// 日次・全取込オーケストレータ（ローカル実行・手動/バックフィル用）。1コマンドで:
//   kabulab日次(Worker /admin/sync-daily を叩く薄いトリガ) + VWAP(日足10年/5分足/信用残高→R2)
// 通常の日次取込は Workers Cron が自動発火する(wrangler.toml [triggers])。本スクリプトは
// 手動再実行用。各ステップは continue-on-error（1つ失敗しても次を実行。最後に失敗数で exit code）。
// 必要env(.env): WORKER_BASE_URL, CRON_SECRET（日次トリガ用）,
//                YAHOO_PROXY_BASE（VWAP の Yahoo をエッジ経由で 429 回避）,
//                R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
import "dotenv/config";
import { spawnSync } from "node:child_process";

// 有報 EDINET は D1 へ移行済み（ADR-0001）。取込は Worker 側の認証ルートで
// 実行するため、本ローカル日次パイプラインからは外した（`pnpm ingest:yuho-edinet`
// が Worker /yuho-quant/admin/catchup を叩く独立トリガになっている）。
// 適時開示 TDnet は D1 へ移行済み（ADR-0001）。取込は Worker 認証ルートで実行する
// ため本ローカル日次パイプラインからは外した（`pnpm ingest:ir-tdnet` が Worker
// /ir-catalog/admin/catchup を叩く独立トリガになっている）。
const steps: Array<[string, string]> = [
  ["kabulab日次 (Worker /admin/sync-daily トリガ)", "scripts/sync/daily.ts"],
  ["VWAP 日足10年→R2", "scripts/vwap/ingest-daily.ts"],
  ["VWAP 5分足蓄積→R2", "scripts/vwap/ingest-intra.ts"],
  ["VWAP 信用残高(週次PDF)→R2", "scripts/vwap/ingest-margin.ts"],
];

let failed = 0;
for (const [label, script] of steps) {
  console.info(`\n========== [daily] ${label} ==========`);
  const r = spawnSync("npx", ["tsx", script, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: process.env,
  });
  if (r.status !== 0) { failed++; console.error(`[daily] 失敗: ${label} (exit ${r.status})`); }
}
console.info(`\n[daily] 完了。失敗ステップ ${failed}/${steps.length}`);
process.exit(failed ? 1 : 0);
