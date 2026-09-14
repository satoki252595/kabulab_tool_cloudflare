/**
 * Yahoo Finance レスポンスの Zod バリデータ。
 *
 * rsi-screening と swing-trading と otakara-yutai の 3 サービスで重複していた定義を
 * ここに集約する。meta には previousClose / chartPreviousClose も入れて、マクロ指数の
 * 前日終値取得にも使えるようにしている。
 */

import { z } from "../zod-mini.js";

/**
 * Yahoo の { raw, fmt } 形式の数値フィールド
 *
 * Yahoo はごく稀に raw を string で返す (観測: 7347 の trailingPE)。
 * Zod で数値型を強く要求すると 1 銘柄の 1 フィールド異常が全銘柄の失敗になる
 * ので、string → number を coerce する。
 */
const rawValueSchema = z.optional(
  z.nullable(
    z.object({
      raw: z.pipe(
        z.optional(z.union([z.number(), z.string()])),
        z.transform((v) => {
          if (v === undefined) return undefined;
          if (typeof v === "number") return v;
          const n = Number(v);
          return Number.isFinite(n) ? n : undefined;
        })
      ),
      fmt: z.optional(z.nullable(z.string())),
    })
  )
);

export const yahooChartResponseSchema = z.object({
  chart: z.object({
    result: z.optional(
      z.nullable(
        z.array(
          z.object({
            meta: z.object({
              symbol: z.string(),
              regularMarketPrice: z.optional(z.nullable(z.number())),
              previousClose: z.optional(z.nullable(z.number())),
              chartPreviousClose: z.optional(z.nullable(z.number())),
              currency: z.optional(z.string()),
            }),
            timestamp: z.optional(z.array(z.number())),
            indicators: z.object({
              quote: z.array(
                z.object({
                  open: z.optional(z.array(z.nullable(z.number()))),
                  high: z.optional(z.array(z.nullable(z.number()))),
                  low: z.optional(z.array(z.nullable(z.number()))),
                  close: z.optional(z.array(z.nullable(z.number()))),
                  volume: z.optional(z.array(z.nullable(z.number()))),
                })
              ),
              adjclose: z.optional(
                z.array(
                  z.object({
                    adjclose: z.optional(z.array(z.nullable(z.number()))),
                  })
                )
              ),
            }),
          })
        )
      )
    ),
    error: z.optional(
      z.nullable(
        z.object({
          code: z.string(),
          description: z.string(),
        })
      )
    ),
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
    result: z.optional(
      z.nullable(
        z.array(
          z.object({
            financialData: z.optional(
              z.nullable(
                z.object({
                  returnOnEquity: rawValueSchema,
                  returnOnAssets: rawValueSchema,
                  totalRevenue: rawValueSchema,
                  operatingMargins: rawValueSchema,
                })
              )
            ),
            defaultKeyStatistics: z.optional(
              z.nullable(
                z.object({
                  priceToBook: rawValueSchema,
                  trailingEps: rawValueSchema,
                  bookValue: rawValueSchema,
                })
              )
            ),
            summaryDetail: z.optional(
              z.nullable(
                z.object({
                  trailingPE: rawValueSchema,
                  marketCap: rawValueSchema,
                  dividendYield: rawValueSchema,
                })
              )
            ),
            incomeStatementHistory: z.optional(
              z.nullable(
                z.object({
                  incomeStatementHistory: z.array(
                    z.object({
                      endDate: rawValueSchema,
                      totalRevenue: rawValueSchema,
                    })
                  ),
                })
              )
            ),
          })
        )
      )
    ),
    error: z.optional(
      z.nullable(
        z.object({
          code: z.string(),
          description: z.string(),
        })
      )
    ),
  }),
});
