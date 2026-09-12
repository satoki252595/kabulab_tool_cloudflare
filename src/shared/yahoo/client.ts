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
import { sharedEnv } from "../env.js";
import { sanitizeBars } from "./bar-sanity.js";
import { STOCK_CODE_REGEX } from "../jpx/stock-code.js";

/**
 * 日本株銘柄コード。
 * 従来 4 桁数字のみだったが、2024 年から JPX が新規上場銘柄に
 * 「4 桁数字 + 末尾英字 1 文字」(例: 130A ソラコム、141A トライアル) を採用。
 * 末尾英字も Yahoo の `<code>.T` 形式で取得可能。
 *
 * パターンは銘柄コード契約の {@link STOCK_CODE_REGEX} を使う。ここに
 * `/^\d{3}[\dA-Z]$/` を写経していたため、正準パターンの写しが 1 つ増えていた
 * (financial-math の price-cache.ts は既に共有定数を参照している)。
 */
const JP_STOCK_PATTERN = STOCK_CODE_REGEX;
/** 指数シンボル (例: ^N225, ^VIX) */
const INDEX_PATTERN = /^\^[A-Z0-9]+$/;
/** 先物シンボル (例: NIY=F) */
const FUTURES_PATTERN = /^[A-Z0-9]{1,6}=F$/;

const CHART_API_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const QUOTE_SUMMARY_API_BASE = "https://query1.finance.yahoo.com/v10/finance/quoteSummary";
const QUOTE_SUMMARY_MODULES =
  "financialData,defaultKeyStatistics,summaryDetail,incomeStatementHistory";
const HTTP_ERROR_BODY_MAX_BYTES = 300;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 5_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 30_000;

/** Retry-After を絶対時刻へ変換し、Actions の実行時間を守るため最大30秒に制限する。 */
function rateLimitRetryAt(response: Response): number | null {
  if (response.status !== 429) return null;

  const now = Date.now();
  const value = response.headers.get("Retry-After")?.trim();
  let delayMs = DEFAULT_RATE_LIMIT_BACKOFF_MS;
  if (value && /^\d+$/.test(value)) {
    delayMs = Number(value) * 1_000;
  } else if (value) {
    const retryAt = Date.parse(value);
    if (
      Number.isFinite(retryAt) &&
      new Date(retryAt).toUTCString() === value
    ) {
      delayMs = Math.max(0, retryAt - now);
    }
  }

  return now + Math.min(delayMs, MAX_RATE_LIMIT_BACKOFF_MS);
}

async function readResponsePrefix(
  response: Response,
  maxBytes: number
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const prefix = new Uint8Array(maxBytes);
  let written = 0;
  try {
    while (written < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, maxBytes - written);
      prefix.set(chunk, written);
      written += chunk.length;
    }
  } finally {
    await reader.cancel();
  }
  return new TextDecoder().decode(prefix.subarray(0, written));
}

