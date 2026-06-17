import { z } from "zod";

/**
 * リスク計算機のフォーム入力バリデーション
 *
 * form submit で送られてくる値は全て string なので z.coerce.number で変換する。
 */
export const riskFormSchema = z.object({
  accountYen: z.coerce.number().positive("口座資金は正の数を入力してください"),
  riskPct: z.coerce.number().positive().max(0.1, "リスク% は 10% 以下"),
  entryPrice: z.coerce.number().positive("エントリー価格は正の数"),
  stopLoss: z.coerce.number().positive("ロスカット価格は正の数"),
  target1: z
    .union([z.coerce.number().nonnegative(), z.literal(""), z.undefined()])
    .optional()
    .transform((v) => (v === "" || v === undefined || v === 0 ? undefined : v)),
});

/** URL クエリ向け (GET /risk?entry=2000&stop=1940) */
export const riskQuerySchema = z.object({
  entry: z.coerce.number().optional(),
  stop: z.coerce.number().optional(),
  target: z.coerce.number().optional(),
});
