/**
 * 日次データ取得エントリポイント (Node / GitHub Actions)
 *
 * core/rsi/swing が必要とする財務・指標・OHLCV を Yahoo から取得し D1 へ書き込む。
 * Yahoo は共有クライアントが `YAHOO_PROXY_BASE`(Worker エッジ)経由で叩き、自宅/CI の
 * IP の 429 を回避する。D1 へは `createD1HttpDb`(CLOUDFLARE_* env)。
 * 実装本体は src/cron/daily.ts。
 *
 * 母集団 (core_stocks) の JPX 同期は xlsx が Node 専用のため別途 `pnpm sync:universe`。
 *
 * 実行:
 *   pnpm sync:daily:core      # この単体
 *   pnpm sync:daily           # all-daily.ts (これ + VWAP を束ねる)
 *   GitHub Actions: .github/workflows/stock-sync.yml
 */
import "dotenv/config";
import { createDailyDb, runDailySync } from "../../src/cron/daily.js";

async function main(): Promise<void> {
  const db = createDailyDb();
  const result = await runDailySync(db);

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
