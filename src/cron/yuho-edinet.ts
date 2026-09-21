/**
 * 005 yuho-quant — EDINET 有報の日次キャッチアップ (D1 + Worker 実行)。
 *
 * D1 はバインディング経由でのみ触れるため、本処理は Worker 上で動く。
 * 起動経路は **認証付き HTTP ルート** (POST /yuho-quant/admin/catchup,
 * services/yuho-quant/src/routes/admin.ts) で、D1 を `createDb(c.env.DB)` で
 * 渡して呼ぶ。catchup.yml が薄いトリガ (scripts/sync/yuho-edinet.ts) で叩く。
 * Workers Cron は使わない (無料運用方針)。Node の日次パイプライン
 * (scripts/sync/all-daily.ts) からは分離済み。
 *
 * 動作:
 *   - 直近 WINDOW_DAYS 日を新しい順に EDINET 書類一覧で走査
 *   - 取込の母集団 (src/shared/db/active-equity.ts の `loadIngestCodeToId`。core_stocks から
 *     非普通株と、区分が NULL の active 行を除いたもの) の有報 (120/130) のうち未取込のものを
 *     ingestDocument で構造化保存 (CSV 事前判定で受注なしは XBRL を落とさない)
 *   - 1 回の実行は MAX_INGEST 件 / TIME_BUDGET_MS で打ち切り。残りは次回実行が
 *     拾う (docId 一意で冪等)。6 月の有報集中期も実行回数×日数で吸収。
 */
import { eq } from "drizzle-orm";
import type { Database } from "../../services/yuho-quant/src/db/client.js";
import { loadIngestCodeToId } from "../shared/db/active-equity.js";
import * as yuhoSchema from "../../services/yuho-quant/src/db/schema.js";
import { listDocuments } from "../../services/yuho-quant/src/services/edinet/client.js";
import {
  isAnnualSecuritiesReport,
  secCodeToTicker,
} from "../../services/yuho-quant/src/services/edinet/types.js";
import { ingestDocument } from "../../services/yuho-quant/src/services/ingest.js";
import { rebuildYuhoGrowthProjection } from "../../services/yuho-quant/src/services/projection.js";

const WINDOW_DAYS = 60;
/**
 * 1 実行あたりの取込上限。Workers のサブリクエスト上限 (Paid は 2026-02 に
 * 1,000→10,000/invocation へ増加。Free は外部 50) に対し、1 doc で最悪 ~14 req
 * (EDINET 2 + Notion 数〜十数) を要する。60 件 × ~14 ≈ 840 req と、時間予算 +
 * Notion レート (~3 req/s) の両面から安全側に抑える。残りは次回が docId 冪等で拾う。
 * ピーク期 (6 月の 3 月決算等) の大量流入は日次だけでは捌き切れないため、
 * `pnpm yuho:backfill:missing` で期間指定回収する (無制限・再開可能)。
 */
const MAX_INGEST = 60;
/**
 * 実時間の上限。Workers の CPU 時間制限 (Paid 既定 30s, 最大 5 分まで引上可) と
 * は別に、fetch/sleep 主体の本処理は壁時計でこの予算に達したら打ち切る。
 * shard 指定時は docId ハッシュで 1/of の文書だけを担当するので、複数実行
 * (cron 並走 or 連続実行) 合算で全件をカバーし、打ち切った残りも次回が docId
 * 冪等で拾う (取りこぼさない)。
 */
const TIME_BUDGET_MS = 300_000;

export interface ShardOpts {
  part: number;
  of: number;
}

