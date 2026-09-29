import { describe, expect, it } from "vitest";
import { buildIngestSummary, findInvalidBars } from "./ingest-guard.js";

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
});

describe("buildIngestSummary", () => {
  const stats = {
    kind: "intra" as const,
    range: "5d",
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
    expect(s.key).toBe("vwap-ingest-intra-20260928");
    expect(s.files).toHaveLength(1);
    expect(s.files[0].filename).toBe("vwap-ingest-intra-20260928.json");
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
});
