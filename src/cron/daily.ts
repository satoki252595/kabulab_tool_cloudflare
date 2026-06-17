/**
 * 日次 sync オーケストレータ
 *
 * 3 サービス (001 RSI / 002 otakara / 003 swing) すべてが必要とする日次データを
 * **1 本の統一フロー** で取得・計算・書き込む。ユーザー要件:
 *   - データ取得コマンドは日次/月次の 2 つだけ
 *   - サービス毎の sync は廃止
 *   - 重複 Yahoo 呼び出しを排除 (1 銘柄につき Chart + QuoteSummary 各 1 回)
 *
 * フロー:
 *   Phase 0. 母集団同期: JPX 公式 XLS で core.stocks を全内国株へ upsert
 *            (旧 `pnpm sync:universe` を日次に内包。shard 分割時は shard 0 のみ)
 *   Phase 1. ブートストラップ: core.stocks からアクティブ銘柄リストを取得
 *   Phase 2. マクロコンテキスト (^N225 / ^VIX / ^GSPC / NIY=F + 日経VI) を並列取得
 *   Phase 3. worker pool (CONCURRENCY=5) で各銘柄について:
 *     - Chart(5y) + QuoteSummary を Yahoo から取得
 *     - in-memory で全指標を計算
 *     - core.stock_financials / core.stock_annual_financials 書き込み
 *     - rsi.stock_rsi_percentile 書き込み
 *     - swing.daily_ohlcv / stock_indicators / stock_screening / entry_signals 書き込み
 *   Phase 4. セクター集計 (in-memory の pct1d から 33 業種を集計)
 *   Phase 5. 廃止銘柄の is_active=false + swing.sector_daily 書き込み
 *
 * CLAUDE.md のフォールバック禁止ルールに従い:
 *   - 銘柄の Yahoo 404 は is_active=false に更新 (silent 無視しない)
 *   - 日経VI 取得失敗は judgeMacro() が HOLD を返すので B/C 判定に変えない
 *   - マクロ 4 指数のどれかが取れない場合も null で通す
 */

import { sql, eq, and, lt, gte, inArray } from "drizzle-orm";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

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
import { downloadJpxListing } from "../shared/jpx/sectors.js";
import { seedUniverse, type UniverseSyncResult } from "./universe.js";
import type { DailyOhlcv } from "../shared/types.js";

// -----------------------------------------------------------------------------
// 型定義
// -----------------------------------------------------------------------------

type Db = ReturnType<typeof drizzle<typeof SCHEMAS>>;
const SCHEMAS = { ...coreSchema, ...rsiSchema, ...swingSchema };

