/**
 * D1 の読み取り専用データソース (005 yuho-quant 事業タグ)。
 * 設計: docs/005-yuho-quant-business-tags.md §5.1・§0 (「D1 には何も書かない」)。
 *
 * 母集団は `activeEquityCondition()` (上場中の内国普通株)。`core_stocks` から
 * select する列は code/name/sector33 の 3 つだけ (`market`/`sector`/
 * `instrument_type` は personal-only。`core-stocks-license-boundary.test.ts` が
 * 固定する境界)。
 *
 * 銘柄ごとの最新有報は `doc_type_code IN ('120','130')` の中で
 * `period_end DESC, submitted_at DESC` の先頭 (訂正有報 130 も対象)。
 * D1 の bind 変数上限 (1クエリ100。memory: D1 bound param limit) を超えないよう、
 * 母集団の id はサブクエリのまま `inArray` に渡す (JS 配列に材料化しない)。
 *
 * `yuho_text_sections` (索引テーブル。80万行規模) には一切触れない
 * (rows_read を抑える)。
 */
import { and, inArray } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { activeEquityCondition } from "../../../../src/shared/db/active-equity.js";
import { stocks } from "../../../../src/shared/db/core-schema.js";
import { yuhoDocuments } from "../db/schema.js";

export interface LatestDoc {
  stockCode: string;
  companyName: string;
  sector33: string | null;
  doc: null | {
    docId: string;
    docTypeCode: "120" | "130";
    /** YYYY-MM-DD */
    periodEnd: string;
    /** ISO 8601 */
    submittedAt: string;
    notionDocPageId: string | null;
    textParseStatus: string | null;
  };
}

/**
 * `core_stocks` / `yuho_documents` にアクセスできれば足りる最小の drizzle db 型。
 * Worker バインディング版 (DrizzleD1Database) と Node の D1 HTTP 版
 * (sqlite-proxy / `createD1HttpDb`) のどちらも渡せる
 * (`src/shared/db/active-equity.ts` の `CoreDb` と同じ形)。
 */
export type BiztagSourceDb = BaseSQLiteDatabase<"async", unknown, Record<string, unknown>>;

const DOC_TYPE_CODES = ["120", "130"] as const;

function assertDocTypeCode(v: string, docId: string): "120" | "130" {
  if (v === "120" || v === "130") return v;
  throw new Error(`loadLatestDocs: 想定外の書類種別コードです (docId=${docId}): ${v}`);
}

interface DocRow {
  stockId: number;
  docId: string;
  docTypeCode: string;
  periodEnd: string;
  submittedAt: Date;
  notionDocPageId: string | null;
  textParseStatus: string | null;
}

function isLater(a: DocRow, b: DocRow): boolean {
  if (a.periodEnd !== b.periodEnd) return a.periodEnd > b.periodEnd;
  return a.submittedAt.getTime() > b.submittedAt.getTime();
}

/**
 * 母集団 (上場中の内国普通株) の銘柄ごとに、最新の有報/訂正有報 1 通を返す。
 * 有報が 1 通も無い銘柄は `doc: null` (古い書類には戻らない。設計 §5.1)。
 */
export async function loadLatestDocs(db: BiztagSourceDb): Promise<LatestDoc[]> {
  const stockRows = await db
    .select({ id: stocks.id, code: stocks.code, name: stocks.name, sector33: stocks.sector33 })
    .from(stocks)
    .where(activeEquityCondition());

  // 母集団の id をサブクエリのまま渡す (JS 配列の inArray は銘柄数ぶんの bind を
  // 作り D1 の 1 クエリ 100 bind 上限を超える)。
  const activeStockIds = db.select({ id: stocks.id }).from(stocks).where(activeEquityCondition());

  const docRows = (await db
    .select({
      stockId: yuhoDocuments.stockId,
      docId: yuhoDocuments.docId,
      docTypeCode: yuhoDocuments.docTypeCode,
      periodEnd: yuhoDocuments.periodEnd,
      submittedAt: yuhoDocuments.submittedAt,
      notionDocPageId: yuhoDocuments.notionDocPageId,
      textParseStatus: yuhoDocuments.textParseStatus,
    })
    .from(yuhoDocuments)
    .where(
      and(
        inArray(yuhoDocuments.docTypeCode, DOC_TYPE_CODES),
        inArray(yuhoDocuments.stockId, activeStockIds)
      )
    )) as DocRow[];

  const latestByStockId = new Map<number, DocRow>();
  for (const row of docRows) {
    const current = latestByStockId.get(row.stockId);
    if (!current || isLater(row, current)) {
      latestByStockId.set(row.stockId, row);
    }
  }

  return stockRows.map((s) => {
    const doc = latestByStockId.get(s.id);
    return {
      stockCode: s.code,
      companyName: s.name,
      sector33: s.sector33,
      doc: doc
        ? {
            docId: doc.docId,
            docTypeCode: assertDocTypeCode(doc.docTypeCode, doc.docId),
            periodEnd: doc.periodEnd,
            submittedAt: doc.submittedAt.toISOString(),
            notionDocPageId: doc.notionDocPageId,
            textParseStatus: doc.textParseStatus,
          }
        : null,
    };
  });
}
