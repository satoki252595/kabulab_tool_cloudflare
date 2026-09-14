/**
 * L2 投影 `p_yuho_growth` の再生成 (L-51/K4b)。
 *
 * 受注/海外スクリーニングの「(会計期末, 最新提出) 採用 → 直近 5 年窓 →
 * CAGR/YoY/比率」の畳み込みを、EDINET catchup の末尾で銘柄ごとに事前集計
 * する。画面 (order-query.ts / overseas-query.ts) はこの表を WHERE/ORDER BY
 * で引くだけになり、全ファクト走査 (6 万超 / 2.5 万 rows_read) が消える。
 *
 * 画面との一致は構造で保証する: 畳み込みの純関数 (reduceOrderWindow /
 * reduceOverseasWindow) が画面の旧実装と同じ式を持ち、読み側は格納値を
 * そのまま ScreenRow へ写す (再計算しない。地域比率だけ `+(yen/total*100)`
 * `.toFixed(1)` で復元し、旧 regionRatioOf と一致)。
 */
import { eq, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { yuhoGrowthProjection } from "../../../../src/shared/db/projection-schema.js";
import {
  orderFacts,
  overseasSalesFacts,
  yuhoDocuments,
} from "../db/schema.js";
import { MAX_YEARS } from "./order-query.js";
import { REGION_BUCKETS, bucketKeysFor } from "./overseas-query.js";

export type RegionBucketKey = keyof typeof REGION_BUCKETS;

function cagr(
  first: number | null,
  last: number | null,
  yearsSpan: number
): number | null {
  if (first === null || last === null) return null;
  if (first <= 0 || last <= 0 || yearsSpan < 1) return null;
  return Math.pow(last / first, 1 / yearsSpan) - 1;
}

function yoy(prev: number | null, last: number | null): number | null {
  if (prev === null || last === null || prev <= 0) return null;
  return last / prev - 1;
}

/** 比率 (%)。旧実装と同じ `+x.toFixed(1)` 丸め。 */
function ratioPct(part: number | null, total: number | null): number | null {
  if (part === null || total === null || total <= 0) return null;
  return +((part / total) * 100).toFixed(1);
}

// ---------------------------------------------------------------------------
// 受注側の畳み込み (旧 screenOrderGrowth と同じ式)
// ---------------------------------------------------------------------------

export interface OrderFactPoint {
  fy: string;
  ordersYen: number | null;
  backlogYen: number | null;
  submittedAt: Date;
}

export interface OrderWindow {
  years: number;
  firstFy: string;
  lastFy: string;
  firstOrdersYen: number | null;
  lastOrdersYen: number | null;
  firstBacklogYen: number | null;
  lastBacklogYen: number | null;
  ordersCagr: number | null;
  backlogCagr: number | null;
  ordersYoy: number | null;
  backlogYoy: number | null;
  hasYearGap: boolean;
}

/**
 * 1 銘柄の全社合計 (segment_kind='total') 行を直近 MAX_YEARS 年窓へ畳む。
 * 同一会計期末は提出日時が最新の書類を採用 (旧実装と同じ。タイは先勝ち)。
 * 行が無ければ null。
 */
export function reduceOrderWindow(points: OrderFactPoint[]): OrderWindow | null {
  const best = new Map<
    string,
    { sub: Date; ordersYen: number | null; backlogYen: number | null }
  >();
  for (const p of points) {
    const cur = best.get(p.fy);
    if (!cur || p.submittedAt > cur.sub) {
      best.set(p.fy, {
        sub: p.submittedAt,
        ordersYen: p.ordersYen,
        backlogYen: p.backlogYen,
      });
    }
  }
  const fys = [...best.keys()].sort().slice(-MAX_YEARS);
  if (fys.length === 0) return null;
  const series = fys.map((fy) => ({ fy, ...best.get(fy)! }));
  const first = series[0];
  const last = series[series.length - 1];
  const prev = series[series.length - 2] ?? null;
  const span = Number(last.fy.slice(0, 4)) - Number(first.fy.slice(0, 4));
  return {
    years: fys.length,
    firstFy: first.fy,
    lastFy: last.fy,
    firstOrdersYen: first.ordersYen,
    lastOrdersYen: last.ordersYen,
    firstBacklogYen: first.backlogYen,
    lastBacklogYen: last.backlogYen,
    ordersCagr: cagr(first.ordersYen, last.ordersYen, span),
    backlogCagr: cagr(first.backlogYen, last.backlogYen, span),
    ordersYoy: yoy(prev?.ordersYen ?? null, last.ordersYen),
    backlogYoy: yoy(prev?.backlogYen ?? null, last.backlogYen),
    hasYearGap: fys.length < span + 1,
  };
}

// ---------------------------------------------------------------------------
// 海外側の畳み込み (旧 screenOverseasGrowth と同じ式)
// ---------------------------------------------------------------------------

export interface OverseasFactPoint {
  fy: string;
  regionKind: string;
  regionName: string;
  salesYen: number | null;
  submittedAt: Date;
}

export interface OverseasWindow {
  years: number;
  firstFy: string;
  lastFy: string;
  firstOverseasYen: number | null;
  lastOverseasYen: number | null;
  lastTotalYen: number | null;
  firstRatioPct: number | null;
  latestRatioPct: number | null;
  overseasCagr: number | null;
  overseasYoy: number | null;
  hasYearGap: boolean;
  /** overseas_total 行を持つ (何期でも 1 行でも)。プルダウンの母集団用 */
  hasOverseasTotal: boolean;
  /** 末端 fy の地域バケット円貨。未開示バケットは null */
  regionYen: Record<RegionBucketKey, number | null>;
  /**
   * 合計行を持たないのに地域行だけある会計期末 (通常は空。不変条件
   * 「地域窓 = 合計窓」の監視用。再生成が警告ログに出す)。
   */
  regionOnlyFys: string[];
}

/**
 * 1 銘柄の海外売上行を直近 MAX_YEARS 年窓へ畳む。年窓は合計行
 * (overseas_total / total) の最新提出で決め、地域バケットは末端 fy の
 * 単独合致行だけ合計する (複合地域 "アジア・中国" 等は除外 = 中立)。
 * 旧実装の地域選択時と同じ値になる (不変条件は projection-schema.ts 参照)。
 * 行が無ければ null。
 */
export function reduceOverseasWindow(
  points: OverseasFactPoint[]
): OverseasWindow | null {
  type YearVals = {
    sub: Date;
    overseas: number | null;
    total: number | null;
    region: Record<RegionBucketKey, number | null>;
  };
  const blankRegion = (): Record<RegionBucketKey, number | null> => ({
    china: null,
    americas: null,
    europe: null,
    asia: null,
  });
  const best = new Map<string, YearVals>();
  let hasOverseasTotal = false;
  for (const p of points) {
    if (p.regionKind === "overseas_total") hasOverseasTotal = true;
    const isTotalRow =
      p.regionKind === "overseas_total" || p.regionKind === "total";
    // 単独バケット合致の overseas 行だけを当該バケットへ算入する
    let singleBucket: RegionBucketKey | null = null;
    if (p.regionKind === "overseas" && p.salesYen !== null) {
      const keys = bucketKeysFor(p.regionName);
      if (keys.length === 1) singleBucket = keys[0] as RegionBucketKey;
    }
    if (!isTotalRow && singleBucket === null) continue;
    const cur = best.get(p.fy);
    if (!cur || p.submittedAt > cur.sub) {
      const v: YearVals = {
        sub: p.submittedAt,
        overseas: null,
        total: null,
        region: blankRegion(),
      };
      if (p.regionKind === "overseas_total") v.overseas = p.salesYen;
      else if (p.regionKind === "total") v.total = p.salesYen;
      else if (singleBucket !== null) v.region[singleBucket] = p.salesYen;
      best.set(p.fy, v);
    } else if (p.submittedAt.getTime() === cur.sub.getTime()) {
      if (p.regionKind === "overseas_total") cur.overseas = p.salesYen;
      else if (p.regionKind === "total") cur.total = p.salesYen;
      else if (singleBucket !== null) {
        cur.region[singleBucket] =
          (cur.region[singleBucket] ?? 0) + (p.salesYen ?? 0);
      }
    }
  }
  // 合計行の無い fy に地域行だけ残ることは無い (パーサが原子的に出す)。
  // 壊れた入力が来たら窓から外して警告材料にする (捏造しない)。
  const regionOnlyFys = [...best.entries()]
    .filter(([, v]) => v.overseas === null && v.total === null)
    .map(([fy]) => fy);
  for (const fy of regionOnlyFys) best.delete(fy);

  const fys = [...best.keys()].sort().slice(-MAX_YEARS);
  if (fys.length === 0) {
    // 合計窓は空だが overseas_total 行自体はある銘柄 (全期が地域行のみ等)。
    // 画面には出さないが hasOverseasTotal だけは保持する。
    if (!hasOverseasTotal) return null;
    return {
      years: 0,
      firstFy: "",
      lastFy: "",
      firstOverseasYen: null,
      lastOverseasYen: null,
      lastTotalYen: null,
      firstRatioPct: null,
      latestRatioPct: null,
      overseasCagr: null,
      overseasYoy: null,
      hasYearGap: false,
      hasOverseasTotal,
      regionYen: blankRegion(),
      regionOnlyFys,
    };
  }
  const series = fys.map((fy) => ({ fy, ...best.get(fy)! }));
  const first = series[0];
  const last = series[series.length - 1];
  const prev = series[series.length - 2] ?? null;
  const span = Number(last.fy.slice(0, 4)) - Number(first.fy.slice(0, 4));
  return {
    years: fys.length,
    firstFy: first.fy,
    lastFy: last.fy,
    firstOverseasYen: first.overseas,
    lastOverseasYen: last.overseas,
    lastTotalYen: last.total,
    firstRatioPct: ratioPct(first.overseas, first.total),
    latestRatioPct: ratioPct(last.overseas, last.total),
    overseasCagr: cagr(first.overseas, last.overseas, span),
    overseasYoy: yoy(prev?.overseas ?? null, last.overseas),
    hasYearGap: fys.length < span + 1,
    hasOverseasTotal,
    regionYen: last.region,
    regionOnlyFys,
  };
}

// ---------------------------------------------------------------------------
// 再生成
// ---------------------------------------------------------------------------

export interface RebuildYuhoGrowthResult {
  stocks: number;
  elapsedSec: number;
}

/**
 * `p_yuho_growth` を全銘柄ぶん再生成する。EDINET catchup の末尾 (非シャード
 * 実行のみ) が呼ぶ。upsert は冪等で、今回触らなかった行は sweep で消す。
 */
export async function rebuildYuhoGrowthProjection(
  db: Database,
  options: { runStartedSec?: number } = {}
): Promise<RebuildYuhoGrowthResult> {
  const startedAt = Date.now();
  const runStartedSec =
    options.runStartedSec ?? Math.floor(startedAt / 1000);

  const orderRows = await db
    .select({
      stockId: orderFacts.stockId,
      fy: orderFacts.fiscalYearEnd,
      ordersYen: orderFacts.ordersReceivedYen,
      backlogYen: orderFacts.orderBacklogYen,
      submittedAt: yuhoDocuments.submittedAt,
    })
    .from(orderFacts)
    .innerJoin(yuhoDocuments, eq(orderFacts.documentId, yuhoDocuments.id))
    .where(eq(orderFacts.segmentKind, "total"));

  const overseasRows = await db
    .select({
      stockId: overseasSalesFacts.stockId,
      fy: overseasSalesFacts.fiscalYearEnd,
      regionKind: overseasSalesFacts.regionKind,
      regionName: overseasSalesFacts.regionName,
      salesYen: overseasSalesFacts.salesYen,
      submittedAt: yuhoDocuments.submittedAt,
    })
    .from(overseasSalesFacts)
    .innerJoin(
      yuhoDocuments,
      eq(overseasSalesFacts.documentId, yuhoDocuments.id)
    )
    .where(
      inArray(overseasSalesFacts.regionKind, [
        "overseas_total",
        "total",
        "overseas",
      ])
    );

  // MAX は生の epoch 秒で返る (drizzle は sql`` を Date 変換しない)
  const [maxDoc] = await db
    .select({
      maxSubmittedAt: sql<number | null>`MAX(${yuhoDocuments.submittedAt})`,
    })
    .from(yuhoDocuments);
  const sourceMaxDate = new Date((maxDoc?.maxSubmittedAt ?? 0) * 1000)
    .toISOString()
    .slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  const orderByStock = new Map<number, OrderFactPoint[]>();
  for (const r of orderRows) {
    const list = orderByStock.get(r.stockId);
    const pt = {
      fy: r.fy,
      ordersYen: r.ordersYen,
      backlogYen: r.backlogYen,
      submittedAt: r.submittedAt,
    };
    if (list) list.push(pt);
    else orderByStock.set(r.stockId, [pt]);
  }
  const overseasByStock = new Map<number, OverseasFactPoint[]>();
  for (const r of overseasRows) {
    const list = overseasByStock.get(r.stockId);
    const pt = {
      fy: r.fy,
      regionKind: r.regionKind,
      regionName: r.regionName,
      salesYen: r.salesYen,
      submittedAt: r.submittedAt,
    };
    if (list) list.push(pt);
    else overseasByStock.set(r.stockId, [pt]);
  }

  type Row = typeof yuhoGrowthProjection.$inferInsert;
  const rows: Row[] = [];
  for (const stockId of new Set([
    ...orderByStock.keys(),
    ...overseasByStock.keys(),
  ])) {
    const ord = reduceOrderWindow(orderByStock.get(stockId) ?? []);
    const ovs = reduceOverseasWindow(overseasByStock.get(stockId) ?? []);
    if (ord === null && ovs === null) continue;
    if (ovs && ovs.regionOnlyFys.length > 0) {
      // 不変条件「地域窓 = 合計窓」の破れ。画面の地域選択時と値がずれる
      // ので、運用ログに残して気づけるようにする (落とさない)。
      console.warn(
        `[yuho-projection] stock_id=${stockId} に合計行の無い地域行がある: ${ovs.regionOnlyFys.join(",")}`
      );
    }
    rows.push({
      stockId,
      ordYears: ord?.years ?? 0,
      ordFirstFy: ord?.firstFy ?? "",
      ordLastFy: ord?.lastFy ?? "",
      ordFirstOrdersYen: ord?.firstOrdersYen ?? null,
      ordLastOrdersYen: ord?.lastOrdersYen ?? null,
      ordFirstBacklogYen: ord?.firstBacklogYen ?? null,
      ordLastBacklogYen: ord?.lastBacklogYen ?? null,
      ordOrdersCagr: ord?.ordersCagr ?? null,
      ordBacklogCagr: ord?.backlogCagr ?? null,
      ordOrdersYoy: ord?.ordersYoy ?? null,
      ordBacklogYoy: ord?.backlogYoy ?? null,
      ordHasYearGap: ord?.hasYearGap ?? false,
      ovsYears: ovs?.years ?? 0,
      ovsFirstFy: ovs?.firstFy ?? "",
      ovsLastFy: ovs?.lastFy ?? "",
      ovsFirstOverseasYen: ovs?.firstOverseasYen ?? null,
      ovsLastOverseasYen: ovs?.lastOverseasYen ?? null,
      ovsLastTotalYen: ovs?.lastTotalYen ?? null,
      ovsFirstRatioPct: ovs?.firstRatioPct ?? null,
      ovsLatestRatioPct: ovs?.latestRatioPct ?? null,
      ovsOverseasCagr: ovs?.overseasCagr ?? null,
      ovsOverseasYoy: ovs?.overseasYoy ?? null,
      ovsHasYearGap: ovs?.hasYearGap ?? false,
      ovsHasOverseasTotal: ovs?.hasOverseasTotal ?? false,
      ovsRegionChinaYen: ovs?.regionYen.china ?? null,
      ovsRegionAmericasYen: ovs?.regionYen.americas ?? null,
      ovsRegionEuropeYen: ovs?.regionYen.europe ?? null,
      ovsRegionAsiaYen: ovs?.regionYen.asia ?? null,
      asOf: today,
      sourceMaxDate,
      computedAt: new Date(runStartedSec * 1000),
    });
  }

  // 30 列 × 3 行 = 90 binds/文 (D1 上限 100)。列を足したら直すこと。
  const ROWS_PER_STATEMENT = 3;
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    const chunk = rows.slice(i, i + ROWS_PER_STATEMENT);
    await db
      .insert(yuhoGrowthProjection)
      .values(chunk)
      .onConflictDoUpdate({
        target: yuhoGrowthProjection.stockId,
        set: {
          ordYears: sql`excluded.ord_years`,
          ordFirstFy: sql`excluded.ord_first_fy`,
          ordLastFy: sql`excluded.ord_last_fy`,
          ordFirstOrdersYen: sql`excluded.ord_first_orders_yen`,
          ordLastOrdersYen: sql`excluded.ord_last_orders_yen`,
          ordFirstBacklogYen: sql`excluded.ord_first_backlog_yen`,
          ordLastBacklogYen: sql`excluded.ord_last_backlog_yen`,
          ordOrdersCagr: sql`excluded.ord_orders_cagr`,
          ordBacklogCagr: sql`excluded.ord_backlog_cagr`,
          ordOrdersYoy: sql`excluded.ord_orders_yoy`,
          ordBacklogYoy: sql`excluded.ord_backlog_yoy`,
          ordHasYearGap: sql`excluded.ord_has_year_gap`,
          ovsYears: sql`excluded.ovs_years`,
          ovsFirstFy: sql`excluded.ovs_first_fy`,
          ovsLastFy: sql`excluded.ovs_last_fy`,
          ovsFirstOverseasYen: sql`excluded.ovs_first_overseas_yen`,
          ovsLastOverseasYen: sql`excluded.ovs_last_overseas_yen`,
          ovsLastTotalYen: sql`excluded.ovs_last_total_yen`,
          ovsFirstRatioPct: sql`excluded.ovs_first_ratio_pct`,
          ovsLatestRatioPct: sql`excluded.ovs_latest_ratio_pct`,
          ovsOverseasCagr: sql`excluded.ovs_overseas_cagr`,
          ovsOverseasYoy: sql`excluded.ovs_overseas_yoy`,
          ovsHasYearGap: sql`excluded.ovs_has_year_gap`,
          ovsHasOverseasTotal: sql`excluded.ovs_has_overseas_total`,
          ovsRegionChinaYen: sql`excluded.ovs_region_china_yen`,
          ovsRegionAmericasYen: sql`excluded.ovs_region_americas_yen`,
          ovsRegionEuropeYen: sql`excluded.ovs_region_europe_yen`,
          ovsRegionAsiaYen: sql`excluded.ovs_region_asia_yen`,
          asOf: sql`excluded.as_of`,
          sourceMaxDate: sql`excluded.source_max_date`,
          computedAt: sql`excluded.computed_at`,
        },
      });
  }

  // 今回触らなかった行 (ファクトが消えた銘柄) を掃除する
  await db
    .delete(yuhoGrowthProjection)
    .where(lt(yuhoGrowthProjection.computedAt, new Date(runStartedSec * 1000)));

  const elapsedSec = (Date.now() - startedAt) / 1000;
  console.info(
    `[yuho-projection] 完了: ${rows.length} 銘柄 所要=${elapsedSec.toFixed(1)}s`
  );
  return { stocks: rows.length, elapsedSec };
}
