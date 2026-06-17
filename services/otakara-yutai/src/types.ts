import type {
  stocks,
  yutaiGenres,
  yutaiBenefits,
  stockFinancials,
  stockScores,
} from "./db/schema.js";
import type { Database } from "./db/client.js";

/** DB型推論 */
export type Stock = typeof stocks.$inferSelect;
export type NewStock = typeof stocks.$inferInsert;

export type YutaiGenre = typeof yutaiGenres.$inferSelect;
export type NewYutaiGenre = typeof yutaiGenres.$inferInsert;

export type YutaiBenefit = typeof yutaiBenefits.$inferSelect;
export type NewYutaiBenefit = typeof yutaiBenefits.$inferInsert;

export type StockFinancial = typeof stockFinancials.$inferSelect;
export type NewStockFinancial = typeof stockFinancials.$inferInsert;

export type StockScore = typeof stockScores.$inferSelect;
export type NewStockScore = typeof stockScores.$inferInsert;

/** Hono Bindings */
export type Bindings = {
  DATABASE_URL: string;
};

/** Honoアプリ共通の環境型（Bindings + Variables） */
export type AppEnv = {
  Bindings: Bindings;
  Variables: { db: Database };
};

/** スクリーニング結果 */
export type ScreeningResult = {
  stock: Stock;
  benefits: YutaiBenefit[];
  financial: StockFinancial | null;
  score: StockScore | null;
};

/** Cronバッチ同期結果 */
export type CronSyncResult = {
  synced: { success: string[]; failed: string[] };
  scored: number;
  executionTimeMs: number;
  timestamp: string;
};

/** スコア内訳 */
export type ScoreBreakdown = {
  fundamentalScore: number;
  technicalScore: number;
  totalScore: number;
  details: {
    perScore: number;
    pbrScore: number;
    dividendYieldScore: number;
    roeScore: number;
    yutaiYieldScore: number;
    maDeviationScore: number;
    rsiScore: number;
    macdScore: number;
  };
};
