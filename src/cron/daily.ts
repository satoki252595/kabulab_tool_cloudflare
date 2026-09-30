/**
 * 日次 sync オーケストレータ (Node / GitHub Actions 実行)。
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
 *   Phase 1. ブートストラップ: core_stocks の active かつ equity の銘柄を取得 +
 *            swing_stock_indicators.latest_date を LEFT JOIN (増分判定用)
 *   Phase 2. マクロコンテキスト (^N225 / ^VIX / ^GSPC / NIY=F + 日経VI)
 *   Phase 3. worker pool で各銘柄: Chart(5y)+QuoteSummary 取得 → 全指標を計算 →
 *            core_financials / rsi_percentile / swing_* を **増分** upsert +
 *            p_momentum へ 1 文 upsert（L-47。Phase 6 の読み直しはしない）
 *   Phase 4. swing_daily_ohlcv の保持期間 prune（月曜 UTC の run のみ。
 *            全銘柄を一括。書き込み経路から独立させてあるので、同期が止まった
 *            銘柄でも保持本数が効く）
 *   Phase 5. セクター集計（当日更新済 indicators から集計・90% カバレッジ guard）
 *   Phase 6. p_momentum の仕上げ: source_max_date の backfill + 掃除 DELETE
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

import { sql, eq, and, or, gte, lte, lt, asc, isNull, inArray } from "drizzle-orm";
import { createD1HttpDb } from "../shared/db/d1-http-client.js";
import { publicSectorColumn } from "../shared/db/public-columns.js";
import { activeEquityCondition } from "../shared/db/active-equity.js";
import {
  jssFinancials,
  pickAnnualSeries,
  PUBLISHABLE_LICENSE_TAG,
  type JssAnnualRow,
} from "../shared/db/jss-financials.js";
import { sharedEnv } from "../shared/env.js";
import {
  ensurePriceSyncDb,
  recordPriceSyncLog,
  recordPrimaryData,
  verifyArchivedAttachments,
  type PriceSyncStatus,
} from "../shared/notion-archive/index.js";
import { sha256HexBytes } from "../shared/sha256.js";
import { selectConfirmedCloses } from "./macro-session.js";

// core スキーマ (共有。日次 sync が更新)
import * as coreSchema from "../shared/db/core-schema.js";
// rsi スキーマ
import * as rsiSchema from "../../services/rsi-screening/src/db/schema.js";
// swing スキーマ
import * as swingSchema from "../../services/swing-trading/src/db/schema.js";
// L2 投影 (p_*)。writer はこの cron だけ。
import * as projectionSchema from "../shared/db/projection-schema.js";
import { encodeCloses, isUsableClose } from "../shared/indicators/momentum-series.js";

import {
  fetchChart,
  fetchStockRawData,
} from "../shared/yahoo/client.js";
import { checkFreshClose } from "../shared/yahoo/bar-sanity.js";
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
import { collectUniverseOfficialEvents } from "./universe-official-events.js";
import {
  ensureUniverseOverlay,
  withBasicEvidence,
  type OverlayCollectFn,
} from "./universe-overlay.js";

// -----------------------------------------------------------------------------
// 型定義
// -----------------------------------------------------------------------------

// createD1HttpDb は core_* を自動登録するので rsi/swing/p_* スキーマのみ渡す。
const SCHEMAS = { ...rsiSchema, ...swingSchema, ...projectionSchema };
type Db = ReturnType<typeof createDailyDb>;

/** 日次 sync の結果サマリ */
export interface DailySyncResult {
  /** 処理対象の件数 = `core_stocks` の active かつ equity (`loadDailyTargets`)。 */
  totalStocks: number;
  successStocks: number;
  failedStocks: number;
  /** null = 株式専用の実行でマクロは対象外。 */
  marketContextOk: boolean | null;
  elapsedSec: number;
  failures: { code: string; error: string }[];
  /**
   * 取引日 (この run が実際に書き込んだ最新バーの日付。
   * `swing_daily_ohlcv` の MAX(date) から導出。§Phase 6)。
   * 導出できなかった (Phase 3 が実質全滅) 場合は `null`
   * (「株価の日次同期」記録は推測せず状態=失敗にする — ルール2)。
   */
  tradingDate: string | null;
  /**
   * 失敗バッチの一次保管キー (`price-sync-batch-{runId}`)。
   * 結果が返る = 保管済み (保管失敗は結果を返さず throw する)。
   * CLI の 20 グループ表示は要約。このキーの JSON が切詰なし正本。
   */
  batchKey: string;
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
/**
 * 一過性失敗の回収に使える時間予算 (ms)。run 開始からの経過で見る。
 *
 * 90 分の Actions 上限 (stock-sync.yml の timeout-minutes) から、後段
 * (Phase 4〜6 + 余裕) の 30 分を引いた 60 分。件数上限 (旧 100 件) だと
 * 失敗の規模で回収が頭打ちになり、52% の run が失敗扱いになっていた (L-57)。
 * timeout-minutes を変えたらここも変えること。
 */
const RECOVERY_TIME_BUDGET_MS = 3_600_000;
/** 失敗率がこの以下なら run 成功扱いにする (L-57。Issue にはコメントする)。 */
const TOLERATED_FAILURE_RATE = 0.01;

/**
 * 月曜 (UTC) だけ真。週1ジョブ (prune・年次) の同 run 内分岐用。
 *
 * 株式cronは平日17:13 UTCなのでUTC曜日で見る。JSTでは火〜土曜02:13。
 * UTC月曜が週の最初の株式run。
 */
export function isMondayUtc(now: Date = new Date()): boolean {
  return now.getUTCDay() === 1;
}

/**
 * run 開始 instant から週1ゲートと日付キーを決める (純関数)。
 *
 * 週1ジョブ (prune・年次) の月曜判定と market/sector 表の日付キーは
 * run 開始時刻に固定する。Phase 実行時刻 (`new Date()`) で評価すると、
 * UTC 日跨ぎの run で月曜判定が外れて prune が飢餓する (F-05)。
 * 旧 21:00 UTC 日程では開始遅延 2〜3h で Phase 4 が火曜に落ち、
 * 3,689 銘柄が 90 本超過まで積み上がった。
 */
export function runDateKeys(startedAt: number): {
  runDate: string;
  runMonday: boolean;
} {
  const at = new Date(startedAt);
  return {
    runDate: at.toISOString().split("T")[0],
    runMonday: isMondayUtc(at),
  };
}
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
  /** 最新 confirmed bar の実終値 (形成中バー・snapshot は入れない)。 */
  price: number | null;
  /** 確定日より前の最新バーの実終値。無ければ null (pct は null)。 */
  prevClose: number | null;
  /** price バーの日付 ('YYYY-MM-DD')。GSPC の確定日が行キーになる。 */
  date: string | null;
}
interface MarketContextDraft {
  charts: Record<MarketContextChartSymbol, MarketContextChartValue>;
  nikkeiVi: number | null;
  /** VI の ZXD (データ日付)。行キーとの照合に使う。 */
  nikkeiViDate: string | null;
}
/** マクロ一次原本の run-local collector (1 target × attempt ごとに 1 件)。 */
interface MacroRawAttempt {
  target: MarketContextTarget;
  attempt: number;
  /** 実要求開始・完了時刻 (ISO8601)。run startedAt とは別に attempt 毎。 */
  requestedAt: string;
  completedAt: string;
  status: number | null;
  bytes: Uint8Array | null;
  sha256: string | null;
  /** 通信失敗などで body が無い理由 (body があるとき null)。 */
  noBodyReason: string | null;
}
/**
 * swing_daily_ohlcv の保持本数 (営業日相当)。増分 upsert と併せて書込/容量を抑える。
 * 適用は Phase 4 の一括 sweep (pruneOhlcvRetention) — 書き込み経路では行わない。
 */
const OHLCV_RETENTION_DAYS = 90;
/**
 * 表ごとの multi-row upsert の行数/文 (L-56)。D1 の bind 上限 (100/文) 対策。
 * 行数×列数 ≤ 100。列を足したらここも直すこと (universe.ts の UPSERT_CHUNK と
 * 同じ規約。flush-snapshot.test.ts が bind 数を実測で固定)。
 */
const FLUSH_ROWS_PER_STATEMENT = {
  /** 年次: 3 列 × 33 = 99 */
  annual: 33,
  /** ②断面: 12 列 × 8 = 96 */
  financials: 8,
  /** rsi: 12 列 × 8 = 96 */
  rsi: 8,
  /** OHLCV: 8 列 × 12 = 96 (旧 OHLCV_CHUNK) */
  ohlcv: 12,
  /** 指標 (+L-52 の畳み 6 列で 37 列): 37 × 2 = 74。3 行は 111 で上限超え */
  indicators: 2,
  /** シグナル (run 刻み込みで 11 列): 11 × 9 = 99 */
  signals: 9,
  /** モメンタム投影: 6 列 × 16 = 96 */
  momentum: 16,
} as const;
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

/**
 * 監視上の失敗か。失敗率 ≤1% は成功扱い (L-57)。
 *
 * 以前は 1 件でも失敗で run 失敗にし、52% の run が失敗扱いになっていた。
 * 上場廃止・Yahoo 欠損などの恒久失敗が毎日数件は出るため、≤1% は成功扱いにし、
 * 代わりに Issue へコメントして trace を残す (scripts/sync/daily.ts が出す)。
 * 空母集団・件数不一致・マクロ失敗は従来どおり失敗。
 */
