/**
 * UI 向けクエリ層。受注高/受注残高 の 5 年推移をセグメント別 + 全社合計で返す。
 *
 * ルール2: データが無い銘柄に架空値を作らない。空配列・null をそのまま返し、
 * ビュー側で「受注データなし / 未対応」と正直に表示させる。訂正報告書
 * (docTypeCode 130) 等で同一会計期末が重複する場合は提出日時が新しい
 * 書類の値を採用する (黙って先頭を選ばない — 明示的に最新を選ぶ)。
 */
import { and, desc, eq, like, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { parseStockCode } from "../../../../src/shared/jpx/stock-code.js";
import { stocks, stockFinancials } from "../../../../src/shared/db/core-schema.js";
import {
  publicMarketColumn,
  publicSectorColumn,
} from "../../../../src/shared/db/public-columns.js";
import { yuhoDocuments, orderFacts } from "../db/schema.js";

/** サービスで表示する最大年数 (EDINET 取得可能な過去分の上限と整合) */
export const MAX_YEARS = 5;

export interface StockHit {
  id: number;
  code: string;
  name: string;
  /** 市場区分。JPX 由来 = personal-only なので既定では常に `null`。 */
  market: string | null;
  /** 業種。既定では `core_stocks.sector33` (EDINET 提出者業種)。 */
  sector: string | null;
}

export async function searchStocks(
  db: Database,
  query: string
): Promise<StockHit[]> {
  const q = query.trim();
  if (q === "") return [];
  const pat = `%${q}%`;
  // 完全一致の昇格は「正準形コード」で判定する (利用者が 130a と打っても DB の
  // 130A を先頭へ)。コードとして妥当でない検索語 (会社名など) は null になり、
  // case-sensitive な = 比較が一致せず昇格しないだけで害はない。name の部分一致
  // (ilike) は大小無視なので raw q のまま使う。
  const exactCode = parseStockCode(q);
  return db
    .select({
      id: stocks.id,
      code: stocks.code,
      name: stocks.name,
      // JPX 由来は公開面へ出さない (src/shared/db/public-columns.ts)。
      market: publicMarketColumn,
      sector: publicSectorColumn,
    })
    .from(stocks)
    .where(
      and(
        eq(stocks.isActive, true),
        or(like(stocks.code, pat), like(stocks.name, pat))
      )
    )
    .orderBy(
      sql`case when ${stocks.code} = ${exactCode} then 0 else 1 end`,
      stocks.code
    )
    .limit(20);
}

export interface OrderYearPoint {
  fiscalYearEnd: string;
  isConsolidated: boolean | null;
  unitLabel: string;
  /** 全社合計 (segment_kind='total')。無ければ null */
  totalOrdersYen: number | null;
  totalBacklogYen: number | null;
  /** セグメント別内訳 (segment_kind='segment' のみ) */
  segments: Array<{
    name: string;
    ordersYen: number | null;
    backlogYen: number | null;
  }>;
}

export interface OrderTrend {
  stock: StockHit;
  /** 取り込んだ有報のうち最新の parse_status 群 (UI の事実表示用) */
  documents: Array<{
    docId: string;
    periodEnd: string;
    submittedAt: Date;
    docTypeCode: string;
    parseStatus: string;
  }>;
  /** 古い→新しい順。最大 MAX_YEARS 年 */
  points: OrderYearPoint[];
  /** 構造化済みデータが 1 つでもあるか (false なら UI は「データなし/未対応」) */
  hasStructuredData: boolean;
}

/**
 * 証券コード (ティッカー) で受注推移を引く。URL は人が打つので内部
 * serial id ではなくコードで解決する (例 /stock/7011, /stock/130A)。
 * 数字 4 桁と JPX 英数字コードの両方を受理し、形式不正・該当なしは null。
 */
export async function getOrderTrendByCode(
  db: Database,
  code: string
): Promise<OrderTrend | null> {
  const c = parseStockCode(code);
  if (c === null) return null;
  const [hit] = await db
    .select({ id: stocks.id })
    .from(stocks)
    .where(eq(stocks.code, c))
    .limit(1);
  if (!hit) return null;
  return getOrderTrend(db, hit.id);
}

export async function getOrderTrend(
  db: Database,
  stockId: number
): Promise<OrderTrend | null> {
  const [stock] = await db
    .select({
      id: stocks.id,
      code: stocks.code,
      name: stocks.name,
      // JPX 由来は公開面へ出さない (src/shared/db/public-columns.ts)。
      market: publicMarketColumn,
      sector: publicSectorColumn,
    })
    .from(stocks)
    .where(eq(stocks.id, stockId))
    .limit(1);
  if (!stock) return null;

  const docs = await db
    .select({
      docId: yuhoDocuments.docId,
      periodEnd: yuhoDocuments.periodEnd,
      submittedAt: yuhoDocuments.submittedAt,
      docTypeCode: yuhoDocuments.docTypeCode,
      parseStatus: yuhoDocuments.parseStatus,
    })
    .from(yuhoDocuments)
    .where(eq(yuhoDocuments.stockId, stockId))
    .orderBy(desc(yuhoDocuments.submittedAt));

  const rows = await db
    .select({
      fiscalYearEnd: orderFacts.fiscalYearEnd,
      segmentName: orderFacts.segmentName,
      segmentKind: orderFacts.segmentKind,
      isConsolidated: orderFacts.isConsolidated,
      unitLabel: orderFacts.unitLabel,
      ordersYen: orderFacts.ordersReceivedYen,
      backlogYen: orderFacts.orderBacklogYen,
      submittedAt: yuhoDocuments.submittedAt,
    })
    .from(orderFacts)
    .innerJoin(yuhoDocuments, eq(orderFacts.documentId, yuhoDocuments.id))
    .where(eq(orderFacts.stockId, stockId));

  // (会計期末, セグメント) ごとに「提出日時が最新の書類」の値を採用
  const best = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const key = `${r.fiscalYearEnd}${r.segmentName}`;
    const cur = best.get(key);
    if (!cur || r.submittedAt > cur.submittedAt) best.set(key, r);
  }

  const byYear = new Map<string, OrderYearPoint>();
  for (const r of best.values()) {
    let p = byYear.get(r.fiscalYearEnd);
    if (!p) {
      p = {
        fiscalYearEnd: r.fiscalYearEnd,
        isConsolidated: r.isConsolidated,
        unitLabel: r.unitLabel,
        totalOrdersYen: null,
        totalBacklogYen: null,
        segments: [],
      };
      byYear.set(r.fiscalYearEnd, p);
    }
    if (r.segmentKind === "total") {
      p.totalOrdersYen = r.ordersYen;
      p.totalBacklogYen = r.backlogYen;
    } else if (r.segmentKind === "segment") {
      p.segments.push({
        name: r.segmentName,
        ordersYen: r.ordersYen,
        backlogYen: r.backlogYen,
      });
    }
  }

  const points = [...byYear.values()]
    .sort((a, b) => a.fiscalYearEnd.localeCompare(b.fiscalYearEnd))
    .slice(-MAX_YEARS);

  return {
    stock,
    documents: docs.map((d) => ({
      docId: d.docId,
      periodEnd: d.periodEnd,
      submittedAt: d.submittedAt,
      docTypeCode: d.docTypeCode,
      parseStatus: d.parseStatus,
    })),
    points,
    hasStructuredData: points.length > 0,
  };
}

