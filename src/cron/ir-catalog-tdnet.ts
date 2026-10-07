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
 *   - 取込の母集団 (src/shared/db/active-equity.ts の `loadIngestCodeToId`。core_stocks から
 *     非普通株と、区分が NULL の active 行を除いたもの) の開示を ir_disclosures へ冪等 upsert。
 *     is_active=0 の銘柄 (上場廃止・地域取引所にだけ上場する会社) の開示は取り込む。
 *     母集団外のコードは取り込まず、Notion にも記録しない
 *   - ルール6: 当日バッチの確定 JSON を Notion 一次データへ実体記録
 *     (key=tdnet-daily-YYYY-MM-DD 冪等)。高シグナルは人間可読 DB へ冪等記録。
 *   - 取りこぼしは、公開から TDNET_PDF_RETAIN_DAYS 日以内の未保存
 *     (notion_page_id が空) を古い順に次回以降が回収する。
 *     page id がある行は Notion 照会をしない。
 */
import type { Database } from "../../services/ir-catalog/src/db/client.js";
import { loadIngestCodeToId } from "../shared/db/active-equity.js";
import { listRange } from "../../services/ir-catalog/src/services/tdnet/client.js";
import { ingestBatch } from "../../services/ir-catalog/src/services/ingest.js";

const WINDOW_DAYS = 7;
/**
 * 未保存 IR を D1 から拾い直す日数。
 *
 * 2026-10-08 02:38 JST の実測: 公開後 37 日の原本は 206、41 日は 404。
 * 40 日は「まだ TDnet にありうる」上限（確定で消えていた 41 日の手前）。
 * 一覧取得そのものは WINDOW_DAYS のまま。二次投入だけこの日数まで広げる。
 * pipeline の ops_check.IR_PDF_RETAIN_DAYS と同じ値。
 */
export const TDNET_PDF_RETAIN_DAYS = 40;
/**
 * 二次データ Notion 投入の実時間上限。**二次フェーズ開始から測る**
 * (D1 upsert 所要に食われない。開始起点の 50s では 2026-06 以降ほぼ
 * 0 件投入だった)。予算は notion_page_id が空の行だけに使う。
 * 直近の catchup は 7 日窓 1,181〜1,326 行のうち skip 479〜603 が
 * 保存済みの照会で、新規は 18〜106 行だった。保存済みを外すと
 * 定常状態で回すのはおおよそ 1 日分（コメント上の見積 120〜260 行、
 * 1 行 2〜5 秒）で、12 分に収まる見込み。収まり切らない日は古い未保存を
 * 優先し、残りは tdnetId をログに残して翌回の遡及が拾う。
 * 常態的に reachedDeadline=true なら backfill を回す合図。
 * catchup.yml の timeout (30 分、yuho と共有) 内に収まること。
 */
const NOTION_BUDGET_MS = 12 * 60_000;

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

  // 取込の母集団。変更前 (core_stocks の全行) から、非普通株と、区分が NULL の active 行
  // だけを除く。P4b で入る非普通株の開示は取り込まず (Notion にも ir-catalog の一覧にも
  // 出さない)、is_active=0 の会社 (上場廃止・地域取引所の単独上場) の開示は取り込み続ける
  // (理由は src/shared/db/active-equity.ts の disclosureIngestCondition)。
  const codeToId = await loadIngestCodeToId(db);

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
    notionByStockBudgetMs: NOTION_BUDGET_MS,
    unsavedLookbackDays: TDNET_PDF_RETAIN_DAYS,
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
