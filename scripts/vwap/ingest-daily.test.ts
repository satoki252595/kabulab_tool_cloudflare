import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { R2PutRejectedError, R2PutUnknownError } from "./lib/r2.js";
import { r2GetVersion, r2Put, confirmUnknownPricePut } from "./lib/r2.js";
import { loadCodes } from "./lib/codes.js";
import { MAX_YAHOO_RAW_BYTES, YahooRawTooLargeError, parseDailyChart, type YahooRawCapture } from "../../src/shared/yahoo/client.js";
import { recordPrimaryData } from "../../src/shared/notion-archive/index.js";
import { NotionUnknownResultError } from "../../src/shared/notion-archive/client.js";
import { NotionConfigError } from "../../src/shared/notion-archive/env.js";
import { archiveYahooRawBatch } from "../../src/shared/yahoo/raw-custody.js";
import { main, tenYearRange } from "./ingest-daily.js";
import { assertSavedDailyShape, completedDailyFetch, hasCompletedDailyFetch } from "./lib/ingest-guard.js";
import { fetchDailySessionReference, qualifyDailySourceRange, loadArchivedDailySessionReference } from "./lib/daily-session.js";
import { referenceFromArchivedParts, readPriceReference, priceMetadata } from "../../src/shared/holdings/price-registry.js";
import { publishDailyPriceSnapshot } from "./lib/holdings-price-registry.js";

const dailySource = vi.hoisted(() => vi.fn());
const rawHook = vi.hoisted(() => ({ enabled: true, status: 200, size: 28, body: null as Uint8Array | null,
  replay: null as Map<string, YahooRawCapture> | null }));

vi.mock("./lib/r2.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./lib/r2.js")>();
  return { ...mod, r2GetVersion: vi.fn(), r2Put: vi.fn(), confirmUnknownPricePut: vi.fn(async error => { throw error; }) };
});
vi.mock("./lib/codes.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./lib/codes.js")>();
  return { ...mod, loadCodes: vi.fn() };
});
// この配管suiteは資格済みsessionを入力する。実原本/休日/形成中の資格はdaily-session.testで検証。
vi.mock("./lib/daily-session.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./lib/daily-session.js")>();
  return { ...mod,
    loadArchivedDailySessionReference: vi.fn(),
    fetchDailySessionReference: vi.fn(async () => ({ date: tenYearRange(new Date().toISOString()).to,
      observedAt: new Date().toISOString(), rawSha: "1".repeat(64) })),
    qualifyDailySourceRange: vi.fn(() => tenYearRange(new Date().toISOString())) };
});
vi.mock("../../src/shared/yahoo/client.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/shared/yahoo/client.js")>();
  return { ...mod, fetchDaily: async (...args: Parameters<typeof mod.fetchDaily>) => {
    if (rawHook.replay !== null) {
      const capture = rawHook.replay.get(args[0]); if (!capture) throw new Error("unexpected actual replay symbol");
      await args[2]?.onRaw?.(capture);
    } else if (rawHook.enabled) await args[2]?.onRaw?.({ symbol: args[0], status: rawHook.status,
      bytes: rawHook.body === null ? new Uint8Array(rawHook.size) : rawHook.body,
      url: `https://query1.finance.yahoo.com/v8/finance/chart/${args[0]}?range=${args[1]}&interval=1d&events=split,div`, receivedAt: new Date().toISOString(), headers: {} });
    return dailySource(...args);
  } };
});
vi.mock("../../src/shared/yahoo/raw-custody.js", () => ({ archiveYahooRawBatch: vi.fn() }));
// 配管testsのcanned proofは原本資格ではない。実member束縛は専用suite/下記回帰で検証。
vi.mock("../../src/shared/holdings/price-registry.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/shared/holdings/price-registry.js")>();
  return { ...mod, referenceFromArchivedParts: vi.fn(), readPriceReference: vi.fn(), priceMetadata: vi.fn() };
});
vi.mock("./lib/holdings-price-registry.js", () => ({ publishDailyPriceSnapshot: vi.fn() }));
vi.mock("../../src/shared/notion-archive/index.js", () => ({
  recordPrimaryData: vi.fn(),
}));
vi.mock("../../src/shared/env.js", () => ({
  sharedEnv: {
    LOCAL_OUT: () => undefined,
    R2_BUCKET: () => "test-bucket",
    R2_ACCOUNT_ID: () => "t",
    R2_ACCESS_KEY_ID: () => "t",
    R2_SECRET_ACCESS_KEY: () => "t",
    vwapKnobs: () =>
      (globalThis as { __vwapKnobs?: { conc: number; delayMs: number; maxRateLimit: number; keepDays: number } })
        .__vwapKnobs ?? { conc: 1, delayMs: 1, maxRateLimit: 5, keepDays: 365 },
  },
}));

const mockR2Get = vi.mocked(r2GetVersion);
const mockR2Put = vi.mocked(r2Put);
const mockLoadCodes = vi.mocked(loadCodes);
const mockFetchDaily = dailySource;
const mockRawArchive = vi.mocked(archiveYahooRawBatch);
const mockRecord = vi.mocked(recordPrimaryData);
const recordedBody = (): Record<string, unknown> => {
  const input = mockRecord.mock.calls[0][0] as {
    files: Array<{ bytes: Uint8Array }>;
  };
  return JSON.parse(new TextDecoder().decode(input.files[0].bytes)) as Record<string, unknown>;
};
const recordedMetadata = (): Record<string, unknown> =>
  (mockRecord.mock.calls[0][0] as { metadata: Record<string, unknown> }).metadata;

// 構造 bar の日付は run 時点の JST today (明示 10y range 内に必ず入る)。
const D_TODAY = tenYearRange(new Date().toISOString()).to;
const BAR_A = { date: D_TODAY, o: 100, h: 110, l: 90, c: 105, v: 1000 };
const BAR_B = { date: D_TODAY, o: 200, h: 210, l: 190, c: 205, v: 2000 };
/** 配管用 canned proof (形状のみ。観測値の主張ではない)。 */
const FAKE_PROOF = {
  observedAt: "2026-01-01T00:00:00.000Z",
  rawSha: "0".repeat(64),
  requestedRange: "10y",
  symbol: "TEST.T",
  firstTs: 1,
  lastTs: 2,
  splits: [],
};
// standing は proof 付き (同一 cached 再観測の skip 制御用。legacy standing は
// proof 付与で PUT する — 新 regression テストが実 excerpt で cover)。
const existingA = JSON.stringify({ code: "A", updated: "2026-09-28T00:00:00.000Z", bars: [BAR_A], splits: [], proof: FAKE_PROOF });

const SAVED_ARGV = [...process.argv];
const SAVED_CWD = process.cwd();
// main() は cwd/.vwap-summaries/ へ原本を書く。repo 汚染防止で tmp へ chdir。
beforeEach(() => {
  vi.clearAllMocks();
  mockR2Put.mockReset(); mockR2Put.mockResolvedValue(undefined);
  vi.mocked(confirmUnknownPricePut).mockReset();
  vi.mocked(confirmUnknownPricePut).mockImplementation(async error => { throw error; });
  vi.mocked(qualifyDailySourceRange).mockReset();
  vi.mocked(qualifyDailySourceRange).mockImplementation(() => tenYearRange(new Date().toISOString()));
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.argv = ["node", "vitest"];
  process.exitCode = undefined;
  (globalThis as { __vwapKnobs?: unknown }).__vwapKnobs = undefined;
  mockRecord.mockResolvedValue({ outcome: "recorded", fileTooLarge: false } as never);
  rawHook.enabled = true;
  rawHook.status = 200;
  rawHook.size = 28;
  rawHook.body = null;
  rawHook.replay = null;
  mockRawArchive.mockResolvedValue({ pages: ["test-page"], rawBytes: 1, compressedBytes: 1, archives: [] });
  vi.mocked(referenceFromArchivedParts).mockReturnValue({} as never);
  vi.mocked(readPriceReference).mockReturnValue({ status: "held", reason: "この配管fixtureは物理原本参照を持たない" });
  vi.mocked(priceMetadata).mockReturnValue({});
  vi.mocked(publishDailyPriceSnapshot).mockResolvedValue({ status: "held", reason: "配管testsではactivationしない" });
  process.chdir(mkdtempSync(join(tmpdir(), "vwap-daily-")));
});
afterEach(() => {
  process.chdir(SAVED_CWD);
  process.argv = SAVED_ARGV;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
const localSummaryBody = (): Record<string, unknown> => {
  const files = readdirSync(".vwap-summaries");
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(".vwap-summaries", files[0]), "utf-8")) as Record<string, unknown>;
};

