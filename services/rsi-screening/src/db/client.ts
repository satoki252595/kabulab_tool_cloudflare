import * as rsiSchema from "./schema.js";
import { createServiceDb } from "../../../../src/shared/db/client.js";

/**
 * Cloudflare D1 に接続した Drizzle クライアント（ADR-0001 / 共有ファクトリ使用）。
 * D1 はバインディング経由（Worker の `c.env.DB`）でのみアクセスする。
 *
 * 001 rsi-screening が触るテーブル:
 *   - rsi_percentile（所有）/ core_*（共有・読み取り）
 *
 * @param d1 - Worker バインディング `c.env.DB`
 */
export function createDb(d1: D1Database) {
  return createServiceDb(d1, rsiSchema);
}

export type Database = ReturnType<typeof createDb>;
