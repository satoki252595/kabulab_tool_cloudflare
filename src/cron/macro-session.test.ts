/**
 * selectConfirmedCloses のテスト。
 *
 * actual fixture (bounded capture trim) で確定日・形成中除外・HOLD を
 * 固定し、symbolic fixture + 最小 inline raw で session 境界・malformed
 * の HOLD 分岐を押さえる。bars 入力は本番と同じ共有 parse+guard
 * (parseChartResponse + guardChartBars) で作る。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseChartResponse } from "../shared/yahoo/client.js";
import { guardChartBars } from "../shared/yahoo/bar-sanity.js";
import type { DailyOhlcv } from "../shared/types.js";
import { selectConfirmedCloses } from "./macro-session.js";

const FX = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__/macro-canonical"
);
const fxBytes = (name: string): Uint8Array =>
  readFileSync(join(FX, name));

/** 本番と同じ bars 入力 (共有 parse + guard)。 */
function prodBars(symbol: string, raw: Uint8Array): DailyOhlcv[] {
  const json = JSON.parse(new TextDecoder().decode(raw));
  const parsed = parseChartResponse(json, symbol);
  const { bars } = guardChartBars(
    parsed.bars,
    parsed.meta.regularMarketPrice,
    symbol
  );
  return [...bars];
}

function closeOf(bars: DailyOhlcv[], date: string): number | null {
  return bars.find((b) => b.date === date)?.close ?? null;
}

describe("selectConfirmedCloses (actual)", () => {
  it.each([
    ["^N225", "n225-20260930.json"],
    ["^GSPC", "gspc-20260930.json"],
    ["^VIX", "vix-20260930.json"],
  ])("%s fresh raw は 9/29 確定 (形成中除外)", (symbol, file) => {
    const raw = fxBytes(file);
    const bars = prodBars(symbol, raw);
    const got = selectConfirmedCloses(raw, bars, symbol);
    expect(got.date).toBe("2026-09-29");
    expect(got.value).toBe(closeOf(bars, "2026-09-29"));
    expect(got.value).toBeGreaterThan(0);
    expect(got.prev).toBe(closeOf(bars, "2026-09-28"));
  });

  it("旧 N225 (9/28 候補 close NULL) は HOLD (9/25 代替なし)", () => {
    const raw = fxBytes("n225-20260929.json");
    const bars = prodBars("^N225", raw);
    expect(() => selectConfirmedCloses(raw, bars, "^N225")).toThrow(
      /確定日 2026-09-28 の実終値を証明できない/
    );
  });
});

describe("selectConfirmedCloses (symbolic 境界)", () => {
  it("09:10 形成中は直前実バー 9/29 が確定 (昨日決め打ちなし)", () => {
    const raw = fxBytes("n225-0910-forming.symbolic.json");
    const bars = prodBars("^N225", raw);
    const got = selectConfirmedCloses(raw, bars, "^N225");
    expect(got.date).toBe("2026-09-29");
    expect(got.value).toBe(closeOf(bars, "2026-09-29"));
    expect(got.prev).toBe(closeOf(bars, "2026-09-28"));
  });

  it("確定バー close null は HOLD (older 代替なし)", () => {
    const raw = fxBytes("gspc-nullclose.symbolic.json");
    const bars = prodBars("^GSPC", raw);
    expect(() => selectConfirmedCloses(raw, bars, "^GSPC")).toThrow(
      /確定日 2026-09-29 の実終値を証明できない/
    );
  });

  it.each([
    ["^N225", "n225-friday-stale.symbolic.json"],
    ["^VIX", "vix-friday-stale.symbolic.json"],
  ])("%s lastTs<start は 9/25 確定", (symbol, file) => {
    const raw = fxBytes(file);
    const bars = prodBars(symbol, raw);
    const got = selectConfirmedCloses(raw, bars, symbol);
    expect(got.date).toBe("2026-09-25");
    expect(got.value).toBe(closeOf(bars, "2026-09-25"));
  });
});