/** 日次 sync の結果サマリ */
export interface DailySyncResult {
  totalStocks: number;
  successStocks: number;
  failedStocks: number;
  inactivatedStocks: number;
  marketContextOk: boolean;
  /**
   * Phase 0 母集団同期の結果。shard 0 / CLI で実行され成功すれば値が入る。
   * JPX 取得失敗時は null (既存 core.stocks で続行・要 operator 確認)。
   * shard 1.. では実行しないため null。
   */
  universe: UniverseSyncResult | null;
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

/** ワーカー並列度 (Yahoo rate limit 配慮) */
const CONCURRENCY = 5;
/** ワーカー間隔 (ms) */
const DELAY_MS = 200;
/**
 * swing.daily_ohlcv の保持期間 (営業日)
 *
 * 母集団が全 JPX 内国株 (~4,000) に拡張されたため、Neon Free tier の
 * ストレージ余裕を確保すべく 120→90 に短縮 (約 -25% 行数)。
 */
const OHLCV_RETENTION_DAYS = 90;

// -----------------------------------------------------------------------------
// エントリポイント
// -----------------------------------------------------------------------------

/**
 * Neon 接続用の Drizzle クライアントを作成する
 */
export function createDailyDb(databaseUrl: string): Db {
  const neonSql = neon(databaseUrl);
  return drizzle(neonSql, { schema: SCHEMAS });
}

/**
 * 日次 sync のシャード指定。
 *
 * 母集団が ~4,000 に拡張され単一実行が Vercel cron のタイムアウト
 * (現行プラン上限 300s) を超えるため、Vercel cron 側で
 * `of` 個に分割し各 `part` を別 invocation で並列実行する。
 * `id % of = part` で銘柄を均等分割する。
 * CLI (`pnpm sync:daily`) は shard 無し = 全銘柄一括。
 */
export interface ShardOpts {
  /** 0-based シャード番号 (0 <= part < of) */
  part: number;
  /** 総シャード数 (>= 1) */
  of: number;
}

/**
 * 日次 sync 本体
 *
 * @param shard 指定時はその銘柄サブセットのみ処理する (Vercel cron 分割用)
 */
export async function runDailySync(
  db: Db,
  shard?: ShardOpts
): Promise<DailySyncResult> {
  const startedAt = Date.now();
  const failures: { code: string; error: string }[] = [];

  // -----------------------------------------------------------------
  // Phase 0: 母集団 (core.stocks) 同期
  //
  // 旧来は `pnpm sync:universe` を日次の前に手動実行する運用だったが、
  // 日次フローに取り込み毎営業日 core.stocks を JPX 最新へ更新する。
  // マクロと同様、銘柄数に依存しないグローバル処理なのでシャード分割時は
  // shard 0 のみが実行し、JPX XLS の重複 DL (×of) と upsert 競合を避ける。
  // (shard 1.. は Phase 1 で core.stocks を読む。vercel.json の cron は
  //  shard を 7 分間隔で順次起動するため、shard 0 の Phase 0 (数秒) は
  //  後続 shard の起動前に完了する。よって新規上場/廃止は当日中に全 shard へ
  //  反映される。万一 shard を同時起動する構成にした場合は、新規上場の反映が
  //  翌実行に遅延しうる点に注意。)
  //
  // CLAUDE.md ルール2: JPX 取得失敗を別値で埋めない。ラウドに警告し、結果に
  // universe=null を残してオペレータが気づける状態にしつつ、既存 core.stocks
  // (前営業日の母集団) で日次の主目的=価格更新を止めずに続行する。
  // (架空データの注入ではなく「任意の更新ステップが今回 skip された」状態。)
  // -----------------------------------------------------------------
  const runGlobalUniverse = !shard || shard.part === 0;
  let universe: UniverseSyncResult | null = null;
  if (runGlobalUniverse) {
    console.info("[sync-daily] Phase 0: 母集団同期 (全 JPX 内国株)");
    try {
      const jpxRows = await downloadJpxListing();
      universe = await seedUniverse(db, jpxRows);
      console.info(
        `[sync-daily]   内国株=${universe.equities} upsert=${universe.upserted} 廃止=${universe.delisted}`
      );
    } catch (e) {
      console.warn(
        "[sync-daily]   Phase 0 母集団同期 失敗 (既存 core.stocks で続行・要確認):",
        e instanceof Error ? e.message : e
      );
      universe = null;
    }
  } else {
    console.info("[sync-daily] Phase 0: 母集団同期スキップ (shard 0 が担当)");
  }

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

  // -----------------------------------------------------------------
  // Phase 2: マクロコンテキスト (並列)
  //
  // マクロ指数は銘柄数に依存しないグローバル処理。シャード分割時は
  // shard 0 のみが実行し、Yahoo への重複呼び出し (×of) を避ける。
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
  //
  // 旧 swing-trading/sync.ts と同じパターン: 1 銘柄の fetch→write を
  // 1 ワーカー内で完結させ、CONCURRENCY=5 ワーカーで並列動作させる。
  // 書き込みまで同一ワーカーで行うことで、1580 銘柄 × ~8 DB roundtrips の
  // 並列化が効き Yahoo rate limit にも掛からない。
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
        await writeStockSnapshot(db, snap);
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
  //
  // 404 廃止はこのシャードが処理した銘柄のみが対象なので shard 毎に実行。
  // -----------------------------------------------------------------
  console.info("[sync-daily] Phase 5: クリーンアップ");

  if (inactivated.length > 0) {
    await db
      .update(coreSchema.stocks)
      .set({ isActive: false, updatedAt: new Date() })
      .where(inArray(coreSchema.stocks.id, inactivated));
  }

  // -----------------------------------------------------------------
  // Phase 4: セクター集計 (DB ベース)
  //
  // セクター集計は全銘柄の pct1d が必要なため、シャード分割時は最終シャード
  // (part === of-1) のみが実行し、swing.stock_indicators (全シャードが書き
  // 終えた最新値) を core.stocks と join して集計する。in-memory 集計では
  // シャード単体の部分集合しか持てず誤った sector_daily になるため DB から
  // 読み直す。
  // -----------------------------------------------------------------
  const runSectorAgg = !shard || shard.part === shard.of - 1;
  if (runSectorAgg) {
    console.info("[sync-daily] Phase 4: セクター集計 (DB ベース)");

    // シャード分割時、最終 shard 実行時点で先行 shard がまだ書き込み中の
    // 可能性がある。**今日更新された** stock_indicators だけを集計対象にし
    // (computed_at >= CURRENT_DATE)、カバレッジが著しく低い場合は古い
    // sector_daily を不完全な集計で上書きせず警告で止める (CLAUDE.md ルール2:
    // 黙って誤った値を出さない / オペレータ通知)。
    const [{ activeCount }] = await db
      .select({ activeCount: sql<number>`count(*)::int` })
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
          gte(swingSchema.stockIndicators.computedAt, sql`CURRENT_DATE`)
        )
      );

