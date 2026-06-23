/**
 * UI 向けクエリ層。海外売上高 / 海外売上高比率 の最大5年推移を地域別 +
 * 会社全体 (overseas_total / total) で返す。
 *
 * ルール2: データが無い銘柄に架空値を作らない。空配列・null をそのまま返し、
 * ビュー側で「海外売上の開示なし / 未対応」と正直に表示させる。訂正報告書
 * (docTypeCode 130) 等で同一会計期末が重複する場合は提出日時が新しい書類の
 * 値を採用する (黙って先頭を選ばない — 明示的に最新を選ぶ)。
 */
import { and, desc, eq, or } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { parseStockCode } from "../../../../src/shared/jpx/stock-code.js";
import { stocks, stockFinancials } from "../../../../src/shared/db/core-schema.js";
import { yuhoDocuments, overseasSalesFacts } from "../db/schema.js";
import type { StockHit } from "./order-query.js";

/** 海外売上の表示でも受注と同じ最大年数 (受注側 MAX_YEARS と一致) */
const MAX_YEARS = 5;

// 検索 (searchStocks) と StockHit は受注側 order-query と共通 (再定義しない)。

export interface OverseasYearPoint {
  fiscalYearEnd: string;
  isConsolidated: boolean | null;
  unitLabel: string;
  /** 海外売上高合計 (円)。無ければ null */
  overseasYen: number | null;
  /** 連結売上高 (円)。無ければ null */
  totalYen: number | null;
  /** 国内 (日本/本邦) 売上高 (円)。無ければ null */
  domesticYen: number | null;
  /** 海外売上高比率 (%)。overseas/total。算出不能は null (0 で埋めない) */
  ratioPct: number | null;
  /** 海外地域別内訳 (region_kind='overseas' のみ) */
  regions: Array<{ name: string; yen: number | null; ratioPct: number | null }>;
}

export interface OverseasTrend {
  stock: StockHit;
  documents: Array<{
    docId: string;
    periodEnd: string;
    submittedAt: Date;
    docTypeCode: string;
    /** 当該有報の海外売上 構造化結果。未取込(受注のみの旧レコード)は null */
    overseasParseStatus: string | null;
  }>;
  /** 古い→新しい順。最大 MAX_YEARS 年 */
  points: OverseasYearPoint[];
  hasStructuredData: boolean;
}

export async function getOverseasTrendByCode(
  db: Database,
  code: string
): Promise<OverseasTrend | null> {
  const c = parseStockCode(code);
  if (c === null) return null;
  const [hit] = await db
    .select({ id: stocks.id })
    .from(stocks)
    .where(eq(stocks.code, c))
    .limit(1);
  if (!hit) return null;
  return getOverseasTrend(db, hit.id);
}

