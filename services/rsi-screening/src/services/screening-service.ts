import { and, asc, desc, eq, lte, sql, type SQL } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { stocks, stockFinancials } from "../db/core-schema.js";
import { stockRsiPercentile } from "../db/schema.js";
import type { ScreeningQuery } from "../validators/screening.js";

/** スクリーニング結果の1行 */
export interface ScreeningRow {
  code: string;
  name: string;
  market: string;
  sector: string | null;
  price: number | null;
  per: number | null;
  pbr: number | null;
  dividendYield: number | null;
  marketCap: number | null;
  rsi10: number | null;
  rsi10Percentile: number | null;
  rsi40: number | null;
  rsi40Percentile: number | null;
  rsi120: number | null;
  rsi120Percentile: number | null;
  rsiMinPercentile: number | null;
  isBlueChip: boolean;
  /** 営業利益率 TTM (0.1234 = 12.34%) */
  operatingMarginTtm: number | null;
  revenueTrend: number | null;
}

/**
 * RSIパーセンタイル + 優良株フラグでスクリーニングする
 *
 * @param db - Drizzleクライアント
 * @param query - スクリーニング条件
 * @returns 条件に合致する銘柄リスト
 */
export async function screenStocks(
  db: Database,
  query: ScreeningQuery
): Promise<ScreeningRow[]> {
  const targetColumn = pickPercentileColumn(query.period);
  const targetRsiColumn = pickRsiColumn(query.period);

  const conditions: SQL[] = [
    eq(stocks.isActive, true),
    sql`${targetColumn} IS NOT NULL`,
    lte(targetColumn, query.percentileMax),
  ];

  if (query.blueChip) {
    conditions.push(eq(stockRsiPercentile.isBlueChip, true));
  }

  const orderBy: SQL = (() => {
    switch (query.sort) {
      case "rsi":
        return targetRsiColumn ? asc(targetRsiColumn) : asc(targetColumn);
      case "marketCap":
        return desc(sql`${stockFinancials.marketCap}`);
      case "percentile":
      default:
        return asc(targetColumn);
    }
  })();

  const rows = await db
    .select({
      code: stocks.code,
      name: stocks.name,
      market: stocks.market,
      sector: stocks.sector,
      price: stockFinancials.price,
      per: stockFinancials.per,
      pbr: stockFinancials.pbr,
      dividendYield: stockFinancials.dividendYield,
      marketCap: stockFinancials.marketCap,
      rsi10: stockRsiPercentile.rsi10,
      rsi10Percentile: stockRsiPercentile.rsi10Percentile,
      rsi40: stockRsiPercentile.rsi40,
      rsi40Percentile: stockRsiPercentile.rsi40Percentile,
      rsi120: stockRsiPercentile.rsi120,
      rsi120Percentile: stockRsiPercentile.rsi120Percentile,
      rsiMinPercentile: stockRsiPercentile.rsiMinPercentile,
      isBlueChip: stockRsiPercentile.isBlueChip,
      operatingMarginTtm: stockRsiPercentile.operatingMarginTtm,
      revenueTrend: stockRsiPercentile.revenueTrend,
    })
    .from(stockRsiPercentile)
    .innerJoin(stocks, eq(stocks.id, stockRsiPercentile.stockId))
    .leftJoin(stockFinancials, eq(stockFinancials.stockId, stocks.id))
    .where(and(...conditions))
    .orderBy(orderBy)
    .limit(query.limit)
    .offset(query.offset);

  return rows;
}

/** period → パーセンタイルカラム */
function pickPercentileColumn(period: ScreeningQuery["period"]) {
  switch (period) {
    case "10":
      return stockRsiPercentile.rsi10Percentile;
    case "40":
      return stockRsiPercentile.rsi40Percentile;
    case "120":
      return stockRsiPercentile.rsi120Percentile;
    case "min":
    default:
      return stockRsiPercentile.rsiMinPercentile;
  }
}

/** period → RSI値カラム (minはnull) */
function pickRsiColumn(period: ScreeningQuery["period"]) {
  switch (period) {
    case "10":
      return stockRsiPercentile.rsi10;
    case "40":
      return stockRsiPercentile.rsi40;
    case "120":
      return stockRsiPercentile.rsi120;
    case "min":
    default:
      return null;
  }
}
