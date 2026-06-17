// Cloudflare Worker エントリ（配信のみ）。
// Hono の root app をそのまま Worker の fetch ハンドラとして公開する。
// R2 は c.env.BUCKET、Neon は c.env.DATABASE_URL（各サービスの dbMiddleware）で参照。
// 取得・加工・本番DB格納は Worker に載せず、ローカル CLI（scripts/sync/*）で実行する。
import app from "../src/index.js";

export default app;
