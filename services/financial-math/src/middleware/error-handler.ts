import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";

/**
 * グローバルエラーハンドラー
 *
 * CLAUDE.md のフォールバック禁止ルールに従い、エラーを握り潰して
 * 「見かけ上 200」を返さない。必ずステータスコードを正しく返し、
 * 異常状態が呼び出し側 / ブラウザで明示される状態を保つ。
 */
export function errorHandler(err: Error, c: Context) {
  console.error("[financial-math error-handler]", err);

  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }

  if (err instanceof ZodError) {
    return c.json({ error: "バリデーションエラー", issues: err.issues }, 400);
  }

  return c.json({ error: "サーバー内部エラー" }, 500);
}