export function isDailySyncIncomplete(
  result: Pick<
    DailySyncResult,
    "totalStocks" | "successStocks" | "failedStocks" | "marketContextOk"
  >
): boolean {
  if (
    result.totalStocks === 0 ||
    result.successStocks + result.failedStocks !== result.totalStocks ||
    result.marketContextOk === false
  ) {
    return true;
  }
  return result.failedStocks / result.totalStocks > TOLERATED_FAILURE_RATE;
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

/** macro を先頭にして、両系統を同じ時間予算へ流す。 */
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
 *
 * 回収量は件数ではなく時間予算 (`deadlineMs`) で区切る (L-57)。
 * 予算切れで手を付けなかった対象は `skippedDueToLimit` に数える。
 * 2 パス目も Retry-After を尊重する (初回の指示を上限 30 秒で待つ)。
 * `deadlineMs` を渡さないと全件を回収する (テスト用)。
 */
export async function recoverTransientDailyFailures<T>(
  failures: readonly DailyRecoveryFailure<T>[],
  processTarget: (target: T) => Promise<void>,
  options: { deadlineMs?: number } = {}
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
    if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) {
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
 * 日次取込の処理対象 = `core_stocks` の **active かつ equity (内国普通株)**。
 *
 * 2026-09-13 のユーザー決定で `is_active` 単独から絞った。移行 P4b が非普通株
 * (+725 行: ETF/ETN・PRO Market・REIT 等・外国株) を INSERT しても、日次の対象件数・
 * Actions の所要時間・D1 の書込が増えないようにするため。述語の定義とライセンス判断は
 * src/shared/db/active-equity.ts。業種集計 (Phase 5) と投影 (Phase 6) も同じ述語を使う。
 *
 * このコードは対象から外れた銘柄の派生行を消さない。更新が止まって凍結し、公開面の
 * 一覧は同じ述語で隠す。2026-09-13 に外れた非普通株 9 銘柄 (reit_fund 8 /
 * investment_certificate 1) は、同日のユーザー決定で core_stocks の行ごと元データから
 * 削除する (一度きりの手作業で、このコードの仕事ではない)。
 * 対象が 0 件なら run を失敗にする判定 (`isDailySyncIncomplete`) は従来どおり効く。
 */
export async function loadDailyTargets(db: Db) {
  return db
    .select({
      id: coreSchema.stocks.id,
      code: coreSchema.stocks.code,
      // この `sector` (JPX 33 業種) は `buildSnapshot` 経由で
      // `StockSnapshot.sector` に入るが、**どこにも保存されず公開面にも出ない**:
      // `writeStockSnapshot` はこのフィールドを参照しない (2026-09-13 に確認)。
      // 公開面に出る業種ランキングの集約キーは Phase 5 (`aggregateSectorDaily`)
      // が別のクエリで引いている。ここを `publicSectorColumn` に揃える案は
      // 採らなかった: 値がどこにも流れない以上、切り替えても挙動が変わらず、
      // 差分だけが増える。保存や表示に使い始めるときは公開面と同じ列へ移すこと。
      sector: coreSchema.stocks.sector,
      // 増分判定用。OHLCV の MAX(date) GROUP BY (336k 行走査) の代わりに
      // indicators の latest_date を LEFT JOIN で引く (L-47)。NULL の銘柄は
      // 初回 backfill (6mo 全 upsert)。latest_date は成功時に必ず書かれるので、
      // 古い値を見ても再 upsert になるだけで欠損にはならない (安全側に倒れる)。
      latestDate: swingSchema.stockIndicators.latestDate,
    })
    .from(coreSchema.stocks)
    .leftJoin(
      swingSchema.stockIndicators,
      eq(swingSchema.stockIndicators.stockId, coreSchema.stocks.id)
    )
    .where(activeEquityCondition());
}

/**
 * 優良株選定の入力にする正本の年次実績を一括で読む。
 *
 * `jss_financials` の本決算 × 公開可 (commercial-ok) だけを 1 文で引き、
 * 銘柄コードごとに束ねる (数百行。全銘柄 × 毎日の per-stock SELECT にしない)。
 * 系列への整形 (最新期の区分単一化・未来期の除外。短期決算の推測除外は
 * しない) は共有 gate (`pickAnnualSeries`) が銘柄ごとに行う。年次比較の
 * 可否は `evaluateBlueChip` が判定不能に倒す。TTM 営業利益率は Yahoo のまま
 * (単年 jss 値への置換は定義を変えるのでしない)。
 */
export async function loadJssAnnualMap(
  db: Db
): Promise<Map<string, JssAnnualRow[]>> {
  const rows = await db
    .select({
      code: jssFinancials.code,
      fiscalPeriodEnd: jssFinancials.fiscalPeriodEnd,
      consolidated: jssFinancials.consolidated,
      revenue: jssFinancials.netSales,
    })
    .from(jssFinancials)
    .where(
      and(
        eq(jssFinancials.disclosureType, "本決算"),
        eq(jssFinancials.licenseTag, PUBLISHABLE_LICENSE_TAG)
      )
    )
    .orderBy(asc(jssFinancials.code), asc(jssFinancials.fiscalPeriodEnd));
  const byCode = new Map<string, JssAnnualRow[]>();
  for (const r of rows) {
    const list = byCode.get(r.code);
    const row: JssAnnualRow = {
      fiscalPeriodEnd: r.fiscalPeriodEnd,
      consolidated: r.consolidated,
      revenue: r.revenue,
    };
    if (list === undefined) {
      byCode.set(r.code, [row]);
    } else {
      list.push(row);
    }
  }
  return byCode;
}

/**
 * `swing_daily_ohlcv` の close-NULL 日を銘柄ごとに集める (F-04 修復の対象抽出)。
 *
 * 増分フィルタ (`date > existingMaxDate`) は保存済み NULL 日を再送しないため、
 * 対象日をここで明示する。再送されるのは fresh スライス内に実終値がある日だけ
 * (`buildOhlcvRows`)。保存済みの有効値は遡及訂正でも自動では書き換えない。
 * 1 文で全件引く (rows_read は無料枠内。修復が進むほど返る行は減る)。
 */
export async function loadNullCloseDates(
  db: Db
): Promise<Map<number, Set<string>>> {
  const rows = await db
    .select({
      stockId: swingSchema.dailyOhlcv.stockId,
      date: swingSchema.dailyOhlcv.date,
    })
    .from(swingSchema.dailyOhlcv)
    .where(isNull(swingSchema.dailyOhlcv.close));
  const byStock = new Map<number, Set<string>>();
  for (const r of rows) {
    const set = byStock.get(r.stockId);
    if (set === undefined) {
      byStock.set(r.stockId, new Set([r.date]));
    } else {
      set.add(r.date);
    }
  }
  return byStock;
}

/** 過去行不存在の存在確認プローブ (F-09 #163)。 */
export interface OhlcvGapProbe {
  stockId: number;
  date: string;
}

/**
 * fresh スライスから gap 候補日を抜く (純粋関数)。
 * 保持 90 本窓内の watermark 以前日で、新規 (a)・NULL 訂正 (b) のどちらにも
 * 該当しない日。呼び出し側が `loadSavedOhlcvDates` で存在確認し、
 * 未保存の日だけ規則 (c) で回収する。
 */
export function collectOhlcvGapCandidates(
  ohlcv6mo: readonly DailyOhlcv[],
  existingMaxDate: string | undefined,
  correctionDates: ReadonlySet<string> | undefined
): string[] {
  if (existingMaxDate === undefined) return [];
  const window = ohlcv6mo.slice(-OHLCV_RETENTION_DAYS);
  return window
    .map((r) => r.date)
    .filter(
      (d) =>
        d <= existingMaxDate &&
        !(correctionDates?.has(d) ?? false)
    );
}

/**
 * プローブ集合を D1 bind 100/文に収まる chunk へ分ける (純粋関数)。
 * 1 文の bind 数 = 銘柄数 + 日付和集合サイズ。1 銘柄ぶん (1 + 90 以下)
 * は必ず 1 文に収まる (collectOhlcvGapCandidates は窓 90 本以下)。
 */
export interface OhlcvGapChunk {
  stockIds: number[];
  dates: string[];
  wanted: ReadonlySet<string>;
}

export function packOhlcvGapChunks(probes: readonly OhlcvGapProbe[]): OhlcvGapChunk[] {
  const byStock = new Map<number, Set<string>>();
  for (const p of probes) {
    const set = byStock.get(p.stockId);
    if (set === undefined) {
      byStock.set(p.stockId, new Set([p.date]));
    } else {
      set.add(p.date);
    }
  }
  const unionSize = (stocks: ReadonlyMap<number, ReadonlySet<string>>): number => {
    const u = new Set<string>();
    for (const dates of stocks.values()) {
      for (const d of dates) u.add(d);
    }
    return u.size;
  };
  const freeze = (stocks: ReadonlyMap<number, ReadonlySet<string>>): OhlcvGapChunk => {
    const dates = [...new Set([...stocks.values()].flatMap((s) => [...s]))];
    const wanted = new Set<string>();
    for (const [stockId, ds] of stocks) {
      for (const d of ds) wanted.add(`${stockId}|${d}`);
    }
    return { stockIds: [...stocks.keys()], dates, wanted };
  };
  const chunks: OhlcvGapChunk[] = [];
  let cur = new Map<number, ReadonlySet<string>>();
  for (const [stockId, dates] of byStock) {
    const test = new Map(cur);
    test.set(stockId, dates);
    if (test.size + unionSize(test) > 100 && cur.size > 0) {
      chunks.push(freeze(cur));
      cur = new Map();
    }
    cur.set(stockId, dates);
  }
  if (cur.size > 0) chunks.push(freeze(cur));
  return chunks;
}

/**
 * プローブした (stockId, date) のうち保存済みの集合を返す。
 * 日付 IN × 銘柄 IN の直積で引き (100 bind/文の chunk 分割)、JS 側で
 * プローブ集合に絞る (複合 ON の JOIN を持ち込まない。空なら問合せなし)。
 * 既知 empty と未知を区別する: プローブ対象 stock は空 Set を先に作り、
 * 行 0 件でも entry を残す (規則 (c) が発火できる)。プローブなし stock は
 * entry を作らない (savedDates 未指定 = 未知のまま)。
 */
export async function loadSavedOhlcvDates(
  db: Db,
  probes: readonly OhlcvGapProbe[]
): Promise<Map<number, Set<string>>> {
  const out = new Map<number, Set<string>>();
  if (probes.length === 0) return out;
  for (const p of probes) {
    if (!out.has(p.stockId)) out.set(p.stockId, new Set());
  }
  for (const chunk of packOhlcvGapChunks(probes)) {
    const rows = await db
      .select({
        stockId: swingSchema.dailyOhlcv.stockId,
        date: swingSchema.dailyOhlcv.date,
      })
      .from(swingSchema.dailyOhlcv)
      .where(
        and(
          inArray(swingSchema.dailyOhlcv.date, chunk.dates),
          inArray(swingSchema.dailyOhlcv.stockId, chunk.stockIds)
        )
      );
    for (const r of rows) {
      if (!chunk.wanted.has(`${r.stockId}|${r.date}`)) continue;
      out.get(r.stockId)?.add(r.date);
    }
  }
  return out;
}

/**
 * 日次 sync が「株価の日次同期」記録 (Notion) に使う状態を決める (純粋関数)。
 * 取引日を導出できない = 実質全滅なので、失敗件数に関わらず必ず「失敗」にする
 * (取引日不明を「完了」「一部失敗」の顔で見せない — ルール2)。
 */
export function priceSyncStatusOf(args: {
  tradingDate: string | null;
  failedStocks: number;
}): PriceSyncStatus {
  if (args.tradingDate === null) return "失敗";
  return args.failedStocks > 0 ? "一部失敗" : "完了";
}

/**
 * 「株価の日次同期」DB へ今回の実行結果を記録する (docs/005-yuho-quant-business-tags-contract.md
 * 「株価の日次同期」節)。取引日で冪等 upsert。Notion 書込自体の失敗はここでは
 * 握りつぶさない (呼び出し側 = `runDailySync` が成功パス/失敗パスそれぞれで
 * ハンドリングする)。
 */
async function recordPriceSyncCompletion(args: {
  tradingDate: string | null;
  targetStocks: number | null;
  updatedStocks: number | null;
  failedStocks: number | null;
  reason: string | null;
}): Promise<void> {
  const status = priceSyncStatusOf({
    tradingDate: args.tradingDate,
    failedStocks: args.failedStocks ?? 0,
  });
  const { dbId } = await ensurePriceSyncDb();
  await recordPriceSyncLog(dbId, {
    tradingDate: args.tradingDate,
    status,
    completedAt: new Date().toISOString(),
    targetStocks: args.targetStocks,
    updatedStocks: args.updatedStocks,
    failedStocks: args.failedStocks,
    runUrl: sharedEnv.GITHUB_RUN_URL() ?? null,
    reason: args.reason,
  });
}

/**
 * run 全体が例外で落ちたときの失敗記録。件数 (対象/更新/失敗銘柄数) は
 * 例外がどの段階で起きたか次第で分からないため `null` (0 件だったと偽らない)。
 * 記録そのもの (Notion 書込) が失敗しても、元の例外を握りつぶさずログに残すだけに
 * とどめる (呼び出し側は必ず元の例外を rethrow する)。
 */
async function recordPriceSyncFailureSafely(
  cause: unknown,
  mode: PriceSyncBatchMode,
  startedAtMs: number
): Promise<void> {
  try {
    await recordPriceSyncCompletion({
      tradingDate: null,
      targetStocks: null,
      updatedStocks: null,
      failedStocks: null,
      reason: `日次 sync が例外で中断しました: ${rootCauseMessage(cause)}`,
    });
  } catch (recordError) {
    console.error(
      "[sync-daily] 「株価の日次同期」への失敗記録 (Notion) 自体にも失敗しました:",
      recordError
    );
  }
  // 例外時も同一バッチ helper で有限保管する (件数/日付は unknown のまま
  // null。0 件だったと偽らない)。保管自体の失敗はログに残し、元の例外を
  // 握りつぶさない (呼び出し側が必ず元の例外を rethrow する)。
  try {
    const key = await archivePriceSyncBatch({
      mode,
      runId: priceSyncBatchRunId(startedAtMs),
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date().toISOString(),
      tradingDate: null,
      totalStocks: null,
      successStocks: null,
      failedStocks: null,
      failures: [],
      failureCollection: "aborted",
      originalError: rootCauseMessage(cause),
    });
    console.info(`[sync-daily] 失敗バッチ保管 (例外時): ${key}`);
  } catch (archiveError) {
    console.error(
      "[sync-daily] 失敗バッチ保管 (例外時) 自体にも失敗しました:",
      archiveError
    );
  }
}

/**
 * 失敗バッチ保管の失敗分類。実 reason 文字列からのみ導出する
 * (原因不明を一律 genuine にしない — ルール2)。
 */
export type PriceSyncFailureCategory =
  | "genuine_source_gap"
  | "priceguard"
  | "networkparse"
  | "savefailure"
  | "unknown";

export function categorizeSyncFailure(error: string): PriceSyncFailureCategory {
  if (error.includes("10倍超乖離")) return "priceguard";
  if (error.includes("実日足が未取得")) return "genuine_source_gap";
  if (isTransientDailySyncFailure(error)) return "networkparse";
  if (
    /^D1 HTTP|D1 .*error|constraint|UNIQUE|SQLITE|database .*error/i.test(
      error
    )
  ) {
    return "savefailure";
  }
  return "unknown";
}

export type PriceSyncBatchMode = "stocks" | "daily";

export interface PriceSyncBatchInput {
  mode: PriceSyncBatchMode;
  runId: string;
  startedAt: string;
  finishedAt: string;
  tradingDate: string | null;
  totalStocks: number | null;
  successStocks: number | null;
  failedStocks: number | null;
  /** 全件・切詰なし。例外中断時は空 + `failureCollection: "aborted"`。 */
  failures: { code: string; error: string }[];
  failureCollection: "complete" | "aborted";
  originalError: string | null;
}

/** バッチ冪等キー。run 一意 (同一 invocation の success/failure 二重を防ぐ)。 */
export function priceSyncBatchKey(runId: string): string {
  return `price-sync-batch-${runId}`;
}

let cachedBatchRunId: string | null = null;
/**
 * 同一 invocation で安定した run 識別子 (バッチ冪等キーの核)。
 * Actions では runID(.attempt)、ローカルでは run 開始時刻。
 */
export function priceSyncBatchRunId(startedAtMs: number): string {
  if (cachedBatchRunId === null) {
    const id = sharedEnv.GITHUB_RUN_ID();
    if (id === undefined) {
      cachedBatchRunId = `local-${startedAtMs}`;
    } else {
      const attempt = sharedEnv.GITHUB_RUN_ATTEMPT();
      cachedBatchRunId =
        attempt === undefined ? id : `${id}.${attempt}`;
    }
  }
  return cachedBatchRunId;
}
/** テスト用 seam (同一プロセスのテスト間で分離)。 */
export function _resetBatchRunIdForTests(): void {
  cachedBatchRunId = null;
}

/** バッチ JSON の純 builder (切詰なし)。 */
export function buildPriceSyncBatch(input: PriceSyncBatchInput): {
  key: string;
  source: string;
  fetchedAt: string;
  metadata: Record<string, unknown>;
  file: { filename: string; bytes: Uint8Array; contentType: string };
} {
  const categories: Record<PriceSyncFailureCategory, number> = {
    genuine_source_gap: 0,
    priceguard: 0,
    networkparse: 0,
    savefailure: 0,
    unknown: 0,
  };
  for (const f of input.failures) {
    categories[categorizeSyncFailure(f.error)]++;
  }
  const key = priceSyncBatchKey(input.runId);
  const body = {
    service: "stock-sync",
    kind: "price-sync-batch",
    key,
    runId: input.runId,
    mode: input.mode,
    tradingDate: input.tradingDate,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    stats: {
      totalStocks: input.totalStocks,
      successStocks: input.successStocks,
      failedStocks: input.failedStocks,
    },
    failureCollection: input.failureCollection,
    categories,
    failures: input.failures,
    originalError: input.originalError,
    provenance: {
      producer: "runDailySync (Yahoo Chart/QuoteSummary→D1 REST)",
      universe: "core_stocks active+equity (loadDailyTargets)",
      note: "CLI の 20 グループ表示は人間可読の要約。この JSON が切詰なし正本。",
    },
  };
  return {
    key,
    source: "stock-sync runDailySync (Yahoo→D1)",
    fetchedAt: input.finishedAt,
    metadata: {
      mode: input.mode,
      runId: input.runId,
      tradingDate: input.tradingDate,
      totalStocks: input.totalStocks,
      successStocks: input.successStocks,
      failedStocks: input.failedStocks,
      failureCollection: input.failureCollection,
      categories,
    },
    file: {
      filename: `${key}.json`,
      bytes: new TextEncoder().encode(JSON.stringify(body)),
      contentType: "application/json",
    },
  };
}

/**
 * 失敗バッチ 1 件を一次保管する。`recorder` はテスト用 seam。
 *
 * - 成功は `recorded` + `fileTooLarge: false` のときだけ。
 *   `skipped_existing` は先行記録が metadata-only (fileTooLarge 頁) の
 *   可能性があり物理証拠にならないため受け入れず throw する
 *   (完了 fileTooLarge → 例外同キー skip を保管成功と偽らない)。
 *   キーは run 一意のまま (二重記録自体は `force: false` で防ぐ)。
 * - recorder の throw も握りつぶさず throw (fail-closed)。
 *   完了パスでは結果を返さず CLI が非0終了する。例外パスでは呼び出し側が
 *   元の例外を rethrow する (非0は維持・保管完了も主張しない)。
 */
export async function archivePriceSyncBatch(
  input: PriceSyncBatchInput,
  recorder: typeof recordPrimaryData = recordPrimaryData
): Promise<string> {
  const batch = buildPriceSyncBatch(input);
  const res = await recorder({
    service: "stock-sync",
    key: batch.key,
    source: batch.source,
    fetchedAt: batch.fetchedAt,
    metadata: batch.metadata,
    files: [batch.file],
    force: false,
  });
  if (res.fileTooLarge) {
    throw new Error(`失敗バッチ保管が不完全 (fileTooLarge): ${batch.key}`);
  }
  if (res.outcome !== "recorded") {
    throw new Error(
      `失敗バッチ保管が不完全 (outcome=${res.outcome}): ${batch.key}`
    );
  }
  return batch.key;
}

/**
 * 日次 sync 本体
 *
 * @param db createDailyDb() の戻り (Node→D1 HTTP)
 */
export async function runDailySync(
  db: Db,
  options: { stocksOnly?: boolean; collectOverlay?: OverlayCollectFn } = {},
): Promise<DailySyncResult> {
  const startedAtMs = Date.now();
  const mode: PriceSyncBatchMode = options.stocksOnly === true ? "stocks" : "daily";
  try {
    return await runDailySyncAndRecord(
      db,
      options.stocksOnly === true,
      options.collectOverlay
    );
  } catch (e) {
    await recordPriceSyncFailureSafely(e, mode, startedAtMs);
    throw e;
  }
}

async function runDailySyncAndRecord(
  db: Db,
  stocksOnly: boolean,
  collectOverlay?: OverlayCollectFn
): Promise<DailySyncResult> {
  const startedAt = Date.now();
  // 日付キーと週1ゲートは run 開始時刻に固定する (F-05。Phase 実行時刻で
  // 評価し直すと日跨ぎで prune/年次が飢餓し、表の日付がずれる)。
  const { runDate: targetDate, runMonday } = runDateKeys(startedAt);
  // 株式の時間窓・N225 対象日/fresh-close guard は全 stock パス共通
  // (stocksOnly でも default でも同じ。stocksOnly はマクロ有無だけを決める)。
  {
    const utcMinutes = new Date(startedAt).getUTCHours() * 60 + new Date(startedAt).getUTCMinutes();
    if (utcMinutes < 390 || utcMinutes >= 1260) {
      throw new Error("株式同期は東証15:30 JST終了後から翌06:00 JST基準までに実行してください");
    }
    // 日本祝日カレンダーを推測しない。対象日の実日足 (日付 + 実終値) が
    // なければ全書込を止める。日付だけの gate では対象日の fresh null bar が
    // 通過し、古い終値で計算した指標を対象日付で保存してしまう (F-01)。
    const session = await fetchChart("^N225", "1mo");
    const sessionLatest = session.ohlcv.at(-1);
    const sessionFresh = checkFreshClose(sessionLatest, targetDate);
    if (!sessionFresh.ok) {
      const sessionUsedClose = sessionLatest?.adj ?? sessionLatest?.close ?? null;
      throw new Error(
        `株式同期の対象 ${targetDate} の日足を確認できません ` +
        `(日経225実日足=${sessionLatest?.date ?? "未取得"}・実終値=${sessionUsedClose ?? "未取得"})。休場または取得遅延のため書込みを止めます。`
      );
    }
  }

  // -----------------------------------------------------------------
  // Phase 1: スキーマ検証 + 処理対象 (active かつ equity) の取得 + 既存 OHLCV の MAX(date)
  // -----------------------------------------------------------------
  console.info("[sync-daily] Phase 1: ブートストラップ");
  await assertDailySchema(db);
  // 母集団 overlay: target-load 前に公式イベントを適用する (Issue #196)。
  // HOLD 残があれば不完全失敗を throw し、株価 fetch へ進まない。
  const overlay = await ensureUniverseOverlay(db, {
    eligibilityAsOf: targetDate,
    collect:
      collectOverlay ??
      withBasicEvidence((input) => collectUniverseOfficialEvents(input)),
  });
  if (overlay.applied) {
    console.info(
      `[sync-daily]   overlay 適用: delist=${overlay.result?.deactivated} ` +
        `transfer=${overlay.result?.marketUpdated} held=${overlay.result?.heldListingCodes.length}`
    );
  }
  const targets = await loadDailyTargets(db);
  console.info(`[sync-daily]   対象: ${targets.length} 銘柄 (active かつ equity)`);
  // 優良株選定の入力にする正本の年次実績を 1 文で先読みする。
  // jss_financials が無い DB ではここで落ちる (無いまま走ると全銘柄の
  // is_blue_chip が偽で上書きされるので、黙って空扱いにしない)。
  const jssAnnualByCode = await loadJssAnnualMap(db);
  console.info(`[sync-daily]   正本年次: ${jssAnnualByCode.size} 銘柄ぶんを読込`);

  // 増分判定の既存日付は Phase 1 の targets に載っている (latest_date JOIN)。
  // NULL/未登録は初回 backfill (6mo 全 upsert)。
  const latestDateByStock = new Map<number, string>(
    targets.flatMap((t) =>
      t.latestDate === null ? [] : [[t.id, t.latestDate] as const]
    )
  );
  // 保存済み close-NULL 日の訂正再送対象 (F-04)。増分フィルタは保存済み
  // NULL 日を再送しないので明示する。fresh に実終値がある日だけ再送され、
  // 保存済みの有効値は書き換えない。件数は修復が進むほど減る。
  const nullCloseDatesByStock = await loadNullCloseDates(db);
  console.info(
    `[sync-daily]   NULL 訂正対象: ${nullCloseDatesByStock.size} 銘柄`
  );

  // -----------------------------------------------------------------
  // Phase 2: マクロコンテキスト
  // -----------------------------------------------------------------
  console.info(`[sync-daily] Phase 2: マクロコンテキスト${stocksOnly ? "対象外" : "取得"}`);
  const marketContext = stocksOnly ? null : await fetchMarketContextDraft();
  let marketContextOk: boolean | null | undefined = stocksOnly ? null : undefined;
  // Phase 2 では persist しない。回収後の最終 draft を下流で 1 回だけ
  // 保管+保存する (初回保存と回収後保存の集約。銘柄の保存順序は不変)。

  // -----------------------------------------------------------------
  // Phase 3: 銘柄ごとのフェッチ + 計算 + DB 書き込み (worker pool)
  // -----------------------------------------------------------------
  console.info("[sync-daily] Phase 3: 銘柄フェッチ + 計算 + 書き込み");
  const queue = [...targets];
  const firstPassFailures: DailyRecoveryFailure<(typeof targets)[number]>[] =
    [];
  const stockStartGate = createDailyStockStartGate(STOCK_START_INTERVAL_MS);
  let succeeded = 0;

  // 年次は月曜 UTC の run でのみ書く (L-49)。年 1 回変わるものに毎日
  // 15,900 行 upsert していた。曜日の判定は run 開始時刻に固定した
  // runMonday を使う (Phase 実行時刻だと日跨ぎで外れる。F-05)。
  const writeAnnual = runMonday;
  // run 開始秒で固定。entry_signals の INSERT 刻みと Phase 3.5 の sweep 境界
  // (L-52)、および Phase 6 の投影掃除の境界に使う。Phase 3 の upsert より
  // 前の時刻でないと、掃除が今回の行まで消す。
  const runStartedSec = Math.floor(startedAt / 1000);

  // Phase 3a: 取込プール。fetch だけ集め、書込は 3b で表ごとに畳む (L-56)。
  // 取れた snapshot を全部メモリに置く (~3,755 件で数十 MB。runner には十分)。
  const pending: FlushItem<(typeof targets)[number]>[] = [];
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const target = queue.shift();
      if (!target) break;
      try {
        await stockStartGate.wait();
        const snap = await buildSnapshot(target.id, target.code, target.sector,
          targetDate,
          jssAnnualByCode.get(target.code) ?? []);
        pending.push({
          target,
          snap,
          existingMaxDate: latestDateByStock.get(target.id),
          correctionDates: nullCloseDatesByStock.get(target.id),
        });
      } catch (e) {
        const msg = rootCauseMessage(e);
        stockStartGate.observeFailure(msg);
        firstPassFailures.push({ target, error: msg });
      }
      await sleep(DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // Phase 3a.5: 過去行不存在の存在確認 (F-09 #163)。各 snap の保持 90 本窓内
  // の watermark 以前日を 1 文で問い合わせ、FlushItem へ載せる。
  // 候補なし (通常時) は問合せ自体を出さない。
  {
    const probes: OhlcvGapProbe[] = pending.flatMap((p) =>
      collectOhlcvGapCandidates(p.snap.ohlcv6mo, p.existingMaxDate, p.correctionDates).map(
        (date) => ({ stockId: p.snap.stockId, date })
      )
    );
    const saved = await loadSavedOhlcvDates(db, probes);
    for (const p of pending) {
      const set = saved.get(p.snap.stockId);
      if (set !== undefined) p.savedDates = set;
    }
    if (probes.length > 0) {
      console.info(`[sync-daily]   過去行の存在確認: 候補 ${probes.length} (stock,日)`);
    }
  }

  // Phase 3b: 表ごとの multi-row flush。失敗は初回失敗に積んで回収へ回す。
  const flushFailures = await flushSnapshots(db, pending, {
    writeAnnual,
    runStartedSec,
  });
  for (const f of flushFailures) {
    if (f.target !== undefined) {
      stockStartGate.observeFailure(f.error);
      firstPassFailures.push({ target: f.target, error: f.error });
    }
  }
  succeeded += pending.length - flushFailures.length;
  console.info(
    `[sync-daily]   初回成功: ${succeeded} / 初回失敗: ${firstPassFailures.length}`
  );

  const recoveryTargets = prioritizeDailyRecoveryFailures(
    marketContext === null ? [] : marketContext.failures,
    firstPassFailures
  );
  let recoveredStocks = 0;
  const recovery = await recoverTransientDailyFailures(
    recoveryTargets,
    async (recoveryTarget) => {
      try {
        if (recoveryTarget.kind === "macro") {
          if (marketContext === null) throw new Error("株式専用同期でマクロ回収を要求しました");
          await fetchMarketContextTarget(
            marketContext.draft,
            recoveryTarget.target,
            marketContext.collector
          );
          return;
        }
        // 回収は件数が少ないので 1 行 flush のまま (初回パスと行 builder は共有)。
        const target = recoveryTarget.target;
        await stockStartGate.wait();
        const snap = await buildSnapshot(target.id, target.code, target.sector,
          targetDate,
          jssAnnualByCode.get(target.code) ?? []);
        const gapDates = collectOhlcvGapCandidates(
          snap.ohlcv6mo,
          latestDateByStock.get(target.id),
          nullCloseDatesByStock.get(target.id)
        );
        const gapSaved = await loadSavedOhlcvDates(
          db,
          gapDates.map((date) => ({ stockId: target.id, date }))
        );
        await writeStockSnapshot(db, snap, latestDateByStock.get(target.id), {
          writeAnnual,
          runStartedSec,
          correctionDates: nullCloseDatesByStock.get(target.id),
          savedDates: gapSaved.get(target.id),
        });
        recoveredStocks++;
      } catch (error) {
        // 2 パス目も 429 を尊重する (L-57)。初回と同じゲートへ観測を流す。
        stockStartGate.observeFailure(rootCauseMessage(error));
        throw error;
      }
    },
    { deadlineMs: startedAt + RECOVERY_TIME_BUDGET_MS }
  );
  succeeded += recoveredStocks;
  const recoveredMacros = recovery.recovered - recoveredStocks;
  if (recovery.attempted > 0 || recovery.skippedDueToLimit > 0) {
    console.info(
      `[sync-daily]   一過性失敗の回収: 実行=${recovery.attempted} ` +
        `回復=${recovery.recovered} (macro=${recoveredMacros}, stock=${recoveredStocks}) ` +
        `未回復=${recovery.attempted - recovery.recovered + recovery.skippedDueToLimit} ` +
        `予算超過=${recovery.skippedDueToLimit}`
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

  // 最終 draft の保管+保存はここで 1 回だけ (daily/context-only 共通)。
  // HOLD でも実取得の原本は保管する。保管失敗は throw (丸めない)。
  if (marketContext !== null) {
    marketContextOk = await archiveAndPersistMarketContext(
      db,
      startedAt,
      marketContext.draft,
      marketContext.collector
    );
  }

  // -----------------------------------------------------------------
  // Phase 3.5: 前 run 以前の entry_signals を 1 文で掃除 (L-52)。
  // 回収 (recovery) の後。銘柄ごとの DELETE 3,755 文の代替。
  // -----------------------------------------------------------------
  const sweptSignals = await sweepStaleEntrySignals(db, runStartedSec);
  console.info(
    `[sync-daily] Phase 3.5: entry_signals sweep: ${sweptSignals} 行を削除`
  );

  // -----------------------------------------------------------------
  // Phase 4: OHLCV 保持期間の一括 prune (同期が止まった銘柄も対象)。
  // 月曜 UTC の run のみ (L-47)。1 日で増えるのは 1 本/銘柄なので週1で足りる。
  // -----------------------------------------------------------------
  console.info("[sync-daily] Phase 4: OHLCV 保持期間の prune");
  // run 開始時刻の曜日で判定する (Phase 実行時刻だと日跨ぎで skip され飢餓する。F-05)。
  if (runMonday) {
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
  } else {
    console.info("[sync-daily]   月曜のみ (今日はスキップ)");
  }

  // -----------------------------------------------------------------
  // Phase 5: セクター集計 (当日更新済 indicators から・90% カバレッジ guard)
  // -----------------------------------------------------------------
  console.info("[sync-daily] Phase 5: セクター集計");
  // 行キーは実データの取引日 (MAX(latest_date))。実行日キーだと再実行・
  // 休場日に重複 snapshot が増える (F-06)。曜日の推測もカレンダーも使わない。
  const sectorTradingDate = await loadIndicatorsMaxLatestDate(db);
  if (sectorTradingDate === null) {
    console.warn(
      "[sync-daily]   セクター集計スキップ: indicators が空です。" +
        "sector_daily は前回値を保持します。"
    );
  } else {
    await aggregateSectorDaily(db, sectorTradingDate);
  }

  // -----------------------------------------------------------------
  // Phase 6: L2 投影 (p_momentum) の仕上げ
  //
  // 投影行自体は Phase 3 で銘柄ごとに upsert 済み (L-47)。ここでは
  // source_max_date の backfill と掃除 DELETE だけを行う。
  // ここで失敗したら run 全体を失敗にする。掃除が走っていないまま緑にすると、
  // /emh は前日の as_of を表示し続けるのに監視上は成功に見える。
  // -----------------------------------------------------------------
  console.info("[sync-daily] Phase 6: モメンタム投影の仕上げ");
  const projected = await rebuildMomentumProjection(db, runStartedSec);
  console.info(
    `[sync-daily]   投影 ${projected.projectedStocks} 行 (` +
      `as_of 上限 ${projected.sourceMaxDate ?? "—"} / 掃除 ${projected.removedStocks} 行)`
  );

  const elapsedSec = (Date.now() - startedAt) / 1000;
  if (marketContextOk === undefined) throw new Error("マクロ同期結果を確認できません");
  if (Date.now() > Date.parse(`${targetDate}T21:00:00Z`)) {
    throw new Error(
      `株式同期が ${targetDate} の翌06:00 JST基準を超えました。` +
      "基準後の値は過去レポートに使えません。日次レポートの欠損と同期遅延を確認してください。"
    );
  }
  console.info(
    `[sync-daily] 完了: 成功=${succeeded} 失敗=${failures.length} 所要=${elapsedSec.toFixed(1)}s`
  );

  const tradingDate = projected.sourceMaxDate;
  await recordPriceSyncCompletion({
    tradingDate,
    targetStocks: targets.length,
    updatedStocks: succeeded,
    failedStocks: failures.length,
    reason:
      tradingDate === null
        ? `取引日 (swing_daily_ohlcv の MAX(date)) を導出できませんでした ` +
          `(対象 ${targets.length} 銘柄中 成功 ${succeeded} 件・投影仕上げが 0 行でした)`
        : null,
  });

  // 失敗バッチの物理保管。結果 return の前 = CLI の 1% throw の前に完了させる。
  // 保管失敗は結果を返さず throw (例外パスへ。非0・fallback なし)。
  const batchKey = await archivePriceSyncBatch({
    mode: stocksOnly ? "stocks" : "daily",
    runId: priceSyncBatchRunId(startedAt),
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    tradingDate,
    totalStocks: targets.length,
    successStocks: succeeded,
    failedStocks: failures.length,
    failures,
    failureCollection: "complete",
    originalError: null,
  });
  console.info(
    `[sync-daily] 失敗バッチ保管: ${batchKey} (全${failures.length}件・切詰なし)`
  );

  return {
    totalStocks: targets.length,
    successStocks: succeeded,
    failedStocks: failures.length,
    marketContextOk,
    elapsedSec,
    failures,
    tradingDate,
    batchKey,
  };
}

/** 米国市場の取引終了後にマクロだけ同期。銘柄全量・株価同期完了記録は触らない。 */
export async function runMarketContextSync(db: Db): Promise<boolean> {
  const startedAt = Date.now();
  const ny = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(startedAt)).map((part) => [part.type, part.value]));
  const nyMinutes = Number(ny.hour) * 60 + Number(ny.minute);
  if (["Mon", "Tue", "Wed", "Thu", "Fri"].includes(ny.weekday) &&
      nyMinutes >= 570 && nyMinutes < 960) {
    throw new Error("米国市場の取引中です。マクロ専用同期は通常市場終了後に実行してください");
  }
  const context = await fetchMarketContextDraft();
  const recovery = await recoverTransientDailyFailures(
    context.failures,
    (target) => fetchMarketContextTarget(context.draft, target, context.collector),
    { deadlineMs: startedAt + RECOVERY_TIME_BUDGET_MS },
  );
  for (const failure of recovery.failures) {
    console.warn(`[sync-context] マクロ未回復 ${failure.target}:`, failure.error);
  }
  return archiveAndPersistMarketContext(db, startedAt, context.draft, context.collector);
}

/**
 * indicators の MAX(latest_date) を 1 文で引く (Phase 5 の行キー用)。
 *
 * 集計対象の実データ日付そのもの。休場日・再実行でも実データの取引日に
 * 揃うため、実行日キーで起きる重複 snapshot (F-06) にならない。
 * Phase 3 が全滅なら前回値の日付が返り、カバレッジ guard が skip する。
 * indicators が空なら null (呼び出し側が skip する)。
 */
export async function loadIndicatorsMaxLatestDate(db: Db): Promise<string | null> {
  const rows = await db
    .select({ maxDate: sql<string | null>`MAX(${swingSchema.stockIndicators.latestDate})` })
    .from(swingSchema.stockIndicators);
  return rows[0]?.maxDate ?? null;
}

/**
 * Phase 5: 業種騰落ランキング (`swing_sector_daily`) を `today` の日付で書き直す。
 *
 * `today` には実データの取引日 (MAX(latest_date)) を渡す。実行日を渡すと
 * 再実行・休場日に重複 snapshot が増える (F-06)。
 * 当日更新済みの indicators だけを集計し、カバレッジが 90% 未満なら書かない
 * (大量失敗の日に一部銘柄だけの平均で前日分を上書きしないため)。
 *
 * ### 集約キーは `publicSectorColumn` (2026-09-13 に `core_stocks.sector` から移した)
 *
 * この表は公開面 `GET /swing-trading/` がそのまま業種名として表示する
 * **保存済みの派生コピー**で、core_stocks を読み直さないため
 * src/shared/db/public-columns.ts のフラグが読み側では届かない。
 * 旧コードは JPX の 33 業種 (`core_stocks.sector`, personal-only) をキーに
 * していたので、公開面ではフラグで表示ごと閉じていた (PR #24)。
 * 書く側で公開面と同じ列を選べば、保存される値の出所がフラグと一致する。
 *
 * - フラグ (`PUBLISH_JPX_DERIVED_COLUMNS`) が false → `core_stocks.sector33`
 *   (EDINET 提出者業種 / commercial-ok)。戻すときもフラグ 1 箇所。
 * - `sector33` が NULL の銘柄は `aggregateSectors` が `未分類` にまとめる。
 *   EDINET の提出者業種を持たない REIT・インフラファンド等は、下の母集団の述語で
 *   先に外れる (本番 2026-09-24: active かつ equity で `sector33` が NULL は 0 銘柄)。
 *   **JPX の `sector` へフォールバックしない** —— フォールバックすると
 *   `sector33` に値が無い銘柄の分だけ JPX の業種名が表に保存され、公開面に出る。
 *
 * rows_read は変わらない: 同じ join で select する列が 1 本入れ替わるだけ
 * (本番の実測で `sector` / `sector33` どちらも 7,430 rows_read、同じ実行計画)。
 *
 * 切り替え前の JPX キー行は P5 で DELETE 済み (L-64)。
 *
 * **分母と分子は同じ述語を使う** (`activeEquityCondition` = active かつ equity。
 * 日次の処理対象 `loadDailyTargets` と同じ集合)。分母は「当日更新されるはずの
 * 銘柄数」なので、日次が更新しない銘柄を数えるとカバレッジが構造的に下がる。
 * P4b (+725 行) の後に分母を is_active のままにすると、3,700/4,434=83.4% で
 * 毎日スキップされる。分子も同じ述語にしておかないと、分母に居ない銘柄を分子が
 * 数えうる (カバレッジが 100% を超える / 業種や `未分類` に非普通株が混ざる)。
 *
 * @returns 書いた業種数。カバレッジ不足でスキップしたら `null`。
 */
export async function aggregateSectorDaily(
  db: Db,
  today: string
): Promise<number | null> {
  const [{ activeCount }] = await db
    .select({ activeCount: sql<number>`count(*)` })
    .from(coreSchema.stocks)
    .where(activeEquityCondition());

  const indicatorRows = await db
    .select({
      sector: publicSectorColumn,
      pct1d: swingSchema.stockIndicators.pctChange1d,
    })
    .from(coreSchema.stocks)
    .innerJoin(
      swingSchema.stockIndicators,
      eq(swingSchema.stockIndicators.stockId, coreSchema.stocks.id)
    )
    .where(
      and(
        activeEquityCondition(),
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
    return null;
  }

  const sectorAggs = aggregateSectors(
    indicatorRows.map(
      (r): StockChangeInput => ({
        sector: r.sector,
        pct1d: r.pct1d,
      })
    )
  );
  // 当日分の書き直し + 30 日より古い行の破棄 (L-53。読み手は最新日だけ見る)。
  // 基準は引数の today (Date.now ではない。テストで固定できる)。
  const retentionCutoff = new Date(
    new Date(`${today}T00:00:00Z`).getTime() - 30 * 24 * 60 * 60 * 1000
  )
    .toISOString()
    .split("T")[0];
  await db.delete(swingSchema.sectorDaily).where(
    or(
      eq(swingSchema.sectorDaily.date, today),
      lt(swingSchema.sectorDaily.date, retentionCutoff)
    )
  );
  for (let i = 0; i < sectorAggs.length; i += SECTOR_CHUNK) {
    await db.insert(swingSchema.sectorDaily).values(
      sectorAggs.slice(i, i + SECTOR_CHUNK).map((a) => ({
        date: today,
        sector: a.sector,
        pct1d: a.pct1d,
        stockCount: a.stockCount,
        rank1d: a.rank1d,
      }))
    );
  }
  return sectorAggs.length;
}

// -----------------------------------------------------------------------------
// 銘柄ごとの snapshot 構築 (純計算)
// -----------------------------------------------------------------------------

async function buildSnapshot(
  stockId: number,
  code: string,
  sector: string | null,
  expectedDate: string,
  jssAnnualRows: JssAnnualRow[] = [],
): Promise<StockSnapshot> {
  // 1 回の Chart(5y) + QuoteSummary で全指標を賄う
  const raw = await fetchStockRawData(code, "5y");

  // -- 6mo スライス (swing 用指標の入力。fresh gate の対象もここ) --
  const ohlcv6mo = raw.ohlcv.slice(-130);
  // 日付一致だけでなく対象日の実終値 (adj ?? close) も要求する。
  // 対象日の fresh null bar を日付だけで合格にすると、古い終値で計算した
  // 指標を対象日付で保存してしまう (F-01)。正当な欠損は未取得扱いにし、
  // 値の補完はしない (ルール2)。RSI を含む全 technical 計算の前に落とす。
  // expectedDate は必須 (全 stock パス共通)。dataDate への黙殺代替なし。
  const fresh = checkFreshClose(ohlcv6mo.at(-1), expectedDate);
  if (!fresh.ok) {
    throw new Error(`${code}: 対象 ${expectedDate} の実日足が未取得です。古い日の指標を書き直しません。`);
  }

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
  // 優良株選定の年度売上は正本の年次系列 (001 銘柄詳細と共用の gate で整形)。
  // Yahoo 年次 (raw.annualFinancials) は旧表の writer にだけ残す。
  // TTM 営業利益率は Yahoo のまま (単年 jss 値に置き換えると定義が変わる)。
  const annualSeries = pickAnnualSeries(jssAnnualRows, expectedDate);
  const blueChip = evaluateBlueChip(annualSeries, raw.operatingMarginTtm);

  // -- 6mo スライス → swing 用指標 —— adjclose ベースで分割歪みを除去 --
  // (ohlcv6mo と fresh gate は fetch 直後へ移動済み。全 technical 計算の前)
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
    // fresh gate が latest 行・日付 = expectedDate を証明済み。
    // dataDate への代替は置かない (dataDate は quote metadata として別保持)。
    latestDate: expectedDate,
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
    // 旧表 (core_stock_annual_financials) の writer 用に Yahoo 年次を残す。
    // 優良株選定は上の annualSeries (正本) を使う。旧表は外部 consumer
    // (YouTube/新高値検証) が残るので書き続け、DROP は宣言しない。
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
 * `writeStockSnapshot` の書き込み範囲スイッチ。将来 ②断面の writer が移る場合に
 * 呼び出し側で止められる形 (両者が同じ 1 行を upsert すると実行順で値が決まる)。
 */
export interface WriteStockSnapshotOptions {
  /**
   * ②断面 (`core_stock_financials`) を書くか。既定 true。
   * 年次は対象外 (別出所のため一緒に止めると売上推移が止まる)。
   */
  writeCoreFinancials?: boolean;
  /**
   * 年次 (`core_stock_annual_financials`) を書くか。既定 true。
   *
   * 年 1 回変わるものに毎日 15,900 行 upsert していたので、月曜 UTC の run
   * でのみ真にする (L-49)。呼び出し側 (Phase 3) が曜日で決める。
   */
  writeAnnual?: boolean;
  /**
   * run 開始時刻 (unix 秒)。`swing_entry_signals` の INSERT に刻む。
   *
   * 銘柄ごとの無条件 DELETE (3,755 文/日) の代わりに、Phase 3 末尾で
   * `computed_at < runStartedSec` を 1 文で掃除する (L-52)。既定は呼び出し
   * 時の現在秒 (テスト用。本番は Phase 3 が run 開始秒を渡す)。
   */
  runStartedSec?: number;
  /**
   * 保存済み close-NULL 日の訂正再送対象 (F-04)。1 行 flush (回収パス) 用。
   * 複数行 flush は `FlushItem.correctionDates` を使う。省略時は新規日のみ。
   */
  correctionDates?: ReadonlySet<string>;
  /**
   * 存在確認済みの保存済み日付 (F-09 #163)。1 行 flush (回収パス) 用。
   * 複数行 flush は `FlushItem.savedDates` を使う。省略時は規則 (c)
   * (過去行不存在の回収) を発火させない (旧動作)。
   */
  savedDates?: ReadonlySet<string>;
}

// -----------------------------------------------------------------------------
// 表ごとの multi-row upsert (L-56)。
//
// 銘柄ごと 7〜8 文 (27.9k 往復/日) を、表ごとに VALUES 複数行へ畳む (~3.7k 往復)。
// 行 builder は writeStockSnapshot と flushSnapshots の共有 (1 行 flush が
// 旧 writeStockSnapshot と同じ文になるので、既存テストがそのまま通る)。
// -----------------------------------------------------------------------------

export interface FlushItem<T = unknown> {
  /** 失敗の帰属先 (回収がこの単位でリトライする)。1 行 flush では省略。 */
  target?: T;
  snap: StockSnapshot;
  existingMaxDate: string | undefined;
  /**
   * 保存済み close-NULL 日の訂正再送対象 (F-04。`loadNullCloseDates`)。
   * fresh スライス内に実終値がある日だけ再送する。省略時は新規日のみ。
   */
  correctionDates?: ReadonlySet<string>;
  /**
   * 存在確認済みの保存済み日付 (F-09 #163。`loadSavedOhlcvDates`)。
   * watermark 以前の穴のうち保持 90 本窓内かつ未保存の日を回収する。
   * 省略時は回収しない (旧動作。未知を未保存とみなさない)。
   */
  savedDates?: ReadonlySet<string>;
}

export interface FlushFailure<T = unknown> {
  target: T | undefined;
  error: string;
}

type BuiltRow<R> = { item: FlushItem<never>; row: R };

function buildAnnualRows(
  item: FlushItem<never>,
  writeAnnual: boolean
): BuiltRow<{ stockId: number; fiscalYear: number; revenue: number | null }>[] {
  if (!writeAnnual || item.snap.annualFinancials.length === 0) return [];
  return item.snap.annualFinancials.map((f) => ({
    item,
    row: { stockId: item.snap.stockId, fiscalYear: f.fiscalYear, revenue: f.revenue },
  }));
}

function buildFinancialsRows(
  item: FlushItem<never>,
  writeCoreFinancials: boolean
): BuiltRow<Record<string, unknown>>[] {
  if (!writeCoreFinancials) return [];
  const snap = item.snap;
  return [
    {
      item,
      row: {
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
      },
    },
  ];
}

function buildRsiRows(item: FlushItem<never>): BuiltRow<Record<string, unknown>>[] {
  const snap = item.snap;
  return [
    {
      item,
      row: {
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
        revenueTrend: snap.blueChip.revenueTrend,
      },
    },
  ];
}

function buildOhlcvRows(
  item: FlushItem<never>
): BuiltRow<Record<string, unknown>>[] {
  const { snap, existingMaxDate, correctionDates, savedDates } = item;
  // 保持 90 本窓の下端 (prune が残す範囲。窓外の不存在は復活させない)。
  const keepFrom =
    snap.ohlcv6mo.length > OHLCV_RETENTION_DAYS
      ? snap.ohlcv6mo[snap.ohlcv6mo.length - OHLCV_RETENTION_DAYS].date
      : null;
  const newOhlcv = existingMaxDate
    ? snap.ohlcv6mo.filter(
        (r) =>
          r.date > existingMaxDate ||
          // 保存済み NULL 日の訂正再送 (F-04)。fresh に実終値がある日だけ
          // (fresh も null の日は NULL のまま正直に残す)。保存済みの有効値は
          // 遡及訂正でも自動では書き換えない (別途 raw 証跡つき修復)。
          (r.close !== null && (correctionDates?.has(r.date) ?? false)) ||
          // 過去行不存在の回収 (F-09 #163)。watermark 以前の穴のうち、
          // 保持 90 本窓内かつ存在確認で未保存の日だけ送る (存在確認済みの
          // ため保存済み有効値の書換えは起きない)。savedDates 未指定 (未知)
          // は未保存とみなさず発火させない。窓外は prune 済みのため送らない。
          // 訂正対象日は除外する (F-04 の管轄。fresh null の日に規則 (c) が
          // 発火すると既存 NULL 行を fresh NULL で上書きしてしまう)。
          (r.date <= existingMaxDate &&
            (keepFrom === null || r.date >= keepFrom) &&
            !(correctionDates?.has(r.date) ?? false) &&
            savedDates !== undefined &&
            !savedDates.has(r.date))
      )
    : snap.ohlcv6mo;
  return newOhlcv.map((r) => ({
    item,
    row: {
      stockId: snap.stockId,
      date: r.date,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      adj: r.adj,
    },
  }));
}

function buildIndicatorRows(
  item: FlushItem<never>
): BuiltRow<Record<string, unknown>>[] {
  const snap = item.snap;
  // screenStock() は indicators 6 値の純関数。旧 swing_stock_screening 表と
  // 同じ値を同じ run で書くので、表示される数値は変わらない。
  const screen = screenStock({
    avgTurnover20d: snap.avgTurnover20d,
    volumeRatio: snap.volumeRatio,
    atrPct: snap.atrPct,
    sma5: snap.sma5,
    sma20: snap.sma20,
    latestClose: snap.latestClose,
  });
  return [
    {
      item,
      row: {
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
        liquidityOk: screen.liquidityOk,
        volatilityOk: screen.volatilityOk,
        trendOkLong: screen.trendOkLong,
        trendOkShort: screen.trendOkShort,
        allPassedLong: screen.allPassedLong,
        allPassedShort: screen.allPassedShort,
      },
    },
  ];
}

function buildSignalRows(
  item: FlushItem<never>,
  runStartedSec: number
): BuiltRow<Record<string, unknown>>[] {
  const snap = item.snap;
  if (snap.latestClose === null) return [];
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
  return signals.map((s) => ({
    item,
    row: {
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
      // sweep が「この run の行」と判定する刻み。秒の一致は「残す」側。
      computedAt: new Date(runStartedSec * 1000),
    },
  }));
}

function buildMomentumRows(
  item: FlushItem<never>
): BuiltRow<Record<string, unknown>>[] {
  // Phase 6 の D1 読み直しの代わりに、メモリ上の 6mo スライスから upsert。
  // 同じ入力・同じ関数 (buildMomentumRow) なので /emh の数値は不変。
  // source_max_date は暫定で自銘柄の最新日、Phase 6 で全体 MAX に直す。
  const row = buildMomentumRow(item.snap.ohlcv6mo);
  if (row === null) return [];
  return [
    {
      item,
      row: {
        stockId: item.snap.stockId,
        asOf: row.asOf,
        bars: row.bars,
        closes: row.closes,
        sourceMaxDate: item.snap.latestDate,
        computedAt: new Date(),
      },
    },
  ];
}

/**
 * 表ごとの multi-row upsert 1 仕様。行の組み立て (build) と書込 (upsert) を分ける。
 */
interface TableFlushSpec {
  rowsPerStatement: number;
  build: (item: FlushItem<never>) => BuiltRow<Record<string, unknown>>[];
  upsert: (db: Db, rows: Record<string, unknown>[]) => Promise<void>;
}

/**
 * 複数銘柄の snapshot を表ごとにまとめて書く (L-56)。
 *
 * 失敗の扱いは旧 writeStockSnapshot と同じ粒度にする: チャンク単位で
 * try/catch し、落ちたチャンクの銘柄だけを失敗として返して続行する。
 * upsert は冪等なので、回収がその銘柄を全表で書き直しても壊れない。
 * 1 行 flush は旧 writeStockSnapshot と同じ文になる。
 *
 * @returns 失敗した銘柄 (target 付き)。空なら全件成功。
 */
export async function flushSnapshots<T>(
  db: Db,
  items: FlushItem<T>[],
  options: WriteStockSnapshotOptions = {}
): Promise<FlushFailure<T>[]> {
  const { writeCoreFinancials = true, writeAnnual = true } = options;
  const runStartedSec =
    options.runStartedSec ?? Math.floor(Date.now() / 1000);
  if (items.length === 0) return [];

  const specs: TableFlushSpec[] = [
    {
      rowsPerStatement: FLUSH_ROWS_PER_STATEMENT.annual,
      build: (item) =>
        buildAnnualRows(
          item as FlushItem<never>,
          writeAnnual
        ) as BuiltRow<Record<string, unknown>>[],
      upsert: (db, rows) =>
        db
          .insert(coreSchema.stockAnnualFinancials)
          .values(
            rows as {
              stockId: number;
              fiscalYear: number;
              revenue: number | null;
            }[]
          )
          .onConflictDoUpdate({
            target: [
              coreSchema.stockAnnualFinancials.stockId,
              coreSchema.stockAnnualFinancials.fiscalYear,
            ],
            set: { revenue: sql`excluded.revenue` },
          })
          .then(() => undefined),
    },
    {
      rowsPerStatement: FLUSH_ROWS_PER_STATEMENT.financials,
      build: (item) =>
        buildFinancialsRows(item as FlushItem<never>, writeCoreFinancials),
      upsert: (db, rows) =>
        db
          .insert(coreSchema.stockFinancials)
          .values(rows as never[])
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
          })
          .then(() => undefined),
    },
    {
      rowsPerStatement: FLUSH_ROWS_PER_STATEMENT.rsi,
      build: (item) => buildRsiRows(item as FlushItem<never>),
      upsert: (db, rows) =>
        db
          .insert(rsiSchema.stockRsiPercentile)
          .values(rows as never[])
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
              revenueTrend: sql`excluded.revenue_trend`,
              computedAt: sql`(unixepoch())`,
            },
          })
          .then(() => undefined),
    },
    {
      rowsPerStatement: FLUSH_ROWS_PER_STATEMENT.ohlcv,
      build: (item) => buildOhlcvRows(item as FlushItem<never>),
      upsert: (db, rows) =>
        db
          .insert(swingSchema.dailyOhlcv)
          .values(rows as never[])
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
          })
          .then(() => undefined),
    },
    {
      rowsPerStatement: FLUSH_ROWS_PER_STATEMENT.indicators,
      build: (item) => buildIndicatorRows(item as FlushItem<never>),
      upsert: (db, rows) =>
        db
          .insert(swingSchema.stockIndicators)
          .values(rows as never[])
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
              liquidityOk: sql`excluded.liquidity_ok`,
              volatilityOk: sql`excluded.volatility_ok`,
              trendOkLong: sql`excluded.trend_ok_long`,
              trendOkShort: sql`excluded.trend_ok_short`,
              allPassedLong: sql`excluded.all_passed_long`,
              allPassedShort: sql`excluded.all_passed_short`,
              computedAt: sql`(unixepoch())`,
            },
          })
          .then(() => undefined),
    },
    {
      rowsPerStatement: FLUSH_ROWS_PER_STATEMENT.signals,
      build: (item) =>
        buildSignalRows(item as FlushItem<never>, runStartedSec),
      upsert: (db, rows) =>
        db
          .insert(swingSchema.entrySignals)
          .values(rows as never[])
          .then(() => undefined),
    },
    {
      rowsPerStatement: FLUSH_ROWS_PER_STATEMENT.momentum,
      build: (item) => buildMomentumRows(item as FlushItem<never>),
      upsert: (db, rows) =>
        db
          .insert(projectionSchema.momentumProjection)
          .values(rows as never[])
          .onConflictDoUpdate({
            target: projectionSchema.momentumProjection.stockId,
            set: {
              asOf: sql`excluded.as_of`,
              bars: sql`excluded.bars`,
              closes: sql`excluded.closes`,
              sourceMaxDate: sql`excluded.source_max_date`,
              computedAt: sql`excluded.computed_at`,
            },
          })
          .then(() => undefined),
    },
  ];

  const failed = new Map<FlushItem<T>, FlushFailure<T>>();
  const failItems = (chunk: BuiltRow<Record<string, unknown>>[], error: unknown) => {
    const message = rootCauseMessage(error);
    for (const { item } of chunk) {
      if (!failed.has(item as FlushItem<T>)) {
        failed.set(item as FlushItem<T>, {
          target: (item as FlushItem<T>).target,
          error: message,
        });
      }
    }
  };

  for (const spec of specs) {
    // 行の組み立ては銘柄ごとに隔離する (旧 writeStockSnapshot は銘柄単位で
    // throw していた。1 銘柄の変な値で 3,755 件道連れは出さない)。
    const built: BuiltRow<Record<string, unknown>>[] = [];
    for (const item of items) {
      if (failed.has(item)) continue;
      try {
        built.push(...spec.build(item as FlushItem<never>));
      } catch (error) {
        failItems([{ item: item as FlushItem<never>, row: {} }], error);
      }
    }
    for (let i = 0; i < built.length; i += spec.rowsPerStatement) {
      const chunk = built.slice(i, i + spec.rowsPerStatement);
      try {
        await spec.upsert(
          db,
          chunk.map((b) => b.row)
        );
      } catch (error) {
        failItems(chunk, error);
      }
    }
  }
  return [...failed.values()];
}

