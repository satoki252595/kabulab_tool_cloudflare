// 月次の優待取得→派生再計算。Mac定期実行は廃止し、要約をここから起動しない。
import "dotenv/config";
import { spawnSync } from "node:child_process";

const steps: Array<[string, string, string[]]> = [
  ["優待 取得 (minkabu)", "services/otakara-yutai/data-scripts/fetch-yutai-full.ts", []],
  ["otakara 派生テーブル rebuild (Node → D1 REST)", "scripts/sync/monthly.ts", []],
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
