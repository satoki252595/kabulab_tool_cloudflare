import { z } from "zod";
import { optionalStockCodeSchema } from "../../../../src/shared/jpx/stock-code-schema.js";

/**
 * Black-Scholes フォーム入力バリデーション。
 *
 * 残存期間は「日数 (整数)」で入力 → T = 日数 / 365 に変換する。
 * ボラティリティは % 入力 (例: 30) → 0.30 に変換。
 */
export const bsFormSchema = z
  .object({
    /** 銘柄コード (プリフィル用) — 空文字列は undefined に正規化。数字 4 桁と
     *  JPX 英数字コード (例: 130A) を受理し、正準形 (大文字・半角) に正規化する。 */
    code: optionalStockCodeSchema,

    /** 株価 S (円)。**省略可** (code 指定時はサーバー側で Yahoo 現在株価を充てる) */
    spot: z.preprocess(
      (v) => (v === "" || v === null ? undefined : v),
      z.coerce.number().positive("株価は正の数を入力してください").optional()
    ),
    /** 行使価格 K (円)。**省略可** (code 指定時は ATM = 現在株価で計算) */
    strike: z.preprocess(
      (v) => (v === "" || v === null ? undefined : v),
      z.coerce.number().positive("行使価格は正の数を入力してください").optional()
    ),
    /** 残存日数 (営業日ではなくカレンダー日。1〜1825) */
    daysToExpiry: z.coerce.number().int().min(1, "残存日数は 1 以上").max(1825, "残存日数は 5 年以下"),
    /** リスクフリーレート % (例: 0.5) */
    riskFreeRatePct: z.coerce.number().min(-5).max(20).default(0.5),
    /** ボラティリティ % (例: 30)。**省略可** (code 指定時はヒストリカル σ を充てる) */
    volatilityPct: z.preprocess(
      (v) => (v === "" || v === null ? undefined : v),
      z.coerce.number().positive("ボラティリティは正の数").max(500).optional()
    ),
    /**
     * オプション市場価格 (任意。指定があれば IV を逆算)
     * z.coerce.number() は "" を 0 にしてしまうので preprocess で先に正規化する。
     */
    marketPrice: z.preprocess(
      (v) => (v === "" || v === null ? undefined : v),
      z.coerce.number().positive().optional()
    ),
    /** IV 計算する場合の対象 (call or put) */
    ivType: z.enum(["call", "put"]).optional(),
  })
  .superRefine((v, ctx) => {
    // code 空の場合は spot/volatilityPct が必須 (Yahoo 補完できないため)
    if (v.code === undefined) {
      if (v.spot === undefined) {
        ctx.addIssue({ code: "custom", path: ["spot"], message: "銘柄コード または 株価 S を入力してください" });
      }
      if (v.volatilityPct === undefined) {
        ctx.addIssue({ code: "custom", path: ["volatilityPct"], message: "銘柄コード または ボラティリティ σ を入力してください" });
      }
    }
  })
  .transform((v) => ({
    code: v.code,
    spot: v.spot,
    strike: v.strike,
    timeToExpiry: v.daysToExpiry / 365,
    riskFreeRate: v.riskFreeRatePct / 100,
    volatility: v.volatilityPct !== undefined ? v.volatilityPct / 100 : undefined,
    marketPrice: v.marketPrice,
    ivType: v.ivType,
    raw: {
      spot: v.spot,
      strike: v.strike,
      daysToExpiry: v.daysToExpiry,
      riskFreeRatePct: v.riskFreeRatePct,
      volatilityPct: v.volatilityPct,
      marketPrice: v.marketPrice,
      ivType: v.ivType,
    },
  }));

export type BsFormParsed = z.infer<typeof bsFormSchema>;

export const bsQuerySchema = z.object({
  code: optionalStockCodeSchema,
});
