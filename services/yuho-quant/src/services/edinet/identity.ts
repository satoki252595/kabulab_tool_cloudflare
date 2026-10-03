/** 提出者 EDINET コードから銘柄を特定する。原本の secCode は変更しない。 */
import { and, eq, inArray } from "drizzle-orm";
import { sqliteTable, text, type BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { parseStockCode } from "../../../../../src/shared/jpx/stock-code.js";
import { stocks } from "../../../../../src/shared/db/core-schema.js";
import { isAnnualSecuritiesReport, resolveReportPeriodEnd, secCodeToTicker, type EdinetDoc } from "./types.js";

// Python master_sync が実 Notion ① から更新する既存の逆引き区画。読み取りのみ。
const notionPages = sqliteTable("jss_notion_pages", {
  code: text("code").notNull(),
  db: text("db").notNull(),
  pageId: text("page_id").notNull(),
});

/** マスタ未到着と、既存行が正規取込母集団外である場合を混同しない。 */
export async function loadKnownStockCodes(
  db: BaseSQLiteDatabase<"async", unknown, Record<string, unknown>>, codes: string[]
): Promise<Set<string>> {
  const unique = [...new Set(codes)];
  const found = new Set<string>();
  for (let i = 0; i < unique.length; i += 90) {
    const batch = unique.slice(i, i + 90);
    const rows = await db.select({code: stocks.code}).from(stocks).where(inArray(stocks.code, batch));
    for (const {code} of rows) {
      if (!batch.includes(code) || found.has(code)) throw new Error("EDINETマスタコード照合が不正");
      found.add(code);
    }
  }
  return found;
}

export async function loadEdinetTickerMap(
  db: BaseSQLiteDatabase<"async", unknown, Record<string, unknown>>,
  edinetCodes: string[]
): Promise<Map<string, string>> {
  const codes = [...new Set(edinetCodes)];
  if (codes.length === 0) return new Map();
  const out = new Map<string, string>();
  // D1 bind 上限100以内。区画＋issuerの既存PKだけを照会する。
  for (let i = 0; i < codes.length; i += 90) {
    const batch = codes.slice(i, i + 90);
    const rows = await db.select({ edinetCode: notionPages.code, ticker: notionPages.pageId })
      .from(notionPages)
      .where(and(eq(notionPages.db, "stock_master_by_edinet"), inArray(notionPages.code, batch)));
    for (const row of rows) {
      if (!batch.includes(row.edinetCode) || !/^E\d{5}$/.test(row.edinetCode)
        || parseStockCode(row.ticker) !== row.ticker || out.has(row.edinetCode)) {
        throw new Error("EDINET提出者の銘柄逆引きが不正または非一意です。");
      }
      out.set(row.edinetCode, row.ticker);
    }
  }
  return out;
}

/**
 * 証券コードが明記されていれば従来の厳密変換のみ。NULL の場合に限り、
 * 年次書類自身の提出者を既存マスタで解決する。未観測は null のまま返す。
 * 大量保有の issuerEdinetCode (提出者と異なる会社) は有報には使わない。
 */
export function resolveAnnualTicker(
  doc: EdinetDoc,
  edinetToTicker: ReadonlyMap<string, string>
): string | null {
  if (doc.secCode !== null) return secCodeToTicker(doc.secCode);
  if (!isAnnualSecuritiesReport(doc) || doc.withdrawalStatus !== "0"
    || doc.docInfoEditStatus !== "0" || doc.disclosureStatus !== "0"
    || resolveReportPeriodEnd(doc) === null) return null;
  if (doc.edinetCode === null) return null;
  const ticker = edinetToTicker.get(doc.edinetCode);
  if (ticker === undefined) return null;
  if (parseStockCode(ticker) !== ticker) {
    throw new Error("EDINET提出者の銘柄逆引きが不正です。");
  }
  return ticker;
}
