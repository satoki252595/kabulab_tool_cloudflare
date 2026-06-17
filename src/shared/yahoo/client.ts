/**
 * 統一 Yahoo Finance クライアント
 *
 * 以前は rsi-screening / swing-trading / otakara-yutai の 3 サービスが
 * それぞれ独自の yahoo-finance.ts を持ち、crumb/cookie キャッシュも別々だった。
 * このモジュールはそれらを 1 つにまとめ、全サービス共通で使う。
 *
 * 提供する API:
 *   - fetchChart(symbol, range)      : Chart API (日足 OHLCV)
 *   - fetchQuoteSummary(code)        : QuoteSummary API (PER/PBR/配当/営業利益率 等)
 *   - fetchStockRawData(code, range) : 上記 2 つを並列実行して統合した生データ
 *
 * CLAUDE.md のフォールバック禁止ルールに従い、HTTP エラー / パース失敗 /
 * crumb 取得失敗はすべて throw する。無認証 fetch への silent fallback は行わない。
 */

import {
  yahooChartResponseSchema,
  yahooQuoteSummaryResponseSchema,
} from "./validators.js";
import type {
  AnnualFinancial,
  DailyOhlcv,
  StockRawData,
} from "../types.js";

/**
 * 日本株銘柄コード。
 * 従来 4 桁数字のみだったが、2024 年から JPX が新規上場銘柄に
 * 「4 桁数字 + 末尾英字 1 文字」(例: 130A ソラコム、141A トライアル) を採用。
 * 末尾英字も Yahoo の `<code>.T` 形式で取得可能。
 */
const JP_STOCK_PATTERN = /^\d{3}[\dA-Z]$/;
/** 指数シンボル (例: ^N225, ^VIX) */
const INDEX_PATTERN = /^\^[A-Z0-9]+$/;
/** 先物シンボル (例: NIY=F) */
const FUTURES_PATTERN = /^[A-Z0-9]{1,6}=F$/;

const CHART_API_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const QUOTE_SUMMARY_API_BASE = "https://query1.finance.yahoo.com/v10/finance/quoteSummary";
const QUOTE_SUMMARY_MODULES =
  "financialData,defaultKeyStatistics,summaryDetail,incomeStatementHistory";

/** プロセス 1 回ぶんで共有する crumb/cookie キャッシュ (module-level singleton) */
let cachedCrumb: string | null = null;
let cachedCookie: string | null = null;
let crumbExpiry = 0;

/**
 * 日本株コードは ".T" を付けて Yahoo シンボルに正規化する。
 * 指数 / 先物はそのまま使える。
 */
function normalizeSymbol(raw: string): string {
  if (JP_STOCK_PATTERN.test(raw)) return `${raw}.T`;
  if (INDEX_PATTERN.test(raw) || FUTURES_PATTERN.test(raw)) return raw;
  throw new Error(
    `不正なシンボル: ${raw} (4桁日本株コード / ^INDEX / SYMBOL=F のいずれかである必要があります)`
  );
}

/** Yahoo Finance の crumb 認証トークンを取得する (30 分キャッシュ) */
async function getYahooCrumb(): Promise<{ crumb: string; cookie: string }> {
  if (cachedCrumb && cachedCookie && Date.now() < crumbExpiry) {
    return { crumb: cachedCrumb, cookie: cachedCookie };
  }

  const pageRes = await fetch("https://finance.yahoo.com/quote/AAPL", {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Accept: "text/html",
    },
    redirect: "manual",
  });

  const cookies = pageRes.headers.getSetCookie?.() ?? [];
  const cookieStr = cookies.map((c) => c.split(";")[0]).join("; ");

  const crumbRes = await fetch(
    "https://query2.finance.yahoo.com/v1/test/getcrumb",
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Cookie: cookieStr,
      },
    }
  );

  if (!crumbRes.ok) {
    throw new Error(`Yahoo crumb 取得失敗: ${crumbRes.status}`);
  }

  const crumb = (await crumbRes.text()).trim();
  cachedCrumb = crumb;
  cachedCookie = cookieStr;
  crumbExpiry = Date.now() + 30 * 60 * 1000;
  return { crumb, cookie: cookieStr };
}

