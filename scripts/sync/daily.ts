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
import {
  createDailyDb,
  isDailySyncIncomplete,
  runDailySync,
} from "../../src/cron/daily.js";
import { requireYahooProxyForNodeSync } from "../../src/shared/env.js";
import { rootCauseMessage } from "../../src/shared/errors.js";

const MAX_CODES_PER_ERROR = 50;
const MAX_ERROR_GROUPS = 20;

function printFailureSummary(
  failures: { code: string; error: string }[]
): void {
  const groups = new Map<string, string[]>();
  for (const failure of failures) {
    const codes = groups.get(failure.error) ?? [];
    codes.push(failure.code);
    groups.set(failure.error, codes);
  }

  console.warn(
    `[sync-daily] 失敗銘柄: ${failures.length} 件 / 原因グループ: ${groups.size} 件`
  );
  for (const [error, codes] of [...groups].slice(0, MAX_ERROR_GROUPS)) {
    const shown = codes.slice(0, MAX_CODES_PER_ERROR).join(", ");
    const omitted =
      codes.length > MAX_CODES_PER_ERROR
        ? ` …他${codes.length - MAX_CODES_PER_ERROR}件`
        : "";
    console.warn(`  - ${codes.length}件 [${shown}${omitted}]: ${error}`);
  }
  if (groups.size > MAX_ERROR_GROUPS) {
    console.warn(`  - 他${groups.size - MAX_ERROR_GROUPS}原因グループは省略`);
  }
}

async function main(): Promise<void> {
  // Node から Yahoo を直接叩く構成は 429 と全銘柄リトライを招くため、DB 接続前に拒否。
  requireYahooProxyForNodeSync();
  const db = createDailyDb();
  const result = await runDailySync(db);

  if (result.failures.length > 0) {
    printFailureSummary(result.failures);
  }

  if (isDailySyncIncomplete(result)) {
    throw new Error(
      `日次同期が不完全です: 成功=${result.successStocks}/${result.totalStocks}, ` +
        `失敗=${result.failedStocks}, マクロ=${result.marketContextOk ? "成功" : "失敗"}`
    );
  }

  // 失敗率 ≤1% の成功扱い (L-57)。成功は成功だが、失敗の trace を残すため
  // workflow が Issue へコメントする。件数を GITHUB_OUTPUT へ出す。
  if (result.failures.length > 0) {
    const out = process.env.GITHUB_OUTPUT;
    if (out !== undefined) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(out, `tolerated_failures=${result.failures.length}\n`);
    }
    console.info(
      `[sync-daily] 許容内失敗: ${result.failures.length} 件 (失敗率 1% 以下のため成功扱い)`
    );
  }
}

main().catch((e) => {
  console.error("[sync-daily] エラー:", rootCauseMessage(e));
  process.exit(1);
});