// export しているのは回収パスとテストから 1 行 flush として使うため。
// 初回パスは flushSnapshots を直接叩く (L-56)。
export async function writeStockSnapshot(
  db: Db,
  snap: StockSnapshot,
  existingMaxDate: string | undefined,
  options: WriteStockSnapshotOptions = {}
): Promise<void> {
  // 1 行 flush。回収パスとテストが使う。失敗したら throw (旧動作と同じ)。
  const failed = await flushSnapshots(
    db,
    [
      {
        snap,
        existingMaxDate,
        correctionDates: options.correctionDates,
        savedDates: options.savedDates,
      },
    ],
    options
  );
  if (failed.length > 0) throw new Error(failed[0].error);
}

/**
 * 前 run 以前の `swing_entry_signals` 行を 1 文で掃除する (L-52)。
 *
 * 銘柄ごとの無条件 DELETE (3,755 文/日) の代替。`writeStockSnapshot` は
 * INSERT のみで run 開始秒を刻むので、ここではそれより古い行だけ消す。
 * 境界 (`computed_at == runStartedSec`) は残す。取得失敗で INSERT が無かった
 * 銘柄の前日シグナルも消える (鮮度のない値を出さない。J3)。
 * `idx_swing_signals_computed` を使う。run が途中で落ちて sweep まで届かなくても、
 * 次 run の sweep が古い行をまとめて消す (自己修復)。
 *
 * @returns 削除行数 (事前 COUNT。pruneOhlcvRetention と同じ方式)
 */