export async function getOverseasTrend(
  db: Database,
  stockId: number
): Promise<OverseasTrend | null> {
  const [stock] = await db
    .select({
      id: stocks.id,
      code: stocks.code,
      name: stocks.name,
      market: stocks.market,
      sector: stocks.sector,
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
      overseasParseStatus: yuhoDocuments.overseasParseStatus,
    })
    .from(yuhoDocuments)
    .where(eq(yuhoDocuments.stockId, stockId))
    .orderBy(desc(yuhoDocuments.submittedAt));

  const rows = await db
    .select({
      fiscalYearEnd: overseasSalesFacts.fiscalYearEnd,
      regionName: overseasSalesFacts.regionName,
      regionKind: overseasSalesFacts.regionKind,
      isConsolidated: overseasSalesFacts.isConsolidated,
      unitLabel: overseasSalesFacts.unitLabel,
      salesYen: overseasSalesFacts.salesYen,
      ratioPct: overseasSalesFacts.ratioPct,
      submittedAt: yuhoDocuments.submittedAt,
    })
    .from(overseasSalesFacts)
    .innerJoin(
      yuhoDocuments,
      eq(overseasSalesFacts.documentId, yuhoDocuments.id)
    )
    .where(eq(overseasSalesFacts.stockId, stockId));

  // (会計期末, 地域) ごとに「提出日時が最新の書類」の値を採用
  const best = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const key = `${r.fiscalYearEnd}${r.regionName}`;
    const cur = best.get(key);
    if (!cur || r.submittedAt > cur.submittedAt) best.set(key, r);
  }

  const byYear = new Map<string, OverseasYearPoint>();
  for (const r of best.values()) {
    let p = byYear.get(r.fiscalYearEnd);
    if (!p) {
      p = {
        fiscalYearEnd: r.fiscalYearEnd,
        isConsolidated: r.isConsolidated,
        unitLabel: r.unitLabel,
        overseasYen: null,
        totalYen: null,
        domesticYen: null,
        ratioPct: null,
        regions: [],
      };
      byYear.set(r.fiscalYearEnd, p);
    }
    if (r.regionKind === "overseas_total") {
      p.overseasYen = r.salesYen;
    } else if (r.regionKind === "total") {
      p.totalYen = r.salesYen;
    } else if (r.regionKind === "domestic") {
      // 欠損 (NULL) を 0 で埋めない (ルール2)。実値のある domestic 行のみ加算し、
      // 1 件も実値が無ければ domesticYen は null のまま (国内未開示を保持)。
      if (r.salesYen !== null) p.domesticYen = (p.domesticYen ?? 0) + r.salesYen;
    } else if (r.regionKind === "overseas") {
      p.regions.push({ name: r.regionName, yen: r.salesYen, ratioPct: r.ratioPct });
    }
  }

  // 比率 = 海外売上高 / 連結売上高 (どちらか欠損なら null = 作らない)
  for (const p of byYear.values()) {
    if (p.overseasYen !== null && p.totalYen !== null && p.totalYen > 0) {
      p.ratioPct = +((p.overseasYen / p.totalYen) * 100).toFixed(1);
    }
    p.regions.sort((a, b) => (b.yen ?? 0) - (a.yen ?? 0));
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
      overseasParseStatus: d.overseasParseStatus,
    })),
    points,
    hasStructuredData: points.some((p) => p.overseasYen !== null),
  };
}

// ===========================================================================
// 海外売上高比率 / 成長性 スクリーニング (会社全体 = overseas_total / total)
// ===========================================================================

/**
 * 地域別スクリーニング用の「正規化バケット」。会社ごとに地域語の粒度・表記が
 * バラバラ (中国/中華圏/香港、米国/北米/南北アメリカ 等) なので、同義の地域語を
 * 1 バケットに束ねて比率を出す。**そのバケットを明示開示している会社だけ**が対象で、
 * アジア等へ丸めている会社は比率を捏造せず除外する (ルール1/2)。
 * key は URL/フォーム値、label は表示、rx は overseas 行の region_name 突合用。
 */
export const REGION_BUCKETS: Record<string, { label: string; rx: RegExp }> = {
  china: { label: "中国・中華圏", rx: /中国|中華|香港/ },
  americas: {
    label: "米国・米州",
    rx: /米国|アメリカ|北米|米州|南北アメリカ|中南米|南米|北中米|米大陸|カナダ|メキシコ/,
  },
  europe: {
    label: "欧州",
    rx: /欧州|ヨーロッパ|EMEA|ドイツ|英国|フランス|イタリア|スペイン|オランダ/,
  },
  asia: {
    label: "アジア・オセアニア",
    rx: /アジア|オセアニア|大洋州|韓国|台湾|タイ|ベトナム|インド|シンガポール|インドネシア|フィリピン|マレーシア/,
  },
};

