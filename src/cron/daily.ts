/**
 * 日次 sync オーケストレータ（Cloudflare Worker 版・ADR-0001 Phase 3）
 *
 * 3 サービス (001 RSI / 002 otakara / 003 swing) すべてが必要とする日次データを
 * **1 本の統一フロー** で取得・計算・書き込む。
 *
 * 実行形態（Phase 3 で Node→Worker へ移行）:
 *   - **Worker 上で実行**: Yahoo は Cloudflare エッジから直接叩くので自宅 IP の
 *     429 に掛からない。D1 はバインディング (c.env.DB) + `db.batch()` で
 *     1 銘柄=1 バッチ書込（HTTP 往復を 1 回に圧縮）。
 *   - 起動経路: (a) Workers Cron Trigger → scheduled() ハンドラ（src/cron/scheduled.ts、
 *     シャード毎に独立 invocation）。(b) 認証ルート POST /admin/sync-daily（手動/CLI）。
 *
 * フロー（母集団同期 Phase 0 は除外）:
 *   Phase 1. ブートストラップ: core_stocks からアクティブ銘柄（シャード分）を取得
 *   Phase 2. マクロコンテキスト (^N225 / ^VIX / ^GSPC / NIY=F + 日経VI) — shard 0 のみ
 *   Phase 3. worker pool で各銘柄: Chart(5y)+QuoteSummary 取得 → 全指標を in-memory 計算 →
 *            **db.batch()** で core_financials / rsi_percentile / swing_* を 1 バッチ書込
 *   Phase 4. セクター集計（最終 shard のみ、当日更新済 indicators から集計）
 *   Phase 5. 廃止銘柄 (Yahoo 404) の is_active=false
 *
 * 母集団 (core_stocks) の JPX 同期は xlsx パーサが Node 専用のため Worker 不可。
 * `pnpm sync:universe`（Node, src/cron/universe.ts）で別途同期する。
 *
 * D1 書込コスト対策（旧 Phase 3 課題の解消）:
 *   OHLCV は「既存 MAX(date) より新しい bar のみ」を増分 upsert する。初回（空）は
 *   全 6mo を backfill、以降は当日分 1〜2 行のみ。全銘柄日次の rows-written を
 *   ~52 万 → ~3 万/日 に削減し D1 無料枠 (10 万/日) 内に収める。
 *
 * CLAUDE.md のフォールバック禁止ルールに従い:
 *   - 銘柄の Yahoo 404 は is_active=false に更新 (silent 無視しない)
 *   - 日経VI 取得失敗は judgeMacro() が HOLD を返すので B/C 判定に変えない
 *   - マクロ 4 指数のどれかが取れない場合も null で通す
 */

import { sql, eq, and, lt, gte, inArray } from "drizzle-orm";
import { createServiceDb } from "../shared/db/client.js";

// core スキーマは rsi-screening の定義を流用 (001 が所有・更新)
import * as coreSchema from "../../services/rsi-screening/src/db/core-schema.js";
// rsi スキーマ
import * as rsiSchema from "../../services/rsi-screening/src/db/schema.js";
// swing スキーマ
import * as swingSchema from "../../services/swing-trading/src/db/schema.js";

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

// -----------------------------------------------------------------------------
// 型定義
// -----------------------------------------------------------------------------

// createD1HttpDb と異なりバインディング版 drizzle (db.batch 対応)。
const SCHEMAS = { ...rsiSchema, ...swingSchema };
type Db = ReturnType<typeof createDailyDb>;

