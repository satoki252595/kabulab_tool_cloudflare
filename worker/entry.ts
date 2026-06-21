// Cloudflare Worker エントリ。
// fetch ハンドラ = Hono root app（配信 + 認証取込ルート /admin/*）。
// scheduled ハンドラ = Workers Cron Trigger（日次/月次の自動取込・ADR-0001 Phase 3）。
//
// データストア参照:
//   - D1(c.env.DB バインディング): 全サービスの正規化リレーショナル正本
//   - R2(c.env.BUCKET): 時系列(VWAP 等)
//   - 一次データ(raw): Notion
//
// 取込:
//   - 日次/月次の指標・スコア計算は Worker 上(Cron / POST /admin/sync-*)で実行。
//     Yahoo はエッジから直接叩くので自宅 IP の 429 に掛からない。
//   - 母集団 (core_stocks) の JPX 同期は xlsx パーサが Node 専用のため
//     `pnpm sync:universe`(Node) で別途実行する。
import app from "../src/index.js";
import { handleScheduled, type WorkerEnv } from "../src/cron/scheduled.js";

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
  scheduled(controller: ScheduledController, env: WorkerEnv) {
    return handleScheduled(controller, env);
  },
};
