/** Exact retained 1798 Yahoo body / issuer evidence; no live requests or generated prices. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import app from "../../../services/vwap-analysis/app.js";
import { parseDailyChart } from "./client.js";
import { assertCorporateEventsShape, corporateEventDateBasis, corporateEventPins, corporateSplitProjection,
  mergeCorporateEvents, priceSnapshotJson, type CorporateEvents } from "./corporate-events.js";
import { assertSavedDailyShape } from "../../../scripts/vwap/lib/ingest-guard.js";
const path = "../../../services/yuho-quant/src/tests/fixtures/holdings-split-1798/";
const read = (file: string) => readFileSync(new URL(path + file, import.meta.url));
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const provenance = JSON.parse(read("provenance.json").toString()), legal = JSON.parse(read("qualified-evidence.json").toString());
const archive = read("price-raw.json.gz");
const member = JSON.parse(gunzipSync(archive).toString()).members.find((m: { api: string; symbol: string }) => m.api === "daily" && m.symbol === "1798.T");
const bytes = Buffer.from(member.bodyBase64, "base64");
async function actual() {
  expect(hash(archive)).toBe(provenance.price.gzipSha256);
  expect(hash(bytes)).toBe(provenance.member.sha256); expect(bytes.length).toBe(provenance.member.byteLength);
  return parseDailyChart(member.symbol, "10y", bytes, member.receivedAt);
}
const daily = (value: Awaited<ReturnType<typeof actual>>, events: CorporateEvents) => ({ code: "1798", updated: value.proof.observedAt,
  bars: value.bars, splits: value.splits, proof: value.proof, corporateEvents: events });
const get = (value: unknown) => app.request("/api/daily?code=1798", {}, { BUCKET: { get: async () => ({ text: async () => JSON.stringify(value) }) } } as never);

describe("Yahoo報告分割日と法的効力日の明示契約", () => {
  it("実1798の3/30を4/1へ読み替えず、原timestamp/株価/出来高/係数/SHAを保つ", async () => {
    const value = await actual(), events = value.corporateEvents!;
    const split = events.splits.find(r => r.value.date === "2026-03-30")!;
    expect(split.value.ratio).toBe(5);
    expect(legal.preSplitFiscalYearBasis.legalEffectiveDate).toBe("2026-04-01");
    expect(split.value.date).not.toBe(legal.preSplitFiscalYearBasis.legalEffectiveDate);
    expect(events.dateBasis).toEqual({ status: "reported-timestamp-only", splitDate: "yahoo-event-timestamp-jst",
      marketExDate: "not-verified", legalEffectiveDate: "not-verified", legacySplitDate: "unknown" });
    expect(split.value.dateMeaning).toBe("split-effective"); // Preserved serialization label, not legal qualification.
    const original = (Object.values(JSON.parse(bytes.toString()).chart.result[0].events.splits) as Array<{ date: number; numerator: number; denominator: number }>)
      .find(r => r.date === split.value.timestamp)!;
    expect(split.value.numerator).toBe(original.numerator); expect(split.value.denominator).toBe(original.denominator);
    expect(events.source.bodySha256).toBe(hash(bytes)); expect(events.source.fetchedAt).toBe(member.receivedAt);
    expect(events.source.priceSnapshotSha256).toBe(hash(priceSnapshotJson(value.bars)));
    for (const pin of corporateEventPins(events)) expect(hash(pin.json)).toBe(pin.sha256);
    assertSavedDailyShape(JSON.stringify(daily(value, events)), "daily/1798.json", "1798");
    const response = await get(daily(value, events)); expect(response.status).toBe(200);
    const api = await response.json(); expect(api.corporateEventDateBasis).toEqual(events.dateBasis);
    expect(api.bars).toEqual(value.bars); expect(api.splits).toEqual(value.splits); expect(api.corporateEvents).toEqual(events);
    expect(await actual()).toEqual(value); expect(hash(bytes)).toBe(provenance.member.sha256);
  });
  it("旧schema1投影のvalue/hash/versionを変えずに読み、APIは旧ラベルの意味未資格を明示する", async () => {
    const value = await actual(), fresh = value.corporateEvents!, legacy = structuredClone(fresh);
    // Explicit compatibility projection of the exact raw source, not a claimed native saved response.
    delete legacy.dateBasis;
    const oldBytes = JSON.stringify(legacy), oldPins = corporateEventPins(legacy);
    assertCorporateEventsShape(legacy, "1798.T");
    expect(corporateEventDateBasis(legacy).status).toBe("legacy-meaning-unqualified");
    assertSavedDailyShape(JSON.stringify(daily(value, legacy)), "daily/1798.json", "1798");
    const response = await get(daily(value, legacy)); expect(response.status).toBe(200);
    const api = await response.json(); expect(api.corporateEvents).toEqual(legacy);
    expect(api.corporateEventDateBasis).toEqual({ ...fresh.dateBasis, status: "legacy-meaning-unqualified" });
    const merged = mergeCorporateEvents(legacy, fresh, value.splits);
    expect(merged.dateBasis).toEqual(fresh.dateBasis); expect(merged.splits).toEqual(legacy.splits);
    expect(merged.dividends).toEqual(legacy.dividends); expect(corporateEventPins(merged)).toEqual(oldPins);
    expect(corporateSplitProjection(merged)).toEqual(value.splits);
    expect(JSON.stringify(legacy)).toBe(oldBytes);
  });
  it("法的/市場日付の資格を偽装したmetadataや未知contractは保存/APIの共通境界でSTOP", async () => {
    const value = await actual();
    for (const basis of [null, {}, { ...value.corporateEvents!.dateBasis, legalEffectiveDate: "verified" },
      { ...value.corporateEvents!.dateBasis, marketExDate: "verified" },
      { ...value.corporateEvents!.dateBasis, status: "legacy-meaning-unqualified" },
      { ...value.corporateEvents!.dateBasis, extra: "unknown" }]) {
      const bad = structuredClone(daily(value, value.corporateEvents!));
      (bad.corporateEvents as unknown as { dateBasis: unknown }).dateBasis = basis;
      expect(() => assertSavedDailyShape(JSON.stringify(bad), "daily/1798.json", "1798")).toThrow();
      expect((await get(bad)).status).toBe(500);
    }
  });
});
