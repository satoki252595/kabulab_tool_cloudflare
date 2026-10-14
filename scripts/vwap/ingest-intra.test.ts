import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { R2PutRejectedError, R2PutUnknownError } from "./lib/r2.js";
import { r2GetVersion, r2Put } from "./lib/r2.js";
import { loadCodes } from "./lib/codes.js";
import { YahooRawTooLargeError, YahooRateLimitError } from "../../src/shared/yahoo/client.js";
import { recordPrimaryData } from "../../src/shared/notion-archive/index.js";
import { NotionUnknownResultError } from "../../src/shared/notion-archive/client.js";
import { NotionConfigError } from "../../src/shared/notion-archive/env.js";
import { archiveYahooRawBatch } from "../../src/shared/yahoo/raw-custody.js";
import { main } from "./ingest-intra.js";
import { scheduledVwapGuard } from "./lib/scheduled-window.js";

const intraSource = vi.hoisted(() => vi.fn());
const intraWindowSource = vi.hoisted(() => vi.fn());
const rawHook = vi.hoisted(() => ({ enabled: true }));

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
    if (rawHook.enabled) await args[2]?.onRaw?.({ symbol: args[0], status: 200,
      bytes: new TextEncoder().encode("test-only captured HTTP body"),
      url: "https://query1.finance.yahoo.com/v8/finance/chart/test", receivedAt: new Date().toISOString(), headers: {} });
    return intraSource(...args);
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

const SAVED_ARGV = [...process.argv];
const SAVED_CWD = process.cwd();
// main() は cwd/.vwap-summaries/ へ原本を書く。repo 汚染防止で tmp へ chdir。
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.argv = ["node", "vitest"];
  process.exitCode = undefined;
  mockRecord.mockResolvedValue({ outcome: "recorded", fileTooLarge: false } as never);
  rawHook.enabled = true;
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
    expect(mockR2Put).not.toHaveBeenCalled();
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
    expect(mockR2Put).toHaveBeenCalledTimes(mode === "unknown-put" ? 1 : 2);
    expect(mockR2Put.mock.calls[0][2]).toBe("observed-intra-version");
    expect(JSON.parse(mockR2Put.mock.calls[0][1]).bars).toEqual([retained, fresh]);
    const body = recordedBody(), outcomes = body.outcomes as Record<string, { status: string; sourceWindowProof: { rawSha256: string; lastTs: number; sourceUrl: string } }>;
    expect(body.range).toContain("period1=");expect(body.range).not.toBe("60d");
    expect(outcomes["593A"].sourceWindowProof.lastTs).toBe(at);
    expect(outcomes["593A"].sourceWindowProof.rawSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(outcomes["593A"].sourceWindowProof.sourceUrl).toContain("period2=");
    expect(recordedMetadata().sourceWindow).toMatchObject({ toExclusive: "2026-10-13T06:30:01Z" });
    expect(process.exitCode).toBe(mode === "unknown-put" ? 2 : 0);
    if (mode === "unknown-put") { expect(body.unknown).toEqual(["593A"]);expect(outcomes["598A"].status).toBe("notStarted"); }
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
    mockR2Get.mockImplementation(async (key: string) => (key === "intra/A.json" ? { body: existingA, etag: "observed-version" } : null));
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

  it("PUT unknown => unknown1/notStarted1/exit2", async () => {
    mockLoadCodes.mockResolvedValue(["A", "B"]);
    mockR2Get.mockResolvedValue(null);
    mockFetch5m.mockResolvedValue([BAR]);
    mockR2Put.mockRejectedValueOnce(new R2PutUnknownError("intra/A.json", "TimeoutError", "none", "test"));
    await main();
    expect(process.exitCode).toBe(2);
    expect(mockR2Put).toHaveBeenCalledTimes(1);
    expect(mockFetch5m).toHaveBeenCalledTimes(2);
    expect(recordedMetadata().unknownCount).toBe(1);
    const outcomes = recordedBody().outcomes as Record<string, { status: string }>;
    expect(outcomes.A.status).toBe("unknown");
    expect(outcomes.B.status).toBe("notStarted");
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