// 構造分岐を検証する入力。市場事実・観測値としては使わない。
const COMPLETED_AT = "2026-10-02T08:00:00.000Z";
const completionRaw = (symbol: string, missingMiddle = false): Uint8Array => new TextEncoder().encode(JSON.stringify({
  chart: { error: null, result: [{
    meta: { symbol, range: "10y", dataGranularity: "1d", exchangeTimezoneName: "Asia/Tokyo", currency: "JPY",
      regularMarketPrice: BAR_A.c, regularMarketTime: 1790922601,
      currentTradingPeriod: { regular: { start: 1790899200, end: 1790922600, timezone: "JST", gmtoffset: 32400 } } },
    timestamp: [1790726400, 1790812800, 1790899200],
    indicators: { quote: [{ open: [BAR_A.o, BAR_A.o, BAR_A.o], high: [BAR_A.h, BAR_A.h, BAR_A.h],
      low: [BAR_A.l, BAR_A.l, BAR_A.l], close: [BAR_A.c, missingMiddle ? null : BAR_A.c, BAR_A.c],
      volume: [BAR_A.v, BAR_A.v, BAR_A.v] }] },
  }] },
}));
const completionCapture = (symbol: string, bytes: Uint8Array) => ({
  symbol, bytes, status: 200, receivedAt: COMPLETED_AT, headers: {},
  url: `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=10y&interval=1d&events=split,div`,
});
const completedSaved = async (code: string) => {
  const bytes = completionRaw(`${code}.T`);
  const fresh = await parseDailyChart(`${code}.T`, "10y", bytes, COMPLETED_AT);
  const completedFetch = completedDailyFetch(fresh, completionCapture(`${code}.T`, bytes), tenYearRange(COMPLETED_AT));
  expect(completedFetch).not.toBeNull();
  return assertSavedDailyShape(JSON.stringify({ code, updated: COMPLETED_AT, ...fresh, completedFetch }), `daily/${code}.json`, code);
};

