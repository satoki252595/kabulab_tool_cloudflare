import { Hono } from "hono";
import { errorHandler } from "./middleware/error-handler.js";
import { pagesRoute } from "./routes/pages.js";
import { apiRoute } from "./routes/api.js";

/**
 * 004 Financial Math — Hono サブアプリ本体
 *
 * `strict: false` を指定して trailing slash の有無を吸収する。
 * ルート側の mount (`app.route(BASE_PATH, financialMathApp)`) によって
 * BASE_PATH が自動で前置されるため、サブアプリ内の登録は相対パスで十分。
 */
export const app = new Hono({ strict: false });

// API routes (POST フォーム送信)
app.route("/api", apiRoute);

// SSR pages (GET / /dcf /capm /emh /black-scholes)
app.route("/", pagesRoute);

app.onError(errorHandler);

export default app;
