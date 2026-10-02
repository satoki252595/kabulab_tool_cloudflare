/**
 * 日次データ取得エントリポイント (Node / GitHub Actions)
 *
 * core/rsi/swing が必要とする財務・指標・OHLCV を Yahoo から取得し D1 へ書き込む。
 * Yahoo は共有クライアントが `YAHOO_PROXY_BASE`(Worker エッジ)経由で取得し、上流の制限を尊重する。
 * 同じrunのYahoo再取得は行わない。D1 へは `createD1HttpDb`(CLOUDFLARE_* env)。
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
  runMarketContextSync,
} from "../../src/cron/daily.js";
import { requireYahooProxyForNodeSync, sharedEnv } from "../../src/shared/env.js";
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
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 &&
      args[0] !== "--stocks-only" && args[0] !== "--context-only")) {
    throw new Error("指定できる引数は --stocks-only または --context-only です");
  }
  // Node から Yahoo を直接叩く構成は 429 と全銘柄リトライを招くため、DB 接続前に拒否。
  requireYahooProxyForNodeSync();
  const db = createDailyDb();
  if (args[0] === "--context-only") {
    if (!await runMarketContextSync(db)) throw new Error("マクロ同期が不完全です");
    console.info("[sync-context] 完了 (株式全量同期は対象外)");
    return;
  }
  const result = await runDailySync(db, { stocksOnly: args[0] === "--stocks-only" });

  if (result.failures.length > 0) {
    printFailureSummary(result.failures);
    console.warn(
      `[sync-daily] 失敗明細の一次保管: ${result.batchKey} ` +
        `(全${result.failures.length}件・切詰なし。上は人間可読の要約)`
    );
  }

  if (isDailySyncIncomplete(result)) {
    throw new Error(
      `日次同期が不完全です: 成功=${result.successStocks}/${result.totalStocks}, ` +
        `失敗=${result.failedStocks}, マクロ=${result.marketContextOk === null ? "対象外" : result.marketContextOk ? "成功" : "失敗"}`
    );
  }

  // 失敗率 ≤1% の成功扱い (L-57)。成功は成功だが、失敗の trace を残すため
  // workflow が Issue へコメントする。件数を GITHUB_OUTPUT へ出す。
  if (result.failures.length > 0) {
    const out = sharedEnv.GITHUB_OUTPUT();
    if (out !== undefined) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(out, `tolerated_failures=${result.failures.length}\n`);
    }
    console.info(
      `[sync-daily] 許容内失敗: ${result.failures.length} 件 (失敗率 1% 以下のため成功扱い)`
    );
  }

  // 実 tradingDate (D1 MAX(date) 由来。N225 session guard 通過済み) を
  // 後続 moneyflow の固定入力として GITHUB_OUTPUT へ出す (#160)。
  // null (Phase 3 実質全滅) なら出さない — 後続は空出力で起動しない (推測しない)。
  if (result.tradingDate !== null) {
    const out = sharedEnv.GITHUB_OUTPUT();
    if (out !== undefined) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(out, `trade_date=${result.tradingDate}\n`);
    }
    console.info(`[sync-daily] 取引日: ${result.tradingDate}`);
  }
}

main().catch((e) => {
  console.error("[sync-daily] エラー:", rootCauseMessage(e));
  process.exit(1);
});
