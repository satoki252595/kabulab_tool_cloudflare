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
 * 004 Financial Math 専用スキーマ（Cloudflare D1 / SQLite 版） — ADR-0001。
 *
 * 所有権: このサービス自身。core.stocks (otakara-yutai が writer) に
 * 縛られないユニバースを持つため、Yahoo クライアントを二次利用する
 * 遅延フェッチ + キャッシュで価格スナップショットを蓄える。
 * 取得は Worker エッジ経由なので Yahoo の 429（自宅 IP）に掛からない。
 *
 * D1 は名前空間が無いため旧 `finmath.<table>` を `finmath_<table>` に降ろす。
 * 既定 TTL は呼び出し側 (price-cache.ts) で決める。スキーマ側は
 * `fetched_at` を必ず付ける契約だけ守る。
 */

/**
 * 最新価格スナップショット (code ごとに 1 行 = UPSERT)
 *
 * Yahoo Finance の Chart + QuoteSummary から得た数値を保持。
 * 名前は Yahoo からは取れないので nullable で保留 (将来 JPX/J-Quants で補完予定)。
 */
export const priceSnapshot = sqliteTable(
  "finmath_price_snapshot",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
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
    dataDate: text("data_date").notNull(),
    /** このスナップショットを取得した時刻 (キャッシュ判定に使う) */
    fetchedAt: integer("fetched_at", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
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
 * - Yahoo Chart API の数年ぶんをそのまま蓄える想定
 * - swing_daily_ohlcv とは独立: 母集団を core.stocks から切り離すための
 *   このサービス専用ストレージ
 */
export const dailyOhlcv = sqliteTable(
  "finmath_daily_ohlcv",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    symbol: text("symbol").notNull(),
    date: text("date").notNull(),
    open: real("open"),
    high: real("high"),
    low: real("low"),
    close: real("close"),
    volume: real("volume"),
    /** 分割調整済み終値 (Yahoo adjclose)。CAPM β 推定など長期計算に使用 */
    adj: real("adj"),
    fetchedAt: integer("fetched_at", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
  },
  (table) => [
    uniqueIndex("idx_finmath_ohlcv_symbol_date").on(table.symbol, table.date),
    index("idx_finmath_ohlcv_symbol").on(table.symbol),
  ]
);

export type DailyOhlcv = typeof dailyOhlcv.$inferSelect;
export type NewDailyOhlcv = typeof dailyOhlcv.$inferInsert;
