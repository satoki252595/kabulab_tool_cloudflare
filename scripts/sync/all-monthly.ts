// 月次・全取込オーケストレータ（ローカル実行）。1コマンドで:
//   kabulab月次(JPXセクター/優待スコア再計算) + 優待4ステップ(minkabu取得→記述抽出→
//   ローカルLLM(ELYZA)解釈→DB反映)。LLMはローカル(Metal)で実行されるためCF制約なし。
import "dotenv/config";
import { spawnSync } from "node:child_process";

const steps: Array<[string, string]> = [
  ["kabulab月次 (JPXセクター/優待スコア)", "scripts/sync/monthly.ts"],
  ["優待 取得 (minkabu)", "services/otakara-yutai/data-scripts/fetch-yutai-full.ts"],
  ["優待 記述抽出", "services/otakara-yutai/data-scripts/export-benefit-descriptions.ts"],
  ["優待 LLM解釈 (ELYZA local)", "services/otakara-yutai/data-scripts/interpret-benefits.ts"],
  ["優待 DB反映", "services/otakara-yutai/data-scripts/apply-benefit-interpretations.ts"],
];

let failed = 0;
for (const [label, script] of steps) {
  console.info(`\n========== [monthly] ${label} ==========`);
  const r = spawnSync("npx", ["tsx", script], { stdio: "inherit", env: process.env });
  if (r.status !== 0) { failed++; console.error(`[monthly] 失敗: ${label} (exit ${r.status})`); }
}
console.info(`\n[monthly] 完了。失敗ステップ ${failed}/${steps.length}`);
process.exit(failed ? 1 : 0);