interface MinBar {
  ts: number;
  close: number | null;
}

/** 最小 inline raw (malformed 分岐用。正常系は上記 fixture が担う)。 */
function minRaw(args: {
  symbol?: unknown;
  granularity?: unknown;
  tz?: unknown;
  start?: unknown;
  end?: unknown;
  rmt?: unknown;
  bars: MinBar[];
  closes?: (number | null)[];
}): Uint8Array {
  const {
    symbol = "^N225",
    granularity = "1d",
    tz = "Asia/Tokyo",
    start = 1_790_726_400,
    end = 1_790_749_800,
    rmt = 1_790_732_425,
    bars,
    closes,
  } = args;
  const json = {
    chart: {
      result: [
        {
          meta: {
            symbol,
            dataGranularity: granularity,
            exchangeTimezoneName: tz,
            regularMarketTime: rmt,
            currentTradingPeriod: { regular: { start, end } },
          },
          timestamp: bars.map((b) => b.ts),
          indicators: {
            quote: [{ close: closes ?? bars.map((b) => b.close) }],
          },
        },
      ],
      error: null,
    },
  };
  return new TextEncoder().encode(JSON.stringify(json));
}

function minBars(bars: MinBar[]): DailyOhlcv[] {
  return bars.map((b) => ({
    date: new Date(b.ts * 1000).toISOString().split("T")[0],
    open: null,
    high: null,
    low: null,
    close: b.close,
    volume: null,
    adj: null,
  }));
}

// 9/29・9/30 09:00 JST の session-open ts (最小 raw 用)。
const T29 = 1_790_640_000;
const T30 = 1_790_726_400;

describe("selectConfirmedCloses (malformed HOLD)", () => {
  const okBars: MinBar[] = [
    { ts: T29, close: 100 },
    { ts: T30, close: 101 },
  ];

  it("最小正常形は 9/29 確定 (helper 自体の sanity)", () => {
    const raw = minRaw({ bars: okBars });
    const got = selectConfirmedCloses(raw, minBars(okBars), "^N225");
    expect(got.date).toBe("2026-09-29");
    expect(got.value).toBe(100);
    expect(got.prev).toBeNull();
  });

  it.each([
    ["symbol 不一致", { symbol: "^GSPC" }],
    ["granularity 非 1d", { granularity: "1wk" }],
    ["timestamp/close 長不一致", { closes: [100] }],
    ["timestamp 非単調", { bars: [{ ts: T30, close: 101 }, { ts: T29, close: 100 }] }],
    ["tz 欠損", { tz: null }],
    ["tz 不正", { tz: "Mars/Olympus" }],
    ["start 欠損", { start: null }],
    ["end 欠損", { end: null }],
    ["rmt 欠損", { rmt: null }],
    ["start>=end", { start: 1_790_749_800, end: 1_790_749_800 }],
    ["session 日跨ぎ", { start: 1_790_726_400, end: 1_790_726_400 + 86400 }],
    ["候補が rmt より新しい", { rmt: T29 - 1 }],
    ["形成中のみ (単独 bar)", { bars: [{ ts: T30, close: 101 }] }],
    ["原文が session より新しい", { bars: [{ ts: T29, close: 100 }, { ts: T30 + 86400, close: 102 }] }],
  ])("%s は HOLD", (_name, overrides) => {
    const bars = (overrides as { bars?: MinBar[] }).bars ?? okBars;
    const raw = minRaw({ ...overrides, bars });
    expect(() => selectConfirmedCloses(raw, minBars(bars), "^N225")).toThrow(
      /マクロ HOLD/
    );
  });

  it("原文 JSON 破損は HOLD", () => {
    const raw = new TextEncoder().encode("{broken");
    expect(() => selectConfirmedCloses(raw, [], "^N225")).toThrow(/原文 JSON/);
  });
});

