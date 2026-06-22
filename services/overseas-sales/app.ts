/**
 * 008 overseas-sales — kabulab portal 配下のサブアプリのエントリポイント。
 *
 * ルート Hono アプリ (/src/index.ts) で
 *   rootApp.route(BASE_PATH, overseasSalesApp)
 * としてマウントされる。
 */
import app from "./src/index.js";

export { BASE_PATH } from "./base-path.js";
export const overseasSalesApp = app;
export default app;
