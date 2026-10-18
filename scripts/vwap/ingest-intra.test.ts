import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { R2PutRejectedError, R2PutUnknownError } from "./lib/r2.js";
import { r2GetVersion, r2Put } from "./lib/r2.js";
import { loadCodes } from "./lib/codes.js";
import { YahooRawTooLargeError, YahooRateLimitError, parseBars5m, describeIntraSource, type YahooRawCapture } from "../../src/shared/yahoo/client.js";
import { recordPrimaryData } from "../../src/shared/notion-archive/index.js";
import { NotionUnknownResultError } from "../../src/shared/notion-archive/client.js";
import { NotionConfigError } from "../../src/shared/notion-archive/env.js";
import { archiveYahooRawBatch } from "../../src/shared/yahoo/raw-custody.js";
import { main } from "./ingest-intra.js";
import { scheduledVwapGuard } from "./lib/scheduled-window.js";

const intraSource = vi.hoisted(() => vi.fn());
const intraWindowSource = vi.hoisted(() => vi.fn());
const rawHook = vi.hoisted(() => ({ enabled: true, replay: null as Map<string, YahooRawCapture> | null }));

vi.mock("./lib/r2.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./lib/r2.js")>();
  return { ...mod, r2GetVersion: vi.fn(), r2Put: vi.fn(),
    retry: <T>(fn: () => Promise<T>, n: number, _base: number, stop?: (error: unknown) => boolean) => mod.retry(fn, n, 1, stop) };
});
vi.mock("./lib/codes.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./lib/codes.js")>();
  return { ...mod, loadCodes: vi.fn() };
});
vi.mock("../../src/shared/yahoo/client.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/shared/yahoo/client.js")>();
  return { ...mod, fetchBars5mWindow: intraWindowSource, fetchBars5m: async (...args: Parameters<typeof mod.fetchBars5m>) => {
    if (rawHook.replay !== null) {
      const capture = rawHook.replay.get(args[0]); if (!capture) throw new Error("unexpected actual replay symbol");
      await args[2]?.onRaw?.(capture);
      return intraSource(...args);
    }
    // Declared transport projection: source bars and HTTP diagnostic must describe the same rows.
    let bars: Array<typeof BAR> = [], failure: unknown;
    try { bars = await intraSource(...args); } catch (error) { failure = error; }
    if (rawHook.enabled) await args[2]?.onRaw?.({ symbol: args[0], status: 200,
      bytes: new TextEncoder().encode(JSON.stringify({ chart: { result: [{ meta: { symbol: args[0] }, timestamp: bars.map(b => b.ts),
        indicators: { quote: [{ open: bars.map(b => b.o), high: bars.map(b => b.h), low: bars.map(b => b.l), close: bars.map(b => b.c), volume: bars.map(b => b.v) }] } }], error: null } })),
      url: "https://query1.finance.yahoo.com/v8/finance/chart/test", receivedAt: new Date().toISOString(), headers: {} });
    if (failure !== undefined) throw failure;
    return bars;
  } };

});
vi.mock("../../src/shared/yahoo/raw-custody.js", () => ({ archiveYahooRawBatch: vi.fn() }));
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
    vwapKnobs: () => (globalThis as { __vwapKnobs?: { conc: number; delayMs: number; maxRateLimit: number; keepDays: number } })
      .__vwapKnobs ?? { conc: 1, delayMs: 1, maxRateLimit: 5, keepDays: 365 },
    VWAP_INTRA_RANGE: () => "5d",
  },
}));

const mockR2Get = vi.mocked(r2GetVersion);
const mockR2Put = vi.mocked(r2Put);
const mockLoadCodes = vi.mocked(loadCodes);
const mockFetch5m = intraSource;
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

const TS = Math.floor(Date.now() / 1000) - 100;
const BAR = { ts: TS, o: 100, h: 110, l: 90, c: 105, v: 1000 };
const existingA = JSON.stringify({ code: "A", updated: "2026-09-28T00:00:00.000Z", bars: [BAR] });

