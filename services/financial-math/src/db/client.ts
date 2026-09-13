import * as swingSchema from "./swing-readonly.js";
import * as projectionSchema from "../../../../src/shared/db/projection-schema.js";
import { createServiceDb } from "../../../../src/shared/db/client.js";

/**
 * Cloudflare D1 に接続した Drizzle クライアント（ADR-0001 / 共有ファクトリ使用）。
 * D1 はバインディング経由（Worker の `c.env.DB`）でのみアクセスする。
 *
 * 004 financial-math が触るテーブル:
 *   - swing_*（003 所有・読み取り。BS/CAPM の OHLCV/指標参照）
 *   - core_*（共有・読み取り。価格断面と銘柄名）
 *   - p_*（L2 投影・読み取り。writer は日次 cron の Phase 6）
 *
 * 004 が所有する表は無い。旧 `finmath_price_snapshot` / `finmath_daily_ohlcv` は
 * 読み取り面を core_* / swing_* へ振り替えた後に宣言ごと撤去した
 * (drizzle/d1/0012。本番の行は ~/kabulab-cf-backup-20260913/d1-finmath/ に退避)。
 *
 * @param d1 - Worker バインディング `c.env.DB`
 */
export function createDb(d1: D1Database) {
  return createServiceDb(d1, {
    ...swingSchema,
    ...projectionSchema,
  });
}

export type Database = ReturnType<typeof createDb>;
