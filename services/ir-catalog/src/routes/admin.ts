/**
 * 006 ir-catalog — 取込トリガ（Worker 側エントリ, ADR-0001）。
 *
 * D1 はバインディング経由でのみ触れるため、TDnet 適時開示の取込は Worker 上で
 * 実行する。本ルートが現状の取込窓口で、手動 curl / 薄い CLI トリガ
 * (scripts/sync/ir-tdnet.ts) から叩く。Workers Cron Trigger からの定期起動は
 * Phase 3 で追加予定（現状未配線）。
 *
 *   POST /ir-catalog/admin/catchup
 *   Authorization: Bearer $CRON_SECRET
 *
 * 認証は共有 cronAuthMiddleware（CRON_SECRET, fail-closed）。
 * EDINET 不要。TDnet は範囲一括取得のためシャード不要（catchup 内で shard 0 固定）。
 */
import { Hono } from "hono";
import { cronAuthMiddleware } from "../../../../src/shared/auth.js";
import { createDb } from "../db/client.js";
import { runIrCatalogCatchup } from "../../../../src/cron/ir-catalog-tdnet.js";

type Bindings = { DB: D1Database };
export const adminRoute = new Hono<{ Bindings: Bindings }>();

adminRoute.use("/*", cronAuthMiddleware);

adminRoute.post("/catchup", async (c) => {
  const db = createDb(c.env.DB);
  const result = await runIrCatalogCatchup(db);
  return c.json(result);
});
