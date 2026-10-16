import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildStockCorporateDiagnostics, extractStockCorporateEvents } from "./stock-corporate-events.js";
import { parseChartResponse } from "./client.js";
import { buildPriceSyncBatch } from "../../cron/daily.js";

const bytes = readFileSync(new URL("./fixtures/stock-corporate-events-20261014.json.gz", import.meta.url));
const fixture = JSON.parse(gunzipSync(bytes).toString()) as Record<string, { json: unknown; receivedAt: string }>;
const proof = JSON.parse(readFileSync(new URL("./fixtures/stock-corporate-events-20261014.provenance.json", import.meta.url), "utf8")) as {
  gzipSha256: string; members: { code: string; projectionSha256: string }[];
};
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const chart = (json: unknown) => (json as { chart: { result: { events?: unknown }[] } }).chart.result[0];
function diagnostic(code: string) {
  const { json, receivedAt } = fixture[code], bars = parseChartResponse(json, code).bars;
  return buildStockCorporateDiagnostics({ events: extractStockCorporateEvents(json, receivedAt),
    code, bodySha256: sha(JSON.stringify(json)), receivedAt, suppliedBars: bars, qualifiedBars: bars });
}

describe("株式報告権利と実使用窓 (保存実原本projection・価格補正なし)", () => {
  it("原SHAを検証し、実分割/併合のdictionary/epoch/ratioを取り出す", () => {
    expect(sha(bytes)).toBe(proof.gzipSha256);
    for (const member of proof.members) expect(sha(JSON.stringify(fixture[member.code].json))).toBe(member.projectionSha256);
    const split = extractStockCorporateEvents(fixture["4374"].json, fixture["4374"].receivedAt).reported
      .find(e => e.kind === "splits" && e.date === "2026-09-29");
    expect(split).toMatchObject({ kind: "splits", numerator: 2, denominator: 1, ratio: 2, splitRatio: "2:1" });
    expect(split!.dictionaryKey).toBe(String(split!.epoch));
    expect(extractStockCorporateEvents(fixture["9252"].json, fixture["9252"].receivedAt).reported)
      .toContainEqual(expect.objectContaining({ kind: "splits", date: "2025-08-07", numerator: 1, denominator: 1.2, ratio: 1 / 1.2 }));
  });

  it("ATR130/volume21/range20/last2/adj90は同一資格列へ結び、分割を二重適用しない", () => {
    const before = structuredClone(fixture), d = diagnostic("4374");
    expect(Object.fromEntries(Object.entries(d.windows).map(([k, v]) => [k, v.rows])))
      .toEqual({ atr130: 130, volume21: 21, range20: 20, close2: 2, adjustedMomentum90: 90 });
    for (const key of ["atr130", "volume21", "range20", "adjustedMomentum90"] as const) {
      expect(d.windows[key].reportedEventReferences.some(r => r.includes(".splits."))).toBe(true);
    }
    expect(d.windows.close2.reportedEventReferences.some(r => r.includes(".splits."))).toBe(false);
    expect(d.basis).toEqual({ ohlc: "unknown", volume: "unknown", dividendShareBasis: "unknown", localAdjustment: "none" });
    expect(fixture).toEqual(before);
  });

  it("実7203の配当とclose/adj差は診断だけを残し、HOLD/代用値へ変換しない", () => {
    const bars = parseChartResponse(fixture["7203"].json, "7203").bars;
    expect(bars.some(b => b.adj !== b.close)).toBe(true);
    const events = extractStockCorporateEvents(fixture["7203"].json, fixture["7203"].receivedAt);
    expect(events.reported).toContainEqual(expect.objectContaining({ kind: "dividends", date: "2026-09-29", amount: 50 }));
    expect(diagnostic("7203").unknownReasons).toContain("rights-issues-capital-increases-and-other-legal-actions-not-covered");
  });

  it("省略/null/空/観測とcapitalGains未要求を区別し、全権利なしとは言わない", () => {
    for (const [value, expected] of [[undefined, "absent"], [null, "null"], [{}, "empty"], [{ splits: {} }, "observed"]] as const) {
      const input = structuredClone(fixture["4374"].json);
      if (value === undefined) delete chart(input).events;
      else chart(input).events = value;
      const events = extractStockCorporateEvents(input, fixture["4374"].receivedAt);
      expect(events.observation.events).toBe(expected);
      expect(events.observation.splits).toBe(value === undefined ? "events-absent" : value === null ? "events-null" : "splits" in value ? "empty" : "absent");
    }
    expect(diagnostic("4374").unknownReasons).toContain("capitalGains-not-requested");
  });

  it("構造異常/未来/ratio不整合/未知kindをSTOPし、任意のイベントなしへ落とさない", () => {
    const source = fixture["4374"], extracted = extractStockCorporateEvents(source.json, source.receivedAt);
    const event = extracted.reported.find(e => e.kind === "splits")!;
    const raw = (chart(source.json).events as Record<string, Record<string, unknown>>).splits[event.dictionaryKey];
    for (const events of [[], { other: {} }, { splits: [] }, { splits: { wrongKey: raw } },
      { splits: { [event.dictionaryKey]: { ...(raw as object), denominator: 0 } } },
      { splits: { [event.dictionaryKey]: { ...(raw as object), splitRatio: "1:1" } } },
      { dividends: { [event.dictionaryKey]: { date: event.epoch, amount: -1 } } }]) {
      const json = structuredClone(source.json); chart(json).events = events;
      expect(() => extractStockCorporateEvents(json, source.receivedAt)).toThrow(/STOP/);
    }
    expect(() => extractStockCorporateEvents(source.json, "invalid")).toThrow(/STOP/);
    expect(() => extractStockCorporateEvents(source.json, "2000-01-01T00:00:00.000Z")).toThrow(/STOP/);
    for (const mutate of [
      (r: Record<string, unknown>) => { const ts = r.timestamp as number[]; ts[1] = ts[0]; },
      (r: Record<string, unknown>) => { const ts = r.timestamp as number[]; ts.reverse(); },
      (r: Record<string, unknown>) => { (r.meta as Record<string, unknown>).range = "1mo"; },
      (r: Record<string, unknown>) => { const q = (r.indicators as { quote: { close: number[] }[] }).quote[0]; q.close.pop(); },
    ]) {
      const input = structuredClone(source.json); mutate(chart(input) as Record<string, unknown>);
      expect(() => extractStockCorporateEvents(input, source.receivedAt)).toThrow(/STOP/);
    }
  });

  it("短い系列/欠測を窓情報に残し、同じ必須batch物理ファイルへ原本参照を記録する", () => {
    const source = fixture["4374"], bars = parseChartResponse(source.json, "4374").bars.slice(-2);
    bars[0] = { ...bars[0], volume: null, high: null, adj: null };
    const d = buildStockCorporateDiagnostics({ events: extractStockCorporateEvents(source.json, source.receivedAt),
      code: "4374", bodySha256: sha(JSON.stringify(source.json)), receivedAt: source.receivedAt, suppliedBars: bars, qualifiedBars: bars });
    expect(d.windows.atr130).toMatchObject({ rows: 1, completeRequestedWindow: false });
    expect(d.windows.volume21).toMatchObject({ rows: 2, missingValues: { volume: 1 }, completeRequestedWindow: false });
    expect(d.windows.adjustedMomentum90.missingValues.adj).toBe(1);
    const entries = [{ code: "4374", attempt: 0, expectedDate: "2026-10-14", diagnostic: d }];
    const batch = buildPriceSyncBatch({ mode: "stocks", runId: "38539360030.1", startedAt: source.receivedAt,
      finishedAt: source.receivedAt, tradingDate: "2026-10-14", totalStocks: 1, successStocks: 1, failedStocks: 0,
      failures: [], failureCollection: "complete", originalError: null, corporateDiagnostics: entries });
    expect(JSON.parse(new TextDecoder().decode(batch.file.bytes)).corporateDiagnostics).toEqual(entries);
    expect(JSON.stringify(d)).not.toContain('"numerator"'); // 原値の再コピーではなくraw内参照
  });
});
