import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchChart, fetchQuoteSummary, yahooHttpErrorMessage } from "./client.js";

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

describe("fetchQuoteSummary — 株数の尺度 guard (F-15)", () => {
  // 9/28 観測原本の必要な数値だけ。全生 JSON・銘柄別の補正値は持ち込まない。
  const observed = [
    {
      code: "1909", shares: 6, float: null,
      cash: 11077999616, cashPerShare: 413.132,
      revenue: 60949000192, revenuePerShare: 2273.075,
      eps: 846560000, per: 4.3706295e-6, cap: 22200,
      bps: 1203.929, pbr: 3.073271, roe: 0.16937, roa: 0.10295,
      margin: 0.15317, dividend: 0.0061000003,
      annualEnd: 1774915200, annualRevenue: 60518000000, annualYear: 2026,
    },
    {
      code: "2180", shares: 10, float: null,
      cash: 3905999872, cashPerShare: 263.717,
      revenue: 26229000192, revenuePerShare: 1777.867,
      eps: -36968876, per: null, cap: 13090,
      bps: 252.577, pbr: 5.182578, roe: -0.08184, roa: 0.13363,
      margin: -0.028859999, dividend: 0.0199,
      annualEnd: 1751241600, annualRevenue: 19587000000, annualYear: 2025,
    },
    {
      code: "7426", shares: 2, float: 152510,
      cash: 661000000, cashPerShare: 595.164,
      revenue: 3988000000, revenuePerShare: 3592.971,
      eps: -140379024, per: null, cap: 1182,
      bps: 1549.586, pbr: 0.38139218, roe: null, roa: null,
      margin: -0.14673, dividend: 0.060599998,
      annualEnd: 1774915200, annualRevenue: 4102000000, annualYear: 2026,
    },
    {
      code: "3853", shares: 16985943, float: 12446789,
      cash: 3395898880, cashPerShare: 199.924,
      revenue: 3442726912, revenuePerShare: 206.868,
      eps: 48.11, per: 22.739555, cap: 18582622208,
      bps: 557.144, pbr: 1.9635857, roe: 0.31483, roa: 0.16213,
      margin: 2.9758801, dividend: 0.009,
      annualEnd: 1774915200, annualRevenue: 3389000000, annualYear: 2026,
    },
  ];

  function summaryShape(row: (typeof observed)[number]) {
    const raw = (value: number | null) => value === null ? null : { raw: value };
    return {
      quoteSummary: {
        result: [{
          defaultKeyStatistics: {
            sharesOutstanding: raw(row.shares), floatShares: raw(row.float),
            trailingEps: raw(row.eps), bookValue: raw(row.bps), priceToBook: raw(row.pbr),
          },
          financialData: {
            totalCash: raw(row.cash), totalCashPerShare: raw(row.cashPerShare),
            totalRevenue: raw(row.revenue), revenuePerShare: raw(row.revenuePerShare),
            returnOnEquity: raw(row.roe), returnOnAssets: raw(row.roa),
            operatingMargins: raw(row.margin),
          },
          summaryDetail: {
            trailingPE: raw(row.per), marketCap: raw(row.cap), dividendYield: raw(row.dividend),
          },
          incomeStatementHistory: { incomeStatementHistory: [{
            endDate: raw(row.annualEnd), totalRevenue: raw(row.annualRevenue),
          }] },
        }],
        error: null,
      },
    };
  }

  async function readSummary(json: unknown, code: string) {
    process.env.YAHOO_PROXY_BASE = "https://kabulab.example.test";
    process.env.CRON_SECRET = "test-secret";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(json), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    return fetchQuoteSummary(code);
  }

  it.each(observed)("$code: EPS/PER/時価総額だけを検証し、他の原数値を保持する", async (row) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await readSummary(summaryShape(row), row.code);
      const rejected = row.code !== "3853";
      expect(result).toEqual({
        eps: rejected ? null : row.eps,
        per: rejected ? null : row.per,
        marketCap: rejected ? null : row.cap,
        bps: row.bps, pbr: row.pbr, roe: row.roe, roa: row.roa,
        operatingMarginTtm: row.margin,
        dividendYield: Math.round(row.dividend * 10000) / 100,
        annualFinancials: [{ fiscalYear: row.annualYear, revenue: row.annualRevenue }],
      });
      expect(warn).toHaveBeenCalledTimes(rejected ? 1 : 0);
      if (rejected) expect(warn).toHaveBeenCalledWith(expect.stringContaining("株数の尺度"));
    } finally {
      warn.mockRestore();
    }
  });

  it.each(["株数欠損", "株数0", "分母欠損", "分母0", "分母非finite", "分母不一致"])(
    "%s: 2つの正finiteな独立分母で裏づけられなければ推定補正・拒否しない",
    async (kind) => {
      const row = observed[0];
      const json = summaryShape(row);
      const item = json.quoteSummary.result[0];
      if (kind === "株数欠損") item.defaultKeyStatistics.sharesOutstanding = null;
      if (kind === "株数0") item.defaultKeyStatistics.sharesOutstanding = { raw: 0 };
      if (kind === "分母欠損") item.financialData.totalCashPerShare = null;
      if (kind === "分母0") item.financialData.totalCashPerShare = { raw: 0 };
      if (kind === "分母非finite") {
        // raw文字列の既存coerce契約でも非finiteを証拠にしない。
        Object.assign(item.financialData, { totalCashPerShare: { raw: "Infinity" } });
      }
      if (kind === "分母不一致") item.financialData.totalCashPerShare = { raw: 413132000 };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = await readSummary(json, row.code);
        expect({ eps: result.eps, per: result.per, cap: result.marketCap })
          .toEqual({ eps: row.eps, per: row.per, cap: row.cap });
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    }
  );

  it("原本の浮動株数>発行株数は、独立分母が欠損でも3項目を採用しない", async () => {
    const row = observed[2];
    const json = summaryShape(row);
    json.quoteSummary.result[0].financialData.totalCashPerShare = null;
    json.quoteSummary.result[0].financialData.revenuePerShare = null;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await readSummary(json, row.code);
      expect({ eps: result.eps, per: result.per, cap: result.marketCap })
        .toEqual({ eps: null, per: null, cap: null });
      expect(result.bps).toBe(row.bps);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
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

describe("proxy 429 → Node recovery contract", () => {
  it("proxy 429 + Retry-After は retry-at-ms 付き transient message になる", async () => {
    process.env.YAHOO_PROXY_BASE = "https://kabulab.example.test";
    process.env.CRON_SECRET = "test-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('{"error":"yahoo rate limited"}', {
            status: 429,
            headers: {
              "Retry-After": "7",
              "X-Kabulab-Yahoo-Status": "429",
            },
          })
      )
    );
    const before = Date.now();
    const err = await fetchChart("^N225", "1mo").catch((e: unknown) => e);
    const message = err instanceof Error ? err.message : String(err);
    // 既存 recovery が parse する retry-at-ms を運ぶ。
    const retryAt = Number(/\bretry-at-ms=(\d+)\b/.exec(message)?.[1]);
    expect(retryAt).toBeGreaterThanOrEqual(before);
    expect(retryAt).toBeLessThanOrEqual(Date.now() + 7_000);
    const { isTransientDailySyncFailure } = await import("../../cron/daily.js");
    expect(isTransientDailySyncFailure(message)).toBe(true);
    expect(message).not.toContain("A1=");
  });
});
