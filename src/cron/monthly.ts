/**
 * 月次 sync オーケストレータ
 *
 * Phase 1: JPX 公式 XLS から core.stocks.sector を更新
 * Phase 2: core / swing から otakara public.stock_financials と public.stock_scores を再構築
 *
 * 特徴:
 *   - Yahoo を 1 回も叩かない (日次 sync が取得済みのデータを DB 経由で再利用)
 *   - 実行時間 <1 分 (1580 銘柄でも DB 内の SELECT + 計算のみ)
 *
 * CLAUDE.md のフォールバック禁止ルールに従い:
 *   - JPX HTTP エラーは throw
 *   - core.stock_financials が未作成の銘柄はスコア計算をスキップ (silent 0 にはしない)
 */

import { sql, eq, and, isNotNull, inArray } from "drizzle-orm";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

import * as coreSchema from "../../services/rsi-screening/src/db/core-schema.js";
import * as rsiSchema from "../../services/rsi-screening/src/db/schema.js";
import * as swingSchema from "../../services/swing-trading/src/db/schema.js";
import * as otakaraSchema from "../../services/otakara-yutai/src/db/schema.js";

import { downloadJpxListing } from "../shared/jpx/sectors.js";
import { seedUniverse, type UniverseSyncResult } from "./universe.js";
import { scoreStock, type ScoringInput } from "../shared/scoring.js";

const SCHEMAS = {
  ...coreSchema,
  ...rsiSchema,
  ...swingSchema,
  ...otakaraSchema,
};

type Db = ReturnType<typeof drizzle<typeof SCHEMAS>>;

export interface MonthlySyncResult {
  universe: UniverseSyncResult;
  scoredStocks: number;
  elapsedSec: number;
}

export function createMonthlyDb(databaseUrl: string): Db {
  const neonSql = neon(databaseUrl);
  return drizzle(neonSql, { schema: SCHEMAS });
}

