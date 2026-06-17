import { Hono } from "hono";
import { errorHandler } from "./middleware/error-handler.js";
import { pagesRoute } from "./routes/pages.js";

/**
 * 005 yuho-quant — Hono サブアプリ本体
 *
 * `strict: false` で trailing slash を吸収。ルート側の mount
 * (`app.route(BASE_PATH, yuhoQuantApp)`) が BASE_PATH を前置するため、
 * ここでは相対パスで登録する。
 */
export const app = new Hono({ strict: false });

app.route("/", pagesRoute);

app.onError(errorHandler);

export default app;