export interface YuhoEdinetResult {
  shard: ShardOpts | null;
  scannedDays: number;
  matched: number;
  ingested: number;
  skippedExisting: number;
  /**
   * 有報 (120/130) のうち、証券コードが取込の母集団 (`loadIngestCodeToId`) に無く取り込まなかった
   * 件数 (非普通株・区分が NULL の active 行・core_stocks に無いコード)。シャード指定時は
   * このシャードの担当分だけを数える。
   */
  outOfUniverse: number;
  byStatus: Record<string, number>;
  reachedCap: boolean;
  elapsedSec: number;
  /** L2 投影 `p_yuho_growth` の再生成銘柄数。シャード実行では 0 (再生成しない) */
  projectionStocks: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** docId の安定ハッシュ (FNV-1a 32bit, 非負)。シャード分配に使う */
function hashDocId(docId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < docId.length; i++) {
    h ^= docId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export async function runYuhoEdinetCatchup(
  db: Database,
  shard?: ShardOpts
): Promise<YuhoEdinetResult> {
  const startedAt = Date.now();

  // 取込の母集団。変更前 (core_stocks の全行) から、非普通株と、区分が NULL の active 行
  // だけを除く。is_active=0 の会社 (上場廃止・地域取引所の単独上場) の有報は取り込み続ける
  // (理由は src/shared/db/active-equity.ts の disclosureIngestCondition)。
  const codeToId = await loadIngestCodeToId(db);

  const byStatus: Record<string, number> = {};
  let scannedDays = 0;
  let matched = 0;
  let ingested = 0;
  let skippedExisting = 0;
  let outOfUniverse = 0;
  let reachedCap = false;

  const overBudget = () => Date.now() - startedAt > TIME_BUDGET_MS;

  // 古い日から走査する (FIFO)。新しい日優先だと流入過多期に古い未取込が
  // 残り続け、窓を過ぎて永久に拾われなくなる (2026-06 ピークの取りこぼし)。
  const today = new Date();
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    if (ingested >= MAX_INGEST || overBudget()) {
      reachedCap = true;
      break;
    }
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const date = d.toISOString().slice(0, 10);
    scannedDays++;

    let list;
    try {
      list = await listDocuments(date);
    } catch (e) {
      console.error(
        `[yuho-edinet] list 失敗 ${date}: ${(e as Error).message}`
      );
      await sleep(800);
      continue;
    }

    const targets = list.results.filter((doc) => {
      if (!isAnnualSecuritiesReport(doc)) return false;
      // シャード分配: 各シャードは docId ハッシュ %of==part の文書のみ担当
      // (8 シャード合算で全文書を一意にカバー・重複なし)。母集団外の件数をシャード間で
      // 重複して数えないよう、コードの判定より先に振り分ける。
      if (shard && hashDocId(doc.docID) % shard.of !== shard.part) return false;
      const t = secCodeToTicker(doc.secCode);
      if (t === null) return false;
      if (!codeToId.has(t)) {
        // 取り込まないが、落とした量は完了ログと戻り値に出す (黙って落とさない)。
        outOfUniverse++;
        return false;
      }
      return true;
    });

    for (const doc of targets) {
      if (ingested >= MAX_INGEST || overBudget()) {
        reachedCap = true;
        break;
      }
      matched++;
      const stockCode = secCodeToTicker(doc.secCode)!;
      const stockId = codeToId.get(stockCode)!;

      // 既取込なら EDINET を叩かずスキップ (冪等・帯域節約)
      const exists = await db
        .select({ id: yuhoSchema.yuhoDocuments.id })
        .from(yuhoSchema.yuhoDocuments)
        .where(eq(yuhoSchema.yuhoDocuments.docId, doc.docID))
        .limit(1);
      if (exists.length > 0) {
        skippedExisting++;
        continue;
      }

      try {
        // ルール6: 日次キャッチアップでも有報の物理 ZIP を Notion へ記録。
        // Notion 通信の分 1 件あたりの実時間は伸びるが TIME_BUDGET_MS で必ず
        // 打ち切られ、打ち切った残りは翌日以降が docId/Notion 冪等で回収する。
        const r = await ingestDocument(db, {
          stockId,
          stockCode,
          doc,
          archiveToNotion: true,
        });
        byStatus[r.parseStatus] = (byStatus[r.parseStatus] ?? 0) + 1;
        // 海外売上も同じ有報から並行構造化される。運用可視化のため prefix 付きで計上。
        const ok = `oseas:${r.overseasParseStatus}`;
        byStatus[ok] = (byStatus[ok] ?? 0) + 1;
        // 定性セクション (CSV のみ抽出) も同様に計上。
        const tx = `text:${r.textParseStatus}`;
        byStatus[tx] = (byStatus[tx] ?? 0) + 1;
        if (r.outcome === "ingested") ingested++;
        else skippedExisting++;
      } catch (e) {
        console.error(
          `[yuho-edinet] ingest 失敗 docID=${doc.docID}: ${(e as Error).message}`
        );
      }
      await sleep(300);
    }
    await sleep(150);
  }

  // L2 投影 `p_yuho_growth` の再生成 (L-51/K4b)。シャード実行では走らせない
  // (各シャードが全表を書き直すと sweep が競合する。非シャードの定時実行が
  // 拾う。手動バックフィル直後は次回定時まで画面が古いまま)。
  let projectionStocks = 0;
  if (!shard) {
    const proj = await rebuildYuhoGrowthProjection(db);
    projectionStocks = proj.stocks;
  }

  const elapsedSec = (Date.now() - startedAt) / 1000;
  console.info(
    `[yuho-edinet] 完了: shard=${shard ? `${shard.part}/${shard.of}` : "-"} 走査${scannedDays}日 matched=${matched} ingested=${ingested} skip=${skippedExisting} outOfUniverse=${outOfUniverse} cap=${reachedCap} 投影=${projectionStocks} ${elapsedSec.toFixed(1)}s`
  );
  return {
    shard: shard ?? null,
    scannedDays,
    matched,
    ingested,
    skippedExisting,
    outOfUniverse,
    byStatus,
    reachedCap,
    elapsedSec,
    projectionStocks,
  };
}
