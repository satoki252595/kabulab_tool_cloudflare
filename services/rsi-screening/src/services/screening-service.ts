import { and, asc, count, desc, eq, gte, lt, lte, sql, type SQL } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { stocks, stockFinancials } from "../db/core-schema.js";
import { stockRsiPercentile } from "../db/schema.js";
import {
  publicMarketColumn,
  publicSectorColumn,
} from "../../../../src/shared/db/public-columns.js";
import type { ScreeningQuery } from "../validators/screening.js";

/** スクリーニング結果の1行 */
export interface ScreeningRow {
  code: string;
  name: string;
  /** 市場区分。JPX 由来 = personal-only なので既定では常に `null`。 */
  market: string | null;
  /** 業種。既定では `core_stocks.sector33` (EDINET 提出者業種)。 */
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
  /**
   * パーセンタイル母集団に使った終値の本数 (母数 N)。
   * sync が 1 周していない行は NULL のまま (ルール2: 0 で埋めない)。
   */
  percentileSampleBars: number | null;
  /** このパーセンタイルを算出した時刻 (鮮度の判断材料として UI に出す) */
  computedAt: Date;
}

/** スクリーニング結果 (行 + 鮮度で落とした件数) */
export interface ScreeningResult {
  rows: ScreeningRow[];
  /**
   * 鮮度条件だけで除外した行数。
   *
   * 黙って落とすと「該当なし」と「古い行しか無い」の区別が読者に付かないので
   * 件数を返し、画面に出す (ルール2: 欠損は欠損として見せる)。
   */
  staleExcluded: number;
  /** 適用した鮮度上限 (日) */
  maxAgeDays: number;
}

/**
 * パーセンタイルの鮮度上限 (日)。
 *
 * 日次 sync は GitHub Actions の `0 21 * * 1-5` (平日のみ) で回るため、正常でも
 * 金曜 21:00 → 月曜 21:00 の **3 日** は computed_at が据え置かれる (週末を跨ぐ
 * 行を誤除外しないための下限がここ)。加えて Yahoo 429 や Actions 障害で 1〜2 回
 * run が落ちても生きている行を落としたくないので、3 日 + 予備 4 日 = 7 日とする。
 *
 * 日本の祝日は考慮不要: cron は JPX の休場日にも回り、休場日でも Yahoo の
 * 最新バーで computed_at は更新される (止まるのは run の失敗時だけ)。
 *
 * 実測 (2026-09-12 時点) では rsi_percentile の computed_at は MIN=2026-05-15 /
 * MAX=2026-09-11 で、**7 日超の行が 49 件**。4 ヶ月前のパーセンタイルが最新値と
 * 同列に並び順位付けにも使われていたので、この 49 件が除外対象になる。
 */
export const PERCENTILE_MAX_AGE_DAYS = 7;

/**
 * 鮮度条件の境界時刻 — これ以降の computed_at を「最新」とみなす
 *
 * SQLite の `unixepoch('now')` ではなく呼出側の `now` から作る。境界を
 * テストから注入できるようにするため (週末跨ぎの誤除外を実際に検証する)。
 */
export function percentileFreshnessCutoff(
  now: Date,
  maxAgeDays: number = PERCENTILE_MAX_AGE_DAYS
): Date {
  return new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000);
}

/**
 * RSIパーセンタイル + 優良株フラグでスクリーニングする
 *
 * `computed_at` が古い行は結果から外す。以前は鮮度を一切見ておらず、
 * 4 ヶ月前のパーセンタイルが最新値と同じ表に並び、パーセンタイル昇順の
 * 順位付けにもそのまま使われていた (古い行のほうが底値に見えやすい)。
 *
 * @param db - Drizzleクライアント
 * @param query - スクリーニング条件
 * @param now - 鮮度判定の基準時刻 (テストからの注入点)
 * @returns 条件に合致する銘柄リストと、鮮度で除外した件数
 */
export async function screenStocks(
  db: Database,
  query: ScreeningQuery,
  now: Date = new Date()
): Promise<ScreeningResult> {
  const targetColumn = pickPercentileColumn(query.period);
  const targetRsiColumn = pickRsiColumn(query.period);
  const freshnessCutoff = percentileFreshnessCutoff(now);

  // 鮮度以外の条件。鮮度で落ちた件数を数えるときに同じ条件を使い回す。
  const baseConditions: SQL[] = [
    eq(stocks.isActive, true),
    sql`${targetColumn} IS NOT NULL`,
    lte(targetColumn, query.percentileMax),
  ];

  if (query.blueChip) {
    baseConditions.push(eq(stockRsiPercentile.isBlueChip, true));
  }

  const conditions: SQL[] = [
    ...baseConditions,
    gte(stockRsiPercentile.computedAt, freshnessCutoff),
  ];

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
      // JPX 由来は公開面へ出さない (src/shared/db/public-columns.ts)。
      market: publicMarketColumn,
      sector: publicSectorColumn,
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
      percentileSampleBars: stockRsiPercentile.percentileSampleBars,
      computedAt: stockRsiPercentile.computedAt,
    })
    .from(stockRsiPercentile)
    .innerJoin(stocks, eq(stocks.id, stockRsiPercentile.stockId))
    .leftJoin(stockFinancials, eq(stockFinancials.stockId, stocks.id))
    .where(and(...conditions))
    .orderBy(orderBy)
    .limit(query.limit)
    .offset(query.offset);

  // 鮮度だけで落ちた件数。limit/offset は掛けない (ページ内の件数ではなく
  // 「条件には合うが古い」総数を読者に見せたい)。
  const [{ staleExcluded }] = await db
    .select({ staleExcluded: count() })
    .from(stockRsiPercentile)
    .innerJoin(stocks, eq(stocks.id, stockRsiPercentile.stockId))
    .where(
      and(...baseConditions, lt(stockRsiPercentile.computedAt, freshnessCutoff))
    );

  return { rows, staleExcluded, maxAgeDays: PERCENTILE_MAX_AGE_DAYS };
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
