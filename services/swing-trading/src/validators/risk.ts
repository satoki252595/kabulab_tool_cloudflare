import { z } from "../../../../src/shared/zod-mini.js";

/**
 * リスク計算機のフォーム入力バリデーション
 *
 * form submit で送られてくる値は全て string なので z.coerce.number で変換する。
 */
export const riskFormSchema = z.object({
  accountYen: z.coerce
    .number()
    .check(z.positive("口座資金は正の数を入力してください")),
  riskPct: z.coerce
    .number()
    .check(z.positive(), z.maximum(0.1, "リスク% は 10% 以下")),
  entryPrice: z.coerce.number().check(z.positive("エントリー価格は正の数")),
  stopLoss: z.coerce.number().check(z.positive("ロスカット価格は正の数")),
  target1: z.pipe(
    z.optional(
      z.union([
        z.coerce.number().check(z.nonnegative()),
        z.literal(""),
        z.undefined(),
      ])
    ),
    z.transform((v) => (v === "" || v === undefined || v === 0 ? undefined : v))
  ),
});

/** URL クエリ向け (GET /risk?entry=2000&stop=1940) */
export const riskQuerySchema = z.object({
  entry: z.optional(z.coerce.number()),
  stop: z.optional(z.coerce.number()),
  target: z.optional(z.coerce.number()),
});
