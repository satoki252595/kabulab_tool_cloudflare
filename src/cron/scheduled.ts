/**
 * Workers Cron Trigger の scheduled ハンドラ（ADR-0001 Phase 3・完全自動化）。
 *
 * 各 cron 式は **独立した invocation** で発火するため、シャード毎に subrequest /
 * 時間バジェットを独立して使える。日次は母集団 ~4,000 を DAILY_OF 分割し、各 part を
 * 別 cron 式で処理する（HTTP fan-out 不要・認証不要 = Worker 内部実行）。
 *
 * ⚠️ Workers Paid 前提: 無料枠は 1 invocation 50 subrequests のため 1 シャード
 * (~1,000 銘柄 × Chart+QuoteSummary) を捌けない。Paid は 10,000 subrequests。
 *
 * cron 式は wrangler.toml の [triggers] crons と **完全一致** させること。
 */

import { createDailyDb, runDailySync } from "./daily.js";
import { createMonthlyRebuildDb, runMonthlyRebuild } from "./monthly.js";

/** scheduled ハンドラが受け取る Worker 環境（D1 バインディングのみ使用）。 */
export interface WorkerEnv {
  DB: D1Database;
}

/** 日次シャード総数（wrangler.toml の日次 cron 数と一致させる）。 */
const DAILY_OF = 4;

/** 日次 cron 式 → シャード part のマッピング。 */
const DAILY_CRON_TO_PART: Record<string, number> = {
  "0 20 * * 1-5": 0,
  "3 20 * * 1-5": 1,
  "6 20 * * 1-5": 2,
  "9 20 * * 1-5": 3,
};

/** 月次 rebuild の cron 式（毎月 1 日 22:00 UTC）。 */
const MONTHLY_CRON = "0 22 1 * *";

/**
 * cron 発火を日次シャード / 月次 rebuild に振り分ける。
 * 戻り値の Promise を呼び出し側 (entry の scheduled) が await/waitUntil する。
 */
export async function handleScheduled(
  controller: ScheduledController,
  env: WorkerEnv
): Promise<void> {
  const cron = controller.cron;

  if (cron in DAILY_CRON_TO_PART) {
    const part = DAILY_CRON_TO_PART[cron];
    const db = createDailyDb(env.DB);
    const result = await runDailySync(db, { part, of: DAILY_OF });
    console.info(
      `[cron] sync-daily shard ${part}/${DAILY_OF}:`,
      JSON.stringify(result)
    );
    return;
  }

  if (cron === MONTHLY_CRON) {
    const db = createMonthlyRebuildDb(env.DB);
    const result = await runMonthlyRebuild(db);
    console.info("[cron] sync-monthly:", JSON.stringify(result));
    return;
  }

  console.warn(`[cron] 未対応の cron 式: ${cron}`);
}
