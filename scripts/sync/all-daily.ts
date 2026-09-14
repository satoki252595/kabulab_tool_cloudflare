// 日次・全取込オーケストレータ（ローカル実行・手動/バックフィル用）。1コマンドで:
//   core/rsi/swing 日次(Node→D1 REST) + VWAP(日足10年/5分足/信用残高→R2)
// 通常運用は stock-sync.yml と vwap-ingest.yml が GitHub Actions で別々に実行する。
// 本スクリプトは手動再実行用。各ステップは continue-on-error（1つ失敗しても次を
// 実行し、最後に失敗数で非ゼロ終了）。
// 必要env(.env):
//   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / D1_DATABASE_ID
//   YAHOO_PROXY_BASE / CRON_SECRET
//   R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
import "dotenv/config";
import { spawnSync } from "node:child_process";

// 有報 EDINET は D1 へ移行済み。取込は Worker 側の認証ルートで
// 実行するため、本ローカル日次パイプラインからは外した（`pnpm ingest:yuho-edinet`
// が Worker /yuho-quant/admin/catchup を叩く独立トリガになっている）。
// 適時開示 TDnet は D1 へ移行済み。取込は `pnpm ingest:ir-tdnet` の Node 直接実行
// (kuromoji が Node 専用のため。Worker 側に /ir-catalog/admin/catchup は無い) で
// 行うため、本ローカル日次パイプラインからは外した。
const steps: Array<[string, string]> = [
  ["core/rsi/swing 日次 (Node → D1 REST)", "scripts/sync/daily.ts"],
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
