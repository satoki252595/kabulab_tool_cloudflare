/**
 * 取りこぼし backfill の 1 文書ぶん batch 構築 + 1 文書処理。
 * data-scripts/backfill-missing-docs.ts (top-level await の CLI で import
 * できない) からテスト可能な部分を切り出したもの。振る舞いの正本はここ。
 * 組成は共有 ingest.ts と同一: 文書 upsert + 3 表の置換を単一 batch に入れ、
 * facts/text の documentId は docId サブクエリで参照する (事前 upsert/id
 * 取得の排除。JS 側で id を受け渡さない)。
 * 順序は raw-before-DB: 物理 ZIP の Notion 記録 (type 別 key・実 bytes の
 * 同一確認つき) を DB batch より先に行い、記録失敗は DB を旧値のまま残す。
 */
import { eq, sql } from "drizzle-orm";
import type { Database } from "../../src/db/client.js";
import {
  orderFacts,
  overseasSalesFacts,
  textSections,
  yuhoDocuments,
} from "../../src/db/schema.js";
import { EdinetNotFoundError } from "../../src/services/edinet/client.js";
import { parseEdinetCsvZip } from "../../src/services/edinet/csv.js";
import {
  parseOrderData,
  RX_ORDER_KEYWORD,
  type OrderFact,
  type ParseStatus,
} from "../../src/services/edinet/order-parser.js";
import {
  parseOverseasData,
  RX_OVERSEAS_KEYWORD,
  validateOverseasSaveSet,
  type OverseasFact,
  type OverseasParseStatus,
} from "../../src/services/overseas-parser.js";
import {
  extractTextSections,
  type ExtractedSection,
  type TextParseStatus,
} from "../../src/services/edinet/text-sections.js";
import {
  resolveReportPeriodEnd,
  secCodeToTicker,
  type EdinetDoc,
} from "../../src/services/edinet/types.js";
import type * as textBackup from "../../src/services/text-backup.js";
import type * as edinetArchive from "../../src/services/edinet/archive.js";
import type * as edinetClient from "../../src/services/edinet/client.js";
import {
  toD1BatchStatements,
  type createD1HttpBatchSender,
} from "../../../../src/shared/db/d1-http-client.js";

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

function parseSubmitDateTime(s: string): Date {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) throw new Error(`submitDateTime 形式が不正: ${s}`);
  const [, y, mo, d, hh, mm] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, hh ? +hh : 0, mm ? +mm : 0));
}

/** 1 文書処理の IO 境界 (本番は実物、試験は mock を注入する)。 */
export interface MissingDocProcessDeps {
  downloadDocument: typeof edinetClient.downloadDocument;
  recordEdinetZip: typeof edinetArchive.recordEdinetZip;
  d1HttpBatch: ReturnType<typeof createD1HttpBatchSender>;
  backupDocTextToNotion: typeof textBackup.backupDocTextToNotion;
  tally: (key: string) => void;
}

/**
 * 取りこぼし 1 通の取得→構造化→記録→DB 書込 (振る舞いの正本)。
 * backfill-missing-docs.ts の per-doc 本体。順序は raw-before-DB:
 * 物理 ZIP の Notion 記録を DB batch より先に 1 回行い、記録失敗は
 * throw を外の catch で tally.error に計上して DB を旧値のまま残す
 * (再実行可)。metadata は DBid 非依存 (text ポインタのみ DBid 解決後)。
 * T1 未提供は型付き EdinetNotFoundError のみ T5 単独で進み、未知失敗は
 * throw する (握り潰さない・無断 T5 単独にしない)。
 */
