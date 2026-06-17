import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as coreSchema from "../../../rsi-screening/src/db/core-schema.js";
import * as yuhoSchema from "./schema.js";

/**
 * Neon PostgreSQL に接続した Drizzle クライアントを生成する。
 *
 * 005 yuho-quant が触るスキーマ:
 *   - yuho_quant (所有): documents / order_facts
 *   - core       (共有・読み取り): 銘柄マスタ core.stocks の参照のみ
 *
 * @param databaseUrl - `sslmode=require` を含む Neon 接続文字列
 */
export function createDb(databaseUrl: string) {
  const sql = neon(databaseUrl);
  return drizzle(sql, { schema: { ...coreSchema, ...yuhoSchema } });
}

export type Database = ReturnType<typeof createDb>;
