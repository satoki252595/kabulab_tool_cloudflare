import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type YahooClient = typeof import("./client.js");
let fetchBars5m: YahooClient["fetchBars5m"];
let fetchDaily: YahooClient["fetchDaily"];
let fetchYahooChartRaw: YahooClient["fetchYahooChartRaw"];
let YahooRateLimitError: YahooClient["YahooRateLimitError"];

/**
 * L-60 で services/vwap-analysis/lib/yahoo.ts から移動した取得系の検証。
 * 形状・JST 変換・丸め・エラー投げ分けは移動前と同一 (R2 の daily/intra 契約)。
 * プロキシ経路 (YAHOO_PROXY_BASE 設定時) で fetch を stub して回す。
 */

const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  // ケース内のcooldownは実装どおり保持し、別HTTPケースへ持ち越さない。
  vi.resetModules();
  ({ fetchBars5m, fetchDaily, fetchYahooChartRaw, YahooRateLimitError } = await import("./client.js"));
});

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
          meta: { symbol: "7203.T", range: "10y", regularMarketPrice: 105 },
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
  it("バー・分割・JST を旧実装どおり整形する (adj は持たない)", async () => {
    useProxy();
    stubChart(chartJson());
    const { bars, splits, proof } = await fetchDaily("7203.T");
    expect(bars).toHaveLength(2);
    // JST 変換 (ts + 9h の日付)
    expect(bars[0].date).toBe("2025-09-11");
    expect(bars[0]).toMatchObject({ o: 100, h: 110, l: 90, c: 105, v: 1000 });
    expect("adj" in bars[0]).toBe(false);
    expect(splits).toEqual([{ date: "2025-09-11", ratio: 2 }]);
    // proof 配管 (stub bytes 由来の実配線。市場値の主張ではない)。
    expect(proof.requestedRange).toBe("10y");
    expect(proof.symbol).toBe("7203.T");
    expect([proof.firstTs, proof.lastTs]).toEqual([1757548800, 1757635200]);
    expect(proof.splits).toEqual([{ date: "2025-09-11", ratio: 2 }]);
    expect(proof.rawSha).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isFinite(Date.parse(proof.observedAt))).toBe(true);
  });

  it("adj 欠落は OHLCV 採用を block しない (VWAP demotion。Sol 裁定の対象外)", async () => {
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
    // 0 本目は OHLCV 揃い → 採用 (adj なし)。1 本目は OHLCV null で脱落。
    const { bars } = await fetchDaily("7203.T");
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({ o: 100, h: 110, l: 90, c: 105, v: 1000 });
    expect("adj" in bars[0]).toBe(false);
  });

  it("result 欠落は空で返さず落とす。quote 欠落も落とす", async () => {
    useProxy();
    stubChart({ chart: { result: [] } });
    await expect(fetchDaily("7203.T")).rejects.toThrow(/result が単一ではありません/);

    stubChart(chartJson({ indicators: {} }));
    await expect(fetchDaily("7203.T")).rejects.toThrow(/quote がありません/);
  });

  it("真正 empty は timestamp 空配列 + 同長空 quote のみ", async () => {
    useProxy();
    stubChart(
      chartJson({
        timestamp: [],
        indicators: {
          quote: [{ open: [], high: [], low: [], close: [], volume: [] }],
          adjclose: [{ adjclose: [] }],
        },
      })
    );
    expect(await fetchDaily("7203.T")).toEqual({
      bars: [],
      splits: [],
      proof: {
        observedAt: expect.any(String),
        rawSha: expect.any(String),
        requestedRange: "10y",
        symbol: "7203.T",
        firstTs: null,
        lastTs: null,
        splits: [],
      },
    });
  });

  it("chart.error 併存は result があっても採用しない (値は出さない)", async () => {
    useProxy();
    stubChart({
      chart: {
        result: chartJson().chart.result,
        error: { code: "Not Found", description: "No data found for 7203.T" },
      },
    });
    const err = (await fetchDaily("7203.T").catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/chart\.error/);
    expect(err.message).toMatch(/keys=code,description/);
    expect(err.message).not.toContain("No data found");
  });

  it("応答 meta.symbol の欠落・不一致は採用しない", async () => {
    useProxy();
    stubChart(chartJson({ meta: { regularMarketPrice: 105 } }));
    await expect(fetchDaily("7203.T")).rejects.toThrow(/meta\.symbol がありません/);
    stubChart(chartJson({ meta: { symbol: "1909.T", regularMarketPrice: 105 } }));
    await expect(fetchDaily("7203.T")).rejects.toThrow(/要求=7203\.T 応答=1909\.T/);
  });

  it("{0: res} 形の未知 envelope は受けない", async () => {
    useProxy();
    stubChart({ chart: { result: { 0: chartJson().chart.result[0] } } });
    await expect(fetchDaily("7203.T")).rejects.toThrow(/result が単一ではありません/);
  });

  it("timestamp 非配列・非有限・非正・無効日付は落とす", async () => {
    useProxy();
    for (const ts of [null, "x", [1757548800, Number.NaN], [0], [-5], [1e30]]) {
      stubChart(chartJson({ timestamp: ts }));
      await expect(fetchDaily("7203.T")).rejects.toThrow(/timestamp|正当な時刻/);
    }
  });

  it("quote 長不一致 (truncated/stale) は malformed で落とす", async () => {
    useProxy();
    stubChart(
      chartJson({
        indicators: {
          quote: [{ open: [100], high: [110, 111], low: [90, 91], close: [105, 106], volume: [1000, 2000] }],
          adjclose: [{ adjclose: [104, 105] }],
        },
      })
    );
    await expect(fetchDaily("7203.T")).rejects.toThrow(/長さが timestamp と一致しません/);
    // timestamp [] + stale 非空 quote も真正 empty にしない。
    stubChart(
      chartJson({
        timestamp: [],
        indicators: {
          quote: [{ open: [100], high: [110], low: [90], close: [105], volume: [1000] }],
          adjclose: [{ adjclose: [] }],
        },
      })
    );
    await expect(fetchDaily("7203.T")).rejects.toThrow(/長さが timestamp と一致しません/);
  });

  it("全行 null は真正 empty にせず落とす (証拠付き)", async () => {
    useProxy();
    stubChart(
      chartJson({
        indicators: {
          quote: [{ open: [null, null], high: [null, null], low: [null, null], close: [null, null], volume: [null, null] }],
          adjclose: [{ adjclose: [null, null] }],
        },
      })
    );
    await expect(fetchDaily("7203.T")).rejects.toThrow(/全行欠落.*timestamps=2/);
  });

  it("splits 形状不正 (0 除算・非数) は落とす", async () => {
    useProxy();
    stubChart(
      chartJson({
        events: { splits: { "1": { date: 1757548800, numerator: 2, denominator: 0 } } },
      })
    );
    await expect(fetchDaily("7203.T")).rejects.toThrow(/splits 応答の形状が不正/);
  });

  it("splits ratio 非正・overflow・日付不正・非 object は落とす", async () => {
    useProxy();
    const cases: Array<[string, unknown]> = [
      ["zero-numerator", { splits: { "1": { date: 1757548800, numerator: 0, denominator: 1 } } }],
      ["negative-denominator", { splits: { "1": { date: 1757548800, numerator: 2, denominator: -1 } } }],
      ["negative-negative", { splits: { "1": { date: 1757548800, numerator: -2, denominator: -1 } } }],
      ["overflow-ratio", { splits: { "1": { date: 1757548800, numerator: 1e308, denominator: 1e-308 } } }],
      ["bad-event-date", { splits: { "1": { date: -5, numerator: 2, denominator: 1 } } }],
      ["splits-array", { splits: [{ date: 1757548800, numerator: 2, denominator: 1 }] }],
    ];
    for (const [name, events] of cases) {
      stubChart(chartJson({ events }));
      await expect(fetchDaily("7203.T"), name).rejects.toThrow(/splits/);
    }
    stubChart(chartJson({ events: "xx" }));
    await expect(fetchDaily("7203.T")).rejects.toThrow(/events 応答の形状が不正/);
    // 欠落 (null/undefined) は文書化された no-events として空扱い。
    stubChart(chartJson({ events: undefined }));
    expect((await fetchDaily("7203.T")).splits).toEqual([]);
  });

  /**
   * 最小合成 fixture。9/28 観測の 1909 応答の形だけを写す
   * (先頭から持続する異常水準・出来高 0・末尾 null・meta 正常)。
   * fetchChart と同じ guard が R2 daily 経路でも働くことを固定する。
   */
  function chart1909Shape() {
    const day = (s: string) => Date.parse(`${s}T00:00:00Z`) / 1000;
    const lv = [16280000512, 16280000512, 16280000512, null];
    return chartJson({
      meta: { symbol: "1909.T", range: "10y", regularMarketPrice: 3700 },
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
    });
  }

  function chartCoherent(over: {
    closes: (number | null)[];
    volumes: (number | null)[];
    metaPrice: number;
  }) {
    const day = (s: string) => Date.parse(`${s}T00:00:00Z`) / 1000;
    const dates = ["2026-09-24", "2026-09-25"].slice(0, over.closes.length);
    return chartJson({
      meta: { symbol: "7203.T", range: "10y", regularMarketPrice: over.metaPrice },
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
    });
  }

  it("1909 形の応答全体を拒否する (R2 daily 書込の手前で落とす)", async () => {
    useProxy();
    stubChart(chart1909Shape());
    await expect(fetchDaily("1909.T")).rejects.toThrow(/応答全体を採用しません/);
  });

  it("薄商い (出来高0・乖離なし) は受理する", async () => {
    useProxy();
    stubChart(
      chartCoherent({ closes: [1000, 1000], volumes: [10000, 0], metaPrice: 1000 })
    );
    const { bars } = await fetchDaily("7203.T");
    expect(bars).toHaveLength(2);
  });

  it("出来高を伴う急変 (正規分割) は受理する", async () => {
    useProxy();
    stubChart(
      chartCoherent({
        closes: [1000, 30000],
        volumes: [10000, 500000],
        metaPrice: 1000,
      })
    );
    const { bars } = await fetchDaily("7203.T");
    expect(bars).toHaveLength(2);
  });

  it("最新 close が負 (-5) の応答全体を拒否する (実数値の無効は欠落と別扱い)", async () => {
    useProxy();
    stubChart(
      chartCoherent({
        closes: [1000, -5],
        volumes: [10000, 500000],
        metaPrice: 1000,
      })
    );
    await expect(fetchDaily("7203.T")).rejects.toThrow(/応答全体を採用しません/);
  });

  it("null 出来高のバーは落とし、0 には化けない (missing≠実0)", async () => {
    useProxy();
    stubChart(
      chartCoherent({
        closes: [1000, 1001],
        volumes: [10000, null],
        metaPrice: 1000,
      })
    );
    const { bars } = await fetchDaily("7203.T");
    expect(bars).toHaveLength(1);
    expect(bars[0].v).toBe(10000);
  });

  it("非有限実値 (1e999→Infinity) は filter 前に拒否する", async () => {
    useProxy();
    const body = JSON.stringify(
      chartCoherent({ closes: [1000, 1001], volumes: [10000, 20000], metaPrice: 1000 })
    ).replace('"volume":[10000,20000]', '"volume":[10000,1e999]');
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 }))
    );
    await expect(fetchDaily("7203.T")).rejects.toThrow(/非有限/);
  });

  it("adjclose の非正は OHLCV 採用を block しない (VWAP demotion。7944 類型)", async () => {
    useProxy();
    stubChart(
      chartJson({
        meta: { symbol: "7203.T", range: "10y", regularMarketPrice: 105 },
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
          adjclose: [{ adjclose: [104, -2] }],
        },
      })
    );
    const { bars } = await fetchDaily("7203.T");
    expect(bars).toHaveLength(2);
    expect(bars.every((b) => !("adj" in b))).toBe(true);
  });

  it("adjclose の欠落は OHLCV 採用を block しない (VWAP demotion)", async () => {
    useProxy();
    stubChart(
      chartJson({
        meta: { symbol: "7203.T", range: "10y", regularMarketPrice: 105 },
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
          adjclose: [{ adjclose: [104, null] }],
        },
      })
    );
    const { bars } = await fetchDaily("7203.T");
    expect(bars).toHaveLength(2);
    expect(bars.every((b) => !("adj" in b))).toBe(true);
  });

  it("正規化 bar は OHLCV のみを持つ (adj 非保存・c 置換なし)", async () => {
    useProxy();
    stubChart(
      chartJson({
        meta: { symbol: "7203.T", range: "10y", regularMarketPrice: 105 },
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
          adjclose: [{ adjclose: [95, 96] }],
        },
      })
    );
    const { bars } = await fetchDaily("7203.T");
    expect(Object.keys(bars[0]).sort()).toEqual(["c", "date", "h", "l", "o", "v"]);
    expect(bars.map((b) => b.c)).toEqual([105, 106]);
  });
});

