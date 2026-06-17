import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as coreSchema from "../../../rsi-screening/src/db/core-schema.js";
import * as irSchema from "./schema.js";

/**
 * Neon PostgreSQL に接続した Drizzle クライアントを生成する。
 *
 * 006 ir-catalog が触るスキーマ:
 *   - ir_catalog (所有): disclosures
 *   - core       (共有・読み取り): 銘柄マスタ core.stocks の参照のみ
 *
 * @param databaseUrl - `sslmode=require` を含む Neon 接続文字列
 */
export function createDb(databaseUrl: string) {
  const sql = neon(databaseUrl);
  return drizzle(sql, { schema: { ...coreSchema, ...irSchema } });
}

export type Database = ReturnType<typeof createDb>;