describe("daily source前の同日確定済み再開", () => {
  it("同じ条件付PUTへ原本参照だけをmetadata保存し、公開本文には追加しない", async () => {
    const actual = await vi.importActual<typeof import("../../src/shared/holdings/price-registry.js")>("../../src/shared/holdings/price-registry.js");
    vi.mocked(referenceFromArchivedParts).mockImplementation(actual.referenceFromArchivedParts);
    vi.mocked(priceMetadata).mockImplementation(actual.priceMetadata);
    vi.mocked(readPriceReference).mockImplementation(actual.readPriceReference);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(COMPLETED_AT));
    try {
      rawHook.body = completionRaw("7203.T");
      const fresh = await parseDailyChart("7203.T", "10y", rawHook.body, COMPLETED_AT);
      mockLoadCodes.mockResolvedValue(["7203", "6758"]);
      process.argv.push("--codes=7203");
      mockR2Get.mockResolvedValue(null);
      mockR2Put.mockResolvedValue(undefined);
      mockFetchDaily.mockResolvedValue(fresh);
      const page = "3f8d74ff-84cd-8188-9724-c64cf81e15e8";
      mockRawArchive.mockImplementation(async ({ captures }) => ({ pages: [page], rawBytes: rawHook.body!.length, compressedBytes: 120,
        archives: [{ archivePageId: page, filename: "vwap-daily-0-001.json.gz", gzipSha256: "1".repeat(64), gzipBytes: 120,
          members: captures.map(({ api, attempt, capture }) => ({ api, attempt, symbol: capture.symbol, receivedAt: capture.receivedAt,
            status: capture.status, byteLength: capture.bytes.length, sha256: createHash("sha256").update(capture.bytes).digest("hex") })) }] }));
      await main();
      expect(process.exitCode).toBe(0);
      expect(mockR2Put).toHaveBeenCalledTimes(1);
      const [key, body, etag, metadata] = mockR2Put.mock.calls[0];
      expect(key).toBe("daily/7203.json"); expect(etag).toBeNull();
      const saved = assertSavedDailyShape(body, key, "7203");
      const ref = actual.readPriceReference(metadata, saved.proof);
      expect(ref).toMatchObject({ status: "ready", reference: { file: { archivePageId: page }, bodySha256: fresh.proof.rawSha } });
      expect(body).not.toContain(page); expect(body).not.toContain("holdings-price");
      expect(Object.keys(JSON.parse(body))).toEqual(["code", "updated", "bars", "splits", "proof", "corporateEvents", "completedFetch"]);
      expect(JSON.parse(body).corporateEvents).toEqual(fresh.corporateEvents);
      expect(vi.mocked(publishDailyPriceSnapshot).mock.calls[0][0]).toMatchObject({ codes: ["7203"], universe: ["7203", "6758"], complete: true });
    } finally { vi.useRealTimers(); }
  });
  it("完了barでも物理原本参照の無い旧保存はsource前skipせず通常metadata CASへ進む", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(COMPLETED_AT));
    const saved = await completedSaved("A");
    mockLoadCodes.mockResolvedValue(["A"]); mockR2Get.mockResolvedValue({ body: JSON.stringify(saved), etag: "legacy-etag" });
    rawHook.body = completionRaw("A.T");
    mockFetchDaily.mockResolvedValue(await parseDailyChart("A.T", "10y", rawHook.body, COMPLETED_AT));
    await main();
    expect(mockFetchDaily).toHaveBeenCalledTimes(1); expect(mockR2Put).toHaveBeenCalledTimes(1);
    expect(mockR2Put.mock.calls[0][2]).toBe("legacy-etag"); expect(referenceFromArchivedParts).toHaveBeenCalledTimes(1);
    expect(priceMetadata).toHaveBeenCalledTimes(1); expect(process.exitCode).toBe(0);
  });
  it("activation unknownは日足本文を再送せずexit2にする", async () => {
    mockLoadCodes.mockResolvedValue(["7203"]); mockR2Get.mockResolvedValue(null);
    mockFetchDaily.mockResolvedValue({ bars: [BAR_A], splits: [], proof: FAKE_PROOF });
    mockR2Put.mockResolvedValue(undefined);
    vi.mocked(publishDailyPriceSnapshot).mockRejectedValue(new R2PutUnknownError("ops/holdings-price/active.json", "TimeoutError", "none", "test"));
    await main();
    expect(mockR2Put).toHaveBeenCalledTimes(1); expect(mockRawArchive).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(2);
  });
  it.each(["success", "unknown", "config", "transport", "changed-session", "refresh-crossed-day"])(
    "midnight %s closes the prior batch before one new reference and never repairs old captures", async (mode) => {
      const before = "2026-10-02T14:59:59.000Z", after = "2026-10-02T15:00:01.000Z";
      const oldReference = { date: "2026-10-02", observedAt: before, rawSha: "1".repeat(64) };
      const nextReference = { date: mode === "changed-session" ? "2026-10-01" : oldReference.date,
        observedAt: after, rawSha: "2".repeat(64) };
      const referenceMock = vi.mocked(fetchDailySessionReference), qualifyMock = vi.mocked(qualifyDailySourceRange);
      const originalReference = referenceMock.getMockImplementation()!, originalQualify = qualifyMock.getMockImplementation()!;
      const actual = await vi.importActual<typeof import("./lib/daily-session.js")>("./lib/daily-session.js");
      const order: string[] = [];
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(before));
      vi.stubEnv("GITHUB_RUN_ID", "200");
      vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
      try {
        referenceMock.mockImplementation(async (_run, stage) => {
          order.push(`reference:${stage === undefined ? "initial" : stage}`);
          if (stage === undefined) return oldReference;
          if (mode === "unknown") throw new NotionUnknownResultError("unknown reference archive; no resend");
          if (mode === "config") throw new NotionConfigError("reference archive configuration");
          if (mode === "transport") throw new Error("reference transport");
          if (mode === "refresh-crossed-day") vi.setSystemTime(new Date("2026-10-03T15:00:01.000Z"));
          return nextReference;
        });
        qualifyMock.mockImplementation(actual.qualifyDailySourceRange);
        mockLoadCodes.mockResolvedValue(["A", "B", "C"]);
        mockR2Get.mockImplementation(async (key) => {
          order.push(`get:${key}`);
          rawHook.body = completionRaw(`${key.slice(6, -5)}.T`);
          return null;
        });
        mockFetchDaily.mockImplementation(async (symbol: string) => {
          order.push(`source:${symbol}`);
          const fresh = await parseDailyChart(symbol, "10y", rawHook.body!, new Date().toISOString());
          if (symbol === "A.T") vi.setSystemTime(new Date(after));
          return fresh;
        });
        mockRawArchive.mockImplementation(async (input) => {
          order.push(`archive:${input.captures.map((c) => c.capture.symbol).join(",")}`);
          return { pages: ["physical"], rawBytes: 1, compressedBytes: 1, archives: [] };
        });
        mockR2Put.mockImplementation(async (key) => { order.push(`put:${key}`); });
        await main();
        expect(referenceMock.mock.calls).toEqual([["200.1"], ["200.1", "vwap-daily-session-1"]]);
        expect(order.indexOf("archive:A.T")).toBeLessThan(order.indexOf("put:daily/A.json"));
        expect(order.indexOf("put:daily/A.json")).toBeLessThan(order.indexOf("reference:vwap-daily-session-1"));
        const saved = assertSavedDailyShape(mockR2Put.mock.calls[0][1], "daily/A.json", "A");
        expect(saved.proof?.observedAt).toBe(before);
        expect(saved.completedFetch?.sessionReference).toEqual(oldReference);
        expect(oldReference).toEqual({ date: "2026-10-02", observedAt: before, rawSha: "1".repeat(64) });
        if (mode === "success") {
          expect(process.exitCode).toBe(0);
          expect(order.indexOf("reference:vwap-daily-session-1")).toBeLessThan(order.indexOf("source:B.T"));
          expect(mockFetchDaily.mock.calls.map(([symbol]) => symbol)).toEqual(["A.T", "B.T", "C.T"]);
          expect(mockRawArchive).toHaveBeenCalledTimes(2);
          expect(mockR2Put).toHaveBeenCalledTimes(3);
          for (const [key, body] of mockR2Put.mock.calls.slice(1)) {
            const next = assertSavedDailyShape(body, key, key.slice(6, -5));
            expect(next.proof?.observedAt).toBe(after);
            expect(next.completedFetch?.sessionReference).toEqual(nextReference);
          }
        } else {
          expect(process.exitCode).toBe(2);
          expect(mockR2Get).toHaveBeenCalledTimes(1);
          expect(mockFetchDaily).toHaveBeenCalledTimes(1);
          expect(mockRawArchive).toHaveBeenCalledTimes(1); // refresh後のNotion batch送信なし。
          expect(mockR2Put).toHaveBeenCalledTimes(1); // refresh前に確定したAだけ。queued PUTは残らない。
          if (mode === "unknown" || mode === "config") expect(mockRecord).not.toHaveBeenCalled();
          const summary = localSummaryBody();
          expect(summary.errors).toBe(1);
          expect(summary.outcomes).toMatchObject({ A: { status: "written" }, B: { status: "error" }, C: { status: "notStarted" } });
        }
      } finally {
        referenceMock.mockImplementation(originalReference);
        qualifyMock.mockImplementation(originalQualify);
        vi.useRealTimers(); vi.unstubAllEnvs();
      }
    });

  it("normal main uses one independent closed-session reference without trimming a Sunday 10y response", async () => {
    // Declared qualified transport reference; raw integrity is covered by price-registry tests.
    vi.mocked(readPriceReference).mockReturnValue({ status: "ready", reference: {} as never });
    const observedAt = "2026-10-04T12:28:34.484Z";
    vi.stubEnv("GITHUB_RUN_ID", "100");
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(observedAt));
    try {
      const body = JSON.parse(new TextDecoder().decode(completionRaw("A.T")));
      body.chart.result[0].timestamp[0] = 1475452800; // 明示構造分岐: 2016-10-03。
      rawHook.body = new TextEncoder().encode(JSON.stringify(body));
      mockLoadCodes.mockResolvedValue(["A"]);
      mockR2Get.mockResolvedValue(null);
      mockFetchDaily.mockResolvedValue(await parseDailyChart("A.T", "10y", rawHook.body, observedAt));
      vi.mocked(fetchDailySessionReference).mockResolvedValueOnce({ date: "2026-10-02",
        observedAt: "2026-10-04T12:14:55.189Z", rawSha: "1".repeat(64) });
      const actual = await vi.importActual<typeof import("./lib/daily-session.js")>("./lib/daily-session.js");
      vi.mocked(qualifyDailySourceRange).mockImplementationOnce(actual.qualifyDailySourceRange);
      // 元HTTP契約も正常dailyと同じ形でcaptureする。
      const original = rawHook.body;
      await main();
      expect(process.exitCode).toBe(0);
      expect(fetchDailySessionReference).toHaveBeenCalledTimes(1);
      expect(mockFetchDaily).toHaveBeenCalledTimes(1);
      expect(mockR2Put).toHaveBeenCalledTimes(1);
      const saved = assertSavedDailyShape(mockR2Put.mock.calls[0][1], "daily/A.json", "A");
      expect(saved.bars.map((b) => b.date)).toEqual(["2016-10-03", "2026-10-01", "2026-10-02"]);
      expect(saved.proof?.observedAt).toBe(observedAt);
      expect(saved.completedFetch?.to).toBe("2026-10-02");
      expect(rawHook.body).toBe(original);
      const savedBody = mockR2Put.mock.calls[0][1];
      vi.clearAllMocks();
      vi.stubEnv("GITHUB_RUN_ID", "101");
      vi.setSystemTime(new Date("2026-10-04T13:00:00.000Z"));
      mockR2Get.mockResolvedValue({ body: savedBody, etag: "preserved-version" });
      vi.mocked(fetchDailySessionReference).mockResolvedValueOnce({ date: "2026-10-02",
        observedAt: "2026-10-04T12:59:00.000Z", rawSha: "2".repeat(64) });
      await main();
      expect(mockFetchDaily).not.toHaveBeenCalled();
      expect(mockR2Put).not.toHaveBeenCalled();
      expect(recordedMetadata().sourceObserved).toMatchObject({ count: 0 });
      expect((recordedBody().outcomes as Record<string, unknown>).A).toMatchObject({ status: "skipped", sourceFetched: false, latestSourceBar: "2026-10-02" });
      expect(saved.proof?.observedAt).toBe(observedAt);

      vi.clearAllMocks();
      vi.stubEnv("GITHUB_RUN_ID", "102");
      const nextObserved = "2026-10-05T12:28:34.484Z";
      vi.setSystemTime(new Date(nextObserved));
      const next = body.chart.result[0];
      next.meta.regularMarketTime += 3 * 86400;
      next.meta.currentTradingPeriod.regular.start += 3 * 86400;
      next.meta.currentTradingPeriod.regular.end += 3 * 86400;
      next.timestamp = [1475625600, 1790812800, 1790899200, 1791158400];
      for (const field of ["open", "high", "low", "close", "volume"]) next.indicators.quote[0][field].push(next.indicators.quote[0][field][0]);
      rawHook.body = new TextEncoder().encode(JSON.stringify(body));
      mockFetchDaily.mockResolvedValue(await parseDailyChart("A.T", "10y", rawHook.body, nextObserved));
      vi.mocked(fetchDailySessionReference).mockResolvedValueOnce({ date: "2026-10-05",
        observedAt: "2026-10-05T12:14:55.189Z", rawSha: "3".repeat(64) });
      vi.mocked(qualifyDailySourceRange).mockImplementationOnce(actual.qualifyDailySourceRange);
      await main();
      expect(mockFetchDaily).toHaveBeenCalledTimes(1); // 確定sessionが変わればsourceを取得する。
      expect(mockR2Put).toHaveBeenCalledTimes(1);
      expect(assertSavedDailyShape(mockR2Put.mock.calls[0][1], "daily/A.json", "A").bars.at(-1)?.date).toBe("2026-10-05");

      vi.clearAllMocks();
      vi.stubEnv("GITHUB_RUN_ID", "103");
      vi.setSystemTime(new Date("2026-10-05T13:00:00.000Z"));
      const broken = { ...saved, completedFetch: { ...saved.completedFetch!, sessionReference: { ...saved.completedFetch!.sessionReference!, rawSha: "invalid" } } };
      mockR2Get.mockResolvedValue({ body: JSON.stringify(broken), etag: "broken-witness" });
      await main();
      expect(mockFetchDaily).not.toHaveBeenCalled();
      expect(mockR2Put).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally { vi.useRealTimers(); vi.unstubAllEnvs(); }
  });
  it("成功済みprefixはYahoo/PUT0、legacy未完だけ取得・保管し、再開後は全件source0", async () => {
    // Declared qualified transport reference; raw integrity is covered by price-registry tests.
    vi.mocked(readPriceReference).mockReturnValue({ status: "ready", reference: {} as never });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(COMPLETED_AT));
    vi.stubEnv("GITHUB_RUN_ID", "1");
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
    try {
      const a = await completedSaved("A"), b = await completedSaved("B");
      delete (b as { completedFetch?: unknown }).completedFetch; // 旧proofのみでは確定扱い不可。
      const store = new Map([["daily/A.json", JSON.stringify(a)], ["daily/B.json", JSON.stringify(b)]]);
      mockLoadCodes.mockResolvedValue(["A", "B"]);
      mockR2Get.mockImplementation(async (key) => ({ body: store.get(key)!, etag: "observed-version" }));
      mockR2Put.mockImplementation(async (key, body) => { store.set(key, body); });
      rawHook.body = completionRaw("B.T");
      mockFetchDaily.mockResolvedValue(await parseDailyChart("B.T", "10y", rawHook.body, COMPLETED_AT));
      await main();
      expect(process.exitCode).toBe(0);
      expect(mockFetchDaily.mock.calls.map(([symbol]) => symbol)).toEqual(["B.T"]);
      expect(mockR2Put.mock.calls.map(([key]) => key)).toEqual(["daily/B.json"]);
      expect(mockRawArchive).toHaveBeenCalledTimes(1);
      expect(recordedMetadata().sourceObserved).toMatchObject({ count: 1 });
      expect((recordedBody().outcomes as Record<string, unknown>).A).toMatchObject({ status: "skipped", sourceFetched: false });
      vi.clearAllMocks();
      rawHook.body = null;
      vi.stubEnv("GITHUB_RUN_ATTEMPT", "2"); // 再開は別attempt。同じ原本名のwx再保存を避ける。
      await main();
      expect(process.exitCode).toBe(0);
      expect(mockFetchDaily).not.toHaveBeenCalled();
      expect(mockR2Put).not.toHaveBeenCalled();
      expect(mockRawArchive).not.toHaveBeenCalled();
      expect(recordedMetadata().sourceObserved).toMatchObject({ count: 0 });
      expect(recordedBody().skipped).toBe(2);
    } finally { vi.unstubAllEnvs(); vi.useRealTimers(); }
  });

  it("翌日・10y条件違い・形成中session・原本のnull脱落はskip資格を持たない", async () => {
    const saved = await completedSaved("A");
    const range = tenYearRange(COMPLETED_AT);
    expect(hasCompletedDailyFetch(saved, range)).toBe(true);
    expect(hasCompletedDailyFetch(saved, tenYearRange("2026-10-03T08:00:00.000Z"))).toBe(false);
    expect(hasCompletedDailyFetch({ ...saved, proof: { ...saved.proof!, requestedRange: "5y" } }, range)).toBe(false);
    const forming = { ...saved, completedFetch: { ...saved.completedFetch!, regularMarketTime: 1790922599 } };
    expect(hasCompletedDailyFetch(forming, range)).toBe(false);
    expect(() => assertSavedDailyShape(JSON.stringify(forming), "daily/A.json", "A")).toThrow("completedFetch");
    const missing = completionRaw("A.T", true);
    const fresh = await parseDailyChart("A.T", "10y", missing, COMPLETED_AT);
    expect(fresh.bars).toHaveLength(2);
    expect(completedDailyFetch(fresh, completionCapture("A.T", missing), range)).toBeNull();
    const bytes = completionRaw("A.T");
    const good = await parseDailyChart("A.T", "10y", bytes, COMPLETED_AT);
    expect(() => completedDailyFetch(good, completionCapture("A.T", missing), range)).toThrow("証跡不一致");
  });
});

