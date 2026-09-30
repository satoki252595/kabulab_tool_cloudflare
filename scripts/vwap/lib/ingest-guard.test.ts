import { describe, expect, it } from "vitest";
import {
  archiveSummaryOrFatal,
  assertSavedDailyShape,
  assertSavedIntraShape,
  bodyPin,
  buildIngestSummary,
  findInvalidBars,
  resolveExitCode,
  resolveRunId,
  sanitizeLogText,
  shouldSkipPut,
  sourceObservedAggregate,
  universePin,
} from "./ingest-guard.js";
import excerpt from "./__fixtures__/universe-excerpt.json";

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
  const zero = { aborted: false, fatalUnknown: false, errors: 0, invalid: 0, rateLimited: 0 };

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

  it("fatalUnknown (R2 fault) は 2 (後続 intra を止める)", () => {
    expect(resolveExitCode({ ...zero, fatalUnknown: true })).toBe(2);
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
    unknown: [] as string[],
    rejected: [] as string[],
    universe: { size: 10, sha256: "u".repeat(64) },
    outcomes: {
      "7203": { status: "written" as const, latestSourceBar: 1757548800, bodySha: "b".repeat(64) },
    },
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
    expect(body.outcomes["7203"].status).toBe("written");
    expect(s.metadata.invalid).toBe(1);
    // metadata は counts + pin + 集約のみ。outcomes/一覧は物理 JSON 本文。
    expect(s.metadata.unknownCount).toBe(0);
    expect("outcomes" in (s.metadata as Record<string, unknown>)).toBe(false);
    expect("unknown" in (s.metadata as Record<string, unknown>)).toBe(false);
    expect(s.metadata.universe).toEqual({ size: 10, sha256: "u".repeat(64) });
    expect(s.metadata.sourceObserved).toEqual({ count: 1, maxDate: null, maxTs: 1757548800 });
  });

  it("実 code 抜粋で metadata は Notion 上限内に収まる (excerpt size bound)", () => {
    // codes は実抜粋 (fixture provenance 参照)。metadata は counts+pin+集約
    // のみで code 件数に依存しない (O(1)) ため、抜粋で上限適合を証明し、
    // 3695 実件は private offline proof (報告のみ、raw 非 commit) で確認する。
    // outcome 値・unknown/rejected 所属は STRUCTURAL (形状保持の証明用。
    // 観測結果の主張ではない)。
    const codes = excerpt.codes as string[];
    const outcomes: Record<string, { status: "written"; latestSourceBar: string; bodySha: string }> = {};
    for (const code of codes) {
      outcomes[code] = { status: "written", latestSourceBar: "2026-09-30", bodySha: "b".repeat(64) };
    }
    const s = buildIngestSummary({
      ...stats,
      kind: "daily",
      range: "1mo-diff/10y-backfill",
      codes: codes.length,
      written: codes.length,
      unknown: ["4439"],
      rejected: ["584A"],
      universe: {
        size: codes.length,
        sha256: "da8250ddb370ece4dc6c62e68542adbae0dcf991ebb261a0e7fa3ea918586e4c",
      },
      outcomes,
    });
    // metadata: rich_text 配列 ≤100 要素 (text 2000 刻み)・blocks ≤1000・
    // payload ≤500KB を要求。実測 ~1KB のところ bound で余裕を持たせつつ
    // 上限から遠ざける (chunk 数の直接証明)。
    const metaLen = JSON.stringify(s.metadata).length;
    expect(metaLen).toBeLessThan(10000);
    const richTextItems = Math.ceil(metaLen / 2000);
    expect(richTextItems).toBeLessThanOrEqual(10);
    const bodyBlocks = Math.ceil(metaLen / 2000);
    expect(bodyBlocks).toBeLessThanOrEqual(10);
    expect("outcomes" in (s.metadata as Record<string, unknown>)).toBe(false);
    expect(s.metadata.unknownCount).toBe(1);
    expect(s.metadata.rejectedCount).toBe(1);
    // 本文は全 outcomes + 非空 unknown/rejected 一覧を保持する (欠落なし)。
    const body = JSON.parse(new TextDecoder().decode(s.files[0].bytes));
    expect(Object.keys(body.outcomes)).toHaveLength(codes.length);
    expect(body.universe.sha256).toBe("da8250ddb370ece4dc6c62e68542adbae0dcf991ebb261a0e7fa3ea918586e4c");
    expect(body.unknown).toEqual(["4439"]);
    expect(body.rejected).toEqual(["584A"]);
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

describe("archiveSummaryOrFatal", () => {
  it("recorded のみ 0", async () => {
    await expect(
      archiveSummaryOrFatal(async () => ({ outcome: "recorded", fileTooLarge: false }))
    ).resolves.toEqual({ code: 0, reason: null });
  });

  it("skipped/fileTooLarge/例外は理由付き 2", async () => {
    await expect(
      archiveSummaryOrFatal(async () => ({ outcome: "skipped_existing", fileTooLarge: false }))
    ).resolves.toEqual({ code: 2, reason: "outcome=skipped_existing" });
    await expect(
      archiveSummaryOrFatal(async () => ({ outcome: "recorded", fileTooLarge: true }))
    ).resolves.toMatchObject({ code: 2 });
    const r = await archiveSummaryOrFatal(async () => { throw new Error("boom https://x.example/s"); });
    expect(r.code).toBe(2);
    expect(r.reason).toContain("exception:Error:");
    expect(r.reason).not.toContain("https://");
  });
});

describe("sourceObservedAggregate", () => {
  it("観測ありのみ数え、日付/ts の最大を取る", () => {
    expect(
      sourceObservedAggregate({
        a: { status: "written", latestSourceBar: "2026-09-29", bodySha: "x" },
        b: { status: "skipped", latestSourceBar: "2026-09-30", bodySha: "y" },
        c: { status: "empty", latestSourceBar: null, bodySha: null },
        d: { status: "notStarted", latestSourceBar: null, bodySha: null },
      })
    ).toEqual({ count: 2, maxDate: "2026-09-30", maxTs: null });
    expect(
      sourceObservedAggregate({
        a: { status: "written", latestSourceBar: 100, bodySha: "x" },
        b: { status: "unknown", latestSourceBar: 200, bodySha: "y" },
      })
    ).toEqual({ count: 2, maxDate: null, maxTs: 200 });
    expect(sourceObservedAggregate({})).toEqual({ count: 0, maxDate: null, maxTs: null });
  });
});

describe("sanitizeLogText", () => {
  it("URL と secret 代入を落とす", () => {
    expect(sanitizeLogText("at https://a.example/x?k=1 end")).toBe("at <url> end");
    expect(sanitizeLogText("secret=abc123 ok")).toBe("secret=<redacted> ok");
  });
});

describe("universePin/bodyPin", () => {
  it("sorted 結合の安定 pin", () => {
    const a = universePin(["7203", "6758"]);
    const b = universePin(["6758", "7203"]);
    expect(a).toEqual(b);
    expect(a.size).toBe(2);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(universePin(["7203"]).sha256).not.toBe(a.sha256);
    expect(bodyPin("{}")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("assertSavedDailyShape", () => {
  const bar = { date: "2026-09-25", o: 100, h: 110, l: 90, c: 105, v: 1000, adj: 104 };
  const good = (over: object = {}) =>
    JSON.stringify({ code: "7203", updated: "x", bars: [bar], splits: [{ date: "2020-01-01", ratio: 2 }], ...over });

  it("正準形は通す", () => {
    expect(assertSavedDailyShape(good(), "daily/7203.json", "7203").code).toBe("7203");
  });

  it("parse不能・非object・code不一致・非配列は落とす", () => {
    expect(() => assertSavedDailyShape("xx", "daily/7203.json", "7203")).toThrow(/parse 不能/);
    expect(() => assertSavedDailyShape("[1]", "daily/7203.json", "7203")).toThrow(/object でない/);
    expect(() => assertSavedDailyShape(good({ code: "6758" }), "daily/7203.json", "7203")).toThrow(/code 不一致/);
    expect(() => assertSavedDailyShape(good({ bars: null }), "daily/7203.json", "7203")).toThrow(/非配列/);
  });

  it("日付不正・重複・adj欠落・価格異常は落とす", () => {
    expect(() => assertSavedDailyShape(good({ bars: [{ ...bar, date: "2026-13-40" }] }), "daily/7203.json", "7203")).toThrow(/日付不正/);
    expect(() => assertSavedDailyShape(good({ bars: [bar, bar] }), "daily/7203.json", "7203")).toThrow(/重複/);
    const noAdj = { date: "2026-09-25", o: 100, h: 110, l: 90, c: 105, v: 1000 };
    expect(() => assertSavedDailyShape(good({ bars: [noAdj] }), "daily/7203.json", "7203")).toThrow(/adj 欠落/);
    expect(() => assertSavedDailyShape(good({ bars: [{ ...bar, c: -5 }] }), "daily/7203.json", "7203")).toThrow(/価格異常/);
  });

  it("splits 要素の日付不正・ratio 非正有限は落とす", () => {
    expect(() => assertSavedDailyShape(good({ splits: [{ date: "xx", ratio: 2 }] }), "daily/7203.json", "7203")).toThrow(/splits 要素/);
    expect(() => assertSavedDailyShape(good({ splits: [{ date: "2020-01-01", ratio: 0 }] }), "daily/7203.json", "7203")).toThrow(/splits 要素/);
  });
});

describe("assertSavedIntraShape", () => {
  const bar = { ts: 1757548800, o: 100, h: 110, l: 90, c: 105, v: 1000 };
  const good = (over: object = {}) =>
    JSON.stringify({ code: "7203", updated: "x", bars: [bar], ...over });

  it("正準形は通す (adj なし可)", () => {
    expect(assertSavedIntraShape(good(), "intra/7203.json", "7203").code).toBe("7203");
  });

  it("code不一致・ts不正・重複・価格異常は落とす", () => {
    expect(() => assertSavedIntraShape(good({ code: "6758" }), "intra/7203.json", "7203")).toThrow(/code 不一致/);
    expect(() => assertSavedIntraShape(good({ bars: [{ ...bar, ts: -1 }] }), "intra/7203.json", "7203")).toThrow(/ts 不正/);
    expect(() => assertSavedIntraShape(good({ bars: [bar, bar] }), "intra/7203.json", "7203")).toThrow(/重複/);
    expect(() => assertSavedIntraShape(good({ bars: [{ ...bar, h: 1, l: 90 }] }), "intra/7203.json", "7203")).toThrow(/価格異常/);
  });
});
