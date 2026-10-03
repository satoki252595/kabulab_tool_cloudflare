// Macでの月次・全取込。取得→派生再計算→ローカル要約の順で失敗時は後続停止。
// 本番ではActionsの月次取得とMacの21時要約jobへ同じ処理を接続している。
import "dotenv/config";
import { spawnSync } from "node:child_process";

const steps: Array<[string, string, string[]]> = [
  ["優待 取得 (minkabu)", "services/otakara-yutai/data-scripts/fetch-yutai-full.ts", []],
  ["otakara 派生テーブル rebuild (Node → D1 REST)", "scripts/sync/monthly.ts", []],
  ["優待 ローカル要約 (既存MLXモデル)", "scripts/biztag-local/main.ts", ["run", "yutai-summary"]],
];

for (const [label, script, args] of steps) {
  console.info(`[monthly] ${label}`);
  const r = spawnSync("pnpm", ["exec", "tsx", "--env-file-if-exists=.env", script, ...args], { stdio: "inherit", env: process.env });
  if (r.status !== 0) {
    console.error(`[monthly] 失敗: ${label} (exit ${r.status})`);
    process.exit(1);
  }
}
console.info("[monthly] 完了");