/** 認証付き fetch (401 時のみ 1 度 crumb を取り直して retry) */
async function yahooFetch(url: string): Promise<Response> {
  const { crumb, cookie } = await getYahooCrumb();
  const separator = url.includes("?") ? "&" : "?";
  const authUrl = `${url}${separator}crumb=${encodeURIComponent(crumb)}`;

  const res = await fetch(authUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Cookie: cookie,
    },
  });

  if (res.status === 401) {
    cachedCrumb = null;
    cachedCookie = null;
    crumbExpiry = 0;
    const fresh = await getYahooCrumb();
    const retryUrl = `${url}${separator}crumb=${encodeURIComponent(fresh.crumb)}`;
    return fetch(retryUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Cookie: fresh.cookie,
      },
    });
  }

  return res;
}

/** Yahoo の `{ raw, fmt }` フィールドから raw 数値を取り出す */
function extractRawValue(
  field: { raw?: number; fmt?: string | null } | null | undefined
): number | null {
  return field && typeof field.raw === "number" ? field.raw : null;
}

/** Unix タイムスタンプ (秒) → `YYYY-MM-DD` */
function toDateString(timestampSec: number): string {
  return new Date(timestampSec * 1000).toISOString().split("T")[0];
}

// -----------------------------------------------------------------------------
// fetchChart — 日足 OHLCV (個別銘柄 + 指数兼用)
// -----------------------------------------------------------------------------

/** Chart API の戻り値 */
export interface ChartResult {
  symbol: string;
  price: number | null;
  previousClose: number | null;
  dataDate: string;
  ohlcv: DailyOhlcv[];
}

/**
 * 単一シンボルの日足データを取得する
 *
 * @param symbol - "7203" (日本株) / "^VIX" (指数) / "NIY=F" (先物)
 * @param range  - "6mo" | "1y" | "5y" など。デフォルト "5y"
 * @throws HTTP / パース / データ不在エラー時
 */
export async function fetchChart(
  symbol: string,
  range = "5y"
): Promise<ChartResult> {
  const normalized = normalizeSymbol(symbol);
  const url = `${CHART_API_BASE}/${normalized}?range=${range}&interval=1d`;
  const response = await yahooFetch(url);

  if (!response.ok) {
    throw new Error(
      `Chart API HTTP エラー [${symbol}]: ${response.status} ${response.statusText}`
    );
  }

  const json = await response.json();
  const parsed = yahooChartResponseSchema.parse(json);

  if (parsed.chart.error) {
    throw new Error(
      `Chart API エラー [${symbol}]: ${parsed.chart.error.code} - ${parsed.chart.error.description}`
    );
  }
  if (!parsed.chart.result || parsed.chart.result.length === 0) {
    throw new Error(`Chart API エラー [${symbol}]: データが見つかりません`);
  }

  const result = parsed.chart.result[0];
  const timestamps = result.timestamp ?? [];
  const quote = result.indicators.quote[0];

  const ohlcv: DailyOhlcv[] = timestamps.map((ts, i) => ({
    date: toDateString(ts),
    open: quote?.open?.[i] ?? null,
    high: quote?.high?.[i] ?? null,
    low: quote?.low?.[i] ?? null,
    close: quote?.close?.[i] ?? null,
    volume: quote?.volume?.[i] ?? null,
  }));

  const closePrices = quote?.close ?? [];
  const price =
    result.meta.regularMarketPrice ??
    closePrices.filter((p): p is number => p !== null).slice(-1)[0] ??
    null;

  const latestTs = timestamps[timestamps.length - 1];
  const dataDate = latestTs
    ? toDateString(latestTs)
    : new Date().toISOString().split("T")[0];

  const previousClose =
    result.meta.previousClose ??
    result.meta.chartPreviousClose ??
    closePrices.filter((p): p is number => p !== null).slice(-2, -1)[0] ??
    null;

  return { symbol, price, previousClose, dataDate, ohlcv };
}

// -----------------------------------------------------------------------------
// fetchQuoteSummary — ファンダメンタルズ + 年度売上
// -----------------------------------------------------------------------------

/** QuoteSummary API の戻り値 */
export interface QuoteSummaryResult {
  per: number | null;
  pbr: number | null;
  dividendYield: number | null;
  eps: number | null;
  bps: number | null;
  roe: number | null;
  roa: number | null;
  marketCap: number | null;
  operatingMarginTtm: number | null;
  annualFinancials: AnnualFinancial[];
}