/** 日次 sync の結果サマリ */
export interface DailySyncResult {
  totalStocks: number;
  successStocks: number;
  failedStocks: number;
  inactivatedStocks: number;
  marketContextOk: boolean;
  /** 時間バジェット超過で打ち切ったか (次回 cron が当該シャードを再処理) */
  reachedBudget: boolean;
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

/** ワーカー並列度 (エッジは 429 制約が無いが Yahoo に配慮) */
const CONCURRENCY = 8;
/** ワーカー間隔 (ms) */
const DELAY_MS = 50;
/**
 * swing_daily_ohlcv の保持期間 (営業日)。母集団が全 JPX 内国株 (~4,000) に拡張
 * されたため 120→90 に短縮。増分 upsert と併せて D1 ストレージ/書込を抑える。
 */
const OHLCV_RETENTION_DAYS = 90;
/** OHLCV insert の D1 bind 上限対策 (7 列なので 14 行/文) */
const OHLCV_CHUNK = 14;
/** sector_daily insert の bind 上限対策 (6 列なので 16 行/文) */
const SECTOR_CHUNK = 16;
/** inactivate IN リストの bind 上限対策 */
const INACT_CHUNK = 80;
/** 既定の時間バジェット (ms)。Worker の 5 分上限に対し余裕を残す */
const DEFAULT_TIME_BUDGET_MS = 240_000;

// -----------------------------------------------------------------------------
// エントリポイント
// -----------------------------------------------------------------------------

/**
 * D1 バインディング接続の Drizzle クライアントを作成する (db.batch 対応)。
 * @param d1 - Worker バインディング `c.env.DB` / `env.DB`
 */
export function createDailyDb(d1: D1Database) {
  return createServiceDb(d1, SCHEMAS);
}

/**
 * 日次 sync のシャード指定。母集団 ~4,000 を Worker 1 invocation の subrequest /
 * 時間上限内に収めるため `id % of = part` で分割し、各 part を別 invocation
 * (別 cron) で処理する。CLI トリガでは全 part を順に叩く。
 */
export interface ShardOpts {
  /** 0-based シャード番号 (0 <= part < of) */
  part: number;
  /** 総シャード数 (>= 1) */
  of: number;
}

export interface DailySyncOpts {
  /** 時間バジェット (ms)。超過で worker pool を打ち切る */
  timeBudgetMs?: number;
}

/**
 * 日次 sync 本体
 *
 * @param db    D1 バインディング drizzle (createDailyDb)
 * @param shard 指定時はその銘柄サブセットのみ処理する (cron シャード分割用)
 * @param opts  時間バジェット等
 */
export async function runDailySync(
  db: Db,
  shard?: ShardOpts,
  opts?: DailySyncOpts
): Promise<DailySyncResult> {
  const startedAt = Date.now();
  const timeBudgetMs = opts?.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const overBudget = () => Date.now() - startedAt > timeBudgetMs;
  const failures: { code: string; error: string }[] = [];

  // -----------------------------------------------------------------
  // Phase 1: 母集団 (core_stocks) からアクティブ銘柄を取得
  //
  // 母集団の JPX 同期 (旧 Phase 0) は xlsx パーサが Node 専用のため
  // `pnpm sync:universe` で別途実行する。ここでは既存 core_stocks を読むだけ。
  // -----------------------------------------------------------------
  console.info(
    `[sync-daily] Phase 1: ブートストラップ${
      shard ? ` (shard ${shard.part}/${shard.of})` : ""
    }`
  );
  const activeCond = eq(coreSchema.stocks.isActive, true);
  const whereCond = shard
    ? and(
        activeCond,
        sql`${coreSchema.stocks.id} % ${shard.of} = ${shard.part}`
      )
    : activeCond;
  const targets = await db
    .select({
      id: coreSchema.stocks.id,
      code: coreSchema.stocks.code,
      sector: coreSchema.stocks.sector,
    })
    .from(coreSchema.stocks)
    .where(whereCond);
  console.info(`[sync-daily]   対象: ${targets.length} 銘柄`);

  // 増分 OHLCV 用: 各銘柄の既存 MAX(date) を 1 クエリで読む (bind 不要)。
  // null/未登録は初回 backfill 扱い。
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
  // Phase 2: マクロコンテキスト (並列) — shard 0 のみ
  // -----------------------------------------------------------------
  const runGlobalMacro = !shard || shard.part === 0;
  let marketContextOk: boolean;
  if (runGlobalMacro) {
    console.info("[sync-daily] Phase 2: マクロコンテキスト取得");
    marketContextOk = await syncMarketContext(db).then(
      () => true,
      (e) => {
        console.warn(
          "[sync-daily]   マクロ取得部分失敗:",
          e instanceof Error ? e.message : e
        );
        return false;
      }
    );
  } else {
    console.info("[sync-daily] Phase 2: マクロ取得スキップ (shard 0 が担当)");
    marketContextOk = false;
  }

  // -----------------------------------------------------------------
  // Phase 3: 銘柄ごとのフェッチ + 計算 + DB 書き込み (worker pool)
  // -----------------------------------------------------------------
  console.info("[sync-daily] Phase 3: 銘柄フェッチ + 計算 + 書き込み");
  const queue = [...targets];
  const inactivated: number[] = [];
  let succeeded = 0;
  let reachedBudget = false;

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      if (overBudget()) {
        reachedBudget = true;
        break;
      }
      const target = queue.shift();
      if (!target) break;
      try {
        const snap = await buildSnapshot(target.id, target.code, target.sector);
        await writeStockSnapshot(db, snap, maxDateByStock.get(target.id));
        succeeded++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failures.push({ code: target.code, error: msg });
        if (msg.includes("404") || msg.includes("見つかりません")) {
          inactivated.push(target.id);
        }
      }
      await sleep(DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const poolSummary = `[sync-daily]   成功: ${succeeded} / 失敗: ${failures.length} / 廃止: ${inactivated.length}`;
  if (reachedBudget) {
    // 打ち切りは degraded 状態なので warn で可視化 (次回 cron が当該シャードを再処理)。
    console.warn(`${poolSummary} (時間バジェット超過で打ち切り — 次回 cron が再処理)`);
  } else {
    console.info(poolSummary);
  }

  // -----------------------------------------------------------------
  // Phase 5: クリーンアップ (廃止銘柄) — このシャードが処理した分のみ
  // -----------------------------------------------------------------
  console.info("[sync-daily] Phase 5: クリーンアップ");
  for (let i = 0; i < inactivated.length; i += INACT_CHUNK) {
    await db
      .update(coreSchema.stocks)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        inArray(coreSchema.stocks.id, inactivated.slice(i, i + INACT_CHUNK))
      );
  }

  // -----------------------------------------------------------------
  // Phase 4: セクター集計 (DB ベース) — 最終 shard のみ
  // -----------------------------------------------------------------
  const runSectorAgg = !shard || shard.part === shard.of - 1;
  if (runSectorAgg) {
    console.info("[sync-daily] Phase 4: セクター集計 (DB ベース)");

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
          `(${(coverage * 100).toFixed(1)}%) が閾値 90% 未満。先行 shard 未完か大量失敗の` +
          `可能性。sector_daily は前回値を保持します。`
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
      // [delete, ...inserts] の literal は非空タプルに推論され db.batch を満たす。
      await db.batch([
        db
          .delete(swingSchema.sectorDaily)
          .where(eq(swingSchema.sectorDaily.date, today)),
        ...chunkArray(sectorAggs, SECTOR_CHUNK).map((slice) =>
          db.insert(swingSchema.sectorDaily).values(
            slice.map((a) => ({
              date: today,
              sector: a.sector,
              pct1d: a.pct1d,
              pct5d: a.pct5d,
              stockCount: a.stockCount,
              rank1d: a.rank1d,
            }))
          )
        ),
      ]);
    }
  } else {
    console.info(
      "[sync-daily] Phase 4: セクター集計スキップ (最終 shard が担当)"
    );
  }

