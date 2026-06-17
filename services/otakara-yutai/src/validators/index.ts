import { z } from "zod";

/** ジャンルレスポンススキーマ */
export const genreResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
});

/** 銘柄一覧クエリパラメータスキーマ */
export const stockQuerySchema = z.object({
  genre: z.string().optional(),
  sort: z.enum(["total", "fundamental", "technical", "price"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

/** 銘柄一覧アイテムスキーマ */
export const stockItemSchema = z.object({
  code: z.string(),
  name: z.string(),
  market: z.string(),
  sector: z.string().nullable(),
  benefitDescription: z.string().nullable(),
  genreSlug: z.string().nullable(),
  genreName: z.string().nullable(),
  price: z.number().nullable(),
  dividendYield: z.number().nullable(),
  per: z.number().nullable(),
  pbr: z.number().nullable(),
  fundamentalScore: z.number().nullable(),
  technicalScore: z.number().nullable(),
  totalScore: z.number().nullable(),
});

/** 銘柄一覧レスポンススキーマ */
export const stockListResponseSchema = z.object({
  stocks: z.array(stockItemSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
});

/** 銘柄詳細レスポンススキーマ */
export const stockDetailResponseSchema = z.object({
  code: z.string(),
  name: z.string(),
  market: z.string(),
  sector: z.string().nullable(),
  benefits: z.array(
    z.object({
      id: z.number(),
      description: z.string(),
      minShares: z.number(),
      recordMonth: z.number(),
      estimatedValue: z.number().nullable(),
      genre: z
        .object({
          id: z.number(),
          name: z.string(),
          slug: z.string(),
        })
        .nullable(),
    }),
  ),
  financial: z
    .object({
      price: z.number().nullable(),
      per: z.number().nullable(),
      pbr: z.number().nullable(),
      dividendYield: z.number().nullable(),
      eps: z.number().nullable(),
      bps: z.number().nullable(),
      marketCap: z.number().nullable(),
      ma5: z.number().nullable(),
      ma25: z.number().nullable(),
      ma75: z.number().nullable(),
      rsi14: z.number().nullable(),
      dataDate: z.string().nullable(),
    })
    .nullable(),
  score: z
    .object({
      fundamentalScore: z.number(),
      technicalScore: z.number(),
      totalScore: z.number(),
      scoredAt: z.string(),
    })
    .nullable(),
});

/** エラーレスポンススキーマ */
export const errorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
});

/** 型エクスポート */
export type GenreResponse = z.infer<typeof genreResponseSchema>;
export type StockQuery = z.infer<typeof stockQuerySchema>;
export type StockItem = z.infer<typeof stockItemSchema>;
export type StockListResponse = z.infer<typeof stockListResponseSchema>;
export type StockDetailResponse = z.infer<typeof stockDetailResponseSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
