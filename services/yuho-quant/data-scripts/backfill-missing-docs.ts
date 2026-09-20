/**
 * 有報の取りこぼし埋め戻し (Node → D1 HTTP 書込)。
 *
 * 日次キャッチアップ (Worker) は 1 実行の上限 (件数・時間) があり、
 * 流入が多い時期 (6 月の 3 月決算ピーク等) の文書を取りこぼす。60 日窓を
 * 過ぎた文書は日次では二度と拾われないため、本スクリプトで期間指定して
 * 回収する (例: --from=2026-06-01 --to=2026-08-31)。
 *
 * 1 通あたり: CSV(5) 取得 → キーワード事前判定 → 必要なら XBRL(1) 取得 →
 * 受注・海外・定性 24 項目を構造化 → D1 へ冪等 upsert →
 * 物理 ZIP を Notion へ冪等記録 (ルール6)。パーサは本番と同一物を共有し、
 * sqlite-proxy (db.batch 非対応) のため書込だけ per-statement で行う
 * (backfill-overseas/text と同じ方式。ingest.ts が正本)。
 *
 * 冪等・再開可能: docId 既存は (force 無しなら) スキップ。
 *
 * 必要env(.env): EDINET_API_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
 *               D1_DATABASE_ID, NOTION_*(ルール6)。
 *
 * 実行: pnpm yuho:backfill:missing -- --from=2026-06-01 --to=2026-08-31 [--limit=N] [--force] [--dry-run]
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { createD1HttpDb } from "../../../src/shared/db/d1-http-client.js";
import { loadIngestCodeToId } from "../../../src/shared/db/active-equity.js";
import { recordPrimaryData } from "../../../src/shared/notion-archive/index.js";
import {
  downloadDocument,
  EdinetNotFoundError,
  listDocuments,
} from "../src/services/edinet/client.js";
import {
  resolveReportPeriodEnd,
  type EdinetDoc,
} from "../src/services/edinet/types.js";
import { parseEdinetCsvZip } from "../src/services/edinet/csv.js";
import { selectMissingDocs } from "../src/services/edinet/missing.js";
import {
  parseOrderData,
  RX_ORDER_KEYWORD,
  type ParseStatus,
} from "../src/services/edinet/order-parser.js";
import {
  parseOverseasData,
  RX_OVERSEAS_KEYWORD,
  type OverseasFact,
  type OverseasParseStatus,
} from "../src/services/overseas-parser.js";
import {
  extractTextSections,
  type TextParseStatus,
} from "../src/services/edinet/text-sections.js";
import type { OrderFact } from "../src/services/edinet/order-parser.js";
import * as yuhoSchema from "../src/db/schema.js";

const arg = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const force = process.argv.includes("--force");
const dryRun = process.argv.includes("--dry-run");
const limit = arg("limit") ? Number(arg("limit")) : Infinity;
const fromArg = arg("from");
const toArg = arg("to");
if (!fromArg || !toArg || !/^\d{4}-\d{2}-\d{2}$/.test(fromArg) || !/^\d{4}-\d{2}-\d{2}$/.test(toArg)) {
  console.error("usage: --from=YYYY-MM-DD --to=YYYY-MM-DD [--limit=N] [--force] [--dry-run]");
  process.exit(1);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseSubmitDateTime(s: string): Date {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) throw new Error(`submitDateTime 形式が不正: ${s}`);
  const [, y, mo, d, hh, mm] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, hh ? +hh : 0, mm ? +mm : 0));
}

function toYen(raw: number | null, factor: number): number | null {
  if (raw === null) return null;
  return Math.round(raw * factor);
}

function orderPatternOf(status: ParseStatus | "parse_error"): string {
  if (status === "ok_pattern_b") return "pattern_b";
  if (status === "ok_pattern_c") return "pattern_c";
  if (status === "ok_total_only") return "total_only";
  return "pattern_a";
}

function overseasPatternOf(status: OverseasParseStatus | "parse_error"): string {
  if (status === "ok_geo_rows") return "geo_rows";
  if (status === "ok_geo_cols") return "geo_cols";
  return "none";
}

function dedupeOrders(facts: OrderFact[], docId: string): OrderFact[] {
  const out: OrderFact[] = [];
  const seen = new Set<string>();
  for (const f of facts) {
    const k = `${f.fiscalYearEnd} ${f.segmentName}`;
    if (seen.has(k)) {
      console.warn(`[missing] dup-seg-skip docID=${docId} fy=${f.fiscalYearEnd} seg=${f.segmentName}`);
      continue;
    }
    seen.add(k);
    out.push(f);
  }
  return out;
}

function dedupeOverseas(facts: OverseasFact[], docId: string): OverseasFact[] {
  const out: OverseasFact[] = [];
  const seen = new Set<string>();
  for (const f of facts) {
    const k = `${f.fiscalYearEnd} ${f.regionName}`;
    if (seen.has(k)) {
      console.warn(`[missing] dup-region-skip docID=${docId} fy=${f.fiscalYearEnd} region=${f.regionName}`);
      continue;
    }
    seen.add(k);
    out.push(f);
  }
  return out;
}

function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const db = createD1HttpDb(yuhoSchema);
const { yuhoDocuments, orderFacts, overseasSalesFacts, textSections } = yuhoSchema;
const codeToId = await loadIngestCodeToId(db);
console.info(`[missing] 母集団 ${codeToId.size} 社 range=${fromArg}〜${toArg} force=${force} dryRun=${dryRun}`);

// 取込済み docId は全件 1 回だけ引く (日ごとに引くと 22k 行 × 日数になる)
const inDbAll = await db.select({ docId: yuhoDocuments.docId }).from(yuhoDocuments);
const existingAll = new Set(inDbAll.map((r) => r.docId));

const tally: Record<string, number> = {};
let done = 0;
let target = 0;

for (const date of eachDay(fromArg, toArg)) {
  if (target >= limit) break;
  let listed: EdinetDoc[];
  try {
    listed = (await listDocuments(date)).results;
  } catch (e) {
    console.warn(`[missing] list 失敗 ${date}: ${(e as Error).message} (スキップ)`);
    continue;
  }
  const { missing, skippedExisting, outOfUniverse } = selectMissingDocs(
    listed,
    existingAll,
    codeToId,
    force
  );
  if (dryRun) {
    console.info(`[missing:dry] ${date} listed=${listed.length} missing=${missing.length} skipped=${skippedExisting} outOfUniverse=${outOfUniverse}`);
    target += missing.length;
    continue;
  }
  for (const { doc, stockId } of missing) {
    if (target >= limit) break;
    target++;
    const tag = `docID=${doc.docID} ${doc.filerName}`;
    try {
      // 有報として最低限必要なメタが欠ける異常エントリは捏造せず明示スキップ
      // (ingest.ts の skipped_invalid_meta と同じ。ルール2)。
      if (!doc.filerName || !doc.docTypeCode || !doc.edinetCode || !doc.submitDateTime) {
        console.warn(`[missing] skip(meta-missing) docID=${doc.docID}`);
        tally.skipped_invalid_meta = (tally.skipped_invalid_meta ?? 0) + 1;
        continue;
      }
      const periodEnd = resolveReportPeriodEnd(doc);
      if (!periodEnd) {
        tally.skipped_no_period = (tally.skipped_no_period ?? 0) + 1;
        continue;
      }
      const csvZip = await downloadDocument(doc.docID, 5);
      let hasOrder = false;
      let hasOverseas = false;
      let csvError = false;
      let rows: ReturnType<typeof parseEdinetCsvZip> | null = null;
      try {
        rows = parseEdinetCsvZip(csvZip);
        hasOrder = rows.some((r) => RX_ORDER_KEYWORD.test(r.itemName) || RX_ORDER_KEYWORD.test(r.value));
        hasOverseas = rows.some(
          (r) => RX_OVERSEAS_KEYWORD.test(r.itemName) || RX_OVERSEAS_KEYWORD.test(r.value)
        );
      } catch {
        csvError = true;
      }
      let xbrlZip: Buffer | null = null;
      let xbrlUnavailable = false;
      if (hasOrder || hasOverseas) {
        try {
          xbrlZip = await downloadDocument(doc.docID, 1);
        } catch (e) {
          if (e instanceof EdinetNotFoundError) xbrlUnavailable = true;
          else throw e;
        }
      }

      let parseStatus: ParseStatus | "parse_error" = "no_order_table";
      let honbunFile: string | null = null;
      let facts: OrderFact[] = [];
      if (!csvError && hasOrder && xbrlZip) {
        try {
          const o = parseOrderData(xbrlZip, periodEnd);
          parseStatus = o.status;
          honbunFile = o.honbunFile;
          facts = o.facts;
        } catch (e) {
          parseStatus = "parse_error";
          console.warn(`[missing] order parse_error ${tag}: ${(e as Error).message}`);
        }
      } else if (csvError || (hasOrder && !xbrlZip)) {
        parseStatus = "parse_error";
      }

      let overseasParseStatus: OverseasParseStatus | "parse_error" = "no_overseas_table";
      let overseasHonbunFile: string | null = null;
      let overseasFacts: OverseasFact[] = [];
      if (!csvError && hasOverseas && xbrlZip) {
        try {
          const o = parseOverseasData(xbrlZip, periodEnd);
          overseasParseStatus = o.status;
          overseasHonbunFile = o.honbunFile;
          overseasFacts = o.facts;
        } catch (e) {
          overseasParseStatus = "parse_error";
          console.warn(`[missing] overseas parse_error ${tag}: ${(e as Error).message}`);
        }
      } else if (csvError || (hasOverseas && !xbrlZip)) {
        overseasParseStatus = "parse_error";
      }

      let textParseStatus: TextParseStatus | "parse_error" = "no_text_sections";
      let sections: ReturnType<typeof extractTextSections> = [];
      if (csvError || !rows) {
        textParseStatus = "parse_error";
      } else {
        try {
          sections = extractTextSections(rows);
          textParseStatus = sections.length > 0 ? "ok" : "no_text_sections";
        } catch (e) {
          textParseStatus = "parse_error";
          console.warn(`[missing] text parse_error ${tag}: ${(e as Error).message}`);
        }
      }

      const deduped = dedupeOrders(facts, doc.docID);
      const overseasDeduped = dedupeOverseas(overseasFacts, doc.docID);

      // per-statement 冪等 upsert (sqlite-proxy は batch 非対応)
      const ex = await db
        .select({ id: yuhoDocuments.id })
        .from(yuhoDocuments)
        .where(eq(yuhoDocuments.docId, doc.docID))
        .limit(1);
      let docRowId: number;
      const submittedAt = parseSubmitDateTime(doc.submitDateTime);
      if (ex.length > 0) {
        docRowId = ex[0]!.id;
        await db
          .update(yuhoDocuments)
          .set({
            parseStatus, honbunFile, overseasParseStatus, overseasHonbunFile,
            textParseStatus, submittedAt, periodStart: doc.periodStart, periodEnd,
          })
          .where(eq(yuhoDocuments.id, docRowId));
      } else {
        await db.insert(yuhoDocuments).values({
          stockId, edinetCode: doc.edinetCode, docId: doc.docID,
          docTypeCode: doc.docTypeCode, filerName: doc.filerName,
          periodStart: doc.periodStart, periodEnd, submittedAt,
          parseStatus, honbunFile, overseasParseStatus, overseasHonbunFile,
          textParseStatus,
        });
        // sqlite-proxy は returning の挙動が読み筋と違うことがあるため
        // 確実に引き直す (doc_id 一意)。
        const re = await db
          .select({ id: yuhoDocuments.id })
          .from(yuhoDocuments)
          .where(eq(yuhoDocuments.docId, doc.docID))
          .limit(1);
        docRowId = re[0]!.id;
      }
      await db.delete(orderFacts).where(eq(orderFacts.documentId, docRowId));
      for (const f of deduped) {
        await db.insert(orderFacts).values({
          documentId: docRowId, stockId, fiscalYearEnd: f.fiscalYearEnd,
          segmentName: f.segmentName, segmentKind: f.segmentKind,
          isConsolidated: f.isConsolidated, unitLabel: f.unitLabel,
          ordersReceivedRaw: f.ordersReceived, orderBacklogRaw: f.orderBacklog,
          ordersReceivedYen: toYen(f.ordersReceived, f.unitYenFactor),
          orderBacklogYen: toYen(f.orderBacklog, f.unitYenFactor),
          pattern: orderPatternOf(parseStatus),
        });
      }
      await db.delete(overseasSalesFacts).where(eq(overseasSalesFacts.documentId, docRowId));
      for (const f of overseasDeduped) {
        await db.insert(overseasSalesFacts).values({
          documentId: docRowId, stockId, fiscalYearEnd: f.fiscalYearEnd,
          regionName: f.regionName, regionKind: f.regionKind,
          isConsolidated: f.isConsolidated, unitLabel: f.unitLabel,
          salesRaw: f.salesAmount, salesYen: toYen(f.salesAmount, f.unitYenFactor),
          ratioPct: f.ratioPct, pattern: overseasPatternOf(overseasParseStatus),
        });
      }
      await db.delete(textSections).where(eq(textSections.documentId, docRowId));
      for (const s of sections) {
        await db.insert(textSections).values({
          documentId: docRowId, stockId, fiscalYearEnd: periodEnd,
          sectionKey: s.sectionKey, text: s.text, elementId: s.elementId,
          itemName: s.itemName, contextId: s.contextId, charCount: s.charCount,
        });
      }

      await recordPrimaryData({
        service: "yuho-quant",
        key: doc.docID,
        source: `EDINET API v2 /documents/${doc.docID} (type=1 XBRL / type=5 CSV)`,
        fetchedAt: submittedAt.toISOString(),
        metadata: {
          docID: doc.docID, edinetCode: doc.edinetCode, secCode: doc.secCode,
          filerName: doc.filerName, docTypeCode: doc.docTypeCode,
          docDescription: doc.docDescription, periodStart: doc.periodStart,
          periodEnd, submitDateTime: doc.submitDateTime,
          parseStatus, honbunFile, factCount: deduped.length,
          overseasParseStatus, overseasHonbunFile, overseasFactCount: overseasDeduped.length,
          textParseStatus, textSectionCount: sections.length,
          xbrlUnavailable,
        },
        files: [
          { bytes: new Uint8Array(csvZip), filename: `${doc.docID}_csv.zip`, contentType: "application/zip" },
          ...(xbrlZip
            ? [{ bytes: new Uint8Array(xbrlZip), filename: `${doc.docID}_xbrl.zip`, contentType: "application/zip" }]
            : []),
        ],
      });
      tally.ingested = (tally.ingested ?? 0) + 1;
    } catch (e) {
      tally.error = (tally.error ?? 0) + 1;
      console.warn(`[missing] 失敗 ${tag}: ${(e as Error).message}`);
    }
    done++;
    if (done % 50 === 0) {
      console.info(`[missing] ${done}件処理 ` + Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(" "));
    }
    await sleep(200);
  }
}

console.info("[missing] 完了: " + Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(" "));