describe("ingest-daily main flow", () => {
  it.each(["success", "unknown", "rejected", "deadline"])("custody後のR2だけ最大2・%s後は開始済みをsettleし後続を止める", async (mode) => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-14T08:00:00.000Z"));
    const codes = mode === "success" ? ["A", "B", "C"] : ["A", "B", ...Array.from({ length: 29 }, (_, i) => `C${i}`)];
    mockLoadCodes.mockResolvedValue(codes); mockR2Get.mockResolvedValue(null);
    let sourceActive = 0, sourcePeak = 0, writeActive = 0, writePeak = 0, archived = false;
    mockFetchDaily.mockImplementation(async () => {
      sourcePeak = Math.max(sourcePeak, ++sourceActive); await Promise.resolve(); sourceActive--;
      return { bars: [{ ...BAR_A, date: "2026-10-14" }], splits: [], proof: FAKE_PROOF };
    });
    mockRawArchive.mockImplementationOnce(async () => {
      expect(mockR2Put).not.toHaveBeenCalled(); archived = true;
      return { pages: ["test-page"], rawBytes: 1, compressedBytes: 1, archives: [] };
    });
    const pending: Array<{ resolve(): void; reject(error: unknown): void }> = [];
    mockR2Put.mockImplementation(async () => {
      expect(archived).toBe(true); writePeak = Math.max(writePeak, ++writeActive);
      try { await new Promise<void>((resolve, reject) => pending.push({ resolve, reject })); } finally { writeActive--; }
    });
    if (mode === "deadline") {
      vi.stubEnv("GITHUB_RUN_ID", "101"); vi.stubEnv("GITHUB_RUN_ATTEMPT", "1"); process.argv.push("--scheduled-date=2026-10-14");
    }
    const operation = main();
    try {
      await vi.waitFor(() => expect(mockR2Put).toHaveBeenCalledTimes(2));
      expect(mockRecord).not.toHaveBeenCalled(); expect(sourcePeak).toBe(1); expect(writePeak).toBe(2);
      if (mode === "success") {
        pending[0].resolve(); await vi.waitFor(() => expect(mockR2Put).toHaveBeenCalledTimes(3));
        pending[1].resolve(); pending[2].resolve();
      } else {
        if (mode === "deadline") { vi.setSystemTime(new Date("2026-10-14T14:30:00.000Z")); pending[0].resolve(); }
        else pending[0].reject(mode === "unknown" ? new R2PutUnknownError("daily/A.json", "timeout", "none", null) : new R2PutRejectedError("daily/A.json", "PreconditionFailed", 412, null));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(mockR2Put).toHaveBeenCalledTimes(2); expect(mockRecord).not.toHaveBeenCalled(); pending[1].resolve();
      }
      await operation;
      expect(writeActive).toBe(0); expect(writePeak).toBe(2);
      const body = recordedBody() as { outcomes: Record<string, { status: string }>; unknown: string[]; rejected: string[] };
      expect(body.outcomes.B.status).toBe("written");
      if (mode === "success") { expect(process.exitCode).toBe(0); expect(body.outcomes.C.status).toBe("written"); }
      else {
        expect(process.exitCode).toBe(2); expect(mockFetchDaily).toHaveBeenCalledTimes(30);
        expect(body.outcomes.C28.status).toBe("notStarted");
        expect(body.unknown).toEqual(mode === "unknown" ? ["A"] : []);
        expect(body.rejected).toEqual(mode === "rejected" ? ["A"] : []);
      }
    } finally { for (const item of pending) item.resolve(); await operation; }
  });
  it("unknown照合中は次PUTを開始せず、完全POST確認だけをsummaryへ区別して通常再開する", async () => {
    mockLoadCodes.mockResolvedValue(["A", "B", "C"]); mockR2Get.mockResolvedValue(null);
    mockFetchDaily.mockResolvedValue({ bars: [BAR_A], splits: [], proof: FAKE_PROOF });
    mockR2Put.mockRejectedValueOnce(new R2PutUnknownError("daily/A.json", "InternalError", 500, null));
    let release!: (proof: Awaited<ReturnType<typeof confirmUnknownPricePut>>) => void;
    vi.mocked(confirmUnknownPricePut).mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const operation = main();
    await vi.waitFor(() => expect(confirmUnknownPricePut).toHaveBeenCalledTimes(1));
    expect(mockR2Put).toHaveBeenCalledTimes(2); expect(mockRecord).not.toHaveBeenCalled();
    const bodySha256 = createHash("sha256").update(mockR2Put.mock.calls[0][1]).digest("hex");
    const proof = { putAcknowledgement: "unknown" as const, state: "exact-post-observed" as const,
      checkedAt: new Date().toISOString(), etag: '"post"', bodyBytes: Buffer.byteLength(mockR2Put.mock.calls[0][1]),
      bodySha256, metadataSha256: createHash("sha256").update("[]").digest("hex"), contentType: "application/json" as const, complete: true as const };
    release(proof); await operation;
    expect(mockR2Put).toHaveBeenCalledTimes(3); expect(process.exitCode).toBe(0);
    expect(recordedBody()).toMatchObject({ unknown: [], outcomes: { A: { status: "written", bodySha: bodySha256, putReadback: proof }, C: { status: "written" } } });
  });
  it("同時2PUTのunknownは両世代のPOST確認が閉じるまで次PUTを開始しない", async () => {
    mockLoadCodes.mockResolvedValue(["A", "B", "C"]); mockR2Get.mockResolvedValue(null);
    mockFetchDaily.mockResolvedValue({ bars: [BAR_A], splits: [], proof: FAKE_PROOF });
    for (const code of ["A", "B"]) mockR2Put.mockRejectedValueOnce(new R2PutUnknownError(`daily/${code}.json`, "InternalError", 500, null));
    type Proof = Awaited<ReturnType<typeof confirmUnknownPricePut>>;
    const pending: Array<(proof: Proof) => void> = [];
    vi.mocked(confirmUnknownPricePut).mockImplementation(() => new Promise(resolve => { pending.push(resolve); }));
    const operation = main();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    const proof = (index: number): Proof => ({ putAcknowledgement: "unknown", state: "exact-post-observed",
      checkedAt: new Date().toISOString(), etag: `"post-${index}"`, bodyBytes: Buffer.byteLength(mockR2Put.mock.calls[index][1]),
      bodySha256: createHash("sha256").update(mockR2Put.mock.calls[index][1]).digest("hex"),
      metadataSha256: createHash("sha256").update("[]").digest("hex"), contentType: "application/json", complete: true });
    try {
      pending[0](proof(0));
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(mockR2Put).toHaveBeenCalledTimes(2); expect(mockRecord).not.toHaveBeenCalled();
      pending[1](proof(1)); await operation;
      expect(mockR2Put).toHaveBeenCalledTimes(3); expect(process.exitCode).toBe(0);
      expect(recordedBody()).toMatchObject({ unknown: [], outcomes: {
        A: { status: "written", putReadback: { etag: '"post-0"' } }, B: { status: "written", putReadback: { etag: '"post-1"' } }, C: { status: "written" },
      } });
    } finally { pending.forEach((release, index) => release(proof(index))); await operation; }
  });
  it("explicit archived source keeps custody in the run receipt without direct benchmark fetch", async () => {
    process.argv.push("--session-source=archived-jp-leg", `--session-date=${D_TODAY}`);
    const reference = { date: D_TODAY, observedAt: new Date().toISOString(), rawSha: "8".repeat(64) };
    const custody = { source: "archived-jp-leg" as const, cacheKey: `macro/jp-close/${D_TODAY}.json`, archivePageId: "test-jp", manifestSha256: "9".repeat(64), n225ArchivePageId: "test-n225", n225Filename: "saved.json.gz", n225GzipSha256: "7".repeat(64) };
    vi.mocked(loadArchivedDailySessionReference).mockResolvedValueOnce({ reference, custody });
    mockLoadCodes.mockResolvedValue(["A"]); mockR2Get.mockResolvedValue(null);
    mockFetchDaily.mockResolvedValue({ bars: [BAR_A], splits: [], proof: FAKE_PROOF });
    await main();
    expect(loadArchivedDailySessionReference).toHaveBeenCalledExactlyOnceWith(D_TODAY);
    expect(fetchDailySessionReference).not.toHaveBeenCalled();
    expect(recordedBody().dailySession).toEqual({ selection: { kind: "archived-jp-leg", date: D_TODAY }, reference, custody });
    expect(recordedMetadata().dailySession).toEqual(recordedBody().dailySession);
    expect(mockR2Put.mock.calls[0][1]).not.toContain("test-n225"); // internal archive links stay out of public price JSON.
  });
  it("invalid or unavailable explicit source stops before any per-stock or replacement source", async () => {
    process.argv.push("--session-source=archived-jp-leg");
    await expect(main()).rejects.toThrow("同日date");
    expect(loadCodes).not.toHaveBeenCalled(); expect(mockFetchDaily).not.toHaveBeenCalled();
    process.argv.push(`--session-date=${D_TODAY}`); mockLoadCodes.mockResolvedValue(["A"]);
    vi.mocked(loadArchivedDailySessionReference).mockRejectedValueOnce(new Error("missing saved source"));
    await expect(main()).rejects.toThrow("missing saved source");
    expect(mockFetchDaily).not.toHaveBeenCalled(); expect(fetchDailySessionReference).not.toHaveBeenCalled(); expect(mockR2Put).not.toHaveBeenCalled();
  });
  it("archived mode never refreshes a benchmark after midnight", async () => {
    process.argv.push("--session-source=archived-jp-leg", `--session-date=${D_TODAY}`);
    const observedAt = new Date().toISOString();
    vi.mocked(loadArchivedDailySessionReference).mockImplementationOnce(async () => {
      vi.spyOn(Date, "now").mockReturnValue(Date.parse(observedAt) + 86400_000);
      return { reference: { date: D_TODAY, observedAt, rawSha: "8".repeat(64) }, custody: { source: "archived-jp-leg", cacheKey: "same-day", archivePageId: "test-jp", manifestSha256: "9".repeat(64), n225ArchivePageId: "test-n225", n225Filename: "saved.json.gz", n225GzipSha256: "7".repeat(64) } };
    });
    mockLoadCodes.mockResolvedValue(["A"]); await main();
    expect(fetchDailySessionReference).not.toHaveBeenCalled(); expect(mockFetchDaily).not.toHaveBeenCalled(); expect(mockR2Put).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });
  it("concurrent replacement rejects the exact observed version and stops remaining codes", async () => {
    mockLoadCodes.mockResolvedValue(["A", "B"]);
    mockR2Get.mockResolvedValue({ body: existingA, etag: "opaque-multipart-2" });
    mockFetchDaily.mockResolvedValue({ bars: [BAR_A], splits: [], proof: { ...FAKE_PROOF, rawSha: "a".repeat(64) } });
    mockR2Put.mockRejectedValueOnce(new R2PutRejectedError("daily/A.json", "PreconditionFailed", 412, null));
    await main();
    expect(mockR2Put).toHaveBeenCalledTimes(1);
    expect(mockR2Put.mock.calls[0][2]).toBe("opaque-multipart-2");
    expect(mockFetchDaily).toHaveBeenCalledTimes(1); // Bの保存済bodyは銘柄不一致でsource前に拒否。
    expect(process.exitCode).toBe(2);
  });
  it("normal positive + skip control (exit 0, all codes accounted)", async () => {
    // Declared qualified transport reference; raw integrity is covered by price-registry tests.
    vi.mocked(readPriceReference).mockReturnValue({ status: "ready", reference: {} as never });
    mockLoadCodes.mockResolvedValue(["A", "B"]);
    mockR2Get.mockImplementation(async (key: string) => (key === "daily/A.json" ? { body: existingA, etag: "observed-version" } : null));
    mockFetchDaily.mockImplementation(async (symbol: string) =>
      symbol === "A.T"
        ? { bars: [BAR_A], splits: [], proof: FAKE_PROOF }
        : { bars: [BAR_B], splits: [], proof: FAKE_PROOF }
    );
    await main();
    expect(process.exitCode).toBe(0);
    expect(mockFetchDaily).toHaveBeenCalledTimes(2);
    // B のみ PUT。A は内容同一で skip。
    expect(mockR2Put).toHaveBeenCalledTimes(1);
    expect(mockR2Put.mock.calls[0][0]).toBe("daily/B.json");
    expect(mockR2Put.mock.calls[0][2]).toBeNull();
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const input = mockRecord.mock.calls[0][0] as { key: string };
    expect(input.key).toMatch(/^vwap-ingest-daily-/);
    const outcomes = recordedBody().outcomes as Record<string, { status: string; latestSourceBar: unknown; bodySha: unknown }>;
    expect(Object.keys(outcomes).sort()).toEqual(["A", "B"]);
    expect(outcomes.A.status).toBe("skipped");
    expect(outcomes.A.latestSourceBar).toBe(D_TODAY);
    // skip の pin は standing の既存 bytes。
    expect(typeof outcomes.A.bodySha).toBe("string");
    expect(outcomes.B.status).toBe("written");
    expect(outcomes.B.latestSourceBar).toBe(D_TODAY);
    expect(typeof outcomes.B.bodySha).toBe("string");
    expect(recordedMetadata().universe).toMatchObject({ size: 2 });
    expect(recordedMetadata().unknownCount).toBe(0);
  });

  it("first PUT timeout => inflight2/unknown1/written1/prepared-notStarted1/exit2", async () => {
    mockLoadCodes.mockResolvedValue(["A", "B", "C"]);
    mockR2Get.mockResolvedValue(null);
    mockFetchDaily.mockResolvedValue({ bars: [BAR_A], splits: [], proof: FAKE_PROOF });
    mockR2Put.mockRejectedValueOnce(new R2PutUnknownError("daily/A.json", "TimeoutError", "none", "test"));
    await main();
    expect(process.exitCode).toBe(2);
    expect(mockR2Put).toHaveBeenCalledTimes(2);
    // Bはunknown判明前に開始済み。Cも保管済みだがunknown後の新規PUTはしない。
    expect(mockFetchDaily).toHaveBeenCalledTimes(3);
    expect(mockFetchDaily.mock.calls[0][0]).toBe("A.T");
    // summary保管はunknown1/開始済みBの既知ACK/未送信Cを区別する。
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(recordedMetadata().unknownCount).toBe(1);
    const outcomes = recordedBody().outcomes as Record<string, { status: string }>;
    expect(outcomes.A.status).toBe("unknown");
    expect(outcomes.B.status).toBe("written");
    expect(outcomes.C.status).toBe("notStarted");
  });

  it("strict GET fault => source0/PUT0/exit2", async () => {
    mockLoadCodes.mockResolvedValue(["A", "B"]);
    mockR2Get.mockRejectedValue(new Error("TimeoutError https://r2.example.test/secret-leak"));
    const errSpy = vi.mocked(console.error);
    await main();
    expect(process.exitCode).toBe(2);
    expect(mockFetchDaily).toHaveBeenCalledTimes(0);
    expect(mockR2Put).toHaveBeenCalledTimes(0);
    const outcomes = recordedBody().outcomes as Record<string, { status: string }>;
    expect(outcomes.A.status).toBe("error");
    expect(outcomes.B.status).toBe("notStarted");
    // 生 SDK cause (URL) は stdout/stderr に出さない。
    for (const call of errSpy.mock.calls) {
      expect(String(call[0])).not.toContain("https://");
    }
  });

  it("chunk waits for delayed raw and custody failure stops all chunk writes and later fetches", async () => {
    (globalThis as { __vwapKnobs?: unknown }).__vwapKnobs = { conc: 2, delayMs: 1, maxRateLimit: 5, keepDays: 365 };
    rawHook.size = MAX_YAHOO_RAW_BYTES / 2;
    mockLoadCodes.mockResolvedValue(["A", "B", "C"]);
    mockR2Get.mockResolvedValue(null);
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    let ready!: () => void;
    const first = new Promise<void>((resolve) => { ready = resolve; });
    mockFetchDaily.mockImplementation(async (symbol: string) => {
      if (symbol === "A.T") { ready(); await delayed; }
      return { bars: [BAR_A], splits: [], proof: FAKE_PROOF };
    });
    mockRawArchive.mockRejectedValue(new Error("physical readback mismatch"));
    const running = main();
    await first;
    expect(mockFetchDaily).toHaveBeenCalledTimes(1);
    expect(mockRawArchive).not.toHaveBeenCalled();
    expect(mockR2Put).not.toHaveBeenCalled();
    release();
    await running;
    expect(mockRawArchive).toHaveBeenCalledTimes(1);
    expect(mockRawArchive.mock.calls[0][0].captures.map((r) => r.capture.symbol).sort()).toEqual(["A.T", "B.T"]);
    expect(mockFetchDaily).toHaveBeenCalledTimes(2);
    expect(mockR2Put).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    const outcomes = recordedBody().outcomes as Record<string, { status: string }>;
    expect(outcomes.C.status).toBe("notStarted");
  });

  it.each([
    ["UNKNOWN", new NotionUnknownResultError("unknown create; no resend")],
    ["CONFIG", new NotionConfigError("malformed Notion read envelope")],
  ])("raw custody %s keeps the local summary and sends no later Notion/R2/source work", async (_kind, error) => {
    const codes = Array.from({ length: 31 }, (_, i) => String(1000 + i));
    mockLoadCodes.mockResolvedValue(codes);
    mockFetchDaily.mockResolvedValue({ bars: [BAR_A], splits: [], proof: FAKE_PROOF });
    mockR2Get.mockResolvedValue(null);
    mockRawArchive.mockRejectedValue(error);
    await main();
    expect(mockRawArchive).toHaveBeenCalledTimes(1);
    expect(mockFetchDaily).toHaveBeenCalledTimes(30);
    expect(mockR2Put).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    const files = readdirSync(".vwap-summaries");
    expect(files).toHaveLength(1);
    const local = JSON.parse(readFileSync(join(".vwap-summaries", files[0]), "utf-8")) as { outcomes: Record<string, { status: string }> };
    expect(Object.keys(local.outcomes)).toHaveLength(31);
    expect(local.outcomes[codes[30]].status).toBe("notStarted");
  });

  it("normal PUT occurs only after its own raw custody returns", async () => {
    mockLoadCodes.mockResolvedValue(["A"]);
    mockR2Get.mockResolvedValue(null);
    mockFetchDaily.mockResolvedValue({ bars: [BAR_A], splits: [], proof: FAKE_PROOF });
    mockR2Put.mockResolvedValue(undefined);
    await main();
    expect(mockRawArchive.mock.calls[0][0].captures[0].capture.symbol).toBe("A.T");
    expect(mockRawArchive.mock.invocationCallOrder[0]).toBeLessThan(mockR2Put.mock.invocationCallOrder[0]);
    expect(process.exitCode).toBe(0);
  });

  it("at most thirty codes share one custody batch and the next offset is not skipped", async () => {
    (globalThis as { __vwapKnobs?: unknown }).__vwapKnobs = { conc: 5, delayMs: 1, maxRateLimit: 5, keepDays: 365 };
    const codes = Array.from({ length: 31 }, (_, i) => String(1000 + i));
    mockLoadCodes.mockResolvedValue(codes);
    mockR2Get.mockResolvedValue(null);
    mockFetchDaily.mockResolvedValue({ bars: [BAR_A], splits: [], proof: FAKE_PROOF });
    mockR2Put.mockResolvedValue(undefined);
    await main();
    expect(mockRawArchive.mock.calls.map(([input]) => input.captures.length)).toEqual([30, 1]);
    expect(mockRawArchive.mock.calls.map(([input]) => input.stage)).toEqual(["vwap-daily-0", "vwap-daily-30"]);
    expect(mockFetchDaily).toHaveBeenCalledTimes(31);
    expect(mockR2Put).toHaveBeenCalledTimes(31);
    expect(mockRawArchive.mock.invocationCallOrder[0]).toBeLessThan(mockR2Put.mock.invocationCallOrder[0]);
    expect(mockRawArchive.mock.invocationCallOrder[1]).toBeLessThan(mockR2Put.mock.invocationCallOrder[30]);
    expect(process.exitCode).toBe(0);
  });

  it("8MiB collected in one wave seals custody before starting the next offset", async () => {
    (globalThis as { __vwapKnobs?: unknown }).__vwapKnobs = { conc: 2, delayMs: 1, maxRateLimit: 5, keepDays: 365 };
    rawHook.size = MAX_YAHOO_RAW_BYTES / 2;
    mockLoadCodes.mockResolvedValue(["A", "B", "C", "D", "E"]);
    mockR2Get.mockResolvedValue(null);
    mockFetchDaily.mockResolvedValue({ bars: [BAR_A], splits: [], proof: FAKE_PROOF });
    mockR2Put.mockResolvedValue(undefined);
    await main();
    expect(mockRawArchive.mock.calls.map(([input]) => input.captures.length)).toEqual([2, 2, 1]);
    expect(mockRawArchive.mock.calls.map(([input]) => input.stage)).toEqual(["vwap-daily-0", "vwap-daily-2", "vwap-daily-4"]);
    expect(mockRawArchive.mock.invocationCallOrder[0]).toBeLessThan(mockFetchDaily.mock.invocationCallOrder[2]);
    expect(mockFetchDaily).toHaveBeenCalledTimes(5);
    expect(mockR2Put).toHaveBeenCalledTimes(5);
    expect(process.exitCode).toBe(0);
  });

  it.each([undefined, Date.now() + 120_000])("first rate response with deadline %s archives and stops GET/PUT regardless of MAX_RL", async (retryAt) => {
    rawHook.status = 429;
    (globalThis as { __vwapKnobs?: unknown }).__vwapKnobs = { conc: 1, delayMs: 1, maxRateLimit: 5, keepDays: 365 };
    mockLoadCodes.mockResolvedValue(["A", "B"]);
    mockR2Get.mockResolvedValue(null);
    mockFetchDaily.mockRejectedValue(Object.assign(new Error("yahoo 429"), { name: "YahooRateLimitError", retryAtMs: retryAt }));
    await main();
    expect(mockRawArchive.mock.calls[0][0].captures).toHaveLength(1);
    expect(mockRawArchive.mock.calls[0][0].captures[0].capture.status).toBe(429);
    expect(mockFetchDaily).toHaveBeenCalledTimes(1);
    expect(mockR2Put).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });

  it("raw absent or single-body too large stops before PUT and later source", async () => {
    for (const tooLarge of [false, true]) {
      vi.clearAllMocks();
      rawHook.enabled = false;
      mockLoadCodes.mockResolvedValue(["A", "B"]);
      mockR2Get.mockResolvedValue(null);
      if (tooLarge) mockFetchDaily.mockRejectedValue(new YahooRawTooLargeError("A.T"));
      else mockFetchDaily.mockResolvedValue({ bars: [BAR_A], splits: [], proof: FAKE_PROOF });
      await main();
      expect(mockRawArchive.mock.calls[0][0].missing).toHaveLength(1);
      expect(mockFetchDaily).toHaveBeenCalledTimes(1);
      expect(mockR2Put).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
      // 2回目のlocal summaryを同keyで衝突させない。
      process.chdir(mkdtempSync(join(tmpdir(), "vwap-daily-raw-")));
    }
  });

  it("archive failure => exit 2 (intra must not run)", async () => {
    mockLoadCodes.mockResolvedValue(["A"]);
    mockR2Get.mockResolvedValue(null);
    mockFetchDaily.mockResolvedValue({ bars: [BAR_A], splits: [], proof: FAKE_PROOF });
    mockR2Put.mockResolvedValue(undefined);
    mockRecord.mockResolvedValue({ outcome: "skipped_existing", fileTooLarge: false } as never);
    await main();
    expect(process.exitCode).toBe(2);
    // archive 失敗時も原本 bytes は local に残る (artifact 回収対象)。
    const local = localSummaryBody();
    expect(Object.keys(local.outcomes as Record<string, unknown>)).toEqual(["A"]);
  });

  it("local write failure => record 0 + exit 2 (no archive attempt)", async () => {
    mockLoadCodes.mockResolvedValue(["A"]);
    mockR2Get.mockResolvedValue(null);
    mockFetchDaily.mockResolvedValue({ bars: [BAR_A], splits: [], proof: FAKE_PROOF });
    mockR2Put.mockResolvedValue(undefined);
    // .vwap-summaries を file で塞ぎ mkdir を失敗させる。
    writeFileSync(".vwap-summaries", "blocker");
    await main();
    expect(process.exitCode).toBe(2);
    expect(mockRecord).toHaveBeenCalledTimes(0);
  });
});

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX_R2_DAILY_7203 = join(HERE, "../../services/vwap-analysis/tests/fixtures/r2-daily-7203.json");
// 実 excerpt 全 bytes pin (由来は fixtures/README.md)。不一致は fail (fallback なし)。
const R2_DAILY_7203_SHA = "2a727f0665ba53e78da50944e58714271f20d26e6ad7e9b296dcd5a21e0c8efc";
const sha256str = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