export function redactYahooDiagnostic(value: string): string {
  return value
    .replace(/([?&]crumb=)[^&\s"'<>]+/gi, "$1[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b((?:Set-)?Cookie)\s*:\s*[^\r\n]*/gi, "$1: [redacted]");
}

/** Yahoo/取込プロキシの失敗元を次回ログで切り分けられる形にする。 */
export async function yahooHttpErrorMessage(
  label: string,
  response: Response
): Promise<string> {
  const details: string[] = [];
  const upstreamStatus = response.headers.get("X-Kabulab-Yahoo-Status");
  const cfRay = response.headers.get("CF-Ray");
  const source = upstreamStatus
    ? "yahoo-upstream"
    : sharedEnv.YAHOO_PROXY_BASE()
      ? "ingest-proxy"
      : "yahoo-direct";
  details.push(`source=${source}`);
  if (upstreamStatus) details.push(`yahoo-status=${upstreamStatus}`);
  if (source === "ingest-proxy" && cfRay) details.push(`cf-ray=${cfRay}`);
  const retryAt = rateLimitRetryAt(response);
  if (retryAt !== null) details.push(`retry-at-ms=${retryAt}`);

  try {
    const body = redactYahooDiagnostic(
      await readResponsePrefix(response, HTTP_ERROR_BODY_MAX_BYTES)
    )
      .replace(/\s+/g, " ")
      .trim();
    if (body) {
      details.push(`body=${JSON.stringify(body)}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    details.push(
      `body-read-error=${JSON.stringify(redactYahooDiagnostic(message))}`
    );
  }

  return `${label}: ${response.status} ${response.statusText}; ${details.join("; ")}`;
}

interface YahooCredential {
  crumb: string;
  cookie: string;
  generation: number;
}

/** isolate 内で共有するのは request I/O を含まない認証値と更新メタデータだけ。 */
let cachedCredential: YahooCredential | null = null;
let credentialExpiry = 0;
let credentialGeneration = 0;
let credentialRefreshInProgress = false;
let credentialRefreshAttempt = 0;
let credentialRefreshStartedAt = 0;
const credentialRefreshErrors: Record<number, string> = {};
const credentialRefreshWaiterCounts: Record<number, number> = {};
const CREDENTIAL_REFRESH_POLL_MS = 100;
const MAX_CREDENTIAL_REFRESH_MS = 30_000;

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

function currentYahooCredential(): YahooCredential | null {
  if (cachedCredential && Date.now() < credentialExpiry) {
    return cachedCredential;
  }
  return null;
}

/** request ごとに生成する timer。Promise を module global に保持しない。 */
function waitForCredentialRefresh(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function assertCredentialRefreshOwner(refreshAttempt: number): void {
  if (
    !credentialRefreshInProgress ||
    credentialRefreshAttempt !== refreshAttempt
  ) {
    throw new Error("Yahoo credential refresh ownership expired");
  }
}

function addCredentialRefreshWaiter(refreshAttempt: number): void {
  const count = credentialRefreshWaiterCounts[refreshAttempt];
  credentialRefreshWaiterCounts[refreshAttempt] =
    count === undefined ? 1 : count + 1;
}

function removeCredentialRefreshWaiter(refreshAttempt: number): void {
  const count = credentialRefreshWaiterCounts[refreshAttempt];
  if (count === undefined || count <= 1) {
    delete credentialRefreshWaiterCounts[refreshAttempt];
    delete credentialRefreshErrors[refreshAttempt];
    return;
  }
  credentialRefreshWaiterCounts[refreshAttempt] = count - 1;
}

function recordCredentialRefreshError(
  refreshAttempt: number,
  message: string
): void {
  credentialRefreshErrors[refreshAttempt] = message;
  if (credentialRefreshWaiterCounts[refreshAttempt] === undefined) {
    delete credentialRefreshErrors[refreshAttempt];
  }
}

function expireCredentialRefresh(refreshAttempt: number): void {
  if (
    credentialRefreshInProgress &&
    credentialRefreshAttempt === refreshAttempt
  ) {
    recordCredentialRefreshError(
      refreshAttempt,
      `Yahoo credential refresh timed out after ${MAX_CREDENTIAL_REFRESH_MS}ms`
    );
    credentialRefreshInProgress = false;
  }
}

async function bootstrapYahooCredential(
  refreshAttempt: number,
  signal: AbortSignal
): Promise<{
  crumb: string;
  cookie: string;
}> {
  const pageRes = await fetch("https://finance.yahoo.com/quote/AAPL", {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Accept: "text/html",
    },
    redirect: "manual",
    signal,
  });
  assertCredentialRefreshOwner(refreshAttempt);

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
      signal,
    }
  );
  assertCredentialRefreshOwner(refreshAttempt);

  if (!crumbRes.ok) {
    throw new Error(
      await yahooHttpErrorMessage("Yahoo crumb HTTP エラー", crumbRes)
    );
  }

  const crumb = (await crumbRes.text()).trim();
  assertCredentialRefreshOwner(refreshAttempt);
  return { crumb, cookie: cookieStr };
}

/**
 * Yahoo Finance の認証値を取得する (30 分キャッシュ + isolate 内 single-flight)。
 * 待機側は自 request の timer だけを await し、bootstrap の I/O Promise を共有しない。
 */
async function getYahooCredential(): Promise<YahooCredential> {
  const cached = currentYahooCredential();
  if (cached) return cached;

  if (credentialRefreshInProgress) {
    const joinedAttempt = credentialRefreshAttempt;
    const refreshDeadline =
      credentialRefreshStartedAt + MAX_CREDENTIAL_REFRESH_MS;
    addCredentialRefreshWaiter(joinedAttempt);
    try {
      while (
        credentialRefreshInProgress &&
        credentialRefreshAttempt === joinedAttempt
      ) {
        const remainingMs = refreshDeadline - Date.now();
        if (remainingMs <= 0) {
          expireCredentialRefresh(joinedAttempt);
          break;
        }
        await waitForCredentialRefresh(
          Math.min(CREDENTIAL_REFRESH_POLL_MS, remainingMs)
        );
      }
      const refreshError = credentialRefreshErrors[joinedAttempt];
      if (refreshError !== undefined) throw new Error(refreshError);
      return getYahooCredential();
    } finally {
      removeCredentialRefreshWaiter(joinedAttempt);
    }
  }

  const refreshAttempt = ++credentialRefreshAttempt;
  credentialRefreshInProgress = true;
  credentialRefreshStartedAt = Date.now();
  try {
    const bootstrap = await bootstrapYahooCredential(
      refreshAttempt,
      AbortSignal.timeout(MAX_CREDENTIAL_REFRESH_MS)
    );
    assertCredentialRefreshOwner(refreshAttempt);
    const credential: YahooCredential = {
      ...bootstrap,
      generation: ++credentialGeneration,
    };
    cachedCredential = credential;
    credentialExpiry = Date.now() + 30 * 60 * 1000;
    return credential;
  } catch (error) {
    const message = redactYahooDiagnostic(
      error instanceof Error ? error.message : String(error)
    );
    if (credentialRefreshAttempt === refreshAttempt) {
      recordCredentialRefreshError(refreshAttempt, message);
    }
    if (error instanceof Error) throw error;
    throw new Error(message, { cause: error });
  } finally {
    if (credentialRefreshAttempt === refreshAttempt) {
      credentialRefreshInProgress = false;
      credentialRefreshStartedAt = 0;
    }
  }
}

/** 遅れて届いた旧 credential の 401 では、更新済み cache を消さない。 */
function invalidateYahooCredential(used: YahooCredential): void {
  if (cachedCredential?.generation !== used.generation) return;
  cachedCredential = null;
  credentialExpiry = 0;
}

/**
 * crumb 付きの直接 fetch (401 時のみ 1 度 crumb を取り直して retry)。
 * **エッジ (Worker) 上で動く前提**。Cloudflare エッジ IP は Yahoo の 429 に掛からない。
 * 取込プロキシルート (/api/ingest/yahoo) からも直接呼ばれる (export)。
 */
export async function yahooFetchDirect(url: string): Promise<Response> {
  const credential = await getYahooCredential();
  const separator = url.includes("?") ? "&" : "?";
  const authUrl = `${url}${separator}crumb=${encodeURIComponent(credential.crumb)}`;

  const res = await fetch(authUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Cookie: credential.cookie,
    },
  });

  if (res.status === 401) {
    invalidateYahooCredential(credential);
    const fresh = await getYahooCredential();
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

/**
 * 認証付き fetch。
 *
 * - **Node 取込 (GitHub Actions / ローカル)**: `YAHOO_PROXY_BASE` が設定されていれば
 *   Cloudflare エッジの取込プロキシ (`/api/ingest/yahoo`) 経由で叩き、自宅/CI IP の
 *   429 を回避する。crumb/cookie はエッジ側 (yahooFetchDirect) が処理する。
 * - **エッジ (Worker) / プロキシ未設定**: そのまま直接 fetch (yahooFetchDirect)。
 *
 * CLAUDE.md ルール2: プロキシ未到達でも別値で握り潰さず、エラーはそのまま伝播させる。
 */
async function yahooFetch(url: string): Promise<Response> {
  const proxyBase = sharedEnv.YAHOO_PROXY_BASE();
  const secret = sharedEnv.CRON_SECRET();
  if (proxyBase && !secret) {
    throw new Error(
      "Yahoo 取込プロキシ設定が不完全です: " +
        "YAHOO_PROXY_BASE を使う場合は CRON_SECRET も設定してください。"
    );
  }
  if (proxyBase && secret) {
    const proxied = `${proxyBase.replace(/\/$/, "")}/api/ingest/yahoo?u=${encodeURIComponent(url)}`;
    return fetch(proxied, {
      headers: { Authorization: `Bearer ${secret}` },
    });
  }
  return yahooFetchDirect(url);
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
  const url = `${CHART_API_BASE}/${normalized}?range=${range}&interval=1d&events=split%2Cdiv`;
  const response = await yahooFetch(url);

  if (!response.ok) {
    throw new Error(
      await yahooHttpErrorMessage(`Chart API HTTP エラー [${symbol}]`, response)
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
  // Yahoo は interval=1d では indicators.adjclose を常に含む。
  // 配列が空になるのは仕様変更時のみ。その場合 adj は全 null となり
  // 呼び出し側の `r.adj ?? r.close` が機能する（adjclose 欠落 = 分割なし = close が正値）。
  const adjcloseArr = result.indicators.adjclose?.[0]?.adjclose ?? [];

  const rawBars: DailyOhlcv[] = timestamps.map((ts, i) => ({
    date: toDateString(ts),
    open: quote?.open?.[i] ?? null,
    high: quote?.high?.[i] ?? null,
    low: quote?.low?.[i] ?? null,
    close: quote?.close?.[i] ?? null,
    volume: quote?.volume?.[i] ?? null,
    adj: adjcloseArr[i] ?? null,
  }));

  // 桁の壊れたバーを取り込まない (bar-sanity.ts 参照)。
  // 1909 の 2026-09-11 は close=16,278,046,720 / volume=0（前日 3,700）で、
  // これが業種平均を汚染して 003 のトップに「機械 +2,105,009.25%」が出た。
  const { bars: ohlcv, rejected } = sanitizeBars(rawBars);
  if (rejected.length > 0) {
    console.warn(
      `[yahoo] ${symbol}: 帯域チェックで ${rejected.length} 本を採用しませんでした ` +
        rejected.map((r) => `${r.date}(${r.reason})`).join(" ")
    );
  }

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
    throw new Error(
      `不正な銘柄コード: ${code} (数字4桁または数字3桁+末尾英字である必要があります)`
    );
  }

  const url = `${QUOTE_SUMMARY_API_BASE}/${code}.T?modules=${QUOTE_SUMMARY_MODULES}`;
  const response = await yahooFetch(url);

  if (!response.ok) {
    throw new Error(
      await yahooHttpErrorMessage(
        `QuoteSummary API HTTP エラー [${code}]`,
        response
      )
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
  // 既知の欠陥 1: revenue (totalRevenue) は**連結と単体が期ごとに混在**する。
  //   Yahoo は持株会社で親会社単体の売上高を混ぜて返すため、同一銘柄の系列内に
  //   10〜40 倍の段差が出る。ここでは供給された値をそのまま保存し、
  //   利用側 (src/shared/indicators/blue-chip.ts の hasDefinitionBreak) で降りる。
  //   書き込み側で弾かない理由は同ファイルのコメント参照 (更新が永久停止するため)。
  //
  // 既知の欠陥 2: fiscalYear は**期末日を捨てて暦年に丸めている**。
  //   結果、この列は銘柄間で意味が違う:
  //     3 月期企業の fiscal_year=2025 は和暦の 2024 年度 (2024-04〜2025-03)
  //     12 月期企業の fiscal_year=2025 は 2025 年度 (2025-01〜2025-12)
  //   つまり fiscal_year を銘柄間で横並びに比較してはいけない (同一銘柄内の
  //   時系列としてのみ有効)。決算期変更で暦年が衝突すると年が 1 つ欠ける。
  //   列 (fiscal_period_end 等) を足して直さない理由:
  //   core_stock_annual_financials は「現状維持のまま、既存消費者を移し終えたら
  //   DROP する」と決めた表なので、寿命の短い表にスキーマ変更を積まない。
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
    throw new Error(
      `不正な銘柄コード: ${code} (数字4桁または数字3桁+末尾英字である必要があります)`
    );
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
