/**
 * 有価証券報告書 1 通を取り込み、海外（地域別）売上を構造化して D1 へ冪等保存する
 * 共通ロジック (Worker の catchup ルートが使う)。
 *
 * 流れ: 書類取得 API type=5(CSV)/type=1(XBRL) ZIP → parseOverseasData で構造化 →
 *       oseas_documents / oseas_sales_facts に冪等 upsert。
 *
 * 一次データ ZIP の Notion アーカイブ (ルール6) は 005 yuho-quant が docId キーで
 * 全有報を既に実施済みのため、008 は同一物理ファイルを重複アップロードしない
 * (ルール6 が課す冪等・レート遵守の帰結)。008 は派生構造化のみを担う。
 *
 * CLAUDE.md 準拠:
 *   - docId 一意で冪等 (再実行でも二重計上しない)
 *   - 構造化不能/パース失敗は parse_status に正直に記録し、数値は捏造しない
 *   - ネットワーク等の一過性失敗は throw して上位でリトライ判断 (握りつぶさない)
 *   - 金額欠損は NULL のまま (0 で埋めない)
 *
 * EDINET 由来の汎用クライアント/CSV は 005 yuho-quant の実装を再利用する。
 */
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { overseasDocuments, overseasSalesFacts } from "../db/schema.js";
import {
  downloadDocument,
  EdinetNotFoundError,
} from "../../../yuho-quant/src/services/edinet/client.js";
import { parseEdinetCsvZip } from "../../../yuho-quant/src/services/edinet/csv.js";
import {
  resolveReportPeriodEnd,
  type EdinetDoc,
} from "../../../yuho-quant/src/services/edinet/types.js";
import {
  parseOverseasData,
  RX_OVERSEAS_KEYWORD,
  type OverseasParseStatus,
} from "./overseas-parser.js";

export type IngestOutcome =
  | "ingested"
  | "skipped_existing"
  | "skipped_no_period"
  | "skipped_invalid_meta";

export interface IngestResult {
  outcome: IngestOutcome;
  parseStatus: OverseasParseStatus | "parse_error";
  factCount: number;
  periodEnd: string | null;
}

/** "2024-06-27 15:30" / "2024-06-27" を Date 化 (JST 表記をそのまま) */
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

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** oseas_sales_facts は 11 列/行。D1 bind 上限 100 → 8 行/文 (8×11=88 ≤ 100)。 */
const MAX_FACT_ROWS_PER_STMT = 8;

function patternOf(status: OverseasParseStatus): string {
  if (status === "ok_geo_rows") return "geo_rows";
  if (status === "ok_geo_cols") return "geo_cols";
  return "none";
}

