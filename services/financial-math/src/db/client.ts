import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as coreSchema from "./core-schema.js";
import * as swingSchema from "./swing-readonly.js";
import * as finmathSchema from "./finmath-schema.js";

/**
 * Neon PostgreSQL に接続した Drizzle クライアントを生成する。
 *
 * 004 Financial Math が触るスキーマ:
 *   - finmath (所有): 価格キャッシュ — Yahoo 二次利用で 1414 のような
 *     otakara-yutai 未登録銘柄もカバーする。
 *   - core   (共有・読み取り): 銘柄名の補完にだけ使う。
 *   - swing  (003 所有・読み取り): Black-Scholes / CAPM の OHLCV 参照用 (既存)。
 *
 * @param databaseUrl - `sslmode=require` を含む Neon 接続文字列
 */
export function createDb(databaseUrl: string) {
  const sql = neon(databaseUrl);
  return drizzle(sql, {
    schema: { ...coreSchema, ...swingSchema, ...finmathSchema },
  });
}

export type Database = ReturnType<typeof createDb>;
