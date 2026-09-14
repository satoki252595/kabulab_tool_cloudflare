import { z } from "../../../../src/shared/zod-mini.js";
import { optionalStockCodeSchema } from "../../../../src/shared/jpx/stock-code-schema.js";

/**
 * DCF (Gordon モデル + 2 段階) フォーム入力バリデーション。
 * パーセント入力 (例: 7) → 小数 (0.07) に変換する。
 */

const dcfFormBase = z.object({
    /**
     * 銘柄コード (任意。指定があれば DB からプリフィルに使う)。
     * 未入力時の空文字列は undefined に正規化。数字 4 桁と JPX 英数字コード
     * (例: 130A) を受理し、正準形 (大文字・半角) に正規化する (cf. src/shared/jpx)。
     */
    code: optionalStockCodeSchema,

    /**
     * 来期予想配当 (円)。**省略可** (code 指定時はサーバー側で Yahoo 推定値を使うため)。
     *
     * z.coerce.number() は空文字列を 0 に変換するので、preprocess で先に
     * 「空文字列なら未入力扱い」(undefined) に正規化する。
     *
     * - 空 → undefined (code 指定時は API 側で Yahoo 推定値を充てる、
     *                    code 空時は API 側で「銘柄コード or 配当のいずれか必須」と返す)
     * - 数値 → positive() で弾く (0/負はエラー)
     */
    expectedDividend: z.pipe(
      // <unknown, unknown> 必須。付けないと falsy 分岐の絞り込み ({}) が
      // pipe の出力型になり、後段の unknown 入力と合わなくなる。
      z.transform<unknown, unknown>((v) =>
        v === "" || v === null || v === undefined ? undefined : v
      ),
      z.optional(
        z.coerce
          .number({ error: "来期予想配当は数値で入力してください" })
          .check(z.positive("来期予想配当は正の数で入力してください"))
      )
    ),

    /** 要求リターン (% 入力 → 小数) */
    requiredReturnPct: z.coerce
      .number()
      .check(
        z.minimum(0.1, "要求リターンは 0.1% 以上"),
        z.maximum(30, "要求リターンは 30% 以下")
      ),

    /** 配当成長率 (% 入力 → 小数。負も可) */
    growthRatePct: z.coerce
      .number()
      .check(
        z.minimum(-10, "成長率は -10% 以上"),
        z.maximum(20, "成長率は 20% 以下")
      ),

    /** モード: gordon (1段階) or two-stage (2段階) */
    mode: z.prefault(z.enum(["gordon", "two-stage"]), "gordon"),

    /** 高成長期年数 (two-stage 時のみ使用) */
    highGrowthYears: z.optional(
      z.coerce.number().check(z.int(), z.minimum(1), z.maximum(30))
    ),
    /** 安定期成長率% (two-stage 時のみ) */
    terminalGrowthPct: z.optional(
      z.coerce.number().check(z.minimum(-5), z.maximum(10))
    ),
  }).check(
    z.superRefine((v, ctx) => {
      // code 空 + expectedDividend 空 = 計算不能。少なくともどちらか必須。
      if (v.code === undefined && v.expectedDividend === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["expectedDividend"],
          message:
            "銘柄コード または 来期予想配当 のどちらかを入力してください",
        });
      }
    })
  );

export const dcfFormSchema = z.pipe(
  dcfFormBase,
  z.transform((v) => ({
    code: v.code,
    mode: v.mode,
    expectedDividend: v.expectedDividend,
    requiredReturn: v.requiredReturnPct / 100,
    growthRate: v.growthRatePct / 100,
    highGrowthYears: v.highGrowthYears,
    terminalGrowthRate:
      v.terminalGrowthPct !== undefined ? v.terminalGrowthPct / 100 : undefined,
    // 元入力もエコーバック (フォーム再レンダ用)
    raw: {
      expectedDividend: v.expectedDividend,
      requiredReturnPct: v.requiredReturnPct,
      growthRatePct: v.growthRatePct,
      highGrowthYears: v.highGrowthYears,
      terminalGrowthPct: v.terminalGrowthPct,
    },
  }))
);

export type DcfFormParsed = z.infer<typeof dcfFormSchema>;

/** GET /dcf?code=7203 のような銘柄プリフィル用クエリ */
export const dcfQuerySchema = z.object({
  code: optionalStockCodeSchema,
});
