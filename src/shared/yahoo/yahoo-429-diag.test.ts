/**
 * INC-20261103-kabulab_tool_cloudflare-macro-vix-429
 * 429 応答と、共有停止で送信前に止める分岐の計測行だけを足す。
 * 秘密・Cookie・crumb を出さないことと、既存の例外経路を変えないことを見る。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  YAHOO_429_DIAG_TAG,
  YAHOO_429_EXACT_HEADERS,
  YAHOO_429_HEADER_PREFIXES,
  isYahoo429HeaderName,
  logYahooCooldownShortCircuit,
  logYahooHttp429,
  symbolFromYahooUrl,
} from "./yahoo-429-diag.js";

const ORIGINAL_PROXY_BASE = process.env.YAHOO_PROXY_BASE;
const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;
const CHART = "https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?range=5y&interval=1d";
const PAGE = "https://finance.yahoo.com/quote/AAPL";
const CRUMB = "https://query2.finance.yahoo.com/v1/test/getcrumb";

function incidentLines(warn: { mock: { calls: unknown[][] } }): string[] {
  return warn.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith(YAHOO_429_DIAG_TAG));
}

beforeEach(() => {
  vi.resetModules();
  delete process.env.YAHOO_PROXY_BASE;
  delete process.env.CRON_SECRET;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (ORIGINAL_PROXY_BASE === undefined) delete process.env.YAHOO_PROXY_BASE;
  else process.env.YAHOO_PROXY_BASE = ORIGINAL_PROXY_BASE;
  if (ORIGINAL_CRON_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
});

describe("Yahoo 429 計測の許可リスト", () => {
  it("制限ヘッダーと cf-ray / date だけを許し、Cookie やトークン名は許さない", () => {
    for (const name of YAHOO_429_EXACT_HEADERS) {
      expect(isYahoo429HeaderName(name)).toBe(true);
      expect(isYahoo429HeaderName(name.toUpperCase())).toBe(true);
    }
    for (const prefix of YAHOO_429_HEADER_PREFIXES) {
      expect(isYahoo429HeaderName(`${prefix}remaining`)).toBe(true);
    }
    for (const name of [
      "set-cookie",
      "cookie",
      "authorization",
      "x-kabulab-yahoo-stage",
      "x-kabulab-yahoo-status",
      "x-ratelimit-cookie",
      "x-ratelimit-token",
      "x-csrf-token",
      "crumb",
      "content-type",
      "server",
    ]) {
      expect(isYahoo429HeaderName(name)).toBe(false);
    }
  });

  it("銘柄はパスだけから取り、クエリの crumb は見ない", () => {
    expect(symbolFromYahooUrl(`${CHART}&crumb=secret-crumb`)).toBe("^VIX");
    expect(symbolFromYahooUrl("https://query1.finance.yahoo.com/v10/finance/quoteSummary/7203.T?modules=financialData&crumb=secret-crumb")).toBe("7203.T");
    expect(symbolFromYahooUrl("https://query1.finance.yahoo.com/v8/finance/chart/NIY=F")).toBe("NIY=F");
    expect(symbolFromYahooUrl(CRUMB)).toBeUndefined();
    expect(symbolFromYahooUrl(`${PAGE}?crumb=secret-crumb`)).toBeUndefined();
  });
});

describe("logYahooHttp429", () => {
  it("chart の 429 は許可ヘッダーと本文先頭だけを1行にし、秘密と本文の続きを出さない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body =
      "Too Many Requests crumb=body-crumb-secret Cookie: A1=body-cookie-secret " +
      "Set-Cookie: A3=body-set-cookie-secret Bearer body-bearer-secret A1=raw-cookie-secret " +
      `${"Y".repeat(400)}END`;
    const response = new Response(body, {
      status: 429,
      headers: {
        "Retry-After": "120",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Limit": "2000",
        "X-Rate-Limit-Reset": "30",
        "RateLimit-Remaining": "1",
        RateLimit: "default",
        "RateLimit-Policy": "default;q=100",
        "CF-Ray": "9f2dummy-NRT",
        Date: "Tue, 03 Nov 2026 21:00:00 GMT",
        "Set-Cookie": "A1=response-cookie-secret; Path=/",
        Cookie: "request-cookie-secret",
        Authorization: "Bearer header-bearer-secret",
        "X-Kabulab-Yahoo-Stage": "chart",
        "X-Request-Id": "req-secret-id",
      },
    });
    const requestUrl = `${CHART}&crumb=url-crumb-secret`;

    await expect(logYahooHttp429(response, requestUrl)).resolves.toBeUndefined();

    const lines = incidentLines(warn);
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).not.toMatch(/\n/);
    expect(line).toContain('stage="chart"');
    expect(line).toContain('symbol="^VIX"');
    expect(line).toContain("status=429");
    expect(line).toContain('"retry-after":"120"');
    expect(line).toContain('"x-ratelimit-remaining":"0"');
    expect(line).toContain('"x-ratelimit-limit":"2000"');
    expect(line).toContain('"x-rate-limit-reset":"30"');
    expect(line).toContain('"ratelimit-remaining":"1"');
    expect(line).toContain('"ratelimit":"default"');
    expect(line).toContain('"ratelimit-policy":"default;q=100"');
    expect(line).toContain('"cf-ray":"9f2dummy-NRT"');
    expect(line).toContain('"date":"Tue, 03 Nov 2026 21:00:00 GMT"');
    expect(line).toContain("Too Many Requests");
    expect(line).toContain("crumb=[redacted]");
    expect(line).toContain("Cookie: [redacted]");
    expect(line).toContain("Set-Cookie: [redacted]");
    expect(line).toContain("Bearer [redacted]");
    const loggedBody = JSON.parse(/ body=(.*)$/.exec(line)?.[1] ?? "null") as string;
    expect(loggedBody).toHaveLength(200);
    expect(loggedBody.startsWith("Too Many Requests")).toBe(true);
    expect(loggedBody).not.toContain("END");
    for (const secret of [
      "body-crumb-secret",
      "url-crumb-secret",
      "body-cookie-secret",
      "body-set-cookie-secret",
      "body-bearer-secret",
      "raw-cookie-secret",
      "response-cookie-secret",
      "request-cookie-secret",
      "header-bearer-secret",
      "req-secret-id",
    ]) {
      expect(line).not.toContain(secret);
    }
    expect(response.headers.get("set-cookie")).toContain("response-cookie-secret");
    expect(await response.text()).toBe(body);
  });

  it("auth-crumb の 429 は呼び出し元の記号を出し、crumb そのものらしい本文は出さない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const token = "ZzCrumbLikeToken99";
    const response = new Response(token, {
      status: 429,
      headers: { "Retry-After": "9", "Set-Cookie": "A1=crumb-cookie-secret" },
    });

    await logYahooHttp429(response, `${CRUMB}?crumb=${token}`, "^VIX");

    const line = incidentLines(warn)[0];
    expect(line).toContain('stage="auth-crumb"');
    expect(line).toContain('symbol="^VIX"');
    expect(line).toContain('body="[redacted]"');
    expect(line).not.toContain(token);
    expect(line).not.toContain("crumb-cookie-secret");
    expect(line).not.toContain("AAPL");
    expect(await response.text()).toBe(token);
  });

  it("auth-crumb の説明文は先頭200文字だけ残し、記号が無ければ記号を作らない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = `slow down ${"あ".repeat(190)}TAIL`;
    await logYahooHttp429(new Response(body, { status: 429 }), CRUMB);

    const line = incidentLines(warn)[0];
    expect(line).toContain('stage="auth-crumb"');
    expect(line).toContain('symbol="-"');
    expect(line).toContain("slow down");
    expect(line).not.toContain("TAIL");
    const loggedBody = / body=(.*)$/.exec(line)?.[1];
    expect(loggedBody).toBeDefined();
    expect(JSON.parse(loggedBody ?? "null")).toHaveLength(200);
  });

  it.each([200, 401, 503])("status %s では行を出さず本文も消費しない", async (status) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = new Response("keep-me", { status, headers: { "Retry-After": "1", "Set-Cookie": "A1=secret" } });
    await logYahooHttp429(response, CHART, "^VIX");
    expect(incidentLines(warn)).toEqual([]);
    expect(await response.text()).toBe("keep-me");
  });

  it("Yahoo 以外の 429 は出さない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = new Response("proxy body crumb=proxy-crumb-secret", {
      status: 429,
      headers: { "Retry-After": "4", "Set-Cookie": "A1=proxy-cookie-secret" },
    });
    await logYahooHttp429(response, "https://proxy.test.invalid/api/ingest/yahoo?u=1&crumb=proxy-crumb-secret");
    expect(incidentLines(warn)).toEqual([]);
    expect(await response.text()).toContain("proxy-crumb-secret");
  });

  it("本文の複製に失敗してもヘッダー行は出て、失敗理由の秘密は出さず、元の本文は残る", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = new Response("visible-body", {
      status: 429,
      headers: { "Retry-After": "3", "Set-Cookie": "A1=nope-secret" },
    });
    vi.spyOn(response, "clone").mockImplementation(() => {
      throw new Error("clone failed crumb=clone-crumb-secret Cookie: A1=clone-cookie-secret");
    });

    await expect(logYahooHttp429(response, CHART)).resolves.toBeUndefined();

    const line = incidentLines(warn)[0];
    expect(line).toContain('stage="chart"');
    expect(line).toContain('"retry-after":"3"');
    expect(line).toContain('body="<unread>"');
    expect(line).not.toContain("clone-crumb-secret");
    expect(line).not.toContain("clone-cookie-secret");
    expect(line).not.toContain("nope-secret");
    expect(await response.text()).toBe("visible-body");
  });
});

describe("yahooFetchDirect 経由の 429 計測", () => {
  function requestUrl(input: RequestInfo | URL): string {
    return typeof input === "string" ? input : input.toString();
  }

  it("crumb 429 は ^VIX の auth-crumb として1行出し、typed error と fetch 回数は変えない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === PAGE) return new Response("", { headers: { "Set-Cookie": "A1=page-secret-value; Path=/" } });
      if (url === CRUMB) {
        return new Response("slow down crumb=body-crumb-secret Cookie: A1=body-cookie-secret", {
          status: 429,
          headers: {
            "Retry-After": "9",
            "X-RateLimit-Remaining": "0",
            "Set-Cookie": "A1=crumb-cookie-secret; Path=/",
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { yahooFetchDirect, YahooRateLimitError } = await import("./client.js");

    const err = await yahooFetchDirect(CHART).catch((error: unknown) => error);

    expect(err).toBeInstanceOf(YahooRateLimitError);
    expect(err).toMatchObject({ status: 429, authStage: "auth-crumb" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const lines = incidentLines(warn);
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).toContain('stage="auth-crumb"');
    expect(line).toContain('symbol="^VIX"');
    expect(line).toContain("status=429");
    expect(line).toContain('"retry-after":"9"');
    expect(line).toContain('"x-ratelimit-remaining":"0"');
    expect(line).toContain("slow down");
    expect(line).toContain("crumb=[redacted]");
    for (const secret of ["page-secret-value", "body-crumb-secret", "body-cookie-secret", "crumb-cookie-secret"]) {
      expect(line).not.toContain(secret);
    }
    expect(String(err)).not.toContain("page-secret-value");
    expect(String(err)).toContain("auth-crumb");
  });

  it("chart 429 の本文は既存の例外文からも読め、URL の crumb は計測行に出ない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let chartCrumb = "";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === PAGE) return new Response("<html>page</html>", { headers: { "Set-Cookie": "A1=page-secret-value; Path=/" } });
      if (url === CRUMB) return new Response("crumb-secret-value");
      if (url.includes("/v8/finance/chart/")) {
        chartCrumb = new URL(url).searchParams.get("crumb") ?? "";
        return new Response(`edge too many ${"Z".repeat(250)}END`, {
          status: 429,
          headers: { "Retry-After": "4", "CF-Ray": "9f2dummy-NRT", "Set-Cookie": "A1=chart-cookie-secret" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { fetchChart, YahooRateLimitError } = await import("./client.js");

    const err = await fetchChart("^VIX", "5y").catch((error: unknown) => error);

    expect(err).toBeInstanceOf(YahooRateLimitError);
    expect(chartCrumb).toBe("crumb-secret-value");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toContain("Chart API HTTP エラー [^VIX]");
    expect(message).toContain("429");
    expect(message).toContain("edge too many");
    expect(message).not.toContain("crumb-secret-value");
    const lines = incidentLines(warn);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('stage="chart"');
    expect(lines[0]).toContain('symbol="^VIX"');
    expect(lines[0]).toContain('"cf-ray":"9f2dummy-NRT"');
    expect(lines[0]).toContain("edge too many");
    expect(lines[0]).not.toContain("END");
    for (const secret of ["crumb-secret-value", "page-secret-value", "chart-cookie-secret"]) {
      expect(lines[0]).not.toContain(secret);
    }
  });

  it("503 とプロキシ 429 では計測行を出さず、既存の本文付き例外のまま止める", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable upstream", { status: 503, headers: { "Retry-After": "8" } })));
    const { yahooFetchDirect, YahooRateLimitError } = await import("./client.js");
    const stopped = await yahooFetchDirect(CHART).catch((error: unknown) => error);
    expect(stopped).toBeInstanceOf(YahooRateLimitError);
    expect(stopped).toMatchObject({ status: 503, authStage: "auth-page" });
    expect(incidentLines(warn)).toEqual([]);

    vi.resetModules();
    process.env.YAHOO_PROXY_BASE = "https://proxy.test.invalid";
    process.env.CRON_SECRET = "test-only";
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"yahoo rate limited crumb=proxy-crumb-secret"}', {
      status: 429,
      headers: { "Retry-After": "7", "X-Kabulab-Yahoo-Status": "429", "Set-Cookie": "A1=proxy-cookie-secret" },
    })));
    const { fetchChart } = await import("./client.js");
    const proxied = await fetchChart("^VIX", "5y").catch((error: unknown) => error);
    expect(proxied).toBeInstanceOf(Error);
    const message = proxied instanceof Error ? proxied.message : String(proxied);
    expect(message).toContain("Chart API HTTP エラー [^VIX]");
    expect(message).toContain("429");
    expect(message).toContain("yahoo rate limited");
    expect(incidentLines(warn)).toEqual([]);
    expect(message).not.toContain("proxy-cookie-secret");
  });
});

describe("cooldown short-circuit の計測", () => {
  const SUMMARY = "https://query1.finance.yahoo.com/v10/finance/quoteSummary/7203.T?modules=financialData";
  const START = 1_790_727_043_000;
  const RETRY_AFTER_MS = 120_000;

  function requestUrl(input: RequestInfo | URL): string {
    return typeof input === "string" ? input : input.toString();
  }

  function cooldownLines(warn: { mock: { calls: unknown[][] } }): string[] {
    return incidentLines(warn).filter((line) => line.includes('branch="cooldown-short-circuit"'));
  }

  it("段階と記号は 429 計測と同じで、URL・crumb・Cookie は出さない", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logYahooCooldownShortCircuit(`${PAGE}?crumb=secret-crumb`, "^VIX", 1_500);
    logYahooCooldownShortCircuit(`${CRUMB}?crumb=secret-crumb`, "^VIX", 1_500);
    logYahooCooldownShortCircuit(`${CHART}&crumb=secret-crumb`, undefined, 1_500);
    logYahooCooldownShortCircuit(`${SUMMARY}&crumb=secret-crumb`, undefined, 1_500);

    const lines = incidentLines(warn);
    expect(lines).toEqual([
      `${YAHOO_429_DIAG_TAG} branch="cooldown-short-circuit" remainingMs=1500 stage="auth-page" symbol="^VIX"`,
      `${YAHOO_429_DIAG_TAG} branch="cooldown-short-circuit" remainingMs=1500 stage="auth-crumb" symbol="^VIX"`,
      `${YAHOO_429_DIAG_TAG} branch="cooldown-short-circuit" remainingMs=1500 stage="chart" symbol="^VIX"`,
      `${YAHOO_429_DIAG_TAG} branch="cooldown-short-circuit" remainingMs=1500 stage="quote-summary" symbol="7203.T"`,
    ]);
    for (const line of lines) {
      expect(line).not.toMatch(/\n/);
      expect(warn.mock.calls.every((call) => call.length === 1)).toBe(true);
      for (const secret of ["secret-crumb", "finance.yahoo.com", "query1", "query2", "range=", "modules=", "AAPL", "Cookie", "http"]) {
        expect(line).not.toContain(secret);
      }
    }
  });

  it("計測が投げても外へ出さない", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("diag boom crumb=diag-crumb-secret Cookie: A1=diag-cookie-secret");
    });
    expect(() => logYahooCooldownShortCircuit(`${CHART}&crumb=diag-crumb-secret`, "^VIX", 10)).not.toThrow();
  });

  it("待機中は1行だけ出し、保存済みのレート制限例外をそのまま投げる", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let now = START;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let chartCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === PAGE) return new Response("", { headers: { "Set-Cookie": "A1=page-secret-value; Path=/" } });
      if (url === CRUMB) return new Response("crumb-secret-value");
      if (url.includes("/v8/finance/chart/")) {
        chartCalls += 1;
        if (chartCalls === 1) {
          return new Response("edge too many", {
            status: 429,
            headers: { "Retry-After": "120", "Set-Cookie": "A1=chart-cookie-secret" },
          });
        }
        return new Response("ok-chart");
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { yahooFetchDirect, YahooRateLimitError } = await import("./client.js");
    const retryAtMs = START + RETRY_AFTER_MS;

    const first = await yahooFetchDirect(CHART);
    expect(first.status).toBe(429);
    expect(cooldownLines(warn)).toEqual([]);
    expect(incidentLines(warn)).toHaveLength(1);
    expect(incidentLines(warn)[0]).toContain('stage="chart"');
    expect(incidentLines(warn)[0]).toContain("status=429");

    warn.mockClear();
    now = START + 30_000;
    const stopped = await yahooFetchDirect(CHART).catch((error: unknown) => error);
    expect(stopped).toBeInstanceOf(YahooRateLimitError);
    expect(stopped).toMatchObject({
      status: 429,
      retryAfterMs: RETRY_AFTER_MS,
      retryAtMs,
      authStage: null,
    });
    expect(stopped).toBeInstanceOf(Error);
    expect((stopped as Error).message).toBe(`yahoo 429 (rate limited); retry-at-ms=${retryAtMs}`);
    expect((stopped as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls).toHaveLength(1);
    expect(warn.mock.calls[0]).toHaveLength(1);
    const line = incidentLines(warn)[0];
    expect(line).toBe(
      `${YAHOO_429_DIAG_TAG} branch="cooldown-short-circuit" remainingMs=90000 stage="chart" symbol="^VIX"`,
    );
    for (const secret of [
      "crumb-secret-value",
      "page-secret-value",
      "chart-cookie-secret",
      "query1.finance.yahoo.com",
      "range=",
      "interval=",
      "http",
      "Cookie",
    ]) {
      expect(line).not.toContain(secret);
    }

    warn.mockClear();
    now = START + 31_000;
    const again = await yahooFetchDirect(SUMMARY).catch((error: unknown) => error);
    expect(again).toBe(stopped);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(incidentLines(warn)).toEqual([
      `${YAHOO_429_DIAG_TAG} branch="cooldown-short-circuit" remainingMs=89000 stage="quote-summary" symbol="7203.T"`,
    ]);
    expect(incidentLines(warn)[0]).not.toContain("crumb-secret-value");
    expect(incidentLines(warn)[0]).not.toContain("financialData");

    warn.mockClear();
    now = retryAtMs;
    const recovered = await yahooFetchDirect(CHART);
    expect(recovered.status).toBe(200);
    expect(await recovered.text()).toBe("ok-chart");
    expect(chartCalls).toBe(2);
    expect(cooldownLines(warn)).toEqual([]);
    expect(incidentLines(warn)).toEqual([]);
  });

  it("待機中でなければ cooldown-short-circuit は出ない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === PAGE) return new Response("", { headers: { "Set-Cookie": "A1=page-secret-value; Path=/" } });
      if (url === CRUMB) return new Response("crumb-secret-value");
      if (url.includes("/v8/finance/chart/")) return new Response("ok-chart");
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { yahooFetchDirect } = await import("./client.js");

    const first = await yahooFetchDirect(CHART);
    const second = await yahooFetchDirect(CHART);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(cooldownLines(warn)).toEqual([]);
    expect(incidentLines(warn)).toEqual([]);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
  });

  it("計測が投げても待機中のレート制限例外は置き換わらない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let now = START;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === PAGE) return new Response("", { headers: { "Set-Cookie": "A1=page-secret-value; Path=/" } });
      if (url === CRUMB) return new Response("crumb-secret-value");
      if (url.includes("/v8/finance/chart/")) {
        return new Response("edge too many", {
          status: 429,
          headers: { "Retry-After": "120" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { yahooFetchDirect, YahooRateLimitError } = await import("./client.js");
    const retryAtMs = START + RETRY_AFTER_MS;

    expect((await yahooFetchDirect(CHART)).status).toBe(429);
    warn.mockImplementation(() => {
      throw new Error("diag boom crumb=diag-crumb-secret Cookie: A1=diag-cookie-secret");
    });
    now = START + 1_000;
    const stopped = await yahooFetchDirect(CHART).catch((error: unknown) => error);
    const repeated = await yahooFetchDirect(SUMMARY).catch((error: unknown) => error);

    expect(stopped).toBeInstanceOf(YahooRateLimitError);
    expect(repeated).toBe(stopped);
    expect((stopped as Error).message).toBe(`yahoo 429 (rate limited); retry-at-ms=${retryAtMs}`);
    expect(String(stopped)).not.toContain("diag boom");
    expect(String(stopped)).not.toContain("diag-crumb-secret");
    expect(String(stopped)).not.toContain("diag-cookie-secret");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
