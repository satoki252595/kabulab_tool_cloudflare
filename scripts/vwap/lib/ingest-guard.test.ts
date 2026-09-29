import { describe, expect, it } from "vitest";
import {
  buildIngestSummary,
  findInvalidBars,
  resolveExitCode,
  resolveRunId,
  shouldSkipPut,
} from "./ingest-guard.js";

describe("findInvalidBars", () => {
  const good = { o: 100, h: 110, l: 90, c: 105, v: 1000 };

  it("正常バーは空", () => {
    expect(findInvalidBars([good, { ...good, v: 0 }])).toEqual([]);
  });

  it("非有限・非正・出来高負・高安逆転を理由つきで数える", () => {
    const bad = findInvalidBars([
      { ...good, c: Number.NaN },
      { ...good, o: -1 },
      { ...good, v: -5 },
      { ...good, h: 80, l: 90 },
    ]);
    expect(bad.map((b) => b.index)).toEqual([0, 1, 2, 3]);
    expect(bad[0].reasons).toContain("c:non-finite");
    expect(bad[1].reasons).toContain("o:non-positive");
    expect(bad[2].reasons).toContain("v:negative");
    expect(bad[3].reasons).toContain("range:inverted");
  });

  it("出来高0は薄商いの正当値で落とさない", () => {
    expect(findInvalidBars([{ ...good, v: 0 }])).toEqual([]);
  });

  it("終値のレンジ外は正当 (7112 丸め・checkBarSelf parity)", () => {
    expect(
      findInvalidBars([{ o: 699, h: 700, l: 698, c: 697, v: 100 }])
    ).toEqual([]);
  });

  it("使用する adj の実値を検査し、欠落と代用を混ぜない", () => {
    expect(findInvalidBars([{ ...good, adj: 104 }])).toEqual([]);
    expect(findInvalidBars([{ ...good }])).toEqual([]);
    const bad = findInvalidBars([
      { ...good, adj: Number.NaN },
      { ...good, adj: -1 },
      { ...good, adj: null },
    ]);
    expect(bad.map((b) => b.reasons)).toEqual([
      ["adj:non-finite"],
      ["adj:non-positive"],
      ["adj:missing"],
    ]);
  });
});

describe("shouldSkipPut", () => {
  const bars = [
    { date: "2026-09-25", o: 100, h: 110, l: 90, c: 105, v: 1000, adj: 104 },
  ];
  const splits: unknown[] = [];
  const fresh = (): Record<string, unknown> => ({
    code: "7203",
    updated: "2026-09-29T02:00:00.000Z",
    bars,
    splits,
  });
  const stored = (over: object = {}) =>
    JSON.stringify({
      code: "7203",
      updated: "2026-09-28T00:00:00.000Z",
      bars,
      splits,
      ...over,
    });

  it("updated 差だけなら skip (内容同一)", () => {
    expect(shouldSkipPut(stored(), fresh())).toBe(true);
  });

  it("JSON key 順だけの差は skip (不必要 PUT しない)", () => {
    const reordered = JSON.stringify({
      splits,
      bars,
      updated: "2026-09-28T00:00:00.000Z",
      code: "7203",
    });
    expect(shouldSkipPut(reordered, fresh())).toBe(true);
  });

  it("同 bars でも schema field 差 (余分/欠落) なら PUT する", () => {
    expect(shouldSkipPut(stored({ extra: 1 }), fresh())).toBe(false);
    const missing = { code: "7203", updated: "2026-09-28T00:00:00.000Z", bars };
    expect(shouldSkipPut(JSON.stringify(missing), fresh())).toBe(false);
  });

  it("不正 splits は [] 扱いせず PUT する (default 補完禁止)", () => {
    expect(shouldSkipPut(stored({ splits: "xx" }), fresh())).toBe(false);
    expect(shouldSkipPut(stored({ splits: null }), fresh())).toBe(false);
  });

  it("bars/splits/code の実変化・剪定は PUT する", () => {
    expect(
      shouldSkipPut(stored(), {
        ...fresh(),
        bars: [{ ...bars[0], c: 106 }],
      })
    ).toBe(false);
    expect(
      shouldSkipPut(
        stored({ bars: [...bars, { ...bars[0], date: "2026-09-24" }] }),
        fresh()
      )
    ).toBe(false);
  });

  it("既存なし・parse不能・object以外は PUT する", () => {
    expect(shouldSkipPut(null, fresh())).toBe(false);
    expect(shouldSkipPut("not-json", fresh())).toBe(false);
    expect(shouldSkipPut(JSON.stringify([1, 2]), fresh())).toBe(false);
  });
});

