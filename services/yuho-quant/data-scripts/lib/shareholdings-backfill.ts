/** 最新会計期末→同一期末の最新訂正だけを、決定的なコード順で走査する。 */
import { and, asc, eq, exists, gt, inArray, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { stocks } from "../../../../src/shared/db/core-schema.js";
import { activeEquityCondition } from "../../../../src/shared/db/active-equity.js";
import { yuhoDocuments } from "../../src/db/schema.js";
import { parseStockCode } from "../../../../src/shared/jpx/stock-code.js";

export async function selectLatestHoldingsDocuments(
  db: BaseSQLiteDatabase<"async", unknown, Record<string, unknown>>,
  args: { afterCode: string | null; limit: number; onlyCode?: string }
) {
  if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 50 ||
      (args.afterCode !== null && parseStockCode(args.afterCode) !== args.afterCode) ||
      (args.onlyCode !== undefined && (typeof args.onlyCode !== "string" || parseStockCode(args.onlyCode) !== args.onlyCode))) throw new Error("保有明細backfillの明示範囲が不正です");
  // 年報の無い銘柄にページ枠を使わず、今回の候補だけで履歴の順位を計算する。
  // 実測済みのcode順走査を固定する。索引欠落はprepare失敗とし、別計画へ切り替えない。
  const candidates = db.select({ id: sql<number>`${stocks.id}` }).from(sql`${stocks} INDEXED BY ${sql.identifier("core_stocks_code_unique")}`).where(and(activeEquityCondition(),
    args.afterCode === null ? undefined : gt(stocks.code, args.afterCode),
    args.onlyCode === undefined ? undefined : eq(stocks.code, args.onlyCode),
    exists(db.select({ stockId: yuhoDocuments.stockId }).from(yuhoDocuments).where(and(
      eq(yuhoDocuments.stockId, stocks.id), inArray(yuhoDocuments.docTypeCode, ["120", "130"]))))))
    .orderBy(asc(stocks.code)).limit(args.limit + 1);
  const latest = db.select({ stockId: yuhoDocuments.stockId, docId: yuhoDocuments.docId,
    edinetCode: yuhoDocuments.edinetCode, ownerName: yuhoDocuments.filerName, fiscalYearEnd: yuhoDocuments.periodEnd,
    submittedAt: yuhoDocuments.submittedAt,
    rank: sql<number>`row_number() over (partition by ${yuhoDocuments.stockId} order by ${yuhoDocuments.periodEnd} desc, ${yuhoDocuments.submittedAt} desc, ${yuhoDocuments.id} desc)`.as("latest_rank"),
  }).from(yuhoDocuments).where(and(inArray(yuhoDocuments.docTypeCode, ["120", "130"]),
    inArray(yuhoDocuments.stockId, candidates))).as("latest_holdings");
  const rows = await db.select({ stockId: latest.stockId, stockCode: sql<string>`${stocks.code}`, docId: latest.docId,
    edinetCode: latest.edinetCode, ownerName: latest.ownerName, fiscalYearEnd: latest.fiscalYearEnd, submittedAt: latest.submittedAt,
  // NOT INDEXEDでもINTEGER PRIMARY KEYは使える。候補だけをrowidで引き、active全株を再走査しない。
  }).from(latest).innerJoin(sql`${stocks} NOT INDEXED`, eq(stocks.id, latest.stockId))
    .where(and(eq(latest.rank, 1), activeEquityCondition(), args.afterCode === null ? undefined : gt(stocks.code, args.afterCode),
      args.onlyCode === undefined ? undefined : eq(stocks.code, args.onlyCode)))
    .orderBy(asc(stocks.code)).limit(args.limit + 1);
  return { rows: rows.slice(0, args.limit), more: rows.length > args.limit };
}
