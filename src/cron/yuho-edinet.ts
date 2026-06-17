/**
 * 005 yuho-quant — EDINET 有報の日次キャッチアップ (統一 daily cron に相乗り)。
 *
 * 新規 cron は作らない方針 (docs/new-project-template.md §9) に従い、既存の
 * 日次 cron ハンドラ (src/index.ts) から **shard 0 のときだけ** 呼ばれる。
 * 既存の日次 sync (Yahoo パイプライン) からは完全に独立しており、ここの失敗が
 * 本体 sync を壊さないよう呼び出し側で握る (ただし結果はレスポンスに載せて
 * 運用者が気づけるようにする — 握り潰さない: ルール2)。
 *
 * 動作:
 *   - 直近 WINDOW_DAYS 日を新しい順に EDINET 書類一覧で走査
 *   - core.stocks に居る上場銘柄の有報 (120/130) のうち未取込のものを
 *     ingestDocument で構造化保存 (CSV 事前判定で受注なしは XBRL を落とさない)
 *   - 1 回の実行は MAX_INGEST 件で打ち切り (Vercel 時間制約)。残りは翌日以降の
 *     実行が拾う (docId 一意で冪等)。6 月の有報集中期も日次×日数で吸収。
 */
import { eq } from "drizzle-orm";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as coreSchema from "../../services/rsi-screening/src/db/core-schema.js";
import * as yuhoSchema from "../../services/yuho-quant/src/db/schema.js";
import { listDocuments } from "../../services/yuho-quant/src/services/edinet/client.js";
import {
  isAnnualSecuritiesReport,
  secCodeToTicker,
} from "../../services/yuho-quant/src/services/edinet/types.js";
import { ingestDocument } from "../../services/yuho-quant/src/services/ingest.js";

const SCHEMAS = { ...coreSchema, ...yuhoSchema };
const WINDOW_DAYS = 60;
const MAX_INGEST = 60;
/**
 * 実時間の上限。日次 cron は runDailySync の後に **各シャードで** これを
 * 直列実行するため、Vercel 関数上限 (現行プラン maxDuration 300s) を本体と
 * 合わせて超えないよう必ず時間で打ち切る。8 シャード化で本体が ~150s 級に
 * 下がったため キャッチアップは最大 90 秒。各シャードは docId ハッシュで
 * 1/of の文書だけを担当するので 6 月の有報集中も 8 シャード合算で当日中に
 * 捌け、打ち切った残りも翌日以降が docId 冪等で拾う (取りこぼさない)。
 */
const TIME_BUDGET_MS = 90_000;

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
  byStatus: Record<string, number>;
  reachedCap: boolean;
  elapsedSec: number;
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
  databaseUrl: string,
  shard?: ShardOpts
): Promise<YuhoEdinetResult> {
  const startedAt = Date.now();
  const db = drizzle(neon(databaseUrl), { schema: SCHEMAS });

  const allStocks = await db
    .select({ id: coreSchema.stocks.id, code: coreSchema.stocks.code })
    .from(coreSchema.stocks);
  const codeToId = new Map<string, number>();
  for (const s of allStocks) codeToId.set(s.code, s.id);

  const byStatus: Record<string, number> = {};
  let scannedDays = 0;
  let matched = 0;
  let ingested = 0;
  let skippedExisting = 0;
  let reachedCap = false;

  const overBudget = () => Date.now() - startedAt > TIME_BUDGET_MS;

  const today = new Date();
  for (let i = 0; i < WINDOW_DAYS; i++) {
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
      const t = secCodeToTicker(doc.secCode);
      if (t === null || !codeToId.has(t)) return false;
      // シャード分配: 各シャードは docId ハッシュ %of==part の文書のみ担当
      // (8 シャード合算で全文書を一意にカバー・重複なし)
      if (shard && hashDocId(doc.docID) % shard.of !== shard.part) return false;
      return true;
    });

    for (const doc of targets) {
      if (ingested >= MAX_INGEST || overBudget()) {
        reachedCap = true;
        break;
      }
      matched++;
      const stockId = codeToId.get(secCodeToTicker(doc.secCode)!)!;

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
          doc,
          archiveToNotion: true,
        });
        byStatus[r.parseStatus] = (byStatus[r.parseStatus] ?? 0) + 1;
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

  const elapsedSec = (Date.now() - startedAt) / 1000;
  console.info(
    `[yuho-edinet] 完了: shard=${shard ? `${shard.part}/${shard.of}` : "-"} 走査${scannedDays}日 matched=${matched} ingested=${ingested} skip=${skippedExisting} cap=${reachedCap} ${elapsedSec.toFixed(1)}s`
  );
  return {
    shard: shard ?? null,
    scannedDays,
    matched,
    ingested,
    skippedExisting,
    byStatus,
    reachedCap,
    elapsedSec,
  };
}
