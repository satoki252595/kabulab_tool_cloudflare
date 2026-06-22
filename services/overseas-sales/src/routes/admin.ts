/**
 * 008 overseas-sales — 取込トリガ（Worker 側エントリ）。
 *
 *   POST /overseas-sales/admin/catchup[?part=0&of=8]
 *   Authorization: Bearer $CRON_SECRET
 *
 * 認証は共有 cronAuthMiddleware（CRON_SECRET, fail-closed）。EDINET_API_KEY は
 * Worker secret（process.env, nodejs_compat 経由）で参照する。
 */
import { Hono } from "hono";
import { cronAuthMiddleware } from "../../../../src/shared/auth.js";
import { createDb } from "../db/client.js";
import {
  runOverseasEdinetCatchup,
  type ShardOpts,
} from "../../../../src/cron/overseas-edinet.js";

type Bindings = { DB: D1Database };
export const adminRoute = new Hono<{ Bindings: Bindings }>();

adminRoute.use("/*", cronAuthMiddleware);

adminRoute.post("/catchup", async (c) => {
  const partRaw = c.req.query("part");
  const ofRaw = c.req.query("of");
  let shard: ShardOpts | undefined;
  if (partRaw !== undefined || ofRaw !== undefined) {
    const part = Number(partRaw);
    const of = Number(ofRaw);
    // 不正な shard は黙って全件にフォールバックせず 400 で弾く（ルール2）。
    if (
      !Number.isInteger(part) ||
      !Number.isInteger(of) ||
      of <= 0 ||
      part < 0 ||
      part >= of
    ) {
      return c.json({ error: "bad shard: part/of must be integers, 0<=part<of" }, 400);
    }
    shard = { part, of };
  }
  const db = createDb(c.env.DB);
  const result = await runOverseasEdinetCatchup(db, shard);
  return c.json(result);
});