describe("fetchBars5m", () => {
  it("result 欠落・chart.error は空で返さず落とす", async () => {
    useProxy();
    stubChart({ chart: { result: [] } });
    await expect(fetchBars5m("7203.T")).rejects.toThrow(/result が単一ではありません/);
    stubChart({ chart: { result: chartJson().chart.result, error: { code: "x" } } });
    await expect(fetchBars5m("7203.T")).rejects.toThrow(/chart\.error/);
  });

  it("真正 empty は timestamp 空配列 + 同長空 quote のみ", async () => {
    useProxy();
    stubChart(
      chartJson({
        timestamp: [],
        indicators: {
          quote: [{ open: [], high: [], low: [], close: [], volume: [] }],
        },
      })
    );
    expect(await fetchBars5m("7203.T")).toEqual([]);
  });

  it("全行 null は真正 empty にせず落とす (証拠付き)", async () => {
    useProxy();
    stubChart(
      chartJson({
        indicators: {
          quote: [{ open: [null, null], high: [null, null], low: [null, null], close: [null, null], volume: [null, null] }],
        },
      })
    );
    await expect(fetchBars5m("7203.T")).rejects.toThrow(/全行欠落.*null脱落=2/);
  });

  it("quote 長不一致・timestamp 不正は malformed で落とす", async () => {
    useProxy();
    stubChart(
      chartJson({
        indicators: {
          quote: [{ open: [100], high: [110, 111], low: [90, 91], close: [105, 106], volume: [1000, 2000] }],
        },
      })
    );
    await expect(fetchBars5m("7203.T")).rejects.toThrow(/長さが timestamp と一致しません/);
    stubChart(chartJson({ timestamp: [1757548800, -1] }));
    await expect(fetchBars5m("7203.T")).rejects.toThrow(/正当な時刻/);
  });

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

  it("1909 形 (meta 乖離+出来高なし) は filter 前の raw 検査で応答全体を拒否する", async () => {
    useProxy();
    stubChart(
      chartJson({
        meta: {
          symbol: "1909.T",
          regularMarketPrice: 3700,
          regularMarketTime: 1757635260,
        },
        indicators: {
          quote: [
            {
              open: [16280000512, 16280000512],
              high: [16280000512, 16280000512],
              low: [16280000512, 16280000512],
              close: [16280000512, 16280000512],
              volume: [0, 0],
            },
          ],
        },
      })
    );
    // volume filter は無出来高異常を消すため、整合は未 filter の raw 最新で
    // 見る。meta 時刻が最新 interval 内 (同時点証明) + 乖離+出来高0 → 拒否。
    await expect(fetchBars5m("1909.T")).rejects.toThrow(
      /応答全体を採用しません/
    );
  });

  it("時刻根拠が未知 (meta 時刻欠落) なら誤比較せず明示 skip する", async () => {
    useProxy();
    stubChart(
      chartJson({
        meta: { symbol: "1909.T", regularMarketPrice: 3700 },
        indicators: {
          quote: [
            {
              open: [16280000512, 16280000512],
              high: [16280000512, 16280000512],
              low: [16280000512, 16280000512],
              close: [16280000512, 16280000512],
              volume: [0, 0],
            },
          ],
        },
      })
    );
    // 同時点が証明できないため比較しない。volume 0 行は filter で落ちる。
    const bars = await fetchBars5m("1909.T");
    expect(bars).toHaveLength(0);
  });

  it("出来高つき乖離は正規変動として受理する (daily と同一規則)", async () => {
    useProxy();
    stubChart(
      chartJson({
        meta: { symbol: "1909.T", regularMarketPrice: 3700 },
        indicators: {
          quote: [
            {
              open: [100, 101],
              high: [110, 111],
              low: [90, 91],
              close: [105, 370000],
              volume: [1000, 500000],
            },
          ],
        },
      })
    );
    // raw 最新 (370000 vs meta 3700、100倍乖離・出来高あり) → 出来高を
    // 伴う乖離は正規変動として受理する。
    const bars = await fetchBars5m("1909.T");
    expect(bars).toHaveLength(2);
  });

  it("非有限実値 (1e999→Infinity) は欠落ではなく異常として filter 前に拒否する", async () => {
    useProxy();
    // JSON は NaN を運べないため、範囲外指数の生テキストで stub する。
    const body = JSON.stringify(chartJson()).replace(
      '"volume":[1000,2000]',
      '"volume":[1000,1e999]'
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 }))
    );
    await expect(fetchBars5m("7203.T")).rejects.toThrow(/非有限/);
  });

  it("最新バーの終値が無効 (非正) なら応答全体を拒否する", async () => {
    useProxy();
    stubChart(
      chartJson({
        meta: { symbol: "7203.T", regularMarketPrice: 3000 },
        indicators: {
          quote: [
            {
              open: [100, 0],
              high: [110, 0],
              low: [90, 0],
              close: [105, 0],
              volume: [1000, 2000],
            },
          ],
        },
      })
    );
    // 0 終値は falsy ではなく null でもないため残り、guard が非正で拒否する。
    await expect(fetchBars5m("7203.T")).rejects.toThrow(
      /応答全体を採用しません/
    );
  });
});

