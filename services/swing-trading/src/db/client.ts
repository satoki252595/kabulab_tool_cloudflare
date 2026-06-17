import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as coreSchema from "./core-schema.js";
import * as swingSchema from "./schema.js";

/**
 * Neon PostgreSQL に接続した Drizzle クライアントを生成する。
 *
 * core スキーマ (共有) と swing スキーマ (003 固有) の両方を登録する。
 * core は読み取り専用で参照するだけで書き込みは行わない (001 が所有)。
 *
 * @param databaseUrl - `sslmode=require` を含む Neon 接続文字列
 */
export function createDb(databaseUrl: string) {
  const sql = neon(databaseUrl);
  return drizzle(sql, { schema: { ...coreSchema, ...swingSchema } });
}

export type Database = ReturnType<typeof createDb>;
