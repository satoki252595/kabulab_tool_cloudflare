/**
 * 月次 rebuild エントリポイント (Node / GitHub Actions)
 *
 * core/swing から otakara の派生テーブル (otakara_stock_financials / otakara_stock_scores)
 * を再構築する。Yahoo は叩かない。D1 へは `createD1HttpDb`。実装は src/cron/monthly.ts。
 *
 * 定期順序: `pnpm sync:universe`(母集団) → 優待原文取得 → 本 rebuild。
 * 保存財務・swingを使い、MA乖離比較だけ財務日と指標日の一致を要求する。
 * 当日18時の日次取得は待たない。is_yutai は yutai_benefits から再導出。
 *
 * 実行:
 *   pnpm sync:monthly:core    # この単体
 *   pnpm sync:monthly         # all-monthly.ts (これ + 優待パイプラインを束ねる)
 */
import "dotenv/config";
import {
  createMonthlyRebuildDb,
  runMonthlyRebuild,
} from "../../src/cron/monthly.js";
import { sharedEnv } from "../../src/shared/env.js";
import { installScheduledDeadline, nativeJobExecutionWindow, ScheduledSourceDeadlineError } from "../../src/shared/scheduled-admission.js";

async function main(): Promise<void> {
  const window = nativeJobExecutionWindow(Date.now(), sharedEnv.BATCH_JOB_STARTED_AT(), 360, 10);
  const assertSource = () => {
    if (window !== undefined && Date.now() >= window.sourceDeadline) {
      throw new ScheduledSourceDeadlineError("月次再計算の新規取得予算がありません（未完）");
    }
  };
  assertSource();
  const restore = window === undefined ? undefined : installScheduledDeadline(window.deadline);
  try {
  const db = createMonthlyRebuildDb();
  await runMonthlyRebuild(db, { beforeSourceRequest: assertSource });
  } finally { restore?.(); }
}

main().catch((e) => {
  console.error("[sync-monthly] エラー:", e);
  process.exit(1);
});
