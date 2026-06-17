/**
 * 001 RSI Screening — kabulab portal 配下のサブアプリのエントリポイント
 *
 * ルート Hono アプリ (`/src/index.ts`) で
 *   `rootApp.route(BASE_PATH, rsiScreeningApp)`
 * としてマウントされる。
 *
 * 実装本体は src/index.ts。BASE_PATH の前置処理は views/routes 側で
 * `BASE_PATH` 定数 (`./base-path.ts`) を参照することで完結する。
 */
import app from "./src/index.js";

export { BASE_PATH } from "./base-path.js";
export const rsiScreeningApp = app;
export default app;
