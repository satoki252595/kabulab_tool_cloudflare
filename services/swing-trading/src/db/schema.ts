import { sql, relations } from "drizzle-orm";
import {
  sqliteTable,
  integer,
  text,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { stocks } from "./core-schema.js";

/**
 * 003 Swing Trading 固有スキーマ（Cloudflare D1 / SQLite 版） — ADR-0001。
 *
 * 所有権: このプロジェクトのみが読み書きする。
 * `core_stocks` / `core_stock_financials` は読み取り専用で参照する。
 *
 * D1 は名前空間が無いため旧 `swing.<table>` を `swing_<table>` に降ろす。
 *
 * 方言マッピング (PostgreSQL → SQLite, ADR-0001 §4):
 *   serial            → integer primaryKey autoIncrement
 *   timestamp+now()   → integer({mode:'timestamp'}) default (unixepoch())
 *   date              → text ('YYYY-MM-DD' 文字列)
 *   boolean           → integer({mode:'boolean'})
 */

// -----------------------------------------------------------------------------
// 1. swing_daily_ohlcv — 日足 OHLCV 履歴 (約 90 営業日保持)
// -----------------------------------------------------------------------------

/**
 * 日足 OHLCV 履歴
 *
 * Yahoo Finance が穴を開けることがあるため open/high/low/close/volume は NULL 許容。
 * NULL 行は指標計算時に除外する。
 */
export const dailyOhlcv = sqliteTable(
  "swing_daily_ohlcv",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    stockId: integer("stock_id")
      .references(() => stocks.id, { onDelete: "cascade" })
      .notNull(),
    date: text("date").notNull(),
    open: real("open"),
    high: real("high"),
    low: real("low"),
    close: real("close"),
    volume: real("volume"),
    /** 分割調整済み終値 (Yahoo adjclose)。CA 前後の RSI/SMA/MACD 計算に使用 */
    adj: real("adj"),
  },
  (table) => [
    uniqueIndex("idx_swing_ohlcv_stock_date").on(table.stockId, table.date),
    index("idx_swing_ohlcv_date").on(table.date),
  ]
);

// -----------------------------------------------------------------------------
// 2. swing_stock_indicators — 銘柄ごとの最新テクニカル集計 (1 銘柄 1 行 upsert)
// -----------------------------------------------------------------------------