// 私有保存60d原本の実3社。通常mainのwrite poolだけを検証し、実vendor/R2通信はしない。
const PUT2_INTRA_REPLAY = "/tmp/kabulab-vwap-put2-replay/intra.json";
it.skipIf(!existsSync(PUT2_INTRA_REPLAY))("actual saved60d 3source bytes/clock preserve under normal main R2 inflight2 (source0)", async () => {
  const wire = readFileSync(PUT2_INTRA_REPLAY);
  expect(createHash("sha256").update(wire).digest("hex")).toBe("e041d9d09f25869db5015b0cc28831cdb06541d32e6fe43ab4deec5491fc7fba");
  const plan = JSON.parse(wire.toString()) as { sources: Array<Omit<YahooRawCapture, "bytes"> & { bodyBase64: string; sha256: string; byteLength: number }> };
  rawHook.replay = new Map(); const fresh = new Map<string, Awaited<ReturnType<typeof parseBars5m>>>();
  for (const item of plan.sources) {
    const bytes = Buffer.from(item.bodyBase64, "base64");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(item.sha256); expect(bytes.length).toBe(item.byteLength);
    rawHook.replay.set(item.symbol, { symbol: item.symbol, status: item.status, receivedAt: item.receivedAt, url: item.url, headers: item.headers, bytes }); fresh.set(item.symbol, parseBars5m(JSON.parse(bytes.toString()), item.symbol));
  }
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(Math.max(...plan.sources.map(x => Date.parse(x.receivedAt))) + 1000));
  process.argv.push("--range=60d");
  mockLoadCodes.mockResolvedValue(plan.sources.map(x => x.symbol.replace(/\.T$/, ""))); mockR2Get.mockResolvedValue(null);
  mockFetch5m.mockImplementation(async symbol => { const v = fresh.get(symbol); if (!v) throw new Error("unexpected actual source"); return v; });
  let active = 0, peak = 0;
  mockR2Put.mockImplementation(async () => { peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 15)); active--; });
  await main(); expect(process.exitCode).toBe(0); expect(peak).toBe(2); expect(active).toBe(0); expect(mockR2Put).toHaveBeenCalledTimes(3);
  for (const [key, body] of mockR2Put.mock.calls) {
    const symbol = key.slice("intra/".length, -".json".length) + ".T";
    expect(JSON.parse(body).bars).toEqual(fresh.get(symbol));
  }
  expect(mockRawArchive.mock.calls[0][0].captures.map(x => createHash("sha256").update(x.capture.bytes).digest("hex")))
    .toEqual(plan.sources.map(x => x.sha256));
});

const SAVED_ARGV = [...process.argv];
const SAVED_CWD = process.cwd();
// main() は cwd/.vwap-summaries/ へ原本を書く。repo 汚染防止で tmp へ chdir。
beforeEach(() => {
  vi.clearAllMocks();
  mockR2Put.mockReset(); mockR2Put.mockResolvedValue(undefined);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.argv = ["node", "vitest"];
  process.exitCode = undefined;
  mockRecord.mockResolvedValue({ outcome: "recorded", fileTooLarge: false } as never);
  rawHook.enabled = true;
  rawHook.replay = null;
  (globalThis as { __vwapKnobs?: unknown }).__vwapKnobs = undefined;
  mockRawArchive.mockResolvedValue({ pages: ["test-page"], rawBytes: 1, compressedBytes: 1 });
  process.chdir(mkdtempSync(join(tmpdir(), "vwap-intra-")));
});
afterEach(() => {
  process.chdir(SAVED_CWD);
  process.argv = SAVED_ARGV;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("通常定時VWAPの5分足は同run受付と終了窓を継承", () => {
  it("最終empty/summary保管中に期限を越えても成功出口へ進まない", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-14T08:00:00.000Z"));
    vi.stubEnv("GITHUB_RUN_ID", "101"); vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
    scheduledVwapGuard({ plannedDate: "2026-10-14", runId: "101.1", phase: "daily" });
    process.argv.push("--scheduled-date=2026-10-14");
    mockLoadCodes.mockResolvedValue(["7203"]); mockFetch5m.mockResolvedValue([]); mockR2Get.mockResolvedValue(null);
    mockRecord.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date("2026-10-14T14:30:00.001Z"));
      return { outcome: "recorded", fileTooLarge: false } as never;
    });
    await main();
    expect(process.exitCode).toBe(2); expect(mockFetch5m).toHaveBeenCalledTimes(1);
    expect(mockFetch5m.mock.calls[0][2].beforeRequest).toBeTypeOf("function");
    expect(mockRawArchive).toHaveBeenCalledTimes(1); expect(mockRecord).toHaveBeenCalledTimes(1);
    // Empty-response status is now persisted before the summary; the late summary still fails.
    expect(mockR2Put).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockR2Put.mock.calls[0][1])).toMatchObject({ bars: [], sourceStatus: { status: "source_empty" } });
    expect(recordedBody().scheduledWindow).toMatchObject({ admittedAt: "2026-10-14T08:00:00.000Z" });
  });
  it.each(["missing", "expired"])("受付%sはsource・母集団・PUT0で停止", async (mode) => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-14T08:00:00.000Z"));
    vi.stubEnv("GITHUB_RUN_ID", "101"); vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
    if (mode === "expired") {
      scheduledVwapGuard({ plannedDate: "2026-10-14", runId: "101.1", phase: "daily" });
      vi.setSystemTime(new Date("2026-10-14T14:30:00.001Z"));
    }
    process.argv.push("--scheduled-date=2026-10-14");
    await expect(main()).rejects.toThrow();
    expect(mockLoadCodes).not.toHaveBeenCalled(); expect(mockFetch5m).not.toHaveBeenCalled();
    expect(mockR2Get).not.toHaveBeenCalled(); expect(mockR2Put).not.toHaveBeenCalled();
    expect(mockRawArchive).not.toHaveBeenCalled();
  });
  it("取得中に終了窓へ達しても原本を保管し、価格PUT0・残りnotStartedで終了2", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-14T08:00:00.000Z"));
    vi.stubEnv("GITHUB_RUN_ID", "101"); vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
    scheduledVwapGuard({ plannedDate: "2026-10-14", runId: "101.1", phase: "daily" });
    process.argv.push("--scheduled-date=2026-10-14");
    mockLoadCodes.mockResolvedValue(["7203", "6758"]);
    mockFetch5m.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date("2026-10-14T14:30:00.001Z")); return [BAR];
    });
    mockR2Get.mockResolvedValue(null);
    await main();
    expect(mockFetch5m).toHaveBeenCalledTimes(1); expect(mockRawArchive).toHaveBeenCalledTimes(1);
    expect(mockRawArchive.mock.calls[0][0].captures).toHaveLength(1);
    expect(mockR2Put).not.toHaveBeenCalled(); expect(process.exitCode).toBe(2);
    expect(recordedBody().outcomes).toMatchObject({ "6758": { status: "notStarted" } });
  });
});

