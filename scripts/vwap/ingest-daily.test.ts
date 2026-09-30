import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { R2PutUnknownError } from "./lib/r2.js";
import { r2Get, r2Put } from "./lib/r2.js";
import { loadCodes } from "./lib/codes.js";
import { fetchDaily } from "../../src/shared/yahoo/client.js";
import { recordPrimaryData } from "../../src/shared/notion-archive/index.js";
import { main } from "./ingest-daily.js";

vi.mock("./lib/r2.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./lib/r2.js")>();
  return { ...mod, r2Get: vi.fn(), r2Put: vi.fn() };
});
vi.mock("./lib/codes.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./lib/codes.js")>();
  return { ...mod, loadCodes: vi.fn() };
});
vi.mock("../../src/shared/yahoo/client.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/shared/yahoo/client.js")>();
  return { ...mod, fetchDaily: vi.fn() };
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
    vwapKnobs: () =>
      (globalThis as { __vwapKnobs?: { conc: number; delayMs: number; maxRateLimit: number; keepDays: number } })
        .__vwapKnobs ?? { conc: 1, delayMs: 1, maxRateLimit: 5, keepDays: 365 },
  },
}));

const mockR2Get = vi.mocked(r2Get);
const mockR2Put = vi.mocked(r2Put);
const mockLoadCodes = vi.mocked(loadCodes);
const mockFetchDaily = vi.mocked(fetchDaily);
const mockRecord = vi.mocked(recordPrimaryData);

const BAR_A = { date: "2026-09-25", o: 100, h: 110, l: 90, c: 105, v: 1000, adj: 104 };
const BAR_B = { date: "2026-09-25", o: 200, h: 210, l: 190, c: 205, v: 2000, adj: 204 };
const existingA = JSON.stringify({ code: "A", updated: "2026-09-28T00:00:00.000Z", bars: [BAR_A], splits: [] });

