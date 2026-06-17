/**
 * 月次データ取得エントリポイント (CLI)
 *
 * JPX 公式 XLS で core.stocks.sector を更新し、otakara の public.stock_financials
 * / public.stock_scores を再構築する。詳細は src/cron/monthly.ts を参照。
 *
 * Yahoo は 1 回も叩かない (日次 sync が取得済みのデータを DB 経由で再利用)。
 *
 * 実行:
 *   pnpm sync:monthly
 *
 * 関連:
 *   - Vercel cron: `/api/cron/sync-monthly` (毎月 1 日 22:00 UTC)
 */

import "dotenv/config";
import { createMonthlyDb, runMonthlySync } from "../../src/cron/monthly.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }

  const db = createMonthlyDb(databaseUrl);
  await runMonthlySync(db);
}

main().catch((e) => {
  console.error("[sync-monthly] エラー:", e);
  process.exit(1);
});