export async function sweepStaleEntrySignals(
  db: Db,
  runStartedSec: number
): Promise<number> {
  const cutoff = new Date(runStartedSec * 1000);
  const [{ stale }] = await db
    .select({ stale: sql<number>`count(*)` })
    .from(swingSchema.entrySignals)
    .where(lt(swingSchema.entrySignals.computedAt, cutoff));
  if (stale > 0) {
    await db
      .delete(swingSchema.entrySignals)
      .where(lt(swingSchema.entrySignals.computedAt, cutoff));
  }
  return stale;
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
// L2 投影 (p_momentum) の生成。画面の全走査を「1 日 1 回」の cron 生成へ移し、
// 画面は 1 銘柄 1 行の投影だけを読む。新しい cron は足さず日次 sync に相乗り。
//
// 生成は 2 段:
//   1. `writeStockSnapshot` が `snap.ohlcv6mo` の末尾 90 本から 1 文 upsert。
//      `source_max_date` は暫定で自銘柄の最新日、Phase 6 で全体 MAX に直す。
//   2. Phase 6 (`rebuildMomentumProjection`) は MAX(date) 1 文 +
//      source_max_date の backfill + 掃除 DELETE だけを行う。
//
// メモリ build が D1 読み直しと一致する根拠: 読む列は遡及修正されない生 `close`、
// 窓は prune 後と同じ末尾 90 本、ソート・usable 判定・encode は同じ関数。
// 失敗した銘柄の行は掃除 DELETE で消える (/emh は欠けた分だけ件数が減る)。
// -----------------------------------------------------------------------------

/** 投影 1 行に入れる終値の本数。prune の保持本数と一致させる。 */
const PROJECTION_BARS = 90;

/** 投影仕上げの結果 (コスト実測をログへ出すために行数を返す) */
export interface MomentumProjectionResult {
  /** 今 run に upsert された投影行数 (computed_at で数える) */
  projectedStocks: number;
  /** 読み出した swing_daily_ohlcv の返却行数。L-47 以降は常に 0 (読み直さない)。 */
  scannedBars: number;
  /** OHLCV 全体の MAX(date)。1 行も無ければ null */
  sourceMaxDate: string | null;
  /** 母集団から落ちて掃除した投影行数 */
  removedStocks: number;
}

/**
 * メモリ上の OHLCV から投影 1 行分を作る (純関数)。
 *
 * 末尾 90 本を取り、日付順に並べ、使える終値だけ残す。D1 読み直しと同じ
 * 順序・同じ述語なので、同じ入力なら同じ行になる。有効な終値が 1 本も無ければ
 * null (その銘柄は投影しない。D1 読み直し版の `usable.length === 0` continue
 * と同じ)。
 */
export function buildMomentumRow(
  ohlcv: ReadonlyArray<{ date: string; close: number | null }>
): { asOf: string; bars: number; closes: string } | null {
  const tail = ohlcv.slice(-PROJECTION_BARS);
  const sorted = [...tail].sort((a, b) => (a.date < b.date ? -1 : 1));
  const usable = sorted.filter((b) => isUsableClose(b.close));
  if (usable.length === 0) return null;
  const last = usable[usable.length - 1] as { date: string; close: number };
  return {
    asOf: last.date,
    bars: usable.length,
    closes: encodeCloses(usable.map((b) => b.close)),
  };
}

/**
 * `p_momentum` の仕上げ: source_max_date の backfill + 掃除 DELETE。
 *
 * 投影行自体は Phase 3 で銘柄ごとに upsert 済み。ここでは全体の MAX(date) を
 * 1 文で引いて全行へ backfill し、「今回の run で触られなかった行」を 1 文の
 * DELETE で落とす。
 *
 * @param runStartedSec run 開始時刻 (unix 秒)。Phase 3 の upsert より前で
 *   ないと掃除が今回の行まで消すので、呼び出し側が run 開始時に取る。
 *
 * 全消し → 全挿入は採らなかった (書込 2 倍)。upsert + 掃除 DELETE で
 * 観測できる結果 (孤児行が残らない) は同じ。
 *
 * 途中で例外が出た場合、掃除 DELETE は走らないので古い行が残る。その行は
 * `as_of` が進まないので画面側で古さとして見える (黙って新しいふりをしない)。
 */
export async function rebuildMomentumProjection(
  db: Db,
  runStartedSec: number
): Promise<MomentumProjectionResult> {
  const projection = projectionSchema.momentumProjection;

  // 母集団 = /emh が分母に使っているのと同じ active かつ equity の集合
  // (src/shared/db/active-equity.ts)。
  const activeIds = new Set(
    (
      await db
        .select({ id: coreSchema.stocks.id })
        .from(coreSchema.stocks)
        .where(activeEquityCondition())
    ).map((r) => r.id)
  );

  if (activeIds.size === 0) {
    // active かつ equity の銘柄が 1 件も返らないのは「母集団が空になった」ではなく
    // core_stocks 側の異常である (is_active の一括対象外化、instrument_type の
    // 充填が消えた等)。このまま進むと下の掃除 DELETE が**投影を全消し**する。
    // /emh は理由を出せないまま「該当 0 件」になる (maxBars=0 なので window 超過の
    // notice も出ない)。静かに返さず run を失敗させる。
    throw new Error(
      "投影の母集団が空です: core_stocks に is_active=1 かつ instrument_type='equity' の行が 1 件もありません。" +
        " 投影を全消しすると /emh が理由なしの 0 件になるので中断します。"
    );
  }

  // 今 run に触られた行数。0 = Phase 3 が全滅か新冠で、掃除すると全消しに
  // なるので何もせず返す (旧「OHLCV 空」ガードと同じ役割)。
  const runStarted = new Date(runStartedSec * 1000);
  const [{ freshCount }] = await db
    .select({ freshCount: sql<number>`count(*)` })
    .from(projection)
    .where(gte(projection.computedAt, runStarted));
  if (freshCount === 0) {
    return {
      projectedStocks: 0,
      scannedBars: 0,
      sourceMaxDate: null,
      removedStocks: 0,
    };
  }

  // 全体の MAX(date) を 1 文で引く (covering index の seek)。
  const maxRows = await db
    .select({ maxDate: sql<string | null>`MAX(${swingSchema.dailyOhlcv.date})` })
    .from(swingSchema.dailyOhlcv);
  const sourceMaxDate = maxRows[0]?.maxDate ?? null;
  if (sourceMaxDate === null) {
    // OHLCV が 1 行も無い (= 初回 backfill 前)。何も触らずに返す。
    return {
      projectedStocks: 0,
      scannedBars: 0,
      sourceMaxDate: null,
      removedStocks: 0,
    };
  }

  // 今 run の行へ全体 MAX を backfill する。
  await db
    .update(projection)
    .set({ sourceMaxDate })
    .where(gte(projection.computedAt, runStarted));

  // 掃除: 今回の run で触られなかった行 (母集団落ち + 今回失敗) を落とす。
  // 時刻の直接比較で十分 (computed_at は run ごとに進む単調時計)。
  const staleBefore = new Date((runStartedSec - 1) * 1000);
  const [{ staleCount }] = await db
    .select({ staleCount: sql<number>`count(*)` })
    .from(projection)
    .where(lte(projection.computedAt, staleBefore));
  if (staleCount > 0) {
    await db.delete(projection).where(lte(projection.computedAt, staleBefore));
  }

  return {
    projectedStocks: freshCount,
    scannedBars: 0,
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
      "^N225": { price: null, prevClose: null, date: null },
      "^VIX": { price: null, prevClose: null, date: null },
      "^GSPC": { price: null, prevClose: null, date: null },
      "NIY=F": { price: null, prevClose: null, date: null },
    },
    nikkeiVi: null,
    nikkeiViDate: null,
  };
}

