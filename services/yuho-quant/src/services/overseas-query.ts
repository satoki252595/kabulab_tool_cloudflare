/**
 * UI 向けクエリ層。海外売上高 / 海外売上高比率 の最大5年推移を地域別 +
 * 会社全体 (overseas_total / total) で返す。
 *
 * ルール2: データが無い銘柄に架空値を作らない。空配列・null をそのまま返し、
 * ビュー側で「海外売上の開示なし / 未対応」と正直に表示させる。訂正報告書
 * (docTypeCode 130) 等で同一会計期末が重複する場合は提出日時が新しい書類の
 * 値を採用する (黙って先頭を選ばない — 明示的に最新を選ぶ)。
 */
import { and, desc, eq, gt, gte, isNotNull, lte, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { parseStockCode } from "../../../../src/shared/jpx/stock-code.js";
import { stocks, stockFinancials } from "../../../../src/shared/db/core-schema.js";
import {
  publicMarketColumn,
  publicSectorColumn,
} from "../../../../src/shared/db/public-columns.js";
import { activeEquityCondition } from "../../../../src/shared/db/active-equity.js";
import { yuhoGrowthProjection } from "../../../../src/shared/db/projection-schema.js";
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

/**
 * 地域名が合致するバケット key 一覧。複数該当 = 複合地域("アジア・中国"等)。
 * 投影の再生成 (projection.ts) も同じ突合を使うため export する。
 */
export function bucketKeysFor(name: string): string[] {
  return Object.entries(REGION_BUCKETS)
    .filter(([, b]) => b.rx.test(name))
    .map(([k]) => k);
}

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
  /** 業種 (公開面が出している業種列。src/shared/db/public-columns.ts) 完全一致で絞る */
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

/**
 * 会社全体 (overseas_total / total) の海外売上高比率・成長性で銘柄を
 * スクリーニングする。L2 投影 `p_yuho_growth` (EDINET catchup の末尾で再生成)
 * を WHERE/ORDER BY で引く。全ファクト走査 (2.5 万 rows_read) はしない。
 *
 * 旧実装 (JS で全行畳み込み) との一致:
 * - 年窓・CAGR/YoY/比率・地域円貨は再生成の純関数 (projection.ts) が旧式と
 *   同じ式で格納する。地域比率だけ `+(yen/total*100).toFixed(1)` で復元し、
 *   旧 regionRatioOf と一致する (SQL の ROUND には寄せない)。
 * - 地域レンジ指定時は SQL で候補を絞った上で JS で地域比率を確定・絞り込む
 *   (丸めの一致を構造で保証するため)。候補は投影の全行 (~1.2k) が上限。
 * - 同率は code 昇順で確定させる (旧実装の順序は未定義だった)。
 * - データが minYears 未満の銘柄は「データ不足」として除外 (架空値を作らない)。
 *   並び替えは直近海外売上高比率の高い順 (固定)。
 */
export async function screenOverseasGrowth(
  db: Database,
  opts: ScreenOpts
): Promise<ScreenRow[]> {
  const p = yuhoGrowthProjection;
  const bucket = opts.region ? REGION_BUCKETS[opts.region] : undefined;

  const conds = [
    gte(p.ovsYears, opts.minYears),
    // 直近比率が算出不能な銘柄は順位付け不能 → 除外 (架空値を作らない)
    isNotNull(p.ovsLatestRatioPct),
    activeEquityCondition(),
  ];
  if (opts.sector !== undefined) {
    conds.push(eq(publicSectorColumn, opts.sector));
  }
  if (opts.minOverseasRatioPct !== undefined) {
    conds.push(gte(p.ovsLatestRatioPct, opts.minOverseasRatioPct));
  }
  if (opts.maxOverseasRatioPct !== undefined) {
    conds.push(lte(p.ovsLatestRatioPct, opts.maxOverseasRatioPct));
  }
  if (opts.minOverseasCagrPct !== undefined) {
    conds.push(sql`${p.ovsOverseasCagr} * 100 >= ${opts.minOverseasCagrPct}`);
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

  const base = db
    .select({
      code: stocks.code,
      name: stocks.name,
      sector: publicSectorColumn,
      years: p.ovsYears,
      firstFiscalYearEnd: p.ovsFirstFy,
      lastFiscalYearEnd: p.ovsLastFy,
      latestRatioPct: p.ovsLatestRatioPct,
      firstRatioPct: p.ovsFirstRatioPct,
      latestOverseasYen: p.ovsLastOverseasYen,
      latestTotalYen: p.ovsLastTotalYen,
      firstOverseasYen: p.ovsFirstOverseasYen,
      hasYearGap: p.ovsHasYearGap,
      overseasCagr: p.ovsOverseasCagr,
      overseasYoy: p.ovsOverseasYoy,
      regionChinaYen: p.ovsRegionChinaYen,
      regionAmericasYen: p.ovsRegionAmericasYen,
      regionEuropeYen: p.ovsRegionEuropeYen,
      regionAsiaYen: p.ovsRegionAsiaYen,
    })
    .from(p)
    .innerJoin(stocks, eq(p.stockId, stocks.id))
    .leftJoin(fin, eq(fin.stockId, p.stockId))
    .where(and(...conds))
    .orderBy(desc(p.ovsLatestRatioPct), stocks.code);

  // 地域別絞り込みは「地域を選択したとき」だけ適用する。地域未選択で比率レンジ
  // だけ入力されても全件除外せず無視する (入力に意味が無いため)。地域選択時は、
  // 当該地域を明示開示せず比率が算出できない銘柄を min/max いずれの条件も満たせ
  // ないものとして除外する (欠損を 0 扱いで通さない・ルール2)。
  const needsRegionFilter =
    bucket !== undefined &&
    (opts.minRegionRatioPct !== undefined ||
      opts.maxRegionRatioPct !== undefined);
  const candidates = needsRegionFilter ? await base : await base.limit(opts.limit);

  const regionYenOf = (r: (typeof candidates)[number]): number | null => {
    if (opts.region === "china") return r.regionChinaYen;
    if (opts.region === "americas") return r.regionAmericasYen;
    if (opts.region === "europe") return r.regionEuropeYen;
    if (opts.region === "asia") return r.regionAsiaYen;
    return null;
  };
  // 旧 regionRatioOf と同一式。SQL の ROUND には寄せない (丸めの一致のため)。
  const regionRatioOf = (yen: number | null, total: number | null) =>
    yen !== null && total !== null && total > 0
      ? +((yen / total) * 100).toFixed(1)
      : null;

  const out: ScreenRow[] = [];
  for (const r of candidates) {
    const regionYen = bucket ? regionYenOf(r) : null;
    const regionRatio = bucket ? regionRatioOf(regionYen, r.latestTotalYen) : null;
    if (needsRegionFilter) {
      if (
        opts.minRegionRatioPct !== undefined &&
        (regionRatio === null || regionRatio < opts.minRegionRatioPct)
      ) {
        continue;
      }
      if (
        opts.maxRegionRatioPct !== undefined &&
        (regionRatio === null || regionRatio > opts.maxRegionRatioPct)
      ) {
        continue;
      }
    }
    out.push({
      code: r.code,
      name: r.name,
      sector: r.sector,
      years: r.years,
      firstFiscalYearEnd: r.firstFiscalYearEnd,
      lastFiscalYearEnd: r.lastFiscalYearEnd,
      latestRatioPct: r.latestRatioPct,
      firstRatioPct: r.firstRatioPct,
      ratioChangePp:
        r.firstRatioPct === null || r.latestRatioPct === null
          ? null
          : +(r.latestRatioPct - r.firstRatioPct).toFixed(1),
      latestOverseasYen: r.latestOverseasYen,
      latestTotalYen: r.latestTotalYen,
      firstOverseasYen: r.firstOverseasYen,
      hasYearGap: r.hasYearGap,
      overseasCagr: r.overseasCagr,
      overseasYoy: r.overseasYoy,
      regionLabel: bucket ? bucket.label : null,
      latestRegionYen: regionYen,
      regionRatioPct: regionRatio,
    });
  }
  return needsRegionFilter ? out.slice(0, opts.limit) : out;
}

/**
 * スクリーニング対象になり得る業種一覧 (絞り込みプルダウン用)。
 * 「overseas_total 行を 1 行でも持つ銘柄の業種」= 投影の
 * `ovs_has_overseas_total` と一致する (total 行だけの銘柄は含めない)。
 */
export async function listSectorsWithOverseas(db: Database): Promise<string[]> {
  const rows = await db
    // JPX 由来は公開面へ出さない (src/shared/db/public-columns.ts)。
    // プルダウンの候補も結果表と同じ列・同じ母集団 (active かつ equity) から作る
    // (ズレると絞り込みが空振りする)。
    .selectDistinct({ sector: publicSectorColumn })
    .from(yuhoGrowthProjection)
    .innerJoin(stocks, eq(yuhoGrowthProjection.stockId, stocks.id))
    .where(
      and(
        eq(yuhoGrowthProjection.ovsHasOverseasTotal, true),
        activeEquityCondition()
      )
    );
  return rows
    .map((r) => r.sector)
    .filter((s): s is string => s !== null)
    .sort();
}
