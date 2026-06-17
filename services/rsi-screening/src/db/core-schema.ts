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

// 注意: 過去には `stockPriceHistory` (core.stock_price_history) を持っていたが、
// RSI 計算は in-memory で完結し、UI からも参照されないため 2026-04 に削除した。

/**
 * 複数プロジェクト間で共有される一次情報スキーマ。
 *
 * 所有権: 001_RSIScreening が sync-core バッチを通じて更新する。
 * 読み取り側: 全てのkabuToolプロジェクトが参照可能。
 *
 * ここに定義するテーブルは「Yahoo Financeから取得した生に近いデータ」のみ。
 * テクニカル指標 (RSI/MACD/MA) やスコアなど「プロジェクトの解釈」は含めない。
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
   * 002 otakara-yutai は is_yutai=true のみを母集団とする (writer は
   * otakara の優待スクレイパー)。日次/月次 sync・001/003/004 は全 active を対象。
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
    /**
     * 営業利益率 TTM (trailing 12 months)
     * Yahoo Finance `financialData.operatingMargins` の生値 (0.1234 = 12.34%)
     */
    operatingMargin: real("operating_margin"),
    dataDate: date("data_date").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("idx_core_financials_stock_id").on(table.stockId)]
);

/**
 * 年度財務 (共有) — 売上高の年度推移
 *
 * 元々は売上高と営業利益の両方を持つ設計だったが、Yahoo Finance が
 * 2025 年頃に無料 quoteSummary API から `incomeStatementHistory.operatingIncome` を
 * 削除した (空オブジェクト `{}` を返す) ため、`revenue` のみを保持する。
 *
 * 営業利益率は TTM 単一値として `stockFinancials.operatingMargin` で持つ。
 */
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