// 私有保存10y原本3社をそのまま再生。価格/clock/bytesを合成しない。CIの機構回帰は上で必須実行。
const PUT2_DAILY_REPLAY = "/tmp/kabulab-vwap-put2-replay/daily.json";
it.skipIf(!existsSync(PUT2_DAILY_REPLAY))("actual saved10y 3source bytes/clock preserve under normal main R2 inflight2 (source0)", async () => {
  const wire = readFileSync(PUT2_DAILY_REPLAY);
  expect(createHash("sha256").update(wire).digest("hex")).toBe("c26fb4f6b7b89ecf0d7e08a7b3e33e9e8104710fc5c1ad2dd1b1927b1ae18bed");
  const plan = JSON.parse(wire.toString()) as { sources: Array<Omit<YahooRawCapture, "bytes"> & { bodyBase64: string; sha256: string; byteLength: number }> };
  rawHook.replay = new Map(); const fresh = new Map<string, Awaited<ReturnType<typeof parseDailyChart>>>();
  for (const item of plan.sources) {
    const bytes = Buffer.from(item.bodyBase64, "base64");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(item.sha256); expect(bytes.length).toBe(item.byteLength);
    rawHook.replay.set(item.symbol, { symbol: item.symbol, status: item.status, receivedAt: item.receivedAt, url: item.url, headers: item.headers, bytes });
    fresh.set(item.symbol, await parseDailyChart(item.symbol, "10y", bytes, item.receivedAt));
  }
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(Math.max(...plan.sources.map(x => Date.parse(x.receivedAt))) + 1000));
  mockLoadCodes.mockResolvedValue(plan.sources.map(x => x.symbol.replace(/\.T$/, ""))); mockR2Get.mockResolvedValue(null);
  // 市場session資格は独立suiteのseam。ここでは本物のraw/解析値とR2順序だけを主張する。
  // rootが物理受入した固定37202207552.1は2026-10-02 session。取得暦日10-04へ移さない。
  vi.mocked(fetchDailySessionReference).mockResolvedValueOnce({ date: "2026-10-02", observedAt: new Date().toISOString(), rawSha: "1".repeat(64) });
  vi.mocked(qualifyDailySourceRange).mockReturnValue(tenYearRange("2026-10-02T08:00:00.000Z"));
  mockFetchDaily.mockImplementation(async symbol => { const v = fresh.get(symbol); if (!v) throw new Error("unexpected actual source"); return v; });
  let active = 0, peak = 0;
  mockR2Put.mockImplementation(async () => { peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 15)); active--; });
  await main(); expect(process.exitCode).toBe(0); expect(peak).toBe(2); expect(active).toBe(0); expect(mockR2Put).toHaveBeenCalledTimes(3);
  for (const [key, body] of mockR2Put.mock.calls) {
    const symbol = key.slice("daily/".length, -".json".length) + ".T", source = fresh.get(symbol)!;
    const saved = JSON.parse(body); expect(saved.bars).toEqual(source.bars); expect(saved.splits).toEqual(source.splits); expect(saved.proof).toEqual(source.proof);
  }
  expect(mockRawArchive.mock.calls[0][0].captures.map(x => createHash("sha256").update(x.capture.bytes).digest("hex")))
    .toEqual(plan.sources.map(x => x.sha256));
});

