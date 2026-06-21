import * as swingSchema from "./swing-readonly.js";
import * as finmathSchema from "./finmath-schema.js";
import { createServiceDb } from "../../../../src/shared/db/client.js";

/**
 * Cloudflare D1 に接続した Drizzle クライアント（ADR-0001 / 共有ファクトリ使用）。
 * D1 はバインディング経由（Worker の `c.env.DB`）でのみアクセスする。
 *
 * 004 financial-math が触るテーブル:
 *   - finmath_*（所有・読み書き。Yahoo 取得キャッシュ。Worker エッジ取得なので 429 回避）
 *   - swing_*（003 所有・読み取り。BS/CAPM の OHLCV/指標参照）
 *   - core_*（共有・読み取り。銘柄名の補完）
 *
 * swing-readonly と finmath-schema は同名 `dailyOhlcv` を持つが、明示 import で
 * 区別して使うため衝突は無害（relational query は使わない）。
 *
 * @param d1 - Worker バインディング `c.env.DB`
 */
export function createDb(d1: D1Database) {
  return createServiceDb(d1, { ...swingSchema, ...finmathSchema });
}

export type Database = ReturnType<typeof createDb>;
