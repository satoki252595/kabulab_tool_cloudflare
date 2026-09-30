import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchChart } from "../../src/shared/yahoo/client.js";
import {
  findBackupChildByTitle,
  queryUniqueRow,
} from "../../src/shared/notion-archive/archive.js";
import { NotionUnknownResultError } from "../../src/shared/notion-archive/client.js";
import { listPageFiles } from "../../src/shared/notion-archive/index.js";
import { sha256HexBytes } from "../../src/shared/sha256.js";

vi.mock("../../src/shared/notion-archive/index.js", async (original) => ({
  ...(await original<typeof import("../../src/shared/notion-archive/index.js")>()),
  listPageFiles: vi.fn(),
}));
vi.mock("../../src/shared/notion-archive/archive.js", async (original) => ({
  ...(await original<typeof import("../../src/shared/notion-archive/archive.js")>()),
  findBackupChildByTitle: vi.fn(),
  queryUniqueRow: vi.fn(),
}));
import {
  REPAIR_DIAG_KEY,
  loadReceiptProofFile,
  ohlcvSevenEqual,
  parseDiagManifest,
  parseEligibleFile,
  persistReceiptProofFile,
  probeReceiptProofAbsent,
  receiptProofPath,
  replayRawBar,
  resumeReceiptProof,
  runGapRepair,
  verifyReceiptAttachment,
  type DiagManifest,
  type EligibleGrant,
  type GapRepairDeps,
  type OhlcvSeven,
} from "./stock-gap-repair.js";

/**
 * Issue #163 replay 修復のテスト。live なし:
 * - replay は構造 double の Chart JSON を実 parse + 実 guard で検証する。
 * - runner は custody/targets/rows/batch/record を注入し、disposition・
 *   CAS・readback・receipt を検証する。Yahoo fetch は使わない。
 */

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

const TS = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 1000;
const D28 = TS(2026, 9, 28);
const D29 = TS(2026, 9, 29);

interface Bar {
  ts: number;
  o: number | null;
  h: number | null;
  l: number | null;
  c: number | null;
  v: number | null;
  adj: number | null;
}
const bar = (
  ts: number,
  c: number | null,
  v: number | null = 1000,
  adj: number | null | undefined = undefined
): Bar => ({
  ts,
  o: c === null ? null : c - 1,
  h: c === null ? null : c + 1,
  l: c === null ? null : c - 2,
  c,
  v,
  adj: adj === undefined ? c : adj,
});

function chartJson(bars: Bar[], metaPrice: number | null, symbol = "0000.T") {
  const col = (pick: (b: Bar) => number | null) => bars.map(pick);
  return {
    chart: {
      result: [
        {
          meta: { symbol, regularMarketPrice: metaPrice, previousClose: null },
          timestamp: bars.map((b) => b.ts),
          indicators: {
            quote: [
              {
                open: col((b) => b.o),
                high: col((b) => b.h),
                low: col((b) => b.l),
                close: col((b) => b.c),
                volume: col((b) => b.v),
              },
            ],
            adjclose: [{ adjclose: col((b) => b.adj) }],
          },
        },
      ],
      error: null,
    },
  };
}

const bytesOf = (json: unknown) => new TextEncoder().encode(JSON.stringify(json));

describe("parseDiagManifest", () => {
  const base = {
    key: REPAIR_DIAG_KEY,
    date: "2026-09-29",
    completeness: "complete",
    codes: [{ code: "1380", httpStatus: 200, sha256: "s", byteLength: 10, category: "has_real_bar", reason: "x" }],
    unattempted: [],
  };

  it("正形を通し、key/date 不一致・型不正は STOP する", () => {
    expect(parseDiagManifest(base).codes).toHaveLength(1);
    expect(() => parseDiagManifest({ ...base, key: "other" })).toThrow(/key 不一致/);
    expect(() => parseDiagManifest({ ...base, date: "2026-09-30" })).toThrow(/date 不一致/);
    expect(() => parseDiagManifest({ ...base, codes: [{ code: "1380" }] })).toThrow(/code\/category/);
    expect(() => parseDiagManifest(null)).toThrow();
  });
});

describe("parseEligibleFile", () => {
  const base = {
    date: "2026-09-29",
    source: "B公式manifest",
    sourceSha256: "a".repeat(64),
    archivePins: ["pin-1"],
    codes: ["1380", "1787"],
  };

  it("正形を通し、不備は STOP する (bare list は受けない)", () => {
    const g = parseEligibleFile(JSON.stringify(base));
    expect([...g.codes]).toEqual(["1380", "1787"]);
    expect(g.sourceSha256).toBe("a".repeat(64));
    expect(() => parseEligibleFile("{oops")).toThrow(/JSON ではない/);
    expect(() => parseEligibleFile(JSON.stringify({ ...base, date: "2026-09-30" }))).toThrow(/date 不一致/);
    expect(() => parseEligibleFile(JSON.stringify({ ...base, sourceSha256: "zz" }))).toThrow(/hex64/);
    expect(() => parseEligibleFile(JSON.stringify({ ...base, archivePins: [] }))).toThrow(/archivePins/);
    expect(() => parseEligibleFile(JSON.stringify({ ...base, codes: [] }))).toThrow(/codes が空/);
    expect(() => parseEligibleFile(JSON.stringify({ ...base, codes: ["1380", "1380"] }))).toThrow(/重複/);
  });
});

