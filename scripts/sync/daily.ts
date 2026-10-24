/**
 * 日次データ取得エントリポイント (Node / GitHub Actions)
 *
 * 株式と引け後JP legを更新。--context-onlyは保存JP leg + 米国3sourceを翌朝結合する。
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
  categorizeSyncFailure,
  isDailySyncIncomplete,
  runDailySync,
  runMarketContextSync,
} from "../../src/cron/daily.js";
import { requireYahooProxyForNodeSync, sharedEnv } from "../../src/shared/env.js";
import { rootCauseMessage } from "../../src/shared/errors.js";
import { r2GetVersion, r2Put } from "../vwap/lib/r2.js";
import type { MacroJpLegStore } from "../../src/cron/macro-jp-leg.js";
import { notionStats } from "../../src/shared/notion-archive/client.js";
import { scheduledAtForDate } from "../../src/shared/scheduled-admission.js";
import { assertStockSyncDeadline, assertStockSyncStart, installStockSyncDeadline, stockSyncExecutionWindow, stockSyncRunDate } from "../../src/shared/stock-sync-window.js";

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
    `[sync-daily] 未完銘柄: ${failures.length} 件 / 原因グループ: ${groups.size} 件`
  );
  const categories = new Map<string, number>();
  for (const { error } of failures) {
    const category = categorizeSyncFailure(error);
    categories.set(category, (categories.get(category) ?? 0) + 1);
  }
  console.warn(`[sync-daily] 未完分類: ${JSON.stringify(Object.fromEntries(categories))} ` +
    "(source_unavailableは売買なし未確認、history_holdは長期指標保留。通信・保存障害と区別)");
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
  // 必須設定はsource取得より前に検証。JP原本の持越しは既存R2 bucketへ日付別1object。
  sharedEnv.R2_ACCOUNT_ID();
  sharedEnv.R2_ACCESS_KEY_ID();
  sharedEnv.R2_SECRET_ACCESS_KEY();
  sharedEnv.R2_BUCKET();
  const jpLegStore: MacroJpLegStore = { get: r2GetVersion, put: r2Put };
  const db = createDailyDb();
  if (args[0] === "--context-only") {
    if (!await runMarketContextSync(db, jpLegStore)) throw new Error("マクロ同期が不完全です");
    console.info("[sync-context] 完了 (株式全量同期は対象外)");
    return;
  }
  let restore: (() => void) | undefined;
  const scheduled = sharedEnv.STOCK_SYNC_TARGET() === "scheduled-stocks";
  const jobStartedAt = sharedEnv.BATCH_JOB_STARTED_AT();
  if (scheduled || jobStartedAt !== undefined) {
    const date = scheduled ? sharedEnv.SCHEDULED_DATE() : stockSyncRunDate(Date.now());
    if (date === undefined) throw new Error("定時株式にはSCHEDULED_DATEが必須です");
    if (scheduled) assertStockSyncStart(scheduledAtForDate(sharedEnv.SCHEDULED_AT(), date, Date.now()), date);
    const { deadline } = stockSyncExecutionWindow(date, scheduled, Date.now(), jobStartedAt);
    restore = installStockSyncDeadline(date, { scheduled, jobStartedAt });
    const assertActive = () => {
      assertStockSyncDeadline(date, Date.now(), scheduled);
      if (Date.now() >= deadline) throw new Error("株式jobの原本閉鎖期限です（未完・再送なし）");
    };
    jpLegStore.get = key => {
      assertActive();
      return r2GetVersion(key, { singleAttempt: true, beforeAttempt: assertActive,
        abortSignal: AbortSignal.timeout(deadline - Date.now()) });
    };
    jpLegStore.put = (key, body, version) => { assertActive(); return r2Put(key, body, version); };
  }
  let result;
  try { result = await runDailySync(db, { stocksOnly: true, jpLegStore }); }
  finally { restore?.(); }

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

main().finally(() => console.info(JSON.stringify({ notionStats: notionStats(), phase: "stock-or-context" }))).catch((e) => {
  console.error("[sync-daily] エラー:", rootCauseMessage(e));
  process.exit(1);
});
