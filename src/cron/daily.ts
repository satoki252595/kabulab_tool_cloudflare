/**
 * 日次 sync オーケストレータ（Node / GitHub Actions 実行・ADR-0001）
 *
 * 3 サービス (001 RSI / 002 otakara / 003 swing) が必要とする日次データを 1 本の
 * 統一フローで取得・計算・書き込む。
 *
 * 実行形態（Workers Paid を使わない運用）:
 *   - **Node で実行**（GitHub Actions / ローカル CLI）。D1 へは `createD1HttpDb`
 *     (sqlite-proxy → D1 REST) で直接書き込む。
 *   - Yahoo は共有クライアントが `YAHOO_PROXY_BASE`（Cloudflare エッジの
 *     `/api/ingest/yahoo`）経由で叩くため、自宅/CI IP の 429 を回避する。
 *   - 起動: `pnpm sync:daily:core`（scripts/sync/daily.ts）/ GitHub Actions。
 *
 * フロー（母集団同期 Phase 0 は除外）:
 *   Phase 1. ブートストラップ: core_stocks のアクティブ銘柄を取得 + 既存 OHLCV の
 *            MAX(date) を読む（増分判定用）
 *   Phase 2. マクロコンテキスト (^N225 / ^VIX / ^GSPC / NIY=F + 日経VI)
 *   Phase 3. worker pool で各銘柄: Chart(5y)+QuoteSummary 取得 → 全指標を計算 →
 *            core_financials / rsi_percentile / swing_* を **増分** upsert
 *   Phase 4. swing_daily_ohlcv の保持期間 prune（全銘柄を一括。書き込み経路から
 *            独立させてあるので、同期が止まった銘柄でも保持本数が効く）
 *   Phase 5. セクター集計（当日更新済 indicators から集計・90% カバレッジ guard）
 *
 * 母集団 (core_stocks) の JPX 同期は xlsx パーサが Node 専用のため
 * `pnpm sync:universe`（src/cron/universe.ts）で別途同期する。
 *
 * D1 書込コスト対策: OHLCV は「既存 MAX(date) より新しい bar のみ」を増分 upsert
 * する。初回(空)は全 6mo backfill、以降は当日分 1〜2 行のみ。全銘柄日次の
 * rows-written を ~52 万 → ~3 万/日 に抑え D1 無料枠 (10 万/日) 内に収める。
 *
 * CLAUDE.md のフォールバック禁止ルールに従い:
 *   - Yahoo の取得失敗は failure として明示し、上場状態は変更しない
 *   - is_active の所有者は JPX 公式一覧を読む universe sync に限定する
 *   - 日経VI 取得失敗は judgeMacro() が HOLD を返すので B/C 判定に変えない
 *   - マクロ 4 指数のどれかが取れない場合も null で通す
 */

import { sql, asc, eq, and, gt, gte, isNotNull, lte } from "drizzle-orm";
import { createD1HttpDb } from "../shared/db/d1-http-client.js";

// core スキーマは rsi-screening の定義を流用 (001 が所有・更新)
import * as coreSchema from "../../services/rsi-screening/src/db/core-schema.js";
// rsi スキーマ
import * as rsiSchema from "../../services/rsi-screening/src/db/schema.js";
// swing スキーマ
import * as swingSchema from "../../services/swing-trading/src/db/schema.js";
// L2 投影 (p_*)。writer はこの cron だけ。
import * as projectionSchema from "../shared/db/projection-schema.js";
import { encodeCloses } from "../shared/indicators/momentum-series.js";

import {
  fetchChart,
  fetchStockRawData,
} from "../shared/yahoo/client.js";
import { fetchNikkeiVi } from "../shared/yahoo/nikkei-vi.js";
import { calculateAllRsiSeries } from "../shared/indicators/rsi.js";
import { computeRsiPercentileSnapshot } from "../shared/indicators/percentile.js";
import { evaluateBlueChip } from "../shared/indicators/blue-chip.js";
import {
  sma,
  atr14,
  rsi14,
  macd as calcMacd,
  rangeAndFib,
  avgTurnover,
  avgVolume,
  volumeRatio,
  pctChange1d,
} from "../shared/indicators/technical.js";
import { screenStock } from "../shared/screener.js";
import { detectAllPatterns, type IndicatorSnapshot } from "../shared/patterns.js";
import { judgeMacro } from "../shared/macro.js";
import {
  aggregateSectors,
  type StockChangeInput,
} from "../shared/sector-aggregate.js";
import type { DailyOhlcv } from "../shared/types.js";
import { rootCauseMessage } from "../shared/errors.js";

// -----------------------------------------------------------------------------
// 型定義
// -----------------------------------------------------------------------------

// createD1HttpDb は core_* を自動登録するので rsi/swing/p_* スキーマのみ渡す。
const SCHEMAS = { ...rsiSchema, ...swingSchema, ...projectionSchema };
type Db = ReturnType<typeof createDailyDb>;

/** 日次 sync の結果サマリ */
export interface DailySyncResult {
  totalStocks: number;
  successStocks: number;
  failedStocks: number;
  marketContextOk: boolean;
  elapsedSec: number;
  failures: { code: string; error: string }[];
}

/** 銘柄ごとの処理結果 (in-memory) */
interface StockSnapshot {
  stockId: number;
  code: string;
  sector: string | null;

  // 生データ
  latestClose: number | null;
  latestOpen: number | null;
  latestHigh: number | null;
  latestLow: number | null;
  latestVolume: number | null;
  latestDate: string;
  previousClose: number | null;

  // ファンダ (QuoteSummary)
  price: number | null;
  per: number | null;
  pbr: number | null;
  dividendYield: number | null;
  eps: number | null;
  bps: number | null;
  roe: number | null;
  roa: number | null;
  marketCap: number | null;
  operatingMarginTtm: number | null;
  dataDate: string;
  annualFinancials: { fiscalYear: number; revenue: number | null }[];

  // RSI (rsi-screening 用)
  rsiPercentile: {
    rsi10: number | null;
    rsi10Percentile: number | null;
    rsi40: number | null;
    rsi40Percentile: number | null;
    rsi120: number | null;
    rsi120Percentile: number | null;
    rsiMinPercentile: number | null;
    /** パーセンタイル母集団に使った終値の本数 (UI の「母数 N」) */
    sampleBars: number;
  };
  blueChip: {
    isBlueChip: boolean;
    operatingMarginTtm: number | null;
    revenueTrend: number | null;
  };

  // テクニカル (swing-trading / otakara-yutai 用)
  sma5: number | null;
  sma20: number | null;
  sma25: number | null;
  sma60: number | null;
  sma75: number | null;
  atr14: number | null;
  atrPct: number | null; // %
  rsi14: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHist: number | null;
  range20dHigh: number | null;
  range20dLow: number | null;
  rangeWidth: number | null;
  fib382: number | null;
  fib500: number | null;
  fib618: number | null;
  avgTurnover20d: number | null;
  volume20d: number | null;
  volumeRatio: number | null;
  pctChange1d: number | null;
  trendLong: boolean;
  trendShort: boolean;
  perfectOrderLong: boolean;
  perfectOrderShort: boolean;

  // 6mo スライス (entry signal 用)
  ohlcv6mo: DailyOhlcv[];
}

// -----------------------------------------------------------------------------
// 定数
// -----------------------------------------------------------------------------

/** ワーカー並列度 (Yahoo はエッジプロキシ経由でも upstream 制限に配慮) */
const CONCURRENCY = 5;
/** ワーカー間隔 (ms) */
const DELAY_MS = 150;
/** 5 worker の既存待機量を均した、銘柄開始の最小間隔。 */
const STOCK_START_INTERVAL_MS = DELAY_MS / CONCURRENCY;
/** 90 分の Actions 上限内で最終集約まで完了させる回復件数上限。 */
const MAX_RECOVERY_TARGETS = 100;
/** upstream 指示や診断文字列が異常でも回復待機を30秒で止める。 */
const MAX_RECOVERY_BACKOFF_MS = 30_000;
const MARKET_CONTEXT_CHART_SYMBOLS = [
  "^N225",
  "^VIX",
  "^GSPC",
  "NIY=F",
] as const;
const NIKKEI_VI_TARGET = "NIKKEI_VI" as const;
type MarketContextChartSymbol = (typeof MARKET_CONTEXT_CHART_SYMBOLS)[number];
type MarketContextTarget =
  | MarketContextChartSymbol
  | typeof NIKKEI_VI_TARGET;
