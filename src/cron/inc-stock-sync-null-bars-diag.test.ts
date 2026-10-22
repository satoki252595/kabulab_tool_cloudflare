/**
 * INC-20261014 実日足未取得ログ。追加取得はせず、例外文は変えない。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildStockSnapshot } from "./daily.js";
import {
  INC_NULL_BARS_TAG,
  describeNullBarsFailure,
  finishNullBarsSummaryLine,
  logFreshCloseNullBars,
  startNullBarsRun,
  type NullBarsFailureInput,
} from "./inc-stock-sync-null-bars-diag.js";
import type { YahooRawCapture } from "../shared/yahoo/client.js";
import type { StockRawData } from "../shared/types.js";

const TARGET = "2026-10-14";
const SECRET = "SUPERSECRET-crumb-value";

function sec(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

function chartBytes(input: {
  rmt: number;
  timestamps: number[];
  open: (number | null)[];
  high: (number | null)[];
  low: (number | null)[];
  close: (number | null)[];
  volume: (number | null)[];
}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    chart: {
      result: [{
        meta: {
          symbol: "7203.T",
          regularMarketTime: input.rmt,
          longName: SECRET,
          currentTradingPeriod: { regular: { start: input.rmt - 3600, end: input.rmt } },
        },
        timestamp: input.timestamps,
        indicators: {
          quote: [{
            open: input.open,
            high: input.high,
            low: input.low,
            close: input.close,
            volume: input.volume,
          }],
        },
      }],
      error: null,
    },
  }));
}

function input(partial: Partial<NullBarsFailureInput> & Pick<NullBarsFailureInput, "bytes">): NullBarsFailureInput {
  return {
    code: "7203",
    expectedDate: TARGET,
    bars: [],
    headers: { age: "18", cfCacheStatus: "HIT" },
    ...partial,
  };
}

afterEach(() => {
  finishNullBarsSummaryLine();
});

describe("describeNullBarsFailure", () => {
  it("対象日バーが全 null のとき OHLC・出来高・JST 時刻・cache header を1行にする", () => {
    const timestamps = [sec("2026-10-10T00:00:00Z"), sec("2026-10-13T00:00:00Z"), sec("2026-10-14T00:00:00Z")];
    const described = describeNullBarsFailure(input({
      bytes: chartBytes({
        rmt: sec("2026-10-14T06:00:01Z"),
        timestamps,
        open: [10, 11, null],
        high: [12, 13, null],
        low: [8, 9, null],
        close: [11, 12, null],
        volume: [100, 200, null],
      }),
    }));
    expect(described.categories).toEqual({
      fullyNull: true, closeOnlyNull: false, absent: false, tradeBefore: false,
    });
    expect(described.line).toBe(
      `${INC_NULL_BARS_TAG} 7203 rmt=2026-10-14T15:00:01+09:00 rmtDay=on o=N h=N l=N c=N v=nil n=3 ` +
      "tail=2026-10-10T09:00,2026-10-13T09:00,2026-10-14T09:00 prev=V age=18 cf=HIT src=raw",
    );
    expect(described.line).not.toContain(SECRET);
    expect(described.line).not.toMatch(/https?:/);
    expect(described.line.length).toBeLessThan(280);
  });

  it("終値だけ null のバーは close-only で、前日終値が null なら prev=N", () => {
    const described = describeNullBarsFailure(input({
      bytes: chartBytes({
        rmt: sec("2026-10-14T06:00:00Z"),
        timestamps: [sec("2026-10-13T00:00:00Z"), sec("2026-10-14T00:00:00Z")],
        open: [null, 10],
        high: [null, 11],
        low: [null, 9],
        close: [null, null],
        volume: [null, 50],
      }),
    }));
    expect(described.categories.closeOnlyNull).toBe(true);
    expect(described.categories.fullyNull).toBe(false);
    expect(described.line).toContain("rmtDay=on o=V h=V l=V c=N v=50");
    expect(described.line).toContain("prev=N");
  });

  it("対象日の timestamp が無く最終約定が前日なら absent と tradeBefore", () => {
    const described = describeNullBarsFailure(input({
      headers: {},
      bytes: chartBytes({
        rmt: sec("2026-10-13T06:30:00Z"),
        timestamps: [sec("2026-10-10T00:00:00Z"), sec("2026-10-13T00:00:00Z")],
        open: [1, 2],
        high: [1, 2],
        low: [1, 2],
        close: [1, null],
        volume: [1, 0],
      }),
    }));
    expect(described.categories).toEqual({
      fullyNull: false, closeOnlyNull: false, absent: true, tradeBefore: true,
    });
    expect(described.line).toContain("rmt=2026-10-13T15:30:00+09:00 rmtDay=before o=- h=- l=- c=- v=-");
    expect(described.line).toContain("n=2 tail=2026-10-10T09:00,2026-10-13T09:00 prev=N age=- cf=- src=raw");
  });

  it("最終約定が対象日より後なら tradeBefore に数えない", () => {
    const described = describeNullBarsFailure(input({
      bytes: chartBytes({
        rmt: sec("2026-10-15T00:00:00Z"),
        timestamps: [sec("2026-10-13T00:00:00Z")],
        open: [1], high: [1], low: [1], close: [1], volume: [1],
      }),
    }));
    expect(described.line).toContain("rmt=2026-10-15T09:00:00+09:00 rmtDay=after");
    expect(described.categories.tradeBefore).toBe(false);
    expect(described.categories.absent).toBe(true);
  });

  it("原文が壊れていても throw せず、バーと secret を出さない", () => {
    const described = describeNullBarsFailure({
      code: "7203",
      expectedDate: TARGET,
      bytes: new TextEncoder().encode(`{"longName":"${SECRET}"`),
      headers: { age: `1; ${SECRET}`, cfCacheStatus: "HIT" },
      bars: [
        { date: "2026-10-13", open: 1, high: 1, low: 1, close: 1, volume: 3 },
        { date: TARGET, open: 2, high: 3, low: 1, close: null, volume: null },
      ],
    });
    expect(described.categories.closeOnlyNull).toBe(true);
    expect(described.line).toContain("rmt=- rmtDay=- o=V h=V l=V c=N v=nil");
    expect(described.line).toContain("n=- tail=- prev=V age=bad cf=HIT src=bad");
    expect(described.line).not.toContain(SECRET);
  });

  it("原文が無いときは取得済みバーだけで対象日を見る", () => {
    const described = describeNullBarsFailure({
      code: "not-a-code",
      expectedDate: TARGET,
      bars: [{ date: "2026-10-13", open: null, high: 1, low: 1, close: null, volume: 4 }],
    });
    expect(described.categories.absent).toBe(true);
    expect(described.line.startsWith(`${INC_NULL_BARS_TAG} bad rmt=- rmtDay=- o=- h=- l=- c=- v=-`)).toBe(true);
    expect(described.line).toContain("prev=N age=- cf=- src=bars");
  });
});

describe("run summary", () => {
  it("失敗区分は重ねて数え、run の外では増やさない", () => {
    logFreshCloseNullBars(input({
      bytes: chartBytes({
        rmt: sec("2026-10-13T06:00:00Z"),
        timestamps: [sec("2026-10-13T00:00:00Z")],
        open: [1], high: [1], low: [1], close: [1], volume: [1],
      }),
    }));
    startNullBarsRun();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logFreshCloseNullBars(input({
      bytes: chartBytes({
        rmt: sec("2026-10-14T06:00:00Z"),
        timestamps: [sec("2026-10-14T00:00:00Z")],
        open: [null], high: [null], low: [null], close: [null], volume: [null],
      }),
    }));
    logFreshCloseNullBars(input({
      code: "130A",
      bytes: chartBytes({
        rmt: sec("2026-10-13T06:00:00Z"),
        timestamps: [sec("2026-10-13T00:00:00Z")],
        open: [1], high: [1], low: [1], close: [1], volume: [1],
      }),
    }));
    expect(finishNullBarsSummaryLine()).toBe(
      `${INC_NULL_BARS_TAG} summary failures=2 fullyNull=1 closeOnlyNull=0 absent=1 tradeBefore=1`,
    );
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe("buildStockSnapshot fresh-close failure", () => {
  it("例外文は変えず、取得済み原文の診断行だけ足す", () => {
    const bytes = chartBytes({
      rmt: sec("2026-10-13T06:00:00Z"),
      timestamps: [sec("2026-10-13T00:00:00Z")],
      open: [1], high: [1], low: [1], close: [1], volume: [9],
    });
    const raw: StockRawData = {
      price: 1, per: null, pbr: null, dividendYield: null, eps: null, bps: null,
      roe: null, roa: null, marketCap: null, operatingMarginTtm: null,
      dataDate: "2026-10-13",
      ohlcv: [{ date: "2026-10-13", open: 1, high: 1, low: 1, close: 1, volume: 9, adj: 1 }],
      annualFinancials: [],
    };
    const chartRaw: YahooRawCapture = {
      symbol: "7203",
      status: 200,
      bytes,
      url: `https://query1.finance.yahoo.com/v8/finance/chart/7203.T?crumb=${SECRET}`,
      receivedAt: "2026-10-14T10:00:00.000Z",
      headers: { age: "18", cfCacheStatus: "REVALIDATED" },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => buildStockSnapshot(1, "7203", null, TARGET, raw, [], chartRaw)).toThrow(
      "7203: 対象 2026-10-14 の実日足が未取得です。古い日の指標を書き直しません。",
    );
    const lines = warn.mock.calls.map((call) => call.map(String).join(" "));
    const diag = lines.find((line) => line.includes(INC_NULL_BARS_TAG));
    expect(diag).toContain("rmt=2026-10-13T15:00:00+09:00 rmtDay=before");
    expect(diag).toContain("o=- h=- l=- c=- v=-");
    expect(diag).toContain("age=18 cf=REVALIDATED src=raw");
    expect(lines.join("\n")).not.toContain(SECRET);
    expect(lines.join("\n")).not.toContain("crumb");
    warn.mockRestore();
  });
});
