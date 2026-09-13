/**
 * 月次 rebuild オーケストレータ（Cloudflare Worker 版・ADR-0001 Phase 3）
 *
 * core_* / swing_* / yutai_benefits を読んで otakara の派生テーブル
 * (otakara_stock_financials / otakara_stock_scores) を再構築する。
 *
 * 特徴:
 *   - Yahoo を 1 回も叩かない (日次 sync が取得済みのデータを DB 経由で再利用)
 *   - D1 バインディング + db.batch (1 銘柄=2 upsert を 1 バッチ)
 *   - 起動: Workers Cron (scheduled) / 認証ルート POST /admin/sync-monthly
 *
 * 母集団 (core_stocks) の JPX 同期は xlsx パーサが Node 専用のため Worker 不可。
 * `pnpm sync:universe`（Node）で別途同期してから本 rebuild を走らせる。
 *
 * CLAUDE.md のフォールバック禁止ルールに従い:
 *   - core_stock_financials が未作成の銘柄はスコア計算をスキップ (silent 0 にはしない)
 */

import { sql, eq, and, isNotNull } from "drizzle-orm";
import { createD1HttpDb } from "../shared/db/d1-http-client.js";
import { activeEquityCondition } from "../shared/db/active-equity.js";

import * as coreSchema from "../../services/rsi-screening/src/db/core-schema.js";
import * as swingSchema from "../../services/swing-trading/src/db/schema.js";
import * as otakaraSchema from "../../services/otakara-yutai/src/db/schema.js";

import { scoreStock, type ScoringInput } from "../shared/scoring.js";

const SCHEMAS = { ...swingSchema, ...otakaraSchema };
type Db = ReturnType<typeof createMonthlyRebuildDb>;

export interface MonthlyRebuildResult {
  scoredStocks: number;
  elapsedSec: number;
}

/** Node→D1 HTTP クライアント (取込専用)。CLOUDFLARE_* env を内部で解決する。 */
export function createMonthlyRebuildDb() {
  return createD1HttpDb(SCHEMAS);
}

export async function runMonthlyRebuild(db: Db): Promise<MonthlyRebuildResult> {
  const startedAt = Date.now();

  // -----------------------------------------------------------------
  // Phase 1: is_yutai を yutai_benefits から導出 (自己修復)
  //
  // is_yutai は「優待がある銘柄か」= yutai_benefits に行が存在するか、と一意に
  // 定まる。母集団 seed (sync:universe) は is_yutai を触らないため、ここで毎月
  // yutai_benefits を真実として再導出する。
  // -----------------------------------------------------------------
  console.info("[sync-monthly] Phase 1: is_yutai 導出 (yutai_benefits 基準)");
  const yutaiExists = sql`EXISTS (SELECT 1 FROM ${otakaraSchema.yutaiBenefits} WHERE ${otakaraSchema.yutaiBenefits.stockId} = ${coreSchema.stocks.id})`;
  await db
    .update(coreSchema.stocks)
    .set({ isYutai: yutaiExists, updatedAt: sql`(unixepoch())` })
    .where(sql`${coreSchema.stocks.isYutai} <> (${yutaiExists})`);

  // -----------------------------------------------------------------
  // Phase 2: otakara public 再構築
  //
  // core_stock_financials + swing_stock_indicators + yutai_benefits を読んで、
  // otakara_stock_financials と otakara_stock_scores に書き戻す。
  // D1 bind 上限のため inArray は使わず全件 SELECT + in-memory Map で引く。
  // -----------------------------------------------------------------
  console.info("[sync-monthly] Phase 2: otakara public 再構築");

  // 母集団は日次 (src/cron/daily.ts の loadDailyTargets) と同じ active かつ equity。
  // 日次を equity に絞ったため、非普通株の断面 (core_stock_financials /
  // swing_stock_indicators) は更新されず凍結する。凍結した値に今日の data_date を
  // 付けて再構築しない (ルール2: 古い値に新しい日付を付けて「今日の値」を名乗らせない)。
  // 既に書かれている非普通株の otakara 行は消さない。公開面は同じ述語で隠す。
  const activeStocks = await db
    .select({ id: coreSchema.stocks.id, code: coreSchema.stocks.code })
    .from(coreSchema.stocks)
    .where(and(activeEquityCondition(), eq(coreSchema.stocks.isYutai, true)));

  const coreFinancials = await db.select().from(coreSchema.stockFinancials);
  const coreFinMap = new Map(coreFinancials.map((f) => [f.stockId, f]));

  const swingIndicators = await db.select().from(swingSchema.stockIndicators);
  const swingIndMap = new Map(swingIndicators.map((i) => [i.stockId, i]));

  // 金額換算できた行だけを対象にする。利回りは「**価値が算定できる最小の
  // 保有段階**での利回り」と定義する。NULL 行も含めて最低単元を決めると、
  // 最小段階の優待が金額換算不能な銘柄で分子が 0 になり、本来 0.3% などの
  // 妥当な利回りが出ていた 95 銘柄が一斉に算定不能になる（本番データで実測）。
  const benefitRows = await db
    .select({
      stockId: otakaraSchema.yutaiBenefits.stockId,
      minShares: otakaraSchema.yutaiBenefits.minShares,
      estimatedValue: otakaraSchema.yutaiBenefits.estimatedValue,
    })
    .from(otakaraSchema.yutaiBenefits)
    .where(isNotNull(otakaraSchema.yutaiBenefits.estimatedValue));
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

    // 1 銘柄=2 upsert を逐次実行 (createD1HttpDb は db.batch 非対応・冪等)。
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
          fetchedAt: sql`(unixepoch())`,
        },
      });
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
          scoredAt: sql`(unixepoch())`,
        },
      });

    scoredCount++;
  }

  const elapsedSec = (Date.now() - startedAt) / 1000;
  console.info(
    `[sync-monthly] 完了: 優待スコア=${scoredCount} 所要=${elapsedSec.toFixed(1)}s`
  );

  return { scoredStocks: scoredCount, elapsedSec };
}