describe("レート制限の投げ分け (旧 ensureOk と同一)", () => {
  it("429/503 は YahooRateLimitError (Retry-After 付き)", async () => {
    useProxy();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("slow down", { status: 429, headers: { "retry-after": "3" } }))
    );
    const before = Date.now();
    const err = await fetchDaily("7203.T").catch((e) => e);
    expect(err).toBeInstanceOf(YahooRateLimitError);
    expect(err.name).toBe("YahooRateLimitError");
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(3000);
    expect(err.retryAtMs).toBeGreaterThanOrEqual(before + 3000);
    expect(err.retryAtMs).toBeLessThanOrEqual(Date.now() + 3000);
  });
  it.each([429, 503])("HTTP-date Retry-Afterを%sの日足/5分足エラーへ保つ", async (status) => {
    useProxy();
    const retryAfter = new Date(Date.now() + 120_000).toUTCString();
    const fetchFn = vi.fn(async () => new Response("slow down", { status, headers: { "Retry-After": retryAfter } }));
    vi.stubGlobal("fetch", fetchFn);
    for (const fetchBars of [() => fetchDaily("7203.T"), () => fetchBars5m("7203.T")]) {
      // 2つの独立したHTTP-date契約を検証する。cooldown再入の検証ではない。
      vi.resetModules();
      ({ fetchBars5m, fetchDaily, fetchYahooChartRaw, YahooRateLimitError } = await import("./client.js"));
      const err = await fetchBars().catch((error) => error);
      expect(err).toBeInstanceOf(YahooRateLimitError);
      expect(err.retryAtMs).toBe(Date.parse(retryAfter));
    }
    expect(fetchFn).toHaveBeenCalledTimes(2);
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
