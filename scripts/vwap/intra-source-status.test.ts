import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeIntraSource, parseBars5m, YahooIntraSourceUnavailableError, type YahooRawCapture } from "../../src/shared/yahoo/client.js";
import { isIntraSourceStatus } from "../../src/shared/vwap/proof.js";
import { retainIntraSourceStatus, shouldSkipPut } from "./lib/ingest-guard.js";
import app from "../../services/vwap-analysis/app.js";

// Explicit transport projection from the saved real 7531 response, not a full-native qualification.
const fixture = JSON.parse(readFileSync(new URL("./tests/fixtures/intra-source-status-7531.json", import.meta.url), "utf8"));
const capture = (json: unknown): YahooRawCapture => ({ symbol: fixture.provenance.symbol, status: 200,
  receivedAt: fixture.provenance.receivedAt, headers: {}, url: "https://query1.finance.yahoo.com/v8/finance/chart/7531.T",
  bytes: new TextEncoder().encode(JSON.stringify(json)) });
const project = (indices: number[]) => {
  const json = structuredClone(fixture), r = json.chart.result[0], q = r.indicators.quote[0];
  r.timestamp = indices.map(i => r.timestamp[i]);
  for (const k of Object.keys(q)) q[k] = indices.map(i => q[k][i]);
  return json;
};

describe("shared intra source observation", () => {
  it("real valid old day plus latest NULL day is source_unavailable, without a no-trade assertion", async () => {
    const status = await describeIntraSource(capture(fixture), parseBars5m(fixture, "7531.T"));
    expect(status).toMatchObject({ status: "source_unavailable", lastSourceDate: "2026-10-16", lastValidSourceDate: "2026-10-08", observedAt: fixture.provenance.receivedAt });
    expect(isIntraSourceStatus(status)).toBe(true);
    expect(Object.keys(status).sort()).toEqual(["lastSourceDate", "lastValidSourceDate", "observedAt", "rawSha256", "status"]);
  });
  it("qualified empty and all-NULL responses remain distinct", async () => {
    const empty = project([]), missing = project([1]);
    expect(parseBars5m(empty, "7531.T")).toEqual([]);
    expect(await describeIntraSource(capture(empty), [])).toMatchObject({ status: "source_empty", lastSourceDate: null, lastValidSourceDate: null });
    expect(() => parseBars5m(missing, "7531.T")).toThrow(YahooIntraSourceUnavailableError);
    expect(await describeIntraSource(capture(missing), [])).toMatchObject({ status: "source_unavailable", lastValidSourceDate: null });
  });
  it("a valid observed last day is not asserted to cover unobserved later sessions", async () => {
    const json = project([0]);
    expect(await describeIntraSource(capture(json), parseBars5m(json, "7531.T"))).toMatchObject({ status: "source_available", lastSourceDate: "2026-10-08" });
  });
  it("malformed and invalid prices do not become source absence", () => {
    const json = project([0]); json.chart.result[0].indicators.quote[0].close[0] = -1;
    expect(() => parseBars5m(json, "7531.T")).toThrow();
    expect(() => parseBars5m(json, "7531.T")).not.toThrow(YahooIntraSourceUnavailableError);
    expect(isIntraSourceStatus({ status: "source_unavailable", observedAt: fixture.provenance.receivedAt, rawSha256: "x", lastSourceDate: "2026-10-16", lastValidSourceDate: null })).toBe(false);
  });
  it("same semantics and full bars retain old proof, while a new capture remains a separate observation", async () => {
    const bars = parseBars5m(fixture, "7531.T").map(b => ({ ...b })), saved = await describeIntraSource(capture(fixture), bars);
    const fresh = { ...saved, observedAt: "2026-10-18T01:36:00.000Z", rawSha256: "a".repeat(64) };
    const old = { code: "7531", bars, sourceStatus: saved };
    const retained = retainIntraSourceStatus(old, bars, fresh);
    expect(retained).toBe(saved); expect(retained.observedAt).not.toBe(fresh.observedAt);
    expect(shouldSkipPut(JSON.stringify(old), { ...old, sourceStatus: retained })).toBe(true);
    expect(retainIntraSourceStatus(old, [{ ...bars[0], v: bars[0].v + 1 }], fresh)).toBe(fresh);
    expect(retainIntraSourceStatus(old, bars, { ...fresh, status: "source_available", lastSourceDate: "2026-10-08" })).not.toBe(saved);
    expect(shouldSkipPut(JSON.stringify({ ...old, unexpected: true }), { ...old, sourceStatus: retained })).toBe(false);
  });
  it("API preserves the old valid bar, labels source absence, and reports last stored valid date", async () => {
    const bars = parseBars5m(fixture, "7531.T"), sourceStatus = await describeIntraSource(capture(fixture), bars);
    const read = async (body: object) => app.fetch(new Request("https://test/api/intra?code=7531"), { BUCKET: {
      get: async (key: string) => key === "intra/7531.json" ? { text: async () => JSON.stringify(body) } : null,
    } } as never, {} as never);
    const payload = { code: "7531", updated: fixture.provenance.receivedAt, bars, sourceStatus };
    const response = await read(payload); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ bars, sourceStatus, lastValidDate: "2026-10-08", basis: { qualified: false, reason: "daily-unavailable" } });
    const legacy = await read({ code: "7531", bars });
    expect(await legacy.json()).toMatchObject({ bars, sourceStatus: null, lastValidDate: "2026-10-08" });
  });
});