// Actual licensed bytes remain private. This replay uses the actual frozen plan
// clock, not the machine's later clock; it proves same-run reentry through main().
const ACTUAL_REPAIR_DIR = "/tmp/vwap-adj-repair";
const ACTUAL_UNIVERSE = "/tmp/fresh-snapshot-read-20260930/post-read/post-snapshot.normalized.json";
const ACTUAL_CODES = ["7944", "8303", "8919"];
const ACTUAL_SOURCES = ["acq-7944.bin", "acq2-8303.bin", "acq2-8919.bin"];
const actualReplayAvailable = existsSync(ACTUAL_UNIVERSE) && existsSync(join(ACTUAL_REPAIR_DIR, "rep3-wholepost-plan.json")) &&
  ACTUAL_CODES.every((c, i) => existsSync(join(ACTUAL_REPAIR_DIR, `repair3-${c}.post-body.json`)) && existsSync(join(ACTUAL_REPAIR_DIR, ACTUAL_SOURCES[i])));
it.skipIf(!actualReplayAvailable)("actual repaired NEWPOSTs reenter the SAME normal main with source replay and PUT0", async () => {
  const universeRaw = readFileSync(ACTUAL_UNIVERSE, "utf8");
  expect(sha256str(universeRaw)).toBe("9bc6b50b7fa3ac86edd17bf87ef60625428423e72efa9df86de7ca741a5b1ec8");
  const universe = (JSON.parse(universeRaw) as { core: Array<{ code: string; isActive: number; instrumentType: string }> }).core
    .filter((r) => r.isActive === 1 && r.instrumentType === "equity").map((r) => r.code).sort();
  expect(universe).toHaveLength(3695);
  expect(sha256str(universe.join("\n"))).toBe("e441dd1fdfccacb7a3f448c16495259d4e4b19b5acd4ae913f5502beeb86beb3");
  const plan = JSON.parse(readFileSync(join(ACTUAL_REPAIR_DIR, "rep3-wholepost-plan.json"), "utf8")) as {
    planAt: string; rows: Array<{ code: string; postSha: string; sourceSha: string; sourceObservedAt: string }>;
  };
  const standing = new Map<string, string>();
  const fresh = new Map<string, Awaited<ReturnType<typeof parseDailyChart>>>();
  for (let i = 0; i < ACTUAL_CODES.length; i++) {
    const code = ACTUAL_CODES[i], row = plan.rows[i];
    expect(row.code).toBe(code);
    const post = readFileSync(join(ACTUAL_REPAIR_DIR, `repair3-${code}.post-body.json`), "utf8");
    expect(sha256str(post)).toBe(row.postSha);
    const source = readFileSync(join(ACTUAL_REPAIR_DIR, ACTUAL_SOURCES[i]));
    expect(createHash("sha256").update(source).digest("hex")).toBe(row.sourceSha);
    standing.set(`daily/${code}.json`, post);
    fresh.set(`${code}.T`, await parseDailyChart(`${code}.T`, "10y", source, row.sourceObservedAt));
  }
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(plan.planAt));
  try {
    process.argv = ["node", "vitest", `--codes=${ACTUAL_CODES.join(",")}`];
    mockLoadCodes.mockResolvedValue(universe);
    mockR2Get.mockImplementation(async (key) => {
      const body = standing.get(key);
      if (body === undefined) throw new Error("unexpected object read");
      return { body, etag: "offline-observed-version" };
    });
    mockFetchDaily.mockImplementation(async (symbol, range) => {
      expect(range).toBe("10y");
      const value = fresh.get(symbol);
      if (value === undefined) throw new Error("unexpected source request");
      return value;
    });
    mockR2Put.mockImplementation(async () => { throw new Error("unexpected PUT during actual replay"); });
    await main();
    expect(process.exitCode).toBe(0);
    expect(mockFetchDaily).toHaveBeenCalledTimes(3);
    expect(mockR2Put).not.toHaveBeenCalled();
    const outcomes = recordedBody().outcomes as Record<string, { status: string }>;
    expect(Object.keys(outcomes)).toEqual(ACTUAL_CODES);
    expect(Object.values(outcomes).every((r) => r.status === "skipped")).toBe(true);
  } finally {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  }
});

