/**
 * 統一 Yahoo Finance クライアント (全サービス共通。crumb/cookie キャッシュも共有)。
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
import {
  assertRawBarsSane,
  assertResponsePriceCoherent,
  guardChartBars,
  isProvenSamePoint,
} from "./bar-sanity.js";
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
/** Retry-After が無い 429 の既定待ち (Yahoo 指定ではなく既定。実測調整可)。 */
export const DEFAULT_RATE_LIMIT_BACKOFF_MS = 5_000;

/**
 * Retry-After を絶対時刻へ変換する。source 実期限を保持し、30 秒への
 * 短縮はしない (待機 budget の cap は呼び出し側 — Node recovery の
 * MAX_RECOVERY_BACKOFF_MS — が担う)。非 finite は既定に倒す。
 */
function rateLimitRetryAt(response: Response): number | null {
  if (response.status !== 429) return null;

  const now = Date.now();
  const value = response.headers.get("Retry-After")?.trim();
  let delayMs = DEFAULT_RATE_LIMIT_BACKOFF_MS;
  if (value && /^\d+$/.test(value)) {
    const seconds = Number(value);
    delayMs =
      Number.isFinite(seconds) && Number.isFinite(seconds * 1_000)
        ? seconds * 1_000
        : DEFAULT_RATE_LIMIT_BACKOFF_MS;
  } else if (value) {
    const retryAt = Date.parse(value);
    if (
      Number.isFinite(retryAt) &&
      new Date(retryAt).toUTCString() === value
    ) {
      delayMs = Math.max(0, retryAt - now);
    }
  }

  const retryAt = now + delayMs;
  return Number.isFinite(retryAt) ? retryAt : now + DEFAULT_RATE_LIMIT_BACKOFF_MS;
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
const credentialRefreshErrors: Record<number, Error> = {};
/** crumb 429 の期限付き失敗。期限内は同一 typed error を投げ、bootstrap しない。 */
let credentialRateLimitedUntil = 0;
let credentialRateLimitError: YahooRateLimitError | null = null;
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
  error: Error
): void {
  credentialRefreshErrors[refreshAttempt] = error;
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
      new Error(
        `Yahoo credential refresh timed out after ${MAX_CREDENTIAL_REFRESH_MS}ms`
      )
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

  if (crumbRes.status === 429) {
    throw new YahooRateLimitError(
      429,
      parseRetryAfter(crumbRes),
      rateLimitRetryAt(crumbRes)
    );
  }
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

  if (
    credentialRateLimitError !== null &&
    Date.now() < credentialRateLimitedUntil
  ) {
    throw credentialRateLimitError;
  }

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
      if (refreshError !== undefined) throw refreshError;
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
    credentialRateLimitedUntil = 0;
    credentialRateLimitError = null;
    return credential;
  } catch (error) {
    if (credentialRefreshAttempt === refreshAttempt) {
      // waiter 共有は typed 429 の同一 instance か、redact 済み Error の
      // いずれか。非 typed の原文・raw cause は共有しない (秘密露出防止)。
      recordCredentialRefreshError(
        refreshAttempt,
        error instanceof YahooRateLimitError
          ? error
          : new Error(
              redactYahooDiagnostic(
                error instanceof Error ? error.message : String(error)
              )
            )
      );
    }
    if (error instanceof YahooRateLimitError) {
      credentialRateLimitedUntil =
        error.retryAtMs ?? Date.now() + DEFAULT_RATE_LIMIT_BACKOFF_MS;
      credentialRateLimitError = error;
    }
    if (error instanceof Error) throw error;
    throw new Error(redactYahooDiagnostic(String(error)), { cause: error });
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
 * **エッジ (Worker) 上で動く前提**。エッジからでも crumb 取得で 429 を
 * 観測した実績あり (typed deadline + cooldown で扱う)。
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

/** 正finiteな同一材料の総額/1株額だけを株数尺度の照合に使う。欠損から株数を補完しない。 */
function impliedShareCount(total: number | null, perShare: number | null): number | null {
  if (total === null || perShare === null || total <= 0 || perShare <= 0 ||
    !Number.isFinite(total) || !Number.isFinite(perShare)) return null;
  const shares = total / perShare;
  return Number.isFinite(shares) && shares > 0 ? shares : null;
}

// TTM/現時点の差は厳密一致で検証できない。独立2尺度が一致しても発行株数と双方10倍超なら
// 基準未確認として降りる。価格の前日比 MAX_DAILY_RATIO とは別の保守的な尺度判定であり、
// この境界から正しい株数・EPS・時価総額を推定してはならない。
const MAX_SHARE_BASIS_RATIO = 10;

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
  /**
   * source 明示 previousClose (meta.previousClose のみ)。欠損は null。
   * 確定日足の前日比には使わない (実バー終値と一致しない — 2026-09-30 実測
   * 4/4 で chartPreviousClose は直前実バー終値と不一致。日足の前日比は
   * 実バー + 直前実バーの終値で組む)。
   */
  previousClose: number | null;
  dataDate: string;
  ohlcv: DailyOhlcv[];
}

