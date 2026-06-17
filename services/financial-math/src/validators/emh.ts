import { z } from "zod";

/**
 * EMH アノマリースクリーニング クエリパラメータ。
 *
 *   /emh?type=momentum&window=120&limit=50&minMarketCap=...
 */
export const emhQuerySchema = z.object({
  type: z
    .enum(["momentum", "small-cap", "low-vol", "post-earnings"])
    .default("momentum"),
  /** モメンタム window (営業日。デフォルト 60。最大 100 = swing.daily_ohlcv 保持上限) */
  window: z.coerce.number().int().min(20).max(100).default(60),
  /** 表示件数 (10-500)。silent 切り捨て防止のため上限 500 まで拡張 */
  limit: z.coerce.number().int().min(10).max(500).default(50),
  /** 小型株閾値 (億円。デフォルト 500) */
  smallCapMaxOku: z.coerce.number().positive().max(50000).default(500),
  /**
   * 低ボラ閾値 (% 値、ATR(14)/終値 × 100)。デフォルト 1.5 (=1.5%)。
   *
   * 注意: swing.stock_indicators.atr_pct は **% 値**で保存されている (例: 2.0 = 2%)。
   * decimal (0.02 = 2%) ではない。dividendYield と同じ Yahoo 由来の単位規約。
   * 過去バージョンで decimal 想定の 0.015 を使っていたため常に 0 件だった。
   */
  lowVolMaxAtrPct: z.coerce.number().positive().max(50).default(1.5),
});

export type EmhQuery = z.infer<typeof emhQuerySchema>;
