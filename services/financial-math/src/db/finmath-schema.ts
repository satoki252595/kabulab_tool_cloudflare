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
 * ## ⚠️ この 2 表は**廃止予定**で、コードからはもう読み書きしない
 *
 * 当初の設計は「core.stocks は otakara-yutai が writer なので優待のない銘柄が
 * 載らない → 004 は独自ユニバースを持つ」だったが、この前提は既に成り立たない。
 * 母集団は universe sync が JPX 一覧から作る東証内国普通株 (~3,700) で、
 * `core_stock_financials` は `is_active=1` の 3,715 銘柄を**完全被覆**している
 * (行が無い 54 件はすべて `is_active=0`。実測 2026-09-13)。
 *
 * さらにこの遅延フェッチは **SSR の GET 中に Yahoo を叩いて本番 D1 へ書く**形
 * だったため、データの中身と鮮度が「誰が画面を開いたか」に依存していた。
 * 読み取り面は `core_stock_financials` / `swing_daily_ohlcv` /
 * `swing_market_context` を読むだけに変えた (services/price-cache.ts)。
 *
 * **宣言を残しているのは意図的**。本番にはまだ表が実在するので、宣言を消すと
 * `drizzle-kit generate` が `DROP TABLE` を吐き、その SQL を誤って本番へ流す口が
 * 開く (`finmath_daily_ohlcv` は 3,490 行・7 シンボルだけだが、消す判断と
 * 消す操作は別の PR でやるべき)。撤去は「本番へ DROP を流す PR」で行うこと。
 * それまでは**誰も読まない・誰も書かない表**として置いておく。
 *
 * D1 は名前空間が無いため旧 `finmath.<table>` を `finmath_<table>` に降ろす。
 */

/**
 * @deprecated 読み書きしない。価格断面は `core_stock_financials` を読む。
 *
 * 最新価格スナップショット (code ごとに 1 行 = UPSERT)。旧・訪問者依存の
 * 遅延充填先。実測で 3,759 行中 3,547 行 (94.4%) が 2026-06 以前という
 * 「開かれたページだけ新しい」状態になっていた。
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
 * @deprecated 読み書きしない。個別銘柄は `swing_daily_ohlcv`、市場系列は
 * `swing_market_context.nikkei_close` を読む。
 *
 * 日足 OHLCV キャッシュ (シンボル × 日付 = ユニーク)。バッチ writer が
 * 存在せず、実測で **3,490 行 / 7 シンボル** (7203, 7974, ^N225, 8035, 9984,
 * 9432, 9983) しか入っていなかった。つまり β/σ はその 7 つ以外では
 * 「Yahoo を叩いた訪問者がいた銘柄だけ動く」状態だった。
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
