import * as overseasSchema from "./schema.js";
import { createServiceDb } from "../../../../src/shared/db/client.js";

/**
 * Cloudflare D1 に接続した Drizzle クライアント（共有ファクトリ使用）。
 * D1 はバインディング経由（Worker の `c.env.DB`）でのみアクセスする。
 *
 * 008 overseas-sales が触るテーブル:
 *   - oseas_*（所有）/ core_*（共有・読み取り）
 *
 * @param d1 - Worker バインディング `c.env.DB`（または取込 cron の env.DB）
 */
export function createDb(d1: D1Database) {
  return createServiceDb(d1, overseasSchema);
}

export type Database = ReturnType<typeof createDb>;
