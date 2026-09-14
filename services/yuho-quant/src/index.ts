import { Hono } from "hono";
import { createErrorHandler } from "../../../src/shared/error-handler.js";
import { pagesRoute } from "./routes/pages.js";
import { adminRoute } from "./routes/admin.js";

/**
 * 005 yuho-quant — Hono サブアプリ本体
 *
 * `strict: false` で trailing slash を吸収。ルート側の mount
 * (`app.route(BASE_PATH, yuhoQuantApp)`) が BASE_PATH を前置するため、
 * ここでは相対パスで登録する。
 */
export const app = new Hono({ strict: false });
const errorHandler = createErrorHandler("yuho-quant");

// 取込トリガ（Worker 側・CRON_SECRET 認証）。SSR より先に登録する。
app.route("/admin", adminRoute);
app.route("/", pagesRoute);

app.onError(errorHandler);

export default app;
