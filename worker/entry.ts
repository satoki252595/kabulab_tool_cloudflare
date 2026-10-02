// Cloudflare Worker エントリ。Hono root app を fetch ハンドラとして公開し、
// 株式 sync の CF スケジューラを scheduled ハンドラとして公開する。
//
// データストア: D1(c.env.DB バインディング) / R2(c.env.BUCKET) / 一次データは Notion。
// 取込(日次/月次の指標計算 + VWAP)は **GitHub Actions(Node)** で実行し、Worker は
//   - サイト配信(D1 読取)
//   - Yahoo/VWAP 取込プロキシ(共有クライアントのエッジ経由取得)
//   - 005/006 の認証取込ルート /admin/catchup
//   - 株式 sync の起動 (scheduled → workflow_dispatch) と期限 readcheck
// を担う。Workers Paid 上でも全銘柄の取得・計算は既存 Node 経路を継続し、
// scheduled 処理は R2 + GitHub API による起動と結果確認のみとする。
import app from "../src/index.js";
import {
  handleStockScheduled,
  type ScheduledControllerLike,
  type SchedulerEnv,
} from "../src/scheduler/stock.js";

// app.fetch は arrow-bound (hono-base.js) のため未束縛参照で安全。
export default {
  fetch: app.fetch,
  scheduled: (controller: ScheduledControllerLike, env: SchedulerEnv) =>
    handleStockScheduled(controller, env),
};