describe("replayRawBar", () => {
  it("9/29 正値バーは原文のまま採用する (adj 別値・v0 維持)", () => {
    const out = replayRawBar("1380", bytesOf(chartJson([bar(D28, 100), bar(D29, 101, 0, 99)], 101, "1380.T")));
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.row).toEqual({ date: "2026-09-29", open: 100, high: 102, low: 99, close: 101, volume: 0, adj: 99 });
  });

  it("9/29 欠落・重複・raw close 不正は HOLD する", () => {
    expect(replayRawBar("1380", bytesOf(chartJson([bar(D28, 100)], 100, "1380.T"))).kind).toBe("held");
    const dup = replayRawBar("1380", bytesOf(chartJson([bar(D29, 101), bar(D29, 102)], 101, "1380.T")));
    expect(dup).toEqual({ kind: "held", reason: expect.stringMatching(/duplicate/) });
    const nul = replayRawBar("1380", bytesOf(chartJson([bar(D28, 100), bar(D29, null, 0, null)], 100, "1380.T")));
    expect(nul).toEqual({ kind: "held", reason: "raw-close-not-positive-finite" });
    // close 0 (o=-1 連れ) は共有 guard 冒頭の raw 検査で応答全体を拒否する。
    const zero = replayRawBar("1380", bytesOf(chartJson([bar(D28, 100), bar(D29, 0)], 100, "1380.T")));
    expect(zero.kind).toBe("held");
    if (zero.kind === "held") expect(zero.reason).toMatch(/^guard-rejected:/);
  });

  it("sanitize 棄却・応答乖離は HOLD する (保存しない)", () => {
    const rej = replayRawBar("1909", bytesOf(chartJson([bar(D28, 100), bar(D29, 5000, 0)], 100, "1909.T")));
    expect(rej).toEqual({ kind: "held", reason: "guarded-9/29-missing" });
    const inc = replayRawBar("7082", bytesOf(chartJson([bar(D29, 100, 0)], 5000, "7082.T")));
    expect(inc.kind).toBe("held");
    if (inc.kind === "held") expect(inc.reason).toMatch(/^guard-rejected:/);
  });

  it("raw 実在値の異常 (出来高負・OHL 非正・adj 非正) は HOLD する", () => {
    const negVol = replayRawBar("1380", bytesOf(chartJson([bar(D28, 100), { ...bar(D29, 101), v: -5 }], 101, "1380.T")));
    expect(negVol.kind).toBe("held");
    const zeroOpen = replayRawBar("1380", bytesOf(chartJson([bar(D28, 100), { ...bar(D29, 101), o: 0 }], 101, "1380.T")));
    expect(zeroOpen.kind).toBe("held");
    const negAdj = replayRawBar("1380", bytesOf(chartJson([bar(D28, 100), bar(D29, 101, 2000, -3)], 101, "1380.T")));
    expect(negAdj.kind).toBe("held");
    // null・adj null・v0 は正常 (欠落扱い)。
    const ok = replayRawBar(
      "1380",
      bytesOf(chartJson([{ ...bar(D28, 100), adj: null }, bar(D29, 101, 0, null)], 101, "1380.T"))
    );
    expect(ok.kind).toBe("ok");
  });

  it("壊れた本文は HOLD する", () => {
    expect(replayRawBar("1380", new TextEncoder().encode("{oops"))).toEqual({
      kind: "held",
      reason: "raw-not-json",
    });
  });

  it("guard は本番 fetchChart と同等 (同一原文・同一 9/29 判定)", async () => {
    process.env.YAHOO_PROXY_BASE = "https://kabulab.example.test";
    process.env.CRON_SECRET = "test-secret";
    const json = chartJson([bar(D28, 100), bar(D29, 101, 2000)], 101, "1380.T");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(json), { status: 200 })));
    const chart = await fetchChart("1380", "5y");
    const replay = replayRawBar("1380", bytesOf(json));
    expect(replay.kind).toBe("ok");
    if (replay.kind !== "ok") return;
    const live29 = chart.ohlcv.find((b) => b.date === "2026-09-29");
    expect(live29).toBeDefined();
    expect(replay.row).toEqual({
      date: "2026-09-29",
      open: live29?.open ?? null,
      high: live29?.high ?? null,
      low: live29?.low ?? null,
      close: live29?.close ?? null,
      volume: live29?.volume ?? null,
      adj: live29?.adj ?? null,
    });
  });
});

describe("ohlcvSevenEqual", () => {
  const row: OhlcvSeven = { date: "2026-09-29", open: 1, high: 2, low: 0.5, close: 1.5, volume: 0, adj: null };
  it("null-safe に同値を判定する", () => {
    expect(ohlcvSevenEqual(row, { ...row })).toBe(true);
    expect(ohlcvSevenEqual(row, { ...row, volume: null })).toBe(false);
    expect(ohlcvSevenEqual(row, { ...row, close: 1.6 })).toBe(false);
    expect(ohlcvSevenEqual(row, { ...row, date: "2026-09-30" })).toBe(false);
  });
});

