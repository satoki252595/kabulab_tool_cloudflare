import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { R2PutRejectedError, R2PutUnknownError } from "./lib/r2.js";
import { r2GetVersion, r2Put } from "./lib/r2.js";
import { loadCodes } from "./lib/codes.js";
import { YahooRawTooLargeError } from "../../src/shared/yahoo/client.js";
import { recordPrimaryData } from "../../src/shared/notion-archive/index.js";
import { archiveYahooRawBatch } from "../../src/shared/yahoo/raw-custody.js";
import { main } from "./ingest-intra.js";

const intraSource = vi.hoisted(() => vi.fn());
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
  return { ...mod, fetchBars5m: async (...args: Parameters<typeof mod.fetchBars5m>) => {
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
  vi.spyOn(console, "log").mockImplementation(() => {});
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
});

describe("ingest-intra main flow", () => {
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
    const codes = Array.from({ length: 13 }, (_, i) => String(1000 + i));
    mockLoadCodes.mockResolvedValue(codes);
    mockFetch5m.mockResolvedValue([BAR]);
    mockR2Get.mockResolvedValue(null);
    mockRawArchive.mockRejectedValue(new Error("unknown Notion result; no resend"));
    await main();
    expect(mockRawArchive).toHaveBeenCalledTimes(1);
    expect(mockRawArchive.mock.calls[0][0].captures.map((r) => r.capture.symbol).sort()).toEqual(codes.slice(0, 12).map((c) => `${c}.T`));
    expect(mockFetch5m).toHaveBeenCalledTimes(12);
    expect(mockR2Put).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
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

  it("second-wave fatal waits for all captured raw and prevents third-wave source and batch PUT", async () => {
    (globalThis as { __vwapKnobs?: unknown }).__vwapKnobs = { conc: 2, delayMs: 1, maxRateLimit: 5, keepDays: 365 };
    mockLoadCodes.mockResolvedValue(["A", "B", "C", "D", "E", "F"]);
    let ready!: () => void;
    const secondWaveReady = new Promise<void>((resolve) => { ready = resolve; });
    mockFetch5m.mockImplementation(async (symbol: string) => {
      if (symbol === "D.T") ready();
      return [BAR];
    });
    mockR2Get.mockImplementation(async (key: string) => {
      if (key === "intra/C.json") {
        await secondWaveReady;
        throw new Error("R2 GET transport fault");
      }
      return null;
    });
    await main();
    expect(mockFetch5m.mock.calls.map(([symbol]) => symbol).sort()).toEqual(["A.T", "B.T", "C.T", "D.T"]);
    expect(mockRawArchive).toHaveBeenCalledTimes(1);
    expect(mockRawArchive.mock.calls[0][0].captures.map((r) => r.capture.symbol).sort()).toEqual(["A.T", "B.T", "C.T", "D.T"]);
    expect(mockR2Put).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });

  it("parse failures preserve every received retry body before successful PUT", async () => {
    mockLoadCodes.mockResolvedValue(["A"]);
    mockR2Get.mockResolvedValue(null);
    mockFetch5m.mockRejectedValueOnce(new Error("JSON parse failure"))
      .mockRejectedValueOnce(new Error("bar guard failure")).mockResolvedValueOnce([BAR]);
    mockR2Put.mockResolvedValue(undefined);
    await main();
    expect(mockRawArchive.mock.calls[0][0].captures.map((r) => r.attempt)).toEqual([1, 2, 3]);
    expect(mockFetch5m).toHaveBeenCalledTimes(3);
    expect(mockR2Put).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(0);
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

  it("transport retries without a response record explicit missing attempts and never PUT", async () => {
    rawHook.enabled = false;
    mockLoadCodes.mockResolvedValue(["A"]);
    mockFetch5m.mockRejectedValue(new Error("transport connection reset"));
    await main();
    const input = mockRawArchive.mock.calls[0][0];
    expect(input.captures).toEqual([]);
    expect(input.missing?.map((r) => r.attempt)).toEqual([1, 2, 3]);
    expect(mockR2Put).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("invalid --range rejects (bounded override preserved)", async () => {
    process.argv = ["node", "vitest", "--range=99d"];
    await expect(main()).rejects.toThrow(/1d〜60d/);
    expect(mockLoadCodes).not.toHaveBeenCalled();
  });
});
