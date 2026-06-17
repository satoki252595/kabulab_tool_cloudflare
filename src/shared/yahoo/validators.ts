/**
 * Yahoo Finance レスポンスの Zod バリデータ。
 *
 * rsi-screening と swing-trading と otakara-yutai の 3 サービスで重複していた定義を
 * ここに集約する。meta には previousClose / chartPreviousClose も入れて、マクロ指数の
 * 前日終値取得にも使えるようにしている。
 */

import { z } from "zod";

/**
 * Yahoo の { raw, fmt } 形式の数値フィールド
 *
 * Yahoo はごく稀に raw を string で返す (観測: 7347 の trailingPE)。
 * Zod で数値型を強く要求すると 1 銘柄の 1 フィールド異常が全銘柄の失敗になる
 * ので、string → number を coerce する。
 */
const rawValueSchema = z
  .object({
    raw: z.union([z.number(), z.string()]).optional().transform((v) => {
      if (v === undefined) return undefined;
      if (typeof v === "number") return v;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }),
    fmt: z.string().nullable().optional(),
  })
  .nullable()
  .optional();

/** Chart API レスポンス */
export const yahooChartResponseSchema = z.object({
  chart: z.object({
    result: z
      .array(
        z.object({
          meta: z.object({
            symbol: z.string(),
            regularMarketPrice: z.number().nullable().optional(),
            previousClose: z.number().nullable().optional(),
            chartPreviousClose: z.number().nullable().optional(),
            currency: z.string().optional(),
          }),
          timestamp: z.array(z.number()).optional(),
          indicators: z.object({
            quote: z.array(
              z.object({
                open: z.array(z.number().nullable()).optional(),
                high: z.array(z.number().nullable()).optional(),
                low: z.array(z.number().nullable()).optional(),
                close: z.array(z.number().nullable()).optional(),
                volume: z.array(z.number().nullable()).optional(),
              })
            ),
          }),
        })
      )
      .nullable()
      .optional(),
    error: z
      .object({
        code: z.string(),
        description: z.string(),
      })
      .nullable()
      .optional(),
  }),
});

/**
 * QuoteSummary API レスポンス (2026 年時点のフィールド配置)
 *
 *   summaryDetail:          trailingPE, marketCap, dividendYield
 *   defaultKeyStatistics:   priceToBook, trailingEps, bookValue
 *   financialData:          returnOnEquity, returnOnAssets, operatingMargins
 *   incomeStatementHistory: endDate, totalRevenue  (operatingIncome は空 {})
 */
export const yahooQuoteSummaryResponseSchema = z.object({
  quoteSummary: z.object({
    result: z
      .array(
        z.object({
          financialData: z
            .object({
              returnOnEquity: rawValueSchema,
              returnOnAssets: rawValueSchema,
              totalRevenue: rawValueSchema,
              operatingMargins: rawValueSchema,
            })
            .nullable()
            .optional(),
          defaultKeyStatistics: z
            .object({
              priceToBook: rawValueSchema,
              trailingEps: rawValueSchema,
              bookValue: rawValueSchema,
            })
            .nullable()
            .optional(),
          summaryDetail: z
            .object({
              trailingPE: rawValueSchema,
              marketCap: rawValueSchema,
              dividendYield: rawValueSchema,
            })
            .nullable()
            .optional(),
          incomeStatementHistory: z
            .object({
              incomeStatementHistory: z.array(
                z.object({
                  endDate: rawValueSchema,
                  totalRevenue: rawValueSchema,
                })
              ),
            })
            .nullable()
            .optional(),
        })
      )
      .nullable()
      .optional(),
    error: z
      .object({
        code: z.string(),
        description: z.string(),
      })
      .nullable()
      .optional(),
  }),
});
