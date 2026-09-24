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

import { sql, eq, and, or, gte, lte, lt } from "drizzle-orm";
import { createD1HttpDb } from "../shared/db/d1-http-client.js";
import { publicSectorColumn } from "../shared/db/public-columns.js";
import { activeEquityCondition } from "../shared/db/active-equity.js";

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
  /** 処理対象の件数 = `core_stocks` の active かつ equity (`loadDailyTargets`)。 */
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
 * cron は平日 21:00 UTC なので UTC 曜日で見る。JST で見ると run は
 * 火〜土曜 06:00 になり「月曜」の run が存在しない。UTC 月曜 = 週の最初の run。
 */
export function isMondayUtc(now: Date = new Date()): boolean {
  return now.getUTCDay() === 1;
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
    !result.marketContextOk
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
 * 日次 sync 本体
 *
 * @param db createDailyDb() の戻り (Node→D1 HTTP)
 */
export async function runDailySync(db: Db): Promise<DailySyncResult> {
  const startedAt = Date.now();

  // -----------------------------------------------------------------
  // Phase 1: スキーマ検証 + 処理対象 (active かつ equity) の取得 + 既存 OHLCV の MAX(date)
  // -----------------------------------------------------------------
  console.info("[sync-daily] Phase 1: ブートストラップ");
  await assertDailySchema(db);
  const targets = await loadDailyTargets(db);
  console.info(`[sync-daily]   対象: ${targets.length} 銘柄 (active かつ equity)`);

  // 増分判定の既存日付は Phase 1 の targets に載っている (latest_date JOIN)。
  // NULL/未登録は初回 backfill (6mo 全 upsert)。
  const latestDateByStock = new Map<number, string>(
    targets.flatMap((t) =>
      t.latestDate === null ? [] : [[t.id, t.latestDate] as const]
    )
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

  // 年次は月曜 UTC の run でのみ書く (L-49)。年 1 回変わるものに毎日
  // 15,900 行 upsert していた。
  const writeAnnual = isMondayUtc();
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
        const snap = await buildSnapshot(target.id, target.code, target.sector);
        pending.push({
          target,
          snap,
          existingMaxDate: latestDateByStock.get(target.id),
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
    marketContext.failures,
    firstPassFailures
  );
  let recoveredStocks = 0;
  const recovery = await recoverTransientDailyFailures(
    recoveryTargets,
    async (recoveryTarget) => {
      try {
        if (recoveryTarget.kind === "macro") {
          await fetchMarketContextTarget(
            marketContext.draft,
            recoveryTarget.target
          );
          return;
        }
        // 回収は件数が少ないので 1 行 flush のまま (初回パスと行 builder は共有)。
        const target = recoveryTarget.target;
        await stockStartGate.wait();
        const snap = await buildSnapshot(target.id, target.code, target.sector);
        await writeStockSnapshot(db, snap, latestDateByStock.get(target.id), {
          writeAnnual,
          runStartedSec,
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

  if (marketContextOk === undefined) {
    marketContextOk = await persistMarketContextWithDiagnostics(
      db,
      marketContext.draft
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
  if (isMondayUtc()) {
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
  await aggregateSectorDaily(db, new Date().toISOString().split("T")[0]);

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

/**
 * Phase 5: 業種騰落ランキング (`swing_sector_daily`) を `today` の日付で書き直す。
 *
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
  const { snap, existingMaxDate } = item;
  const newOhlcv = existingMaxDate
    ? snap.ohlcv6mo.filter((r) => r.date > existingMaxDate)
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
  const failed = await flushSnapshots(db, [{ snap, existingMaxDate }], options);
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
