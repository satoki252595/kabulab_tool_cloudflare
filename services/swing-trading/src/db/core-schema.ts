import {
  pgSchema,
  serial,
  text,
  integer,
  real,
  timestamp,
  date,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

/**
 * 複数プロジェクト間で共有される一次情報スキーマ (kabulab 共通)
 *
 * 所有権: 001_RSIScreening が sync-core バッチを通じて更新する。
 * 003 Swing Trading は **読み取り専用** で参照する (銘柄マスタ・最新ファンダメンタル)。
 *
 * このファイルは services/rsi-screening/src/db/core-schema.ts と同一 (コピー)。
 * 共通化しない理由は「各サービスが自分の drizzle 設定で自分のスキーマ一覧を
 * 独立して push できる」ようにするため (1 サービスの変更が他の sync に影響しない)。
 */
export const coreSchema = pgSchema("core");

/** 銘柄マスタ (共有) */
export const stocks = coreSchema.table("stocks", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  market: text("market").notNull(),
  sector: text("sector"),
  isActive: boolean("is_active").default(true).notNull(),
  /**
   * 株主優待を実施している銘柄か。母集団は全 JPX 上場株 (~4,000) だが、
   * 002 otakara-yutai は is_yutai=true のみを母集団とする。
   * 003 swing-trading は全 active を対象とする。
   */
  isYutai: boolean("is_yutai").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** 最新ファンダメンタルズ (共有) */
export const stockFinancials = coreSchema.table(
  "stock_financials",
  {
    id: serial("id").primaryKey(),
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
    operatingMargin: real("operating_margin"),
    dataDate: date("data_date").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("idx_core_financials_stock_id").on(table.stockId)]
);

/** 年度財務 (共有) — 売上高のみ */
export const stockAnnualFinancials = coreSchema.table(
  "stock_annual_financials",
  {
    id: serial("id").primaryKey(),
    stockId: integer("stock_id")
      .references(() => stocks.id, { onDelete: "cascade" })
      .notNull(),
    fiscalYear: integer("fiscal_year").notNull(),
    revenue: real("revenue"),
  },
  (table) => [uniqueIndex("idx_core_annual_stock_year").on(table.stockId, table.fiscalYear)]
);

// --- Relations ---

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

export const stockAnnualFinancialsRelations = relations(stockAnnualFinancials, ({ one }) => ({
  stock: one(stocks, {
    fields: [stockAnnualFinancials.stockId],
    references: [stocks.id],
  }),
}));
