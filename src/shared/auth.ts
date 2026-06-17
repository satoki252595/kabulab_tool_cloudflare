/**
 * Cron 認証 — Vercel Cron から送られる `Authorization: Bearer $CRON_SECRET` を検証する。
 *
 * 従来は各サービスが独立して認証関数を持っていた (rsi-screening/src/index.ts の
 * インライン比較、swing-trading/src/routes/api.ts のインライン比較、
 * otakara-yutai/src/services/cron-auth.ts) が、統一 cron エンドポイントへ移行する
 * にあたり 1 箇所に集約した。
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import { sharedEnv } from "./env.js";

/**
 * `Authorization: Bearer <token>` ヘッダの token 部分を返す。
 * 形式不正なら null。
 */
function extractBearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return null;
  const token = parts[1];
  return token.length > 0 ? token : null;
}

/**
 * CRON_SECRET を型付きアクセサ (sharedEnv — ルール3) 経由で取得し、
 * リクエストヘッダの Bearer token と比較する。
 *
 * CLAUDE.md のフォールバック禁止ルールに従い、CRON_SECRET 未設定時は
 * 常に 401 を返す (falsy fallback しない・fail-closed)。required() で
 * throw させない理由: cron エンドポイント全体が 500 になり挙動が変わるため。
 */
export function verifyCronSecret(request: Request): boolean {
  const expected = sharedEnv.CRON_SECRET();
  if (expected === undefined) return false;
  const token = extractBearerToken(request.headers.get("Authorization"));
  return token !== null && token === expected;
}

/** Hono ミドルウェア版 */
export const cronAuthMiddleware: MiddlewareHandler = async (
  c: Context,
  next: Next
) => {
  if (!verifyCronSecret(c.req.raw)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
};