  const elapsedSec = (Date.now() - startedAt) / 1000;
  console.info(
    `[sync-daily] 完了: 成功=${succeeded} 失敗=${failures.length} 廃止=${inactivated.length} 所要=${elapsedSec.toFixed(1)}s`
  );

  return {
    totalStocks: targets.length,
    successStocks: succeeded,
    failedStocks: failures.length,
    inactivatedStocks: inactivated.length,
    marketContextOk,
    reachedBudget,
    elapsedSec,
    failures,
  };
}

// -----------------------------------------------------------------------------
// 銘柄ごとの snapshot 構築 (純計算・Worker 安全)
// -----------------------------------------------------------------------------

async function buildSnapshot(
  stockId: number,
  code: string,
  sector: string | null
): Promise<StockSnapshot> {
  // 1 回の Chart(5y) + QuoteSummary で全指標を賄う
  const raw = await fetchStockRawData(code, "5y");

  // -- RSI 時系列 (5y 全量) → percentile --
  const closes5y = raw.ohlcv
    .map((r) => r.close)
    .filter((c): c is number => c !== null);
  const rsiSeries = calculateAllRsiSeries(closes5y);
  const rsiPercentile = computeRsiPercentileSnapshot(rsiSeries);
  const blueChip = evaluateBlueChip(raw.annualFinancials, raw.operatingMarginTtm);

  // -- 6mo スライス → swing 用指標 --
  const ohlcv6mo = raw.ohlcv.slice(-130);
  const closes6mo = ohlcv6mo.map((r) => r.close);

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
// 銘柄ごとの DB 書き込み (db.batch で 1 銘柄=1 バッチ・増分 OHLCV)
// -----------------------------------------------------------------------------

async function writeStockSnapshot(
  db: Db,
  snap: StockSnapshot,
  existingMaxDate: string | undefined
): Promise<void> {
  // --- 増分 OHLCV: 既存 MAX(date) より新しい bar のみ (初回=全 6mo backfill) ---
  const newOhlcv = existingMaxDate
    ? snap.ohlcv6mo.filter((r) => r.date > existingMaxDate)
    : snap.ohlcv6mo;
  const ohlcvInsertOps = chunkArray(newOhlcv, OHLCV_CHUNK).map((slice) =>
    db
      .insert(swingSchema.dailyOhlcv)
      .values(
        slice.map((r) => ({
          stockId: snap.stockId,
          date: r.date,
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
          volume: r.volume,
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
        },
      })
  );

  // --- OHLCV 保持期間より古い行を削除 ---
  const ohlcvDeleteOps =
    snap.ohlcv6mo.length > 0
      ? [
          db
            .delete(swingSchema.dailyOhlcv)
            .where(
              and(
                eq(swingSchema.dailyOhlcv.stockId, snap.stockId),
                lt(
                  swingSchema.dailyOhlcv.date,
                  snap.ohlcv6mo[
                    Math.max(0, snap.ohlcv6mo.length - OHLCV_RETENTION_DAYS)
                  ].date
                )
              )
            ),
        ]
      : [];

  // --- core_stock_annual_financials (年度売上) ---
  const annualOps =
    snap.annualFinancials.length > 0
      ? [
          db
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
            }),
        ]
      : [];

  // --- swing_entry_signals (E&E パターン) ---
  // delete + insert を同一 db.batch に入れることで原子置換になる (バインディングの
  // db.batch はトランザクション)。delete は **無条件**: latestClose が null
  // (出来高途絶/データ欠落) でも当該銘柄の古いシグナルを必ず消し、鮮度の無い
  // entry/stop を残さない (CLAUDE.md rule2)。シグナルが算出できた時だけ再挿入する。
  let entrySignalRows: (typeof swingSchema.entrySignals.$inferInsert)[] = [];
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
    entrySignalRows = signals.map((s) => ({
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
    }));
  }

  const screen = screenStock({
    avgTurnover20d: snap.avgTurnover20d,
    volumeRatio: snap.volumeRatio,
    atrPct: snap.atrPct,
    sma5: snap.sma5,
    sma20: snap.sma20,
    latestClose: snap.latestClose,
  });

  // 1 銘柄=1 バッチ (D1 への HTTP/RPC 往復を 1 回に圧縮)。先頭は常に存在する
  // financials upsert なので batch のタプル型 (非空) を満たす。
  await db.batch([
    // core_stock_financials
    db
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
      }),
    // rsi_percentile
    db
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
          isBlueChip: sql`excluded.is_blue_chip`,
          operatingMarginTtm: sql`excluded.operating_margin_ttm`,
          revenueTrend: sql`excluded.revenue_trend`,
          computedAt: sql`(unixepoch())`,
        },
      }),
    // swing_stock_indicators
    db
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
      }),
    // swing_stock_screening
    db
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
      }),
    ...annualOps,
    ...ohlcvInsertOps,
    ...ohlcvDeleteOps,
    // 既存シグナルを無条件にクリア (古い entry/stop を残さない)。
    db
      .delete(swingSchema.entrySignals)
      .where(eq(swingSchema.entrySignals.stockId, snap.stockId)),
    ...(entrySignalRows.length > 0
      ? [db.insert(swingSchema.entrySignals).values(entrySignalRows)]
      : []),
  ]);
}