export async function runMonthlySync(db: Db): Promise<MonthlySyncResult> {
  const startedAt = Date.now();

  // -----------------------------------------------------------------
  // Phase 1: 母集団 (core.stocks) を全 JPX 内国株へ同期
  //
  // 旧 Phase 1 は「既存 active 銘柄のセクター更新」のみだったが、母集団を
  // 優待縛りから全 JPX 上場株へ拡張するため、ここで JPX 内国普通株を
  // upsert (新規 insert + name/market/sector 更新 + 廃止 inactivate) する。
  // セクター更新は upsert の中に内包される。
  // -----------------------------------------------------------------
  console.info("[sync-monthly] Phase 1: 母集団同期 (全 JPX 内国株)");
  const jpxRows = await downloadJpxListing();
  console.info(`[sync-monthly]   JPX 取得: ${jpxRows.length} 行`);
  const universe = await seedUniverse(db, jpxRows);
  console.info(
    `[sync-monthly]   内国株=${universe.equities} upsert=${universe.upserted} 廃止=${universe.delisted}`
  );

  // -----------------------------------------------------------------
  // Phase 1.5: is_yutai を yutai_benefits から導出 (自己修復)
  //
  // is_yutai は「優待がある銘柄か」= public.yutai_benefits に行が存在するか、
  // と一意に定まる。母集団 seed (sync:universe) は is_yutai を触らないため、
  // ここで毎月 yutai_benefits を真実として再導出する。これにより母集団
  // 再 seed や is_yutai 列追加直後でも otakara が壊れない (現行どおり動く)。
  // yutai_benefits 自体の更新は優待スクレイパーが担当 (Yahoo とは別ソース)。
  // -----------------------------------------------------------------
  console.info("[sync-monthly] Phase 1.5: is_yutai 導出 (yutai_benefits 基準)");
  // 差分のある行だけ 1 文で真実値へ収束させる (drizzle/backfill-is-yutai-from-benefits.sql
  // と同一述語。HTTP 1 往復・両ソースのロジック一本化)。
  const yutaiExists = sql`EXISTS (SELECT 1 FROM ${otakaraSchema.yutaiBenefits} WHERE ${otakaraSchema.yutaiBenefits.stockId} = ${coreSchema.stocks.id})`;
  const yutaiSync = await db
    .update(coreSchema.stocks)
    .set({ isYutai: yutaiExists, updatedAt: sql`now()` })
    .where(sql`${coreSchema.stocks.isYutai} <> (${yutaiExists})`);
  console.info(
    `[sync-monthly]   is_yutai 同期 (差分更新)=${yutaiSync.rowCount ?? 0}`
  );

  // -----------------------------------------------------------------
  // Phase 2: otakara public 再構築
  //
  // core.stock_financials + swing.stock_indicators + yutai_benefits を読んで、
  // public.stock_financials と public.stock_scores に書き戻す。
  // -----------------------------------------------------------------
  console.info("[sync-monthly] Phase 2: otakara public 再構築");

  //    active かつ優待実施 (is_yutai) の銘柄のみを otakara public へ。
  //    母集団は全 JPX ~4,000 だが otakara は優待サービスなので、
  //    public.stock_financials / stock_scores は優待銘柄に限定して
  //    Neon 容量を抑える (CLAUDE.md のコスト方針)。
  const activeStocks = await db
    .select({ id: coreSchema.stocks.id, code: coreSchema.stocks.code })
    .from(coreSchema.stocks)
    .where(
      and(
        eq(coreSchema.stocks.isActive, true),
        eq(coreSchema.stocks.isYutai, true)
      )
    );

  const activeIds = activeStocks.map((s) => s.id);

  //    core.stock_financials を一括取得 (1580 行程度)
  const coreFinancials = activeIds.length > 0
    ? await db
        .select()
        .from(coreSchema.stockFinancials)
        .where(inArray(coreSchema.stockFinancials.stockId, activeIds))
    : [];
  const coreFinMap = new Map(coreFinancials.map((f) => [f.stockId, f]));

  //    swing.stock_indicators を一括取得
  const swingIndicators = activeIds.length > 0
    ? await db
        .select()
        .from(swingSchema.stockIndicators)
        .where(inArray(swingSchema.stockIndicators.stockId, activeIds))
    : [];
  const swingIndMap = new Map(swingIndicators.map((i) => [i.stockId, i]));

  //    yutai_benefits (estimated_value ありのみ) を一括取得 →
  //    stock_id ごとに group
  const benefitRows = activeIds.length > 0
    ? await db
        .select({
          stockId: otakaraSchema.yutaiBenefits.stockId,
          minShares: otakaraSchema.yutaiBenefits.minShares,
          estimatedValue: otakaraSchema.yutaiBenefits.estimatedValue,
        })
        .from(otakaraSchema.yutaiBenefits)
        .where(
          and(
            inArray(otakaraSchema.yutaiBenefits.stockId, activeIds),
            isNotNull(otakaraSchema.yutaiBenefits.estimatedValue)
          )
        )
    : [];
  const benefitMap = new Map<number, typeof benefitRows>();
  for (const b of benefitRows) {
    const list = benefitMap.get(b.stockId);
    if (list) list.push(b);
    else benefitMap.set(b.stockId, [b]);
  }

  let scoredCount = 0;
  const today = new Date().toISOString().split("T")[0];

  for (const s of activeStocks) {
    const core = coreFinMap.get(s.id);
    if (!core) continue; // 未取得銘柄はスキップ (silent 0 は禁止)

    const swing = swingIndMap.get(s.id);
    const benefits = benefitMap.get(s.id) ?? [];
    const yutaiYield = calcYutaiYield(core.price, benefits);

    const input: ScoringInput = {
      price: core.price,
      per: core.per,
      pbr: core.pbr,
      dividendYield: core.dividendYield,
      roe: core.roe,
      ma25: swing?.sma25 ?? null,
      rsi14: swing?.rsi14 ?? null,
      macd: swing?.macd ?? null,
      macdSignal: swing?.macdSignal ?? null,
      yutaiYield,
    };
    const score = scoreStock(input);

    //    public.stock_financials に upsert
    //    (このサービスは 002 otakara の UI で使う mirror。ma5/ma75/roa も格納)
    await db
      .insert(otakaraSchema.stockFinancials)
      .values({
        stockId: s.id,
        price: core.price,
        per: core.per,
        pbr: core.pbr,
        dividendYield: core.dividendYield,
        eps: core.eps,
        bps: core.bps,
        roe: core.roe,
        roa: core.roa,
        marketCap: core.marketCap,
        ma5: swing?.sma5 ?? null,
        ma25: swing?.sma25 ?? null,
        ma75: swing?.sma75 ?? null,
        rsi14: swing?.rsi14 ?? null,
        macd: swing?.macd ?? null,
        macdSignal: swing?.macdSignal ?? null,
        yutaiYield,
        dataDate: today,
      })
      .onConflictDoUpdate({
        target: otakaraSchema.stockFinancials.stockId,
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
          ma5: sql`excluded.ma_5`,
          ma25: sql`excluded.ma_25`,
          ma75: sql`excluded.ma_75`,
          rsi14: sql`excluded.rsi_14`,
          macd: sql`excluded.macd`,
          macdSignal: sql`excluded.macd_signal`,
          yutaiYield: sql`excluded.yutai_yield`,
          dataDate: sql`excluded.data_date`,
          fetchedAt: sql`now()`,
        },
      });

    //    public.stock_scores に upsert
    await db
      .insert(otakaraSchema.stockScores)
      .values({
        stockId: s.id,
        fundamentalScore: score.fundamentalScore,
        technicalScore: score.technicalScore,
        totalScore: score.totalScore,
      })
      .onConflictDoUpdate({
        target: otakaraSchema.stockScores.stockId,
        set: {
          fundamentalScore: sql`excluded.fundamental_score`,
          technicalScore: sql`excluded.technical_score`,
          totalScore: sql`excluded.total_score`,
          scoredAt: sql`now()`,
        },
      });

    scoredCount++;
  }

  const elapsedSec = (Date.now() - startedAt) / 1000;
  console.info(
    `[sync-monthly] 完了: 内国株=${universe.equities} 廃止=${universe.delisted} 優待スコア=${scoredCount} 所要=${elapsedSec.toFixed(1)}s`
  );

  return {
    universe,
    scoredStocks: scoredCount,
    elapsedSec,
  };
}

/**
 * 優待利回りを算出する
 *
 * 優待利回り(%) = (優待の推定価値合計 / (株価 × 最低必要株数)) × 100
 *
 * 最低必要株数が最小の優待を基準にして、その株数で受けられる全優待の推定価値を合算する。
 */
function calcYutaiYield(
  price: number | null,
  benefits: ReadonlyArray<{
    minShares: number;
    estimatedValue: number | null;
  }>
): number | null {
  if (price === null || price <= 0) return null;
  if (benefits.length === 0) return null;

  const minRequired = Math.min(...benefits.map((b) => b.minShares));
  const investmentAmount = price * minRequired;
  const totalValue = benefits
    .filter((b) => b.minShares <= minRequired)
    .reduce((sum, b) => sum + (b.estimatedValue ?? 0), 0);

  if (totalValue <= 0) return null;
  return (totalValue / investmentAmount) * 100;
}
