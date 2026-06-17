import { z } from "zod";

/** 優待生データのバリデーションスキーマ */
export const yutaiRawDataSchema = z.object({
  stockCode: z.string().min(1, "銘柄コードは必須です"),
  stockName: z.string().min(1, "銘柄名は必須です"),
  market: z.string().min(1, "市場は必須です"),
  genreName: z.string().min(1, "ジャンル名は必須です"),
  description: z.string().min(1, "優待内容は必須です"),
  minShares: z.number().int().min(1, "最低株数は1以上の整数です"),
  recordMonth: z
    .number()
    .int()
    .min(1, "権利確定月は1〜12の整数です")
    .max(12, "権利確定月は1〜12の整数です"),
  estimatedValue: z.number().int().nullable(),
});

/** インポート結果のバリデーションスキーマ */
export const yutaiImportResultSchema = z.object({
  created: z.number().int().min(0),
  updated: z.number().int().min(0),
  skipped: z.number().int().min(0),
});

/** CSVインポートリクエストボディスキーマ */
export const csvImportBodySchema = z.object({
  csv: z.string().min(1, "CSVデータは必須です"),
});

/** JSONインポートリクエストボディスキーマ */
export const jsonImportBodySchema = z.object({
  data: z.array(yutaiRawDataSchema).min(1, "データは1件以上必要です"),
});

/** 型エクスポート */
export type YutaiRawDataInput = z.infer<typeof yutaiRawDataSchema>;
export type YutaiImportResult = z.infer<typeof yutaiImportResultSchema>;
