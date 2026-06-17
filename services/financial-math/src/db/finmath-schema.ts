import {
  pgSchema,
  serial,
  text,
  real,
  timestamp,
  date,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * 004 Financial Math 専用スキーマ
 *
 * 所有権: このサービス自身。core.stocks (otakara-yutai が writer) に
 * 縛られないユニバースを持つため、Yahoo クライアントを二次利用する
 * 遅延フェッチ + キャッシュで価格スナップショットを蓄える。
 *
 * 既定 TTL は呼び出し側 (price-cache.ts) で決める。スキーマ側は
 * `fetched_at` を必ず付ける契約だけ守る。
 */
export const finmathSchema = pgSchema("finmath");

/**
 * 最新価格スナップショット (code ごとに 1 行 = UPSERT)
 *
 * Yahoo Finance の Chart + QuoteSummary から得た数値を保持。
 * 名前は Yahoo からは取れないので nullable で保留 (将来 JPX/J-Quants で補完予定)。
 */
export const priceSnapshot = finmathSchema.table(
  "price_snapshot",
  {
    id: serial("id").primaryKey(),
    code: text("code").notNull(),
    name: text("name"),
    price: real("price"),
    per: real("per"),
    pbr: real("pbr"),
    dividendYield: real("dividend_yield"),
    eps: real("eps"),
    bps: real("bps"),
    roe: real("roe"),
    roa: real("roa"),
    marketCap: real("market_cap"),
    operatingMarginTtm: real("operating_margin_ttm"),
    /** Yahoo Chart API が返した最新営業日 (YYYY-MM-DD) */
    dataDate: date("data_date").notNull(),
    /** このスナップショットを取得した時刻 (キャッシュ判定に使う) */
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("idx_finmath_price_code").on(table.code)]
);

export type PriceSnapshot = typeof priceSnapshot.$inferSelect;
export type NewPriceSnapshot = typeof priceSnapshot.$inferInsert;

/**
 * 日足 OHLCV キャッシュ (シンボル × 日付 = ユニーク)
 *
 * - シンボル: 日本株 4 桁 ("1414", "7203") または指数 ("^N225")
 * - 「鮮度」は同一 symbol の `MAX(fetched_at)` で判定 (per-row TTL)
 * - Yahoo Chart API の 5 年ぶんをそのまま蓄える想定
 * - swing.daily_ohlcv とは独立: 母集団を core.stocks から切り離すための
 *   このサービス専用ストレージ
 */
export const dailyOhlcv = finmathSchema.table(
  "daily_ohlcv",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    date: date("date").notNull(),
    open: real("open"),
    high: real("high"),
    low: real("low"),
    close: real("close"),
    volume: real("volume"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_finmath_ohlcv_symbol_date").on(table.symbol, table.date),
    index("idx_finmath_ohlcv_symbol").on(table.symbol),
  ]
);

export type DailyOhlcv = typeof dailyOhlcv.$inferSelect;
export type NewDailyOhlcv = typeof dailyOhlcv.$inferInsert;