describe("runGapRepair", () => {
  const manifestOf = (codes: DiagManifest["codes"]): DiagManifest => ({
    key: REPAIR_DIAG_KEY,
    date: "2026-09-29",
    completeness: "complete",
    codes,
    unattempted: [],
  });
  const codeEntry = (code: string, category = "has_real_bar") => ({
    code,
    httpStatus: 200,
    sha256: "s",
    byteLength: 10,
    category,
    reason: "x",
  });
  const okRaw = (code: string, close = 101) =>
    bytesOf(chartJson([bar(D28, 100), bar(D29, close, 2000)], close, `${code}.T`));
  const okRow = (close: number): OhlcvSeven => ({
    date: "2026-09-29",
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 2000,
    adj: close,
  });
  const grant = (codes: string[]): EligibleGrant => ({
    codes: new Set(codes),
    fileSha256: "f".repeat(64),
    source: "test-grant",
    sourceSha256: "a".repeat(64),
    archivePins: ["pin-1"],
  });
  /** 1 回目は不存在、2 回目以降は送信分を返す readRows (readback 成功の再現)。 */
  const echoReadRows = (rows: [number, OhlcvSeven][]) => {
    let calls = 0;
    return async (): Promise<Map<number, OhlcvSeven>> => {
      calls += 1;
      return calls === 1 ? new Map() : new Map(rows);
    };
  };

  function depsOf(over: Partial<GapRepairDeps> & { manifest: DiagManifest; raws: [string, Uint8Array][] }): {
    deps: GapRepairDeps;
    batches: { sql: string; params: readonly unknown[] }[][];
    recorded: { current: { key: string; metadata: Record<string, unknown>; files: { filename: string; bytes: Uint8Array }[] } | null };
    persisted: { current: { key: string; runId: string; sha256: string; bytes: Uint8Array } | null };
    verified: { calls: { pageId: string; filename: string; bytes: Uint8Array }[] };
  } {
    const batches: { sql: string; params: readonly unknown[] }[][] = [];
    const recorded: { current: { key: string; metadata: Record<string, unknown>; files: { filename: string; bytes: Uint8Array }[] } | null } = {
      current: null,
    };
    const persisted: { current: { key: string; runId: string; sha256: string; bytes: Uint8Array } | null } = {
      current: null,
    };
    const verified: { calls: { pageId: string; filename: string; bytes: Uint8Array }[] } = { calls: [] };
    const deps: GapRepairDeps = {
      loadCustody: async () => ({ manifest: over.manifest, rawByCode: new Map(over.raws) }),
      loadTargets: async () => [
        { id: 7, code: "1380" },
        { id: 8, code: "1787" },
      ],
      readRows: async () => new Map(),
      sendBatch: async (statements) => {
        batches.push(statements.map((s) => ({ sql: s.sql, params: s.params })));
      },
      record: (async (input: {
        key: string;
        metadata: Record<string, unknown>;
        files: { filename: string; bytes: Uint8Array }[];
      }) => {
        recorded.current = { key: input.key, metadata: input.metadata, files: input.files };
        return { pageId: "receipt-page", outcome: "recorded", fileTooLarge: false };
      }) as never,
      probeProofAbsent: async () => {},
      persistProof: async (proof) => {
        persisted.current = proof;
        return `/test-proof-${proof.runId}.json`;
      },
      verifyReceipt: async (pageId, filename, bytes) => {
        verified.calls.push({ pageId, filename, bytes });
      },
      ...over,
    };
    return { deps, batches, recorded, persisted, verified };
  }

  it("eligible 2 件の不存在は 1 batch で INSERT し receipt を残す", async () => {
    const manifest = manifestOf([codeEntry("1380"), codeEntry("1787")]);
    const { deps, batches, recorded } = depsOf({
      manifest,
      raws: [
        ["1380", okRaw("1380", 101)],
        ["1787", okRaw("1787", 202)],
      ],
      readRows: echoReadRows([
        [7, okRow(101)],
        [8, okRow(202)],
      ]),
    });
    const report = await runGapRepair("run-9", grant(["1380", "1787"]), deps, () => "2026-09-30T00:00:00.000Z");
    expect(report.applied).toBe(2);
    expect(report.aborted).toBe(false);
    expect(report.held).toEqual([]);
    expect(report.unknown).toEqual([]);
    expect(report.receiptKey).toBe("price-sync-repair-20260929-run-9");
    // preflight 2 文 + INSERT 1 文の batch を 1 回。bind は 100 以下。
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
    expect(batches[0][0].sql).toMatch(/銘柄同一性/);
    expect(batches[0][1].sql).toMatch(/が存在すれば/);
    expect(batches[0][2].sql).toMatch(/^INSERT INTO swing_daily_ohlcv/);
    for (const s of batches[0]) expect(s.params.length).toBeLessThanOrEqual(100);
    // INSERT 値は原文のまま (101/202)。
    expect(batches[0][2].params).toContain(101);
    expect(batches[0][2].params).toContain(202);
    // receipt は custody のみ (stdout 報告に値は載らない設計は型で担保)。
    expect(recorded.current?.key).toBe("price-sync-repair-20260929-run-9");
    expect(recorded.current?.metadata["applied"]).toBe(2);
    const receipt = JSON.parse(new TextDecoder().decode(recorded.current?.files[0]?.bytes ?? new Uint8Array())) as {
      writes: unknown[];
      readback: string;
      eligible: { fileSha256: string; source: string; sourceSha256: string; archivePins: string[]; codes: string[] };
    };
    expect(receipt.writes).toHaveLength(2);
    expect(receipt.readback).toBe("applied:2/unknown:0");
    // eligible の pin は receipt に残る (資格の証拠)。
    expect(receipt.eligible).toMatchObject({
      fileSha256: "f".repeat(64),
      source: "test-grant",
      sourceSha256: "a".repeat(64),
      archivePins: ["pin-1"],
    });
    expect(receipt.eligible.codes).toEqual(["1380", "1787"]);
  });

  it("receipt は POST 前 persist・ack 後 readback の順で物理完了を確認する", async () => {
    const manifest = manifestOf([codeEntry("1380")]);
    const order: string[] = [];
    const { deps, recorded } = depsOf({
      manifest,
      raws: [["1380", okRaw("1380", 101)]],
      readRows: echoReadRows([[7, okRow(101)]]),
      persistProof: async (proof) => {
        order.push("persist");
        expect(proof.key).toBe("price-sync-repair-20260929-run-9");
        expect(proof.runId).toBe("run-9");
        return "/test-proof-run-9.json";
      },
      record: (async (input: { key: string }) => {
        order.push("record");
        recorded.current = { key: input.key, metadata: {}, files: [] };
        return { pageId: "receipt-page", outcome: "recorded", fileTooLarge: false };
      }) as never,
      verifyReceipt: async (pageId, filename, bytes) => {
        order.push("verify");
        expect(pageId).toBe("receipt-page");
        expect(filename).toBe("price-sync-repair-20260929-run-9.json");
        expect(bytes.length).toBeGreaterThan(0);
      },
    });
    const report = await runGapRepair("run-9", grant(["1380"]), deps);
    expect(order).toEqual(["persist", "record", "verify"]);
    expect(report.receiptKey).toBe("price-sync-repair-20260929-run-9");
  });

  it("CAS 競合は全 STOP し後続 chunk を送らない (receipt には abort を残す)", async () => {
    const codes = Array.from({ length: 13 }, (_, i) => `9${String(100 + i)}`);
    const manifest = manifestOf(codes.map((c) => codeEntry(c)));
    const raws = codes.map((c) => [c, okRaw(c)] as [string, Uint8Array]);
    const { deps, batches, recorded } = depsOf({
      manifest,
      raws,
      loadTargets: async () => codes.map((code, i) => ({ id: 100 + i, code })),
      sendBatch: async () => {
        batches.push([]);
        throw new Error("D1 batch: 3 件目の文が失敗しました");
      },
    });
    const report = await runGapRepair("run-9", grant(codes), deps);
    expect(report.applied).toBe(0);
    expect(report.aborted).toBe(true);
    expect(report.abortReason).toMatch(/^chunk-0:/);
    expect(batches).toHaveLength(1);
    expect(recorded.current?.metadata["aborted"]).toBe(true);
    // 応答不明の chunk-0 (12 件) は readback に入るが、SELECT 時点の
    // 不存在は rollback 確定にしない (遅延 commit があり得るため HOLD)。
    // 13 件目は未送信のため対象外。
    expect(report.applied).toBe(0);
    expect(report.unknown).toHaveLength(12);
    expect(report.unknown[0]).toMatchObject({ reason: "observed-absent-at-readback" });
  });

  it("応答不明 chunk が commit 済みなら readback で適用確定する (再送なし)", async () => {
    const manifest = manifestOf([codeEntry("1380")]);
    const sendBatch = vi.fn(async () => {
      throw new Error("fetch failed (timeout)");
    });
    let calls = 0;
    const { deps } = depsOf({
      manifest,
      raws: [["1380", okRaw("1380", 101)]],
      sendBatch,
      readRows: async () => {
        calls += 1;
        // 1 回目 (事前照合): 不存在。2 回目 (readback): commit 済みの行あり。
        if (calls === 1) return new Map();
        return new Map([[7, okRow(101)]]);
      },
    });
    const report = await runGapRepair("run-9", grant(["1380"]), deps);
    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(report.applied).toBe(1);
    expect(report.unknown).toEqual([]);
    // 応答不明だった事実は残る (abort 扱い。適用数は readback 確定)。
    expect(report.aborted).toBe(true);
    expect(report.abortReason).toMatch(/^chunk-0:/);
  });

  it("応答不明 chunk の readback 差異は unknown として STOP する", async () => {
    const manifest = manifestOf([codeEntry("1380")]);
    let calls = 0;
    const { deps } = depsOf({
      manifest,
      raws: [["1380", okRaw("1380", 101)]],
      sendBatch: async () => {
        throw new Error("HTTP timeout");
      },
      readRows: async () => {
        calls += 1;
        if (calls === 1) return new Map();
        return new Map([
          [7, { date: "2026-09-29", open: 1, high: 2, low: 0.5, close: 999, volume: 0, adj: null }],
        ]);
      },
    });
    const report = await runGapRepair("run-9", grant(["1380"]), deps);
    expect(report.applied).toBe(0);
    expect(report.unknown).toEqual([{ code: "1380", reason: "attempted-row-drift" }]);
    expect(report.aborted).toBe(true);
  });

  it("readback 自体の失敗は全対象を unknown にする (0 と断定しない)", async () => {
    const manifest = manifestOf([codeEntry("1380"), codeEntry("1787")]);
    let calls = 0;
    const { deps } = depsOf({
      manifest,
      raws: [
        ["1380", okRaw("1380", 101)],
        ["1787", okRaw("1787", 202)],
      ],
      readRows: async () => {
        calls += 1;
        if (calls === 1) return new Map();
        throw new Error("D1 read timeout");
      },
    });
    const report = await runGapRepair("run-9", grant(["1380", "1787"]), deps);
    expect(report.applied).toBe(0);
    expect(report.unknown).toHaveLength(2);
    expect(report.unknown[0].reason).toMatch(/^readback-unobserved:/);
    expect(report.aborted).toBe(true);
    expect(report.abortReason).toMatch(/^readback-unobserved:/);
  });

  it("再実行は全行 write0 で batch を送らない", async () => {
    const manifest = manifestOf([codeEntry("1380")]);
    const row: OhlcvSeven = { date: "2026-09-29", open: 100, high: 102, low: 99, close: 101, volume: 2000, adj: 101 };
    const { deps, batches } = depsOf({
      manifest,
      raws: [["1380", okRaw("1380", 101)]],
      readRows: async () => new Map([[7, row]]),
    });
    const report = await runGapRepair("run-9", grant(["1380"]), deps);
    expect(report.applied).toBe(0);
    expect(report.write0).toEqual(["1380"]);
    expect(report.aborted).toBe(false);
    expect(batches).toHaveLength(0);
  });

  it("既存差異・非 eligible・非 has_real_bar は HOLD/除外し保存しない", async () => {
    const manifest = manifestOf([
      codeEntry("1380"),
      codeEntry("1787"),
      { ...codeEntry("3480"), category: "source_gap" },
    ]);
    const diff: OhlcvSeven = { date: "2026-09-29", open: 1, high: 2, low: 0.5, close: 999, volume: 0, adj: null };
    const { deps, batches } = depsOf({
      manifest,
      raws: [
        ["1380", okRaw("1380", 101)],
        ["1787", okRaw("1787", 202)],
      ],
      readRows: async () => new Map([[7, diff]]),
    });
    // 1787 は eligible 外。3480 は非 has_real_bar。
    const report = await runGapRepair("run-9", grant(["1380"]), deps);
    expect(report.applied).toBe(0);
    expect(report.held).toContainEqual({ code: "1380", reason: "existing-row-differs" });
    expect(report.held).toContainEqual({ code: "1787", reason: "not-in-eligible-set" });
    expect(report.excluded).toContainEqual({ code: "3480", reason: "diag-category:source_gap" });
    expect(batches).toHaveLength(0);
  });

  it("非 eligible の has_real_bar は not-in-eligible-set で HOLD する", async () => {
    const manifest = manifestOf([codeEntry("1380"), codeEntry("1787")]);
    const { deps } = depsOf({
      manifest,
      raws: [
        ["1380", okRaw("1380", 101)],
        ["1787", okRaw("1787", 202)],
      ],
      readRows: echoReadRows([[7, okRow(101)]]),
    });
    const report = await runGapRepair("run-9", grant(["1380"]), deps);
    expect(report.applied).toBe(1);
    expect(report.held).toEqual([{ code: "1787", reason: "not-in-eligible-set" }]);
  });

  it("eligible 空・未知・非 has_real_bar・manifest 非 complete は即 STOP する", async () => {
    const manifest = manifestOf([codeEntry("1380")]);
    const { deps } = depsOf({ manifest, raws: [["1380", okRaw("1380", 101)]] });
    await expect(runGapRepair("run-9", grant([]), deps)).rejects.toThrow(/eligible 集合が空/);
    await expect(runGapRepair("run-9", grant(["9999"]), deps)).rejects.toThrow(/manifest にありません/);
    const mixed = manifestOf([codeEntry("1380"), { ...codeEntry("3480"), category: "source_gap" }]);
    const d2 = depsOf({ manifest: mixed, raws: [["1380", okRaw("1380", 101)]] });
    await expect(runGapRepair("run-9", grant(["1380", "3480"]), d2.deps)).rejects.toThrow(/保存不可/);
    const partial = { ...manifest, completeness: "partial" };
    const d3 = depsOf({ manifest: partial, raws: [["1380", okRaw("1380", 101)]] });
    await expect(runGapRepair("run-9", grant(["1380"]), d3.deps)).rejects.toThrow(/complete 前提/);
  });

  it("readback 不一致は abort する", async () => {
    const manifest = manifestOf([codeEntry("1380")]);
    let calls = 0;
    const { deps } = depsOf({
      manifest,
      raws: [["1380", okRaw("1380", 101)]],
      readRows: async () => {
        calls += 1;
        // 1 回目 (事前照合): 不存在。2 回目 (readback): 別値。
        if (calls === 1) return new Map();
        return new Map([
          [7, { date: "2026-09-29", open: 1, high: 2, low: 0.5, close: 999, volume: 0, adj: null }],
        ]);
      },
    });
    const report = await runGapRepair("run-9", grant(["1380"]), deps);
    // 応答成功でも readback 不一致は適用に数えない (unknown 扱い)。
    expect(report.applied).toBe(0);
    expect(report.unknown).toEqual([{ code: "1380", reason: "confirmed-row-drift" }]);
    expect(report.aborted).toBe(true);
    expect(report.abortReason).toMatch(/^readback-unknown:/);
  });

  it("応答成功 chunk の readback 不存在も rollback 確定にしない", async () => {
    const manifest = manifestOf([codeEntry("1380")]);
    let calls = 0;
    const { deps } = depsOf({
      manifest,
      raws: [["1380", okRaw("1380", 101)]],
      readRows: async () => {
        calls += 1;
        return new Map();
      },
    });
    const report = await runGapRepair("run-9", grant(["1380"]), deps);
    expect(calls).toBe(2);
    expect(report.applied).toBe(0);
    expect(report.unknown).toEqual([{ code: "1380", reason: "observed-absent-at-readback" }]);
    expect(report.aborted).toBe(true);
  });

  it("receipt 失敗は throw する (再送なし・単発呼出)", async () => {
    const manifest = manifestOf([codeEntry("1380")]);
    const record = vi.fn(async () => {
      throw new Error("Notion 書込失敗");
    });
    const verifyReceipt = vi.fn(async () => {});
    const { deps, verified } = depsOf({
      manifest,
      raws: [["1380", okRaw("1380", 101)]],
      record: record as never,
      verifyReceipt,
    });
    await expect(runGapRepair("run-9", grant(["1380"]), deps)).rejects.toThrow(/receipt の記録に失敗/);
    expect(record).toHaveBeenCalledTimes(1);
    expect(verified.calls).toHaveLength(0);
    expect(verifyReceipt).not.toHaveBeenCalled();
  });

  it("receipt record の Unknown は再送せず readonly 回収を誘導する", async () => {
    const manifest = manifestOf([codeEntry("1380")]);
    const record = vi.fn(async () => {
      throw new NotionUnknownResultError("POST 応答不明");
    });
    const verifyReceipt = vi.fn(async () => {});
    const { deps } = depsOf({
      manifest,
      raws: [["1380", okRaw("1380", 101)]],
      readRows: echoReadRows([[7, okRow(101)]]),
      record: record as never,
      verifyReceipt,
    });
    const err = await runGapRepair("run-9", grant(["1380"]), deps).catch((e: unknown) => e);
    expect(String(err)).toMatch(/resume-receipt --run-id=run-9 で既存key\+0600証拠のreadonly回収のみ/);
    // 別 runId での書直し誘導は無い (原 Unknown 解消と後日実行を混同しない)。
    expect(String(err)).not.toMatch(/新規runId/);
    expect(String(err)).toMatch(/不在\/読取失敗はHOLD/);
    expect(record).toHaveBeenCalledTimes(1);
    expect(verifyReceipt).not.toHaveBeenCalled();
  });

  it("receipt readback 失敗は throw する (ack だけでは完了にしない)", async () => {
    const manifest = manifestOf([codeEntry("1380")]);
    const record = vi.fn(async () => ({ pageId: "receipt-page", outcome: "recorded", fileTooLarge: false }));
    const { deps } = depsOf({
      manifest,
      raws: [["1380", okRaw("1380", 101)]],
      readRows: echoReadRows([[7, okRow(101)]]),
      record: record as never,
      verifyReceipt: async () => {
        throw new Error("修復 receipt の readback 照合に失敗したため HOLD: 添付 0 件 ≠ 期待 1 件");
      },
    });
    await expect(runGapRepair("run-9", grant(["1380"]), deps)).rejects.toThrow(/readback 照合に失敗/);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("同 runId proof の存在は D1 送信前に HOLD する (二重送信なし)", async () => {
    const manifest = manifestOf([codeEntry("1380")]);
    const sendBatch = vi.fn(async () => {});
    const record = vi.fn(async () => ({}));
    const { deps } = depsOf({
      manifest,
      raws: [["1380", okRaw("1380", 101)]],
      sendBatch,
      record: record as never,
      probeProofAbsent: async () => {
        throw new Error("修復の開始を HOLD: 同 runId の receipt 証拠が既にあります");
      },
    });
    await expect(runGapRepair("run-9", grant(["1380"]), deps)).rejects.toThrow(/D1 送信前に停止|既にあります/);
    expect(sendBatch).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});

describe("receipt 0600 証拠", () => {
  it("receiptProofPath は traversal を拒否する", () => {
    expect(receiptProofPath("/tmp/x", "run-9")).toBe("/tmp/x/receipt-run-9.json");
    expect(() => receiptProofPath("/tmp/x", "../evil")).toThrow(/証拠パスに使えません/);
    expect(() => receiptProofPath("/tmp/x", "a/b")).toThrow(/証拠パスに使えません/);
    expect(() => receiptProofPath("/tmp/x", "")).toThrow(/証拠パスに使えません/);
  });

  it("persist→load が往復し、0600 で保存される", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repair-proof-"));
    const bytes = new TextEncoder().encode('{"k":1}');
    const sha = await sha256HexBytes(bytes);
    const path = await persistReceiptProofFile(dir, { key: "k", runId: "run-9", sha256: sha, bytes });
    expect(path).toBe(join(dir, "receipt-run-9.json"));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const loaded = await loadReceiptProofFile(dir, "run-9");
    expect(loaded?.key).toBe("k");
    expect(loaded?.runId).toBe("run-9");
    expect(loaded?.sha256).toBe(sha);
    expect(loaded?.bytes).toEqual(bytes);
  });

  it("不在は null、改ざん・形式不正は throw する", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repair-proof-"));
    expect(await loadReceiptProofFile(dir, "nope")).toBeNull();
    const bytes = new TextEncoder().encode('{"k":1}');
    const sha = await sha256HexBytes(bytes);
    const path = await persistReceiptProofFile(dir, { key: "k", runId: "run-9", sha256: sha, bytes });
    const tampered = JSON.stringify({
      key: "k",
      runId: "run-9",
      sha256: sha,
      bytesBase64: Buffer.from("tampered").toString("base64"),
    });
    await writeFile(path, tampered);
    await expect(loadReceiptProofFile(dir, "run-9")).rejects.toThrow(/SHA 不一致/);
    await writeFile(path, JSON.stringify({ key: "k", runId: "other", sha256: sha, bytesBase64: "e30=" }));
    await expect(loadReceiptProofFile(dir, "run-9")).rejects.toThrow(/形式不正/);
  });

  it("同一内容の再 persist は原器を再利用する (上書きしない)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repair-proof-"));
    const bytes = new TextEncoder().encode('{"k":1}');
    const sha = await sha256HexBytes(bytes);
    const proof = { key: "k", runId: "run-9", sha256: sha, bytes };
    const first = await persistReceiptProofFile(dir, proof);
    const before = await stat(first);
    const second = await persistReceiptProofFile(dir, { ...proof, bytes: new TextEncoder().encode('{"k":1}') });
    expect(second).toBe(first);
    // 原器の実体は不変 (mtime 変化なし)。
    expect((await stat(first)).mtimeMs).toBe(before.mtimeMs);
  });

  it("既存と内容不一致なら HOLD し、原器は不変のまま残す", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repair-proof-"));
    const bytes = new TextEncoder().encode('{"applied":1}');
    const sha = await sha256HexBytes(bytes);
    const path = await persistReceiptProofFile(dir, { key: "k", runId: "run-9", sha256: sha, bytes });
    const changed = new TextEncoder().encode('{"applied":0,"write0":["1380"]}');
    const err = await persistReceiptProofFile(
      dir,
      { key: "k", runId: "run-9", sha256: await sha256HexBytes(changed), bytes: changed }
    ).catch((e: unknown) => e);
    expect(String(err)).toMatch(/内容不一致/);
    expect(String(err)).toMatch(/resume-receipt --run-id=run-9/);
    // 原器は truncate されず Unknown 元の bytes を保持する。
    expect(await loadReceiptProofFile(dir, "run-9")).not.toBeNull();
    expect((await loadReceiptProofFile(dir, "run-9"))?.bytes).toEqual(bytes);
    expect(path).toBe(join(dir, "receipt-run-9.json"));
  });

  it("既存 proof の mode 非 0600・parse 不可は HOLD し、自動 chmod しない", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repair-proof-"));
    const bytes = new TextEncoder().encode('{"k":1}');
    const sha = await sha256HexBytes(bytes);
    const path = await persistReceiptProofFile(dir, { key: "k", runId: "run-9", sha256: sha, bytes });
    await chmod(path, 0o644);
    const err = await persistReceiptProofFile(dir, { key: "k", runId: "run-9", sha256: sha, bytes }).catch(
      (e: unknown) => e
    );
    expect(String(err)).toMatch(/0600 ではありません/);
    expect(String(err)).toMatch(/自動 chmod はしません/);
    expect((await stat(path)).mode & 0o777).toBe(0o644);
    await chmod(path, 0o600);
    await writeFile(path, "{broken");
    await expect(persistReceiptProofFile(dir, { key: "k", runId: "run-9", sha256: sha, bytes })).rejects.toThrow(
      /parse に失敗/
    );
  });

  it("probe は既存で HOLD、不存在で通す", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repair-proof-"));
    await expect(probeReceiptProofAbsent(dir, "run-9")).resolves.toBeUndefined();
    const bytes = new TextEncoder().encode('{"k":1}');
    await persistReceiptProofFile(dir, { key: "k", runId: "run-9", sha256: await sha256HexBytes(bytes), bytes });
    const err = await probeReceiptProofAbsent(dir, "run-9").catch((e: unknown) => e);
    expect(String(err)).toMatch(/D1 送信前に停止/);
    expect(String(err)).toMatch(/resume-receipt --run-id=run-9/);
  });
});

