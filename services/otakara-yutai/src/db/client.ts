import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.js";

/**
 * Cloudflare D1 に接続した Drizzle クライアント（ADR-0001）。
 * D1 はバインディング経由（Worker の `c.env.DB`）でのみアクセスする。
 *
 * 注意: otakara は `otakara_stock_financials` という独自テーブルを持ち、
 * 共有 `core_stock_financials` と TS シンボル名（stockFinancials）が衝突する。
 * そのため共有ファクトリ（createServiceDb = core を必ず混ぜる）ではなく、
 * otakara スキーマのみを登録する。`stocks` は schema.ts が core_stocks を
 * 再 export しているので銘柄マスタは共有される。
 *
 * @param d1 - Worker バインディング `c.env.DB`
 */
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Database = ReturnType<typeof createDb>;