/**
 * `fetchChart` の原文 capture (診断の一次保管用)。
 * HTTP 判定・JSON parse・guard より前に `response.clone()` から取る。
 */
export interface YahooChartRawCapture {
  symbol: string;
  status: number;
  bytes: Uint8Array;
  /** 最終 response.url (redirect 検出用。要求 URL との一致を呼出側が検証)。 */
  url: string;
}

export interface FetchChartOptions {
  /**
   * 原文 capture の受取 (任意・1 件)。指定時のみ clone して呼ぶ
   * (未指定の通常呼出はバイト列に触れず従来どおり)。
   */
  onRaw?: (capture: YahooChartRawCapture) => void | Promise<void>;
}

/** `parseChartResponse` の戻り値 (fetchChart と診断が共有する parse 結果)。 */
export interface ParsedChartResponse {
  bars: DailyOhlcv[];
  meta: {
    regularMarketPrice: number | null;
    previousClose: number | null;
    chartPreviousClose: number | null;
  };
  timestamps: number[];
  closePrices: (number | null)[];
}

/**
 * Chart 応答 JSON の純粋 parse (zod 検証 + 日足マッピング)。
 * `fetchChart` 本体と診断 (保管済み原文の再 parse) が共有し、
 * parse 知識の二重化による分類違いを防ぐ。guard (sanitize・coherence)
 * は含まない (呼び出し側が従来どおり適用する)。
 */
export function parseChartResponse(json: unknown, symbol: string): ParsedChartResponse {
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
  // symbol は raw 形 ("7203") で来る。正規化してから応答と照合する。
  assertResponseSymbol(normalizeSymbol(symbol), symbol, result.meta);
  const timestamps = result.timestamp ?? [];
  const quote = result.indicators.quote[0];
  // Yahoo は interval=1d では indicators.adjclose を常に含む。
  // 配列が空になるのは仕様変更時のみ。その場合 adj は全 null となり
  // 呼び出し側の `r.adj ?? r.close` が機能する（adjclose 欠落 = 分割なし = close が正値）。
  const adjcloseArr = result.indicators.adjclose?.[0]?.adjclose ?? [];

  const bars: DailyOhlcv[] = timestamps.map((ts, i) => ({
    date: toDateString(ts),
    open: quote?.open?.[i] ?? null,
    high: quote?.high?.[i] ?? null,
    low: quote?.low?.[i] ?? null,
    close: quote?.close?.[i] ?? null,
    volume: quote?.volume?.[i] ?? null,
    adj: adjcloseArr[i] ?? null,
  }));

  return {
    bars,
    meta: {
      regularMarketPrice: result.meta.regularMarketPrice ?? null,
      previousClose: result.meta.previousClose ?? null,
      chartPreviousClose: result.meta.chartPreviousClose ?? null,
    },
    timestamps,
    closePrices: quote?.close ?? [],
  };
}

/**
 * 単一シンボルの日足データを取得する
 *
 * @param symbol - "7203" (日本株) / "^VIX" (指数) / "NIY=F" (先物)
 * @param range  - "6mo" | "1y" | "5y" など。デフォルト "5y"
 * @param options - `onRaw` 指定時のみ原文 capture する (未指定は従来どおり)
 * @throws HTTP / パース / データ不在エラー時
 */