/**
 * 原本 collector へ 1 attempt を追記する。回収 attempt は別番号で保持し、
 * 初回原本を上書きしない。body が無い通信失敗も理由つきで記録する。
 */
async function collectMacroRawAttempt(
  collector: MacroRawAttempt[],
  target: MarketContextTarget,
  requestedAt: string,
  capture: { status: number; bytes: Uint8Array } | null,
  noBodyReason: string | null
): Promise<void> {
  const attempt = collector.filter((a) => a.target === target).length;
  collector.push({
    target,
    attempt,
    requestedAt,
    completedAt: new Date().toISOString(),
    status: capture?.status ?? null,
    bytes: capture ? new Uint8Array(capture.bytes) : null,
    sha256: capture ? await sha256HexBytes(Uint8Array.from(capture.bytes)) : null,
    noBodyReason: capture ? null : (noBodyReason ?? "body なし (onRaw 未発火)"),
  });
}

async function fetchMarketContextTarget(
  draft: MarketContextDraft,
  target: MarketContextTarget,
  collector: MacroRawAttempt[]
): Promise<void> {
  const requestedAt = new Date().toISOString();
  if (target === NIKKEI_VI_TARGET) {
    let capture: { status: number; bytes: Uint8Array } | null = null;
    try {
      const snapshot = await fetchNikkeiVi({
        onRaw: (cap) => {
          capture = cap;
        },
      });
      await collectMacroRawAttempt(collector, target, requestedAt, capture, null);
      if (capture === null) {
        console.warn(
          `[sync-daily]   マクロ対象 ${target}: 原文 capture が無いため採用しません。保存時に HOLD します。`
        );
        return;
      }
      draft.nikkeiVi = snapshot.price;
      draft.nikkeiViDate = snapshot.date;
    } catch (error) {
      await collectMacroRawAttempt(
        collector,
        target,
        requestedAt,
        capture,
        `取得失敗 (body ${capture ? "あり" : "なし"}): ${rootCauseMessage(error)}`
      );
      throw error;
    }
    return;
  }

  // holder 経由で受け取る (closure 代入の変数を直接 narrow しない)。
  const capture: { current: { status: number; bytes: Uint8Array } | null } = {
    current: null,
  };
  try {
    const chart = await fetchChart(target, "1mo", {
      onRaw: (cap) => {
        capture.current = cap;
      },
    });
    await collectMacroRawAttempt(collector, target, requestedAt, capture.current, null);
    const raw = capture.current;
    if (raw === null) {
      // 原本 capture 必須 (NIY snapshot も含む全 target)。hook 未発火の
      // 契約後退があっても原本なしの値を採用しない。保存時に HOLD する。
      console.warn(
        `[sync-daily]   マクロ対象 ${target}: 原文 capture が無いため採用しません。保存時に HOLD します。`
      );
      return;
    }
    if (target === "NIY=F") {
      // NIY は confirmed helper の対象外。snapshot をそのまま使う
      // (確定日足扱いしない。日付は最新バー日で照合には使わない)。
      draft.charts[target] = {
        price: chart.price,
        prevClose: chart.previousClose,
        date: chart.ohlcv.at(-1)?.date ?? null,
      };
      return;
    }
    try {
      const confirmed = selectConfirmedCloses(raw.bytes, chart.ohlcv, target);
      draft.charts[target] = {
        price: confirmed.value,
        prevClose: confirmed.prev,
        date: confirmed.date,
      };
    } catch (error) {
      // session 不足・形成中のみ・確定バー欠落は fetch 失敗ではない。
      // 回収対象にせず、保存時の日付 gate で HOLD する。
      console.warn(`[sync-daily]   マクロ対象 ${target}:`, rootCauseMessage(error));
    }
  } catch (error) {
    await collectMacroRawAttempt(
      collector,
      target,
      requestedAt,
      capture.current,
      `取得失敗 (body ${capture.current ? "あり" : "なし"}): ${rootCauseMessage(error)}`
    );
    throw error;
  }
}

