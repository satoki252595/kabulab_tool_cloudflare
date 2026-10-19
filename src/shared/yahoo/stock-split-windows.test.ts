import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildStockSnapshot } from "../../cron/daily.js";
import { screenStock } from "../screener.js";
import { buildStockCorporateDiagnostics, extractStockCorporateEvents, STOCK_SPLIT_WINDOW_HOLD } from "./stock-corporate-events.js";
import { parseChartResponse, parseSavedStockRawData, type SavedYahooRawCapture } from "./client.js";

const gzip = readFileSync(new URL("./fixtures/stock-split-windows-20261016.json.gz", import.meta.url));
const fixture = JSON.parse(gunzipSync(gzip).toString()) as Record<string, string>;
const proof = JSON.parse(readFileSync(new URL("./fixtures/stock-split-windows-20261016.provenance.json", import.meta.url), "utf8")) as {
  gzipSha256: string; members: { key: string; sourceSha256: string; sourceBytes: number; receivedAt: string }[];
};
const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const raws = new Map<string, Awaited<ReturnType<typeof parseSavedStockRawData>>>();
const reasons = new Set<string>(Object.values(STOCK_SPLIT_WINDOW_HOLD));
function capture(code: string, api: "chart" | "quote-summary"): SavedYahooRawCapture {
  const member = proof.members.find(m => m.key === `${code}-${api}`)!;
  const bytes = Buffer.from(fixture[member.key]);
  // Declared protocol URL only: the original unmodified bodies/SHA/clock are retained in provenance.
  const url = api === "chart"
    ? `https://query1.finance.yahoo.com/v8/finance/chart/${code}.T?range=5y&interval=1d&events=split%2Cdiv`
    : `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${code}.T?modules=financialData,defaultKeyStatistics,summaryDetail,incomeStatementHistory`;
  return { capture: { symbol: code, status: 200, bytes, url, receivedAt: member.receivedAt, headers: {} },
    expectedSha256: member.sourceSha256, expectedByteLength: member.sourceBytes };
}
function snapshot(code: string, removeNewHolds = false) {
  const raw = structuredClone(raws.get(code)!);
  if (removeNewHolds && raw.corporateDiagnostics) raw.corporateDiagnostics.unknownReasons =
    raw.corporateDiagnostics.unknownReasons.filter(r => !reasons.has(r));
  return buildStockSnapshot(1, code, null, "2026-10-16", raw, { kind: "unverified", reason: "no-forecast-row" });
}
function diagnostic(code: string, bars = parseChartResponse(JSON.parse(fixture[`${code}-chart`]), code).bars, json = JSON.parse(fixture[`${code}-chart`])) {
  const receivedAt = proof.members.find(m => m.key === `${code}-chart`)!.receivedAt;
  return buildStockCorporateDiagnostics({ events: extractStockCorporateEvents(json, receivedAt), code,
    receivedAt, bodySha256: sha(JSON.stringify(json)), suppliedBars: bars, qualifiedBars: bars });
}
beforeAll(async () => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("saved fixture tests forbid HTTP"); }));
  for (const code of ["4374", "2814", "9252", "8303", "7203"]) raws.set(code,
    await parseSavedStockRawData(code, { chart: capture(code, "chart"), summary: capture(code, "quote-summary") }));
});
afterAll(() => vi.unstubAllGlobals());

