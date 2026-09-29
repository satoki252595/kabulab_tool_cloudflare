/**
 * 取りこぼし backfill の 1 文書ぶん batch 構築。
 * data-scripts/backfill-missing-docs.ts (top-level await の CLI で import
 * できない) からテスト可能な純粋部を切り出したもの。振る舞いの正本はここ。
 * 組成は共有 ingest.ts と同一: 文書 upsert + 3 表の置換を単一 batch に入れ、
 * facts/text の documentId は docId サブクエリで参照する (事前 upsert/id
 * 取得の排除。JS 側で id を受け渡さない)。
 */
import { eq, sql } from "drizzle-orm";
import type { Database } from "../../src/db/client.js";
import {
  orderFacts,
  overseasSalesFacts,
  textSections,
  yuhoDocuments,
} from "../../src/db/schema.js";
import type {
  OrderFact,
  ParseStatus,
} from "../../src/services/edinet/order-parser.js";
import type {
  OverseasFact,
  OverseasParseStatus,
} from "../../src/services/overseas-parser.js";
import type { ExtractedSection } from "../../src/services/edinet/text-sections.js";

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
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

/**
 * 同一 (会計期末, セグメント名) の重複は order_facts の一意制約に反する
 * ため先頭を採用し重複は警告して落とす (ingest.ts の安全弁と同一)。
 */
export function dedupeOrders(facts: OrderFact[], docId: string): OrderFact[] {
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

export interface MissingDocWriteSet {
  stockId: number;
  docId: string;
  edinetCode: string;
  docTypeCode: string;
  filerName: string;
  periodStart: string | null;
  periodEnd: string;
  submittedAt: Date;
  parseStatus: ParseStatus | "parse_error";
  honbunFile: string | null;
  overseasParseStatus: OverseasParseStatus | "parse_error";
  overseasHonbunFile: string | null;
  textParseStatus: string;
  /** dedup 済みの受注ファクト */
  deduped: OrderFact[];
  /** 保存前検証済みの海外ファクト */
  overseasFacts: OverseasFact[];
  sections: ExtractedSection[];
}

/**
 * 1 文書ぶん (文書 upsert + 受注/海外/定性の各 DELETE + chunked INSERT) の
 * batch 文を構築する。呼び出し側は toD1BatchStatements で変換し d1HttpBatch
 * の単一 batch で送る。per-statement フォールバックはしない。
 */
export function buildMissingDocStatements(db: Database, w: MissingDocWriteSet) {
  const docUpsert = db
    .insert(yuhoDocuments)
    .values({
      stockId: w.stockId,
      edinetCode: w.edinetCode,
      docId: w.docId,
      docTypeCode: w.docTypeCode,
      filerName: w.filerName,
      periodStart: w.periodStart,
      periodEnd: w.periodEnd,
      submittedAt: w.submittedAt,
      parseStatus: w.parseStatus,
      honbunFile: w.honbunFile,
      overseasParseStatus: w.overseasParseStatus,
      overseasHonbunFile: w.overseasHonbunFile,
      textParseStatus: w.textParseStatus,
    })
    .onConflictDoUpdate({
      target: yuhoDocuments.docId,
      set: {
        parseStatus: w.parseStatus,
        honbunFile: w.honbunFile,
        overseasParseStatus: w.overseasParseStatus,
        overseasHonbunFile: w.overseasHonbunFile,
        textParseStatus: w.textParseStatus,
        submittedAt: w.submittedAt,
        periodStart: w.periodStart,
        periodEnd: w.periodEnd,
      },
    });

  // 同一 batch 内の upsert 行を指す docId サブクエリ (ingest.ts と同一)。
  const docIdSubquery = sql`(select ${yuhoDocuments.id} from ${yuhoDocuments} where ${yuhoDocuments.docId} = ${w.docId})`;

  // D1 bind 上限 100 に対し insert は 8 行/文に分割 (ingest.ts と同一)。
  const orderRows = w.deduped.map((f) => ({
    documentId: docIdSubquery,
    stockId: w.stockId,
    fiscalYearEnd: f.fiscalYearEnd,
    segmentName: f.segmentName,
    segmentKind: f.segmentKind,
    isConsolidated: f.isConsolidated,
    unitLabel: f.unitLabel,
    ordersReceivedRaw: f.ordersReceived,
    orderBacklogRaw: f.orderBacklog,
    ordersReceivedYen: toYen(f.ordersReceived, f.unitYenFactor),
    orderBacklogYen: toYen(f.orderBacklog, f.unitYenFactor),
    pattern: orderPatternOf(w.parseStatus),
  }));
  const overseasRows = w.overseasFacts.map((f) => ({
    documentId: docIdSubquery,
    stockId: w.stockId,
    fiscalYearEnd: f.fiscalYearEnd,
    regionName: f.regionName,
    regionKind: f.regionKind,
    isConsolidated: f.isConsolidated,
    unitLabel: f.unitLabel,
    salesRaw: f.salesAmount,
    salesYen: toYen(f.salesAmount, f.unitYenFactor),
    ratioPct: f.ratioPct,
    pattern: overseasPatternOf(w.overseasParseStatus),
  }));
  const sectionRows = w.sections.map((s) => ({
    documentId: docIdSubquery,
    stockId: w.stockId,
    fiscalYearEnd: w.periodEnd,
    sectionKey: s.sectionKey,
    elementId: s.elementId,
    itemName: s.itemName,
    contextId: s.contextId,
    charCount: s.charCount,
  }));

  return [
    docUpsert,
    db.delete(orderFacts).where(eq(orderFacts.documentId, docIdSubquery)),
    ...chunk(orderRows, 8).map((rows) => db.insert(orderFacts).values(rows)),
    db
      .delete(overseasSalesFacts)
      .where(eq(overseasSalesFacts.documentId, docIdSubquery)),
    ...chunk(overseasRows, 8).map((rows) =>
      db.insert(overseasSalesFacts).values(rows)
    ),
    db.delete(textSections).where(eq(textSections.documentId, docIdSubquery)),
    ...chunk(sectionRows, 8).map((rows) => db.insert(textSections).values(rows)),
  ];
}