export async function fetchChart(
  symbol: string,
  range = "5y",
  options?: FetchChartOptions
): Promise<ChartResult> {
  const normalized = normalizeSymbol(symbol);
  const url = `${CHART_API_BASE}/${normalized}?range=${range}&interval=1d&events=split%2Cdiv`;
  const response = await yahooFetch(url);

  if (options?.onRaw) {
    const bytes = new Uint8Array(await response.clone().arrayBuffer());
    await options.onRaw({ symbol, status: response.status, bytes, url: response.url });
  }

  if (!response.ok) {
    throw new Error(
      await yahooHttpErrorMessage(`Chart API HTTP エラー [${symbol}]`, response)
    );
  }

  const json = await response.json();
  const {
    bars: rawBars,
    meta,
    timestamps,
    closePrices,
  } = parseChartResponse(json, symbol);

  // 桁の壊れたバーを取り込まない (bar-sanity.ts 参照)。
  // 1909 の 2026-09-11 は close=16,278,046,720 / volume=0（前日 3,700）で、
  // これが業種平均を汚染して 003 のトップに「機械 +2,105,009.25%」が出た。
  // 共有 guard (修復 replay と同一判定)。棄却の warn は従来どおり出す。
  const { bars: ohlcv, rejected } = guardChartBars(rawBars, meta.regularMarketPrice, symbol);
  if (rejected.length > 0) {
    console.warn(
      `[yahoo] ${symbol}: 帯域チェックで ${rejected.length} 本を採用しませんでした ` +
        rejected.map((r) => `${r.date}(${r.reason})`).join(" ")
    );
  }

  const price =
    meta.regularMarketPrice ??
    closePrices.filter((p): p is number => p !== null).slice(-1)[0] ??
    null;

  const latestTs = timestamps[timestamps.length - 1];
  const dataDate = latestTs
    ? toDateString(latestTs)
    : new Date().toISOString().split("T")[0];

  // source 明示 previousClose のみ。chartPreviousClose / 日足終値での補完は
  // しない (実測で別意味と確定 — 呼び出し側は実バー終値で前日比を組む)。
  const previousClose = meta.previousClose ?? null;

  return { symbol, price, previousClose, dataDate, ohlcv };
}

// -----------------------------------------------------------------------------
// 生 chart レスポンス + VWAP 用の整形取得 (L-60 で lib/yahoo.ts から移動)
// -----------------------------------------------------------------------------

/**
 * Yahoo のレート制限/一時不可 (429/503)。呼び出し側はこれを「これ以上叩くな」の
 * シグナルとして扱い、即リトライで叩き返さない (retry は再スロー、ingest は
 * サーキットブレークで中断する)。`retryAfterMs` は Retry-After ヘッダ由来。
 */
export class YahooRateLimitError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
    readonly retryAtMs: number | null = null
  ) {
    super(
      `yahoo ${status} (rate limited)` +
        (retryAtMs !== null ? `; retry-at-ms=${retryAtMs}` : "")
    );
    this.name = "YahooRateLimitError";
  }
}

function parseRetryAfter(r: Response): number | null {
  const ra = r.headers.get("retry-after");
  if (!ra) return null;
  const sec = Number(ra);
  if (!Number.isFinite(sec) || sec < 0 || !Number.isFinite(sec * 1_000)) {
    return null;
  }
  return sec * 1_000;
}

/** !ok を投げ分ける。429/503 はレート制限として型付きで投げる。 */
function ensureOk(r: Response): void {
  if (r.ok) return;
  if (r.status === 429 || r.status === 503) {
    throw new YahooRateLimitError(r.status, parseRetryAfter(r));
  }
  throw new Error(`yahoo ${r.status}`);
}

/**
 * chart 生レスポンスを取得する (007 の当日 5 分足中継 + 取込 CLI 用)。
 *
 * 共有の yahooFetch (プロキシ対応・crumb 付き) を使う。`symbol` は Yahoo 形式の
 * 完全形 ("7203.T" / "^N225" 等) で渡す (fetchChart のような正規化はしない)。
 * Worker ランタイムでは `YAHOO_PROXY_BASE` 未設定なので直叩きになり、
 * プロキシ自身がループしない。
 */
export async function fetchYahooChartRaw(
  symbol: string,
  range: string,
  interval: string,
  events = false
): Promise<Response> {
  const ev = events ? "&events=split,div" : "";
  const url =
    `${CHART_API_BASE}/${encodeURIComponent(symbol)}` +
    `?range=${range}&interval=${interval}${ev}`;
  return yahooFetch(url);
}