describe("通常定時VWAPの日足source前開始/終了窓", () => {
  it("定時受付だけがbenchmark/個別source/registryへ同じrequest-local guardを渡す", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(COMPLETED_AT));
    vi.stubEnv("GITHUB_RUN_ID", "101"); vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
    process.argv.push("--scheduled-date=2026-10-02"); mockLoadCodes.mockResolvedValue(["7203"]);
    rawHook.body = completionRaw("7203.T");
    mockFetchDaily.mockResolvedValue(await parseDailyChart("7203.T", "10y", rawHook.body, COMPLETED_AT));
    mockR2Get.mockResolvedValue(null);
    await main();
    const guard = vi.mocked(fetchDailySessionReference).mock.calls[0][2];
    expect(guard).toBeTypeOf("function");
    expect(mockFetchDaily.mock.calls[0][2].beforeRequest).toBe(guard);
    expect(vi.mocked(publishDailyPriceSnapshot).mock.calls[0][0].beforeMutation).toBe(guard);
    expect(process.exitCode).toBe(0); expect(mockR2Put).toHaveBeenCalledTimes(1);
  });
  it("registryの非更新read中に完了期限を越えても成功出口へ進まない", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-14T08:00:00.000Z"));
    vi.stubEnv("GITHUB_RUN_ID", "101"); vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
    process.argv.push("--scheduled-date=2026-10-14"); mockLoadCodes.mockResolvedValue([]);
    vi.mocked(publishDailyPriceSnapshot).mockImplementationOnce(async () => {
      vi.setSystemTime(new Date("2026-10-14T14:30:00.001Z")); return { status: "unchanged" };
    });
    await main();
    expect(process.exitCode).toBe(2); expect(mockR2Put).not.toHaveBeenCalled();
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(recordedBody().scheduledWindow).toMatchObject({ admittedAt: "2026-10-14T08:00:00.000Z" });
  });
  it("7時間超の遅配は母集団/benchmark/個別価格/保存すべて0でSTOP", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-14T15:19:56.144Z"));
    vi.stubEnv("GITHUB_RUN_ID", "38570657322"); vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
    process.argv.push("--scheduled-date=2026-10-14");
    await expect(main()).rejects.toThrow("開始期限");
    expect(mockLoadCodes).not.toHaveBeenCalled(); expect(fetchDailySessionReference).not.toHaveBeenCalled();
    expect(mockFetchDaily).not.toHaveBeenCalled(); expect(mockR2Put).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled(); expect(mockRawArchive).not.toHaveBeenCalled();
  });
  it("受付後の母集団read中に終了窓を越えたらbenchmarkも取得しない", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-14T08:00:00.000Z"));
    vi.stubEnv("GITHUB_RUN_ID", "101"); vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
    process.argv.push("--scheduled-date=2026-10-14");
    mockLoadCodes.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date("2026-10-14T14:30:00.001Z")); return ["7203"];
    });
    await expect(main()).rejects.toThrow("完了期限");
    expect(fetchDailySessionReference).not.toHaveBeenCalled(); expect(mockFetchDaily).not.toHaveBeenCalled();
    expect(mockR2Get).not.toHaveBeenCalled(); expect(mockR2Put).not.toHaveBeenCalled();
  });
});

