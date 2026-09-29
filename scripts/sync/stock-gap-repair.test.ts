import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchChart } from "../../src/shared/yahoo/client.js";
import {
  REPAIR_DIAG_KEY,
  ohlcvSevenEqual,
  parseDiagManifest,
  replayRawBar,
  runGapRepair,
  type DiagManifest,
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

function chartJson(bars: Bar[], metaPrice: number | null) {
  const col = (pick: (b: Bar) => number | null) => bars.map(pick);
  return {
    chart: {
      result: [
        {
          meta: { symbol: "0000.T", regularMarketPrice: metaPrice, previousClose: null },
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

describe("replayRawBar", () => {
  it("9/29 正値バーは原文のまま採用する (adj 別値・v0 維持)", () => {
    const out = replayRawBar("1380", bytesOf(chartJson([bar(D28, 100), bar(D29, 101, 0, 99)], 101)));
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.row).toEqual({ date: "2026-09-29", open: 100, high: 102, low: 99, close: 101, volume: 0, adj: 99 });
  });

  it("9/29 欠落・重複・raw close 不正は HOLD する", () => {
    expect(replayRawBar("1380", bytesOf(chartJson([bar(D28, 100)], 100))).kind).toBe("held");
    const dup = replayRawBar("1380", bytesOf(chartJson([bar(D29, 101), bar(D29, 102)], 101)));
    expect(dup).toEqual({ kind: "held", reason: expect.stringMatching(/duplicate/) });
    const nul = replayRawBar("1380", bytesOf(chartJson([bar(D28, 100), bar(D29, null, 0, null)], 100)));
    expect(nul).toEqual({ kind: "held", reason: "raw-close-not-positive-finite" });
    const zero = replayRawBar("1380", bytesOf(chartJson([bar(D28, 100), bar(D29, 0)], 100)));
    expect(zero).toEqual({ kind: "held", reason: "raw-close-not-positive-finite" });
  });

  it("sanitize 棄却・応答乖離は HOLD する (保存しない)", () => {
    const rej = replayRawBar("1909", bytesOf(chartJson([bar(D28, 100), bar(D29, 5000, 0)], 100)));
    expect(rej).toEqual({ kind: "held", reason: "guarded-9/29-missing" });
    const inc = replayRawBar("7082", bytesOf(chartJson([bar(D29, 100, 0)], 5000)));
    expect(inc.kind).toBe("held");
    if (inc.kind === "held") expect(inc.reason).toMatch(/^guard-rejected:/);
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
    const json = chartJson([bar(D28, 100), bar(D29, 101, 2000)], 101);
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
  const okRaw = (close = 101) => bytesOf(chartJson([bar(D28, 100), bar(D29, close, 2000)], close));
  const okRow = (close: number): OhlcvSeven => ({
    date: "2026-09-29",
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 2000,
    adj: close,
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
  } {
    const batches: { sql: string; params: readonly unknown[] }[][] = [];
    const recorded: { current: { key: string; metadata: Record<string, unknown>; files: { filename: string; bytes: Uint8Array }[] } | null } = {
      current: null,
    };
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
      ...over,
    };
    return { deps, batches, recorded };
  }

  it("eligible 2 件の不存在は 1 batch で INSERT し receipt を残す", async () => {
    const manifest = manifestOf([codeEntry("1380"), codeEntry("1787")]);
    const { deps, batches, recorded } = depsOf({
      manifest,
      raws: [
        ["1380", okRaw(101)],
        ["1787", okRaw(202)],
      ],
      readRows: echoReadRows([
        [7, okRow(101)],
        [8, okRow(202)],
      ]),
    });
    const report = await runGapRepair("run-9", new Set(["1380", "1787"]), deps, () => "2026-09-30T00:00:00.000Z");
    expect(report.applied).toBe(2);
    expect(report.aborted).toBe(false);
    expect(report.held).toEqual([]);
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
    };
    expect(receipt.writes).toHaveLength(2);
    expect(receipt.readback).toBe("matched:2");
  });

  it("CAS 競合は全 STOP し後続 chunk を送らない (receipt には abort を残す)", async () => {
    const codes = Array.from({ length: 13 }, (_, i) => `9${String(100 + i)}`);
    const manifest = manifestOf(codes.map((c) => codeEntry(c)));
    const raws = codes.map((c) => [c, okRaw()] as [string, Uint8Array]);
    const { deps, batches, recorded } = depsOf({
      manifest,
      raws,
      loadTargets: async () => codes.map((code, i) => ({ id: 100 + i, code })),
      sendBatch: async () => {
        batches.push([]);
        throw new Error("D1 batch: 3 件目の文が失敗しました");
      },
    });
    const report = await runGapRepair("run-9", new Set(codes), deps);
    expect(report.applied).toBe(0);
    expect(report.aborted).toBe(true);
    expect(report.abortReason).toMatch(/^chunk-0:/);
    expect(batches).toHaveLength(1);
    expect(recorded.current?.metadata["aborted"]).toBe(true);
  });

  it("再実行は全行 write0 で batch を送らない", async () => {
    const manifest = manifestOf([codeEntry("1380")]);
    const row: OhlcvSeven = { date: "2026-09-29", open: 100, high: 102, low: 99, close: 101, volume: 2000, adj: 101 };
    const { deps, batches } = depsOf({
      manifest,
      raws: [["1380", okRaw(101)]],
      readRows: async () => new Map([[7, row]]),
    });
    const report = await runGapRepair("run-9", new Set(["1380"]), deps);
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
        ["1380", okRaw(101)],
        ["1787", okRaw(202)],
      ],
      readRows: async () => new Map([[7, diff]]),
    });
    // 1787 は eligible 外。3480 は非 has_real_bar。
    const report = await runGapRepair("run-9", new Set(["1380"]), deps);
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
        ["1380", okRaw(101)],
        ["1787", okRaw(202)],
      ],
      readRows: echoReadRows([[7, okRow(101)]]),
    });
    const report = await runGapRepair("run-9", new Set(["1380"]), deps);
    expect(report.applied).toBe(1);
    expect(report.held).toEqual([{ code: "1787", reason: "not-in-eligible-set" }]);
  });

  it("eligible 空・未知・非 has_real_bar・manifest 非 complete は即 STOP する", async () => {
    const manifest = manifestOf([codeEntry("1380")]);
    const { deps } = depsOf({ manifest, raws: [["1380", okRaw(101)]] });
    await expect(runGapRepair("run-9", new Set(), deps)).rejects.toThrow(/eligible 集合が空/);
    await expect(runGapRepair("run-9", new Set(["9999"]), deps)).rejects.toThrow(/manifest にありません/);
    const mixed = manifestOf([codeEntry("1380"), { ...codeEntry("3480"), category: "source_gap" }]);
    const d2 = depsOf({ manifest: mixed, raws: [["1380", okRaw(101)]] });
    await expect(runGapRepair("run-9", new Set(["1380", "3480"]), d2.deps)).rejects.toThrow(/保存不可/);
    const partial = { ...manifest, completeness: "partial" };
    const d3 = depsOf({ manifest: partial, raws: [["1380", okRaw(101)]] });
    await expect(runGapRepair("run-9", new Set(["1380"]), d3.deps)).rejects.toThrow(/complete 前提/);
  });

  it("readback 不一致は abort する", async () => {
    const manifest = manifestOf([codeEntry("1380")]);
    let calls = 0;
    const { deps } = depsOf({
      manifest,
      raws: [["1380", okRaw(101)]],
      readRows: async () => {
        calls += 1;
        // 1 回目 (事前照合): 不存在。2 回目 (readback): 別値。
        if (calls === 1) return new Map();
        return new Map([
          [7, { date: "2026-09-29", open: 1, high: 2, low: 0.5, close: 999, volume: 0, adj: null }],
        ]);
      },
    });
    const report = await runGapRepair("run-9", new Set(["1380"]), deps);
    expect(report.applied).toBe(1);
    expect(report.aborted).toBe(true);
    expect(report.abortReason).toMatch(/^readback:mismatch/);
  });

  it("receipt 失敗は throw する (再送なし・単発呼出)", async () => {
    const manifest = manifestOf([codeEntry("1380")]);
    const record = vi.fn(async () => {
      throw new Error("Notion 書込失敗");
    });
    const { deps } = depsOf({ manifest, raws: [["1380", okRaw(101)]], record: record as never });
    await expect(runGapRepair("run-9", new Set(["1380"]), deps)).rejects.toThrow(/receipt の記録に失敗/);
    expect(record).toHaveBeenCalledTimes(1);
  });
});
