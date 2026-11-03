/**
 * diag(INC-20261103-kabulab_tool_cloudflare-macro-vix-429): 撤去予定。
 * Yahoo への HTTP 応答が 429 のときだけ 1 行出す。再送・例外・期限・分岐には使わない。
 */

export const YAHOO_429_DIAG_TAG = "[INC-20261103-kabulab_tool_cloudflare-macro-vix-429]";

/** 名前がこのどれかと完全一致する応答ヘッダーだけを出す（小文字比較）。 */
export const YAHOO_429_EXACT_HEADERS = [
  "retry-after",
  "cf-ray",
  "date",
  "ratelimit",
  "ratelimit-policy",
] as const;

/**
 * この接頭辞で始まる応答ヘッダー名だけを追加で出す。
 * `x-ratelimit-*` に加え、同じ制限情報の `x-rate-limit-*` と IETF `ratelimit-*`。
 */
export const YAHOO_429_HEADER_PREFIXES = [
  "x-ratelimit-",
  "x-rate-limit-",
  "ratelimit-",
] as const;

const YAHOO_HTTP_HOSTS = new Set([
  "finance.yahoo.com",
  "query1.finance.yahoo.com",
  "query2.finance.yahoo.com",
]);

const BODY_PREFIX_BYTES = 4096;
const BODY_HEAD_CHARS = 200;
const HEADER_VALUE_CHARS = 200;
const YAHOO_SYMBOL = /^[A-Za-z0-9.^=+-]{1,64}$/;

export type Yahoo429Stage = "auth-page" | "auth-crumb" | "chart" | "quote-summary" | "unknown";

export function isYahoo429HeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  if (
    lower.includes("cookie") ||
    lower.includes("authorization") ||
    lower.includes("crumb") ||
    lower.includes("token")
  ) {
    return false;
  }
  if ((YAHOO_429_EXACT_HEADERS as readonly string[]).includes(lower)) return true;
  return YAHOO_429_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** パスだけの銘柄。クエリ（crumb を含む）は見ない。取れなければ undefined。 */
export function symbolFromYahooUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return undefined;
  }
  const match = /^\/v(?:8\/finance\/chart|10\/finance\/quoteSummary)\/([^/]+)$/.exec(path);
  if (match === null) return undefined;
  return isSafeYahooSymbol(match[1]) ? match[1] : undefined;
}

export function formatYahoo429DiagLine(input: {
  stage: Yahoo429Stage;
  symbol: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}): string {
  return (
    `${YAHOO_429_DIAG_TAG} stage=${JSON.stringify(input.stage)}` +
    ` symbol=${JSON.stringify(input.symbol)}` +
    ` status=${input.status}` +
    ` headers=${JSON.stringify(input.headers)}` +
    ` body=${JSON.stringify(input.body)}`
  );
}

/**
 * Yahoo ホストへの応答が 429 のときだけ 1 行出す。それ以外は何もしない。
 * 本文は clone の先頭だけを読む。失敗しても投げない。
 */
export async function logYahooHttp429(
  response: Response,
  requestUrl: string,
  diagSymbol?: string,
): Promise<void> {
  try {
    if (response.status !== 429) return;
    if (!isYahooHttpHost(requestUrl)) return;
    const stage = stageFromYahooUrl(requestUrl);
    const headers = pickYahoo429Headers(response.headers);
    let body = "<unread>";
    try {
      body = await readRedactedBodyHead(response, stage);
    } catch {
      body = "<unread>";
    }
    console.warn(formatYahoo429DiagLine({
      stage,
      symbol: resolveSymbol(requestUrl, diagSymbol),
      status: response.status,
      headers,
      body,
    }));
  } catch {
    // 計測の失敗は既存の例外経路を変えない
  }
}

function isYahooHttpHost(url: string): boolean {
  try {
    return YAHOO_HTTP_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function stageFromYahooUrl(url: string): Yahoo429Stage {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "unknown";
  }
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return "unknown";
  }
  if (parsed.hostname.toLowerCase() === "finance.yahoo.com") return "auth-page";
  if (path === "/v1/test/getcrumb") return "auth-crumb";
  if (path.startsWith("/v8/finance/chart/")) return "chart";
  if (path.startsWith("/v10/finance/quoteSummary/")) return "quote-summary";
  return "unknown";
}

function resolveSymbol(requestUrl: string, diagSymbol: string | undefined): string {
  const fromPath = symbolFromYahooUrl(requestUrl);
  if (fromPath !== undefined) return fromPath;
  if (diagSymbol !== undefined && isSafeYahooSymbol(diagSymbol)) return diagSymbol;
  return "-";
}

function isSafeYahooSymbol(value: string): boolean {
  return YAHOO_SYMBOL.test(value) && !/crumb/i.test(value);
}

function pickYahoo429Headers(headers: Headers): Record<string, string> {
  const found = new Map<string, string>();
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (!isYahoo429HeaderName(lower) || found.has(lower)) return;
    found.set(lower, redactHeaderValue(value));
  });
  return Object.fromEntries([...found.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function redactHeaderValue(value: string): string {
  return headChars(redactDiagnosticText(value).replace(/[\r\n]+/g, " "), HEADER_VALUE_CHARS);
}

async function readRedactedBodyHead(response: Response, stage: Yahoo429Stage): Promise<string> {
  const raw = await readClonePrefix(response, BODY_PREFIX_BYTES);
  if (stage === "auth-crumb" && isCrumbLikeBody(raw)) return "[redacted]";
  return headChars(redactDiagnosticText(raw), BODY_HEAD_CHARS);
}

function isCrumbLikeBody(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 8 || /\s/.test(trimmed)) return false;
  if (/too|many|request|error|denied|limit|forbid|html|edge|unavailable|rejected/i.test(trimmed)) return false;
  return /^[A-Za-z0-9+/_.=-]+$/.test(trimmed);
}

/** `redactYahooDiagnostic` と同じ crumb / Bearer / Cookie 置換に、JSON の crumb を足す。 */
function redactDiagnosticText(value: string): string {
  return value
    .replace(/([?&]crumb=)[^&\s"'<>]+/gi, "$1[redacted]")
    .replace(/(crumb%3D)(?:(?!%26)[^&\s"'<>])+/gi, "$1[redacted]")
    .replace(/("crumb"\s*:\s*")[^"]*/gi, '$1[redacted]')
    .replace(/\bcrumb\b\s*[:=]\s*["']?[A-Za-z0-9+/_.=-]{6,}/gi, "crumb=[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    // 値だけ伏せる。429 本文が1行でも、後ろの理由まで消さない。
    .replace(/\b((?:Set-)?Cookie)\s*:\s*\S+/gi, "$1: [redacted]")
    .replace(/\bA[13]=[^\s;,"']+/g, "A=[redacted]");
}

function headChars(value: string, maxChars: number): string {
  return Array.from(value).slice(0, maxChars).join("");
}

async function readClonePrefix(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return "";
  const clone = response.clone();
  const reader = clone.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      const slice = value.subarray(0, maxBytes - total);
      chunks.push(slice);
      total += slice.byteLength;
      if (value.byteLength > slice.byteLength) break;
    }
  } finally {
    await reader.cancel();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
