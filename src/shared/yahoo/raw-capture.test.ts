import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchChart, fetchDaily, fetchBars5m, fetchQuoteSummary, fetchStockRawData, YahooRawTooLargeError, MAX_YAHOO_RAW_BYTES, type YahooRawCapture, type YahooChartRawCapture } from "./client.js";

/**
 * fetchChart の任意 raw-capture hook (onRaw) の検証。
 * プロキシ経路で fetch を stub して回す (client.test.ts と同じ方式)。
 * 未指定の通常呼出はバイト列に触れない (clone なし・挙動不変)。
 */

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

function useProxy() {
  process.env.YAHOO_PROXY_BASE = "https://kabulab.example.test";
  process.env.CRON_SECRET = "test-secret";
}

function chartJson() {
  return {
    chart: {
      result: [
        {
          meta: { symbol: "7203.T", regularMarketPrice: 101, previousClose: 99 },
          timestamp: [1757548800, 1757635200],
          indicators: {
            quote: [
              {
                open: [100, 101],
                high: [110, 111],
                low: [90, 91],
                close: [105, 106],
                volume: [1000, 2000],
              },
            ],
            adjclose: [{ adjclose: [104, 105] }],
          },
        },
      ],
      error: null,
    },
  };
}

describe("fetchChart onRaw hook", () => {
  it("指定時は HTTP 判定・parse より前の原文 bytes + status を渡す", async () => {
    useProxy();
    const body = JSON.stringify(chartJson());
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
    const seen: YahooChartRawCapture[] = [];
    const chart = await fetchChart("7203", "5y", {
      onRaw: (c) => {
        seen.push(c);
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.symbol).toBe("7203");
    expect(seen[0]?.status).toBe(200);
    expect(new TextDecoder().decode(seen[0]?.bytes)).toBe(body);
    // clone のため原本 response は消費されず、通常 parse も成立する。
    expect(chart.ohlcv).toHaveLength(2);
    expect(chart.ohlcv[1]?.close).toBe(106);
  });

  it("非 ok 応答でも capture してから従来どおり throw する", async () => {
    useProxy();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));
    const seen: YahooChartRawCapture[] = [];
    await expect(
      fetchChart("7203", "5y", {
        onRaw: (c) => {
          seen.push(c);
        },
      })
    ).rejects.toThrow(/Chart API HTTP エラー \[7203\]: 429/);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.status).toBe(429);
    expect(new TextDecoder().decode(seen[0]?.bytes)).toBe("rate limited");
  });

  it("未指定の通常呼出は hook なしで従来どおり取得する", async () => {
    useProxy();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(chartJson()), { status: 200 }));
    vi.stubGlobal("fetch", fetchFn);
    const chart = await fetchChart("7203", "5y");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(chart.ohlcv).toHaveLength(2);
  });
});

describe("fetchChart previousClose (explicit-only)", () => {
  // 保存済み actual raw (bounded 01:55Z capture の trim) の offline 再生。
  // meta.previousClose 欠損の 4/4 で previousClose は null になり、
  // chartPreviousClose / 日足終値での補完はしない。price は不変。
  // fixture は macro-canonical の共有 custody を参照する (複写しない)。
  it.each([
    ["^N225", "n225-20260930.json"],
    ["^GSPC", "gspc-20260930.json"],
    ["^VIX", "vix-20260930.json"],
    ["NIY=F", "niy-20260930.json"],
  ])("%s: previousClose null・price 不変", async (symbol, file) => {
    useProxy();
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const body = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../cron/__fixtures__/macro-canonical",
        file
      ),
      "utf8"
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
    const chart = await fetchChart(symbol, "1mo");
    expect(chart.previousClose).toBeNull();
    const meta = JSON.parse(body).chart.result[0].meta;
    expect(chart.price).toBe(meta.regularMarketPrice);
    expect(chart.ohlcv).toHaveLength(3);
  });

  it("meta.previousClose があるときはその値を返す (補完なし)", async () => {
    useProxy();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(chartJson()), { status: 200 }))
    );
    const chart = await fetchChart("7203", "5y");
    expect(chart.previousClose).toBe(99);
  });

  it("chartPreviousClose があっても補完しない (chain 削除の証明)", async () => {
    useProxy();
    const json = chartJson();
    delete (json.chart.result[0].meta as { previousClose?: number }).previousClose;
    (json.chart.result[0].meta as { chartPreviousClose?: number }).chartPreviousClose = 98;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(json), { status: 200 }))
    );
    const chart = await fetchChart("7203", "5y");
    expect(chart.previousClose).toBeNull();
  });
});