describe("ingest-intra main flow", () => {
  it("有限手動intraはYahooの認証・間隔待機後も通信直前に期限を再検査する", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); const start = Date.parse("2026-10-14T08:00:00.000Z"); vi.setSystemTime(start);
    process.argv.push("--codes=A", "--max-start-seconds=1");
    mockLoadCodes.mockResolvedValue(["A"]); mockR2Get.mockResolvedValue(null);
    mockFetch5m.mockImplementationOnce(async (_symbol, _range, options) => {
      vi.setSystemTime(start + 1000);
      options.beforeRequest?.();
      return [{ ...BAR, ts: Date.parse("2026-10-14T06:00:00.000Z") / 1000 }];
    });
    await main();
    expect(mockFetch5m.mock.calls[0][2].beforeRequest).toBeTypeOf("function");
    expect(mockR2Get).not.toHaveBeenCalled(); expect(mockR2Put).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2); expect(recordedBody().outcomes).toMatchObject({ A: { status: "error" } });
  });
  it("有限手動intraはcustody中の期限到達後PUT0、原本/全outcome/予算を保管してexit2", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); const start = Date.parse("2026-10-14T08:00:00.000Z"); vi.setSystemTime(start);
    process.argv.push("--codes=A", "--max-start-seconds=1");
    mockLoadCodes.mockResolvedValue(["A"]); mockR2Get.mockResolvedValue(null);
    mockFetch5m.mockResolvedValue([{ ...BAR, ts: Date.parse("2026-10-14T06:00:00.000Z") / 1000 }]);
    mockRawArchive.mockImplementationOnce(async () => {
      vi.setSystemTime(start + 1000); return { pages: ["test-page"], rawBytes: 1, compressedBytes: 1 };
    });
    await main();
    expect(mockFetch5m).toHaveBeenCalledTimes(1); expect(mockRawArchive).toHaveBeenCalledTimes(1);
    expect(mockR2Put).not.toHaveBeenCalled(); expect(mockRecord).toHaveBeenCalledTimes(1); expect(process.exitCode).toBe(2);
    expect(recordedBody().finiteStartBudget).toEqual({ startedAt: new Date(start).toISOString(), deadline: new Date(start + 1000).toISOString(), seconds: 1 });
    expect(recordedBody().outcomes).toMatchObject({ A: { status: "error" } });
  });
  it.each([[], ["--codes=A,A"], ["--codes=A", "--limit=1"], ["--codes=" + Array.from({ length: 101 }, (_, i) => String(i)).join(",")]])("有限手動intraの曖昧/重複/過大対象はD1/source前に拒否 %s", async (...args) => {
    process.argv.push("--max-start-seconds=900", ...args);
    await expect(main()).rejects.toThrow("1〜100コード"); expect(mockLoadCodes).not.toHaveBeenCalled(); expect(mockFetch5m).not.toHaveBeenCalled();
  });
  it.each(["success", "unknown", "rejected", "deadline"])("custody後のR2だけ最大2・%s後は開始済みをsettleし後続を止める", async (mode) => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-14T08:00:00.000Z"));
    const codes = mode === "success" ? ["A", "B", "C"] : ["A", "B", ...Array.from({ length: 29 }, (_, i) => `C${i}`)];
    mockLoadCodes.mockResolvedValue(codes); mockR2Get.mockResolvedValue(null);
    let sourceActive = 0, sourcePeak = 0, writeActive = 0, writePeak = 0, archived = false;
    mockFetch5m.mockImplementation(async () => {
      sourcePeak = Math.max(sourcePeak, ++sourceActive); await Promise.resolve(); sourceActive--;
      return [{ ...BAR, ts: Date.parse("2026-10-14T06:00:00.000Z") / 1000 }];
    });
    mockRawArchive.mockImplementationOnce(async () => {
      expect(mockR2Put).not.toHaveBeenCalled(); archived = true;
      return { pages: ["test-page"], rawBytes: 1, compressedBytes: 1 };
    });
    const pending: Array<{ resolve(): void; reject(error: unknown): void }> = [];
    mockR2Put.mockImplementation(async () => {
      expect(archived).toBe(true); writePeak = Math.max(writePeak, ++writeActive);
      try { await new Promise<void>((resolve, reject) => pending.push({ resolve, reject })); } finally { writeActive--; }
    });
    if (mode === "deadline") {
      vi.stubEnv("GITHUB_RUN_ID", "101"); vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
      scheduledVwapGuard({ plannedDate: "2026-10-14", runId: "101.1", phase: "daily" }); process.argv.push("--scheduled-date=2026-10-14");
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
        else pending[0].reject(mode === "unknown" ? new R2PutUnknownError("intra/A.json", "timeout", "none", null) : new R2PutRejectedError("intra/A.json", "PreconditionFailed", 412, null));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(mockR2Put).toHaveBeenCalledTimes(2); expect(mockRecord).not.toHaveBeenCalled(); pending[1].resolve();
      }
      await operation;
      expect(writeActive).toBe(0); expect(writePeak).toBe(2);
      const body = recordedBody() as { outcomes: Record<string, { status: string }>; unknown: string[]; rejected: string[] };
      expect(body.outcomes.B.status).toBe("written");
      if (mode === "success") { expect(process.exitCode).toBe(0); expect(body.outcomes.C.status).toBe("written"); }
      else {
        expect(process.exitCode).toBe(2); expect(mockFetch5m).toHaveBeenCalledTimes(30);
        expect(body.outcomes.C28.status).toBe("notStarted");
        expect(body.unknown).toEqual(mode === "unknown" ? ["A"] : []);
        expect(body.rejected).toEqual(mode === "rejected" ? ["A"] : []);
      }
    } finally { for (const item of pending) item.resolve(); await operation; }
  });
  it.each(["success", "unknown-put", "wrong-window", "unknown-custody", "no-trade"])("explicit five-code recovery %s preserves custody/CAS/proof and stops unknown", async mode => {
    vi.useFakeTimers({ toFake: ["Date"] });vi.setSystemTime(new Date("2026-10-13T19:43:00.123Z"));
    process.argv = ["node", "vitest", "--codes=593A,598A", "--from=2026-08-17T00:00:00Z", "--to-exclusive=2026-10-13T06:30:01Z"];
    mockLoadCodes.mockResolvedValue(["593A", "598A"]);
    const at = Date.parse("2026-10-13T06:30:00Z") / 1000, fresh = { ...BAR, ts: at };
    const retained = { ...BAR, ts: at - 300, sourceTag: "existing-field-preserved" };
    mockR2Get.mockImplementation(async key => ({ body: JSON.stringify({ code: key.split("/")[1].split(".")[0], updated: "2026-10-09T08:00:00Z", bars: [retained] }), etag: "observed-intra-version" }));
    intraWindowSource.mockImplementation(async (symbol, window, options) => {
      const bytes = new TextEncoder().encode(JSON.stringify({ chart: { error: null, result: [{
        meta: { symbol, currency: "JPY", instrumentType: "EQUITY", dataGranularity: "5m", exchangeTimezoneName: "Asia/Tokyo" },
        timestamp: [mode === "wrong-window" ? window.period2 : at],
        indicators: { quote: [{ open: [fresh.o], high: [fresh.h], low: [fresh.l], close: [fresh.c],
          volume: [mode === "no-trade" ? 0 : fresh.v] }] },
      }] } }));
      await options.onRaw({ symbol, bytes, status: 200, receivedAt: new Date().toISOString(), headers: {},
        url: `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=5m&period1=${window.period1}&period2=${window.period2}` });
      return mode === "no-trade" ? [] : [fresh];
    });
    mockRawArchive.mockImplementation(async () => {
      expect(mockR2Put).not.toHaveBeenCalled();
      if (mode === "unknown-custody") throw new NotionUnknownResultError("test-only unknown custody");
      return { pages: ["physical-raw"], rawBytes: 1, compressedBytes: 1 };
    });
    if (mode === "unknown-put") mockR2Put.mockRejectedValueOnce(new R2PutUnknownError("intra/593A.json", "timeout", "none", null));
    else mockR2Put.mockResolvedValue(undefined);
    await main();
    expect(mockFetch5m).not.toHaveBeenCalled();
    expect(intraWindowSource).toHaveBeenCalledTimes(mode === "wrong-window" || mode === "no-trade" ? 1 : 2);
    expect(mockRawArchive.mock.calls[0][0].captures).toHaveLength(mode === "wrong-window" || mode === "no-trade" ? 1 : 2);
    if (mode === "wrong-window" || mode === "unknown-custody" || mode === "no-trade") { expect(mockR2Put).not.toHaveBeenCalled();expect(process.exitCode).toBe(2);return; }
    expect(mockR2Put).toHaveBeenCalledTimes(2);
    expect(mockR2Put.mock.calls[0][2]).toBe("observed-intra-version");
    expect(JSON.parse(mockR2Put.mock.calls[0][1]).bars).toEqual([retained, fresh]);
    const body = recordedBody(), outcomes = body.outcomes as Record<string, { status: string; sourceWindowProof: { rawSha256: string; lastTs: number; sourceUrl: string } }>;
    expect(body.range).toContain("period1=");expect(body.range).not.toBe("60d");
    expect(outcomes["593A"].sourceWindowProof.lastTs).toBe(at);
    expect(outcomes["593A"].sourceWindowProof.rawSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(outcomes["593A"].sourceWindowProof.sourceUrl).toContain("period2=");
    expect(recordedMetadata().sourceWindow).toMatchObject({ toExclusive: "2026-10-13T06:30:01Z" });
    expect(process.exitCode).toBe(mode === "unknown-put" ? 2 : 0);
    if (mode === "unknown-put") { expect(body.unknown).toEqual(["593A"]);expect(outcomes["598A"].status).toBe("written"); }
  });
  it("concurrent replacement rejects the exact observed version and stops remaining codes", async () => {
    mockLoadCodes.mockResolvedValue(["A", "B"]);
    mockR2Get.mockResolvedValue({ body: existingA, etag: "opaque-multipart-2" });
    mockFetch5m.mockResolvedValue([{ ...BAR, ts: TS + 60 }]);
    mockR2Put.mockRejectedValueOnce(new R2PutRejectedError("intra/A.json", "PreconditionFailed", 412, null));
    await main();
    expect(mockR2Put).toHaveBeenCalledTimes(1);
    expect(mockR2Put.mock.calls[0][2]).toBe("opaque-multipart-2");
    expect(mockFetch5m).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBe(2);
  });
  it("normal positive + skip control (exit 0, all codes accounted)", async () => {
    mockLoadCodes.mockResolvedValue(["A", "B"]);
    const at = new Date().toISOString();
    const makeCapture = (symbol: string): YahooRawCapture => ({ symbol, status: 200, receivedAt: at, headers: {}, url: "https://query1.finance.yahoo.com/v8/finance/chart/test",
      bytes: new TextEncoder().encode(JSON.stringify({ chart: { error: null, result: [{ meta: { symbol }, timestamp: [BAR.ts], indicators: { quote: [{ open: [BAR.o], high: [BAR.h], low: [BAR.l], close: [BAR.c], volume: [BAR.v] }] } }] } })) });
    const capture = makeCapture("A.T");
    rawHook.replay = new Map([["A.T", capture], ["B.T", makeCapture("B.T")]]);
    const existing = JSON.stringify({ ...JSON.parse(existingA), sourceStatus: await describeIntraSource(capture, [BAR]) });
    mockR2Get.mockImplementation(async (key: string) => (key === "intra/A.json" ? { body: existing, etag: "observed-version" } : null));
    mockFetch5m.mockResolvedValue([BAR]);
    await main();
    expect(process.exitCode).toBe(0);
    expect(mockFetch5m).toHaveBeenCalledTimes(2);
    expect(mockR2Put).toHaveBeenCalledTimes(1);
    expect(mockR2Put.mock.calls[0][0]).toBe("intra/B.json");
    expect(mockR2Put.mock.calls[0][2]).toBeNull();
    const outcomes = recordedBody().outcomes as Record<string, { status: string; latestSourceBar: unknown; bodySha: unknown }>;
    expect(Object.keys(outcomes).sort()).toEqual(["A", "B"]);
    expect(outcomes.A.status).toBe("skipped");
    expect(outcomes.A.latestSourceBar).toBe(TS);
    expect(typeof outcomes.A.bodySha).toBe("string");
    expect(outcomes.B.status).toBe("written");
    expect(outcomes.B.latestSourceBar).toBe(TS);
    expect(recordedMetadata().universe).toMatchObject({ size: 2 });
    // 原本 bytes は archive 前に local へ (intra 配線証明)。
    const files = readdirSync(".vwap-summaries");
    expect(files).toHaveLength(1);
    const local = JSON.parse(readFileSync(join(".vwap-summaries", files[0]), "utf-8")) as { kind: string };
    expect(local.kind).toBe("intra");
  });

  it("validated timestamp keys sort/prune while preserving all surviving bar fields", async () => {
    mockLoadCodes.mockResolvedValue(["A"]);
    const oldKept = { ...BAR, ts: TS - 60, sourceTag: "retained" };
    const oldExpired = { ...BAR, ts: TS - 366 * 86400, sourceTag: "expired" };
    const oldReplaced = { ...BAR, sourceTag: "replaced" };
    const newBar = { ...BAR, sourceTag: "fresh", extra: { captured: true } };
    mockR2Get.mockResolvedValue({ body: JSON.stringify({ code: "A", updated: "2026-09-28T00:00:00.000Z",
      bars: [oldReplaced, oldExpired, oldKept] }), etag: "version-A" });
    mockFetch5m.mockResolvedValue([newBar]);
    await main();
    expect(mockR2Put).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockR2Put.mock.calls[0][1]).bars).toEqual([oldKept, newBar]);
    expect(process.exitCode).toBe(0);
  });

  it("GET fault after source await => PUT0/exit2 (second code never fetched)", async () => {
    mockLoadCodes.mockResolvedValue(["A", "B"]);
    mockFetch5m.mockResolvedValue([BAR]);
    mockR2Get.mockRejectedValue(new Error("R2 GET 応答が不完全です: intra/A.json"));
    await main();
    expect(process.exitCode).toBe(2);
    // A は source 取得後に GET fault。B は未着手。
    expect(mockFetch5m).toHaveBeenCalledTimes(1);
    expect(mockFetch5m.mock.calls[0][0]).toBe("A.T");
    expect(mockR2Put).toHaveBeenCalledTimes(0);
    const outcomes = recordedBody().outcomes as Record<string, { status: string }>;
    expect(outcomes.A.status).toBe("error");
    expect(outcomes.B.status).toBe("notStarted");
  });

  it("PUT unknown => inflight2/unknown1/written1/notStarted1/exit2", async () => {
    mockLoadCodes.mockResolvedValue(["A", "B", "C"]);
    mockR2Get.mockResolvedValue(null);
    mockFetch5m.mockResolvedValue([BAR]);
    mockR2Put.mockRejectedValueOnce(new R2PutUnknownError("intra/A.json", "TimeoutError", "none", "test"));
    await main();
    expect(process.exitCode).toBe(2);
    expect(mockR2Put).toHaveBeenCalledTimes(2);
    expect(mockFetch5m).toHaveBeenCalledTimes(3);
    expect(recordedMetadata().unknownCount).toBe(1);
    const outcomes = recordedBody().outcomes as Record<string, { status: string }>;
    expect(outcomes.A.status).toBe("unknown");
    expect(outcomes.B.status).toBe("written");
    expect(outcomes.C.status).toBe("notStarted");
  });

  it("custody failure archives current chunk attempts but prevents chunk PUT and next chunk source", async () => {
    (globalThis as { __vwapKnobs?: unknown }).__vwapKnobs = { conc: 2, delayMs: 1, maxRateLimit: 5, keepDays: 365 };
    const codes = Array.from({ length: 31 }, (_, i) => String(1000 + i));
    mockLoadCodes.mockResolvedValue(codes);
    mockFetch5m.mockResolvedValue([BAR]);
    mockR2Get.mockResolvedValue(null);
    mockRawArchive.mockRejectedValue(new Error("unknown Notion result; no resend"));
    await main();
    expect(mockRawArchive).toHaveBeenCalledTimes(1);
    expect(mockRawArchive.mock.calls[0][0].captures.map((r) => r.capture.symbol).sort()).toEqual(codes.slice(0, 30).map((c) => `${c}.T`));
    expect(mockFetch5m).toHaveBeenCalledTimes(30);
    expect(mockR2Put).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });

  it.each([
    ["UNKNOWN", new NotionUnknownResultError("unknown create; no resend")],
    ["CONFIG", new NotionConfigError("malformed Notion read envelope")],
  ])("raw custody %s keeps the local summary and sends no later Notion/R2/source work", async (_kind, error) => {
    const codes = Array.from({ length: 31 }, (_, i) => String(1000 + i));
    mockLoadCodes.mockResolvedValue(codes);
    mockFetch5m.mockResolvedValue([BAR]);
    mockR2Get.mockResolvedValue(null);
    mockRawArchive.mockRejectedValue(error);
    await main();
    expect(mockRawArchive).toHaveBeenCalledTimes(1);
    expect(mockFetch5m).toHaveBeenCalledTimes(30);
    expect(mockR2Put).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    const files = readdirSync(".vwap-summaries");
    expect(files).toHaveLength(1);
    const local = JSON.parse(readFileSync(join(".vwap-summaries", files[0]), "utf-8")) as { outcomes: Record<string, { status: string }> };
    expect(Object.keys(local.outcomes)).toHaveLength(31);
    expect(local.outcomes[codes[30]].status).toBe("notStarted");
  });

  it("normal PUT follows its own raw custody", async () => {
    mockLoadCodes.mockResolvedValue(["A"]);
    mockR2Get.mockResolvedValue(null);
    mockFetch5m.mockResolvedValue([BAR]);
    mockR2Put.mockResolvedValue(undefined);
    await main();
    expect(mockRawArchive.mock.calls[0][0].captures[0].capture.symbol).toBe("A.T");
    expect(mockRawArchive.mock.invocationCallOrder[0]).toBeLessThan(mockR2Put.mock.invocationCallOrder[0]);
    expect(process.exitCode).toBe(0);
  });

  it("sequential acquisition ignores higher CONC and R2 fault stops the next source", async () => {
    (globalThis as { __vwapKnobs?: unknown }).__vwapKnobs = { conc: 5, delayMs: 1, maxRateLimit: 5, keepDays: 365 };
    mockLoadCodes.mockResolvedValue(["A", "B", "C", "D"]);
    mockFetch5m.mockResolvedValue([BAR]);
    mockR2Get.mockImplementation(async (key: string) => {
      if (key === "intra/C.json") throw new Error("R2 GET transport fault");
      return null;
    });
    await main();
    expect(mockFetch5m.mock.calls.map(([symbol]) => symbol)).toEqual(["A.T", "B.T", "C.T"]);
    expect(mockRawArchive.mock.calls[0][0].captures.map((r) => r.capture.symbol)).toEqual(["A.T", "B.T", "C.T"]);
    expect(mockR2Put).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });

  it.each([null, Date.now() + 120_000])("first rate response deadline %s seals raw before stopping GET/PUT", async (retryAt) => {
    (globalThis as { __vwapKnobs?: unknown }).__vwapKnobs = { conc: 5, delayMs: 1, maxRateLimit: 5, keepDays: 365 };
    mockLoadCodes.mockResolvedValue(["A", "B", "C"]);
    mockFetch5m.mockRejectedValue(new YahooRateLimitError(429, 120_000, retryAt));
    await main();
    expect(mockFetch5m).toHaveBeenCalledTimes(1);
    expect(mockRawArchive.mock.calls[0][0].captures).toHaveLength(1);
    expect(mockR2Put).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });

  it("parse failure preserves the received body without another source attempt", async () => {
    mockLoadCodes.mockResolvedValue(["A"]);
    mockFetch5m.mockRejectedValueOnce(new Error("JSON parse failure")).mockResolvedValueOnce([BAR]);
    await main();
    expect(mockRawArchive.mock.calls[0][0].captures.map((r) => r.attempt)).toEqual([1]);
    expect(mockFetch5m).toHaveBeenCalledTimes(1);
    expect(mockR2Put).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("raw absent or too large aborts without retrying source or sending PUT", async () => {
    for (const tooLarge of [false, true]) {
      vi.clearAllMocks();
      rawHook.enabled = false;
      mockLoadCodes.mockResolvedValue(["A", "B"]);
      mockR2Get.mockResolvedValue(null);
      if (tooLarge) mockFetch5m.mockRejectedValue(new YahooRawTooLargeError("A.T"));
      else mockFetch5m.mockResolvedValue([BAR]);
      await main();
      expect(mockRawArchive.mock.calls[0][0].missing).toHaveLength(1);
      expect(mockFetch5m).toHaveBeenCalledTimes(1);
      expect(mockR2Put).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
      process.chdir(mkdtempSync(join(tmpdir(), "vwap-intra-raw-")));
    }
  });

  it("transport failure records one explicit missing attempt without retry or PUT", async () => {
    rawHook.enabled = false;
    mockLoadCodes.mockResolvedValue(["A"]);
    mockFetch5m.mockRejectedValue(new Error("transport connection reset"));
    await main();
    const input = mockRawArchive.mock.calls[0][0];
    expect(input.captures).toEqual([]);
    expect(input.missing?.map((r) => r.attempt)).toEqual([1]);
    expect(mockR2Put).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("invalid --range rejects (bounded override preserved)", async () => {
    process.argv = ["node", "vitest", "--range=99d"];
    await expect(main()).rejects.toThrow(/1d〜60d/);
    expect(mockLoadCodes).not.toHaveBeenCalled();
  });
});

// Full real vendor bodies remain private. CI runs the declared two-row transport projection separately.
const CURRENT2_RAW = join(SAVED_CWD, ".yahoo-raw-custody/yahoo-raw-local-4ba99b6d-vwap-intra-0-part-0.json.gz");
it.skipIf(!existsSync(CURRENT2_RAW))("actual 7531/9311 fresh60d source gaps retain full old bars and report their last valid date", async () => {
  const gzip = readFileSync(CURRENT2_RAW);
  expect(createHash("sha256").update(gzip).digest("hex")).toBe("ca47b94e7b7daee55b1d07ad4997f7a8bf213e90f6a4cb8e92c3be25c2200234");
  const data = JSON.parse(gunzipSync(gzip).toString()) as { members: Array<Omit<YahooRawCapture,"bytes"> & { bodyBase64:string; sha256:string; byteLength:number }> };
  rawHook.replay = new Map(); const parsed = new Map<string, ReturnType<typeof parseBars5m>>();
  for (const m of data.members) {
    const bytes = Buffer.from(m.bodyBase64,"base64"); expect(createHash("sha256").update(bytes).digest("hex")).toBe(m.sha256); expect(bytes.length).toBe(m.byteLength);
    rawHook.replay.set(m.symbol,{...m,bytes}); parsed.set(m.symbol,parseBars5m(JSON.parse(bytes.toString()),m.symbol));
  }
  process.argv.push("--codes=7531,9311","--range=60d");
  mockLoadCodes.mockResolvedValue(["7531","9311"]);
  const old = new Map(data.members.map(m => { const code=m.symbol.slice(0,4); return [code,readFileSync(join(SAVED_CWD,"tmp/feature-audit-20261018/holdings-rights-needed-current-v1/vwap2-readonly-v1",`${code}-body.private.json`),"utf8")]; }));
  mockR2Get.mockImplementation(async key=>({body:old.get(key.slice(6,10))!,etag:"saved-before"}));
  mockFetch5m.mockImplementation(async symbol=>parsed.get(symbol));
  await main(); expect(process.exitCode).toBe(0); expect(mockR2Put).toHaveBeenCalledTimes(2);
  for (const [key,raw] of mockR2Put.mock.calls) {
    const code=key.slice(6,10), payload=JSON.parse(raw), before=JSON.parse(old.get(code)!);
    expect(before.bars.every((b:{ts:number})=>payload.bars.some((n:{ts:number})=>n.ts===b.ts))).toBe(true);
    expect(payload.sourceStatus).toMatchObject({status:"source_unavailable",lastSourceDate:"2026-10-16"});
    expect((recordedBody().outcomes as Record<string,unknown>)[code]).toMatchObject({sourceStatus:payload.sourceStatus,lastValidDate:code==="7531"?"2026-10-08":"2026-10-07"});
  }
  expect(mockRawArchive.mock.invocationCallOrder[0]).toBeLessThan(mockR2Put.mock.invocationCallOrder[0]);
});

it("declared actual-row all-NULL fault persists source status only, keeps old bars, and retains nonzero exit", async () => {
  const wire = JSON.parse(readFileSync(new URL("./tests/fixtures/intra-source-status-7531.json", import.meta.url), "utf8"));
  const oldBars = parseBars5m(wire, "7531.T");
  const r = wire.chart.result[0], q = r.indicators.quote[0];
  r.timestamp = [r.timestamp[1]]; for (const k of Object.keys(q)) q[k] = [q[k][1]];
  const capture: YahooRawCapture = { symbol: "7531.T", status: 200, receivedAt: wire.provenance.receivedAt, headers: {}, url: "https://query1.finance.yahoo.com/v8/finance/chart/7531.T", bytes: new TextEncoder().encode(JSON.stringify(wire)) };
  rawHook.replay = new Map([["7531.T", capture]]);
  mockLoadCodes.mockResolvedValue(["7531"]); mockFetch5m.mockImplementation(async () => parseBars5m(wire, "7531.T"));
  const old = { code: "7531", bars: oldBars }; mockR2Get.mockResolvedValue({ body: JSON.stringify(old), etag: "old-version" });
  await main(); expect(process.exitCode).toBe(1); expect(mockFetch5m).toHaveBeenCalledTimes(1); expect(mockR2Put).toHaveBeenCalledTimes(1);
  expect(JSON.parse(mockR2Put.mock.calls[0][1])).toMatchObject({ bars: old.bars, sourceStatus: { status: "source_unavailable", lastValidSourceDate: null } });
  expect(mockR2Put.mock.calls[0][2]).toBe("old-version");
  expect(recordedBody()).toMatchObject({ errors: 1, empty: 0, written: 1, outcomes: { "7531": { status: "error", bodySha: expect.stringMatching(/^[a-f0-9]{64}$/) } } });
  expect(mockRawArchive.mock.invocationCallOrder[0]).toBeLessThan(mockR2Put.mock.invocationCallOrder[0]);
});
