import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { R2PutRejectedError, R2PutUnknownError } from "./lib/r2.js";
import { r2GetVersion, r2Put } from "./lib/r2.js";
import { loadCodes } from "./lib/codes.js";
import { fetchDaily } from "../../src/shared/yahoo/client.js";
import { recordPrimaryData } from "../../src/shared/notion-archive/index.js";
import { main, tenYearRange } from "./ingest-daily.js";

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

const mockR2Get = vi.mocked(r2GetVersion);
const mockR2Put = vi.mocked(r2Put);
const mockLoadCodes = vi.mocked(loadCodes);
const mockFetchDaily = vi.mocked(fetchDaily);
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
    expect(mockFetchDaily).toHaveBeenCalledTimes(1);
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

  it("first PUT timeout => PUT1/Yahoo0-more/unknown1/notStarted1/exit2 (archive still runs)", async () => {
    mockLoadCodes.mockResolvedValue(["A", "B"]);
    mockR2Get.mockResolvedValue(null);
    mockFetchDaily.mockResolvedValue({ bars: [BAR_A], splits: [], proof: FAKE_PROOF });
    mockR2Put.mockRejectedValueOnce(new R2PutUnknownError("daily/A.json", "TimeoutError", "none", "test"));
    await main();
    expect(process.exitCode).toBe(2);
    expect(mockR2Put).toHaveBeenCalledTimes(1);
    // B の Yahoo は叩かない。
    expect(mockFetchDaily).toHaveBeenCalledTimes(1);
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

  it("delayed worker rechecks fatal after GET await => no new stage", async () => {
    (globalThis as { __vwapKnobs?: unknown }).__vwapKnobs = { conc: 2, delayMs: 1, maxRateLimit: 5, keepDays: 365 };
    mockLoadCodes.mockResolvedValue(["A", "B", "C"]);
    let openGate!: () => void;
    const gate = new Promise<void>((r) => { openGate = r; });
    mockR2Get.mockImplementation(async (key: string) => {
      if (key === "daily/A.json") await gate;
      return null;
    });
    mockFetchDaily.mockResolvedValue({ bars: [BAR_A], splits: [], proof: FAKE_PROOF });
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
    const outcomes = recordedBody().outcomes as Record<string, { status: string; latestSourceBar: unknown }>;
    expect(outcomes.A).toEqual({ status: "notStarted", latestSourceBar: null, bodySha: null });
    expect(outcomes.B.status).toBe("unknown");
    expect(outcomes.C.status).toBe("notStarted");
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
