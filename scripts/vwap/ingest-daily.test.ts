import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { R2PutRejectedError, R2PutUnknownError } from "./lib/r2.js";
import { r2GetVersion, r2Put } from "./lib/r2.js";
import { loadCodes } from "./lib/codes.js";
import { MAX_YAHOO_RAW_BYTES, YahooRawTooLargeError, parseDailyChart } from "../../src/shared/yahoo/client.js";
import { recordPrimaryData } from "../../src/shared/notion-archive/index.js";
import { archiveYahooRawBatch } from "../../src/shared/yahoo/raw-custody.js";
import { main, tenYearRange } from "./ingest-daily.js";

const dailySource = vi.hoisted(() => vi.fn());
const rawHook = vi.hoisted(() => ({ enabled: true, status: 200, size: 28 }));

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
  return { ...mod, fetchDaily: async (...args: Parameters<typeof mod.fetchDaily>) => {
    if (rawHook.enabled) await args[2]?.onRaw?.({ symbol: args[0], status: rawHook.status,
      bytes: new Uint8Array(rawHook.size),
      url: "https://query1.finance.yahoo.com/v8/finance/chart/test", receivedAt: new Date().toISOString(), headers: {} });
    return dailySource(...args);
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
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.argv = ["node", "vitest"];
  process.exitCode = undefined;
  (globalThis as { __vwapKnobs?: unknown }).__vwapKnobs = undefined;
  mockRecord.mockResolvedValue({ outcome: "recorded", fileTooLarge: false } as never);
  rawHook.enabled = true;
  rawHook.status = 200;
  rawHook.size = 28;
  mockRawArchive.mockResolvedValue({ pages: ["test-page"], rawBytes: 1, compressedBytes: 1 });
  process.chdir(mkdtempSync(join(tmpdir(), "vwap-daily-")));
});
afterEach(() => {
  process.chdir(SAVED_CWD);
  process.argv = SAVED_ARGV;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});
const localSummaryBody = (): Record<string, unknown> => {
  const files = readdirSync(".vwap-summaries");
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(".vwap-summaries", files[0]), "utf-8")) as Record<string, unknown>;
};

describe("ingest-daily main flow", () => {
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

  it("first PUT timeout => PUT1/unknown1/prepared-notStarted1/exit2 (archive still runs)", async () => {
    mockLoadCodes.mockResolvedValue(["A", "B"]);
    mockR2Get.mockResolvedValue(null);
    mockFetchDaily.mockResolvedValue({ bars: [BAR_A], splits: [], proof: FAKE_PROOF });
    mockR2Put.mockRejectedValueOnce(new R2PutUnknownError("daily/A.json", "TimeoutError", "none", "test"));
    await main();
    expect(process.exitCode).toBe(2);
    expect(mockR2Put).toHaveBeenCalledTimes(1);
    // B は同じ保管batchで取得済みだが、unknown後の新規取得/PUTはしない。
    expect(mockFetchDaily).toHaveBeenCalledTimes(2);
    expect(mockFetchDaily.mock.calls[0][0]).toBe("A.T");
    // summary 保管は走り、unknown1/notStarted1 を記録する。
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(recordedMetadata().unknownCount).toBe(1);
    const outcomes = recordedBody().outcomes as Record<string, { status: string }>;
    expect(outcomes.A.status).toBe("unknown");
    expect(outcomes.B.status).toBe("notStarted");
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
    const second = new Promise<void>((resolve) => { ready = resolve; });
    mockFetchDaily.mockImplementation(async (symbol: string) => {
      if (symbol === "A.T") await delayed;
      else ready();
      return { bars: [BAR_A], splits: [], proof: FAKE_PROOF };
    });
    mockRawArchive.mockRejectedValue(new Error("physical readback mismatch"));
    const running = main();
    await second;
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

  it("HTTP rate-limit ABORT still archives the acquired body and sends no PUT", async () => {
    rawHook.status = 429;
    (globalThis as { __vwapKnobs?: unknown }).__vwapKnobs = { conc: 1, delayMs: 1, maxRateLimit: 1, keepDays: 365 };
    mockLoadCodes.mockResolvedValue(["A", "B"]);
    mockR2Get.mockResolvedValue(null);
    mockFetchDaily.mockRejectedValue(Object.assign(new Error("yahoo 429"), { name: "YahooRateLimitError" }));
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
  }
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

describe("tenYearRange", () => {
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