describe.skipIf(!existsSync(FIX_R2_DAILY_7203))("ingest-daily actual same-cached (実 excerpt)", () => {
  it("同一 cached 再観測 → run2 PUT0/standing bytes 不変/初回 clock 保持", async () => {
    const standing = readFileSync(FIX_R2_DAILY_7203, "utf-8");
    expect(sha256str(standing)).toBe(R2_DAILY_7203_SHA);
    const obj = JSON.parse(standing) as {
      bars: Array<{ date: string; o: number; h: number; l: number; c: number; v: number; adj: number }>;
      splits: [];
    };
    // fresh は実 excerpt の in-range 実 bars を verbatim (値の合成なし)。
    // フィルタのみで中身は触らない。range 外旧は明示破棄される。
    const { from } = tenYearRange(new Date().toISOString());
    // 使用型は OHLCV のみ (実行時の adj 余分キーは検証対象外)。
    const bars = obj.bars as Array<{ date: string; o: number; h: number; l: number; c: number; v: number }>;
    const freshFull = bars.filter((b) => b.date >= from);
    expect(freshFull.length).toBeGreaterThan(0);
    const expectDiscarded = obj.bars.length - freshFull.length;
    // 等価条件の機構部 (同一 cached = 同一 rawSha・range・span・splits、clock のみ差)。
    const proofBase = {
      rawSha: "b".repeat(64),
      requestedRange: "10y",
      symbol: "7203.T",
      firstTs: 1700000000,
      lastTs: 1700100000,
      splits: [],
    };
    const P1 = { ...proofBase, observedAt: "2026-09-29T00:00:00.000Z" };
    const P2 = { ...proofBase, observedAt: "2026-09-29T01:00:00.000Z" };
    const store = new Map<string, string>([["daily/7203.json", standing]]);
    mockLoadCodes.mockResolvedValue(["7203"]);
    mockR2Get.mockImplementation(async (key: string) => store.has(key) ? { body: store.get(key)!, etag: "observed-version" } : null);
    mockR2Put.mockImplementation(async (key: string, body: string) => {
      store.set(key, body);
    });
    // run1: legacy に proof 付与 + 全置換で PUT1。range 外旧は破棄 count 付き。
    mockFetchDaily.mockResolvedValueOnce({ bars: freshFull, splits: [], proof: P1 });
    await main();
    expect(process.exitCode).toBe(0);
    expect(mockR2Put).toHaveBeenCalledTimes(1);
    const after1 = store.get("daily/7203.json") as string;
    expect(mockR2Put.mock.calls[0][2]).toBe("observed-version");
    const sha1 = sha256str(after1);
    const post1 = JSON.parse(after1) as { bars: unknown[]; proof: { observedAt: string } };
    expect(post1.bars).toHaveLength(freshFull.length);
    expect(post1.proof.observedAt).toBe(P1.observedAt);
    const out1 = recordedBody().outcomes as Record<string, { discardedOutOfRange?: { count: number } }>;
    if (expectDiscarded > 0) {
      expect(out1["7203"].discardedOutOfRange?.count).toBe(expectDiscarded);
    } else {
      expect(out1["7203"].discardedOutOfRange).toBeUndefined();
    }
    // run2: 同一 cached (clock のみ差) → PUT0・bytes 不変・restamp なし。
    mockFetchDaily.mockResolvedValueOnce({ bars: freshFull, splits: [], proof: P2 });
    await main();
    expect(process.exitCode).toBe(0);
    expect(mockR2Put).toHaveBeenCalledTimes(1);
    const after2 = store.get("daily/7203.json") as string;
    expect(sha256str(after2)).toBe(sha1);
    expect((JSON.parse(after2) as { proof: { observedAt: string } }).proof.observedAt).toBe(P1.observedAt);
  });

  it("旧 in-range 日付欠落 → HOLD (PUT0・error)", async () => {
    const standing = readFileSync(FIX_R2_DAILY_7203, "utf-8");
    expect(sha256str(standing)).toBe(R2_DAILY_7203_SHA);
    const obj = JSON.parse(standing) as { bars: Array<{ date: string }> };
    const { from } = tenYearRange(new Date().toISOString());
    const inRange = obj.bars.filter((b) => b.date >= from);
    expect(inRange.length).toBeGreaterThan(2);
    // 構造変異: 中盤 1 日を落として欠落分岐を作る (市場事実ではない)。
    const mid = Math.floor(inRange.length / 2);
    const freshBars = [...inRange.slice(0, mid), ...inRange.slice(mid + 1)] as Array<{
      date: string; o: number; h: number; l: number; c: number; v: number;
    }>;
    const P = {
      rawSha: "c".repeat(64),
      requestedRange: "10y",
      symbol: "7203.T",
      firstTs: 1700000000,
      lastTs: 1700100000,
      splits: [],
      observedAt: "2026-09-29T00:00:00.000Z",
    };
    mockLoadCodes.mockResolvedValue(["7203"]);
    mockR2Get.mockResolvedValue({ body: standing, etag: "observed-version" });
    mockFetchDaily.mockResolvedValueOnce({ bars: freshBars, splits: [], proof: P });
    await main();
    expect(process.exitCode).toBe(1);
    expect(mockR2Put).toHaveBeenCalledTimes(0);
    const outcomes = recordedBody().outcomes as Record<string, { status: string }>;
    expect(outcomes["7203"].status).toBe("error");
  });
});

it("先頭5件以降のHOLD理由もsanitize・上限制限してsummary原本に残し、取得/PUT/exitを変えない", async () => {
  const codes = ["1444", "1788", "1897", "2136", "2376", "2993"];
  mockLoadCodes.mockResolvedValue(codes);
  mockR2Get.mockResolvedValue(null);
  mockFetchDaily.mockImplementation(async (symbol: string) => ({ bars: [BAR_A], splits: [], proof: { ...FAKE_PROOF, symbol } }));
  vi.mocked(qualifyDailySourceRange).mockImplementation((fresh) => {
    throw new Error(`repair HOLD: ${fresh.proof.symbol} https://query1.finance.yahoo.com/private?secret=private-value secret=private-value ${"x".repeat(400)}`);
  });
  await main();
  const body = recordedBody();
  const outcomes = body.outcomes as Record<string, { status: string; reason: string }>;
  expect(Object.keys(outcomes)).toHaveLength(6);
  for (const code of codes) {
    expect(outcomes[code].status).toBe("error");
    expect(outcomes[code].reason).toHaveLength(300);
    expect(outcomes[code].reason).toContain(`Error: repair HOLD: ${code}.T <url> secret=<redacted>`);
    expect(outcomes[code].reason).not.toContain("private-value");
    expect(outcomes[code].reason).not.toContain("https://");
  }
  expect(localSummaryBody().outcomes).toEqual(outcomes);
  expect(body).toMatchObject({ written: 0, errors: 6, aborted: false, unknown: [], rejected: [] });
  expect(mockFetchDaily).toHaveBeenCalledTimes(6);
  expect(mockRawArchive).toHaveBeenCalledTimes(1);
  expect(mockRecord).toHaveBeenCalledTimes(1);
  expect(mockR2Put).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledTimes(5);
  expect(process.exitCode).toBe(1);
});

describe("tenYearRange", () => {
  it("the checked-in workflow shell keeps daily-only codes and all daily/intra stop contracts", () => {
    const result = execFileSync("bash", [fileURLToPath(new URL("./lib/runblock-check.sh", import.meta.url))], {
      encoding: "utf-8", timeout: 10_000, env: { PATH: process.env.PATH, TMPDIR: tmpdir() },
    });
    expect(result).toContain("pass=11 fail=0");
  });
  it("通常日は JST 10 年前の同月日〜当日", () => {
    expect(tenYearRange("2026-09-30T00:00:00.000Z")).toEqual({ from: "2016-09-30", to: "2026-09-30" });
  });
  it("うるう日は 02-28 明示 rule", () => {
    expect(tenYearRange("2024-02-29T00:00:00.000Z")).toEqual({ from: "2014-02-28", to: "2024-02-29" });
  });
  it("無効入力は HOLD (Feb28 化しない)", () => {
    expect(() => tenYearRange("not-a-date")).toThrow(/無効な now/);
  });
  it("緩い clock は HOLD (日付のみ・存在しない日付の繰上げを通さない)", () => {
    expect(() => tenYearRange("2026-09-30")).toThrow(/無効な now/);
    expect(() => tenYearRange("2026-02-30T00:00:00.000Z")).toThrow(/無効な now/);
  });
});