const SAVED_ARGV = [...process.argv];
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.argv = ["node", "vitest"];
  process.exitCode = undefined;
  (globalThis as { __vwapKnobs?: unknown }).__vwapKnobs = undefined;
  mockRecord.mockResolvedValue({ outcome: "recorded", fileTooLarge: false } as never);
});
afterEach(() => {
  process.argv = SAVED_ARGV;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("ingest-daily main flow", () => {
  it("normal positive + skip control (exit 0, all codes accounted)", async () => {
    mockLoadCodes.mockResolvedValue(["A", "B"]);
    mockR2Get.mockImplementation(async (key: string) => (key === "daily/A.json" ? existingA : null));
    mockFetchDaily.mockImplementation(async (symbol: string) =>
      symbol === "A.T" ? { bars: [BAR_A], splits: [] } : { bars: [BAR_B], splits: [] }
    );
    await main();
    expect(process.exitCode).toBe(0);
    expect(mockFetchDaily).toHaveBeenCalledTimes(2);
    // B のみ PUT。A は内容同一で skip。
    expect(mockR2Put).toHaveBeenCalledTimes(1);
    expect(mockR2Put.mock.calls[0][0]).toBe("daily/B.json");
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const summary = mockRecord.mock.calls[0][0] as {
      key: string;
      metadata: Record<string, unknown>;
    };
    expect(summary.key).toMatch(/^vwap-ingest-daily-/);
    const outcomes = summary.metadata.outcomes as Record<string, { status: string; latestSourceBar: unknown; bodySha: unknown }>;
    expect(Object.keys(outcomes).sort()).toEqual(["A", "B"]);
    expect(outcomes.A.status).toBe("skipped");
    expect(outcomes.A.latestSourceBar).toBe("2026-09-25");
    // skip の pin は standing の既存 bytes。
    expect(typeof outcomes.A.bodySha).toBe("string");
    expect(outcomes.B.status).toBe("written");
    expect(outcomes.B.latestSourceBar).toBe("2026-09-25");
    expect(typeof outcomes.B.bodySha).toBe("string");
    expect(summary.metadata.universe).toMatchObject({ size: 2 });
    expect(summary.metadata.unknown).toEqual([]);
  });

  it("first PUT timeout => PUT1/Yahoo0-more/unknown1/notStarted1/exit2 (archive still runs)", async () => {
    mockLoadCodes.mockResolvedValue(["A", "B"]);
    mockR2Get.mockResolvedValue(null);
    mockFetchDaily.mockResolvedValue({ bars: [BAR_A], splits: [] });
    mockR2Put.mockRejectedValueOnce(new R2PutUnknownError("daily/A.json", "TimeoutError", "none", "test"));
    await main();
    expect(process.exitCode).toBe(2);
    expect(mockR2Put).toHaveBeenCalledTimes(1);
    // B の Yahoo は叩かない。
    expect(mockFetchDaily).toHaveBeenCalledTimes(1);
    expect(mockFetchDaily.mock.calls[0][0]).toBe("A.T");
    // summary 保管は走り、unknown1/notStarted1 を記録する。
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const summary = mockRecord.mock.calls[0][0] as { metadata: Record<string, unknown> };
    expect(summary.metadata.unknown).toEqual(["A"]);
    const outcomes = summary.metadata.outcomes as Record<string, { status: string }>;
    expect(outcomes.A.status).toBe("unknown");
    expect(outcomes.B.status).toBe("notStarted");
  });

  it("strict GET fault => source0/PUT0/exit2", async () => {
    mockLoadCodes.mockResolvedValue(["A", "B"]);
    mockR2Get.mockRejectedValue(new Error("R2 GET 応答が不完全です: daily/A.json"));
    await main();
    expect(process.exitCode).toBe(2);
    expect(mockFetchDaily).toHaveBeenCalledTimes(0);
    expect(mockR2Put).toHaveBeenCalledTimes(0);
    const summary = mockRecord.mock.calls[0][0] as { metadata: Record<string, unknown> };
    const outcomes = summary.metadata.outcomes as Record<string, { status: string }>;
    expect(outcomes.A.status).toBe("error");
    expect(outcomes.B.status).toBe("notStarted");
  });

  it("delayed worker rechecks fatal after GET await => no new stage", async () => {
    (globalThis as { __vwapKnobs?: unknown }).__vwapKnobs = { conc: 2, delayMs: 1, maxRateLimit: 5, keepDays: 365 };
    mockLoadCodes.mockResolvedValue(["A", "B", "C"]);
    let openGate!: () => void;
    const gate = new Promise<void>((r) => { openGate = r; });
    mockR2Get.mockImplementation(async (key: string) => {
      if (key === "daily/A.json") await gate;
      return null;
    });
    mockFetchDaily.mockResolvedValue({ bars: [BAR_A], splits: [] });
    mockR2Put.mockImplementation(async (key: string) => {
      if (key === "daily/B.json") {
        openGate();
        throw new R2PutUnknownError(key, "TimeoutError", "none", "test");
      }
      throw new Error(`unexpected PUT ${key}`);
    });
    await main();
    expect(process.exitCode).toBe(2);
    expect(mockR2Put).toHaveBeenCalledTimes(1);
    // A は GET 解決後に fatal 再確認で止まり、Yahoo を叩かない。C も未着手。
    expect(mockFetchDaily).toHaveBeenCalledTimes(1);
    expect(mockFetchDaily.mock.calls[0][0]).toBe("B.T");
    const summary = mockRecord.mock.calls[0][0] as { metadata: Record<string, unknown> };
    const outcomes = summary.metadata.outcomes as Record<string, { status: string; latestSourceBar: unknown }>;
    expect(outcomes.A).toEqual({ status: "notStarted", latestSourceBar: null, bodySha: null });
    expect(outcomes.B.status).toBe("unknown");
    expect(outcomes.C.status).toBe("notStarted");
  });

  it("archive failure => exit 2 (intra must not run)", async () => {
    mockLoadCodes.mockResolvedValue(["A"]);
    mockR2Get.mockResolvedValue(null);
    mockFetchDaily.mockResolvedValue({ bars: [BAR_A], splits: [] });
    mockR2Put.mockResolvedValue(undefined);
    mockRecord.mockResolvedValue({ outcome: "skipped_existing", fileTooLarge: false } as never);
    await main();
    expect(process.exitCode).toBe(2);
  });
});
