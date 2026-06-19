// 日次・全取込オーケストレータ（ローカル実行）。1コマンドで:
//   kabulab日次(Yahoo→Neon) + EDINET + TDnet + VWAP(日足10年/5分足/信用残高→R2)
// 各ステップは continue-on-error（1つ失敗しても次を実行。最後に失敗数で exit code）。
// 必要env(.env): DATABASE_URL, EDINET_API_KEY, NOTION_TOKEN, NOTION_*_PAGE_ID,
//                R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
import "dotenv/config";
import { spawnSync } from "node:child_process";

// 有報 EDINET は D1 へ移行済み（ADR-0001）。取込は Worker 側の認証ルートで
// 実行するため、本ローカル日次パイプラインからは外した（`pnpm ingest:yuho-edinet`
// が Worker /yuho-quant/admin/catchup を叩く独立トリガになっている）。
const steps: Array<[string, string]> = [
  ["kabulab日次 (Yahoo全銘柄→Neon)", "scripts/sync/daily.ts"],
  ["適時開示 TDnet", "scripts/sync/ir-tdnet.ts"],
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
