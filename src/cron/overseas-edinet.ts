/**
 * 008 overseas-sales — EDINET 有報の日次キャッチアップ (D1 + Worker 実行)。
 *
 * 005 yuho-quant の catchup と同型。直近 WINDOW_DAYS 日を新しい順に EDINET 書類
 * 一覧で走査し、core_stocks に居る上場銘柄の有報 (120/130) のうち未取込のものを
 * ingestDocument で海外売上を構造化保存する (CSV 事前判定で海外開示なしは XBRL を
 * 落とさない)。1 回の実行は MAX_INGEST 件 / TIME_BUDGET_MS で打ち切り、残りは次回が
 * docId 一意で拾う。shard 指定時は docId ハッシュで担当分のみ処理する。
 *
 * 起動経路は認証付き HTTP ルート (POST /overseas-sales/admin/catchup)。
 */
import { eq } from "drizzle-orm";
import type { Database } from "../../services/overseas-sales/src/db/client.js";
import * as coreSchema from "../shared/db/core-schema.js";
import * as oseasSchema from "../../services/overseas-sales/src/db/schema.js";
import { listDocuments } from "../../services/yuho-quant/src/services/edinet/client.js";
import {
  isAnnualSecuritiesReport,
  secCodeToTicker,
} from "../../services/yuho-quant/src/services/edinet/types.js";
import { ingestDocument } from "../../services/overseas-sales/src/services/ingest.js";

const WINDOW_DAYS = 60;
const MAX_INGEST = 40;
const TIME_BUDGET_MS = 90_000;

export interface ShardOpts {
  part: number;
  of: number;
}

export interface OverseasEdinetResult {
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

export async function runOverseasEdinetCatchup(
  db: Database,
  shard?: ShardOpts
): Promise<OverseasEdinetResult> {
  const startedAt = Date.now();

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
      console.error(`[oseas-edinet] list 失敗 ${date}: ${(e as Error).message}`);
      await sleep(800);
      continue;
    }

    const targets = list.results.filter((doc) => {
      if (!isAnnualSecuritiesReport(doc)) return false;
      const t = secCodeToTicker(doc.secCode);
      if (t === null || !codeToId.has(t)) return false;
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

      const exists = await db
        .select({ id: oseasSchema.overseasDocuments.id })
        .from(oseasSchema.overseasDocuments)
        .where(eq(oseasSchema.overseasDocuments.docId, doc.docID))
        .limit(1);
      if (exists.length > 0) {
        skippedExisting++;
        continue;
      }

      try {
        const r = await ingestDocument(db, { stockId, doc });
        byStatus[r.parseStatus] = (byStatus[r.parseStatus] ?? 0) + 1;
        if (r.outcome === "ingested") ingested++;
        else skippedExisting++;
      } catch (e) {
        console.error(
          `[oseas-edinet] ingest 失敗 docID=${doc.docID}: ${(e as Error).message}`
        );
      }
      await sleep(250);
    }
    await sleep(150);
  }

  const elapsedSec = (Date.now() - startedAt) / 1000;
  console.info(
    `[oseas-edinet] 完了: shard=${shard ? `${shard.part}/${shard.of}` : "-"} 走査${scannedDays}日 matched=${matched} ingested=${ingested} skip=${skippedExisting} cap=${reachedCap} ${elapsedSec.toFixed(1)}s`
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
