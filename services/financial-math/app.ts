/**
 * 004 Financial Math — kabulab portal 配下のサブアプリのエントリポイント
 *
 * ルート Hono アプリ (`/src/index.ts`) で
 *   `rootApp.route(BASE_PATH, financialMathApp)`
 * としてマウントされる。
 */
import app from "./src/index.js";

export { BASE_PATH } from "./base-path.js";
export const financialMathApp = app;
export default app;
