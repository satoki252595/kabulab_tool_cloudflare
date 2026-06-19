/**
 * 005 yuho-quant — 取込トリガ（Worker 側エントリ, ADR-0001）。
 *
 * D1 はバインディング経由でのみ触れるため、EDINET 有報の取込は Node ローカル
 * CLI ではなく **Worker 上で** 実行する。本ルートが現状の唯一の取込窓口で、
 * 手動 curl / CLI トリガ (scripts/sync/yuho-edinet.ts) から叩く。Workers Cron
 * Trigger からの定期起動 ([triggers] crons + scheduled ハンドラ) は Phase 3 で
 * 追加予定 (現状は未配線)。
 *
 *   POST /yuho-quant/admin/catchup[?part=0&of=8]
 *   Authorization: Bearer $CRON_SECRET
 *
 * 認証は共有 cronAuthMiddleware（CRON_SECRET, fail-closed）。EDINET_API_KEY /
 * NOTION_TOKEN は Worker secret（process.env, nodejs_compat 経由）で参照する。
 */
import { Hono } from "hono";
import { cronAuthMiddleware } from "../../../../src/shared/auth.js";
import { createDb } from "../db/client.js";
import {
  runYuhoEdinetCatchup,
  type ShardOpts,
} from "../../../../src/cron/yuho-edinet.js";

type Bindings = { DB: D1Database };
export const adminRoute = new Hono<{ Bindings: Bindings }>();

// 取込窓口は全て CRON_SECRET 認証必須（未設定なら 401・fail-closed）。
adminRoute.use("/*", cronAuthMiddleware);

/**
 * EDINET 有報の日次キャッチアップ取込。直近 WINDOW 日を走査し未取込分を
 * D1 へ冪等保存 + 物理 ZIP を Notion へ記録（ルール6）。shard 指定時は
 * docId ハッシュで担当分のみ処理する（複数 cron 並走で全件カバー）。
 */
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
  const result = await runYuhoEdinetCatchup(db, shard);
  return c.json(result);
});