// ===========================================================================
// 受注高/受注残高 成長性スクリーニング (会社全体=segment_kind='total')
// ===========================================================================

export type GrowthMetric = "orders" | "backlog";

export interface ScreenOpts {
  /** 並び替え基準の指標 (この指標の年率降順)。順位付け不能 (null) な銘柄は除外 */
  metric: GrowthMetric;
  /** 必要な年数 (これ未満はデータ不足として除外, 既定 3) */
  minYears: number;
  /**
   * 受注高/受注残高 を**独立**に条件化する (ユーザ要件: 同時にスクリーニング)。
   * 旧設計の「metric 側だけ絞る」を辞めて、両方とも個別に下限指定できる。
   * 未指定 (undefined) = 解除。指定したがその指標の値が null = 充足不能で除外
   * (ルール2: 欠損を黙って通さない)。
   */
  /** 受注高 年率(%) 下限 (未指定なら絞らない) */
  minOrdersCagrPct?: number;
  /** 受注残高 年率(%) 下限 */
  minBacklogCagrPct?: number;
  /** 業種 (公開面が出している業種列。src/shared/db/public-columns.ts) 完全一致で絞る */
  sector?: string;
  /**
   * ファンダメンタルズ絞り込み (共有 core.stock_financials 由来。Yahoo Finance)。
   * 結果表には出さず「条件」としてのみ使う (ユーザ要件)。指定された条件に
   * 対し当該銘柄の財務値が NULL の場合は条件を満たせないので除外する
   * (ルール2: 欠損を黙って通さない / 架空値で埋めない)。
   */
  /** 営業利益率 (%) 下限。core.operating_margin は小数 (0.1234=12.34%) */
  minOpMarginPct?: number;
  /** 時価総額 (億円) 下限。core.market_cap は円なので /1e8 して比較 */
  minMarketCapOku?: number;
  /** 時価総額 (億円) 上限。小型株抽出用。下限と併用でレンジ検索 */
  maxMarketCapOku?: number;
  /** PER (倍) 上限。core.per が正かつこの値以下のみ */
  maxPer?: number;
  /** ROE (%) 下限。core.roe は小数 (0.15=15%) */
  minRoePct?: number;
  /** 配当利回り (%) 下限。core.dividend_yield は既に % 値 (3.43=3.43%) */
  minDivYieldPct?: number;
  /** 返却上限 (既定 100) */
  limit: number;
}

