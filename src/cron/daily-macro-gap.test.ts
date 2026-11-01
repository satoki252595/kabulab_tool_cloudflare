/**
 * INC-20261008-kabulab_tool_cloudflare-financials-stale
 *
 * 429 で swing_market_context の 1 日が欠けたあと、次の定時 run が
 * その日を検出する。d の bar が無ければ別の日の値では埋めず HOLD。
 * 既存行は上書きしない。MACRO_CONTEXT_GAP_FILL が無効なら書かない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { MACRO_CONTEXT_GAP_LOOKBACK_DAYS, macroContextGapDates, runMarketContextSync } from "./daily.js";
import * as jpLegModule from "./macro-jp-leg.js";
import { marketClosure } from "../shared/market-calendar.js";
import {
  fetchChart,
  parseChartResponse,
  YahooRateLimitError,
  type ChartResult,
} from "../shared/yahoo/client.js";
import { guardChartBars } from "../shared/yahoo/bar-sanity.js";
import {
  recordPrimaryData,
  verifyArchivedAttachments,
} from "../shared/notion-archive/index.js";
import { selectConfirmedCloses } from "./macro-session.js";
import * as coreSchema from "../shared/db/core-schema.js";
import * as rsiSchema from "../../services/rsi-screening/src/db/schema.js";
import * as swingSchema from "../../services/swing-trading/src/db/schema.js";
import * as projectionSchema from "../shared/db/projection-schema.js";

vi.mock("../shared/yahoo/client.js", async (original) => ({
  ...await original<typeof import("../shared/yahoo/client.js")>(),
  fetchChart: vi.fn(),
}));
vi.mock("../shared/notion-archive/index.js", async (original) => ({
  ...await original<typeof import("../shared/notion-archive/index.js")>(),
  recordPrimaryData: vi.fn(),
  verifyArchivedAttachments: vi.fn(),
}));

const TAG = "[INC-20261008-kabulab_tool_cloudflare-financials-stale]";
const GAP_DAY = "2026-09-28";
const NEXT_DAY = "2026-09-29";
const EXISTING_DAY = "2026-09-25";
const FX = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__/macro-canonical");
const FILES: Record<string, string> = {
  "^GSPC": "gspc-20260930.json",
  "^VIX": "vix-20260930.json",
  "NIY=F": "niy-20260930.json",
};
const NIKKEI: Record<string, number> = {
  [EXISTING_DAY]: 11111.25,
  [GAP_DAY]: 22222.5,
  [NEXT_DAY]: 33333.75,
};

const fxBytes = (name: string): Uint8Array => readFileSync(join(FX, name));

function stripUtcDate(raw: Uint8Array, utcDate: string): Uint8Array {
  const json = JSON.parse(new TextDecoder().decode(raw)) as {
    chart: { result: Array<Record<string, unknown>> };
  };
  const result = json.chart.result[0] as {
    timestamp: number[];
    indicators: {
      quote: Array<Record<string, unknown>>;
      adjclose?: Array<Record<string, unknown>>;
    };
  };
  const keep: number[] = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    const day = new Date(result.timestamp[i] * 1000).toISOString().slice(0, 10);
    if (day !== utcDate) keep.push(i);
  }
  if (keep.length === result.timestamp.length) {
    throw new Error(`テスト: ${utcDate} の bar が原文に無い`);
  }
  const take = <T>(values: T[]): T[] => keep.map((i) => values[i]);
  result.timestamp = take(result.timestamp);
  for (const quote of result.indicators.quote) {
    for (const key of Object.keys(quote)) {
      const column = quote[key];
      if (Array.isArray(column)) quote[key] = take(column);
    }
  }
  for (const adj of result.indicators.adjclose ?? []) {
    for (const key of Object.keys(adj)) {
      const column = adj[key];
      if (Array.isArray(column)) adj[key] = take(column);
    }
  }
  return new TextEncoder().encode(JSON.stringify(json));
}

function chartFromBytes(symbol: string, raw: Uint8Array): ChartResult {
  const json = JSON.parse(new TextDecoder().decode(raw));
  const parsed = parseChartResponse(json, symbol);
  const { bars } = guardChartBars(parsed.bars, parsed.meta.regularMarketPrice, symbol);
  const closes = parsed.closePrices.filter((price): price is number => price !== null);
  return {
    symbol,
    price: parsed.meta.regularMarketPrice ?? closes.at(-1) ?? null,
    previousClose: parsed.meta.previousClose ?? null,
    dataDate: bars.at(-1)?.date ?? "",
    ohlcv: [...bars],
  };
}

function jointOpenDates(end: string): string[] {
  const endMs = Date.parse(`${end}T00:00:00Z`);
  const dates: string[] = [];
  for (let i = MACRO_CONTEXT_GAP_LOOKBACK_DAYS - 1; i >= 0; i--) {
    const date = new Date(endMs - i * 86_400_000).toISOString().slice(0, 10);
    if (marketClosure("JPX", date) === null && marketClosure("NYSE", date) === null) {
      dates.push(date);
    }
  }
  return dates;
}

function jpLeg(date: string) {
  const nikkei = NIKKEI[date];
  if (nikkei === undefined) return null;
  return {
    n225: { value: nikkei, prev: nikkei - 100, date },
    nikkeiVi: 20,
    nikkeiViDate: date,
    reference: {
      kind: "archived-jp-leg" as const,
      expectedDate: date,
      cacheKey: `macro/jp-close/${date}.json`,
      archivePageId: "test-jp-page",
      manifestSha256: "a".repeat(64),
      n225: {
        sha256: "b".repeat(64),
        receivedAt: `${date}T09:00:00Z`,
        archivePages: ["test-n225-page"],
      },
      vi: { sha256: "c".repeat(64), receivedAt: `${date}T09:00:01Z`, status: 200 },
    },
  };
}

function gapDb(present: ReadonlySet<string>) {
  const calls: string[] = [];
  const params: unknown[][] = [];
  const db = drizzle(async (sql, p, method) => {
    calls.push(sql);
    params.push([...p]);
    if (method !== "run" && /^\s*select/i.test(sql) && sql.includes("swing_market_context")) {
      return { rows: [...present].map((date) => [date]) };
    }
    return { rows: [] };
  }, {
    schema: { ...coreSchema, ...rsiSchema, ...swingSchema, ...projectionSchema },
  });
  return {
    calls,
    params,
    db: db as Parameters<typeof runMarketContextSync>[0],
    inserts() {
      return calls.flatMap((sql, index) => (
        /insert\s+into\s+"swing_market_context"/i.test(sql)
          ? [{ sql, params: params[index] }]
          : []
      ));
    },
  };
}

function schedule(date: string) {
  vi.stubEnv("STOCK_SYNC_TARGET", "scheduled-context");
  vi.stubEnv("SCHEDULED_DATE", date);
  vi.stubEnv("SCHEDULED_AT", `${date}T21:00:30.000Z`);
  vi.setSystemTime(new Date(`${date}T21:00:30.000Z`));
}

function setFill(mode: "unset" | "0" | "1") {
  vi.stubEnv("MACRO_CONTEXT_GAP_FILL", mode === "unset" ? "" : mode);
}

function mockCharts(strip: string | null) {
  vi.mocked(fetchChart).mockImplementation(async (symbol, _range, options) => {
    const file = FILES[symbol];
    if (file === undefined) throw new Error(`テスト: 未定義 symbol ${symbol}`);
    const raw = strip === null ? fxBytes(file) : stripUtcDate(fxBytes(file), strip);
    await options?.onRaw?.({
      symbol,
      status: 200,
      bytes: raw,
      url: `https://mock.test/chart/${symbol}`,
      receivedAt: new Date().toISOString(),
      headers: {},
    });
    return chartFromBytes(symbol, raw);
  });
}

function barClose(symbol: string, date: string): number {
  const raw = fxBytes(FILES[symbol]);
  const bars = chartFromBytes(symbol, raw).ohlcv;
  const close = bars.find((bar) => bar.date === date)?.close;
  if (typeof close !== "number") throw new Error(`テスト: ${symbol} ${date} の close が無い`);
  return close;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.mocked(recordPrimaryData).mockResolvedValue({
    pageId: "test-page",
    outcome: "recorded",
    fileTooLarge: false,
    manifestMatch: "written",
  });
  vi.mocked(verifyArchivedAttachments).mockResolvedValue(undefined);
  vi.spyOn(jpLegModule, "loadMacroJpLeg").mockImplementation(async (_store, date) => jpLeg(date));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("429 で欠けたマクロ日を次の定時 run が検出する", () => {
  it("窓は30暦日で、JPX休場の10-12を含めず10-30を含む", () => {
    expect(MACRO_CONTEXT_GAP_LOOKBACK_DAYS).toBe(30);
    const dates = macroContextGapDates("2026-11-02");
    expect(dates[0]).toBe("2026-10-05");
    expect(dates.at(-1)).toBe("2026-11-02");
    expect(dates).toContain("2026-10-30");
    expect(dates).not.toContain("2026-10-12");
    expect(dates).not.toContain("2026-10-31");
    expect(dates).not.toContain("2026-11-01");
  });

  const store = { get: async () => null, put: async () => { throw new Error("test: unexpected PUT"); } };

  it("429 の次の定時 run は欠けを検出し、d の bar が無ければ HOLD して書かない", async () => {
    const warns: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((message) => { warns.push(String(message)); });
    schedule(GAP_DAY);
    setFill("unset");
    vi.mocked(fetchChart).mockImplementation(async (_symbol, _range, options) => {
      await options?.onRaw?.({
        symbol: "^VIX",
        status: 429,
        bytes: fxBytes(FILES["^VIX"]),
        url: "https://mock.test/chart",
        receivedAt: new Date().toISOString(),
        headers: {},
      });
      throw new YahooRateLimitError(429, null);
    });
    const missed = gapDb(new Set());
    await expect(runMarketContextSync(missed.db, store)).rejects.toBeInstanceOf(YahooRateLimitError);
    expect(missed.inserts()).toEqual([]);

    const stripped = stripUtcDate(fxBytes(FILES["^GSPC"]), GAP_DAY);
    const strippedBars = chartFromBytes("^GSPC", stripped).ohlcv;
    expect(selectConfirmedCloses(stripped, strippedBars, "^GSPC").date).toBe(NEXT_DAY);
    expect(strippedBars.some((bar) => bar.date === GAP_DAY)).toBe(false);

    schedule(NEXT_DAY);
    setFill("unset");
    mockCharts(GAP_DAY);
    const present = new Set(jointOpenDates(NEXT_DAY).filter((date) => date !== GAP_DAY));
    expect(present.has(EXISTING_DAY)).toBe(true);
    expect(present.has(NEXT_DAY)).toBe(true);
    const next = gapDb(present);
    expect(await runMarketContextSync(next.db, store)).toBe(true);
    const wrote = next.inserts().map((row) => row.params[0]);
    expect(wrote).toEqual([NEXT_DAY]);
    expect(wrote).not.toContain(GAP_DAY);
    expect(wrote).not.toContain(EXISTING_DAY);
    expect(next.inserts()[0].params).toContain(NIKKEI[NEXT_DAY]);
    expect(next.inserts()[0].params).not.toContain(NIKKEI[GAP_DAY]);
    expect(warns).toContain(`${TAG} マクロ欠け日 検出: ${GAP_DAY}（MACRO_CONTEXT_GAP_FILL は無効。書き込まない）`);
    expect(warns).toContainEqual(expect.stringContaining(`${TAG} マクロ欠け日 HOLD: ${GAP_DAY}`));
    const hold = warns.find((line) => line.startsWith(`${TAG} マクロ欠け日 HOLD: ${GAP_DAY}`));
    expect(hold).toMatch(/GSPC/);
    expect(hold).not.toContain(barClose("^GSPC", NEXT_DAY).toString());
  });

  it.each(["unset", "0"] as const)(
    "フラグが %s なら d の bar が揃っていても欠けた日を書かない",
    async (mode) => {
      const warns: string[] = [];
      const infos: string[] = [];
      vi.spyOn(console, "warn").mockImplementation((message) => { warns.push(String(message)); });
      vi.spyOn(console, "info").mockImplementation((message) => { infos.push(String(message)); });
      schedule(NEXT_DAY);
      setFill(mode);
      mockCharts(null);
      const present = new Set(jointOpenDates(NEXT_DAY).filter((date) => date !== GAP_DAY));
      const next = gapDb(present);
      expect(await runMarketContextSync(next.db, store)).toBe(true);
      expect(next.inserts().map((row) => row.params[0])).toEqual([NEXT_DAY]);
      expect(warns).toContain(`${TAG} マクロ欠け日 検出: ${GAP_DAY}（MACRO_CONTEXT_GAP_FILL は無効。書き込まない）`);
      expect(warns.some((line) => line.startsWith(`${TAG} マクロ欠け日 HOLD: ${GAP_DAY}`))).toBe(false);
      expect(infos.some((line) => line.includes(`${TAG} マクロ欠け日 書込: ${GAP_DAY}`))).toBe(false);
    },
  );

  it("フラグが有効でも d の bar が無ければ別日の値で埋めず HOLD する", async () => {
    const warns: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((message) => { warns.push(String(message)); });
    schedule(NEXT_DAY);
    setFill("1");
    mockCharts(GAP_DAY);
    const present = new Set(jointOpenDates(NEXT_DAY).filter((date) => date !== GAP_DAY));
    const next = gapDb(present);
    expect(await runMarketContextSync(next.db, store)).toBe(true);
    expect(next.inserts().map((row) => row.params[0])).toEqual([NEXT_DAY]);
    const hold = warns.find((line) => line.startsWith(`${TAG} マクロ欠け日 HOLD: ${GAP_DAY}`));
    expect(hold).toBeDefined();
    expect(hold).toMatch(/GSPC/);
    expect(hold).not.toContain(String(barClose("^VIX", NEXT_DAY)));
    expect(next.inserts()[0].params).not.toContain(barClose("^VIX", GAP_DAY));
  });

  it("フラグが有効なときだけ d の bar と JP leg で INSERT し、既存行は上書きしない", async () => {
    const infos: string[] = [];
    vi.spyOn(console, "info").mockImplementation((message) => { infos.push(String(message)); });
    schedule(NEXT_DAY);
    setFill("1");
    mockCharts(null);
    const present = new Set(jointOpenDates(NEXT_DAY).filter((date) => date !== GAP_DAY));
    const next = gapDb(present);
    expect(await runMarketContextSync(next.db, store)).toBe(true);
    const gap = next.inserts().find((row) => row.params[0] === GAP_DAY);
    const today = next.inserts().find((row) => row.params[0] === NEXT_DAY);
    if (gap === undefined || today === undefined) {
      throw new Error(`テスト: 挿入日が想定外 ${next.inserts().map((row) => row.params[0]).join(",")}`);
    }
    expect(next.inserts().some((row) => row.params[0] === EXISTING_DAY)).toBe(false);
    expect(gap.sql.toLowerCase()).toMatch(/on conflict .*do nothing/);
    expect(gap.sql.toLowerCase()).not.toMatch(/do update/);
    expect(gap.params).toContain(NIKKEI[GAP_DAY]);
    expect(gap.params).toContain(barClose("^VIX", GAP_DAY));
    expect(gap.params).not.toContain(NIKKEI[NEXT_DAY]);
    expect(gap.params).not.toContain(barClose("^VIX", NEXT_DAY));
    expect(gap.params).not.toContain(NIKKEI[EXISTING_DAY]);
    expect(today.sql.toLowerCase()).toMatch(/do update/);
    expect(today.params).toContain(NIKKEI[NEXT_DAY]);
    expect(infos).toContain(`${TAG} マクロ欠け日 書込: ${GAP_DAY}`);

    const filled = gapDb(new Set(jointOpenDates(NEXT_DAY)));
    expect(await runMarketContextSync(filled.db, store)).toBe(true);
    expect(filled.inserts().map((row) => row.params[0])).toEqual([NEXT_DAY]);
    expect(filled.inserts().some((row) => /do nothing/i.test(row.sql))).toBe(false);
  });

  it("MACRO_CONTEXT_GAP_FILL が 0 と 1 以外なら取得前に停止する", async () => {
    schedule(NEXT_DAY);
    vi.stubEnv("MACRO_CONTEXT_GAP_FILL", "yes");
    const { db, calls } = gapDb(new Set());
    await expect(runMarketContextSync(db, store)).rejects.toThrow(/MACRO_CONTEXT_GAP_FILL/);
    expect(fetchChart).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});
