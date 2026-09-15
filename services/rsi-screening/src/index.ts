import { Hono } from "hono";
import { createErrorHandler } from "../../../src/shared/error-handler.js";
import { pagesRoute } from "./routes/pages.js";

/** Honoアプリ — strict: false で trailing slash の有無を吸収 */
export const app = new Hono({ strict: false });
const errorHandler = createErrorHandler("rsi-screening");

// NOTE: 旧 /api/cron/sync-daily エンドポイントは廃止された。
// 日次/月次の取込は GitHub Actions (Node) が実行する (src/cron/{daily,monthly}.ts)。
// Worker 上に cron ルートは無い。

// SSR pages
app.route("/", pagesRoute);

app.onError(errorHandler);

export default app;