describe("resolveExitCode", () => {
  const zero = { aborted: false, errors: 0, invalid: 0, rateLimited: 0 };

  it("全0のみ exit 0 (negative)", () => {
    expect(resolveExitCode(zero)).toBe(0);
  });

  it("errors/invalid/rateLimited のいずれかで exit 1 (positive)", () => {
    expect(resolveExitCode({ ...zero, errors: 1 })).toBe(1);
    expect(resolveExitCode({ ...zero, invalid: 1 })).toBe(1);
    // 単発 rate-limit (MAX_RL 未達) も成功扱いしない。
    expect(resolveExitCode({ ...zero, rateLimited: 1 })).toBe(1);
  });

  it("aborted は 2 のまま", () => {
    expect(
      resolveExitCode({ ...zero, aborted: true, rateLimited: 5 })
    ).toBe(2);
  });
});

describe("resolveRunId", () => {
  it("Actions では run_id(.attempt)", () => {
    expect(
      resolveRunId({ GITHUB_RUN_ID: "36504277304", GITHUB_RUN_ATTEMPT: "2" })
    ).toBe("36504277304.2");
    expect(resolveRunId({ GITHUB_RUN_ID: "36504277304" })).toBe("36504277304");
  });

  it("手元では local-8hex (同日再 run で衝突しない)", () => {
    const a = resolveRunId({});
    const b = resolveRunId({});
    expect(a).toMatch(/^local-[0-9a-f]{8}$/);
    expect(b).toMatch(/^local-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });

  it("非数値の GITHUB_RUN_ID は無視して local へ", () => {
    expect(resolveRunId({ GITHUB_RUN_ID: "abc" })).toMatch(/^local-/);
  });
});

describe("buildIngestSummary", () => {
  const stats = {
    kind: "intra" as const,
    range: "5d",
    runId: "36504277304.1",
    codes: 10,
    written: 9,
    empty: 0,
    errors: 0,
    invalid: 1,
    rateLimited: 0,
    keepDays: 365,
    aborted: false,
    startedAt: "2026-09-28T08:00:00.000Z",
    finishedAt: "2026-09-28T08:30:00.000Z",
  };

  it("run粒度のkey/添付1件・per-stock鏡像なし", () => {
    const s = buildIngestSummary(stats);
    expect(s.service).toBe("vwap-analysis");
    expect(s.key).toBe("vwap-ingest-intra-20260928-36504277304.1");
    expect(s.files).toHaveLength(1);
    expect(s.files[0].filename).toBe("vwap-ingest-intra-20260928-36504277304.1.json");
    const body = JSON.parse(new TextDecoder().decode(s.files[0].bytes));
    expect(body.invalid).toBe(1);
    expect(body.written).toBe(9);
    expect(s.metadata.invalid).toBe(1);
  });

  it("日付キーが取れないfinishedAtは投げる", () => {
    expect(() =>
      buildIngestSummary({ ...stats, finishedAt: "not-a-date" })
    ).toThrow(/日付キー不能/);
  });

  it("runId 形状不正は投げる", () => {
    expect(() =>
      buildIngestSummary({ ...stats, runId: "../evil" })
    ).toThrow(/runId 形状不正/);
  });
});
