import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchBars5m,
  fetchDaily,
  fetchYahooChartRaw,
  YahooRateLimitError,
} from "./client.js";

/**
 * L-60 で services/vwap-analysis/lib/yahoo.ts から移動した取得系の検証。
 * 形状・JST 変換・丸め・エラー投げ分けは移動前と同一 (R2 の daily/intra 契約)。
 * プロキシ経路 (YAHOO_PROXY_BASE 設定時) で fetch を stub して回す。
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

function chartJson(over: Record<string, unknown> = {}) {
  return {
    chart: {
      result: [
        {
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
          events: {
            splits: {
              "1757548800": { date: 1757548800, numerator: 2, denominator: 1 },
            },
          },
          ...over,
        },
      ],
    },
  };
}

function stubChart(json: unknown, init?: ResponseInit) {
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      seen.push(String(url));
      return new Response(JSON.stringify(json), {
        status: 200,
        headers: { "Content-Type": "application/json" },
        ...init,
      });
    })
  );
  return seen;
}

describe("fetchYahooChartRaw", () => {
  it("プロキシ設定時は /api/ingest/yahoo?u= に委譲する", async () => {
    useProxy();
    const seen = stubChart(chartJson());
    const r = await fetchYahooChartRaw("7203.T", "5d", "5m", false);
    expect(r.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("/api/ingest/yahoo?u=");
    expect(seen[0]).toContain(encodeURIComponent("7203.T"));
    expect(seen[0]).not.toContain("ingest-fetch");
  });

  it("events=true で分割/配当イベントを要求する", async () => {
    useProxy();
    const seen = stubChart(chartJson());
    await fetchYahooChartRaw("7203.T", "10y", "1d", true);
    expect(seen[0]).toContain("events");
  });
});

describe("fetchDaily", () => {
  it("バー・分割・JST・adj を旧実装どおり整形する", async () => {
    useProxy();
    stubChart(chartJson());
    const { bars, splits } = await fetchDaily("7203.T");
    expect(bars).toHaveLength(2);
    // JST 変換 (ts + 9h の日付)
    expect(bars[0].date).toBe("2025-09-11");
    expect(bars[0]).toMatchObject({ o: 100, h: 110, l: 90, c: 105, v: 1000 });
    expect(bars[0].adj).toBe(104);
    expect(splits).toEqual([{ date: "2025-09-11", ratio: 2 }]);
  });

  it("adj 欠落は close で補い、OHLC 欠損バーは落とす", async () => {
    useProxy();
    stubChart(
      chartJson({
        indicators: {
          quote: [
            {
              open: [100, null],
              high: [110, null],
              low: [90, null],
              close: [105, null],
              volume: [1000, 0],
            },
          ],
          adjclose: [{ adjclose: [null, null] }],
        },
      })
    );
    const { bars } = await fetchDaily("7203.T");
    expect(bars).toHaveLength(1);
    expect(bars[0].adj).toBe(105);
  });

  it("result 欠落は空で返し、quote 欠落は落とす", async () => {
    useProxy();
    stubChart({ chart: { result: [] } });
    expect(await fetchDaily("7203.T")).toEqual({ bars: [], splits: [] });

    stubChart(chartJson({ indicators: {} }));
    await expect(fetchDaily("7203.T")).rejects.toThrow(/quote がありません/);
  });
});

describe("fetchBars5m", () => {
  it("正準形に整形し時系列昇順にする", async () => {
    useProxy();
    stubChart(chartJson());
    const bars = await fetchBars5m("7203.T");
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({
      ts: 1757548800,
      o: 100,
      h: 110,
      l: 90,
      c: 105,
      v: 1000,
    });
    expect(bars[0].ts).toBeLessThan(bars[1].ts);
  });

  it("出来高 0 のバーは落とす", async () => {
    useProxy();
    stubChart(
      chartJson({
        indicators: {
          quote: [
            {
              open: [100, 101],
              high: [110, 111],
              low: [90, 91],
              close: [105, 106],
              volume: [0, 2000],
            },
          ],
        },
      })
    );
    const bars = await fetchBars5m("7203.T");
    expect(bars.map((b) => b.ts)).toEqual([1757635200]);
  });
});

describe("レート制限の投げ分け (旧 ensureOk と同一)", () => {
  it("429/503 は YahooRateLimitError (Retry-After 付き)", async () => {
    useProxy();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("slow down", { status: 429, headers: { "retry-after": "3" } }))
    );
    const err = await fetchDaily("7203.T").catch((e) => e);
    expect(err).toBeInstanceOf(YahooRateLimitError);
    expect(err.name).toBe("YahooRateLimitError");
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(3000);
  });

  it("404 は `yahoo 404` の Error (retry が即 throw する形状)", async () => {
    useProxy();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 }))
    );
    const err = await fetchDaily("7203.T").catch((e) => e);
    expect(err).not.toBeInstanceOf(YahooRateLimitError);
    expect((err as Error).message).toBe("yahoo 404");
  });
});
