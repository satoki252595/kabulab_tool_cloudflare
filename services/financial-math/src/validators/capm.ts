import { z } from "../../../../src/shared/zod-mini.js";
import { optionalStockCodeSchema } from "../../../../src/shared/jpx/stock-code-schema.js";

/**
 * CAPM フォーム入力バリデーション。
 *
 * 実データ計算モード (mode=auto):
 *   銘柄コードと市場指数の終値配列があれば β を OLS 推定して期待リターンを算出。
 *
 * 手動入力モード (mode=manual):
 *   ユーザーが β を直接入力する。
 */
const capmFormBase = z.object({
    /** 銘柄コード — 未入力時の空文字列は undefined に正規化。数字 4 桁と
     *  JPX 英数字コード (例: 130A) を受理し、正準形 (大文字・半角) に正規化する。 */
    code: optionalStockCodeSchema,
    mode: z.prefault(z.enum(["auto", "manual"]), "manual"),

    /**
     * 手動 β (mode=manual のみ) — 空文字列で送られてくる場合あり。
     * `z.coerce.number()` は "" を 0 に変換してしまうので、
     * 先に transform で "" → undefined に正規化する。
     */
    beta: z.pipe(
      z.transform<unknown, unknown>((v) =>
        v === "" || v === null ? undefined : v
      ),
      z.optional(
        z.coerce.number().check(z.minimum(-5), z.maximum(5))
      )
    ),

    /** リスクフリーレート % (例: 0.5) */
    riskFreeRatePct: z.prefault(
      z.coerce.number().check(z.minimum(-5), z.maximum(20)),
      0.5
    ),
    /** 市場期待リターン % (例: 6) */
    marketReturnPct: z.prefault(
      z.coerce.number().check(z.minimum(-50), z.maximum(50)),
      6
    ),
  });

export const capmFormSchema = z.pipe(
  capmFormBase,
  z.transform((v) => ({
    code: v.code,
    mode: v.mode,
    beta: v.beta,
    riskFreeRate: v.riskFreeRatePct / 100,
    marketReturn: v.marketReturnPct / 100,
    raw: {
      beta: v.beta,
      riskFreeRatePct: v.riskFreeRatePct,
      marketReturnPct: v.marketReturnPct,
    },
  }))
);

export type CapmFormParsed = z.infer<typeof capmFormSchema>;

export const capmQuerySchema = z.object({
  code: optionalStockCodeSchema,
});
