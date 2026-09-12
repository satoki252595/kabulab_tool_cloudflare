import { asc, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  stocks,
  stockFinancials,
  stockAnnualFinancials,
} from "../db/core-schema.js";
import { stockRsiPercentile } from "../db/schema.js";

/** 銘柄詳細レスポンス */
export interface StockDetail {
  code: string;
  name: string;
  market: string;
  sector: string | null;
  financials: {
    price: number | null;
    per: number | null;
    pbr: number | null;
    dividendYield: number | null;
    eps: number | null;
    bps: number | null;
    roe: number | null;
    roa: number | null;
    marketCap: number | null;
    /** 営業利益率 TTM (0.1234 = 12.34%) */
    operatingMargin: number | null;
    dataDate: string;
  } | null;
  rsi: {
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
    /** パーセンタイル母集団に使った終値の本数 (母数 N)。未計算は null */
    percentileSampleBars: number | null;
    /** パーセンタイルの算出時刻 (鮮度) */
    computedAt: Date;
  } | null;
  annualFinancials: Array<{
    fiscalYear: number;
    revenue: number | null;
  }>;
}

/**
 * 銘柄コードから銘柄詳細を取得する
 *
 * @param db - Drizzleクライアント
 * @param code - 銘柄コード
 * @returns 銘柄詳細。存在しない場合はnull
 */
export async function getStockDetail(db: Database, code: string): Promise<StockDetail | null> {
  const stock = await db.select().from(stocks).where(eq(stocks.code, code)).limit(1);
  if (stock.length === 0) return null;
  const stockRow = stock[0];

  const [financialsRow, percentileRow, annualRows] = await Promise.all([
    db
      .select()
      .from(stockFinancials)
      .where(eq(stockFinancials.stockId, stockRow.id))
      .limit(1),
    db
      .select()
      .from(stockRsiPercentile)
      .where(eq(stockRsiPercentile.stockId, stockRow.id))
      .limit(1),
    db
      .select()
      .from(stockAnnualFinancials)
      .where(eq(stockAnnualFinancials.stockId, stockRow.id))
      .orderBy(asc(stockAnnualFinancials.fiscalYear)),
  ]);

  const fin = financialsRow[0];
  const pct = percentileRow[0];

  return {
    code: stockRow.code,
    name: stockRow.name,
    market: stockRow.market,
    sector: stockRow.sector,
    financials: fin
      ? {
          price: fin.price,
          per: fin.per,
          pbr: fin.pbr,
          dividendYield: fin.dividendYield,
          eps: fin.eps,
          bps: fin.bps,
          roe: fin.roe,
          roa: fin.roa,
          marketCap: fin.marketCap,
          operatingMargin: fin.operatingMargin,
          dataDate: fin.dataDate,
        }
      : null,
    rsi: pct
      ? {
          rsi10: pct.rsi10,
          rsi10Percentile: pct.rsi10Percentile,
          rsi40: pct.rsi40,
          rsi40Percentile: pct.rsi40Percentile,
          rsi120: pct.rsi120,
          rsi120Percentile: pct.rsi120Percentile,
          rsiMinPercentile: pct.rsiMinPercentile,
          isBlueChip: pct.isBlueChip,
          operatingMarginTtm: pct.operatingMarginTtm,
          revenueTrend: pct.revenueTrend,
          percentileSampleBars: pct.percentileSampleBars,
          computedAt: pct.computedAt,
        }
      : null,
    annualFinancials: annualRows.map((r) => ({
      fiscalYear: r.fiscalYear,
      revenue: r.revenue,
    })),
  };
}