export async function fetchQuoteSummary(code: string): Promise<QuoteSummaryResult> {
  if (!JP_STOCK_PATTERN.test(code)) {
    throw new Error(`不正な銘柄コード: ${code} (4桁数字である必要があります)`);
  }

  const url = `${QUOTE_SUMMARY_API_BASE}/${code}.T?modules=${QUOTE_SUMMARY_MODULES}`;
  const response = await yahooFetch(url);

  if (!response.ok) {
    throw new Error(
      `QuoteSummary API HTTP エラー [${code}]: ${response.status} ${response.statusText}`
    );
  }

  const json = await response.json();
  const parsed = yahooQuoteSummaryResponseSchema.parse(json);

  if (parsed.quoteSummary.error) {
    throw new Error(
      `QuoteSummary API エラー [${code}]: ${parsed.quoteSummary.error.code} - ${parsed.quoteSummary.error.description}`
    );
  }
  if (!parsed.quoteSummary.result || parsed.quoteSummary.result.length === 0) {
    throw new Error(`QuoteSummary API エラー [${code}]: データが見つかりません`);
  }

  const result = parsed.quoteSummary.result[0];
  const keyStats = result.defaultKeyStatistics;
  const financialData = result.financialData;
  const summaryDetail = result.summaryDetail;

  const per = extractRawValue(summaryDetail?.trailingPE);
  const pbr = extractRawValue(keyStats?.priceToBook);
  const eps = extractRawValue(keyStats?.trailingEps);
  const bps = extractRawValue(keyStats?.bookValue);
  const marketCap = extractRawValue(summaryDetail?.marketCap);
  const roe = extractRawValue(financialData?.returnOnEquity);
  const roa = extractRawValue(financialData?.returnOnAssets);
  const operatingMarginTtm = extractRawValue(financialData?.operatingMargins);

  // Yahoo の配当利回りは 0.0234 (小数) で返ってくる → % に直して 2 桁丸め
  const rawDividendYield = extractRawValue(summaryDetail?.dividendYield);
  const dividendYield =
    rawDividendYield !== null
      ? Math.round(rawDividendYield * 100 * 100) / 100
      : null;

  const incomeHistory =
    result.incomeStatementHistory?.incomeStatementHistory ?? [];
  const annualFinancials: AnnualFinancial[] = incomeHistory
    .map((item) => {
      const endDate = extractRawValue(item.endDate);
      const revenue = extractRawValue(item.totalRevenue);
      if (endDate === null) return null;
      const fiscalYear = new Date(endDate * 1000).getUTCFullYear();
      return { fiscalYear, revenue };
    })
    .filter((v): v is AnnualFinancial => v !== null)
    .sort((a, b) => a.fiscalYear - b.fiscalYear);

  return {
    per,
    pbr,
    dividendYield,
    eps,
    bps,
    roe,
    roa,
    marketCap,
    operatingMarginTtm,
    annualFinancials,
  };
}

// -----------------------------------------------------------------------------
// fetchStockRawData — Chart + QuoteSummary を並列実行して統合
// -----------------------------------------------------------------------------

/**
 * 1 銘柄ぶんの OHLCV + ファンダメンタルズ + 年度売上を 1 回の呼び出しで取得する
 *
 * これが「統合 Yahoo クライアント」の主力 API。rsi-screening / swing-trading /
 * otakara-yutai のいずれもこれ 1 本で必要なデータが揃う。
 *
 * @param code  - 4 桁日本株コード
 * @param range - OHLCV の取得期間。デフォルト "5y" (RSI120 の履歴に十分)
 */
export async function fetchStockRawData(
  code: string,
  range = "5y"
): Promise<StockRawData> {
  if (!JP_STOCK_PATTERN.test(code)) {
    throw new Error(`不正な銘柄コード: ${code} (4桁数字である必要があります)`);
  }

  const [chart, summary] = await Promise.all([
    fetchChart(code, range),
    fetchQuoteSummary(code),
  ]);

  return {
    price: chart.price,
    per: summary.per,
    pbr: summary.pbr,
    dividendYield: summary.dividendYield,
    eps: summary.eps,
    bps: summary.bps,
    roe: summary.roe,
    roa: summary.roa,
    marketCap: summary.marketCap,
    operatingMarginTtm: summary.operatingMarginTtm,
    dataDate: chart.dataDate,
    ohlcv: chart.ohlcv,
    annualFinancials: summary.annualFinancials,
  };
}
