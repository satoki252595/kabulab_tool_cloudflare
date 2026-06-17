import {
  pgTable,
  serial,
  text,
  integer,
  real,
  timestamp,
  date,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { stocks as coreStocks } from "../../../rsi-screening/src/db/core-schema.js";

/**
 * 002 お宝優待 のスキーマ定義。
 *
 * 銘柄マスタは core.stocks に一本化済み (2026-04)。public.stocks は廃止し、
 * ここからは core.stocks を `stocks` として再 export して UI の query を変えずに
 * 使えるようにしている。
 */

/** 優待ジャンルマスタ */
export const yutaiGenres = pgTable("yutai_genres", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * 銘柄マスタ (core.stocks への alias)
 *
 * 既存 app.ts の query は `stocks` シンボルを参照しているので、import パスは
 * そのままで `coreStocks` を再 export する形にすることで差分を最小化している。
 */
export const stocks = coreStocks;

/** 優待情報 — stock_id は core.stocks(id) を参照 */
export const yutaiBenefits = pgTable(
  "yutai_benefits",
  {
    id: serial("id").primaryKey(),
    stockId: integer("stock_id")
      .references(() => coreStocks.id)
      .notNull(),
    genreId: integer("genre_id")
      .references(() => yutaiGenres.id)
      .notNull(),
    description: text("description").notNull(),
    shortSummary: text("short_summary"),
    minShares: integer("min_shares").notNull(),
    recordMonth: integer("record_month").notNull(),
    estimatedValue: integer("estimated_value"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_yutai_benefits_stock_id").on(table.stockId),
    index("idx_yutai_benefits_genre_id").on(table.genreId),
  ]
);

/** 株価・財務データ (1 銘柄 1 行) — stock_id は core.stocks(id) を参照 */
export const stockFinancials = pgTable(
  "stock_financials",
  {
    id: serial("id").primaryKey(),
    stockId: integer("stock_id")
      .references(() => coreStocks.id)
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
    ma5: real("ma_5"),
    ma25: real("ma_25"),
    ma75: real("ma_75"),
    rsi14: real("rsi_14"),
    macd: real("macd"),
    macdSignal: real("macd_signal"),
    yutaiYield: real("yutai_yield"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    dataDate: date("data_date").notNull(),
  },
  (table) => [index("idx_stock_financials_stock_id").on(table.stockId)]
);

/** スコアリング結果 (1 銘柄 1 行) — stock_id は core.stocks(id) を参照 */
export const stockScores = pgTable(
  "stock_scores",
  {
    id: serial("id").primaryKey(),
    stockId: integer("stock_id")
      .references(() => coreStocks.id)
      .notNull()
      .unique(),
    fundamentalScore: real("fundamental_score").notNull(),
    technicalScore: real("technical_score").notNull(),
    totalScore: real("total_score").notNull(),
    scoredAt: timestamp("scored_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("idx_stock_scores_stock_id").on(table.stockId)]
);

// --- Relations ---
//
// app.ts は db.query.stocks.findFirst({ with: { benefits, financials, scores } })
// の形で otakara 固有のリレーションを参照する。coreStocks をここで再 export した上で、
// otakara 用のリレーション集を定義する。core-schema の stocksRelations (→
// annualFinancials 等) とは別の Drizzle registry スペースに属する。

export const stocksRelations = relations(coreStocks, ({ many }) => ({
  benefits: many(yutaiBenefits),
  financials: many(stockFinancials),
  scores: many(stockScores),
}));

export const yutaiGenresRelations = relations(yutaiGenres, ({ many }) => ({
  benefits: many(yutaiBenefits),
}));

export const yutaiBenefitsRelations = relations(yutaiBenefits, ({ one }) => ({
  stock: one(coreStocks, {
    fields: [yutaiBenefits.stockId],
    references: [coreStocks.id],
  }),
  genre: one(yutaiGenres, {
    fields: [yutaiBenefits.genreId],
    references: [yutaiGenres.id],
  }),
}));

export const stockFinancialsRelations = relations(
  stockFinancials,
  ({ one }) => ({
    stock: one(coreStocks, {
      fields: [stockFinancials.stockId],
      references: [coreStocks.id],
    }),
  })
);

export const stockScoresRelations = relations(stockScores, ({ one }) => ({
  stock: one(coreStocks, {
    fields: [stockScores.stockId],
    references: [coreStocks.id],
  }),
}));
