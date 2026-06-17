import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";

/**
 * グローバルエラーハンドラー
 */
export function errorHandler(err: Error, c: Context) {
  console.error("[error-handler]", err);

  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }

  if (err instanceof ZodError) {
    return c.json(
      { error: "バリデーションエラー", issues: err.issues },
      400
    );
  }

  return c.json({ error: "サーバー内部エラー" }, 500);
}
