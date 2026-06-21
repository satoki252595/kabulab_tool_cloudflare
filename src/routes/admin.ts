import { Hono } from "hono";
import { cronAuthMiddleware } from "../shared/auth.js";
import { createDailyDb, runDailySync, type ShardOpts } from "../cron/daily.js";
import {
  createMonthlyRebuildDb,
  runMonthlyRebuild,
} from "../cron/monthly.js";

/**
 * 横断取込 (core / 001 rsi / 002 otakara / 003 swing) を実行する認証付きルート
 * （ADR-0001 Phase 3）。Workers Cron の scheduled ハンドラと同じオーケストレータを
 * 共有し、こちらは **手動 / CLI トリガ**（CRON_SECRET 認証）用の入口。
 *
 * ルート root app に `app.route("/admin", adminRoute)` でマウントする。
 *   POST /admin/sync-daily?part=&of=  日次 sync（シャード指定可）
 *   POST /admin/sync-monthly          otakara 派生再構築（Yahoo 不使用）
 */
type Bindings = { DB: D1Database };

export const adminRoute = new Hono<{ Bindings: Bindings }>({ strict: false });

// 全 /admin/* は CRON_SECRET Bearer 必須 (fail-closed)。
adminRoute.use("/*", cronAuthMiddleware);

adminRoute.post("/sync-daily", async (c) => {
  const partRaw = c.req.query("part");
  const ofRaw = c.req.query("of");
  let shard: ShardOpts | undefined;
  if (partRaw !== undefined || ofRaw !== undefined) {
    const part = Number(partRaw);
    const of = Number(ofRaw);
    if (
      !Number.isInteger(part) ||
      !Number.isInteger(of) ||
      of <= 0 ||
      part < 0 ||
      part >= of
    ) {
      return c.json(
        { error: "part/of は整数で 0<=part<of を満たす必要があります" },
        400
      );
    }
    shard = { part, of };
  }
  const db = createDailyDb(c.env.DB);
  const result = await runDailySync(db, shard);
  return c.json(result);
});

adminRoute.post("/sync-monthly", async (c) => {
  const db = createMonthlyRebuildDb(c.env.DB);
  const result = await runMonthlyRebuild(db);
  return c.json(result);
});
