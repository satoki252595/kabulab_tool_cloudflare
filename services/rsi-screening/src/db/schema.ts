import { sql, relations } from "drizzle-orm";
import { sqliteTable, integer, real, index } from "drizzle-orm/sqlite-core";
import { stocks } from "./core-schema.js";

/**
 * 001_RSIScreening 固有スキーマ（Cloudflare D1 / SQLite 版） — ADR-0001。
 *
 * 所有権: このプロジェクトのみが読み書きする。
 * core.stocks（共有）を参照して銘柄マスタを共有する。
 *
 * D1 は名前空間が無いため、旧 `rsi.stock_rsi_percentile` は冗長な接頭を
 * 落として `rsi_percentile` に降ろす。
 *
 * 注意: 過去には `stockRsiHistory`（rsi.stock_rsi_history）を持っていたが、
 * RSI パーセンタイル算出は in-memory で完結し UI からも参照されないため
 * 2026-04 に削除した。
 */

/** 現在のRSIパーセンタイル順位 + 優良株判定 (スクリーニング用) */
export const stockRsiPercentile = sqliteTable(
  "rsi_percentile",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    stockId: integer("stock_id")
      .references(() => stocks.id, { onDelete: "cascade" })
      .notNull()
      .unique(),
    rsi10: real("rsi_10"),
    rsi10Percentile: real("rsi_10_percentile"),
    rsi40: real("rsi_40"),
    rsi40Percentile: real("rsi_40_percentile"),
    rsi120: real("rsi_120"),
    rsi120Percentile: real("rsi_120_percentile"),
    /** 3期間のパーセンタイルの最小値 (最も底にある期間) */
    rsiMinPercentile: real("rsi_min_percentile"),
    /** 優良株フラグ: 売上高増加基調 AND 営業利益率TTM が一定以上 */
    isBlueChip: integer("is_blue_chip", { mode: "boolean" })
      .default(false)
      .notNull(),
    /**
     * 営業利益率 TTM (trailing 12 months)
     * Yahoo Finance `financialData.operatingMargins` の生値 (0.1234 = 12.34%)
     *
     * 元々は過去3年の営業利益率トレンド (+1/0/-1) を保持していたが、
     * Yahoo が無料 API から historical operating_income を削除したため、
     * TTM 単一値に変更した。詳細は services/blue-chip-filter.ts のコメント参照。
     */
    operatingMarginTtm: real("operating_margin_ttm"),
    /** 売上高トレンド (+1=上昇 / 0=横ばい / -1=下降) */
    revenueTrend: integer("revenue_trend"),
    computedAt: integer("computed_at", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
  },
  (table) => [
    index("idx_rsi_percentile_min").on(table.rsiMinPercentile),
    index("idx_rsi_percentile_blue_chip").on(table.isBlueChip),
  ]
);

// --- Relations ---

export const stockRsiPercentileRelations = relations(
  stockRsiPercentile,
  ({ one }) => ({
    stock: one(stocks, {
      fields: [stockRsiPercentile.stockId],
      references: [stocks.id],
    }),
  })
);
