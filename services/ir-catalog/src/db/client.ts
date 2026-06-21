import { drizzle } from "drizzle-orm/d1";
import * as coreSchema from "../../../../src/shared/db/core-schema.js";
import * as irSchema from "./schema.js";

/**
 * Cloudflare D1 に接続した Drizzle クライアントを生成する（ADR-0001）。
 * D1 はバインディング経由（Worker の `c.env.DB`）でのみアクセスする。
 *
 * 006 ir-catalog が触るテーブル:
 *   - ir_disclosures（所有）
 *   - core_*（共有・読み取り）: 銘柄マスタ core_stocks の参照のみ
 *
 * @param d1 - Worker バインディング `c.env.DB`（または取込 cron の env.DB）
 */
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema: { ...coreSchema, ...irSchema } });
}

export type Database = ReturnType<typeof createDb>;
