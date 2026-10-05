import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchChart, parseDailyChart, type YahooRawCapture } from "../../../src/shared/yahoo/client.js";
import { archiveYahooRawBatch } from "../../../src/shared/yahoo/raw-custody.js";
import { fetchDailySessionReference, qualifyDailySourceRange } from "./daily-session.js";
import { buildRepairPost } from "./repair-daily.js";
import { tenYearRangeForDate } from "../../../src/shared/vwap/proof.js";
import { completedDailyFetch, hasCompletedDailyFetch, assertSavedDailyShape } from "./ingest-guard.js";

vi.mock("../../../src/shared/yahoo/client.js", async (original) => ({
  ...await original<typeof import("../../../src/shared/yahoo/client.js")>(), fetchChart: vi.fn(),
}));
vi.mock("../../../src/shared/yahoo/raw-custody.js", () => ({ archiveYahooRawBatch: vi.fn() }));
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

// 構造/時刻分岐用。市場の観測値としては使用しない。
const RECEIVED = "2026-10-04T12:28:34.484Z", START = 1790899200, END = 1790922600;
const PRE_OPEN = "2026-10-04T15:32:42.328Z", NEXT_START = 1791158400, NEXT_END = 1791181800;
const symbol = "1301.T", reference = { date: "2026-10-02", observedAt: "2026-10-04T12:14:55.189Z", rawSha: "1".repeat(64) };
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
function raw(over: Record<string, unknown> = {}, timestamp = [1475452800, START]) {
  return new TextEncoder().encode(JSON.stringify({ chart: { error: null, result: [{
    meta: { symbol, currency: "JPY", range: "10y", dataGranularity: "1d", exchangeTimezoneName: "Asia/Tokyo",
      regularMarketPrice: 100, regularMarketTime: END,
      currentTradingPeriod: { regular: { start: START, end: END, timezone: "JST", gmtoffset: 32400 } }, ...over },
    timestamp, indicators: { quote: [{ open: timestamp.map(() => 100), high: timestamp.map(() => 100), low: timestamp.map(() => 100),
      close: timestamp.map(() => 100), volume: timestamp.map(() => 1000) }] },
    events: { dividends: { "1475452800": { date: 1475452800, amount: 1 } } },
  }] } }));
}
const capture = (bytes: Uint8Array, receivedAt = RECEIVED): YahooRawCapture => ({ symbol, bytes, status: 200, receivedAt,
  url: `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=10y&interval=1d&events=split,div`, headers: {} });
const fresh = async (bytes: Uint8Array, receivedAt = RECEIVED) => parseDailyChart(symbol, "10y", bytes, receivedAt);
const emptyOld = JSON.stringify({ code: "1301", bars: [], splits: [] });

