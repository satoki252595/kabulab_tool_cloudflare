import { sql } from "drizzle-orm";
import {
  sqliteTable,
  integer,
  text,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * 003 Swing Trading のスキーマを **読み取り専用** で再宣言する
 * （Cloudflare D1 / SQLite 版） — ADR-0001。
 *
 * 004 Financial Math は CAPM の β 計算 (個別銘柄リターン vs 日経平均) に
 * 過去日足が必要、また Black-Scholes のヒストリカルボラティリティ算出にも
 * 過去日足が必要。これらは `swing_daily_ohlcv` から取得する。
 *
 * また、低ボラ・アノマリースクリーニングで `swing_stock_indicators.atr_pct`
 * を参照する。
 *
 * **書き込みは一切行わない**。所有権は 003 にある。テーブル定義は
 * services/swing-trading/src/db/schema.ts と一致させること。
 */

/**
 * 日足 OHLCV 履歴 (約 90 営業日保持)
 * — 003 が日次 sync で更新する。
 *
 * 004 はここを **個別銘柄の日足の正本**として読む (CAPM の β 推定、
 * Black-Scholes のヒストリカル σ)。以前は `finmath_daily_ohlcv` へ GET 中に
 * Yahoo から遅延充填していたが、実際に入っていたのは 7 シンボル 3,490 行だけで、
 * それ以外の銘柄では β/σ が既に死んでいた。詳細は services/price-cache.ts。
 */
export const dailyOhlcv = sqliteTable(
  "swing_daily_ohlcv",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    stockId: integer("stock_id").notNull(),
    date: text("date").notNull(),
    open: real("open"),
    high: real("high"),
    low: real("low"),
    close: real("close"),
    volume: real("volume"),
    /**
     * 分割調整済み終値 (Yahoo adjclose)。0008 で本番へ入った列。
     *
     * 宣言から漏れていた。この再宣言は「本番の表と一致していること」だけが
     * 価値なので、列が欠けていると読めない列があることに気付けない。
     * (drizzle.d1.config.ts はこのファイルを読まないので DDL には影響しない)
     */
    adj: real("adj"),
  },
  (table) => [
    uniqueIndex("idx_swing_ohlcv_stock_date").on(table.stockId, table.date),
    index("idx_swing_ohlcv_date").on(table.date),
  ]
);

/**
 * 銘柄ごとの最新テクニカル集計 (1 銘柄 1 行)
 * 004 では atr_pct (低ボラスクリーニング)、latest_close (BS の S 初期値)、
 * pct_change_1d などを参照する。
 */
export const stockIndicators = sqliteTable("swing_stock_indicators", {
  stockId: integer("stock_id").primaryKey(),

  avgTurnover20d: real("avg_turnover_20d"),
  volume20d: real("volume_20d"),
  volumeRatio: real("volume_ratio"),

  atr14: real("atr_14"),
  atrPct: real("atr_pct"),

  sma5: real("sma_5"),
  sma20: real("sma_20"),
  sma25: real("sma_25"),
  sma60: real("sma_60"),
  sma75: real("sma_75"),
  trendLong: integer("trend_long", { mode: "boolean" }).default(false).notNull(),
  trendShort: integer("trend_short", { mode: "boolean" })
    .default(false)
    .notNull(),
  perfectOrderLong: integer("perfect_order_long", { mode: "boolean" })
    .default(false)
    .notNull(),
  perfectOrderShort: integer("perfect_order_short", { mode: "boolean" })
    .default(false)
    .notNull(),

  rsi14: real("rsi_14"),
  macd: real("macd"),
  macdSignal: real("macd_signal"),
  macdHist: real("macd_hist"),

  range20dHigh: real("range_20d_high"),
  range20dLow: real("range_20d_low"),
  rangeWidth: real("range_width"),

  fibHigh: real("fib_high"),
  fibLow: real("fib_low"),
  fib382: real("fib_382"),
  fib500: real("fib_500"),
  fib618: real("fib_618"),

  latestClose: real("latest_close"),
  latestVolume: real("latest_volume"),
  latestDate: text("latest_date"),
  pctChange1d: real("pct_change_1d"),

  computedAt: integer("computed_at", { mode: "timestamp" })
    .default(sql`(unixepoch())`)
    .notNull(),
});

/**
 * 日次マクロ判定 (1 日 1 行)
 *
 * 004 は `nikkei_close` を **CAPM の市場系列**として読む。`swing_daily_ohlcv` の
 * FK は `core_stocks` なので指数 (`^N225`) を置く場所が無く、D1 で日経平均の
 * 系列を持っているのはここだけ。実測 107 行 (2026-04-12 開始・`nikkei_close`
 * 非 NULL 106) で、`swing_daily_ohlcv` と日付が重なるのは 94 日しかない。
 *
 * 注意: 1 行は「日次 sync の run 1 回」であって 1 営業日ではない
 * (休場日にも行ができ、`nikkei_close` は前営業日の値のまま)。
 */
export const marketContext = sqliteTable("swing_market_context", {
  date: text("date").primaryKey(),
  nikkeiClose: real("nikkei_close"),
  nikkeiPct: real("nikkei_pct"),
  nikkeiVi: real("nikkei_vi"),
  topixTurnoverRatio: real("topix_turnover_ratio"),
  futuresGap: real("futures_gap"),
  vix: real("vix"),
  sp500Pct: real("sp500_pct"),
  judgment: text("judgment").notNull(),
  judgmentReason: text("judgment_reason").notNull(),
  computedAt: integer("computed_at", { mode: "timestamp" })
    .default(sql`(unixepoch())`)
    .notNull(),
});
