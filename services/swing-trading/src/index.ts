import { Hono } from "hono";
import { createErrorHandler } from "../../../src/shared/error-handler.js";
import { pagesRoute } from "./routes/pages.js";
import { apiRoute } from "./routes/api.js";

/**
 * 003 Swing Trading — Hono サブアプリ本体
 *
 * `strict: false` を指定して trailing slash の有無を吸収する。
 * ルート側の mount (`app.route(BASE_PATH, swingTradingApp)`) によって
 * BASE_PATH が自動で前置されるので、ここでの登録は相対パスで十分。
 */
export const app = new Hono({ strict: false });
const errorHandler = createErrorHandler("swing-trading");

// API routes (POST /api/risk/calc + GET /api/cron/sync-daily)
app.route("/api", apiRoute);

// SSR pages (GET / /screening /signals /stock/:code /risk)
app.route("/", pagesRoute);

app.onError(errorHandler);

export default app;