async function fetchMarketContextDraft(): Promise<{
  draft: MarketContextDraft;
  failures: DailyRecoveryFailure<MarketContextTarget>[];
  collector: MacroRawAttempt[];
}> {
  const draft = createMarketContextDraft();
  const collector: MacroRawAttempt[] = [];
  const failures: DailyRecoveryFailure<MarketContextTarget>[] = [];
  const targets: readonly MarketContextTarget[] = [
    ...MARKET_CONTEXT_CHART_SYMBOLS,
    NIKKEI_VI_TARGET,
  ];

  await Promise.all(
    targets.map(async (target) => {
      try {
        await fetchMarketContextTarget(draft, target, collector);
      } catch (error) {
        const message = rootCauseMessage(error);
        failures.push({ target, error: message });
        console.warn(`[sync-daily]   マクロ取得失敗 ${target}:`, message);
      }
    })
  );

  return { draft, failures, collector };
}

interface MarketContextGate {
  ok: boolean;
  key: string | null;
  reason: string;
}

/**
 * 正準 gate (純関数)。INSERT の前に必須データの完全性を判定する。
 * 行キーは GSPC の確定バー日。N225/VIX 確定日と VI 日付 (ZXD) が
 * キーと一致し、必須の確定終値・前日終値・snapshot が揃うときだけ
 * 書く。異なる取引日の脚を混ぜた行・null で前回行を潰す部分行を
 * 残さない。NIY は snapshot のため日付照合はしない (価格は必須)。
 * 曜日もカレンダーも見ない。
 */
