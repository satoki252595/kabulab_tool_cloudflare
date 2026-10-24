/**
 * 母集団 (core.stocks) 同期エントリポイント (CLI)
 *
 * JPX 公式 data_j.xlsx の東証内国普通株（共有4文字コード、~3,700）を
 * core.stocks に upsert する。
 * 初回 seed や JPX 構成変更の手動反映に使う。月次は stock-sync.yml が
 * このコマンドを実行した後に `pnpm sync:monthly:core` を呼ぶ。
 *
 * 実行:
 *   pnpm sync:universe
 */

import "dotenv/config";
import { createUniverseDb, runUniverseSync } from "../../src/cron/universe.js";
import { rootCauseMessage } from "../../src/shared/errors.js";
import { sharedEnv } from "../../src/shared/env.js";
import { installScheduledDeadline, nativeJobExecutionWindow, ScheduledSourceDeadlineError } from "../../src/shared/scheduled-admission.js";

async function main(): Promise<void> {
  const window = nativeJobExecutionWindow(Date.now(), sharedEnv.BATCH_JOB_STARTED_AT(), 360, 10);
  if (window !== undefined && Date.now() >= window.sourceDeadline) {
    throw new ScheduledSourceDeadlineError("月次母集団の新規取得予算がありません（未完）");
  }
  const restore = window === undefined ? undefined : installScheduledDeadline(window.deadline);
  try {
  const db = createUniverseDb();
  const result = await runUniverseSync(db);
  console.info(
    `[sync-universe] 完了: 基準日=${result.sourceAsOf} JPX=${result.jpxRows} ` +
      `対象株=${result.equities} upsert=${result.upserted} 対象外化=${result.deactivated} ` +
      `instrument_type更新(非内国普通株)=${result.instrumentTypeUpdated}`
  );
  // 5 文字の種類株 (内国株式の区分) が毎月出るのは正常。それ以外の区分が出たら
  // JPX が区分を変えた合図 (src/shared/jpx/instrument-type.ts の表を見直す)。
  console.info(
    `[sync-universe] instrument_type 未分類: ${JSON.stringify(result.unclassifiedCategories)}`
  );
  } finally { restore?.(); }
}

main().catch((e) => {
  console.error("[sync-universe] エラー:", rootCauseMessage(e));
  process.exit(1);
});
