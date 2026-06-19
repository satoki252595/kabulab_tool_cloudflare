// Cloudflare Worker エントリ。
// Hono の root app をそのまま Worker の fetch ハンドラとして公開する。
// データストア参照(ADR-0001 で移行中):
//   - 005 yuho-quant: D1(c.env.DB バインディング) ← Neon から移行済み
//   - 未移行サービス: Neon(c.env.DATABASE_URL / 各サービスの dbMiddleware)
//   - 時系列(VWAP 等): R2(c.env.BUCKET)
// 取得・加工は原則ローカル CLI(scripts/sync/*)。ただし D1 はバインディング経由のみ
// のため yuho の EDINET 取込は Worker 上(認証ルート /yuho-quant/admin/catchup)で実行する。
import app from "../src/index.js";

export default app;