/** chart JSON の最小構造 (fetchBars5m / fetchDaily が読む範囲だけ)。 */
interface YahooChartJson {
  chart?: {
    result?: Array<{
      meta?: {
        symbol?: string;
        regularMarketPrice?: number | null;
        regularMarketTime?: number | null;
      };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }>;
        adjclose?: Array<{ adjclose?: (number | null)[] }>;
      };
      events?: {
        splits?: Record<
          string,
          { date: number; numerator: number; denominator: number }
        >;
      };
    }>;
  };
}

export interface DailyBar {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  adj: number;
}
export interface DailyResult {
  bars: DailyBar[];
  splits: { date: string; ratio: number }[];
}

export const jstDate = (ts: number) =>
  new Date((ts + 32400) * 1000).toISOString().slice(0, 10);

export interface Bar5m {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/**
 * 応答銘柄の同一性検証 (VWAP/ fetchChart 共有 boundary)。
 * 要求の正規化形と応答 meta.symbol の完全一致を要求する。
 * 欠落・不一致は throw (別銘柄混入の採用防止)。推測・補完なし。
 * 正規 alias は既存 normalizeSymbol のみ。
 */
function assertResponseSymbol(
  requestedNormalized: string,
  symbol: string,
  meta: { symbol?: unknown } | null | undefined
): void {
  const got = meta?.symbol;
  if (typeof got !== "string" || got.length === 0) {
    throw new Error(
      `Chart API エラー [${symbol}]: 応答 meta.symbol がありません (別銘柄混入防止のため採用しません)。`
    );
  }
  if (got !== requestedNormalized) {
    throw new Error(
      `Chart API エラー [${symbol}]: 応答銘柄が要求と一致しません (要求=${requestedNormalized} 応答=${got})。`
    );
  }
}

/** chart.error の field-family 診断。値は出さない (存在と型のみ)。 */
function chartErrorFamily(err: unknown): string {
  if (err === null || err === undefined) return "none";
  if (typeof err !== "object") return `type=${typeof err}`;
  if (Array.isArray(err)) return `array[${err.length}]`;
  return `keys=${Object.keys(err as Record<string, unknown>).sort().join(",")}`;
}

/**
 * chart result の厳密抽出。真正 empty は「構造的に妥当な result +
 * timestamp 空配列」のみ。以下は success-empty にせず throw する:
 * chart 非 object / chart.error 非 null (result 併存でも STOP) /
 * result 非配列・非単一・非 object / timestamp 非配列・非有限・非正・
 * 無効 JS 日付。`{0: res}` 形の未知 envelope は受けない。
 */
function extractChartResult(symbol: string, j: YahooChartJson): {
  res: Exclude<
    Exclude<Exclude<YahooChartJson["chart"], undefined>["result"], undefined>[number],
    undefined
  >;
  timestamps: number[];
} {
  const chart = j?.chart as unknown;
  if (chart === null || typeof chart !== "object" || Array.isArray(chart)) {
    throw new Error(
      `Chart API エラー [${symbol}]: chart がありません (空として採用しません)。`
    );
  }
  const chartErr = (chart as { error?: unknown }).error;
  if (chartErr !== null && chartErr !== undefined) {
    throw new Error(
      `Chart API エラー [${symbol}]: chart.error があるため採用しません (${chartErrorFamily(chartErr)})。`
    );
  }
  const result = (chart as { result?: unknown }).result;
  if (!Array.isArray(result) || result.length !== 1) {
    throw new Error(
      `Chart API エラー [${symbol}]: result が単一ではありません (空として採用しません)。`
    );
  }
  const res = result[0] as Record<string, unknown> | null;
  if (res === null || typeof res !== "object" || Array.isArray(res)) {
    throw new Error(
      `Chart API エラー [${symbol}]: result が object ではありません (空として採用しません)。`
    );
  }
  const ts = res.timestamp;
  if (!Array.isArray(ts)) {
    throw new Error(
      `Chart API エラー [${symbol}]: timestamp が配列ではありません (空として採用しません)。`
    );
  }
  for (const t of ts) {
    // jstDate 適用前に正の妥当 JS 日付であることを要求する
    // (RangeError・source 日付捏造の防止)。
    const ms = typeof t === "number" ? (t + 32400) * 1000 : NaN;
    if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(ms) || Number.isNaN(new Date(ms).getTime())) {
      throw new Error(
        `Chart API エラー [${symbol}]: timestamp が正当な時刻ではありません (空として採用しません)。`
      );
    }
  }
  // VWAP 呼び出し側は正規化形 ("7203.T") で呼ぶ。応答の同一性を検証する。
  assertResponseSymbol(symbol, symbol, res.meta as { symbol?: unknown } | null | undefined);
  return {
    res: res as Exclude<
      Exclude<Exclude<YahooChartJson["chart"], undefined>["result"], undefined>[number],
      undefined
    >,
    timestamps: ts,
  };
}

