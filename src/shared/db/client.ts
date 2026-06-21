/**
 * 共有 D1 クライアントファクトリ（ADR-0001 / 共通化 P1）。
 *
 * 全サービスの `createDb` は「drizzle-orm/d1 に共有 core_* スキーマ + サービス固有
 * スキーマをスプレッドして渡す」完全同型になる（D1 化済の 005/006 で逐語一致を確認）。
 * その共通部分をここへ集約し、各サービスの `db/client.ts` は
 *   export const createDb = (d1: D1Database) => createServiceDb(d1, ownSchema);
 * の薄いラッパだけ残す（`Database` 型 export は後方互換で各サービスに残す）。
 *
 * core は単一正本（src/shared/db/core-schema）なので、ここで必ず混ぜる。
 */
import { drizzle } from "drizzle-orm/d1";
import * as coreSchema from "./core-schema.js";

export function createServiceDb<TSchema extends Record<string, unknown>>(
  d1: D1Database,
  schema: TSchema
) {
  return drizzle(d1, { schema: { ...coreSchema, ...schema } });
}