export interface ScreenOpts {
  /** 必要な年数 (これ未満はデータ不足として除外, 既定 3) */
  minYears: number;
  /** 地域バケット key (REGION_BUCKETS)。指定時のみ地域別比率を算出・絞り込む */
  region?: string;
  /** 選択地域の対連結売上比率(%) 下限。地域を明示開示しない銘柄は除外 (架空値禁止) */
  minRegionRatioPct?: number;
  /** 選択地域の対連結売上比率(%) 上限。地域を明示開示しない銘柄は除外 */
  maxRegionRatioPct?: number;
  /** 直近 海外売上高比率(%) 下限 (未指定なら絞らない) */
  minOverseasRatioPct?: number;
  /** 直近 海外売上高比率(%) 上限 (内需株抽出用) */
  maxOverseasRatioPct?: number;
  /** 海外売上高 年率(%) 下限 (未指定なら絞らない) */
  minOverseasCagrPct?: number;
  /** 業種 (core.stocks.sector) 完全一致で絞る */
  sector?: string;
  // --- ファンダ絞り込み (共有 core.stock_financials。結果表には出さない) ---
  /** 営業利益率 (%) 下限。core.operating_margin は小数 (0.1234=12.34%) */
  minOpMarginPct?: number;
  /** 時価総額 (億円) 下限 */
  minMarketCapOku?: number;
  /** 時価総額 (億円) 上限 */
  maxMarketCapOku?: number;
  /** PER (倍) 上限 (正値のみ) */
  maxPer?: number;
  /** ROE (%) 下限。core.roe は小数 */
  minRoePct?: number;
  /** 配当利回り (%) 下限。core.dividend_yield は既に % 値 */
  minDivYieldPct?: number;
  /** 返却上限 (既定 100) */
  limit: number;
}

