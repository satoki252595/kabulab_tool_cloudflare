import { describe, expect, it } from "vitest";
import { proveIntraRecoveryCapture, resolveIntraRecoveryWindow } from "./intra-recovery.js";
import type { YahooRawCapture } from "../../../src/shared/yahoo/client.js";

const NOW = "2026-10-13T19:43:00.000Z", FROM = "2026-08-17T00:00:00Z", TO = "2026-10-13T06:30:01Z";
const args = { from: FROM, toExclusive: TO, codes: "593A,598A,603A,604A,607A", now: NOW };
const window = resolveIntraRecoveryWindow(args)!;
const stamp = (iso: string) => Date.parse(iso) / 1000;
// 取得窓の構造だけを検証する。価格/株数などの観測値は生成しない。
function capture(stamps = [window.period1, window.period2 - 1], over: object = {}): YahooRawCapture {
  return { symbol: "593A.T", status: 200, receivedAt: NOW, headers: {},
    url: `https://query1.finance.yahoo.com/v8/finance/chart/593A.T?interval=5m&period1=${window.period1}&period2=${window.period2}`,
    bytes: new TextEncoder().encode(JSON.stringify({ chart: { result: [{
      meta: { symbol: "593A.T", currency: "JPY", instrumentType: "EQUITY", dataGranularity: "5m", exchangeTimezoneName: "Asia/Tokyo" }, timestamp: stamps,
    }], error: null } })), ...over };
}
describe("explicit five-code intra recovery", () => {
  it("does not change a normal range call", () => {
    expect(resolveIntraRecoveryWindow({ codes: "7203", range: "60d", now: NOW })).toBeNull();
  });
  it("binds the first recoverable JP open and prior confirmed close without Monday holiday invention", () => {
    expect(window).toEqual({ from: FROM, toExclusive: TO, period1: stamp(FROM), period2: stamp(TO) });
    expect(resolveIntraRecoveryWindow({ ...args, codes: "593A" })).toEqual(window);
    expect(resolveIntraRecoveryWindow({ ...args, now: "2026-10-12T19:43:00.000Z", from: "2026-08-14T00:00:00Z", toExclusive: "2026-10-09T06:30:01Z" })).toMatchObject({ period2: stamp("2026-10-09T06:30:01Z") });
  });
  it.each([
    { from: undefined }, { toExclusive: undefined }, { codes: undefined }, { codes: "7203" }, { codes: "593A,593A" },
    { codes: "593A," }, { range: "60d" }, { limit: "1" }, { from: "2026-08-14T00:00:00Z" },
    { from: "2026-08-18T00:00:00Z" }, { from: "2026-08-17T00:05:00Z" }, { from: "2026-08-32T00:00:00Z" },
    { toExclusive: "2026-10-12T06:30:01Z" }, { toExclusive: "2026-10-14T06:30:01Z" },
    { toExclusive: "2026-10-13T06:30:00Z" }, { toExclusive: "2026-10-13T06:35:00Z" }, { now: "2028-10-13T19:43:00Z" },
  ])("rejects an unqualified target/window %j before source fetch", change => {
    expect(() => resolveIntraRecoveryWindow({ ...args, ...change })).toThrow();
  });
  it("includes the real 15:30 auction timestamp, retains its raw SHA and exact period URL", () => {
    const source = capture(), proof = proveIntraRecoveryCapture(source, window, "593A.T");
    expect(proof).toMatchObject({ ...window, observedAt: NOW, rawBars: 2, firstTs: window.period1, lastTs: window.period2 - 1 });
    expect(proof.rawSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(new URL(proof.sourceUrl).searchParams.has("range")).toBe(false);
  });
  it("keeps fractional milliseconds in actual clocks while operator boundaries stay whole-second", () => {
    expect(resolveIntraRecoveryWindow({ ...args, now: "2026-10-13T19:43:00.123Z" })).toEqual(window);
    expect(proveIntraRecoveryCapture(capture(undefined, { receivedAt: "2026-10-13T19:43:00.987Z" }), window, "593A.T").observedAt).toBe("2026-10-13T19:43:00.987Z");
    expect(() => resolveIntraRecoveryWindow({ ...args, from: "2026-08-17T00:00:00.123Z" })).toThrow();
  });
  it("holds stale last-session response and non-equity instrument instead of claiming recovery", () => {
    expect(() => proveIntraRecoveryCapture(capture([window.period1]), window, "593A.T")).toThrow();
    const source = capture(), json = JSON.parse(new TextDecoder().decode(source.bytes));json.chart.result[0].meta.instrumentType = "INDEX";
    expect(() => proveIntraRecoveryCapture(capture(undefined, { bytes: new TextEncoder().encode(JSON.stringify(json)) }), window, "593A.T")).toThrow();
  });
  it.each([
    [window.period1 - 300], [window.period2], [stamp("2026-10-12T00:00:00Z")],
    [stamp("2026-10-13T03:00:00Z")], [window.period1 + 1], [window.period1, window.period1], [],
  ])("rejects all out-of-window/holiday/lunch/misaligned/duplicate raw rows %j", (...stamps) => {
    expect(() => proveIntraRecoveryCapture(capture(stamps), window, "593A.T")).toThrow();
  });
  it("rejects range=60d capture, wrong issuer, currency and failure without promoting it", () => {
    const original = capture();
    expect(() => proveIntraRecoveryCapture(capture(undefined, { status: 422 }), window, "593A.T")).toThrow();
    expect(() => proveIntraRecoveryCapture(capture(undefined, { url: `${original.url}&range=60d` }), window, "593A.T")).toThrow();
    expect(() => proveIntraRecoveryCapture(capture(), window, "598A.T")).toThrow();
    const json = JSON.parse(new TextDecoder().decode(original.bytes));json.chart.result[0].meta.currency = null;
    expect(() => proveIntraRecoveryCapture(capture(undefined, { bytes: new TextEncoder().encode(JSON.stringify(json)) }), window, "593A.T")).toThrow();
  });
});
