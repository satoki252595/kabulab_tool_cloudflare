import { Hono } from "hono";
import { createErrorHandler } from "../../../src/shared/error-handler.js";
import { pagesRoute } from "./routes/pages.js";

/**
 * 006 ir-catalog — Hono サブアプリ本体
 *
 * `strict: false` で trailing slash を吸収。ルート側の mount
 * (`app.route(BASE_PATH, irCatalogApp)`) が BASE_PATH を前置するため、
 * ここでは相対パスで登録する。
 */
export const app = new Hono({ strict: false });
const errorHandler = createErrorHandler("ir-catalog");

// 注: ir-catalog の取込(catchup)は PDF センチメントが kuromoji(Node 専用 fs 依存)
// のため Worker 上で動かせない。取込は Node 実行で D1 HTTP API へ書く(別タスク)。
// Worker は読取(SSR/JSON, c.env.DB)のみを担う。
app.route("/", pagesRoute);

app.onError(errorHandler);

export default app;