function decideMarketContextGate(draft: MarketContextDraft): MarketContextGate {
  const key = draft.charts["^GSPC"].date;
  const n225 = draft.charts["^N225"];
  const vix = draft.charts["^VIX"];
  const gspc = draft.charts["^GSPC"];
  const niy = draft.charts["NIY=F"];
  if (key === null) {
    return { ok: false, key: null, reason: "GSPC 確定日が無い (取得失敗または session 不足)" };
  }
  const dates: Array<[string, string | null]> = [
    ["N225 確定日", n225.date],
    ["VIX 確定日", vix.date],
    ["VI 日付", draft.nikkeiViDate],
  ];
  for (const [name, d] of dates) {
    if (d === null) {
      return { ok: false, key, reason: `${name}が無い (取得失敗または session 不足)` };
    }
    if (d !== key) {
      return { ok: false, key, reason: `${name} ${d} ≠ GSPC ${key} (混ぜない)` };
    }
  }
  const required: Array<[string, number | null]> = [
    ["N225 確定終値", n225.price],
    ["N225 前日終値", n225.prevClose],
    ["GSPC 確定終値", gspc.price],
    ["GSPC 前日終値", gspc.prevClose],
    ["VIX 確定終値", vix.price],
    ["NIY snapshot", niy.price],
    ["VI 価格", draft.nikkeiVi],
  ];
  for (const [name, v] of required) {
    if (v === null) {
      return { ok: false, key, reason: `${name}が無い (部分行を書かない)` };
    }
  }
  return { ok: true, key, reason: "確定日・必須値が一致" };
}