export async function processMissingDoc(
  db: Database,
  deps: MissingDocProcessDeps,
  input: { doc: EdinetDoc; stockId: number; force: boolean }
): Promise<void> {
  const { doc, stockId, force } = input;
  const tag = `docID=${doc.docID} ${doc.filerName}`;
  try {
    // 有報として最低限必要なメタが欠ける異常エントリは捏造せず明示スキップ
    // (ingest.ts の skipped_invalid_meta と同じ。ルール2)。
    if (!doc.filerName || !doc.docTypeCode || !doc.edinetCode || !doc.submitDateTime) {
      console.warn(`[missing] skip(meta-missing) docID=${doc.docID}`);
      deps.tally("skipped_invalid_meta");
      return;
    }
    const periodEnd = resolveReportPeriodEnd(doc);
    if (!periodEnd) {
      deps.tally("skipped_no_period");
      return;
    }
    const csvZip = await deps.downloadDocument(doc.docID, 5);
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
        xbrlZip = await deps.downloadDocument(doc.docID, 1);
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
    let overseasProof: ReturnType<typeof parseOverseasData>["proof"];
    if (!csvError && hasOverseas && xbrlZip) {
      try {
        const o = parseOverseasData(xbrlZip, periodEnd);
        overseasParseStatus = o.status;
        overseasHonbunFile = o.honbunFile;
        overseasFacts = o.facts;
        overseasProof = o.proof;
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
    // 海外売上ファクトは保存前検証を通す。違反があれば parse_error + 空保存
    // (先頭行 dedup で回復させない = aggregate-before-dedup の再発防止)。
    try {
      validateOverseasSaveSet(overseasFacts, overseasProof);
    } catch (e) {
      console.warn(
        `[missing] overseas save-set invalid; downgrade to parse_error docID=${doc.docID}: ${(e as Error).message}`
      );
      overseasParseStatus = "parse_error";
      overseasFacts = [];
    }

    // type 別 key で各実体を記録する (共通契約)。各 key の既存は
    // recordPrimaryData 側で冪等スキップし、Type5 済みは Type1 を抑止しない。
    // DB batch より先に置く: 記録に失敗したら D1 は旧値のまま残り再実行できる。
    const submittedAt = parseSubmitDateTime(doc.submitDateTime);
    const fetchedAt = submittedAt.toISOString();
    const metadata = {
      docID: doc.docID, edinetCode: doc.edinetCode, secCode: doc.secCode,
      filerName: doc.filerName, docTypeCode: doc.docTypeCode,
      docDescription: doc.docDescription, periodStart: doc.periodStart,
      periodEnd, submitDateTime: doc.submitDateTime,
      parseStatus, honbunFile, factCount: deduped.length,
      overseasParseStatus, overseasHonbunFile, overseasFactCount: overseasFacts.length,
      textParseStatus, textSectionCount: sections.length,
      xbrlUnavailable,
    };
    await deps.recordEdinetZip({
      service: "yuho-quant", docID: doc.docID, type: 5, zip: csvZip,
      source: `EDINET API v2 /documents/${doc.docID}?type=5`,
      fetchedAt, metadata,
    });
    if (xbrlZip) {
      await deps.recordEdinetZip({
        service: "yuho-quant", docID: doc.docID, type: 1, zip: xbrlZip,
        source: `EDINET API v2 /documents/${doc.docID}?type=1`,
        fetchedAt, metadata,
      });
    }

    // 文書 upsert + 3 表の置換を単一 batch で原子適用する (ingest.ts と
    // 同一組成)。失敗は外の catch で tally.error に計上し非 0 終了する
    // (握り潰さない)。statement fallback なし。
    const statements = buildMissingDocStatements(db, {
      stockId,
      docId: doc.docID,
      edinetCode: doc.edinetCode,
      docTypeCode: doc.docTypeCode,
      filerName: doc.filerName,
      periodStart: doc.periodStart,
      periodEnd,
      submittedAt,
      parseStatus,
      honbunFile,
      overseasParseStatus,
      overseasHonbunFile,
      textParseStatus,
      deduped,
      overseasFacts,
      sections,
    });
    await deps.d1HttpBatch(toD1BatchStatements(statements));
    // 行 id は batch から取り出さない (ingest.ts と同一方針)。本文保管と
    // ポインタ書戻しに要るため docId 冪等 SELECT で解決する (読取のみ)。
    const idRow = await db
      .select({ id: yuhoDocuments.id })
      .from(yuhoDocuments)
      .where(eq(yuhoDocuments.docId, doc.docID))
      .limit(1);
    const docRowId = idRow[0]!.id;

    // 定性テキスト本文の Notion 保管 (D1 には索引 + 行 ID のみ)。
    // 失敗は当該通の警告に留める (ポインタ NULL の通は P3 が回収)。
    if (sections.length > 0) {
      try {
        const ticker = secCodeToTicker(doc.secCode);
        if (ticker === null) {
          console.warn(`[missing] notion text skip(コード不明) docID=${doc.docID}`);
          deps.tally("notion_text_no_code");
        } else {
          const r = await deps.backupDocTextToNotion({
            stockCode: ticker,
            docId: doc.docID,
            d1DocumentId: docRowId,
            fiscalYearEnd: periodEnd,
            textParseStatus,
            sections,
            force,
          });
          if (r.rowPageId) {
            await db
              .update(yuhoDocuments)
              .set({ notionDocPageId: r.rowPageId })
              .where(eq(yuhoDocuments.id, docRowId));
          } else {
            // 本文ありなのに行 ID 未取得は黙って成功にしない (P6 共有根因)。
            console.warn(`[missing] notion text backup 失敗(行 ID 未取得) ${tag}: outcome=${r.outcome}`);
            deps.tally("notion_text_no_pointer");
          }
        }
      } catch (e) {
        console.warn(`[missing] notion text backup 失敗 ${tag}: ${(e as Error).message}`);
        deps.tally("notion_text_error");
      }
    }
    deps.tally("ingested");
  } catch (e) {
    deps.tally("error");
    console.warn(`[missing] 失敗 ${tag}: ${(e as Error).message}`);
  }
}