/**
 * 優待利回りを算出する
 *
 * 優待利回り(%) = (優待の推定価値合計 / (株価 × 最低必要株数)) × 100
 *
 * 「保有しているだけで確実に受け取れる価値」だけを分子に入れる。
 * 抽選や、大きな買い物を条件にするキャッシュバックを合算すると、
 * 実在しない利回りが出る（本番実測）:
 *
 *   7578  65円 ×100株=6,500円 に対し「50万円相当の商品券贈呈(抽選)」を
 *         3月・9月の2回ぶん確定価値として合算 → 16,676.9%
 *   3477  「新築分譲住宅のキャッシュバック20万円」を年2回合算 → 455.3%
 *   5618  「定額カルモくん申込みで100,000円キャッシュバック」 → 694.2%
 *
 * いずれもスクリーニングの上位に出ていた。
 */

/**
 * 条件付き優待を**文言では判定しない**（判定器を作らない）。
 *
 * 検討して捨てた案を記録しておく。本番データで実際に試した結果である。
 *
 * - 「キャッシュバック」「申込み」「入会時」「購入時」等で弾く
 *   → 「買物金額の5%キャッシュバック」のような正当な優待も同じ語を使うため、
 *      利回り 0.3% の銘柄まで含め **93 銘柄が誤って算定不能**になった
 * - 「抽選」だけで弾く
 *   → 「抽選**に当選されなかった場合は**3,000円相当」(2751 = 必ずもらえる)、
 *      「特製QUOカード1,000円相当…フジテレビ番組観覧(抽選)」(4676 = QUOカードは確実)、
 *      「…日本酒のセット、抽選で塩数の子は上限1000個」(2683 = 本体は確実)
 *      のように、**優待の一部だけが抽選**のケースを丸ごと落としてしまう
 *
 * 「優待全体が抽選か、一部だけか」をテキストから見分けるのは推定であり、
 * §3-1 に反する。桁外れの値は下の上限側で拾えば足りる。
 */

/**
 * これを超える優待利回りは推定が壊れているとみなし、値を出さない。
 *
 * 本番 1,261 銘柄の実測分布: ≤5% が 86.8% / ≤10% が 94.9% / ≤30% が 98.3% /
 * ≤50% が 98.6%。50% 超の 18 件（1.4%）はすべて上記の条件付き優待が
 * 混ざったもので、実在する利回りではない。
 *
 * 推定できない優待を 0 円として扱うのではなく **値を出さない**のは、
 * 既存の「金額換算が難しい優待」表示と同じ方針（§3-1 推定禁止）。
 */
export const YUTAI_YIELD_MAX_PCT = 50;

export function calcYutaiYield(
  price: number | null,
  benefits: ReadonlyArray<{
    minShares: number;
    estimatedValue: number | null;
  }>
): number | null {
  if (price === null || price <= 0) return null;
  if (benefits.length === 0) return null;

  // 価値が算定できる行のうち最小の保有段階（呼び出し側が NULL 行を除いている）
  const minRequired = Math.min(...benefits.map((b) => b.minShares));
  const investmentAmount = price * minRequired;
  const totalValue = benefits
    .filter((b) => b.minShares <= minRequired)
    .reduce((sum, b) => sum + (b.estimatedValue ?? 0), 0);

  if (totalValue <= 0) return null;
  const pct = (totalValue / investmentAmount) * 100;
  // 上限超過は「高利回り」ではなく「推定が壊れている」。値を出さない。
  if (pct > YUTAI_YIELD_MAX_PCT) return null;
  return pct;
}
