import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  stocks,
  stockFinancials,
} from "../../../../src/shared/db/core-schema.js";
import {
  jssFinancials,
  pickAnnualSeries,
  PUBLISHABLE_LICENSE_TAG,
  type AnnualSeriesPoint,
} from "../../../../src/shared/db/jss-financials.js";
import { stockRsiPercentile } from "../db/schema.js";
import {
  publicMarketColumn,
  publicSectorColumn,
} from "../../../../src/shared/db/public-columns.js";

/** 銘柄詳細レスポンス */
export interface StockDetail {
  code: string;
  name: string;
  /**
   * 市場区分。JPX 由来 = personal-only なので既定では常に `null`
   * (src/shared/db/public-columns.ts)。表示側は null を省くこと。
   */
  market: string | null;
  /** 業種。既定では `core_stocks.sector33` (EDINET 提出者業種)。 */
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
  /**
   * 年度売上系列 (古い→新しい順)。正本 `jss_financials` の本決算実績。
   * 選定は共有 gate (`pickAnnualSeries`) が行う: 公開可 (commercial-ok) のみ、
   * 最新期の連結区分に単一化、未来期のみ除外。短期決算の推測除外はせず、
   * 決算期変更の端数期も欠損 (null・年欠落) と同じく原文のまま保持する。
   */
  annualFinancials: AnnualSeriesPoint[];
}

/** 基準日 (UTC 当日 'YYYY-MM-DD')。未来期の除外に使う */
function todayUtc(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * 銘柄コードから銘柄詳細を取得する
 *
 * @param db - Drizzleクライアント
 * @param code - 銘柄コード
 * @param asOf - 基準日 'YYYY-MM-DD' (既定は UTC 当日。未来期の除外境界)
 * @returns 銘柄詳細。存在しない場合はnull
 */
export async function getStockDetail(
  db: Database,
  code: string,
  asOf: string = todayUtc()
): Promise<StockDetail | null> {
  // 列を明示する。`select()` (列指定なし) は core_stocks の全列 = `personal-only` の
  // sector33 / instrument_type / license_tag / src_source / quality まで
  // 公開面のプロセスへ載せてしまう。sector33 は stockStock の master_sync が
  // 既に値を埋めているため、詰め替え漏れではなくクエリで落とす必要が現に有効。
  // (src/shared/db/core-stocks-license-boundary.test.ts が列指定なしを禁じている)
  const stock = await db
    .select({
      id: stocks.id,
      code: stocks.code,
      name: stocks.name,
      // JPX 由来の market / sector は公開面へ出さない。出す列は
      // src/shared/db/public-columns.ts が 1 箇所で決める。
      market: publicMarketColumn,
      sector: publicSectorColumn,
    })
    .from(stocks)
    .where(eq(stocks.code, code))
    .limit(1);
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
    // 年度売上は正本 `jss_financials` の本決算実績から読む。旧
    // `core_stock_annual_financials` (Yahoo 派生・連結/単体混在・暦年丸め) は
    // 001 の表示ではもう読まない (writer は外部 consumer が残るので維持)。
    // 四半期 (1Q/2Q/中間/3Q)・修正・予想は年度実績に混ぜない。
    // 公開可 (commercial-ok。EDINET) の行だけを SQL で絞る。TDnet 短信由来
    // (factual-cite) を公開面に出さない — 来歴列を select しないだけでは
    // 公開制限にならないので WHERE で落とす。
    db
      .select({
        fiscalPeriodEnd: jssFinancials.fiscalPeriodEnd,
        consolidated: jssFinancials.consolidated,
        revenue: jssFinancials.netSales,
      })
      .from(jssFinancials)
      .where(
        and(
          eq(jssFinancials.code, stockRow.code),
          eq(jssFinancials.disclosureType, "本決算"),
          eq(jssFinancials.licenseTag, PUBLISHABLE_LICENSE_TAG)
        )
      )
      // fiscal_period_end は 'YYYY-MM-DD' 固定なので TEXT 順 = 時系列順。
      .orderBy(asc(jssFinancials.fiscalPeriodEnd)),
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
          operatingMarginTtm: fin?.operatingMargin ?? null,
          revenueTrend: pct.revenueTrend,
          percentileSampleBars: pct.percentileSampleBars,
          computedAt: pct.computedAt,
        }
      : null,
    annualFinancials: pickAnnualSeries(annualRows, asOf),
  };
}