describe("source 10y bounds and independent session", () => {
  it("Sunday full body retains its first bar, events, source SHA/clock/URL, without moving data to Sunday", async () => {
    const bytes = raw(), parsed = await fresh(bytes), c = capture(bytes);
    const before = JSON.stringify(parsed), original = sha(bytes);
    expect(() => buildRepairPost({ code: "1301", oldRaw: emptyOld, fresh: parsed,
      range: tenYearRangeForDate("2026-10-04"), updatedAt: RECEIVED })).toThrow("fresh 契約外 2016-10-03");
    const range = qualifyDailySourceRange(parsed, c, reference);
    expect(range).toEqual({ from: "2016-10-02", to: "2026-10-02" });
    const repaired = buildRepairPost({ code: "1301", oldRaw: emptyOld, fresh: parsed,
      range: { from: range.from, to: "2026-10-04" }, updatedAt: RECEIVED });
    expect(repaired.post.bars).toEqual(parsed.bars);
    expect(repaired.post.corporateEvents).toEqual(parsed.corporateEvents);
    expect(repaired.post.proof).toEqual(parsed.proof);
    expect(JSON.stringify(parsed)).toBe(before);
    expect(sha(bytes)).toBe(original);
    expect(c.receivedAt).toBe(RECEIVED);
    expect(parsed.bars.at(-1)?.date).toBe("2026-10-02");
    const completedFetch = completedDailyFetch(parsed, c, range);
    const saved = assertSavedDailyShape(JSON.stringify({ ...repaired.post, completedFetch }), "daily/1301.json", "1301");
    expect(hasCompletedDailyFetch(saved, tenYearRangeForDate("2026-10-04"))).toBe(false); // 休日を当日freshへ偽装しない。
  });

  it("actual weekday and holiday observations use the independently proven session, without calendar guesses", async () => {
    for (const receivedAt of ["2026-10-02T08:00:00.000Z", "2026-10-05T08:00:00.000Z"]) {
      const bytes = raw(), parsed = await fresh(bytes, receivedAt);
      expect(qualifyDailySourceRange(parsed, capture(bytes, receivedAt), { ...reference, observedAt: receivedAt })).toEqual({ from: "2016-10-02", to: "2026-10-02" });
    }
  });

  it.each([
    ["quote before session", { regularMarketTime: START - 1 }],
    ["exchange timezone", { exchangeTimezoneName: "UTC" }],
    ["period timezone", { currentTradingPeriod: { regular: { start: START, end: END, timezone: "UTC", gmtoffset: 0 } } }],
    ["stale session", { regularMarketTime: END - 86400, currentTradingPeriod: { regular: { start: START - 86400, end: END - 86400, timezone: "JST", gmtoffset: 32400 } } }],
  ])("%s stays HOLD", async (_name, meta) => {
    const bytes = raw(meta);
    const awaited = await fresh(bytes);
    expect(() => qualifyDailySourceRange(awaited, capture(bytes), reference)).toThrow(/daily session HOLD/);
  });

  it("stale source cannot delete a newer stored bar, and unknown/mismatched provenance never qualifies", async () => {
    const bytes = raw(), parsed = await fresh(bytes), c = capture(bytes), range = qualifyDailySourceRange(parsed, c, reference);
    const newer = JSON.stringify({ code: "1301", bars: [{ ...parsed.bars.at(-1), date: "2026-10-03" }], splits: [] });
    expect(() => buildRepairPost({ code: "1301", oldRaw: newer, fresh: parsed,
      range: { from: range.from, to: "2026-10-04" }, updatedAt: RECEIVED })).toThrow("in-range 旧");
    expect(() => qualifyDailySourceRange(parsed, undefined, reference)).toThrow("実受領証跡");
    expect(() => qualifyDailySourceRange(parsed, { ...c, receivedAt: reference.observedAt }, reference)).toThrow("実受領証跡");
    expect(() => qualifyDailySourceRange(parsed, c, { ...reference, observedAt: "2026-10-03T12:00:00.000Z" })).toThrow("実受領証跡");
    expect(() => qualifyDailySourceRange(parsed, { ...c, bytes: raw({ regularMarketTime: END + 1 }) }, reference)).toThrow("証跡不一致");
    expect(() => qualifyDailySourceRange(parsed, { ...c, symbol: "1332.T" }, reference)).toThrow("証跡不一致");
    expect(() => qualifyDailySourceRange(parsed, { ...c, url: c.url.replace("10y", "5y") }, reference)).toThrow("要求契約");
    expect(() => qualifyDailySourceRange({ ...parsed, proof: { ...parsed.proof, requestedRange: "5y" } }, c, reference)).toThrow();
  });
  it("an out-of-contract first bar and a null-dropped raw row stay HOLD instead of trimming", async () => {
    const outside = raw({}, [1475280000, START]); // 2016-10-01: 独立10y下限より前。
    const parsedOutside = await fresh(outside);
    expect(() => qualifyDailySourceRange(parsedOutside, capture(outside), reference)).toThrow("全原本行");
    const json = JSON.parse(new TextDecoder().decode(raw()));
    json.chart.result[0].indicators.quote[0].close[0] = null;
    const bytes = new TextEncoder().encode(JSON.stringify(json)), parsed = await fresh(bytes);
    expect(parsed.bars).toHaveLength(1);
    expect(() => qualifyDailySourceRange(parsed, capture(bytes), reference)).toThrow("全原本行");
  });
  it("a last trade before the close qualifies only with the independent closed-session witness", async () => {
    const bytes = raw({ regularMarketTime: START }), parsed = await fresh(bytes), c = capture(bytes), range = tenYearRangeForDate(reference.date);
    expect(completedDailyFetch(parsed, c, range)).toBeNull(); // witness無しlegacy条件は不変。
    expect(qualifyDailySourceRange(parsed, c, reference)).toEqual(range);
    const completedFetch = completedDailyFetch(parsed, c, range, reference);
    expect(completedFetch).not.toBeNull();
    const saved = assertSavedDailyShape(JSON.stringify({ code: "1301", ...parsed, completedFetch }), "daily/1301.json", "1301");
    expect(hasCompletedDailyFetch(saved, range)).toBe(true);
    expect(hasCompletedDailyFetch(saved, tenYearRangeForDate("2026-10-04"))).toBe(false);
    for (const witness of [{ ...reference, date: "2026-10-01" }, { ...reference, rawSha: "invalid" },
      { ...reference, observedAt: "2026-10-04T13:00:00.000Z" }, { ...reference, observedAt: "2026-10-02T06:00:00.000Z" }]) {
      const invalid = { ...saved, completedFetch: { ...completedFetch!, sessionReference: witness } };
      expect(hasCompletedDailyFetch(invalid, range)).toBe(false);
      expect(() => assertSavedDailyShape(JSON.stringify(invalid), "daily/1301.json", "1301")).toThrow("completedFetch");
    }
    const earlyAt = "2026-10-02T06:00:00.000Z", early = await fresh(bytes, earlyAt);
    expect(() => qualifyDailySourceRange(early, capture(bytes, earlyAt), { ...reference, observedAt: earlyAt })).toThrow("全原本行");
    const noTrade = raw({ regularMarketTime: START - 86400 });
    const noTradeParsed = await fresh(noTrade);
    expect(() => qualifyDailySourceRange(noTradeParsed, capture(noTrade), reference)).toThrow("全原本行");
  });
  it("before opening, the next period remains raw metadata while the witnessed prior day's full body qualifies", async () => {
    const bytes = raw({ regularMarketTime: START,
      currentTradingPeriod: { regular: { start: NEXT_START, end: NEXT_END, timezone: "JST", gmtoffset: 32400 } } });
    const parsed = await fresh(bytes, PRE_OPEN), c = capture(bytes, PRE_OPEN);
    const witness = { ...reference, observedAt: PRE_OPEN }, range = tenYearRangeForDate(reference.date);
    expect(completedDailyFetch(parsed, c, range)).toBeNull(); // legacy is unchanged.
    expect(qualifyDailySourceRange(parsed, c, witness)).toEqual(range);
    const completion = completedDailyFetch(parsed, c, range, witness)!;
    expect(completion).toMatchObject({ regularStart: NEXT_START, regularEnd: NEXT_END, regularMarketTime: START });
    const saved = assertSavedDailyShape(JSON.stringify({ code: "1301", ...parsed, completedFetch: completion }), "daily/1301.json", "1301");
    expect(hasCompletedDailyFetch(saved, range)).toBe(true);
    expect(hasCompletedDailyFetch(saved, tenYearRangeForDate("2026-10-05"))).toBe(false);
    expect(saved.proof).toEqual(parsed.proof);
    expect(saved.corporateEvents).toEqual(parsed.corporateEvents);
    expect(sha(bytes)).toBe(parsed.proof.rawSha);
    const sourceAfterOpening = { ...saved, proof: { ...saved.proof!, observedAt: "2026-10-05T00:00:00.000Z" } };
    expect(hasCompletedDailyFetch(sourceAfterOpening, range)).toBe(false); // benchmark alone being pre-open is insufficient.
    const laterRawBar = raw({ regularMarketTime: START,
      currentTradingPeriod: { regular: { start: NEXT_START, end: NEXT_END, timezone: "JST", gmtoffset: 32400 } } }, [1475452800, START + 1]);
    const inconsistent = await fresh(laterRawBar, PRE_OPEN);
    expect(() => qualifyDailySourceRange(inconsistent, capture(laterRawBar, PRE_OPEN), witness)).toThrow("全原本行");
    for (const at of ["2026-10-05T00:00:00.000Z", "2026-10-05T03:00:00.000Z", "2026-10-03T15:00:00.000Z"]) {
      const invalid = { ...saved, proof: { ...saved.proof!, observedAt: at },
        completedFetch: { ...completion, sessionReference: { ...witness, observedAt: at } } };
      expect(hasCompletedDailyFetch(invalid, range)).toBe(false);
      expect(() => assertSavedDailyShape(JSON.stringify(invalid), "daily/1301.json", "1301")).toThrow();
    }
  });
});

