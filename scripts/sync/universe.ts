/**
 * 母集団 (core.stocks) 同期エントリポイント (CLI)
 *
 * JPX 公式 data_j.xls の内国普通株 (~4,000) を core.stocks に upsert する。
 * 初回 seed や JPX 構成変更の手動反映に使う。月次 cron でも同等処理が
 * Phase 1 として走る (src/cron/monthly.ts)。
 *
 * 実行:
 *   pnpm sync:universe
 */

import "dotenv/config";
import { createUniverseDb, runUniverseSync } from "../../src/cron/universe.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }

  const db = createUniverseDb(databaseUrl);
  const result = await runUniverseSync(db);
  console.info(
    `[sync-universe] 完了: JPX=${result.jpxRows} 内国株=${result.equities} upsert=${result.upserted} 廃止=${result.delisted}`
  );
}

main().catch((e) => {
  console.error("[sync-universe] エラー:", e);
  process.exit(1);
});