export async function ingestDocument(
  db: Database,
  args: { stockId: number; doc: EdinetDoc; force?: boolean }
): Promise<IngestResult> {
  const { stockId, doc, force = false } = args;

  const existing = await db
    .select({ id: overseasDocuments.id })
    .from(overseasDocuments)
    .where(eq(overseasDocuments.docId, doc.docID))
    .limit(1);
  if (existing.length > 0 && !force) {
    return {
      outcome: "skipped_existing",
      parseStatus: "no_overseas_table",
      factCount: 0,
      periodEnd: doc.periodEnd ?? null,
    };
  }

  // 有報として最低限必要なメタが欠ける異常エントリは捏造せず明示スキップ (ルール2)
  if (!doc.filerName || !doc.docTypeCode || !doc.edinetCode || !doc.submitDateTime) {
    return {
      outcome: "skipped_invalid_meta",
      parseStatus: "no_overseas_table",
      factCount: 0,
      periodEnd: null,
    };
  }
  const periodEnd = resolveReportPeriodEnd(doc);
  if (!periodEnd) {
    return {
      outcome: "skipped_no_period",
      parseStatus: "no_overseas_table",
      factCount: 0,
      periodEnd: null,
    };
  }

  // 1) 軽量な CSV で海外/地域 開示の有無を確定。無ければ重い XBRL を落とさない。
  let parseStatus: OverseasParseStatus | "parse_error";
  let honbunFile: string | null = null;
  let facts: ReturnType<typeof parseOverseasData>["facts"] = [];

  const csvZip = await downloadDocument(doc.docID, 5);
  let hasKeyword = false;
  let csvError = false;
  try {
    const csvRows = parseEdinetCsvZip(csvZip);
    hasKeyword = csvRows.some(
      (r) => RX_OVERSEAS_KEYWORD.test(r.itemName) || RX_OVERSEAS_KEYWORD.test(r.value)
    );
  } catch (e) {
    csvError = true;
    console.warn(
      `[oseas-ingest] csv parse_error docID=${doc.docID} ${doc.filerName}: ${(e as Error).message}`
    );
  }

  let xbrlZip: Buffer | null = null;
  if (!csvError && hasKeyword) {
    try {
      xbrlZip = await downloadDocument(doc.docID, 1);
    } catch (e) {
      if (e instanceof EdinetNotFoundError) {
        xbrlZip = null; // type=1 未提供は事実として記録 (捏造しない)
      } else {
        throw e;
      }
    }
  }

  if (csvError) {
    parseStatus = "parse_error";
  } else if (!hasKeyword) {
    parseStatus = "no_overseas_table";
  } else if (!xbrlZip) {
    parseStatus = "parse_error"; // 開示語ありだが XBRL 未提供 → 構造化不能を正直に
  } else {
    try {
      const ex = parseOverseasData(xbrlZip, periodEnd);
      parseStatus = ex.status;
      honbunFile = ex.honbunFile;
      facts = ex.facts;
    } catch (e) {
      parseStatus = "parse_error";
      facts = [];
      console.warn(
        `[oseas-ingest] parse_error docID=${doc.docID} ${doc.filerName}: ${(e as Error).message}`
      );
    }
  }

  // 安全弁: 同一 (会計期末, 地域名) の重複は一意制約に反する。先頭採用・重複は警告。
  const deduped: typeof facts = [];
  const seen = new Set<string>();
  for (const f of facts) {
    const k = `${f.fiscalYearEnd} ${f.regionName}`;
    if (seen.has(k)) {
      console.warn(`[oseas-ingest] dup-region-skip docID=${doc.docID} ${k}`);
      continue;
    }
    seen.add(k);
    deduped.push(f);
  }

  const [docRow] = await db
    .insert(overseasDocuments)
    .values({
      stockId,
      edinetCode: doc.edinetCode,
      docId: doc.docID,
      docTypeCode: doc.docTypeCode,
      filerName: doc.filerName,
      periodStart: doc.periodStart,
      periodEnd,
      submittedAt: parseSubmitDateTime(doc.submitDateTime),
      parseStatus,
      honbunFile,
    })
    .onConflictDoUpdate({
      target: overseasDocuments.docId,
      set: {
        parseStatus,
        honbunFile,
        submittedAt: parseSubmitDateTime(doc.submitDateTime),
        periodStart: doc.periodStart,
        periodEnd,
      },
    })
    .returning({ id: overseasDocuments.id });

  const factRows = deduped.map((f) => ({
    documentId: docRow.id,
    stockId,
    fiscalYearEnd: f.fiscalYearEnd,
    regionName: f.regionName,
    regionKind: f.regionKind,
    isConsolidated: f.isConsolidated,
    unitLabel: f.unitLabel,
    salesRaw: f.salesAmount,
    salesYen: toYen(f.salesAmount, f.unitYenFactor),
    ratioPct: f.ratioPct,
    pattern: patternOf(parseStatus as OverseasParseStatus),
  }));

  await db.batch([
    db.delete(overseasSalesFacts).where(eq(overseasSalesFacts.documentId, docRow.id)),
    ...chunk(factRows, MAX_FACT_ROWS_PER_STMT).map((rs) =>
      db.insert(overseasSalesFacts).values(rs)
    ),
  ]);

  return {
    outcome: "ingested",
    parseStatus,
    factCount: deduped.length,
    periodEnd,
  };
}