export interface ScreenRow {
  code: string;
  name: string;
  sector: string | null;
  years: number;
  firstFiscalYearEnd: string;
  lastFiscalYearEnd: string;
  /** 直近 海外売上高比率 (%)。算出不能は null */
  latestRatioPct: number | null;
  /** 起点 海外売上高比率 (%) */
  firstRatioPct: number | null;
  /** 比率の変化 (pp = 直近 − 起点)。どちらか欠損は null */
  ratioChangePp: number | null;
  /** 直近 海外売上高 (円) */
  latestOverseasYen: number | null;
  /** 直近 連結売上高 (円) */
  latestTotalYen: number | null;
  /** 起点 海外売上高 (円) */
  firstOverseasYen: number | null;
  /** データ点数 < 暦年差+1 (=途中年が欠落) なら true */
  hasYearGap: boolean;
  /** 海外売上高 年平均成長率 (小数)。基準<=0 や 1 年は null */
  overseasCagr: number | null;
  /** 直近 海外売上高 前年比 (小数) */
  overseasYoy: number | null;
  /** 選択地域バケットの表示名 (region 指定時のみ)。未指定は null */
  regionLabel: string | null;
  /** 選択地域の直近売上高 (円)。地域を開示していなければ null */
  latestRegionYen: number | null;
  /** 選択地域の対連結売上比率 (%)。算出不能/未開示は null (0 で埋めない) */
  regionRatioPct: number | null;
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

/** 地域名が合致するバケット key 一覧。複数該当 = 複合地域("アジア・中国"等)。 */
function bucketKeysFor(name: string): string[] {
  return Object.entries(REGION_BUCKETS)
    .filter(([, b]) => b.rx.test(name))
    .map(([k]) => k);
}

/**
 * 会社全体 (overseas_total / total) の海外売上高比率・成長性で銘柄を
 * スクリーニングする。データが minYears 未満の銘柄は「データ不足」として除外
 * (架空値を作らない)。並び替えは直近海外売上高比率の高い順 (固定)。
 */
export async function screenOverseasGrowth(
  db: Database,
  opts: ScreenOpts
): Promise<ScreenRow[]> {
  const bucket = opts.region ? REGION_BUCKETS[opts.region] : undefined;
  // 地域絞り込み時のみ overseas 行も読む (普段は overseas_total/total だけで軽量)。
  const kindCond = bucket
    ? or(
        eq(overseasSalesFacts.regionKind, "overseas_total"),
        eq(overseasSalesFacts.regionKind, "total"),
        eq(overseasSalesFacts.regionKind, "overseas")
      )
    : or(
        eq(overseasSalesFacts.regionKind, "overseas_total"),
        eq(overseasSalesFacts.regionKind, "total")
      );
  const rows = await db
    .select({
      stockId: overseasSalesFacts.stockId,
      code: stocks.code,
      name: stocks.name,
      sector: stocks.sector,
      fy: overseasSalesFacts.fiscalYearEnd,
      regionKind: overseasSalesFacts.regionKind,
      regionName: overseasSalesFacts.regionName,
      salesYen: overseasSalesFacts.salesYen,
      submittedAt: yuhoDocuments.submittedAt,
      finOpMargin: stockFinancials.operatingMargin,
      finMarketCap: stockFinancials.marketCap,
      finPer: stockFinancials.per,
      finRoe: stockFinancials.roe,
      finDivYield: stockFinancials.dividendYield,
    })
    .from(overseasSalesFacts)
    .innerJoin(
      yuhoDocuments,
      eq(overseasSalesFacts.documentId, yuhoDocuments.id)
    )
    .innerJoin(stocks, eq(overseasSalesFacts.stockId, stocks.id))
    .leftJoin(stockFinancials, eq(stockFinancials.stockId, overseasSalesFacts.stockId))
    .where(and(kindCond, eq(stocks.isActive, true)));

  type Fin = {
    opMargin: number | null;
    marketCap: number | null;
    per: number | null;
    roe: number | null;
    divYield: number | null;
  };
  type YearVals = {
    sub: Date;
    overseas: number | null;
    total: number | null;
    /** 選択地域バケットに合致した overseas 行の合計 (region 指定時のみ)。未開示=null */
    region: number | null;
  };
  const byStock = new Map<
    number,
    {
      code: string;
      name: string;
      sector: string | null;
      fin: Fin;
      best: Map<string, YearVals>; // fy → 提出日時最新の {overseas, total}
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
    // overseas_total と total は同一書類 (同一 submittedAt) に同居する。
    // (stockId, fy) で最新提出の書類の行だけを採る: 新しい提出が来たら作り直し、
    // 同じ提出なら overseas/total を同じレコードに集約する (訂正報告で最新優先)。
    // 選択バケットに合致し、かつ **そのバケットだけ** に合致する行のみ算入する。
    // "アジア・中国" のような複合地域行は 2 バケットに該当 → どちらにも入れない
    // (china に丸ごと足して過大評価しない・asia に丸めて見落とさない = 中立で除外)。
    const matchesBucket =
      bucket !== undefined &&
      r.regionKind === "overseas" &&
      r.salesYen !== null &&
      (() => {
        const keys = bucketKeysFor(r.regionName);
        return keys.length === 1 && keys[0] === opts.region;
      })();
    const cur = s.best.get(r.fy);
    if (!cur || r.submittedAt > cur.sub) {
      const v: YearVals = {
        sub: r.submittedAt,
        overseas: null,
        total: null,
        region: null,
      };
      if (r.regionKind === "overseas_total") v.overseas = r.salesYen;
      else if (r.regionKind === "total") v.total = r.salesYen;
      else if (matchesBucket) v.region = r.salesYen;
      s.best.set(r.fy, v);
    } else if (r.submittedAt.getTime() === cur.sub.getTime()) {
      if (r.regionKind === "overseas_total") cur.overseas = r.salesYen;
      else if (r.regionKind === "total") cur.total = r.salesYen;
      else if (matchesBucket) cur.region = (cur.region ?? 0) + r.salesYen!;
    }
  }

  const ratioOf = (v: YearVals): number | null =>
    v.overseas !== null && v.total !== null && v.total > 0
      ? (v.overseas / v.total) * 100
      : null;
  const regionRatioOf = (v: YearVals): number | null =>
    v.region !== null && v.total !== null && v.total > 0
      ? (v.region / v.total) * 100
      : null;

  const out: ScreenRow[] = [];
  for (const s of byStock.values()) {
    if (opts.sector && s.sector !== opts.sector) continue;

    // ファンダ絞り込み (結果表には出さない)。条件指定かつ財務値 NULL は除外
    // (ルール2: 欠損を黙って通さない / 架空値で埋めない)。
    const f = s.fin;
    if (opts.minOpMarginPct !== undefined && (f.opMargin === null || f.opMargin * 100 < opts.minOpMarginPct)) continue;
    if (opts.minMarketCapOku !== undefined && (f.marketCap === null || f.marketCap / 1e8 < opts.minMarketCapOku)) continue;
    if (opts.maxMarketCapOku !== undefined && (f.marketCap === null || f.marketCap / 1e8 > opts.maxMarketCapOku)) continue;
    if (opts.maxPer !== undefined && (f.per === null || f.per <= 0 || f.per > opts.maxPer)) continue;
    if (opts.minRoePct !== undefined && (f.roe === null || f.roe * 100 < opts.minRoePct)) continue;
    if (opts.minDivYieldPct !== undefined && (f.divYield === null || f.divYield < opts.minDivYieldPct)) continue;

    const fys = [...s.best.keys()].sort().slice(-MAX_YEARS);
    if (fys.length < opts.minYears) continue;
    const series = fys.map((fy) => ({ fy, ...s.best.get(fy)! }));
    const first = series[0];
    const last = series[series.length - 1];
    const prev = series[series.length - 2] ?? null;
    const span = Number(last.fy.slice(0, 4)) - Number(first.fy.slice(0, 4));

    const latestRatio = ratioOf(last);
    // 直近比率が算出不能な銘柄は順位付け不能 → 除外 (架空値を作らない)
    if (latestRatio === null) continue;
    const firstRatio = ratioOf(first);
    const regionRatio = bucket ? regionRatioOf(last) : null;

    const row: ScreenRow = {
      code: s.code,
      name: s.name,
      sector: s.sector,
      years: fys.length,
      firstFiscalYearEnd: first.fy,
      lastFiscalYearEnd: last.fy,
      latestRatioPct: +latestRatio.toFixed(1),
      firstRatioPct: firstRatio === null ? null : +firstRatio.toFixed(1),
      ratioChangePp: firstRatio === null ? null : +(latestRatio - firstRatio).toFixed(1),
      latestOverseasYen: last.overseas,
      latestTotalYen: last.total,
      firstOverseasYen: first.overseas,
      hasYearGap: fys.length < span + 1,
      overseasCagr: cagr(first.overseas, last.overseas, span),
      overseasYoy: yoy(prev?.overseas ?? null, last.overseas),
      regionLabel: bucket ? bucket.label : null,
      latestRegionYen: bucket ? last.region : null,
      regionRatioPct: regionRatio === null ? null : +regionRatio.toFixed(1),
    };

    if (opts.minOverseasRatioPct !== undefined && row.latestRatioPct! < opts.minOverseasRatioPct) continue;
    if (opts.maxOverseasRatioPct !== undefined && row.latestRatioPct! > opts.maxOverseasRatioPct) continue;
    if (opts.minOverseasCagrPct !== undefined && (row.overseasCagr === null || row.overseasCagr * 100 < opts.minOverseasCagrPct)) continue;
    // 地域別絞り込みは「地域を選択したとき」だけ適用する。地域未選択で比率レンジ
    // だけ入力されても全件除外せず無視する (入力に意味が無いため)。地域選択時は、
    // 当該地域を明示開示せず比率が算出できない銘柄を min/max いずれの条件も満たせ
    // ないものとして除外する (欠損を 0 扱いで通さない・ルール2)。
    if (bucket) {
      if (
        opts.minRegionRatioPct !== undefined &&
        (row.regionRatioPct === null || row.regionRatioPct < opts.minRegionRatioPct)
      ) {
        continue;
      }
      if (
        opts.maxRegionRatioPct !== undefined &&
        (row.regionRatioPct === null || row.regionRatioPct > opts.maxRegionRatioPct)
      ) {
        continue;
      }
    }

    out.push(row);
  }

  out.sort((a, b) => (b.latestRatioPct ?? -1) - (a.latestRatioPct ?? -1));
  return out.slice(0, opts.limit);
}

/** スクリーニング対象になり得る業種一覧 (絞り込みプルダウン用) */
export async function listSectorsWithOverseas(db: Database): Promise<string[]> {
  const rows = await db
    .selectDistinct({ sector: stocks.sector })
    .from(overseasSalesFacts)
    .innerJoin(stocks, eq(overseasSalesFacts.stockId, stocks.id))
    .where(
      and(
        eq(overseasSalesFacts.regionKind, "overseas_total"),
        eq(stocks.isActive, true)
      )
    );
  return rows
    .map((r) => r.sector)
    .filter((s): s is string => s !== null)
    .sort();
}