describe("報告splitの実使用窓だけHOLD (実原本・係数再適用なし)", () => {
  it("unmodified5社原本の全SHA/bytesを確認し、4374の実9/29split跨ぎだけ該当derivedをNULLにする", () => {
    expect(sha(gzip)).toBe(proof.gzipSha256);
    for (const m of proof.members) { expect(sha(fixture[m.key])).toBe(m.sourceSha256); expect(Buffer.byteLength(fixture[m.key])).toBe(m.sourceBytes); }
    const original = structuredClone(raws.get("4374")), after = snapshot("4374"), before = snapshot("4374", true);
    const held = ["atr14", "atrPct", "volume20d", "volumeRatio", "avgTurnover20d", "range20dHigh", "range20dLow", "rangeWidth", "fib382", "fib500", "fib618"] as const;
    for (const k of held) { expect(before[k]).not.toBeNull(); expect(after[k]).toBeNull(); }
    for (const k of Object.keys(before) as (keyof typeof before)[]) if (!held.includes(k as typeof held[number]) && k !== "corporateDiagnostics") expect(after[k]).toEqual(before[k]);
    expect(after.corporateDiagnostics!.unknownReasons).toContain(STOCK_SPLIT_WINDOW_HOLD.atr130);
    expect(after.pctChange1d).toBe(before.pctChange1d);
    expect(raws.get("4374")).toEqual(original); // Raw OHLCV/adj/source clocks are never mutated.
    expect(screenStock({ avgTurnover20d: after.avgTurnover20d, volumeRatio: after.volumeRatio,
      atrPct: after.atrPct, sma5: after.sma5, sma20: after.sma20, latestClose: after.ohlcv6mo.at(-1)!.adj! }))
      .toMatchObject({ liquidityOk: false, volatilityOk: false, allPassedLong: false, allPassedShort: false });
  });

  it("8303・7203・9252の非跨ぎは全値同じ、8303の既存RSI履歴HOLDと原価格を保持", () => {
    for (const code of ["8303", "7203", "9252"]) expect(snapshot(code)).toEqual(snapshot(code, true));
    expect(snapshot("8303").rsiHistoryHold).toMatchObject({ invalidBars: 245, reasonCode: "non_positive_adjusted_close" });
    expect(snapshot("8303").latestClose).toBe(1478.5);
    expect(snapshot("7203").latestClose).toBe(3094);
  });

  it("2814のvolume21先頭=報告split当日は跨ぎでないため出来高比を保持", () => {
    const raw = raws.get("2814")!, d = raw.corporateDiagnostics!;
    expect(d.windows.volume21.firstDate).toBe("2026-09-14");
    expect(d.windows.volume21.reportedEventReferences.some(r => r.includes(".splits."))).toBe(true);
    expect(d.unknownReasons).not.toContain(STOCK_SPLIT_WINDOW_HOLD.volume21);
    expect(snapshot("2814").volumeRatio).toBe(snapshot("2814", true).volumeRatio);
    expect(snapshot("2814").volumeRatio).not.toBeNull();
  });

  it("明示nullable投影: pre-splitのhigh/lowをNULLにすればrangeの実使用日は分割後だけ、volumeは別窓のまま", () => {
    const bars = parseChartResponse(JSON.parse(fixture["4374-chart"]), "4374").bars;
    const changed = bars.map(b => b.date < "2026-09-29" ? { ...b, high: null, low: null } : b);
    const d = diagnostic("4374", changed);
    expect(d.unknownReasons).not.toContain(STOCK_SPLIT_WINDOW_HOLD.range20);
    expect(d.unknownReasons).not.toContain(STOCK_SPLIT_WINDOW_HOLD.atr130); // <15 usable OHLC rows: existing ATR already NULL.
    expect(d.unknownReasons).toContain(STOCK_SPLIT_WINDOW_HOLD.volume21);
    const missingVolume = diagnostic("4374", bars.map(b => b.date === "2026-09-28" ? { ...b, volume: null } : b));
    for (const reason of [STOCK_SPLIT_WINDOW_HOLD.volume20, STOCK_SPLIT_WINDOW_HOLD.volume21, STOCK_SPLIT_WINDOW_HOLD.turnover20]) {
      expect(missingVolume.unknownReasons).not.toContain(reason); // Existing incomplete averages already NULL.
    }
    expect(missingVolume.unknownReasons).toContain(STOCK_SPLIT_WINDOW_HOLD.atr130);
  });

  it("保存historical subsetでlast2を跨ぐと前日比だけHOLD、split当日からの2行はHOLDしない", () => {
    const bars = parseChartResponse(JSON.parse(fixture["4374-chart"]), "4374").bars;
    const historical = bars.filter(b => b.date <= "2026-09-29").slice(-2);
    expect(historical.map(b => b.date)).toEqual(["2026-09-28", "2026-09-29"]);
    expect(diagnostic("4374", historical).unknownReasons).toContain(STOCK_SPLIT_WINDOW_HOLD.close2);
    expect(diagnostic("4374", historical.map((b, i) => i === 0 ? { ...b, close: null } : b)).unknownReasons)
      .not.toContain(STOCK_SPLIT_WINDOW_HOLD.close2); // Only one effective close: existing calculation is unavailable.
    expect(diagnostic("4374", bars.filter(b => b.date >= "2026-09-29").slice(0, 2)).unknownReasons)
      .not.toContain(STOCK_SPLIT_WINDOW_HOLD.close2);
  });

  it("9252の実1:1.2逆分割もhistorical実使用窓で保留 (予定日/法的効力日へ読み替えない)", () => {
    const bars = parseChartResponse(JSON.parse(fixture["9252-chart"]), "9252").bars.filter(b => b.date <= "2025-08-07");
    const d = diagnostic("9252", bars);
    expect(d.unknownReasons).toContain(STOCK_SPLIT_WINDOW_HOLD.atr130);
    expect(d.unknownReasons).toContain(STOCK_SPLIT_WINDOW_HOLD.close2);
    expect(d.eventDateBasis).toContain("legal-effective-date-unverified");
  });

  it("明示events欠測をsplit無しの証明にせず、malformed ratioは既存STOPのまま", () => {
    const json = JSON.parse(fixture["4374-chart"]); delete json.chart.result[0].events;
    const d = diagnostic("4374", undefined, json);
    expect(d.observation.splits).toBe("events-absent");
    expect(d.unknownReasons).toContain("reported-events-only;omission-is-not-none");
    expect(d.unknownReasons.some(r => reasons.has(r))).toBe(false);
    const bad = JSON.parse(fixture["4374-chart"]), split = Object.values(bad.chart.result[0].events.splits)[0] as { denominator: number };
    split.denominator = 0;
    expect(() => diagnostic("4374", undefined, bad)).toThrow(/STOP/);
  });
});