/**
 * quote 必須 5 配列の検証。存在 + timestamps と exact 同長を要求する。
 * 空配列は可 (真正 empty の形)。`[] + stale 非空 quote`・truncated quote は
 * malformed (真正 empty・partial null 扱いしない)。同長での per-row null は
 * 明示 row-missing として残す。
 */
function assertQuoteArrays(
  symbol: string,
  q: Record<string, unknown>,
  timestampsLength: number
): asserts q is {
  open: unknown[];
  high: unknown[];
  low: unknown[];
  close: unknown[];
  volume: unknown[];
} {
  for (const k of ["open", "high", "low", "close", "volume"] as const) {
    const arr = q[k];
    if (!Array.isArray(arr)) {
      throw new Error(
        `Chart API エラー [${symbol}]: quote 配列 ${k} がありません (空として採用しません)。`
      );
    }
    if (arr.length !== timestampsLength) {
      throw new Error(
        `Chart API エラー [${symbol}]: quote 配列 ${k} の長さが timestamp と一致しません ` +
          `(${arr.length} vs ${timestampsLength})。`
      );
    }
  }
}

// 5分足を正準形 [{ts,o,h,l,c,v}] で取得（蓄積・フロント共通の内部形式）。
// 空の区別: timestamp 空配列の真正 empty → []。非空 timestamps で
// 有効バー 0 かつ null 脱落あり → 欠落として throw (真正 empty にしない)。
// 全行 v=0 (妥当 OHLC) → 意図的 business 除外の結果 [] (no-trade 観測。
// 休日推定・v0 行の保持はしない)。
export async function fetchBars5m(symbol: string, range = "5d"): Promise<Bar5m[]> {
  const r = await fetchYahooChartRaw(symbol, range, "5m", false);
  ensureOk(r);
  const j = (await r.json()) as YahooChartJson;
  const { res, timestamps } = extractChartResult(symbol, j);
  // quote 欠落は仕様変更の疑い。空で黙殺せず落とす (旧実装は TypeError)。
  const q = res.indicators?.quote?.[0];
  if (!q) throw new Error(`Chart API エラー [${symbol}]: quote がありません`);
  assertQuoteArrays(symbol, q as unknown as Record<string, unknown>, timestamps.length);
  // 真正 empty: 構造妥当 + timestamp 空配列のみ。
  if (timestamps.length === 0) return [];
  // raw-first 全行検査 (filter 前)。volume filter は無出来高異常を消すため、
  // 実在値の異常は欠落除去の前に見る (他欠落で隠さない)。
  assertRawBarsSane(
    symbol,
    timestamps.map((_, i) => ({
      o: q.open?.[i],
      h: q.high?.[i],
      l: q.low?.[i],
      c: q.close?.[i],
      v: q.volume?.[i],
    }))
  );
  // meta 価格との整合は同時点証明時のみ。時刻根拠が未知 (欠落・interval外)
  // なら旧 session/split 前 bar との誤比較になるため明示 skip する。
  // 形成中 5m bar に daily 完了日 gate は転用しない。
  {
    const li = timestamps.length - 1;
    if (
      li >= 0 &&
      isProvenSamePoint(res.meta?.regularMarketTime, timestamps[li], 300)
    ) {
      assertResponsePriceCoherent({
        symbol,
        latestUsedClose: q.close?.[li] ?? null,
        latestVolume: q.volume?.[li] ?? null,
        metaPrice: res.meta?.regularMarketPrice ?? null,
      });
    }
  }
  const out: Bar5m[] = [];
  let droppedNull = 0;
  let droppedZeroVol = 0;
  for (let i = 0; i < timestamps.length; i++) {
    const o = q.open?.[i],
      h = q.high?.[i],
      l = q.low?.[i],
      c = q.close?.[i],
      v = q.volume?.[i];
    if (o == null || h == null || l == null || c == null || v == null) {
      droppedNull++;
      continue;
    }
    // v=0 は raw として合法。filter 除外は意図的 business 選択。
    if (!v) {
      droppedZeroVol++;
      continue;
    }
    out.push({
      ts: timestamps[i],
      o: +o.toFixed(2),
      h: +h.toFixed(2),
      l: +l.toFixed(2),
      c: +c.toFixed(2),
      v,
    });
  }
  if (out.length === 0 && droppedNull > 0) {
    throw new Error(
      `Chart API エラー [${symbol}]: 全行欠落のため空として採用しません ` +
        `(timestamps=${timestamps.length} null脱落=${droppedNull} v0除外=${droppedZeroVol})。`
    );
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// 日足（最大10年・分割/配当イベント込み）を取得・整形。
// 空の区別は fetchBars5m と同一: 真正 empty は timestamp 空配列のみ。
// 非空 timestamps で有効バー 0 (全行 null) → 欠落として throw する。
export async function fetchDaily(
  symbol: string,
  range = "10y",
  options?: FetchChartOptions
): Promise<DailyResult> {
  const r = await fetchYahooChartRaw(symbol, range, "1d", true);
  // fetchChart と同一の原文 capture (durable-before-parse 用。未指定は従来どおり)。
  if (options?.onRaw) {
    const bytes = new Uint8Array(await r.clone().arrayBuffer());
    await options.onRaw({ symbol, status: r.status, bytes, url: r.url });
  }
  ensureOk(r);
  const j = (await r.json()) as YahooChartJson;
  const { res, timestamps } = extractChartResult(symbol, j);
  // quote 欠落は仕様変更の疑い。空で黙殺せず落とす (旧実装は TypeError)。
  const q = res.indicators?.quote?.[0];
  if (!q) throw new Error(`Chart API エラー [${symbol}]: quote がありません`);
  assertQuoteArrays(symbol, q as unknown as Record<string, unknown>, timestamps.length);
  // 真正 empty: 構造妥当 + timestamp 空配列のみ。
  if (timestamps.length === 0) return { bars: [], splits: [] };
  const adj = res.indicators?.adjclose?.[0]?.adjclose || [];
  // raw-first 全行検査 (filter 前)。使用/保存する adj の実値もここで見る。
  assertRawBarsSane(
    symbol,
    timestamps.map((_, i) => ({
      o: q.open?.[i],
      h: q.high?.[i],
      l: q.low?.[i],
      c: q.close?.[i],
      v: q.volume?.[i],
    })),
    adj
  );
  const bars: DailyBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = q.open?.[i],
      h = q.high?.[i],
      l = q.low?.[i],
      c = q.close?.[i],
      v = q.volume?.[i];
    // null は欠落として落とす。null 出来高は 0 に化けない (missing≠実0)。
    // v=0 は合法行として残す (daily は v0 を filter しない)。
    if (o == null || h == null || l == null || c == null || v == null) continue;
    // OHLCV 保存候補が揃った行で adj 欠落なら throw (c 代用なし。行だけの
    // silent skip も不可)。呼び出し側は当該 stock PUT0/errors/exit1 へ。
    const a = adj[i];
    if (a == null) {
      throw new Error(
        `Chart API エラー [${symbol}]: 保存候補行に adj 欠落のため応答全体を採用しません。`
      );
    }
    bars.push({
      date: jstDate(timestamps[i]),
      o: +o.toFixed(2),
      h: +h.toFixed(2),
      l: +l.toFixed(2),
      c: +c.toFixed(2),
      v,
      adj: +a.toFixed(2),
    });
  }
  // 非空 timestamps で有効バー 0 = 全行 null 欠落。真正 empty にしない。
  // (daily は v=0 行を残すため、0 件は null 脱落のみで起きる)
  if (bars.length === 0) {
    throw new Error(
      `Chart API エラー [${symbol}]: 全行欠落のため空として採用しません (timestamps=${timestamps.length})。`
    );
  }
  const splits: { date: string; ratio: number }[] = [];
  // events/splits は提供されれば期待 object。欠落 (null/undefined) のみ
  // no-events として空扱いする (文書化された不在形)。
  const events = res.events as unknown;
  if (events !== null && events !== undefined) {
    if (typeof events !== "object" || Array.isArray(events)) {
      throw new Error(
        `Chart API エラー [${symbol}]: events 応答の形状が不正です。`
      );
    }
    const ev = (events as { splits?: unknown }).splits;
    if (ev !== null && ev !== undefined) {
      if (typeof ev !== "object" || Array.isArray(ev)) {
        throw new Error(
          `Chart API エラー [${symbol}]: splits 応答の形状が不正です。`
        );
      }
      for (const k of Object.keys(ev)) {
        const s = (ev as Record<string, unknown>)[k] as {
          date?: unknown;
          numerator?: unknown;
          denominator?: unknown;
        } | null;
        // 分割株数は負にならない: 分子・分母は各々有限正数。
        // (負/負が見かけ正 ratio になる抜けを塞ぐ)
        const badShape =
          s == null ||
          typeof s.date !== "number" ||
          !Number.isFinite(s.date) ||
          s.date <= 0 ||
          Number.isNaN(new Date((s.date + 32400) * 1000).getTime()) ||
          !Number.isFinite(s.numerator) ||
          (s.numerator as number) <= 0 ||
          !Number.isFinite(s.denominator) ||
          (s.denominator as number) <= 0;
        if (badShape) {
          throw new Error(
            `Chart API エラー [${symbol}]: splits 応答の形状が不正です (key=${k})。`
          );
        }
        // 結果 ratio が有限正数であることを要求する (0/負・overflow
        // Infinity の JSON null 化を保存前に拒否。保存側契約と同一)。
        const ratio = (s as { numerator: number; denominator: number }).numerator /
          (s as { numerator: number; denominator: number }).denominator;
        if (!Number.isFinite(ratio) || ratio <= 0) {
          throw new Error(
            `Chart API エラー [${symbol}]: splits ratio が正の有限値ではありません (key=${k})。`
          );
        }
        splits.push({ date: jstDate(s.date as number), ratio });
      }
    }
  }
  // fetchChart と同じ応答整合 (R2 daily への別経路も書込前に拒否する)。
  {
    const latest = bars[bars.length - 1];
    assertResponsePriceCoherent({
      symbol,
      latestUsedClose: latest?.c ?? null,
      latestVolume: latest?.v ?? null,
      metaPrice: res.meta?.regularMarketPrice ?? null,
    });
  }
  return { bars, splits };
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

  const reportedShares = extractRawValue(keyStats?.sharesOutstanding);
  const floatShares = extractRawValue(keyStats?.floatShares);
  const cashShares = impliedShareCount(
    extractRawValue(financialData?.totalCash),
    extractRawValue(financialData?.totalCashPerShare)
  );
  const revenueShares = impliedShareCount(
    extractRawValue(financialData?.totalRevenue),
    extractRawValue(financialData?.revenuePerShare)
  );
  const shareBasisUnconfirmed = reportedShares !== null && reportedShares > 0 &&
    Number.isFinite(reportedShares) && (
      (floatShares !== null && Number.isFinite(floatShares) && floatShares > reportedShares) ||
      (cashShares !== null && revenueShares !== null &&
        Math.max(cashShares, revenueShares) / Math.min(cashShares, revenueShares) <= MAX_SHARE_BASIS_RATIO &&
        Math.max(cashShares, reportedShares) / Math.min(cashShares, reportedShares) > MAX_SHARE_BASIS_RATIO &&
        Math.max(revenueShares, reportedShares) / Math.min(revenueShares, reportedShares) > MAX_SHARE_BASIS_RATIO)
    );
  if (shareBasisUnconfirmed) {
    console.warn(`[yahoo] ${code}: 株数の尺度が応答内で不整合のため EPS/PER/時価総額を採用しません`);
  }

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
    per: shareBasisUnconfirmed ? null : per,
    pbr,
    dividendYield,
    eps: shareBasisUnconfirmed ? null : eps,
    bps,
    roe,
    roa,
    marketCap: shareBasisUnconfirmed ? null : marketCap,
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