describe("verifyReceiptAttachment", () => {
  const filename = "price-sync-repair-20260929-run-9.json";
  const text = '{"key":"price-sync-repair-20260929-run-9"}';
  const expected = new TextEncoder().encode(text);
  const hostedFile = (over: Record<string, unknown> = {}) => ({
    name: filename,
    url: "https://signed.test/receipt.json",
    kind: "file",
    ...over,
  });

  it("hosted 1 件・全 bytes 一致で通す", async () => {
    vi.mocked(listPageFiles).mockResolvedValue([hostedFile()] as never);
    const fetchMock = vi.fn(async () => new Response(text, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await verifyReceiptAttachment("page-9", filename, expected);
    expect(fetchMock).toHaveBeenCalledWith("https://signed.test/receipt.json");
  });

  it("件数・名前・hosted 種別の不一致は HOLD する", async () => {
    vi.mocked(listPageFiles).mockResolvedValue([] as never);
    vi.stubGlobal("fetch", vi.fn());
    await expect(verifyReceiptAttachment("page-9", filename, expected)).rejects.toThrow(/添付 0 件/);
    vi.mocked(listPageFiles).mockResolvedValue([hostedFile(), hostedFile({ name: "other.json" })] as never);
    await expect(verifyReceiptAttachment("page-9", filename, expected)).rejects.toThrow(/添付 2 件/);
    vi.mocked(listPageFiles).mockResolvedValue([hostedFile({ name: "renamed.json" })] as never);
    await expect(verifyReceiptAttachment("page-9", filename, expected)).rejects.toThrow(/添付名不一致/);
    vi.mocked(listPageFiles).mockResolvedValue([hostedFile({ kind: "external" })] as never);
    await expect(verifyReceiptAttachment("page-9", filename, expected)).rejects.toThrow(/hosted/);
  });

  it("再取得失敗・長さ・SHA の不一致は HOLD する", async () => {
    vi.mocked(listPageFiles).mockResolvedValue([hostedFile()] as never);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ng", { status: 500 })));
    await expect(verifyReceiptAttachment("page-9", filename, expected)).rejects.toThrow(/再取得に失敗/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("short", { status: 200 })));
    await expect(verifyReceiptAttachment("page-9", filename, expected)).rejects.toThrow(/バイト長/);
    const sameLen = `${text.slice(0, -2)}XX`;
    expect(new TextEncoder().encode(sameLen).length).toBe(expected.length);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sameLen, { status: 200 })));
    await expect(verifyReceiptAttachment("page-9", filename, expected)).rejects.toThrow(/SHA256 不一致/);
  });
});