describe("witnessed daily rows without a new trade", () => {
  type NoTradeTestResult = {
    meta: { regularMarketTime: number };
    indicators: { quote: Array<{ open: Array<number | null>; high: Array<number | null>;
      low: Array<number | null>; close: Array<number | null>; volume: Array<number | null> }> };
  };
  function noTradeRaw(beforeOpen: boolean, change?: (r: NoTradeTestResult) => void) {
    const result = JSON.parse(new TextDecoder().decode(raw({ regularMarketTime: START - 86400 + 10000,
      currentTradingPeriod: { regular: { start: beforeOpen ? NEXT_START : START,
        end: beforeOpen ? NEXT_END : END, timezone: "JST", gmtoffset: 32400 } } },
      [1475452800, START - 86400, START]))).chart.result[0] as NoTradeTestResult;
    result.indicators.quote[0].volume = [1000, 200, 0];
    change?.(result);
    return new TextEncoder().encode(JSON.stringify({ chart: { error: null, result: [result] } }));
  }

  it.each([false, true])("full v0/flat raw rows qualify with an independent closed witness (preopen=%s)", async (beforeOpen) => {
    const at = beforeOpen ? PRE_OPEN : RECEIVED, bytes = noTradeRaw(beforeOpen), parsed = await fresh(bytes, at);
    const witness = { ...reference, observedAt: at }, c = capture(bytes, at), range = tenYearRangeForDate(reference.date);
    expect(completedDailyFetch(parsed, c, range)).toBeNull(); // No new legacy allowance.
    expect(qualifyDailySourceRange(parsed, c, witness)).toEqual(range);
    const completedFetch = completedDailyFetch(parsed, c, range, witness)!;
    expect(completedFetch.noTrade).toEqual({ regularMarketPrice: 100, quoteBarTimestamp: START - 86400 });
    expect(completedFetch.regularMarketTime).toBe(START - 86400 + 10000);
    expect(completedFetch.regularStart).toBe(beforeOpen ? NEXT_START : START);
    const saved = assertSavedDailyShape(JSON.stringify({ code: "1301", ...parsed, completedFetch }), "daily/1301.json", "1301");
    expect(hasCompletedDailyFetch(saved, range)).toBe(true);
    expect(hasCompletedDailyFetch(saved, tenYearRangeForDate("2026-10-05"))).toBe(false);
    expect(saved.proof).toEqual(parsed.proof);
    expect(saved.corporateEvents).toEqual(parsed.corporateEvents);
    expect(saved.bars).toEqual(parsed.bars);
    expect(sha(bytes)).toBe(parsed.proof.rawSha);
    for (const noTrade of [undefined, null, { regularMarketPrice: 101, quoteBarTimestamp: START - 86400 },
      { regularMarketPrice: 100, quoteBarTimestamp: START }]) {
      const invalid = { ...saved, completedFetch: { ...completedFetch, noTrade } };
      expect(hasCompletedDailyFetch(invalid as typeof saved, range)).toBe(false);
      expect(() => assertSavedDailyShape(JSON.stringify(invalid), "daily/1301.json", "1301")).toThrow();
    }
    expect(hasCompletedDailyFetch({ ...saved, completedFetch: { ...completedFetch, sessionReference: undefined } }, range)).toBe(false);
  });

  it.each([
    ["newer trade", (r: NoTradeTestResult) => { r.indicators.quote[0].volume[2] = 1; }],
    ["v0 non-flat", (r: NoTradeTestResult) => { r.indicators.quote[0].open[2] = 99; }],
    ["flat only after rounding", (r: NoTradeTestResult) => { r.indicators.quote[0].high[2] = 100.001; }],
    ["no actual quoted-day volume", (r: NoTradeTestResult) => { r.indicators.quote[0].volume[1] = 0; }],
    ["quoted-day close differs", (r: NoTradeTestResult) => { r.indicators.quote[0].close[1] = 99; }],
    ["raw null row", (r: NoTradeTestResult) => { r.indicators.quote[0].open[1] = null; }],
    ["quote before its raw bar", (r: NoTradeTestResult) => { r.meta.regularMarketTime = START - 86400 - 1; }],
  ])("%s stays HOLD", async (_why, change) => {
    const bytes = noTradeRaw(true, change), parsed = await fresh(bytes, PRE_OPEN), witness = { ...reference, observedAt: PRE_OPEN };
    expect(() => qualifyDailySourceRange(parsed, capture(bytes, PRE_OPEN), witness)).toThrow("全原本行");
  });

  it.each([false, true])("forming/opened metadata and one premature witness stay HOLD (preopen=%s)", async (beforeOpen) => {
    const bytes = noTradeRaw(beforeOpen), at = beforeOpen ? "2026-10-05T00:00:00.000Z" : "2026-10-02T06:00:00.000Z";
    const parsed = await fresh(bytes, at), witness = { ...reference, observedAt: at };
    expect(() => qualifyDailySourceRange(parsed, capture(bytes, at), witness)).toThrow("全原本行");
    if (beforeOpen) {
      const earlyWitness = { ...reference, observedAt: PRE_OPEN };
      expect(() => qualifyDailySourceRange(parsed, capture(bytes, at), earlyWitness)).toThrow("全原本行");
    }
  });
});

