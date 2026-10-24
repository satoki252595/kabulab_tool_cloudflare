import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { runMarketContextSync } from "./daily.js";
import { fetchChart, parseChartResponse } from "../shared/yahoo/client.js";
import { guardChartBars } from "../shared/yahoo/bar-sanity.js";
import { fetchNikkeiVi } from "../shared/yahoo/nikkei-vi.js";
import { recordPrimaryData, verifyArchivedAttachments } from "../shared/notion-archive/index.js";
import { captureMacroJpLeg, loadMacroJpLeg, macroJpCacheKey, qualifyMacroJpRaw, type MacroJpLegStore } from "./macro-jp-leg.js";
import type { YahooRawCapture } from "../shared/yahoo/client.js";
vi.mock("../shared/yahoo/nikkei-vi.js", async (original) => ({ ...await original<typeof import("../shared/yahoo/nikkei-vi.js")>(), fetchNikkeiVi: vi.fn() }));
vi.mock("../shared/notion-archive/index.js", async (original) => ({ ...await original<typeof import("../shared/notion-archive/index.js")>(), recordPrimaryData: vi.fn(), verifyArchivedAttachments: vi.fn() }));
vi.mock("../shared/yahoo/client.js", async (original) => ({ ...await original<typeof import("../shared/yahoo/client.js")>(), fetchChart: vi.fn() }));
const date = "2026-09-29";
const enc = new TextEncoder();
/** SYMBOLIC mechanism fixture: real bars, test-only closed-session metadata (not a captured evening proof). */
function n225Raw(change?: (raw: ReturnType<typeof JSON.parse>) => void): YahooRawCapture {
  const j = JSON.parse(readFileSync(new URL("./__fixtures__/macro-canonical/n225-20260930.json", import.meta.url), "utf8"));
  const r = j.chart.result[0];
  r.timestamp.pop();
  for (const quote of r.indicators.quote) for (const values of Object.values(quote)) (values as unknown[]).pop();
  for (const quote of r.indicators.adjclose) quote.adjclose.pop();
  const sec = (s: string) => Date.parse(s) / 1000;
  r.meta.currentTradingPeriod.regular = { start: sec(`${date}T09:00:00+09:00`), end: sec(`${date}T15:30:00+09:00`) };
  r.meta.regularMarketTime = sec(`${date}T15:30:00+09:00`);
  change?.(j);
  return { symbol: "^N225", status: 200, receivedAt: `${date}T09:00:00Z`, url: "https://test.invalid/symbolic", headers: {}, bytes: enc.encode(JSON.stringify(j)) };
}
function viRaw(tick = `${date}T15:50:00+09:00`, rawDate = date) {
  const state = { symbolInfo: { RESPONSE: { ohlc: { DPP: "30", PRP: "29", DYWP: "1", DYRP: "3.45", ZXD: rawDate, "DPP:T": tick } } } };
  return { status: 200, receivedAt: `${date}T09:00:01Z`, bytes: enc.encode(`<title>SYMBOLIC TEST ONLY</title><script>window.__INITIAL_STATE__=${JSON.stringify(state)};</script>`) };
}
function memoryStore() {
  const objects = new Map<string, string>();
  const store: MacroJpLegStore = {
    get: vi.fn(async (key) => objects.has(key) ? { body: objects.get(key)!, etag: "observed" } : null),
    put: vi.fn(async (key, body, observed) => { if (observed !== null || objects.has(key)) throw new Error("CAS rejected"); objects.set(key, body); }),
  };
  return { store, objects };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${date}T09:00:01Z`));
  vi.mocked(recordPrimaryData).mockResolvedValue({ pageId: "test-jp-page", outcome: "recorded", fileTooLarge: false, manifestMatch: "written" });
  vi.mocked(verifyArchivedAttachments).mockResolvedValue(undefined);
  vi.mocked(fetchNikkeiVi).mockImplementation(async (options) => {
    const raw = viRaw();
    await options?.onRaw?.(raw);
    return { price: 30, previousClose: 29, change: 1, changePct: 3.45, date, latestTimestamp: `${date}T15:50:00+09:00` };
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
describe("日本引け原本の翌朝持越し", () => {
  it("VI1GETだけで保管、N225は既存一次原本参照、CAS/readback後に朝は取得0で再parseする", async () => {
    const { store, objects } = memoryStore();
    expect(await captureMacroJpLeg({ date, runId: "test-1", n225: n225Raw(), n225ArchivePages: ["test-n225-page"], store })).toMatchObject({ ok: true });
    expect(fetchNikkeiVi).toHaveBeenCalledTimes(1);
    expect(store.put).toHaveBeenCalledTimes(1);
    expect(vi.mocked(store.put).mock.calls[0][2]).toBeNull();
    const files = vi.mocked(recordPrimaryData).mock.calls[0][0].files!;
    expect(files.map((f) => f.filename)).toEqual(["macro-jp-manifest.json", "macro-jp-VI.html"]);
    expect(new TextDecoder().decode(files[0].bytes)).toContain("test-n225-page");
    vi.setSystemTime(new Date(`${date}T21:00:01Z`));
    const leg = await loadMacroJpLeg(store, date);
    expect(leg).toMatchObject({ n225: { date }, nikkeiVi: 30, nikkeiViDate: date, reference: { expectedDate: date, archivePageId: "test-jp-page" } });
    expect(verifyArchivedAttachments).toHaveBeenCalledTimes(2);
    expect(fetchNikkeiVi).toHaveBeenCalledTimes(1);
    expect(objects.size).toBe(1);
    // 同予定日再実行は既存原本を再照合し、VI再取得・R2上書きを行わない。
    expect(await captureMacroJpLeg({ date, runId: "test-2", n225: n225Raw(), n225ArchivePages: ["new-unused-capture"], store })).toMatchObject({ ok: true });
    expect(fetchNikkeiVi).toHaveBeenCalledTimes(1);
    expect(store.put).toHaveBeenCalledTimes(1);
  });
  it("夕方guard N2251 + VI1、翌朝米3 = 通常5GET、二段原本照合後だけ同日D1へ書く", async () => {
    const { store } = memoryStore();
    const rawN225 = n225Raw();
    const usFiles: Record<string, string> = { "^VIX": "vix-20260930.json", "^GSPC": "gspc-20260930.json", "NIY=F": "niy-20260930.json" };
    vi.mocked(fetchChart).mockImplementation(async (symbol, _range, options) => {
      const raw = symbol === "^N225" ? rawN225.bytes : new Uint8Array(readFileSync(new URL(`./__fixtures__/macro-canonical/${usFiles[symbol]}`, import.meta.url)));
      const parsed = parseChartResponse(JSON.parse(new TextDecoder().decode(raw)), symbol);
      const { bars } = guardChartBars(parsed.bars, parsed.meta.regularMarketPrice, symbol);
      await options?.onRaw?.({ ...rawN225, symbol, receivedAt: new Date().toISOString(), bytes: raw });
      return { symbol, price: parsed.meta.regularMarketPrice, previousClose: parsed.meta.previousClose, dataDate: bars.at(-1)!.date, ohlcv: bars };
    });
    // stocks-sessionの既存guard1GETと保管成功後の同じbytes受渡しを再現する。
    await fetchChart("^N225", "1mo");
    await captureMacroJpLeg({ date, runId: "test-evening", n225: rawN225, n225ArchivePages: ["test-n225-page"], store });
    vi.setSystemTime(new Date(`${date}T21:00:01Z`));
    vi.stubEnv("STOCK_SYNC_TARGET", "scheduled-context");
    vi.stubEnv("SCHEDULED_DATE", date);
    vi.stubEnv("SCHEDULED_AT", `${date}T21:00:01.000Z`);
    const writes: { sql: string; params: unknown[] }[] = [];
    const db = drizzle(async (sql, params) => { writes.push({ sql, params }); return { rows: [] }; });
    expect(await runMarketContextSync(db as unknown as Parameters<typeof runMarketContextSync>[0], store)).toBe(true);
    expect(vi.mocked(fetchChart).mock.calls.map(([symbol]) => symbol)).toEqual(["^N225", "^VIX", "^GSPC", "NIY=F"]);
    expect(fetchNikkeiVi).toHaveBeenCalledTimes(1);
    expect(fetchChart).toHaveBeenCalledTimes(4);
    expect(writes).toHaveLength(1);
    expect(writes[0].params[0]).toBe(date);
    const composite = vi.mocked(recordPrimaryData).mock.calls.at(-1)![0];
    expect(composite.files?.map((file) => file.filename).sort()).toEqual(["macro-GSPC-attempt0.json", "macro-NIY-attempt0.json", "macro-VIX-attempt0.json", "macro-manifest.json"]);
    expect(verifyArchivedAttachments).toHaveBeenCalledTimes(3);
  });
  it.each([
    ["forming", (j: ReturnType<typeof JSON.parse>) => { j.chart.result[0].meta.regularMarketTime -= 60; }],
    ["old-current-period", (j: ReturnType<typeof JSON.parse>) => { j.chart.result[0].meta.currentTradingPeriod.regular.start -= 86400; j.chart.result[0].meta.currentTradingPeriod.regular.end -= 86400; }],
    ["future-observation", (j: ReturnType<typeof JSON.parse>) => { j.chart.result[0].meta.regularMarketTime += 86400; }],
    ["null-close", (j: ReturnType<typeof JSON.parse>) => { j.chart.result[0].indicators.quote[0].close[1] = null; }],
  ])("N225 %sは確定日だけが同じでも採用しない", (_label, change) => {
    expect(() => qualifyMacroJpRaw(date, n225Raw(change), viRaw())).toThrow(/HOLD/);
  });
  it("明示次sessionへroll済みでも同D実close+同D引け後quoteだけを採用し、日中quoteはHOLD", () => {
    const next = (j: ReturnType<typeof JSON.parse>) => { j.chart.result[0].meta.currentTradingPeriod.regular.start += 86400; j.chart.result[0].meta.currentTradingPeriod.regular.end += 86400; };
    expect(qualifyMacroJpRaw(date, n225Raw(next), viRaw())).toMatchObject({ n225: { date } });
    expect(() => qualifyMacroJpRaw(date, n225Raw((j) => { next(j); j.chart.result[0].meta.regularMarketTime -= 3600; }), viRaw())).toThrow(/HOLD/);
  });
  it.each([`${date}T15:44:59+09:00`, "2026-09-28T15:50:00+09:00", `${date}T19:00:00+09:00`])("VIの古い日中値・別日・未来tick %sを採らない", (tick) => {
    expect(() => qualifyMacroJpRaw(date, n225Raw(), viRaw(tick, tick.slice(0, 10)))).toThrow(/HOLD|一致/);
  });
  it("原本不一致・別予定日・欠測・Notion readback障害に取得や上書きで代替しない", async () => {
    const { store, objects } = memoryStore();
    expect(await loadMacroJpLeg(store, date)).toBeNull();
    await captureMacroJpLeg({ date, runId: "test", n225: n225Raw(), n225ArchivePages: ["test-n225-page"], store });
    expect(await loadMacroJpLeg(store, "2026-09-30")).toBeNull();
    const key = macroJpCacheKey(date), body = objects.get(key)!;
    const cache = JSON.parse(body);
    cache.n225.bodyBase64 = btoa("tampered");
    objects.set(key, JSON.stringify(cache));
    await expect(loadMacroJpLeg(store, date)).rejects.toThrow(/SHA/);
    objects.set(key, body);
    vi.mocked(verifyArchivedAttachments).mockRejectedValue(new Error("physical bytes mismatch"));
    await expect(loadMacroJpLeg(store, date)).rejects.toThrow("physical bytes mismatch");
    expect(fetchNikkeiVi).toHaveBeenCalledTimes(1);
    expect(store.put).toHaveBeenCalledTimes(1);
  });
  it("対象日N225のsession終了証明が無ければVIを取得せずHOLD原本参照だけ保管する", async () => {
    const { store } = memoryStore();
    const n225 = n225Raw((j) => { j.chart.result[0].meta.regularMarketTime -= 60; });
    expect(await captureMacroJpLeg({ date, runId: "test", n225, n225ArchivePages: ["test-n225-page"], store })).toMatchObject({ ok: false });
    expect(fetchNikkeiVi).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
    expect(vi.mocked(recordPrimaryData).mock.calls[0][0].files).toHaveLength(1);
  });
  it("VI既知取得失敗は原本/理由を保管してHOLD、R2へ部分成功を置かない", async () => {
    const { store } = memoryStore();
    vi.mocked(fetchNikkeiVi).mockRejectedValue(new Error("VI unavailable"));
    expect(await captureMacroJpLeg({ date, runId: "test", n225: n225Raw(), n225ArchivePages: ["test-n225-page"], store })).toEqual({ ok: false, reason: "VI unavailable" });
    expect(store.put).not.toHaveBeenCalled();
    const files = vi.mocked(recordPrimaryData).mock.calls[0][0].files!;
    expect(files).toHaveLength(1);
    expect(new TextDecoder().decode(files[0].bytes)).toContain("VI unavailable");
  });
  it("Notion unknownとR2 unknownは再送しない、全bytes照合より先にPUTしない", async () => {
    const { store } = memoryStore();
    vi.mocked(verifyArchivedAttachments).mockRejectedValue(new Error("Notion unknown"));
    await expect(captureMacroJpLeg({ date, runId: "test", n225: n225Raw(), n225ArchivePages: ["test-n225-page"], store })).rejects.toThrow("Notion unknown");
    expect(store.put).not.toHaveBeenCalled();
    vi.mocked(verifyArchivedAttachments).mockResolvedValue(undefined);
    vi.mocked(store.put).mockRejectedValue(new Error("R2 unknown"));
    await expect(captureMacroJpLeg({ date, runId: "test2", n225: n225Raw(), n225ArchivePages: ["test-n225-page"], store })).rejects.toThrow("R2 unknown");
    expect(store.put).toHaveBeenCalledTimes(1);
  });
});
