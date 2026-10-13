/** 最新会計期末→同一期末の最新訂正だけを、決定的なコード順で走査する。 */
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { stocks } from "../../../../src/shared/db/core-schema.js";
import { disclosureIngestCondition } from "../../../../src/shared/db/active-equity.js";
import { yuhoDocuments } from "../../src/db/schema.js";
import { parseStockCode } from "../../../../src/shared/jpx/stock-code.js";

export async function selectLatestHoldingsDocuments(
  db: BaseSQLiteDatabase<"async", unknown, Record<string, unknown>>,
  args: { afterCode: string | null; limit: number }
) {
  if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 50 ||
      (args.afterCode !== null && parseStockCode(args.afterCode) !== args.afterCode)) throw new Error("保有明細backfillの明示範囲が不正です");
  const latest = db.select({ stockId: yuhoDocuments.stockId, docId: yuhoDocuments.docId,
    edinetCode: yuhoDocuments.edinetCode, ownerName: yuhoDocuments.filerName, fiscalYearEnd: yuhoDocuments.periodEnd,
    submittedAt: yuhoDocuments.submittedAt,
    rank: sql<number>`row_number() over (partition by ${yuhoDocuments.stockId} order by ${yuhoDocuments.periodEnd} desc, ${yuhoDocuments.submittedAt} desc, ${yuhoDocuments.id} desc)`.as("latest_rank"),
  }).from(yuhoDocuments).where(inArray(yuhoDocuments.docTypeCode, ["120", "130"])).as("latest_holdings");
  const rows = await db.select({ stockId: latest.stockId, stockCode: stocks.code, docId: latest.docId,
    edinetCode: latest.edinetCode, ownerName: latest.ownerName, fiscalYearEnd: latest.fiscalYearEnd, submittedAt: latest.submittedAt,
  }).from(latest).innerJoin(stocks, eq(stocks.id, latest.stockId))
    .where(and(eq(latest.rank, 1), disclosureIngestCondition(), args.afterCode === null ? undefined : gt(stocks.code, args.afterCode)))
    .orderBy(asc(stocks.code)).limit(args.limit + 1);
  return { rows: rows.slice(0, args.limit), more: rows.length > args.limit };
}
