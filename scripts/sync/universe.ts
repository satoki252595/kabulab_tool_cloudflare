/**
 * 母集団 (core.stocks) 同期エントリポイント (CLI)
 *
 * JPX 公式 data_j.xls の東証内国普通株（共有4文字コード、~3,700）を
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

async function main(): Promise<void> {
  const db = createUniverseDb();
  const result = await runUniverseSync(db);
  console.info(
    `[sync-universe] 完了: 基準日=${result.sourceAsOf} JPX=${result.jpxRows} ` +
      `対象株=${result.equities} upsert=${result.upserted} 対象外化=${result.deactivated}`
  );
}

main().catch((e) => {
  console.error("[sync-universe] エラー:", rootCauseMessage(e));
  process.exit(1);
});
