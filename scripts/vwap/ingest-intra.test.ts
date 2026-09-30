import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { R2PutRejectedError, R2PutUnknownError } from "./lib/r2.js";
import { r2GetVersion, r2Put } from "./lib/r2.js";
import { loadCodes } from "./lib/codes.js";
import { fetchBars5m } from "../../src/shared/yahoo/client.js";
import { recordPrimaryData } from "../../src/shared/notion-archive/index.js";
import { main } from "./ingest-intra.js";

vi.mock("./lib/r2.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./lib/r2.js")>();
  return { ...mod, r2GetVersion: vi.fn(), r2Put: vi.fn() };
});
vi.mock("./lib/codes.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./lib/codes.js")>();
  return { ...mod, loadCodes: vi.fn() };
});
vi.mock("../../src/shared/yahoo/client.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/shared/yahoo/client.js")>();
  return { ...mod, fetchBars5m: vi.fn() };
});
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
    vwapKnobs: () => ({ conc: 1, delayMs: 1, maxRateLimit: 5, keepDays: 365 }),
    VWAP_INTRA_RANGE: () => "5d",
  },
}));

const mockR2Get = vi.mocked(r2GetVersion);
const mockR2Put = vi.mocked(r2Put);
const mockLoadCodes = vi.mocked(loadCodes);
const mockFetch5m = vi.mocked(fetchBars5m);
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
    expect(mockFetch5m).toHaveBeenCalledTimes(1);
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
    expect(mockFetch5m).toHaveBeenCalledTimes(1);
    expect(recordedMetadata().unknownCount).toBe(1);
    const outcomes = recordedBody().outcomes as Record<string, { status: string }>;
    expect(outcomes.A.status).toBe("unknown");
    expect(outcomes.B.status).toBe("notStarted");
  });

  it("invalid --range rejects (bounded override preserved)", async () => {
    process.argv = ["node", "vitest", "--range=99d"];
    await expect(main()).rejects.toThrow(/1d〜60d/);
    expect(mockLoadCodes).not.toHaveBeenCalled();
  });
});