export interface ScreenRow {
  code: string;
  name: string;
  sector: string | null;
  /** 成長率計算に使った会計年度数 */
  years: number;
  firstFiscalYearEnd: string;
  lastFiscalYearEnd: string;
  latestOrdersYen: number | null;
  latestBacklogYen: number | null;
  /** 年率の起点額 (初年度値)。微小基準で年率が誇張される判定に使う */
  firstOrdersYen: number | null;
  firstBacklogYen: number | null;
  /** データ点数 < 暦年差+1 (=途中年が欠落) なら true (誤読防止フラグ) */
  hasYearGap: boolean;
  /** 年平均成長率 (小数。例 0.123=+12.3%)。基準<=0 や 1 年は null (捏造しない) */
  ordersCagr: number | null;
  backlogCagr: number | null;
  /** 直近前年比 (小数)。前年<=0/欠損は null */
  ordersYoy: number | null;
  backlogYoy: number | null;
}

function cagr(first: number | null, last: number | null, yearsSpan: number): number | null {
  if (first === null || last === null) return null;
  if (first <= 0 || last <= 0 || yearsSpan < 1) return null;
  return Math.pow(last / first, 1 / yearsSpan) - 1;
}

function yoy(prev: number | null, last: number | null): number | null {
  if (prev === null || last === null || prev <= 0) return null;
  return last / prev - 1;
}

/**
 * 全社合計 (segment_kind='total') の受注高/受注残高の成長性で銘柄を
 * スクリーニングする。訂正等で同一会計期末が重複する場合は提出日時が
 * 新しい書類の値を採用 (getOrderTrend と同じ方針)。データが
 * minYears 未満の銘柄は「データ不足」として除外 (架空値を作らない)。
 */