interface MarketContextChartValue {
  price: number | null;
  prevClose: number | null;
}
interface MarketContextDraft {
  charts: Record<MarketContextChartSymbol, MarketContextChartValue>;
  nikkeiVi: number | null;
}
/**
 * swing_daily_ohlcv の保持本数 (営業日相当)。増分 upsert と併せて書込/容量を抑える。
 * 適用は Phase 4 の一括 sweep (pruneOhlcvRetention) — 書き込み経路では行わない。
 */
const OHLCV_RETENTION_DAYS = 90;
/** OHLCV insert の D1 bind 上限対策 (adj 追加で 8 列になったので 12 行/文: 8×12=96≤100) */
const OHLCV_CHUNK = 12;
/** sector_daily insert の bind 上限対策 (6 列なので 16 行/文) */
const SECTOR_CHUNK = 16;
/** prune の DELETE 1 文に載せる stock_id 数 (bind 上限 100: ids + retention で余裕を取る) */
const OHLCV_PRUNE_ID_CHUNK = 50;
// -----------------------------------------------------------------------------
// エントリポイント
// -----------------------------------------------------------------------------

/**
 * Node から D1 へ書き込む Drizzle クライアントを作成する (取込専用 HTTP)。
 * createD1HttpDb が CLOUDFLARE_* env (型付きアクセサ) を内部で解決する。
 */
export function createDailyDb() {
  return createD1HttpDb(SCHEMAS);
}

/** 成功件数が残っていても、欠損を含む run は監視上の失敗として扱う。 */
export function isDailySyncIncomplete(
  result: Pick<
    DailySyncResult,
    "totalStocks" | "successStocks" | "failedStocks" | "marketContextOk"
  >
): boolean {
  return (
    result.totalStocks === 0 ||
    result.successStocks + result.failedStocks !== result.totalStocks ||
    result.failedStocks > 0 ||
    !result.marketContextOk
  );
}

export interface DailyRecoveryFailure<T> {
  target: T;
  error: string;
}

export interface DailyRecoveryResult<T> {
  attempted: number;
  recovered: number;
  skippedDueToLimit: number;
  failures: DailyRecoveryFailure<T>[];
}

export type PrioritizedDailyRecoveryTarget<MacroTarget, StockTarget> =
  | { kind: "macro"; target: MacroTarget }
  | { kind: "stock"; target: StockTarget };

/**
 * 銘柄開始を平準化し、最初の429の Retry-After 中は未実行銘柄を止める。
 * run 内の数値だけを共有し、外部 call、retry、30秒超の待機は増やさない。
 */
export function createDailyStockStartGate(startIntervalMs: number) {
  let nextStartAt = 0;
  let backoffUntil = 0;
  let rateLimitObserved = false;

  return {
    async wait(): Promise<void> {
      while (true) {
        const now = Date.now();
        const startAt = Math.max(now, nextStartAt, backoffUntil);
        nextStartAt = startAt + startIntervalMs;
        if (startAt <= now) return;
        await sleep(startAt - now);
        if (backoffUntil <= startAt) return;
      }
    },
    observeFailure(message: string): void {
      if (rateLimitObserved) return;
      if (
        !/^(?:Chart|QuoteSummary) API HTTP エラー \[[^\]]+\]: 429\b/.test(
          message
        )
      ) {
        return;
      }
      const requested = Number(/\bretry-at-ms=(\d+)\b/.exec(message)?.[1]);
      if (!Number.isFinite(requested)) return;
      rateLimitObserved = true;
      backoffUntil = Math.min(
        requested,
        Date.now() + MAX_RECOVERY_BACKOFF_MS
      );
    },
  };
}

/** macro を先頭にして、両系統を同じ回収件数上限へ流す。 */
export function prioritizeDailyRecoveryFailures<MacroTarget, StockTarget>(
  macroFailures: readonly DailyRecoveryFailure<MacroTarget>[],
  stockFailures: readonly DailyRecoveryFailure<StockTarget>[]
): DailyRecoveryFailure<
  PrioritizedDailyRecoveryTarget<MacroTarget, StockTarget>
>[] {
  return [
    ...macroFailures.map(({ target, error }) => ({
      target: { kind: "macro" as const, target },
      error,
    })),
    ...stockFailures.map(({ target, error }) => ({
      target: { kind: "stock" as const, target },
      error,
    })),
  ];
}

/** 取得元の429/5xx、D1の5xx、ネットワーク障害だけを回収対象にする。 */
export function isTransientDailySyncFailure(message: string): boolean {
  return (
    /^(?:(?:Chart|QuoteSummary) API HTTP エラー \[[^\]]+\]|Yahoo crumb HTTP エラー): (?:429|5\d{2})\b/.test(message) ||
    /^Nikkei smartchart HTTP エラー: (?:429|5\d{2})\b/.test(message) ||
    /^D1 HTTP 5\d{2}\b/.test(message) ||
    /D1 HTTP error:.*"message":"internal error; reference =/i.test(message) ||
    /\b(?:fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_SOCKET|socket hang up|other side closed|terminated)\b/i.test(
      message
    )
  );
}

/**
 * 初回バッチ完走後、一過性失敗だけを逐次 1 回再処理する。
 * 永続エラーは再試行せず、再処理にも失敗した対象は最新原因を返す。
 */
export async function recoverTransientDailyFailures<T>(
  failures: readonly DailyRecoveryFailure<T>[],
  processTarget: (target: T) => Promise<void>
): Promise<DailyRecoveryResult<T>> {
  const unresolved: DailyRecoveryFailure<T>[] = [];
  let attempted = 0;
  let recovered = 0;
  let skippedDueToLimit = 0;
  const requestedRetryAt = Math.max(
    0,
    ...failures
      .filter(({ error }) => isTransientDailySyncFailure(error))
      .map(
        ({ error }) => Number(/\bretry-at-ms=(\d+)\b/.exec(error)?.[1]) || 0
      )
  );
  const retryAt = Math.min(
    requestedRetryAt,
    Date.now() + MAX_RECOVERY_BACKOFF_MS
  );
  if (retryAt > Date.now()) await sleep(retryAt - Date.now());

  for (const failure of failures) {
    if (!isTransientDailySyncFailure(failure.error)) {
      unresolved.push(failure);
      continue;
    }
    if (attempted >= MAX_RECOVERY_TARGETS) {
      unresolved.push(failure);
      skippedDueToLimit++;
      continue;
    }
    attempted++;
    try {
      await processTarget(failure.target);
      recovered++;
    } catch (error) {
      unresolved.push({
        target: failure.target,
        error: rootCauseMessage(error),
      });
    }
    await sleep(DELAY_MS);
  }

  return {
    attempted,
    recovered,
    skippedDueToLimit,
    failures: unresolved,
  };
}

/**
 * コードが要求する D1 スキーマを、数千銘柄の取得を始める前に検証する。
 *
 * 2026-06-29〜07-27 は `adj` 追加 migration が本番未適用のままコードだけ先行し、
 * 毎回ほぼ全銘柄が15分後に失敗した。存在列を SELECT することで同種の適用漏れを
 * 即時かつ具体的に検出する。
 *
 * ここで見ている列は `swing_daily_ohlcv.adj` と
 * `rsi_percentile.percentile_sample_bars` の 2 本だけで、どちらも
 * `WriteStockSnapshotOptions` のフラグとは無関係に毎回書かれる。②断面
 * (`core_stock_financials`) を止めてもこの検証の前提は変わらない。逆に、
 * フラグで止まりうる列をここへ足すと「書かないのに検証だけ落ちる」になるので、
 * 足すときは無条件に書かれる列かを先に確かめること。
 */
