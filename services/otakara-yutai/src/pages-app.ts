import { Hono } from "hono";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { handle } from "hono/vercel";

import type { AppEnv } from "./types.js";
import { dbMiddleware, createRateLimiter } from "./middleware.js";
import pages from "./routes/pages.js";

/** エラーページ用の最小HTMLテンプレート（ダークテーマ統一） */
function errorPage(status: number, title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>${title} | お宝優待</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans JP", sans-serif;
      background: #0a0a0a; color: #f0f0f0; display: flex; flex-direction: column;
      align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 16px;
      text-align: center;
    }
    h1 { font-size: 3rem; color: #00d4ff; margin-bottom: 8px; }
    p { color: #a0a0a0; margin-bottom: 24px; }
    a { color: #00d4ff; text-decoration: none; padding: 10px 24px; border: 1px solid #2a2a2a;
        border-radius: 8px; background: #1a1a1a; display: inline-block; }
    a:hover { background: #252525; }
  </style>
</head>
<body>
  <h1>${status}</h1>
  <p>${message}</p>
  <a href="/">ホームへ戻る</a>
</body>
</html>`;
}

/**
 * ページ用Honoアプリ（SSR）
 * — API (/api) とは別のエントリポイント
 */
const app = new Hono<AppEnv>();

app.use("*", logger());
app.use("*", secureHeaders());
app.use("*", dbMiddleware);
app.use("*", createRateLimiter({ windowMs: 60_000, maxRequests: 60 }));

// エラーハンドリング
app.onError((err, c) => {
  console.error(`[PageError] ${err.message}`);
  return c.html(
    errorPage(500, "サーバーエラー", "予期しないエラーが発生しました。しばらくしてから再度お試しください。"),
    500
  );
});

app.notFound((c) => {
  return c.html(
    errorPage(404, "ページが見つかりません", "お探しのページは存在しないか、移動した可能性があります。"),
    404
  );
});

// ページルートをマウント
app.route("/", pages);

export default app;
export const GET = handle(app);
