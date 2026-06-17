/**
 * 日次データ取得エントリポイント (CLI)
 *
 * 3 サービス (001 RSI / 002 otakara / 003 swing) すべてが必要とする日次データを
 * 1 本のフローで取得・計算・保存する。詳細は src/cron/daily.ts を参照。
 *
 * Phase 0 で母集団 (core.stocks) を JPX 最新へ同期するため、`pnpm sync:universe`
 * を別途先に走らせる必要はない (日次に内包済み)。初回 seed もこれ 1 本で足りる。
 *
 * 実行:
 *   pnpm sync:daily
 *
 * 関連:
 *   - Vercel cron: `/api/cron/sync-daily` (平日 20:00 UTC)
 */

import "dotenv/config";
import { createDailyDb, runDailySync } from "../../src/cron/daily.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }

  const db = createDailyDb(databaseUrl);
  const result = await runDailySync(db);

  if (result.universe) {
    console.info(
      `[sync-daily] 母集団同期: 内国株=${result.universe.equities} upsert=${result.universe.upserted} 廃止=${result.universe.delisted}`
    );
  } else {
    console.warn(
      "[sync-daily] 母集団同期は未実行/失敗 (既存 core.stocks を使用)。Phase 0 のログを確認してください。"
    );
  }

  if (result.failures.length > 0) {
    console.warn("[sync-daily] 失敗銘柄:");
    for (const f of result.failures.slice(0, 50)) {
      console.warn(`  - ${f.code}: ${f.error}`);
    }
    if (result.failures.length > 50) {
      console.warn(`  ... 他 ${result.failures.length - 50} 銘柄`);
    }
  }
}

main().catch((e) => {
  console.error("[sync-daily] エラー:", e);
  process.exit(1);
});
