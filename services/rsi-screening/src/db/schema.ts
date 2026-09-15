import { sql, relations } from "drizzle-orm";
import { sqliteTable, integer, real, index } from "drizzle-orm/sqlite-core";
import { stocks } from "../../../../src/shared/db/core-schema.js";

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

/** 現在のRSIパーセンタイル順位 + 優良株判定 (スクリーニング用)。1 銘柄 1 行のため stock_id が PK (L-53) */
export const stockRsiPercentile = sqliteTable(
  "rsi_percentile",
  {
    stockId: integer("stock_id")
      .primaryKey()
      .references(() => stocks.id, { onDelete: "cascade" }),
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
    // NOTE (L-53): 旧 operating_margin_ttm 列は core_stock_financials.operating_margin と
    // 完全一致の二重持ちだったため 0018 で DROP。読み手は financials 側を参照する。
    /** 売上高トレンド (+1=上昇 / 0=横ばい / -1=下降) */
    revenueTrend: integer("revenue_trend"),
    /**
     * パーセンタイル母集団に使った終値の本数。
     *
     * パーセンタイルは日次 sync が Yahoo の 5y チャートをメモリ上で処理して
     * 算出する (src/cron/daily.ts)。母集団は「5 年」ではなく「Yahoo が返した
     * 本数」なので、上場が浅い銘柄は 400 件サンプルの実測で最短 461 本
     * (≒1.9 年) しかない。同じ「5年パーセンタイル」の列に 1,223 本の銘柄と
     * 461 本の銘柄が並ぶため、**母数を持たないと読者は深さの差に気づけない**。
     *
     * 期間別の分母はこの本数 − 期間長 (rsi10 なら −10)。3 期間で分母が違うが、
     * 3 列持つのは D1 の列追加コストと UI の情報量に見合わないので、共通の
     * 元本数 1 列だけを持つ。
     *
     * 既存行は sync が 1 周するまで NULL (ルール2: 0 で埋めない)。
     */
    percentileSampleBars: integer("percentile_sample_bars"),
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
