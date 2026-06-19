/**
 * 共有 core スキーマ（Cloudflare D1 / SQLite 版） — ADR-0001。
 *
 * Neon PostgreSQL の `core` スキーマ（services/rsi-screening/src/db/core-schema.ts）を
 * D1(SQLite) へ移行したもの。D1 は 1 DB = 1 SQLite で名前空間が無いため、旧
 * スキーマ名を接頭辞 `core_` に降ろしてテーブル名衝突を避ける。
 *
 * 所有権: 銘柄マスタ・財務の一次情報。Neon 版と同じく「Yahoo Finance 等から
 * 取得した生に近いデータ」のみ。テクニカル指標やスコアは各サービス側に置く。
 *
 * 方言マッピング（PostgreSQL → SQLite, ADR-0001 §4）:
 *   serial                         → integer primaryKey autoIncrement
 *   timestamp(withTimezone)+now()  → integer({mode:'timestamp'}) default unixepoch()
 *   date                           → text（'YYYY-MM-DD' 文字列のまま）
 *   boolean                        → integer({mode:'boolean'})
 *   real / doublePrecision         → real
 */
import { sql, relations } from "drizzle-orm";
import {
  sqliteTable,
  integer,
  text,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** 銘柄マスタ（共有） */
export const stocks = sqliteTable("core_stocks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  market: text("market").notNull(),
  sector: text("sector"),
  isActive: integer("is_active", { mode: "boolean" }).default(true).notNull(),
  /**
   * 株主優待を実施している銘柄か。母集団は全 JPX 上場株 (~4,000) だが、
   * 002 otakara-yutai は is_yutai=true のみを母集団とする。
   */
  isYutai: integer("is_yutai", { mode: "boolean" }).default(false).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .default(sql`(unixepoch())`)
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .default(sql`(unixepoch())`)
    .notNull(),
});

/** 最新ファンダメンタルズ（共有） */
export const stockFinancials = sqliteTable(
  "core_stock_financials",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    stockId: integer("stock_id")
      .references(() => stocks.id, { onDelete: "cascade" })
      .notNull()
      .unique(),
    price: real("price"),
    per: real("per"),
    pbr: real("pbr"),
    dividendYield: real("dividend_yield"),
    eps: real("eps"),
    bps: real("bps"),
    roe: real("roe"),
    roa: real("roa"),
    marketCap: real("market_cap"),
    /** 営業利益率 TTM。Yahoo `financialData.operatingMargins` の生値 (0.1234=12.34%) */
    operatingMargin: real("operating_margin"),
    dataDate: text("data_date").notNull(),
    fetchedAt: integer("fetched_at", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
  },
  (table) => [index("idx_core_financials_stock_id").on(table.stockId)]
);

/**
 * 年度財務（共有） — 売上高の年度推移。
 * Yahoo が無料 API から operatingIncome を削除したため revenue のみ保持。
 */
export const stockAnnualFinancials = sqliteTable(
  "core_stock_annual_financials",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    stockId: integer("stock_id")
      .references(() => stocks.id, { onDelete: "cascade" })
      .notNull(),
    fiscalYear: integer("fiscal_year").notNull(),
    revenue: real("revenue"),
  },
  (table) => [
    uniqueIndex("idx_core_annual_stock_year").on(table.stockId, table.fiscalYear),
  ]
);

// --- Relations（dialect 非依存。Neon 版と同一） ---

export const stocksRelations = relations(stocks, ({ one, many }) => ({
  annualFinancials: many(stockAnnualFinancials),
  financials: one(stockFinancials, {
    fields: [stocks.id],
    references: [stockFinancials.stockId],
  }),
}));

export const stockFinancialsRelations = relations(stockFinancials, ({ one }) => ({
  stock: one(stocks, {
    fields: [stockFinancials.stockId],
    references: [stocks.id],
  }),
}));

export const stockAnnualFinancialsRelations = relations(
  stockAnnualFinancials,
  ({ one }) => ({
    stock: one(stocks, {
      fields: [stockAnnualFinancials.stockId],
      references: [stocks.id],
    }),
  })
);
