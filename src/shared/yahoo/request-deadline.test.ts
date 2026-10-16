import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 実spacingと実clientを通す。fetchだけ置換し、vendor通信は0。
vi.unmock("./request-spacing.js");
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000); vi.resetModules(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("request-local guardはnative発信直前、既開始本文は保持", () => {
  it("producer待機なしでも認証・401再認証・再GETの実開始を各1秒離す", async () => {
    vi.stubEnv("YAHOO_PROXY_BASE", ""); vi.stubEnv("CRON_SECRET", "");
    const starts: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      starts.push(Date.now());
      return starts.length === 1 || starts.length === 4
        ? new Response("auth page", { headers: { "set-cookie": "test-cookie=value" } })
        : starts.length === 2 || starts.length === 5 ? new Response("test-crumb")
        : new Response("protocol-only response", { status: starts.length === 3 ? 401 : 200 });
    }));
    const { yahooFetchDirect } = await import("./client.js");
    const response = yahooFetchDirect("https://query1.finance.yahoo.com/v8/finance/chart/7203.T");
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await response).status).toBe(200);
    expect(starts).toEqual([10_000, 11_000, 12_000, 13_000, 14_000, 15_000]);
  });
  it("既429/Retry-Afterの停止理由をguard例外で置き換えず再送0", async () => {
    vi.stubEnv("YAHOO_PROXY_BASE", "https://proxy.test.invalid"); vi.stubEnv("CRON_SECRET", "test-only");
    const native = vi.fn(async () => new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } }));
    vi.stubGlobal("fetch", native);
    const m = await import("./client.js");
    await m.fetchYahooChartRaw("^N225", "1mo", "1d");
    const beforeRequest = vi.fn(() => { throw new Error("completion deadline"); });
    await expect(m.fetchYahooChartRaw("^N225", "1mo", "1d", false, beforeRequest))
      .rejects.toMatchObject({ name: "YahooRateLimitError", retryAtMs: 70_000 });
    expect(native).toHaveBeenCalledTimes(1); expect(beforeRequest).not.toHaveBeenCalled();
  });
  it.each(["chart", "daily", "intra", "intra-window", "quote", "raw"])("%sのspacing待機で期限を越えたら発信/再試行/capture0", async (kind) => {
    vi.stubEnv("YAHOO_PROXY_BASE", "https://proxy.test.invalid"); vi.stubEnv("CRON_SECRET", "test-only");
    const native = vi.fn(async () => new Response("not-parsed-prior-response")); vi.stubGlobal("fetch", native);
    const m = await import("./client.js");
    await m.fetchYahooChartRaw("^N225", "1mo", "1d"); // 間隔を予約した先行要求
    const stopped = new Error("completion deadline");
    const beforeRequest = () => { if (Date.now() > 10_500) throw stopped; }, onRaw = vi.fn();
    const options = { beforeRequest, onRaw };
    const operation = kind === "chart" ? m.fetchChart("^N225", "1mo", options) :
      kind === "daily" ? m.fetchDaily("7203.T", "10y", options) :
      kind === "intra" ? m.fetchBars5m("7203.T", "5d", options) :
      kind === "intra-window" ? m.fetchBars5mWindow("7203.T", { period1: 1, period2: 9 }, options) :
      kind === "quote" ? m.fetchQuoteSummary("7203", options) :
      m.fetchYahooChartRaw("^N225", "1mo", "1d", false, beforeRequest);
    const result = operation.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toBe(stopped); expect(native).toHaveBeenCalledTimes(1); expect(onRaw).not.toHaveBeenCalled();
  });
  it.each([1, 2, 3])("認証stage%i応答後の期限超過は次auth/401再認証へ進まない", async (stopAfter) => {
    vi.stubEnv("YAHOO_PROXY_BASE", ""); vi.stubEnv("CRON_SECRET", "");
    let sent = 0;
    const native = vi.fn(async () => {
      sent++;
      if (sent === stopAfter) vi.setSystemTime(20_001);
      return sent === 1 ? new Response("auth page", { headers: { "set-cookie": "test-cookie=value" } }) :
        sent === 2 ? new Response("test-crumb") : new Response("unauthorized", { status: 401 });
    });
    vi.stubGlobal("fetch", native);
    const m = await import("./client.js"), stopped = new Error("completion deadline");
    const result = m.yahooFetchDirect("https://query1.finance.yahoo.com/v8/finance/chart/7203.T", () => {
      if (Date.now() > 20_000) throw stopped;
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await result).toBe(stopped); expect(native).toHaveBeenCalledTimes(stopAfter);
  });
  it("期限内に始まったHTTPは本文を原時計付きでcaptureし、受領後guardで破棄しない", async () => {
    vi.stubEnv("YAHOO_PROXY_BASE", "https://proxy.test.invalid"); vi.stubEnv("CRON_SECRET", "test-only");
    const body = new TextEncoder().encode("original failure response");
    vi.stubGlobal("fetch", vi.fn(async () => {
      vi.setSystemTime(20_001); return new Response(body, { status: 404 });
    }));
    const m = await import("./client.js"), onRaw = vi.fn();
    await expect(m.fetchDaily("7203.T", "10y", { onRaw, beforeRequest() {
      if (Date.now() > 20_000) throw new Error("completion deadline");
    } })).rejects.toThrow();
    expect(onRaw).toHaveBeenCalledTimes(1); expect(onRaw.mock.calls[0][0].bytes).toEqual(body);
    expect(onRaw.mock.calls[0][0].receivedAt).toBe(new Date(20_001).toISOString());
  });
});
