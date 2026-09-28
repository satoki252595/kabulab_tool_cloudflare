import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchChart, yahooHttpErrorMessage } from "./client.js";

const ORIGINAL_PROXY_BASE = process.env.YAHOO_PROXY_BASE;
const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (ORIGINAL_PROXY_BASE === undefined) {
    delete process.env.YAHOO_PROXY_BASE;
  } else {
    process.env.YAHOO_PROXY_BASE = ORIGINAL_PROXY_BASE;
  }
  if (ORIGINAL_CRON_SECRET === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
  }
});

describe("yahooHttpErrorMessage", () => {
  it("429のRetry-Afterを有界な再試行時刻として記録する", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T00:00:00.000Z"));
    const response = new Response("rate limited", {
      status: 429,
      statusText: "Too Many Requests",
      headers: { "Retry-After": "2" },
    });

    const message = await yahooHttpErrorMessage("Yahoo HTTP エラー", response);

    expect(message).toContain(`retry-at-ms=${Date.now() + 2_000}`);
  });

  it.each(["0.5", "-1"])(
    "不正な数値形式のRetry-After=%sは既定の待機時間にする",
    async (retryAfter) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-27T00:00:00.000Z"));
      const response = new Response("rate limited", {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "Retry-After": retryAfter },
      });

      const message = await yahooHttpErrorMessage("Yahoo HTTP エラー", response);

      expect(message).toContain(`retry-at-ms=${Date.now() + 5_000}`);
    }
  );

  it("Yahoo upstreamの本文先頭だけを秘密値なしで記録する", async () => {
    process.env.YAHOO_PROXY_BASE = "https://kabulab.example.test";
    const response = new Response(
      `url=https://query1.finance.yahoo.com/?crumb=secret-crumb\n` +
        `Authorization: Bearer secret-token\n` +
        `Cookie: A1=secret-cookie\n${"x".repeat(400)} END`,
      {
        status: 502,
        statusText: "Bad Gateway",
        headers: {
          "CF-Ray": "not-grouped-for-upstream",
          "X-Kabulab-Yahoo-Status": "502",
        },
      }
    );

    const message = await yahooHttpErrorMessage("Yahoo HTTP エラー", response);

    expect(message).toContain("502 Bad Gateway");
    expect(message).toContain("source=yahoo-upstream");
    expect(message).toContain("yahoo-status=502");
    expect(message).toContain("crumb=[redacted]");
    expect(message).toContain("Bearer [redacted]");
    expect(message).toContain("Cookie: [redacted]");
    expect(message).not.toContain("secret-crumb");
    expect(message).not.toContain("secret-token");
    expect(message).not.toContain("secret-cookie");
    expect(message).not.toContain("not-grouped-for-upstream");
    expect(message).not.toContain("END");
  });

  it("markerのない500を取込プロキシ内部障害としてCF-Ray付きで記録する", async () => {
    process.env.YAHOO_PROXY_BASE = "https://kabulab.example.test";
    const response = new Response("worker internal error", {
      status: 500,
      statusText: "Internal Server Error",
      headers: { "CF-Ray": "abc123-NRT" },
    });

    const message = await yahooHttpErrorMessage("Yahoo HTTP エラー", response);

    expect(message).toContain("source=ingest-proxy");
    expect(message).toContain("cf-ray=abc123-NRT");
    expect(message).toContain('body="worker internal error"');
  });
});

describe("fetchChart — 応答整合 guard (F-01 1909 再発防止)", () => {
  /**
   * 最小合成 fixture。9/28 観測の 1909 応答の形だけを写す
   * (先頭から持続する異常水準 1.6e10・出来高 0・末尾 null・meta 正常)。
   * 原本 JSON そのものは commit しない (全生データの持込禁止)。
   */
  function chart1909Shape() {
    const day = (s: string) => Date.parse(`${s}T00:00:00Z`) / 1000;
    const lv = [16280000512, 16280000512, 16280000512, null];
    return {
      chart: {
        result: [
          {
            meta: {
              symbol: "1909.T",
              regularMarketPrice: 3700,
              chartPreviousClose: 16234051600,
              currency: "JPY",
            },
            timestamp: [
              day("2026-09-10"),
              day("2026-09-11"),
              day("2026-09-14"),
              day("2026-09-15"),
            ],
            indicators: {
              quote: [
                {
                  open: [...lv],
                  high: [...lv],
                  low: [...lv],
                  close: [...lv],
                  volume: [0, 0, 0, null],
                },
              ],
              adjclose: [{ adjclose: [...lv] }],
            },
            events: {
              splits: {
                "1789344000": {
                  date: 1789344000,
                  numerator: 1,
                  denominator: 4400000,
                },
              },
            },
          },
        ],
        error: null,
      },
    };
  }

  function chartNormal(over: {
    closes: (number | null)[];
    volumes: (number | null)[];
    metaPrice: number;
  }) {
    const day = (s: string) => Date.parse(`${s}T00:00:00Z`) / 1000;
    const dates = ["2026-09-24", "2026-09-25"].slice(0, over.closes.length);
    return {
      chart: {
        result: [
          {
            meta: {
              symbol: "7203.T",
              regularMarketPrice: over.metaPrice,
              currency: "JPY",
            },
            timestamp: dates.map(day),
            indicators: {
              quote: [
                {
                  open: [...over.closes],
                  high: [...over.closes],
                  low: [...over.closes],
                  close: [...over.closes],
                  volume: [...over.volumes],
                },
              ],
              adjclose: [{ adjclose: [...over.closes] }],
            },
          },
        ],
        error: null,
      },
    };
  }

  function useProxyStub(json: unknown) {
    process.env.YAHOO_PROXY_BASE = "https://kabulab.example.test";
    process.env.CRON_SECRET = "test-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(json), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
    );
  }

  it("1909 形の応答全体を拒否する (sanitize 素通り後の最終境界)", async () => {
    useProxyStub(chart1909Shape());
    await expect(fetchChart("1909", "5y")).rejects.toThrow(
      /応答全体を採用しません/
    );
  });

  it("薄商い (出来高0・乖離なし) は受理する", async () => {
    useProxyStub(
      chartNormal({ closes: [1000, 1000], volumes: [10000, 0], metaPrice: 1000 })
    );
    const res = await fetchChart("3600", "5y");
    expect(res.ohlcv).toHaveLength(2);
  });

  it("出来高を伴う急変 (正規分割) は受理する", async () => {
    useProxyStub(
      chartNormal({
        closes: [1000, 30000],
        volumes: [10000, 500000],
        metaPrice: 1000,
      })
    );
    const res = await fetchChart("7203", "5y");
    expect(res.ohlcv).toHaveLength(2);
  });
});