describe("共有Yahoo取得のraw custody", () => {
  it.each([
    ["Chart", (onRaw: (c: YahooRawCapture) => void) => fetchChart("7203", "5y", { onRaw })],
    ["QuoteSummary", (onRaw: (c: YahooRawCapture) => void) => fetchQuoteSummary("7203", { onRaw })],
    ["daily", (onRaw: (c: YahooRawCapture) => void) => fetchDaily("7203", "10y", { onRaw })],
    ["5m", (onRaw: (c: YahooRawCapture) => void) => fetchBars5m("7203", "5d", { onRaw })],
  ])("%s HTTP/parse失敗でも最終応答原文を先にcapture", async (_name, fetchRaw) => {
    useProxy();
    for (const status of [200, 503]) {
      const response = new Response("invalid JSON\nsource bytes", { status, headers: {
        "Content-Type": "text/plain", "X-Kabulab-Yahoo-Status": "503", "Set-Cookie": "private-secret",
      } });
      Object.defineProperty(response, "url", { value: "https://test.invalid/api?crumb=private-secret&symbol=7203" });
      vi.stubGlobal("fetch", vi.fn(async () => response));
      const seen: YahooRawCapture[] = [];
      await expect(fetchRaw((c) => { seen.push(c); })).rejects.toThrow();
      expect(seen).toHaveLength(1);
      expect(new TextDecoder().decode(seen[0].bytes)).toBe("invalid JSON\nsource bytes");
      expect(seen[0].status).toBe(status);
      expect(Number.isFinite(Date.parse(seen[0].receivedAt))).toBe(true);
      expect(seen[0].headers).toEqual({ contentType: "text/plain", upstreamStatus: "503" });
      expect(seen[0].url).not.toContain("private-secret");
      expect(seen[0].url).toContain("symbol=7203");
    }
  });

  it("proxy応答URL内のencoded crumbもmetadataのみ除去し、本文は保持", async () => {
    useProxy();
    const original = "crumb=原文内は保管する";
    const response = new Response(original, { status: 503 });
    Object.defineProperty(response, "url", { value: "https://test.invalid/proxy?url=https%3A%2F%2Fyahoo.invalid%2Fapi%3Fcrumb%3Dprivate-secret%26range%3D5y" });
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const seen: YahooRawCapture[] = [];
    await expect(fetchQuoteSummary("7203", { onRaw: (c) => { seen.push(c); } })).rejects.toThrow();
    expect(seen[0].url).not.toContain("private-secret");
    expect(new TextDecoder().decode(seen[0].bytes)).toBe(original);
  });

  it("片API失敗後も相方の取得/capture完了を待ち、追加GETしない", async () => {
    useProxy();
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const fetchFn = vi.fn(async (url: string) => {
      if (decodeURIComponent(url).includes("quoteSummary")) { await waiting; return new Response("summary body", { status: 503 }); }
      return new Response("chart body", { status: 503 });
    });
    vi.stubGlobal("fetch", fetchFn);
    const events: string[] = [];
    const result = fetchStockRawData("7203", "5y", {
      onChartRaw: () => { events.push("chart"); }, onSummaryRaw: () => { events.push("summary"); },
    }).catch((e) => { events.push("throw"); return e; });
    await vi.waitFor(() => expect(events).toEqual(["chart"]));
    release!();
    expect(await result).toBeInstanceOf(Error);
    expect(events).toEqual(["chart", "summary", "throw"]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("8MiB超過は切詰captureせずSTOP、相方parse失敗に隠れない", async () => {
    useProxy();
    const fetchFn = vi.fn(async (url: string) => new Response(decodeURIComponent(url).includes("quoteSummary")
      ? new Uint8Array(MAX_YAHOO_RAW_BYTES + 1) : "invalid chart JSON", { status: 200 }));
    vi.stubGlobal("fetch", fetchFn);
    const chartRaw = vi.fn(), summaryRaw = vi.fn();
    await expect(fetchStockRawData("7203", "5y", { onChartRaw: chartRaw, onSummaryRaw: summaryRaw }))
      .rejects.toBeInstanceOf(YahooRawTooLargeError);
    expect(chartRaw).toHaveBeenCalledTimes(1);
    expect(summaryRaw).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