export async function assertDailySchema(db: Db): Promise<void> {
  try {
    await db
      .select({ adj: swingSchema.dailyOhlcv.adj })
      .from(swingSchema.dailyOhlcv)
      .limit(1);
  } catch (error) {
    throw new Error(
      "D1 スキーマ不整合: swing_daily_ohlcv.adj を確認できません。" +
        " drizzle/d1/0008_young_ben_urich.sql の本番適用状態を確認してください。",
      { cause: error }
    );
  }
  // percentile_sample_bars は全銘柄の rsi_percentile upsert が値を載せる列。
  // 0009 が未適用のままコードだけ先行すると、adj のとき (2026-06-29〜07-27) と
  // 同じ「3,700 銘柄を取得し終えた頃に全件が書込で落ちる」状態になるので、
  // 取得を始める前に 1 SELECT で確かめる。
  try {
    await db
      .select({ bars: rsiSchema.stockRsiPercentile.percentileSampleBars })
      .from(rsiSchema.stockRsiPercentile)
      .limit(1);
  } catch (error) {
    throw new Error(
      "D1 スキーマ不整合: rsi_percentile.percentile_sample_bars を確認できません。" +
        " drizzle/d1/0009_natural_loners.sql の本番適用状態を確認してください。",
      { cause: error }
    );
  }
  // p_momentum は Phase 6 が**無条件に**全銘柄ぶん書き直す投影表。
  // フラグで止まる経路には無いので、この検証の前提 (「書かないのに検証だけ落ちる」
  // にならない) を満たす。未適用のまま走ると 3,700 銘柄を取り終えた後の
  // Phase 6 で全件が書込で落ちる — adj (2026-06-29〜07-27) と同じ失敗の形になる。
  try {
    await db
      .select({ closes: projectionSchema.momentumProjection.closes })
      .from(projectionSchema.momentumProjection)
      .limit(1);
  } catch (error) {
    throw new Error(
      "D1 スキーマ不整合: p_momentum.closes を確認できません。" +
        " drizzle/d1/0011_clean_iron_fist.sql の本番適用状態を確認してください。",
      { cause: error }
    );
  }
}

/**
 * 日次 sync 本体
 *
 * @param db createDailyDb() の戻り (Node→D1 HTTP)
 */
