import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

/**
 * Zodバリデーションエラーかどうかを判定する（duck-typing）
 * Zod v4では$constructorで生成されるためinstanceofが使えない場合がある
 */
function isZodError(
  err: unknown
): err is { issues: Array<{ path: (string | number)[]; message: string }> } {
  if (typeof err !== "object" || err === null || !("issues" in err)) {
    return false;
  }
  const candidate = err as Record<string, unknown>;
  return Array.isArray(candidate.issues);
}

/**
 * グローバルエラーハンドラーミドルウェア
 * 全てのエラーをキャッチし、統一的なJSONエラーレスポンスを返す
 */
export function onError(err: Error, c: Context): Response {
  console.error(`[Error] ${err.message}`);

  // Zodバリデーションエラー
  if (isZodError(err)) {
    return c.json(
      {
        error: "Validation Error",
        message: err.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join(", "),
      },
      400,
    );
  }

  // HTTPエラー（Honoが投げるHTTPException）
  if (err instanceof HTTPException) {
    return c.json(
      {
        error: "HTTP Error",
        message: err.message,
      },
      err.status,
    );
  }

  // その他の予期しないエラー
  return c.json(
    {
      error: "Internal Server Error",
      message: "予期しないエラーが発生しました",
    },
    500,
  );
}

/**
 * 404ハンドラー
 * マッチするルートがない場合に呼ばれる
 */
export function onNotFound(c: Context): Response {
  return c.json(
    {
      error: "Not Found",
      message: `${c.req.method} ${c.req.path} は存在しません`,
    },
    404,
  );
}