describe("resumeReceiptProof", () => {
  const runId = "run-9";
  const key = `price-sync-repair-20260929-${runId}`;
  const filename = `${key}.json`;
  const text = JSON.stringify({ key, runId });
  const bytes = new TextEncoder().encode(text);

  async function proofDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "repair-resume-"));
    await persistReceiptProofFile(dir, { key, runId, sha256: await sha256HexBytes(bytes), bytes });
    return dir;
  }

  it("既存 key + 0600 証拠の一致で adopted する (書込なし)", async () => {
    process.env.NOTION_ARCHIVE_PAGE_ID = "b".repeat(32);
    const dir = await proofDir();
    vi.mocked(findBackupChildByTitle).mockResolvedValue("db-1");
    vi.mocked(queryUniqueRow).mockResolvedValue({ id: "page-9" } as never);
    vi.mocked(listPageFiles).mockResolvedValue([
      { name: filename, url: "https://signed.test/receipt.json", kind: "file" },
    ] as never);
    const fetchMock = vi.fn(async () => new Response(text, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await resumeReceiptProof(runId, { dir });
    expect(r).toMatchObject({ status: "adopted", key, runId, pageId: "page-9" });
    expect(vi.mocked(queryUniqueRow)).toHaveBeenCalledWith(
      "db-1",
      { property: "Key", title: { equals: key } },
      expect.stringContaining("保全停止")
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("key 不在は absent (HOLD) で再 POST しない", async () => {
    process.env.NOTION_ARCHIVE_PAGE_ID = "b".repeat(32);
    const dir = await proofDir();
    vi.mocked(findBackupChildByTitle).mockResolvedValue("db-1");
    vi.mocked(queryUniqueRow).mockResolvedValue(null as never);
    const fetchMock = vi.fn(async () => new Response(text, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await resumeReceiptProof(runId, { dir });
    expect(r.status).toBe("absent");
    expect(r.detail).toMatch(/HOLD/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("0600 証拠なし・DB なし・readback 不一致は HOLD/STOP する", async () => {
    process.env.NOTION_ARCHIVE_PAGE_ID = "b".repeat(32);
    const empty = await mkdtemp(join(tmpdir(), "repair-resume-"));
    const noProof = await resumeReceiptProof(runId, { dir: empty }).catch((e: unknown) => e);
    expect(String(noProof)).toMatch(/0600 証拠なし/);
    expect(String(noProof)).not.toMatch(/新規 runId/);
    const dir = await proofDir();
    vi.mocked(findBackupChildByTitle).mockResolvedValue(null);
    await expect(resumeReceiptProof(runId, { dir })).rejects.toThrow(/DB なし/);
    vi.mocked(findBackupChildByTitle).mockResolvedValue("db-1");
    vi.mocked(queryUniqueRow).mockResolvedValue({ id: "page-9" } as never);
    vi.mocked(listPageFiles).mockResolvedValue([] as never);
    await expect(resumeReceiptProof(runId, { dir })).rejects.toThrow(/readback 照合に失敗/);
  });
});