export async function runDailySync(db: Db): Promise<DailySyncResult> {
  const startedAt = Date.now();

  // -----------------------------------------------------------------
  // Phase 1: スキーマ検証 + アクティブ銘柄取得 + 既存 OHLCV の MAX(date)
  // -----------------------------------------------------------------
  console.info("[sync-daily] Phase 1: ブートストラップ");
  await assertDailySchema(db);
  const targets = await db
    .select({
      id: coreSchema.stocks.id,
      code: coreSchema.stocks.code,
      sector: coreSchema.stocks.sector,
    })
    .from(coreSchema.stocks)
    .where(eq(coreSchema.stocks.isActive, true));
  console.info(`[sync-daily]   対象: ${targets.length} 銘柄`);

  // 各銘柄の既存 MAX(date) を 1 クエリで取得 (bind 不要)。null/未登録は初回 backfill。
  const maxDateRows = await db
    .select({
      stockId: swingSchema.dailyOhlcv.stockId,
      maxDate: sql<string>`MAX(${swingSchema.dailyOhlcv.date})`,
    })
    .from(swingSchema.dailyOhlcv)
    .groupBy(swingSchema.dailyOhlcv.stockId);
  const maxDateByStock = new Map<number, string>(
    maxDateRows.map((r) => [r.stockId, r.maxDate])
  );

  // -----------------------------------------------------------------
  // Phase 2: マクロコンテキスト
  // -----------------------------------------------------------------
  console.info("[sync-daily] Phase 2: マクロコンテキスト取得");
  const marketContext = await fetchMarketContextDraft();
  const deferMarketContextPersistence = marketContext.failures.some(
    ({ error }) => isTransientDailySyncFailure(error)
  );
  let marketContextOk: boolean | undefined;
  if (!deferMarketContextPersistence) {
    marketContextOk = await persistMarketContextWithDiagnostics(
      db,
      marketContext.draft
    );
  }

  // -----------------------------------------------------------------
  // Phase 3: 銘柄ごとのフェッチ + 計算 + DB 書き込み (worker pool)
  // -----------------------------------------------------------------
  console.info("[sync-daily] Phase 3: 銘柄フェッチ + 計算 + 書き込み");
  const queue = [...targets];
  const firstPassFailures: DailyRecoveryFailure<(typeof targets)[number]>[] =
    [];
  const stockStartGate = createDailyStockStartGate(STOCK_START_INTERVAL_MS);
  let succeeded = 0;

  async function processTarget(
    target: (typeof targets)[number]
  ): Promise<void> {
    await stockStartGate.wait();
    const snap = await buildSnapshot(target.id, target.code, target.sector);
    await writeStockSnapshot(db, snap, maxDateByStock.get(target.id));
  }

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const target = queue.shift();
      if (!target) break;
      try {
        await processTarget(target);
        succeeded++;
      } catch (e) {
        const msg = rootCauseMessage(e);
        stockStartGate.observeFailure(msg);
        firstPassFailures.push({ target, error: msg });
      }
      await sleep(DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.info(
    `[sync-daily]   初回成功: ${succeeded} / 初回失敗: ${firstPassFailures.length}`
  );

  const recoveryTargets = prioritizeDailyRecoveryFailures(
    marketContext.failures,
    firstPassFailures
  );
  let recoveredStocks = 0;
  const recovery = await recoverTransientDailyFailures(
    recoveryTargets,
    async (recoveryTarget) => {
      if (recoveryTarget.kind === "macro") {
        await fetchMarketContextTarget(
          marketContext.draft,
          recoveryTarget.target
        );
        return;
      }
      await processTarget(recoveryTarget.target);
      recoveredStocks++;
    }
  );
  succeeded += recoveredStocks;
  const recoveredMacros = recovery.recovered - recoveredStocks;
  if (recovery.attempted > 0 || recovery.skippedDueToLimit > 0) {
    console.info(
      `[sync-daily]   一過性失敗の回収: 実行=${recovery.attempted} ` +
        `回復=${recovery.recovered} (macro=${recoveredMacros}, stock=${recoveredStocks}) ` +
        `未回復=${recovery.attempted - recovery.recovered + recovery.skippedDueToLimit} ` +
        `上限超過=${recovery.skippedDueToLimit}`
    );
  }
  const failures: DailySyncResult["failures"] = [];
  for (const failure of recovery.failures) {
    if (failure.target.kind === "macro") {
      console.warn(
        `[sync-daily]   マクロ未回復 ${failure.target.target}:`,
        failure.error
      );
    } else {
      failures.push({
        code: failure.target.target.code,
        error: failure.error,
      });
    }
  }

  if (marketContextOk === undefined) {
    marketContextOk = await persistMarketContextWithDiagnostics(
      db,
      marketContext.draft
    );
  }

  // -----------------------------------------------------------------
  // Phase 4: OHLCV 保持期間の一括 prune (同期が止まった銘柄も対象)
  // -----------------------------------------------------------------
  console.info("[sync-daily] Phase 4: OHLCV 保持期間の prune");
  const pruned = await pruneOhlcvRetention(db);
  if (pruned.prunedStocks > 0) {
    console.info(
      `[sync-daily]   保持本数超過: ${pruned.prunedStocks} 銘柄 / ` +
        `削除 ${pruned.deletedRows} 行 (保持 ${OHLCV_RETENTION_DAYS} 本)`
    );
  } else {
    console.info(
      `[sync-daily]   保持本数超過なし (保持 ${OHLCV_RETENTION_DAYS} 本)`
    );
  }

  // -----------------------------------------------------------------
  // Phase 5: セクター集計 (当日更新済 indicators から・90% カバレッジ guard)
  // -----------------------------------------------------------------
  console.info("[sync-daily] Phase 5: セクター集計");
  const [{ activeCount }] = await db
    .select({ activeCount: sql<number>`count(*)` })
    .from(coreSchema.stocks)
    .where(eq(coreSchema.stocks.isActive, true));

  const indicatorRows = await db
    .select({
      sector: coreSchema.stocks.sector,
      pct1d: swingSchema.stockIndicators.pctChange1d,
    })
    .from(coreSchema.stocks)
    .innerJoin(
      swingSchema.stockIndicators,
      eq(swingSchema.stockIndicators.stockId, coreSchema.stocks.id)
    )
    .where(
      and(
        eq(coreSchema.stocks.isActive, true),
        // D1/SQLite: computed_at は epoch 秒。本日(UTC)0 時の epoch と比較。
        gte(
          swingSchema.stockIndicators.computedAt,
          sql`unixepoch('now','start of day')`
        )
      )
    );

  const coverage = activeCount > 0 ? indicatorRows.length / activeCount : 0;
  if (coverage < 0.9) {
    console.warn(
      `[sync-daily]   セクター集計スキップ: 本日更新 ${indicatorRows.length}/${activeCount} ` +
        `(${(coverage * 100).toFixed(1)}%) が閾値 90% 未満 (大量失敗の可能性)。` +
        `sector_daily は前回値を保持します。`
    );
  } else {
    const sectorAggs = aggregateSectors(
      indicatorRows.map(
        (r): StockChangeInput => ({
          sector: r.sector,
          pct1d: r.pct1d,
          pct5d: null,
        })
      )
    );
    const today = new Date().toISOString().split("T")[0];
    await db
      .delete(swingSchema.sectorDaily)
      .where(eq(swingSchema.sectorDaily.date, today));
    for (let i = 0; i < sectorAggs.length; i += SECTOR_CHUNK) {
      await db.insert(swingSchema.sectorDaily).values(
        sectorAggs.slice(i, i + SECTOR_CHUNK).map((a) => ({
          date: today,
          sector: a.sector,
          pct1d: a.pct1d,
          pct5d: a.pct5d,
          stockCount: a.stockCount,
          rank1d: a.rank1d,
        }))
      );
    }
  }

  // -----------------------------------------------------------------
  // Phase 6: L2 投影 (p_momentum) の再生成
  //
  // prune の後に置く (投影の本数を D1 の実在本数と一致させるため)。
  // ここで失敗したら run 全体を失敗にする。投影が書けていないまま緑にすると、
  // /emh は前日の as_of を表示し続けるのに監視上は成功に見える。
  // -----------------------------------------------------------------
  console.info("[sync-daily] Phase 6: モメンタム投影の再生成");
  const projected = await rebuildMomentumProjection(db);
  console.info(
    `[sync-daily]   投影 ${projected.projectedStocks} 行 (走査 ${projected.scannedBars} 行 / ` +
      `as_of ${projected.sourceMaxDate ?? "—"} / 掃除 ${projected.removedStocks} 行)`
  );

  const elapsedSec = (Date.now() - startedAt) / 1000;
  console.info(
    `[sync-daily] 完了: 成功=${succeeded} 失敗=${failures.length} 所要=${elapsedSec.toFixed(1)}s`
  );

  return {
    totalStocks: targets.length,
    successStocks: succeeded,
    failedStocks: failures.length,
    marketContextOk,
    elapsedSec,
    failures,
  };
}

// -----------------------------------------------------------------------------
// 銘柄ごとの snapshot 構築 (純計算)
// -----------------------------------------------------------------------------

async function buildSnapshot(
  stockId: number,
  code: string,
  sector: string | null
): Promise<StockSnapshot> {
  // 1 回の Chart(5y) + QuoteSummary で全指標を賄う
  const raw = await fetchStockRawData(code, "5y");

  // -- RSI 時系列 (5y 全量) → percentile —— adjclose ベースで分割歪みを除去 --
  //
  // ここで null を落とすのは、RSI が「欠損なしの終値列」を要求するため
  // (calculateRsiSeries の前提)。ただし落とした分は日付の穴として残らず
  // **欠損日を無言で詰めて母集団を縮める**ので、何本で算出したのかを
  // rsiPercentile.sampleBars として持ち UI (母数 N) まで運ぶ。
  // 「5 年」は名前であって保証ではない: 実測で最短 461 本 (≒1.9 年) の銘柄がある。
  const closes5y = raw.ohlcv
    .map((r) => r.adj ?? r.close)
    .filter((c): c is number => c !== null);
  const rsiSeries = calculateAllRsiSeries(closes5y);
  const rsiPercentile = computeRsiPercentileSnapshot(rsiSeries);
  const blueChip = evaluateBlueChip(raw.annualFinancials, raw.operatingMarginTtm);

  // -- 6mo スライス → swing 用指標 —— adjclose ベースで分割歪みを除去 --
  const ohlcv6mo = raw.ohlcv.slice(-130);
  const closes6mo = ohlcv6mo.map((r) => r.adj ?? r.close);

  const sma5Val = sma(closes6mo, 5);
  const sma20Val = sma(closes6mo, 20);
  const sma25Val = sma(closes6mo, 25);
  const sma60Val = sma(closes6mo, 60);
  const sma75Val = sma(closes6mo, 75);
  const atr = atr14(ohlcv6mo);
  const latestRow = ohlcv6mo[ohlcv6mo.length - 1];
  const latestClose = latestRow?.close ?? null;
  const atrPctRatio =
    atr !== null && latestClose !== null && latestClose > 0
      ? atr / latestClose
      : null;
  const atrPct = atrPctRatio !== null ? atrPctRatio * 100 : null;
  const rsiVal = rsi14(closes6mo);
  const macdResult = calcMacd(closes6mo);
  const range = rangeAndFib(ohlcv6mo, 20);
  const turnover = avgTurnover(ohlcv6mo, 20);
  const vol20 = avgVolume(ohlcv6mo, 20);
  const volRatio = volumeRatio(ohlcv6mo, 20);
  const pct1d = pctChange1d(ohlcv6mo);

  const trendLong =
    sma5Val !== null &&
    sma20Val !== null &&
    latestClose !== null &&
    sma5Val > sma20Val &&
    latestClose > sma5Val;
  const trendShort =
    sma5Val !== null &&
    sma20Val !== null &&
    latestClose !== null &&
    sma5Val < sma20Val &&
    latestClose < sma5Val;
  const perfectOrderLong =
    sma5Val !== null &&
    sma20Val !== null &&
    sma60Val !== null &&
    sma5Val > sma20Val &&
    sma20Val > sma60Val;
  const perfectOrderShort =
    sma5Val !== null &&
    sma20Val !== null &&
    sma60Val !== null &&
    sma5Val < sma20Val &&
    sma20Val < sma60Val;

  return {
    stockId,
    code,
    sector,
    latestClose,
    latestOpen: latestRow?.open ?? null,
    latestHigh: latestRow?.high ?? null,
    latestLow: latestRow?.low ?? null,
    latestVolume: latestRow?.volume ?? null,
    latestDate: latestRow?.date ?? raw.dataDate,
    previousClose:
      ohlcv6mo.length >= 2
        ? (ohlcv6mo[ohlcv6mo.length - 2].close ?? null)
        : null,
    price: raw.price,
    per: raw.per,
    pbr: raw.pbr,
    dividendYield: raw.dividendYield,
    eps: raw.eps,
    bps: raw.bps,
    roe: raw.roe,
    roa: raw.roa,
    marketCap: raw.marketCap,
    operatingMarginTtm: raw.operatingMarginTtm,
    dataDate: raw.dataDate,
    annualFinancials: raw.annualFinancials,
    rsiPercentile,
    blueChip,
    sma5: sma5Val,
    sma20: sma20Val,
    sma25: sma25Val,
    sma60: sma60Val,
    sma75: sma75Val,
    atr14: atr,
    atrPct,
    rsi14: rsiVal,
    macd: macdResult.macd,
    macdSignal: macdResult.signal,
    macdHist: macdResult.hist,
    range20dHigh: range.high,
    range20dLow: range.low,
    rangeWidth: range.width,
    fib382: range.fib382,
    fib500: range.fib500,
    fib618: range.fib618,
    avgTurnover20d: turnover,
    volume20d: vol20,
    volumeRatio: volRatio,
    pctChange1d: pct1d,
    trendLong,
    trendShort,
    perfectOrderLong,
    perfectOrderShort,
    ohlcv6mo,
  };
}

// -----------------------------------------------------------------------------
// 銘柄ごとの DB 書き込み (Node→D1 HTTP・逐次・増分 OHLCV)
//
// createD1HttpDb (sqlite-proxy) は db.batch/トランザクション非対応のため逐次 await。
// 各 upsert は冪等なので途中失敗しても次回実行が回収する。
// -----------------------------------------------------------------------------

/**
 * `writeStockSnapshot` の書き込み範囲スイッチ。
 *
 * 移行 P5-b で ②断面 (`core_stock_financials`) の writer が stockStock 側へ移る。
 * 両者が同じ 1 行 (stock_id ユニーク) を upsert すると、残る値は実行順で決まり、
 * `fetched_at` と値の組が壊れる（新しい fetched_at に古い価格が乗る）。切替当日に
 * daily.ts のコードを削るのではなく、**呼び出し側で止められる**形にしておく。
 */
export interface WriteStockSnapshotOptions {
  /**
   * ②断面 (`core_stock_financials`) を書くか。既定 true = 従来どおり書く。
   *
   * 年次 (`core_stock_annual_financials`) はこのフラグの対象外。年次は Yahoo の
   * annualFinancials が唯一の出所で P5-b の移行対象に入っていないため、ここで
   * 一緒に止めると「フラグを立てた瞬間に売上推移が止まる」副作用になる。
   */
  writeCoreFinancials?: boolean;
}

// export しているのは src/cron/daily-write-snapshot.test.ts から
// フラグの両分岐を直接叩くため。呼び出し元は runDailySync 内の 1 箇所だけ。
export async function writeStockSnapshot(
  db: Db,
  snap: StockSnapshot,
  existingMaxDate: string | undefined,
  options: WriteStockSnapshotOptions = {}
): Promise<void> {
  const { writeCoreFinancials = true } = options;

  // --- core_stock_annual_financials ---
  if (snap.annualFinancials.length > 0) {
    await db
      .insert(coreSchema.stockAnnualFinancials)
      .values(
        snap.annualFinancials.map((f) => ({
          stockId: snap.stockId,
          fiscalYear: f.fiscalYear,
          revenue: f.revenue,
        }))
      )
      .onConflictDoUpdate({
        target: [
          coreSchema.stockAnnualFinancials.stockId,
          coreSchema.stockAnnualFinancials.fiscalYear,
        ],
        set: { revenue: sql`excluded.revenue` },
      });
  }

  // --- core_stock_financials (②断面) ---
  // 囲むのはこの upsert だけ。上の年次と下の rsi_percentile 以降は
  // writer 移行の対象外なので、フラグを立てても従来どおり書き続ける。
  if (writeCoreFinancials) {
    await db
      .insert(coreSchema.stockFinancials)
      .values({
        stockId: snap.stockId,
        price: snap.price,
        per: snap.per,
        pbr: snap.pbr,
        dividendYield: snap.dividendYield,
        eps: snap.eps,
        bps: snap.bps,
        roe: snap.roe,
        roa: snap.roa,
        marketCap: snap.marketCap,
        operatingMargin: snap.operatingMarginTtm,
        dataDate: snap.dataDate,
      })
      .onConflictDoUpdate({
        target: coreSchema.stockFinancials.stockId,
        set: {
          price: sql`excluded.price`,
          per: sql`excluded.per`,
          pbr: sql`excluded.pbr`,
          dividendYield: sql`excluded.dividend_yield`,
          eps: sql`excluded.eps`,
          bps: sql`excluded.bps`,
          roe: sql`excluded.roe`,
          roa: sql`excluded.roa`,
          marketCap: sql`excluded.market_cap`,
          operatingMargin: sql`excluded.operating_margin`,
          dataDate: sql`excluded.data_date`,
          fetchedAt: sql`(unixepoch())`,
        },
      });
  }

  // --- rsi_percentile ---
  await db
    .insert(rsiSchema.stockRsiPercentile)
    .values({
      stockId: snap.stockId,
      rsi10: snap.rsiPercentile.rsi10,
      rsi10Percentile: snap.rsiPercentile.rsi10Percentile,
      rsi40: snap.rsiPercentile.rsi40,
      rsi40Percentile: snap.rsiPercentile.rsi40Percentile,
      rsi120: snap.rsiPercentile.rsi120,
      rsi120Percentile: snap.rsiPercentile.rsi120Percentile,
      rsiMinPercentile: snap.rsiPercentile.rsiMinPercentile,
      percentileSampleBars: snap.rsiPercentile.sampleBars,
      isBlueChip: snap.blueChip.isBlueChip,
      operatingMarginTtm: snap.blueChip.operatingMarginTtm,
      revenueTrend: snap.blueChip.revenueTrend,
    })
    .onConflictDoUpdate({
      target: rsiSchema.stockRsiPercentile.stockId,
      set: {
        rsi10: sql`excluded.rsi_10`,
        rsi10Percentile: sql`excluded.rsi_10_percentile`,
        rsi40: sql`excluded.rsi_40`,
        rsi40Percentile: sql`excluded.rsi_40_percentile`,
        rsi120: sql`excluded.rsi_120`,
        rsi120Percentile: sql`excluded.rsi_120_percentile`,
        rsiMinPercentile: sql`excluded.rsi_min_percentile`,
        percentileSampleBars: sql`excluded.percentile_sample_bars`,
        isBlueChip: sql`excluded.is_blue_chip`,
        operatingMarginTtm: sql`excluded.operating_margin_ttm`,
        revenueTrend: sql`excluded.revenue_trend`,
        computedAt: sql`(unixepoch())`,
      },
    });

  // --- swing_daily_ohlcv (増分: 既存 MAX(date) より新しい bar のみ) ---
  const newOhlcv = existingMaxDate
    ? snap.ohlcv6mo.filter((r) => r.date > existingMaxDate)
    : snap.ohlcv6mo;
  for (let i = 0; i < newOhlcv.length; i += OHLCV_CHUNK) {
    await db
      .insert(swingSchema.dailyOhlcv)
      .values(
        newOhlcv.slice(i, i + OHLCV_CHUNK).map((r) => ({
          stockId: snap.stockId,
          date: r.date,
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
          volume: r.volume,
          adj: r.adj,
        }))
      )
      .onConflictDoUpdate({
        target: [swingSchema.dailyOhlcv.stockId, swingSchema.dailyOhlcv.date],
        set: {
          open: sql`excluded.open`,
          high: sql`excluded.high`,
          low: sql`excluded.low`,
          close: sql`excluded.close`,
          volume: sql`excluded.volume`,
          adj: sql`excluded.adj`,
        },
      });
  }
  // 保持期間の prune はここ (書き込み経路) では行わない。
  // 以前は snap.ohlcv6mo から cutoff 日付を作って銘柄ごとに DELETE していたが、
  // それだと **Yahoo 取得が失敗し続けている銘柄では prune が一度も走らない**。
  // 実測で stock_id 640/710/992/1009 が 120→90 短縮前の 120 行を保持したままで、
  // swing_daily_ohlcv の DISTINCT date が 203 に伸びる直接の原因になっていた。
  // 全銘柄の一括 sweep (pruneOhlcvRetention) が Phase 4 で面倒を見る。

  // --- swing_stock_indicators ---
  await db
    .insert(swingSchema.stockIndicators)
    .values({
      stockId: snap.stockId,
      avgTurnover20d: snap.avgTurnover20d,
      volume20d: snap.volume20d,
      volumeRatio: snap.volumeRatio,
      atr14: snap.atr14,
      atrPct: snap.atrPct,
      sma5: snap.sma5,
      sma20: snap.sma20,
      sma25: snap.sma25,
      sma60: snap.sma60,
      sma75: snap.sma75,
      trendLong: snap.trendLong,
      trendShort: snap.trendShort,
      perfectOrderLong: snap.perfectOrderLong,
      perfectOrderShort: snap.perfectOrderShort,
      rsi14: snap.rsi14,
      macd: snap.macd,
      macdSignal: snap.macdSignal,
      macdHist: snap.macdHist,
      range20dHigh: snap.range20dHigh,
      range20dLow: snap.range20dLow,
      rangeWidth: snap.rangeWidth,
      fibHigh: snap.range20dHigh,
      fibLow: snap.range20dLow,
      fib382: snap.fib382,
      fib500: snap.fib500,
      fib618: snap.fib618,
      latestClose: snap.latestClose,
      latestVolume: snap.latestVolume,
      latestDate: snap.latestDate,
      pctChange1d: snap.pctChange1d,
    })
    .onConflictDoUpdate({
      target: swingSchema.stockIndicators.stockId,
      set: {
        avgTurnover20d: sql`excluded.avg_turnover_20d`,
        volume20d: sql`excluded.volume_20d`,
        volumeRatio: sql`excluded.volume_ratio`,
        atr14: sql`excluded.atr_14`,
        atrPct: sql`excluded.atr_pct`,
        sma5: sql`excluded.sma_5`,
        sma20: sql`excluded.sma_20`,
        sma25: sql`excluded.sma_25`,
        sma60: sql`excluded.sma_60`,
        sma75: sql`excluded.sma_75`,
        trendLong: sql`excluded.trend_long`,
        trendShort: sql`excluded.trend_short`,
        perfectOrderLong: sql`excluded.perfect_order_long`,
        perfectOrderShort: sql`excluded.perfect_order_short`,
        rsi14: sql`excluded.rsi_14`,
        macd: sql`excluded.macd`,
        macdSignal: sql`excluded.macd_signal`,
        macdHist: sql`excluded.macd_hist`,
        range20dHigh: sql`excluded.range_20d_high`,
        range20dLow: sql`excluded.range_20d_low`,
        rangeWidth: sql`excluded.range_width`,
        fibHigh: sql`excluded.fib_high`,
        fibLow: sql`excluded.fib_low`,
        fib382: sql`excluded.fib_382`,
        fib500: sql`excluded.fib_500`,
        fib618: sql`excluded.fib_618`,
        latestClose: sql`excluded.latest_close`,
        latestVolume: sql`excluded.latest_volume`,
        latestDate: sql`excluded.latest_date`,
        pctChange1d: sql`excluded.pct_change_1d`,
        computedAt: sql`(unixepoch())`,
      },
    });

  // --- swing_stock_screening ---
  const screen = screenStock({
    avgTurnover20d: snap.avgTurnover20d,
    volumeRatio: snap.volumeRatio,
    atrPct: snap.atrPct,
    sma5: snap.sma5,
    sma20: snap.sma20,
    latestClose: snap.latestClose,
  });
  await db
    .insert(swingSchema.stockScreening)
    .values({
      stockId: snap.stockId,
      liquidityOk: screen.liquidityOk,
      volatilityOk: screen.volatilityOk,
      trendOkLong: screen.trendOkLong,
      trendOkShort: screen.trendOkShort,
      allPassedLong: screen.allPassedLong,
      allPassedShort: screen.allPassedShort,
    })
    .onConflictDoUpdate({
      target: swingSchema.stockScreening.stockId,
      set: {
        liquidityOk: sql`excluded.liquidity_ok`,
        volatilityOk: sql`excluded.volatility_ok`,
        trendOkLong: sql`excluded.trend_ok_long`,
        trendOkShort: sql`excluded.trend_ok_short`,
        allPassedLong: sql`excluded.all_passed_long`,
        allPassedShort: sql`excluded.all_passed_short`,
        computedAt: sql`(unixepoch())`,
      },
    });

  // --- swing_entry_signals ---
  // 既存シグナルは無条件にクリア (latestClose が null でも古い entry/stop を残さない
  // — CLAUDE.md rule2)。算出できた時だけ再挿入する。
  await db
    .delete(swingSchema.entrySignals)
    .where(eq(swingSchema.entrySignals.stockId, snap.stockId));
  if (snap.latestClose !== null) {
    const prevOhlcv =
      snap.ohlcv6mo.length >= 2 ? snap.ohlcv6mo[snap.ohlcv6mo.length - 2] : null;
    const signalSnap: IndicatorSnapshot = {
      latestClose: snap.latestClose,
      prevClose: snap.previousClose,
      latestOpen: snap.latestOpen,
      latestHigh: snap.latestHigh,
      latestLow: snap.latestLow,
      atr14: snap.atr14,
      atrPct: snap.atrPct,
      sma5: snap.sma5,
      sma20: snap.sma20,
      sma60: snap.sma60,
      rsi14: snap.rsi14,
      macd: snap.macd,
      macdSignal: snap.macdSignal,
      range20dHigh: snap.range20dHigh,
      range20dLow: snap.range20dLow,
      rangeWidth: snap.rangeWidth,
      fib382: snap.fib382,
      fib618: snap.fib618,
      volumeRatio: snap.volumeRatio,
      avgTurnover20d: snap.avgTurnover20d,
      perfectOrderLong: snap.perfectOrderLong,
      perfectOrderShort: snap.perfectOrderShort,
      pctChange1d: snap.pctChange1d,
    };
    const signals = detectAllPatterns(signalSnap, prevOhlcv ? [prevOhlcv] : []);
    if (signals.length > 0) {
      await db.insert(swingSchema.entrySignals).values(
        signals.map((s) => ({
          stockId: snap.stockId,
          pattern: s.pattern,
          direction: s.direction,
          entryPrice: s.entryPrice,
          stopLoss: s.stopLoss,
          target1: s.target1,
          target2: s.target2,
          riskRewardRatio: s.riskRewardRatio,
          signalStrength: s.signalStrength,
          note: s.note,
        }))
      );
    }
  }
}

// -----------------------------------------------------------------------------
// OHLCV 保持期間の一括 prune (書き込み経路から独立)
//
// 判定は「銘柄ごとに新しい方から OHLCV_RETENTION_DAYS 本だけ残す」。
// **is_active や「MAX(date) が N 日以上遅れている」条件は採らない**:
//   - is_active の所有者は JPX 一覧を読む universe sync で、同期が止まっただけの
//     銘柄は is_active=true のまま残る (実測 4 銘柄が is_active かどうかは
//     このレーンからは D1 を読めず未確認)。is_active 条件では取り残される。
//   - 遅れ日数 N を導入すると「N をいくつにするか」の根拠が別途必要になり、
//     しかも N 日以内の銘柄の余剰行は放置される。
// 「新しい方から N 本」なら同期が止まっていても本数が収束し、閾値を 1 つ
// (保持本数) しか持たなくて済む。
// -----------------------------------------------------------------------------

/**
 * 保持本数を超えている銘柄と超過本数を選ぶ (純関数)
 *
 * @param counts - 銘柄ごとの OHLCV 行数
 * @param retentionDays - 残す本数 (営業日ベースの行数)
 */
export function selectOverRetentionStocks(
  counts: { stockId: number; bars: number }[],
  retentionDays: number
): { stockId: number; excessBars: number }[] {
  return counts
    .filter((r) => r.bars > retentionDays)
    .map((r) => ({ stockId: r.stockId, excessBars: r.bars - retentionDays }));
}

/**
 * swing_daily_ohlcv を「銘柄ごとに新しい方から retentionDays 本」へ揃える。
 *
 * 全銘柄を 1 度の GROUP BY で走査するので、同期が止まって Phase 3 に現れない
 * 銘柄も対象になる (これが書き込み経路内 prune との違い)。
 *
 * @returns prune 対象になった銘柄数と削除行数 (D1 REST は changes を返さないので
 *          超過本数の合計から算出した期待値)
 */
export async function pruneOhlcvRetention(
  db: Db,
  retentionDays: number = OHLCV_RETENTION_DAYS
): Promise<{ prunedStocks: number; deletedRows: number }> {
  const counts = await db
    .select({
      stockId: swingSchema.dailyOhlcv.stockId,
      bars: sql<number>`count(*)`,
    })
    .from(swingSchema.dailyOhlcv)
    .groupBy(swingSchema.dailyOhlcv.stockId)
    .having(sql`count(*) > ${retentionDays}`);

  const over = selectOverRetentionStocks(counts, retentionDays);
  if (over.length === 0) return { prunedStocks: 0, deletedRows: 0 };

  for (let i = 0; i < over.length; i += OHLCV_PRUNE_ID_CHUNK) {
    const ids = over.slice(i, i + OHLCV_PRUNE_ID_CHUNK).map((r) => r.stockId);
    // ROW_NUMBER で「新しい日付から数えて retentionDays 本目より古い行」を消す。
    // date 文字列から cutoff を引き算する方式は、欠損日 (取引所休場・取得欠け) で
    // 残る本数がぶれるので採らない。
    await db.run(sql`
      DELETE FROM swing_daily_ohlcv
      WHERE rowid IN (
        SELECT rowid FROM (
          SELECT rowid,
                 ROW_NUMBER() OVER (
                   PARTITION BY stock_id ORDER BY date DESC
                 ) AS rn
          FROM swing_daily_ohlcv
          WHERE stock_id IN (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `
          )})
        )
        WHERE rn > ${retentionDays}
      )
    `);
  }

  return {
    prunedStocks: over.length,
    deletedRows: over.reduce((acc, r) => acc + r.excessBars, 0),
  };
}

// -----------------------------------------------------------------------------
// L2 投影 (p_momentum) の再生成
//
// なぜ cron 側に置くのか: `/financial-math/emh?type=momentum` は 1 表示ごとに
// swing_daily_ohlcv を全走査していた (実測 340,763 rows_read / TTFB 0.86〜1.01 秒)。
// D1 は走査行課金なので、これは訪問者 1 人ごとに払う継続コストである。
// 走査を「1 日 1 回」へ移し、画面は 1 銘柄 1 行の投影だけを読む。
//
// **新しい cron は足さない**。既存の日次 sync (平日 21:00 UTC) の最終フェーズに
// 相乗りさせる。prune (Phase 4) の後に置くのは、投影の中身を「prune 後に D1 に
// 実在する本数」と一致させるため (先に作ると消える行まで畳んでしまう)。
// -----------------------------------------------------------------------------

/**
 * 投影再生成の 1 ページで読む OHLCV 行数。
 *
 * 刻まずに 1 文で読むと 336,169 行 ≒ 25 MB を 1 レスポンスで受けることになり、
 * D1 REST の応答上限に依存した壊れ方をする。1 ページ 40,000 行 ≒ 3 MB。
 *
 * 刻み方は **rowid カーソル** (`WHERE id > :last ORDER BY id LIMIT n`)。
 * 本番実測で走査行の比率がこれだけ違う (2026-09-13, kabulab-cf):
 *
 *   | 読み方 | rows_read | 返却行 | 比 |
 *   |---|---|---|---|
 *   | rowid カーソル 40,000 行 | 40,150 | 40,000 | **1.004** |
 *   | 全表走査 (join なし) | 336,169 | 309,156 | 1.09 |
 *   | stock_id 範囲 400 銘柄 (join なし) | 35,281 | 31,296 | 1.13 |
 *   | stock_id 範囲 400 銘柄 + core_stocks join | **371,793** | 31,030 | 12.0 |
 *
 * 最後の行が落とし穴で、`core_stocks` を JOIN すると SQLite は
 * `SEARCH core_stocks USING COVERING INDEX (is_active=?)` を外側ループに選び、
 * stock_id の範囲条件が**外側を刈らない**。1 チャンクごとに OHLCV を全走査する
 * ので、32 チャンクで 1,190 万行になる。**is_active の絞り込みは SQL で
 * JOIN せず、id 集合を先に引いて JS 側で落とす。**
 */
const PROJECTION_SCAN_PAGE = 40_000;
/** p_momentum upsert の bind 上限対策 (6 列なので 16 行/文: 6×16=96≤100) */
const PROJECTION_CHUNK = 16;

/** 投影再生成の結果 (コスト実測をログへ出すために行数を返す) */
export interface MomentumProjectionResult {
  /** 書いた投影行数 (= 母集団のうち有効な終値を持つ銘柄数) */
  projectedStocks: number;
  /** 走査した swing_daily_ohlcv の行数 (= 画面から消えた走査行) */
  scannedBars: number;
  /** 生成時の MAX(swing_daily_ohlcv.date)。1 行も無ければ null */
  sourceMaxDate: string | null;
  /** 母集団から落ちて掃除した投影行数 */
  removedStocks: number;
}

/**
 * `p_momentum` を `swing_daily_ohlcv` から作り直す。
 *
 * 母集団は `/emh` が数えているものと同じ「`core_stocks.is_active` かつ終値が
 * NULL でない行」。同じ WHERE / 同じ順序で読むので、投影を経由しても
 * `calcMomentum` に入る配列は**従来と同一**になる (= 画面の数値は変わらない)。
 *
 * 全消し → 全挿入は採らなかった。3,764 行の DELETE + 3,764 行の INSERT で
 * 書込が 2 倍になる。代わりに upsert してから「今回の run で触られなかった行」を
 * 1 文の DELETE で落とす。観測できる結果 (孤児行が残らない) は同じで、
 * 書込は約 3,764 行/日に収まる。
 *
 * 途中で例外が出た場合、掃除 DELETE は走らないので古い行が残る。その行は
 * `as_of` が進まないので画面側で古さとして見える (黙って新しいふりをしない)。
 */
export async function rebuildMomentumProjection(
  db: Db
): Promise<MomentumProjectionResult> {
  // 掃除の閾値。この時刻以降に computed_at が書かれた行だけが「今回の run で
  // 触られた行」。unixepoch() 秒に合わせるため切り捨てる。
  const runStartedSec = Math.floor(Date.now() / 1000);
  const projection = projectionSchema.momentumProjection;

  // 母集団 = /emh が分母に使っているのと同じ is_active の集合。
  // **JOIN にはしない** (上の表のとおり JOIN すると 1 ページごとに OHLCV を
  // 全走査する計画を選ばれる)。id 集合を先に引いて JS 側で落とす。
  const activeIds = new Set(
    (
      await db
        .select({ id: coreSchema.stocks.id })
        .from(coreSchema.stocks)
        .where(eq(coreSchema.stocks.isActive, true))
    ).map((r) => r.id)
  );

  const barsByStock = new Map<number, { date: string; close: number }[]>();
  let scannedBars = 0;
  let sourceMaxDate: string | null = null;

  // rowid カーソルで前進する。id は autoincrement だが prune で穴が空くため
  // (実測 336,169 行が id 8,916〜20,625,713 に散っている) 固定幅の範囲刻みは
  // 使えない。カーソルなら空き番地を跨いでも走査行が返却行に比例する。
  let lastId = 0;
  for (;;) {
    const page = await db
      .select({
        id: swingSchema.dailyOhlcv.id,
        stockId: swingSchema.dailyOhlcv.stockId,
        date: swingSchema.dailyOhlcv.date,
        close: swingSchema.dailyOhlcv.close,
      })
      .from(swingSchema.dailyOhlcv)
      .where(
        and(
          isNotNull(swingSchema.dailyOhlcv.close),
          gt(swingSchema.dailyOhlcv.id, lastId)
        )
      )
      .orderBy(asc(swingSchema.dailyOhlcv.id))
      .limit(PROJECTION_SCAN_PAGE);
    if (page.length === 0) break;

    scannedBars += page.length;
    for (const bar of page) {
      if (bar.close === null) continue;
      // データセット全体の鮮度。非活動銘柄のバーも含める (as_of との差が
      // 「この銘柄だけ取得が止まっている」ことを示すので、分母は揃えない)。
      if (sourceMaxDate === null || bar.date > sourceMaxDate) {
        sourceMaxDate = bar.date;
      }
      if (!activeIds.has(bar.stockId)) continue;
      const arr = barsByStock.get(bar.stockId);
      if (arr) arr.push({ date: bar.date, close: bar.close });
      else barsByStock.set(bar.stockId, [{ date: bar.date, close: bar.close }]);
    }
    lastId = page[page.length - 1].id;
    if (page.length < PROJECTION_SCAN_PAGE) break;
  }

  if (sourceMaxDate === null) {
    // OHLCV が 1 行も無い = 初回 backfill 前。ここで投影を全消しすると
    // 「まだ取れていない」と「母集団から落ちた」の区別が付かなくなるので触らない。
    return {
      projectedStocks: 0,
      scannedBars,
      sourceMaxDate: null,
      removedStocks: 0,
    };
  }

  // rowid 順で読んだので日付順とは限らない (prune と増分 upsert で id と date の
  // 単調性が一致しない)。**ここで date 昇順に揃える**。逆順や飛び順のまま
  // 畳むと累積リターンの符号が黙って反転する。
  const rows = [...barsByStock.entries()].map(([stockId, bars]) => {
    bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return {
      stockId,
      asOf: bars[bars.length - 1].date,
      sourceMaxDate: sourceMaxDate as string,
      bars: bars.length,
      closes: encodeCloses(bars.map((b) => b.close)),
      computedAt: new Date(runStartedSec * 1000),
    };
  });

  for (let i = 0; i < rows.length; i += PROJECTION_CHUNK) {
    await db
      .insert(projection)
      .values(rows.slice(i, i + PROJECTION_CHUNK))
      .onConflictDoUpdate({
        target: projection.stockId,
        set: {
          asOf: sql`excluded.as_of`,
          sourceMaxDate: sql`excluded.source_max_date`,
          bars: sql`excluded.bars`,
          closes: sql`excluded.closes`,
          computedAt: sql`excluded.computed_at`,
        },
      });
  }

  // 今回の run で触られなかった行 = 非活動化・上場廃止で母集団から落ちた銘柄。
  // 件数は D1 REST が changes を返さないので DELETE の前に数える
  // (行は転送しない = count(*)。どちらも p_momentum の全走査 3,764 行)。
  const staleBefore = new Date((runStartedSec - 1) * 1000);
  const [{ staleCount }] = await db
    .select({ staleCount: sql<number>`count(*)` })
    .from(projection)
    .where(lte(projection.computedAt, staleBefore));
  if (staleCount > 0) {
    await db.delete(projection).where(lte(projection.computedAt, staleBefore));
  }

  return {
    projectedStocks: rows.length,
    scannedBars,
    sourceMaxDate,
    removedStocks: staleCount,
  };
}

// -----------------------------------------------------------------------------
// マクロコンテキスト同期 (^N225 / ^VIX / ^GSPC / NIY=F + 日経VI)
// -----------------------------------------------------------------------------

function createMarketContextDraft(): MarketContextDraft {
  return {
    charts: {
      "^N225": { price: null, prevClose: null },
      "^VIX": { price: null, prevClose: null },
      "^GSPC": { price: null, prevClose: null },
      "NIY=F": { price: null, prevClose: null },
    },
    nikkeiVi: null,
  };
}

async function fetchMarketContextTarget(
  draft: MarketContextDraft,
  target: MarketContextTarget
): Promise<void> {
  if (target === NIKKEI_VI_TARGET) {
    const snapshot = await fetchNikkeiVi();
    draft.nikkeiVi = snapshot.price;
    return;
  }

  const chart = await fetchChart(target, "1mo");
  draft.charts[target] = {
    price: chart.price,
    prevClose: chart.previousClose,
  };
}

async function fetchMarketContextDraft(): Promise<{
  draft: MarketContextDraft;
  failures: DailyRecoveryFailure<MarketContextTarget>[];
}> {
  const draft = createMarketContextDraft();
  const failures: DailyRecoveryFailure<MarketContextTarget>[] = [];
  const targets: readonly MarketContextTarget[] = [
    ...MARKET_CONTEXT_CHART_SYMBOLS,
    NIKKEI_VI_TARGET,
  ];

  await Promise.all(
    targets.map(async (target) => {
      try {
        await fetchMarketContextTarget(draft, target);
      } catch (error) {
        const message = rootCauseMessage(error);
        failures.push({ target, error: message });
        console.warn(`[sync-daily]   マクロ取得失敗 ${target}:`, message);
      }
    })
  );

  return { draft, failures };
}

async function persistMarketContext(
  db: Db,
  draft: MarketContextDraft
): Promise<boolean> {
  const today = new Date().toISOString().split("T")[0];
  const n225 = draft.charts["^N225"];
  const vix = draft.charts["^VIX"];
  const gspc = draft.charts["^GSPC"];
  const niy = draft.charts["NIY=F"];
  const nikkeiVi = draft.nikkeiVi;

  const nikkeiPct =
    n225.price !== null && n225.prevClose !== null && n225.prevClose > 0
      ? ((n225.price - n225.prevClose) / n225.prevClose) * 100
      : null;
  const sp500Pct =
    gspc.price !== null && gspc.prevClose !== null && gspc.prevClose > 0
      ? ((gspc.price - gspc.prevClose) / gspc.prevClose) * 100
      : null;
  const futuresGap =
    niy.price !== null && n225.price !== null ? niy.price - n225.price : null;

  // TOPIX 売買代金は Yahoo から取れない
  const topixTurnoverRatio = null;

  const result = judgeMacro({
    nikkeiVi,
    topixTurnoverRatio,
    futuresGap,
    vix: vix.price,
    sp500Pct,
  });

  await db
    .insert(swingSchema.marketContext)
    .values({
      date: today,
      nikkeiClose: n225.price,
      nikkeiPct,
      nikkeiVi,
      topixTurnoverRatio,
      futuresGap,
      vix: vix.price,
      sp500Pct,
      judgment: result.judgment,
      judgmentReason: result.reason,
    })
    .onConflictDoUpdate({
      target: swingSchema.marketContext.date,
      set: {
        nikkeiClose: sql`excluded.nikkei_close`,
        nikkeiPct: sql`excluded.nikkei_pct`,
        nikkeiVi: sql`excluded.nikkei_vi`,
        topixTurnoverRatio: sql`excluded.topix_turnover_ratio`,
        futuresGap: sql`excluded.futures_gap`,
        vix: sql`excluded.vix`,
        sp500Pct: sql`excluded.sp500_pct`,
        judgment: sql`excluded.judgment`,
        judgmentReason: sql`excluded.judgment_reason`,
        computedAt: sql`(unixepoch())`,
      },
    });

  return (
    n225.price !== null &&
    n225.prevClose !== null &&
    vix.price !== null &&
    gspc.price !== null &&
    gspc.prevClose !== null &&
    niy.price !== null &&
    nikkeiVi !== null
  );
}

async function persistMarketContextWithDiagnostics(
  db: Db,
  draft: MarketContextDraft
): Promise<boolean> {
  try {
    return await persistMarketContext(db, draft);
  } catch (error) {
    console.warn(
      "[sync-daily]   マクロ保存失敗:",
      rootCauseMessage(error)
    );
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
