import { Hono } from "hono";
import { errorHandler } from "./middleware/error-handler.js";
import { pagesRoute } from "./routes/pages.js";
import { adminRoute } from "./routes/admin.js";

/**
 * 008 overseas-sales — Hono サブアプリ本体
 *
 * `strict: false` で trailing slash を吸収。ルート側の mount
 * (`app.route(BASE_PATH, overseasSalesApp)`) が BASE_PATH を前置するため、
 * ここでは相対パスで登録する。
 */
export const app = new Hono({ strict: false });

// 取込トリガ（Worker 側・CRON_SECRET 認証）。SSR より先に登録する。
app.route("/admin", adminRoute);
app.route("/", pagesRoute);

app.onError(errorHandler);

export default app;
