// 月次・全取込オーケストレータ（ローカル実行）。1コマンドで:
//   otakara 派生テーブル rebuild + 優待 (minkabu取得→記述抽出→要約タスク書き出し)。
//
// 優待の要約 (short_summary / estimated_value) は**ここでは作らない**。要約は
// リポジトリの外のクラウド LLM (Cursor Automations 等) が
// services/otakara-yutai/docs/llm-summary-task.md に従って作り、
// `pnpm yutai:summary:import` で検証して取り込む。以前はここでローカル LLM
// (node-llama-cpp + ELYZA-JP-8B、初回に数 GB をダウンロード) を回していた。
//
// 要約が未反映でも月次同期は失敗させない。未要約の行は公開面で要約が空になるだけで
// (掲載文は出さない)、他のデータの更新を止める理由にならないため。
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const day = new Date().toISOString().slice(0, 10);
const tasksPath = join(
  "services/otakara-yutai/data-scripts/data/summary-tasks",
  `tasks-${day}.jsonl`,
);

const steps: Array<[string, string, string[]]> = [
  ["otakara 派生テーブル rebuild (Node → D1 REST)", "scripts/sync/monthly.ts", []],
  ["優待 取得 (minkabu)", "services/otakara-yutai/data-scripts/fetch-yutai-full.ts", []],
  ["優待 記述抽出", "services/otakara-yutai/data-scripts/export-benefit-descriptions.ts", []],
  [
    "優待 要約タスク書き出し (要約は外部のクラウド LLM)",
    "services/otakara-yutai/data-scripts/export-summary-tasks.ts",
    ["--out", tasksPath],
  ],
];

let failed = 0;
let tasksExported = false;
for (const [label, script, args] of steps) {
  console.info(`\n========== [monthly] ${label} ==========`);
  const r = spawnSync("npx", ["tsx", script, ...args], { stdio: "inherit", env: process.env });
  if (r.status !== 0) {
    failed++;
    console.error(`[monthly] 失敗: ${label} (exit ${r.status})`);
  } else if (script.endsWith("export-summary-tasks.ts")) {
    tasksExported = true;
  }
}

if (tasksExported) {
  console.info(
    `\n[monthly] 優待の要約はこの同期では作っていません。要約タスクを ${tasksPath} に書き出しました。\n` +
      "  1. services/otakara-yutai/docs/llm-summary-task.md とタスクファイルをクラウド LLM (Cursor Automations 等) に渡して要約させる\n" +
      "     (タスクファイルは出典サイトの掲載文を含むので、コミットや公開の場所には置かない)\n" +
      `  2. pnpm yutai:summary:import --tasks ${tasksPath} --results <結果ファイル>          # dry-run で件数とはじいた理由を確認\n` +
      `  3. pnpm yutai:summary:import --tasks ${tasksPath} --results <結果ファイル> --apply  # 通った行だけ D1 に書く`,
  );
}
console.info(`\n[monthly] 完了。失敗ステップ ${failed}/${steps.length}`);
process.exit(failed ? 1 : 0);
