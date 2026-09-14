/**
 * UI 向けクエリ層。受注高/受注残高 の 5 年推移をセグメント別 + 全社合計で返す。
 *
 * ルール2: データが無い銘柄に架空値を作らない。空配列・null をそのまま返し、
 * ビュー側で「受注データなし / 未対応」と正直に表示させる。訂正報告書
 * (docTypeCode 130) 等で同一会計期末が重複する場合は提出日時が新しい
 * 書類の値を採用する (黙って先頭を選ばない — 明示的に最新を選ぶ)。
 */
import { and, desc, eq, gt, gte, isNotNull, like, lte, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { parseStockCode } from "../../../../src/shared/jpx/stock-code.js";
import { stocks, stockFinancials } from "../../../../src/shared/db/core-schema.js";
import {
  publicMarketColumn,
  publicSectorColumn,
} from "../../../../src/shared/db/public-columns.js";
import { activeEquityCondition } from "../../../../src/shared/db/active-equity.js";
import { yuhoGrowthProjection } from "../../../../src/shared/db/projection-schema.js";
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
        // 母集団 = active かつ equity (src/shared/db/active-equity.ts)。
        // 検索・スクリーニング・業種プルダウンで同じ集合を見る。
        activeEquityCondition(),
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

/**
 * 全社合計 (segment_kind='total') の受注高/受注残高の成長性で銘柄を
 * スクリーニングする。L2 投影 `p_yuho_growth` (EDINET catchup の末尾で再生成)
 * を WHERE/ORDER BY で引く。全ファクト走査 (6 万超 rows_read) はしない。
 *
 * 旧実装 (JS で全行畳み込み) との一致:
 * - 年窓・CAGR/YoY・欠落判定は再生成の純関数 (projection.ts) が旧式と同じ式で
 *   格納する。ここでは再計算せず格納値をそのまま ScreenRow へ写す。
 * - 「条件指定かつ値 null → 除外」(ルール2) は SQL の 3 値論理で再現する
 *   (`col * 100 >= ?` は null 行を落とす)。並び替え不能 (metric null) の除外
 *   だけは ORDER BY が null を先頭に持ってくるため明示の IS NOT NULL が要る。
 * - 同率は code 昇順で確定させる。旧実装は DB 返却順の安定ソートで、順序は
 *   未定義だった (クエリに ORDER BY が無い)。
 */
export async function screenOrderGrowth(
  db: Database,
  opts: ScreenOpts
): Promise<ScreenRow[]> {
  const p = yuhoGrowthProjection;
  const metricCol =
    opts.metric === "orders" ? p.ordOrdersCagr : p.ordBacklogCagr;
  const conds = [
    gte(p.ordYears, opts.minYears),
    isNotNull(metricCol),
    activeEquityCondition(),
  ];
  if (opts.sector !== undefined) {
    conds.push(eq(publicSectorColumn, opts.sector));
  }
  if (opts.minOrdersCagrPct !== undefined) {
    conds.push(sql`${p.ordOrdersCagr} * 100 >= ${opts.minOrdersCagrPct}`);
  }
  if (opts.minBacklogCagrPct !== undefined) {
    conds.push(sql`${p.ordBacklogCagr} * 100 >= ${opts.minBacklogCagrPct}`);
  }
  const fin = stockFinancials;
  if (opts.minOpMarginPct !== undefined) {
    conds.push(sql`${fin.operatingMargin} * 100 >= ${opts.minOpMarginPct}`);
  }
  if (opts.minMarketCapOku !== undefined) {
    conds.push(sql`${fin.marketCap} / 100000000 >= ${opts.minMarketCapOku}`);
  }
  if (opts.maxMarketCapOku !== undefined) {
    conds.push(sql`${fin.marketCap} / 100000000 <= ${opts.maxMarketCapOku}`);
  }
  if (opts.maxPer !== undefined) {
    conds.push(gt(fin.per, 0), lte(fin.per, opts.maxPer));
  }
  if (opts.minRoePct !== undefined) {
    conds.push(sql`${fin.roe} * 100 >= ${opts.minRoePct}`);
  }
  if (opts.minDivYieldPct !== undefined) {
    // dividend_yield は既に % 値なので 100 倍しない (旧実装と同じ)
    conds.push(gte(fin.dividendYield, opts.minDivYieldPct));
  }

  return db
    .select({
      code: stocks.code,
      name: stocks.name,
      sector: publicSectorColumn,
      years: p.ordYears,
      firstFiscalYearEnd: p.ordFirstFy,
      lastFiscalYearEnd: p.ordLastFy,
      latestOrdersYen: p.ordLastOrdersYen,
      latestBacklogYen: p.ordLastBacklogYen,
      firstOrdersYen: p.ordFirstOrdersYen,
      firstBacklogYen: p.ordFirstBacklogYen,
      hasYearGap: p.ordHasYearGap,
      ordersCagr: p.ordOrdersCagr,
      backlogCagr: p.ordBacklogCagr,
      ordersYoy: p.ordOrdersYoy,
      backlogYoy: p.ordBacklogYoy,
    })
    .from(p)
    .innerJoin(stocks, eq(p.stockId, stocks.id))
    .leftJoin(fin, eq(fin.stockId, p.stockId))
    .where(and(...conds))
    .orderBy(desc(metricCol), stocks.code)
    .limit(opts.limit);
}

/**
 * スクリーニング対象になり得る業種一覧 (絞り込みプルダウン用)。
 * 「全社合計行を 1 行でも持つ銘柄の業種」= 投影の `ord_years >= 1` と一致する。
 */
export async function listSectorsWithOrders(
  db: Database
): Promise<string[]> {
  const rows = await db
    // JPX 由来は公開面へ出さない (src/shared/db/public-columns.ts)。
    // プルダウンの候補も結果表と同じ列・同じ母集団 (active かつ equity) から作る
    // (ズレると絞り込みが空振りする)。
    .selectDistinct({ sector: publicSectorColumn })
    .from(yuhoGrowthProjection)
    .innerJoin(stocks, eq(yuhoGrowthProjection.stockId, stocks.id))
    .where(
      and(gte(yuhoGrowthProjection.ordYears, 1), activeEquityCondition())
    );
  return rows
    .map((r) => r.sector)
    .filter((s): s is string => s !== null)
    .sort();
}
