import { Hono } from "hono";
import { createErrorHandler } from "../../../src/shared/error-handler.js";
import { pagesRoute } from "./routes/pages.js";

/** Honoアプリ — strict: false で trailing slash の有無を吸収 */
export const app = new Hono({ strict: false });
const errorHandler = createErrorHandler("rsi-screening");

// NOTE: 旧 /api/cron/sync-daily エンドポイントは廃止された。
// 日次/月次の統一 cron は root app (/api/cron/sync-{daily,monthly}) に集約している。
// 詳細は src/index.ts / src/cron/{daily,monthly}.ts を参照。

// SSR pages
app.route("/", pagesRoute);

app.onError(errorHandler);

export default app;
