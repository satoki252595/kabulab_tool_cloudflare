/**
 * 006 ir-catalog — TDnet 適時開示の日次キャッチアップ (ADR-0001: D1 + Worker 実行)。
 *
 * D1 はバインディング経由でのみ触れるため Worker 上で動く。現状の起動経路は
 * 認証付き HTTP ルート POST /ir-catalog/admin/catchup
 * (services/ir-catalog/src/routes/admin.ts) で、D1 を createDb(c.env.DB) で渡して
 * 呼ぶ。TDnet は 1 リクエストで範囲全件を返せるためシャード分散は不要
 * (shard 指定時は part 0 のみ実行)。Workers Cron Trigger 配線は Phase 3。
 * 失敗は握り潰さず結果に載せる (ルール2)。
 *
 * 動作:
 *   - 直近 WINDOW_DAYS 日を 1 日ずつ全件取得 (yanoshin は page 無効のため)
 *   - core_stocks の active かつ equity (日次・公開面と同じ母集団。
 *     src/shared/db/active-equity.ts) の開示を ir_disclosures へ冪等 upsert。
 *     母集団外のコードは取り込まず、Notion にも記録しない
 *   - ルール6: 当日バッチの確定 JSON を Notion 一次データへ実体記録
 *     (key=tdnet-daily-YYYY-MM-DD 冪等)。高シグナルは人間可読 DB へ冪等記録。
 *   - 取りこぼしは翌日以降の WINDOW 重なりと tdnet_id/Notion 冪等で回収。
 */
import type { Database } from "../../services/ir-catalog/src/db/client.js";
import { loadActiveEquityCodeToId } from "../shared/db/active-equity.js";
import { listRange } from "../../services/ir-catalog/src/services/tdnet/client.js";
import { ingestBatch } from "../../services/ir-catalog/src/services/ingest.js";

const WINDOW_DAYS = 7;
/**
 * 二次データ Notion 投入の実時間上限。Worker 実行時間に収まるよう Notion 投入を
 * この予算で必ず打ち切る。打ち切った残りは WINDOW_DAYS の重なりと TDnet ID 冪等で
 * 次回が回収する (D1 が正本なので Notion 未投入分も失われない)。常態的に
 * reachedDeadline=true なら過去ギャップが大きい合図 → backfill を回す。
 */
const NOTION_BUDGET_MS = 50_000;

export interface IrCatalogResult {
  ran: boolean;
  range?: string;
  fetched?: number;
  inUniverse?: number;
  upserted?: number;
  unclassified?: number;
  byPrimaryTag?: Record<string, number>;
  notionArchive?: unknown;
  notionByStock?: unknown;
  elapsedSec?: number;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export async function runIrCatalogCatchup(
  db: Database,
  shard?: { part: number; of: number }
): Promise<IrCatalogResult> {
  // TDnet は範囲一括取得できるのでシャード分散不要。重複実行を避け shard 0 のみ。
  if (shard && shard.part !== 0) return { ran: false };

  const started = Date.now();

  // 母集団は日次・公開面と同じ active かつ equity。全行で引くと、公開面から外した
  // 銘柄 (P4b で入る非普通株など) の開示まで取り込み、Notion に記録し、ir-catalog の
  // 一覧と検索に出す (理由は src/shared/db/active-equity.ts)。
  const codeToId = await loadActiveEquityCodeToId(db);

  // TDnet の開示日は JST。日付境界も JST で揃える (UTC だと JST 午前に
  // 走ったとき当日分が翌日まで取れず、Notion 冪等キーも 1 日ずれる)。
  const JST_MS = 9 * 3600 * 1000;
  const to = new Date(Date.now() + JST_MS); // 以降 getUTC* = JST 壁時計
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - WINDOW_DAYS);
  const rs = `${from.getUTCFullYear()}${pad(from.getUTCMonth() + 1)}${pad(
    from.getUTCDate()
  )}`;
  const re = `${to.getUTCFullYear()}${pad(to.getUTCMonth() + 1)}${pad(
    to.getUTCDate()
  )}`;
  const range = `${rs}-${re}`;
  const dayKey = `${to.getUTCFullYear()}-${pad(to.getUTCMonth() + 1)}-${pad(
    to.getUTCDate()
  )}`;

  const items = await listRange(range);
  const r = await ingestBatch(db, items, {
    batchKey: `tdnet-daily-${dayKey}`,
    source: `yanoshin TDnet WebAPI /tdnet/list/{YYYYMMDD}.json 日次キャッチアップ 1日ずつ全件 (範囲 ${range})`,
    archiveToNotion: true,
    notionByStock: true,
    notionByStockDeadlineMs: started + NOTION_BUDGET_MS,
    codeToId,
  });

  const elapsedSec = (Date.now() - started) / 1000;
  const bs = r.notionByStock;
  const bsInfo =
    bs && "created" in bs
      ? `銘柄別${bs.stocksTouched}社+${bs.created}/upd${bs.updated}/skip${bs.skippedExisting}/skipNF${bs.skippedNoFile}/rej${bs.rejudged}/err${bs.rowErrors}${
          bs.reachedDeadline ? "(打切)" : ""
        }`
      : bs && "error" in bs
        ? `銘柄別ERR`
        : "-";
  console.info(
    `[ir-catalog] 日次完了 range=${range} 取得=${r.fetched} ユニバース内=${r.inUniverse} upsert=${r.upserted} ${bsInfo} ${elapsedSec.toFixed(
      1
    )}s`
  );
  return {
    ran: true,
    range,
    fetched: r.fetched,
    inUniverse: r.inUniverse,
    upserted: r.upserted,
    unclassified: r.unclassified,
    byPrimaryTag: r.byPrimaryTag,
    notionArchive: r.notionArchive,
    notionByStock: r.notionByStock,
    elapsedSec,
  };
}