// -----------------------------------------------------------------------------
// マクロコンテキスト同期 (^N225 / ^VIX / ^GSPC / NIY=F + 日経VI)
// -----------------------------------------------------------------------------

async function syncMarketContext(db: Db): Promise<void> {
  const today = new Date().toISOString().split("T")[0];

  async function safeFetchLatest(
    symbol: string
  ): Promise<{ price: number | null; prevClose: number | null }> {
    try {
      const chart = await fetchChart(symbol, "1mo");
      return { price: chart.price, prevClose: chart.previousClose };
    } catch (e) {
      console.warn(
        `[sync-daily]   マクロ取得失敗 ${symbol}:`,
        e instanceof Error ? e.message : e
      );
      return { price: null, prevClose: null };
    }
  }

  async function safeFetchNikkeiVi(): Promise<number | null> {
    try {
      const snap = await fetchNikkeiVi();
      return snap.price;
    } catch (e) {
      console.warn(
        `[sync-daily]   日経VI 取得失敗:`,
        e instanceof Error ? e.message : e
      );
      return null;
    }
  }

  const [n225, vix, gspc, niy, nikkeiVi] = await Promise.all([
    safeFetchLatest("^N225"),
    safeFetchLatest("^VIX"),
    safeFetchLatest("^GSPC"),
    safeFetchLatest("NIY=F"),
    safeFetchNikkeiVi(),
  ]);

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
}

/** 配列を size ごとに分割する */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
