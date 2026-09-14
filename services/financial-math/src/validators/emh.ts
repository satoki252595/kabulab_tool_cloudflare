import { z } from "../../../../src/shared/zod-mini.js";

/**
 * EMH アノマリースクリーニング クエリパラメータ。
 *
 *   /emh?type=momentum&window=120&limit=50&minMarketCap=...
 */
export const emhQuerySchema = z.object({
  type: z.prefault(
    z.enum(["momentum", "small-cap", "low-vol", "post-earnings"]),
    "momentum"
  ),
  /** モメンタム window (営業日。デフォルト 60。最大 100 = swing.daily_ohlcv 保持上限) */
  window: z.prefault(
    z.coerce.number().check(z.int(), z.minimum(20), z.maximum(100)),
    60
  ),
  /** 表示件数 (10-500)。silent 切り捨て防止のため上限 500 まで拡張 */
  limit: z.prefault(
    z.coerce.number().check(z.int(), z.minimum(10), z.maximum(500)),
    50
  ),
  /** 小型株閾値 (億円。デフォルト 500) */
  smallCapMaxOku: z.prefault(
    z.coerce.number().check(z.positive(), z.maximum(50000)),
    500
  ),
  /**
   * 低ボラ閾値 (% 値、ATR(14)/終値 × 100)。デフォルト 1.5 (=1.5%)。
   *
   * 注意: swing.stock_indicators.atr_pct は **% 値**で保存されている (例: 2.0 = 2%)。
   * decimal (0.02 = 2%) ではない。dividendYield と同じ Yahoo 由来の単位規約。
   * 過去バージョンで decimal 想定の 0.015 を使っていたため常に 0 件だった。
   */
  lowVolMaxAtrPct: z.prefault(
    z.coerce.number().check(z.positive(), z.maximum(50)),
    1.5
  ),
});

export type EmhQuery = z.infer<typeof emhQuerySchema>;