export async function screenOrderGrowth(
  db: Database,
  opts: ScreenOpts
): Promise<ScreenRow[]> {
  const rows = await db
    .select({
      stockId: orderFacts.stockId,
      code: stocks.code,
      name: stocks.name,
      // JPX 由来は公開面へ出さない (src/shared/db/public-columns.ts)。
      sector: publicSectorColumn,
      fy: orderFacts.fiscalYearEnd,
      ordersYen: orderFacts.ordersReceivedYen,
      backlogYen: orderFacts.orderBacklogYen,
      submittedAt: yuhoDocuments.submittedAt,
      // 共有 core.stock_financials (絞り込み専用。結果表には出さない)
      finOpMargin: stockFinancials.operatingMargin,
      finMarketCap: stockFinancials.marketCap,
      finPer: stockFinancials.per,
      finRoe: stockFinancials.roe,
      finDivYield: stockFinancials.dividendYield,
    })
    .from(orderFacts)
    .innerJoin(yuhoDocuments, eq(orderFacts.documentId, yuhoDocuments.id))
    .innerJoin(stocks, eq(orderFacts.stockId, stocks.id))
    .leftJoin(stockFinancials, eq(stockFinancials.stockId, orderFacts.stockId))
    .where(and(eq(orderFacts.segmentKind, "total"), eq(stocks.isActive, true)));

  // (stockId, fy) ごとに提出日時が最新の書類の値を採用
  type Pt = { ordersYen: number | null; backlogYen: number | null };
  type Fin = {
    opMargin: number | null;
    marketCap: number | null;
    per: number | null;
    roe: number | null;
    divYield: number | null;
  };
  const byStock = new Map<
    number,
    {
      code: string;
      name: string;
      sector: string | null;
      fin: Fin;
      best: Map<string, { sub: Date; pt: Pt }>;
    }
  >();
  for (const r of rows) {
    let s = byStock.get(r.stockId);
    if (!s) {
      s = {
        code: r.code,
        name: r.name,
        sector: r.sector,
        fin: {
          opMargin: r.finOpMargin,
          marketCap: r.finMarketCap,
          per: r.finPer,
          roe: r.finRoe,
          divYield: r.finDivYield,
        },
        best: new Map(),
      };
      byStock.set(r.stockId, s);
    }
    const cur = s.best.get(r.fy);
    if (!cur || r.submittedAt > cur.sub) {
      s.best.set(r.fy, {
        sub: r.submittedAt,
        pt: { ordersYen: r.ordersYen, backlogYen: r.backlogYen },
      });
    }
  }

  const out: ScreenRow[] = [];
  for (const s of byStock.values()) {
    if (opts.sector && s.sector !== opts.sector) continue;

    // ファンダ絞り込み (結果表には出さない)。条件が指定され、かつ当該
    // 銘柄の財務値が NULL なら「条件を満たせない」ので除外する
    // (ルール2: 欠損を黙って通さない / 架空値で埋めない)。
    const f = s.fin;
    if (
      opts.minOpMarginPct !== undefined &&
      (f.opMargin === null || f.opMargin * 100 < opts.minOpMarginPct)
    ) {
      continue;
    }
    if (
      opts.minMarketCapOku !== undefined &&
      (f.marketCap === null || f.marketCap / 1e8 < opts.minMarketCapOku)
    ) {
      continue;
    }
    if (
      opts.maxMarketCapOku !== undefined &&
      (f.marketCap === null || f.marketCap / 1e8 > opts.maxMarketCapOku)
    ) {
      continue;
    }
    if (
      opts.maxPer !== undefined &&
      (f.per === null || f.per <= 0 || f.per > opts.maxPer)
    ) {
      continue;
    }
    if (
      opts.minRoePct !== undefined &&
      (f.roe === null || f.roe * 100 < opts.minRoePct)
    ) {
      continue;
    }
    if (
      opts.minDivYieldPct !== undefined &&
      (f.divYield === null || f.divYield < opts.minDivYieldPct)
    ) {
      continue;
    }

    // 古い→新しい順、直近 MAX_YEARS 年
    const fys = [...s.best.keys()].sort().slice(-MAX_YEARS);
    if (fys.length < opts.minYears) continue;
    const series = fys.map((fy) => ({ fy, ...s.best.get(fy)!.pt }));
    const first = series[0];
    const last = series[series.length - 1];
    const prev = series[series.length - 2] ?? null;
    const span =
      Number(last.fy.slice(0, 4)) - Number(first.fy.slice(0, 4));

    const row: ScreenRow = {
      code: s.code,
      name: s.name,
      sector: s.sector,
      years: fys.length,
      firstFiscalYearEnd: first.fy,
      lastFiscalYearEnd: last.fy,
      latestOrdersYen: last.ordersYen,
      latestBacklogYen: last.backlogYen,
      firstOrdersYen: first.ordersYen,
      firstBacklogYen: first.backlogYen,
      hasYearGap: fys.length < span + 1,
      ordersCagr: cagr(first.ordersYen, last.ordersYen, span),
      backlogCagr: cagr(first.backlogYen, last.backlogYen, span),
      ordersYoy: yoy(prev?.ordersYen ?? null, last.ordersYen),
      backlogYoy: yoy(prev?.backlogYen ?? null, last.backlogYen),
    };

    // 並び替え基準が算出不能な銘柄は順位付け不能 → 除外 (架空値を作らない)
    const sortKey =
      opts.metric === "orders" ? row.ordersCagr : row.backlogCagr;
    if (sortKey === null) continue;

    // 受注高 / 受注残高 を独立に絞り込み (ユーザ要件: 同時条件)。
    // 指定された軸の値が null なら条件未充足として除外 (ルール2)。
    if (
      opts.minOrdersCagrPct !== undefined &&
      (row.ordersCagr === null || row.ordersCagr * 100 < opts.minOrdersCagrPct)
    ) {
      continue;
    }
    if (
      opts.minBacklogCagrPct !== undefined &&
      (row.backlogCagr === null ||
        row.backlogCagr * 100 < opts.minBacklogCagrPct)
    ) {
      continue;
    }
    out.push(row);
  }

  out.sort((a, b) => {
    const ka = (opts.metric === "orders" ? a.ordersCagr : a.backlogCagr)!;
    const kb = (opts.metric === "orders" ? b.ordersCagr : b.backlogCagr)!;
    return kb - ka;
  });
  return out.slice(0, opts.limit);
}

/** スクリーニング対象になり得る業種一覧 (絞り込みプルダウン用) */
export async function listSectorsWithOrders(
  db: Database
): Promise<string[]> {
  const rows = await db
    // JPX 由来は公開面へ出さない (src/shared/db/public-columns.ts)。
    // プルダウンの候補も結果表と同じ列から作る (ズレると絞り込みが空振りする)。
    .selectDistinct({ sector: publicSectorColumn })
    .from(orderFacts)
    .innerJoin(stocks, eq(orderFacts.stockId, stocks.id))
    .where(and(eq(orderFacts.segmentKind, "total"), eq(stocks.isActive, true)));
  return rows
    .map((r) => r.sector)
    .filter((s): s is string => s !== null)
    .sort();
}
