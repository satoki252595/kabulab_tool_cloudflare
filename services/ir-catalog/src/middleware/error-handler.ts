import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";

/**
 * グローバルエラーハンドラ。CLAUDE.md ルール2 に従い、エラーを握り潰して
 * 「見かけ上 200」を返さない。常に正しいステータスを返し、異常を明示する。
 */
export function errorHandler(err: Error, c: Context) {
  console.error("[ir-catalog error-handler]", err);

  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  if (err instanceof ZodError) {
    return c.json({ error: "バリデーションエラー", issues: err.issues }, 400);
  }
  return c.json({ error: "サーバー内部エラー" }, 500);
}