async function persistMarketContext(
  db: Db,
  draft: MarketContextDraft
): Promise<boolean> {
  // 書くのは正準 gate が通るときだけ (F-06 の後継)。不一致・不足は
  // 書かず前回値を残す (HOLD)。実行日・run 日はキーに使わない。
  const gate = decideMarketContextGate(draft);
  if (!gate.ok || gate.key === null) {
    console.warn(
      `[sync-daily]   マクロ保存スキップ (HOLD): ${gate.reason}。前回値を保持します。`
    );
    return false;
  }
  const today = gate.key;
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

  // ここまで来たら gate が必須値の完全性を保証済み。INSERT 後の
  // 部分行チェックは gate 前へ移動したので true を返す。
  return true;
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

/** マクロ一次原本バッチの冪等 key (run 一意。実 startedAt + 既存 runId)。 */
function macroSourceBatchKey(runId: string, startedAt: number): string {
  return `macro-source-batch-${runId}-${startedAt}`;
}

function macroRawFileTag(target: MarketContextTarget): string {
  if (target === NIKKEI_VI_TARGET) return "VI";
  if (target === "NIY=F") return "NIY";
  return target.replace(/^\^/, "");
}

/**
 * 最終 draft + 同一 generation の原本を保管し、strict readback が通って
 * 初めて D1 へ persist する。daily/context-only 両 caller の唯一の経路。
 *
 * 保管失敗 (fileTooLarge・非 recorded・manifest 不一致・readback 不一致) は
 * この catch の外 = 呼び出し側へ throw し、false/success に丸めない。
 * 未回復 target・日付不足の HOLD でも実取得の原本は保管する (save 0)。
 */
async function archiveAndPersistMarketContext(
  db: Db,
  startedAt: number,
  draft: MarketContextDraft,
  attempts: readonly MacroRawAttempt[]
): Promise<boolean> {
  await archiveMacroSourceBatch({ startedAt, draft, attempts });
  return persistMarketContextWithDiagnostics(db, draft);
}

async function archiveMacroSourceBatch(args: {
  startedAt: number;
  draft: MarketContextDraft;
  attempts: readonly MacroRawAttempt[];
}): Promise<string> {
  const runId = priceSyncBatchRunId(args.startedAt);
  const key = macroSourceBatchKey(runId, args.startedAt);
  if (args.attempts.length === 0) {
    throw new Error("マクロ一次原本: attempt 記録が空 (内部不整合のため STOP)");
  }
  // fetchedAt は run 開始ではなく実観測の完了 (全 attempt の最新
  // completedAt)。run startedAt は provenance として別途残す。
  const fetchedAt = args.attempts
    .map((a) => a.completedAt)
    .sort()
    .at(-1) as string;
  const gate = decideMarketContextGate(args.draft);
  const files: Array<{ filename: string; bytes: Uint8Array; contentType: string }> = [];
  const attemptEntries = args.attempts.map((a) => {
    let filename: string | null = null;
    if (a.bytes !== null) {
      const ext = a.target === NIKKEI_VI_TARGET ? "html" : "json";
      filename = `macro-${macroRawFileTag(a.target)}-attempt${a.attempt}.${ext}`;
      files.push({
        filename,
        bytes: a.bytes,
        contentType: a.target === NIKKEI_VI_TARGET ? "text/html" : "application/json",
      });
    }
    return {
      target: a.target,
      attempt: a.attempt,
      requestedAt: a.requestedAt,
      completedAt: a.completedAt,
      status: a.status,
      byteLength: a.bytes?.length ?? null,
      sha256: a.sha256,
      filename,
      noBodyReason: a.noBodyReason,
    };
  });
  const manifest = {
    service: "stock-sync",
    kind: "macro-source-batch",
    key,
    runId,
    startedAt: new Date(args.startedAt).toISOString(),
    gate,
    draft: {
      charts: Object.fromEntries(
        MARKET_CONTEXT_CHART_SYMBOLS.map((s) => [s, args.draft.charts[s]])
      ),
      nikkeiVi: args.draft.nikkeiVi,
      nikkeiViDate: args.draft.nikkeiViDate,
    },
    attempts: attemptEntries,
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  files.push({
    filename: "macro-manifest.json",
    bytes: manifestBytes,
    contentType: "application/json",
  });

  const res = await recordPrimaryData({
    service: "stock-sync",
    key,
    source: "macro-producer final-draft + same-generation raw (chart onRaw + VI HTML)",
    fetchedAt,
    metadata: {
      key,
      runId,
      startedAt: new Date(args.startedAt).toISOString(),
      gate,
      keyDates: {
        gspc: args.draft.charts["^GSPC"].date,
        n225: args.draft.charts["^N225"].date,
        vi: args.draft.nikkeiViDate,
      },
      attemptCount: args.attempts.length,
      fileCount: files.length,
    },
    files,
    force: false,
  });
  if (res.fileTooLarge) {
    throw new Error(`マクロ一次原本の保管が不完全 (fileTooLarge): ${key}`);
  }
  if (res.outcome !== "recorded" || res.manifestMatch !== "written") {
    throw new Error(
      `マクロ一次原本の保管が不完全 (outcome=${res.outcome} manifest=${res.manifestMatch}): ${key}`
    );
  }
  await verifyArchivedAttachments(res.pageId, files, "マクロ一次原本");
  return res.pageId;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
