import { drizzle } from "drizzle-orm/d1";
import * as coreSchema from "../../../../src/shared/db/core-schema.js";
import * as yuhoSchema from "./schema.js";

/**
 * Cloudflare D1 に接続した Drizzle クライアントを生成する（ADR-0001）。
 *
 * D1 はバインディング経由でのみアクセスできる（Worker の `c.env.DB`）。
 * Neon の `DATABASE_URL` 文字列接続は廃止した。
 *
 * 005 yuho-quant が触るテーブル:
 *   - yuho_*（所有）: yuho_documents / yuho_order_facts
 *   - core_*（共有・読み取り）: 銘柄マスタ core_stocks の参照のみ
 *
 * @param d1 - Worker バインディング `c.env.DB`（または取込 cron の env.DB）
 */
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema: { ...coreSchema, ...yuhoSchema } });
}

export type Database = ReturnType<typeof createDb>;
