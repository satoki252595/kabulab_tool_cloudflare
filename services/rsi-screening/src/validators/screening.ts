import { z } from "../../../../src/shared/zod-mini.js";
import { stockCodeSchema } from "../../../../src/shared/jpx/stock-code-schema.js";

/** RSI期間キー */
export const rsiPeriodSchema = z.enum(["10", "40", "120", "min"]);

/** ソート対象 */
export const sortSchema = z.enum(["percentile", "rsi", "marketCap"]);

/**
 * スクリーニングクエリパラメータ
 *
 * デフォルトは「全銘柄、底値圏 (下位 10%)、パーセンタイル昇順」。
 * `blueChip=true` で優良株フィルタを適用 (revenueTrend=1 AND operatingMarginTTM>=5%)。
 *
 * 以前のデフォルトは `blueChip=true` だったが、Yahoo Finance API の仕様変更で
 * historical operating_income が取れなくなった影響で blue chip 判定が
 * デフォルト 0 hits になっていたため、`false` に変更している。
 */
export const screeningQuerySchema = z.object({
  period: z.prefault(rsiPeriodSchema, "min"),
  percentileMax: z.prefault(
    z.coerce.number().check(z.minimum(0), z.maximum(100)),
    10
  ),
  blueChip: z.pipe(
    z.prefault(z.enum(["true", "false"]), "false"),
    z.transform((v) => v === "true")
  ),
  sort: z.prefault(sortSchema, "percentile"),
  limit: z.prefault(
    z.coerce.number().check(z.int(), z.minimum(1), z.maximum(200)),
    50
  ),
  offset: z.prefault(
    z.coerce.number().check(z.int(), z.minimum(0)),
    0
  ),
});

export type ScreeningQuery = z.infer<typeof screeningQuerySchema>;

/** 銘柄コードパラメータ (数字 4 桁 + JPX 英数字コード 例 130A を受理) */
export const stockCodeParamSchema = z.object({
  code: stockCodeSchema,
});
