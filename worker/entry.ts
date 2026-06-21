// Cloudflare Worker エントリ。Hono root app をそのまま fetch ハンドラとして公開する。
//
// データストア: D1(c.env.DB バインディング) / R2(c.env.BUCKET) / 一次データは Notion。
// 取込(日次/月次の指標計算 + VWAP)は **GitHub Actions(Node)** で実行し、Worker は
//   - サイト配信(D1 読取)
//   - Yahoo/VWAP 取込プロキシ(エッジ経由で 429 回避)
//   - 005/006 の認証取込ルート /admin/catchup
// のみを担う。Workers Paid を使わないため Workers Cron(scheduled)は配線しない。
import app from "../src/index.js";

export default app;