    const coverage =
      activeCount > 0 ? indicatorRows.length / activeCount : 0;
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
      await db
        .delete(swingSchema.sectorDaily)
        .where(eq(swingSchema.sectorDaily.date, today));
      if (sectorAggs.length > 0) {
        await db.insert(swingSchema.sectorDaily).values(
          sectorAggs.map((a) => ({
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
    universe,
    elapsedSec,
    failures,
  };
}

// -----------------------------------------------------------------------------
// 銘柄ごとの snapshot 構築
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
  //    5y の末尾 ~130 営業日を取る (6mo 相当)
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
// 銘柄ごとの DB 書き込み
// -----------------------------------------------------------------------------

async function writeStockSnapshot(db: Db, snap: StockSnapshot): Promise<void> {
  // --- core.stock_annual_financials ---
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

  // --- core.stock_financials ---
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
        fetchedAt: sql`now()`,
      },
    });

  // --- rsi.stock_rsi_percentile ---
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
        computedAt: sql`now()`,
      },
    });

  // --- swing.daily_ohlcv ---
  //    全 6mo を毎回 upsert する (旧 sync の挙動そのまま)
  const ohlcvRows = snap.ohlcv6mo.map((r) => ({
    stockId: snap.stockId,
    date: r.date,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
  }));
  if (ohlcvRows.length > 0) {
    await db
      .insert(swingSchema.dailyOhlcv)
      .values(ohlcvRows)
      .onConflictDoUpdate({
        target: [swingSchema.dailyOhlcv.stockId, swingSchema.dailyOhlcv.date],
        set: {
          open: sql`excluded.open`,
          high: sql`excluded.high`,
          low: sql`excluded.low`,
          close: sql`excluded.close`,
          volume: sql`excluded.volume`,
        },
      });
    // 古いレコード削除 (OHLCV_RETENTION_DAYS より前)
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

  // --- swing.stock_indicators ---
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
        computedAt: sql`now()`,
      },
    });

  // --- swing.stock_screening ---
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
        computedAt: sql`now()`,
      },
    });

  // --- swing.entry_signals ---
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

    await db
      .delete(swingSchema.entrySignals)
      .where(eq(swingSchema.entrySignals.stockId, snap.stockId));
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
        computedAt: sql`now()`,
      },
    });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
