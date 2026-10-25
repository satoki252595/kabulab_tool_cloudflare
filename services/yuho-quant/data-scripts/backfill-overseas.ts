/** 保存原本だけの有限海外補完。暗黙の全市場走査・上流取得は行わない。 */
import "dotenv/config";
import assert from "node:assert/strict";
import {
  parseSavedOverseasOptions,
  runSavedOverseas,
} from "./lib/saved-overseas-backfill.js";

const options = parseSavedOverseasOptions(process.argv.slice(2));
assert(
  options,
  "overseas_saved_cohort_required: 固定 --saved-cohort、prepare/apply/inspectのいずれかの --saved-mode、および通信・時間上限を明示してください。旧 --limit/--offset/--force だけの上流取得は廃止済みです。docs/test-logs/overseas-saved-cohort-20261017.md を参照してください。",
);
await runSavedOverseas(options, process.cwd());