describe("selectConfirmedCloses (session 重複・guard 証明)", () => {
  it("同 session day 重複 (形成中) でも prior unique なら 9/29 採用 ([-2] 禁止の証明)", () => {
    const bars: MinBar[] = [
      { ts: T29, close: 100 },
      { ts: T30, close: 101 },
      { ts: T30 + 60, close: 102 },
    ];
    const raw = minRaw({ bars });
    const got = selectConfirmedCloses(raw, minBars(bars), "^N225");
    expect(got.date).toBe("2026-09-29");
    expect(got.value).toBe(100);
  });

  it("同 session 終了証明ありは当 session 最新バーが確定", () => {
    const bars: MinBar[] = [
      { ts: T29, close: 100 },
      { ts: T30, close: 101 },
    ];
    // rmt が当 session 日かつ end 以降 → 終了。
    const raw = minRaw({ bars, rmt: 1_790_749_800 + 60 });
    const got = selectConfirmedCloses(raw, minBars(bars), "^N225");
    expect(got.date).toBe("2026-09-30");
    expect(got.value).toBe(101);
    expect(got.prev).toBe(100);
  });

  it("guard 除去 (候補日なし) は HOLD", () => {
    const raw = minRaw({ bars: [{ ts: T29, close: 100 }, { ts: T30, close: 101 }] });
    const bars = minBars([{ ts: T30, close: 101 }]);
    expect(() => selectConfirmedCloses(raw, bars, "^N225")).toThrow(/実終値を証明できない/);
  });

  it("guard 重複 (候補日 2 件) は HOLD", () => {
    const raw = minRaw({ bars: [{ ts: T29, close: 100 }, { ts: T30, close: 101 }] });
    const one = minBars([{ ts: T29, close: 100 }])[0];
    const bars = [one, { ...one }, ...minBars([{ ts: T30, close: 101 }])];
    expect(() => selectConfirmedCloses(raw, bars, "^N225")).toThrow(/実終値を証明できない/);
  });

  it("raw/guard close 不一致は HOLD", () => {
    const raw = minRaw({ bars: [{ ts: T29, close: 100 }, { ts: T30, close: 101 }] });
    const bars = minBars([
      { ts: T29, close: 999 },
      { ts: T30, close: 101 },
    ]);
    expect(() => selectConfirmedCloses(raw, bars, "^N225")).toThrow(/実終値を証明できない/);
  });

  it("raw close 非正は HOLD", () => {
    const bars: MinBar[] = [
      { ts: T29, close: 0 },
      { ts: T30, close: 101 },
    ];
    const raw = minRaw({ bars });
    expect(() => selectConfirmedCloses(raw, minBars(bars), "^N225")).toThrow(
      /実終値を証明できない/
    );
  });

  it("直前 idx close null は prev explicit null (older 代替なし)", () => {
    const bars: MinBar[] = [
      { ts: T29 - 86400, close: 99 },
      { ts: T29, close: null },
      { ts: T30, close: 101 },
    ];
    // session 終了形にして 9/30 を確定させ、直前 9/29 null を踏む。
    const raw = minRaw({ bars, rmt: 1_790_749_800 + 60 });
    const got = selectConfirmedCloses(raw, minBars(bars), "^N225");
    expect(got.date).toBe("2026-09-30");
    expect(got.prev).toBeNull();
  });

  it("直前 day 自体が無ければ prev null", () => {
    const bars: MinBar[] = [{ ts: T29, close: 100 }];
    const raw = minRaw({
      bars,
      start: T29,
      end: T29 + 23400,
      rmt: T29 + 23400 + 60,
    });
    const got = selectConfirmedCloses(raw, minBars(bars), "^N225");
    expect(got.date).toBe("2026-09-29");
    expect(got.value).toBe(100);
    expect(got.prev).toBeNull();
  });
});