describe("normal benchmark capture before stock ingestion", () => {
  it("pre-open metadata retains the prior closed day selected by the existing source-only helper", async () => {
    const bytes = raw({ symbol: "^N225", range: "1mo",
      currentTradingPeriod: { regular: { start: NEXT_START, end: NEXT_END, timezone: "JST", gmtoffset: 32400 } } });
    vi.mocked(fetchChart).mockImplementationOnce(async (_s, _r, options) => {
      await options!.onRaw!({ ...capture(bytes, PRE_OPEN), symbol: "^N225" });
      return { symbol: "^N225", price: 100, previousClose: null, dataDate: "2026-10-02",
        ohlcv: [{ date: "2016-10-03", open: 100, high: 100, low: 100, close: 100, volume: 1000, adj: null },
          { date: "2026-10-02", open: 100, high: 100, low: 100, close: 100, volume: 1000, adj: null }] };
    });
    vi.mocked(archiveYahooRawBatch).mockResolvedValueOnce({ pages: ["physical"], rawBytes: bytes.length, compressedBytes: 1 });
    expect(await fetchDailySessionReference("1.1")).toEqual({ date: "2026-10-02", observedAt: PRE_OPEN, rawSha: sha(bytes) });
    expect(fetchChart).toHaveBeenCalledTimes(1);
    expect(archiveYahooRawBatch).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["opening has begun", "2026-10-05T00:00:00.000Z", NEXT_START, NEXT_END, END, [START]],
    ["period is a different future day", PRE_OPEN, NEXT_START + 86400, NEXT_END + 86400, END, [START]],
    ["raw already contains the future period", PRE_OPEN, NEXT_START, NEXT_END, END, [START, NEXT_START]],
    ["quote is in the future", PRE_OPEN, NEXT_START, NEXT_END, NEXT_START, [START]],
    ["quote day differs from confirmed bar", PRE_OPEN, NEXT_START, NEXT_END, END - 86400, [START]],
    ["period end crosses into a different day", PRE_OPEN, NEXT_START, NEXT_END + 86400, END, [START]],
  ] as const)("pre-open %s is archived and remains HOLD", async (_why, observedAt, start, end, marketTime, stamps) => {
    const bytes = raw({ symbol: "^N225", range: "1mo", regularMarketTime: marketTime,
      currentTradingPeriod: { regular: { start, end, timezone: "JST", gmtoffset: 32400 } } }, [...stamps]);
    vi.mocked(fetchChart).mockImplementationOnce(async (_s, _r, options) => {
      await options!.onRaw!({ ...capture(bytes, observedAt), symbol: "^N225" });
      return { symbol: "^N225", price: 100, previousClose: null, dataDate: "2026-10-02",
        ohlcv: stamps.map(t => ({ date: new Date(t * 1000).toISOString().slice(0, 10), open: 100, high: 100,
          low: 100, close: 100, volume: 1000, adj: null })) };
    });
    vi.mocked(archiveYahooRawBatch).mockResolvedValueOnce({ pages: ["physical"], rawBytes: bytes.length, compressedBytes: 1 });
    await expect(fetchDailySessionReference("1.1")).rejects.toThrow(/HOLD/);
    expect(fetchChart).toHaveBeenCalledTimes(1);
    expect(archiveYahooRawBatch).toHaveBeenCalledTimes(1);
  });
  it("one shared benchmark and one physical archive settle before returning its independent date", async () => {
    const bytes = raw({ symbol: "^N225", range: "1mo" });
    vi.mocked(fetchChart).mockImplementationOnce(async (_s, _r, options) => {
      await options!.onRaw!({ ...capture(bytes), symbol: "^N225" });
      return { symbol: "^N225", price: 100, previousClose: null, dataDate: "2026-10-02",
        ohlcv: [{ date: "2016-10-03", open: 100, high: 100, low: 100, close: 100, volume: 1000, adj: null },
          { date: "2026-10-02", open: 100, high: 100, low: 100, close: 100, volume: 1000, adj: null }] };
    });
    vi.mocked(archiveYahooRawBatch).mockResolvedValueOnce({ pages: ["physical"], rawBytes: bytes.length, compressedBytes: 1 });
    expect(await fetchDailySessionReference("1.1")).toEqual({ date: "2026-10-02", observedAt: RECEIVED, rawSha: sha(bytes) });
    expect(fetchChart).toHaveBeenCalledTimes(1);
    expect(fetchChart).toHaveBeenCalledWith("^N225", "1mo", expect.objectContaining({ onRaw: expect.any(Function) }));
    expect(archiveYahooRawBatch).toHaveBeenCalledWith(expect.objectContaining({ stage: "vwap-daily-session", captures: [expect.objectContaining({ capture: expect.objectContaining({ bytes }) })] }));
  });
  it("transport/unknown archive failures STOP with no benchmark retry", async () => {
    vi.mocked(fetchChart).mockRejectedValueOnce(new Error("transport"));
    vi.mocked(archiveYahooRawBatch).mockRejectedValueOnce(new Error("unknown physical write"));
    await expect(fetchDailySessionReference("1.1")).rejects.toThrow("unknown physical write");
    expect(fetchChart).toHaveBeenCalledTimes(1);
    expect(archiveYahooRawBatch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(archiveYahooRawBatch).mock.calls[0][0].missing).toHaveLength(1);
  });
  it("a forming benchmark archives its captured body and stops before any per-stock work", async () => {
    const bytes = raw({ symbol: "^N225", range: "1mo", regularMarketTime: END - 1 });
    vi.mocked(fetchChart).mockImplementationOnce(async (_s, _r, options) => {
      await options!.onRaw!({ ...capture(bytes), symbol: "^N225" });
      return { symbol: "^N225", price: 100, previousClose: null, dataDate: "2026-10-02",
        ohlcv: [{ date: "2016-10-03", open: 100, high: 100, low: 100, close: 100, volume: 1000, adj: null },
          { date: "2026-10-02", open: 100, high: 100, low: 100, close: 100, volume: 1000, adj: null }] };
    });
    vi.mocked(archiveYahooRawBatch).mockResolvedValueOnce({ pages: ["physical"], rawBytes: bytes.length, compressedBytes: 1 });
    await expect(fetchDailySessionReference("1.1")).rejects.toThrow("現在session");
    expect(fetchChart).toHaveBeenCalledTimes(1);
    expect(archiveYahooRawBatch).toHaveBeenCalledTimes(1);
  });
});
