/**
 * 005 yuho-quant — 取込トリガ（Worker 側エントリ, ADR-0001）。
 *
 * Worker バインディング経由の認証付き取込窓口。日次 Node CLI は同じ共通処理を
 * 既存 D1 HTTP 接続で直接実行するため、このルートへの長い POST は使わない。
 * Workers Cron Trigger は未配線。
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
  catchupHttpStatus,
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
  // 一覧取得失敗は result 本文付き非 2xx。取込例外は結果を返さず停止する。
  // 母集団外・cap・既取込は正当結果で 200 のまま。
  return c.json(result, catchupHttpStatus(result));
});