export const stockIndicators = sqliteTable(
  "swing_stock_indicators",
  {
    stockId: integer("stock_id")
      .primaryKey()
      .references(() => stocks.id, { onDelete: "cascade" }),

    // --- 流動性 ---
    /** 20 日平均売買代金 (円) = Σ(close × volume) / N */
    avgTurnover20d: real("avg_turnover_20d"),
    /** 20 日平均出来高 (株) */
    volume20d: real("volume_20d"),
    /** 当日出来高 / 20 日平均 (3 倍以上で「出来高急増」扱い) */
    volumeRatio: real("volume_ratio"),

    // --- ボラティリティ ---
    /** ATR(14) — Wilder's true range average */
    atr14: real("atr_14"),
    /** ATR14 / 終値 (0.02 以上で条件②充足) */
    atrPct: real("atr_pct"),

    // --- トレンド ---
    sma5: real("sma_5"),
    sma20: real("sma_20"),
    /**
     * SMA(25) — otakara-yutai の MA25 乖離率スコアリングで使用する。
     * swing 自体のスクリーニングには使わないが、月次 sync で otakara が
     * このテーブルを読むため一緒に計算・保存している。
     */
    sma25: real("sma_25"),
    sma60: real("sma_60"),
    sma75: real("sma_75"),
    /** 5>20 かつ 終値>5MA (ロング環境) */
    trendLong: integer("trend_long", { mode: "boolean" })
      .default(false)
      .notNull(),
    /** 5<20 かつ 終値<5MA (ショート環境) */
    trendShort: integer("trend_short", { mode: "boolean" })
      .default(false)
      .notNull(),
    /** パーフェクトオーダー 5>20>60 (押し目買いの前提条件) */
    perfectOrderLong: integer("perfect_order_long", { mode: "boolean" })
      .default(false)
      .notNull(),
    /** パーフェクトオーダー 5<20<60 */
    perfectOrderShort: integer("perfect_order_short", { mode: "boolean" })
      .default(false)
      .notNull(),

    // --- モメンタム ---
    rsi14: real("rsi_14"),
    macd: real("macd"),
    macdSignal: real("macd_signal"),
    macdHist: real("macd_hist"),

    // --- 20 日レンジ (ブレイクアウト判定) ---
    range20dHigh: real("range_20d_high"),
    range20dLow: real("range_20d_low"),
    /** range20dHigh - range20dLow */
    rangeWidth: real("range_width"),

    // --- フィボナッチ (押し目買い用、20 日高安の fib 38.2/50/61.8) ---
    fibHigh: real("fib_high"),
    fibLow: real("fib_low"),
    fib382: real("fib_382"),
    fib500: real("fib_500"),
    fib618: real("fib_618"),

    // --- 最新値 ---
    latestClose: real("latest_close"),
    latestVolume: real("latest_volume"),
    latestDate: text("latest_date"),
    /** 前日比% (当日 close - 前日 close) / 前日 close × 100 */
    pctChange1d: real("pct_change_1d"),

    // --- スクリーニング結果 (L-52: swing_stock_screening を畳む) ---
    // screenStock() (src/shared/screener.ts) の純関数 4 bool + 2 派生。
    // 需給/カタリストの note 列は定数 ("外部データ未対応") で読み手が無いので畳まない。
    /** ① 流動性: avgTurnover20d ≧ 10億 OR (volumeRatio ≧ 3 AND avgTurnover20d ≧ 5億) */
    liquidityOk: integer("liquidity_ok", { mode: "boolean" })
      .default(false)
      .notNull(),
    /** ② ボラ: atrPct ≧ 0.02 */
    volatilityOk: integer("volatility_ok", { mode: "boolean" })
      .default(false)
      .notNull(),
    /** ③ トレンド long: 5>20 かつ close>5MA */
    trendOkLong: integer("trend_ok_long", { mode: "boolean" })
      .default(false)
      .notNull(),
    /** ③ トレンド short: 逆 */
    trendOkShort: integer("trend_ok_short", { mode: "boolean" })
      .default(false)
      .notNull(),
    /** ① ② ③long 全て true */
    allPassedLong: integer("all_passed_long", { mode: "boolean" })
      .default(false)
      .notNull(),
    /** ① ② ③short 全て true */
    allPassedShort: integer("all_passed_short", { mode: "boolean" })
      .default(false)
      .notNull(),

    computedAt: integer("computed_at", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
  },
  (table) => [
    // screening 表の 2 索引を移したもの (L-52)。/screening の駆動索引。
    index("idx_swing_indicators_all_passed_long").on(table.allPassedLong),
    index("idx_swing_indicators_all_passed_short").on(table.allPassedShort),
  ]
);

// swing_stock_screening は L-52 で削除 (indicators の列に畳んだ。kabulab-cf 0015 で DROP)。
// 番号は振り直さない (drizzle の migration 履歴とコメントの対応がずれるため)。

// -----------------------------------------------------------------------------
// 4. swing_entry_signals — E&E パターン判定 (1 銘柄 × 複数パターン行)
// -----------------------------------------------------------------------------

/**
 * パターン種別:
 *   - "breakout_long"   : ブレイクアウト (20 日高値突破 + 出来高 1.5x)
 *   - "breakout_short"  : ブレイクアウト (20 日安値割れ + 出来高 1.5x)
 *   - "pullback_long"   : 押し目買い (パーフェクトオーダー + fib 38.2-61.8)
 *   - "pullback_short"  : 戻り売り
 *   - "volume_surge"    : 出来高急増 (3 倍 + 値動き 3% 以上) 翌日狙い
 *   - "gap_follow"      : ギャップ追随 (|ギャップ%| 1.5%+出来高 2x)
 *   - "gap_fade"        : ギャップ逆張り (材料なしの普通窓 → 窓埋め狙い)
 *   - "post_earnings"   : 決算後初動 (financials の直近更新 + 出来高急増)
 */
export const entrySignals = sqliteTable(
  "swing_entry_signals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    stockId: integer("stock_id")
      .references(() => stocks.id, { onDelete: "cascade" })
      .notNull(),
    pattern: text("pattern").notNull(),
    direction: text("direction").notNull(), // "long" | "short"

    entryPrice: real("entry_price").notNull(),
    stopLoss: real("stop_loss").notNull(),
    target1: real("target_1"),
    target2: real("target_2"),
    /** (target1 - entry) / (entry - stop) の絶対値。2 以上で推奨 */
    riskRewardRatio: real("risk_reward_ratio"),
    /** 0-100 のシグナル強度 (出来高倍率・価格位置などから計算) */
    signalStrength: real("signal_strength"),
    note: text("note"),

    computedAt: integer("computed_at", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
  },
  (table) => [
    index("idx_swing_signals_pattern_strength").on(
      table.pattern,
      table.signalStrength
    ),
    index("idx_swing_signals_stock").on(table.stockId),
    index("idx_swing_signals_computed").on(table.computedAt),
  ]
);

// -----------------------------------------------------------------------------
// 5. swing_market_context — マクロ判定 (1 日 1 行 upsert)
// -----------------------------------------------------------------------------

export const marketContext = sqliteTable("swing_market_context", {
  date: text("date").primaryKey(),

  /** 日経平均終値 (^N225) */
  nikkeiClose: real("nikkei_close"),
  /** 日経平均前日比% */
  nikkeiPct: real("nikkei_pct"),
  /** 日経 VI (^NKVI) — 取得不能の場合は NULL */
  nikkeiVi: real("nikkei_vi"),
  /** TOPIX 売買代金 20 日平均比 (=当日 / 20 日平均) */
  topixTurnoverRatio: real("topix_turnover_ratio"),
  /** 日経 225 先物(^NKD) 夜間 - 日経現物前日終値 (円) */
  futuresGap: real("futures_gap"),
  /** VIX */
  vix: real("vix"),
  /** S&P500 前日比% */
  sp500Pct: real("sp500_pct"),

  /** "A" | "B" | "C" | "D" | "HOLD" (判定保留) */
  judgment: text("judgment").notNull(),
  judgmentReason: text("judgment_reason").notNull(),

  computedAt: integer("computed_at", { mode: "timestamp" })
    .default(sql`(unixepoch())`)
    .notNull(),
});

// -----------------------------------------------------------------------------
// 6. swing_sector_daily — セクター騰落ランキング (1 日 × 業種)
// -----------------------------------------------------------------------------

export const sectorDaily = sqliteTable(
  "swing_sector_daily",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    date: text("date").notNull(),
    sector: text("sector").notNull(),
    /** 当日セクター平均騰落率% */
    pct1d: real("pct_1d"),
    /** 過去 5 営業日の累積騰落率% */
    pct5d: real("pct_5d"),
    /** セクター内銘柄数 */
    stockCount: integer("stock_count").notNull(),
    /** 当日ランク (1 = 最も上昇) */
    rank1d: integer("rank_1d"),
  },
  (table) => [
    uniqueIndex("idx_swing_sector_date_sector").on(table.date, table.sector),
    index("idx_swing_sector_date_rank").on(table.date, table.rank1d),
  ]
);

// --- Relations ---

export const dailyOhlcvRelations = relations(dailyOhlcv, ({ one }) => ({
  stock: one(stocks, {
    fields: [dailyOhlcv.stockId],
    references: [stocks.id],
  }),
}));

export const stockIndicatorsRelations = relations(stockIndicators, ({ one }) => ({
  stock: one(stocks, {
    fields: [stockIndicators.stockId],
    references: [stocks.id],
  }),
}));

export const entrySignalsRelations = relations(entrySignals, ({ one }) => ({
  stock: one(stocks, {
    fields: [entrySignals.stockId],
    references: [stocks.id],
  }),
}));
