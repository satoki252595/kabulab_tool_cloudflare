import * as yuhoSchema from "./schema.js";
import { createServiceDb } from "../../../../src/shared/db/client.js";

/**
 * Cloudflare D1 に接続した Drizzle クライアント（ADR-0001 / 共有ファクトリ使用）。
 * D1 はバインディング経由（Worker の `c.env.DB`）でのみアクセスする。
 *
 * 005 yuho-quant が触るテーブル:
 *   - yuho_*（所有）/ core_*（共有・読み取り）
 *
 * @param d1 - Worker バインディング `c.env.DB`（または取込 cron の env.DB）
 */
export function createDb(d1: D1Database) {
  return createServiceDb(d1, yuhoSchema);
}

export type Database = ReturnType<typeof createDb>;
