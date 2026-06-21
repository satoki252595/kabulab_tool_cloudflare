import * as irSchema from "./schema.js";
import { createServiceDb } from "../../../../src/shared/db/client.js";

/**
 * Cloudflare D1 に接続した Drizzle クライアント（ADR-0001 / 共有ファクトリ使用）。
 * D1 はバインディング経由（Worker の `c.env.DB`）でのみアクセスする。
 *
 * 006 ir-catalog が触るテーブル:
 *   - ir_disclosures（所有）/ core_*（共有・読み取り）
 *
 * @param d1 - Worker バインディング `c.env.DB`
 */
export function createDb(d1: D1Database) {
  return createServiceDb(d1, irSchema);
}

export type Database = ReturnType<typeof createDb>;
