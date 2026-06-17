/**
 * 005 yuho-quant — kabulab portal 配下のサブアプリのエントリポイント。
 *
 * ルート Hono アプリ (/src/index.ts) で
 *   rootApp.route(BASE_PATH, yuhoQuantApp)
 * としてマウントされる。
 */
import app from "./src/index.js";

export { BASE_PATH } from "./base-path.js";
export const yuhoQuantApp = app;
export default app;
