/**
 * 月次 rebuild エントリポイント (Node / GitHub Actions)
 *
 * core/swing から otakara の派生テーブル (otakara_stock_financials / otakara_stock_scores)
 * を再構築する。Yahoo は叩かない。D1 へは `createD1HttpDb`。実装は src/cron/monthly.ts。
 *
 * 前提順序: `pnpm sync:universe`(母集団) → 日次 sync(swing 指標) → 優待スクレイプ/解釈
 * (data-scripts) → 本 rebuild。is_yutai は rebuild 内で yutai_benefits から再導出。
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

async function main(): Promise<void> {
  const db = createMonthlyRebuildDb();
  await runMonthlyRebuild(db);
}

main().catch((e) => {
  console.error("[sync-monthly] エラー:", e);
  process.exit(1);
});
