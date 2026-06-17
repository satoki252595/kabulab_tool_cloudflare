import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as coreSchema from "./core-schema.js";
import * as rsiSchema from "./schema.js";

/**
 * Neon PostgreSQL に接続したDrizzleクライアントを生成する。
 *
 * coreスキーマ (共有) とrsiスキーマ (001固有) の両方を登録する。
 *
 * @param databaseUrl - `sslmode=require` を含むNeon接続文字列
 */
export function createDb(databaseUrl: string) {
  const sql = neon(databaseUrl);
  return drizzle(sql, { schema: { ...coreSchema, ...rsiSchema } });
}

export type Database = ReturnType<typeof createDb>;
