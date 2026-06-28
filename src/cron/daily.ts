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
 *   Phase 4. セクター集計（当日更新済 indicators から集計・90% カバレッジ guard）
 *   Phase 5. 廃止銘柄 (Yahoo 404) の is_active=false
 *
 * 母集団 (core_stocks) の JPX 同期は xlsx パーサが Node 専用のため
 * `pnpm sync:universe`（src/cron/universe.ts）で別途同期する。
 *
 * D1 書込コスト対策: OHLCV は「既存 MAX(date) より新しい bar のみ」を増分 upsert
 * する。初回(空)は全 6mo backfill、以降は当日分 1〜2 行のみ。全銘柄日次の
 * rows-written を ~52 万 → ~3 万/日 に抑え D1 無料枠 (10 万/日) 内に収める。
 *
 * CLAUDE.md のフォールバック禁止ルールに従い:
 *   - 銘柄の Yahoo 404 は is_active=false に更新 (silent 無視しない)
 *   - 日経VI 取得失敗は judgeMacro() が HOLD を返すので B/C 判定に変えない
 *   - マクロ 4 指数のどれかが取れない場合も null で通す
 */

import { sql, eq, and, lt, gte, inArray } from "drizzle-orm";
import { createD1HttpDb } from "../shared/db/d1-http-client.js";

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

// createD1HttpDb は core_* を自動登録するので rsi/swing スキーマのみ渡す。
const SCHEMAS = { ...rsiSchema, ...swingSchema };
type Db = ReturnType<typeof createDailyDb>;

/** 日次 sync の結果サマリ */
export interface DailySyncResult {
  totalStocks: number;
  successStocks: number;
  failedStocks: number;
  inactivatedStocks: number;
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

/** ワーカー並列度 (Yahoo はエッジプロキシ経由なので 429 は無いが配慮) */
const CONCURRENCY = 5;
/** ワーカー間隔 (ms) */
const DELAY_MS = 150;
/** swing_daily_ohlcv の保持期間 (営業日)。増分 upsert と併せて書込/容量を抑える。 */
const OHLCV_RETENTION_DAYS = 90;
/** OHLCV insert の D1 bind 上限対策 (adj 追加で 8 列になったので 12 行/文: 8×12=96≤100) */
const OHLCV_CHUNK = 12;
/** sector_daily insert の bind 上限対策 (6 列なので 16 行/文) */
const SECTOR_CHUNK = 16;
/** inactivate IN リストの bind 上限対策 */
const INACT_CHUNK = 80;

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
 * 日次 sync 本体
 *
 * @param db createDailyDb() の戻り (Node→D1 HTTP)
 */
export async function runDailySync(db: Db): Promise<DailySyncResult> {
  const startedAt = Date.now();
  const failures: { code: string; error: string }[] = [];

  // -----------------------------------------------------------------
  // Phase 1: アクティブ銘柄取得 + 既存 OHLCV の MAX(date) (増分判定用)
  // -----------------------------------------------------------------
  console.info("[sync-daily] Phase 1: ブートストラップ");
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
  const marketContextOk = await syncMarketContext(db).then(
    () => true,
    (e) => {
      console.warn(
        "[sync-daily]   マクロ取得部分失敗:",
        e instanceof Error ? e.message : e
      );
      return false;
    }
  );

  // -----------------------------------------------------------------
  // Phase 3: 銘柄ごとのフェッチ + 計算 + DB 書き込み (worker pool)
  // -----------------------------------------------------------------
  console.info("[sync-daily] Phase 3: 銘柄フェッチ + 計算 + 書き込み");
  const queue = [...targets];
  const inactivated: number[] = [];
  let succeeded = 0;

  async function worker(): Promise<void> {
    while (queue.length > 0) {
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
  console.info(
    `[sync-daily]   成功: ${succeeded} / 失敗: ${failures.length} / 廃止: ${inactivated.length}`
  );

  // -----------------------------------------------------------------
  // Phase 5: クリーンアップ (廃止銘柄)
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
  // Phase 4: セクター集計 (当日更新済 indicators から・90% カバレッジ guard)
  // -----------------------------------------------------------------
  console.info("[sync-daily] Phase 4: セクター集計");
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

async function writeStockSnapshot(
  db: Db,
  snap: StockSnapshot,
  existingMaxDate: string | undefined
): Promise<void> {
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

  // --- core_stock_financials ---
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
  // 保持期間より古い行を削除
  if (snap.ohlcv6mo.length > 0) {
    const cutoffDate =
      snap.ohlcv6mo[Math.max(0, snap.ohlcv6mo.length - OHLCV_RETENTION_DAYS)]
        .date;
    await db
      .delete(swingSchema.dailyOhlcv)
      .where(
        and(
          eq(swingSchema.dailyOhlcv.stockId, snap.stockId),
          lt(swingSchema.dailyOhlcv.date, cutoffDate)
        )
      );
  }

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
