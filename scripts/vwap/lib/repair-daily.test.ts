import { describe, expect, it } from "vitest";
import { buildRepairPost } from "./repair-daily.js";

/** STRUCTURAL fixtures (形状・分岐の証明用。観測値の主張ではない)。 */
const bar = (date: string, over: Record<string, unknown> = {}) => ({
  date, o: 100, h: 110, l: 90, c: 105, v: 1000, adj: 104, ...over,
});
const old = (bars: Array<Record<string, unknown>>) =>
  JSON.stringify({ code: "7944", updated: "2026-09-29T00:00:00.000Z", bars, splits: [] });
const RANGE = { from: "2026-09-20", to: "2026-09-29" };

describe("buildRepairPost", () => {
  it("有効 fresh で whole post を再構築し range 外旧を明示破棄する", () => {
    const r = buildRepairPost({
      code: "7944",
      oldRaw: old([bar("2016-06-20"), bar("2026-09-25"), bar("2026-09-26", { adj: -1 })]),
      fresh: { bars: [bar("2026-09-25"), bar("2026-09-26")], splits: [] },
      range: RANGE,
      updatedAt: "2026-09-30T10:00:00.000Z",
    });
    expect(r.post.code).toBe("7944");
    expect(r.freshFirst).toBe("2026-09-25");
    expect(r.freshLast).toBe("2026-09-26");
    expect(r.discardedOutOfRange).toEqual({ count: 1, first: "2016-06-20", last: "2016-06-20" });
    expect(r.supersededInRange).toBe(2);
    const body = JSON.parse(r.postJson) as { bars: unknown[]; splits: unknown[] };
    expect(body.bars).toHaveLength(2);
    expect(body.splits).toEqual([]);
  });

  it("fresh 非正 adj は HOLD (PUT 素材にしない)", () => {
    expect(() =>
      buildRepairPost({
        code: "7944",
        oldRaw: old([bar("2026-09-25")]),
        fresh: { bars: [bar("2026-09-25", { adj: 0 })], splits: [] },
        range: RANGE,
        updatedAt: "2026-09-30T10:00:00.000Z",
      })
    ).toThrow(/fresh 不合格/);
  });

  it("fresh adj 欠落は HOLD (c 代用なし)", () => {
    expect(() =>
      buildRepairPost({
        code: "7944",
        oldRaw: old([bar("2026-09-25")]),
        fresh: { bars: [bar("2026-09-25", { adj: null })], splits: [] },
        range: RANGE,
        updatedAt: "2026-09-30T10:00:00.000Z",
      })
    ).toThrow(/fresh 不合格/);
  });

  it("in-range 有効旧が fresh に欠ければ HOLD (silent drop 禁止)", () => {
    expect(() =>
      buildRepairPost({
        code: "7944",
        oldRaw: old([bar("2026-09-25"), bar("2026-09-26")]),
        fresh: { bars: [bar("2026-09-25")], splits: [] },
        range: RANGE,
        updatedAt: "2026-09-30T10:00:00.000Z",
      })
    ).toThrow(/2026-09-26/);
  });

  it("旧 adj<=0 行の日付が fresh に欠けても HOLD (修復対象の silent drop 禁止)", () => {
    expect(() =>
      buildRepairPost({
        code: "7944",
        oldRaw: old([bar("2026-09-25", { adj: -2 })]),
        fresh: { bars: [bar("2026-09-26")], splits: [] },
        range: RANGE,
        updatedAt: "2026-09-30T10:00:00.000Z",
      })
    ).toThrow(/2026-09-25/);
  });

  it("old code 不一致・fresh 契約外・重複・splits 不正・range 不正是 HOLD", () => {
    const base = {
      code: "7944",
      oldRaw: old([bar("2026-09-25")]),
      fresh: { bars: [bar("2026-09-25")], splits: [] as Array<{ date: string; ratio: number }> },
      range: RANGE,
      updatedAt: "2026-09-30T10:00:00.000Z",
    };
    expect(() => buildRepairPost({ ...base, code: "8303" })).toThrow(/old code 不一致/);
    expect(() =>
      buildRepairPost({ ...base, fresh: { bars: [bar("2026-09-19")], splits: [] } })
    ).toThrow(/契約外/);
    expect(() =>
      buildRepairPost({ ...base, fresh: { bars: [bar("2026-09-25"), bar("2026-09-25")], splits: [] } })
    ).toThrow(/重複/);
    expect(() =>
      buildRepairPost({ ...base, fresh: { bars: [bar("2026-09-25")], splits: [{ date: "2026-09-25", ratio: 0 }] } })
    ).toThrow(/splits/);
    expect(() => buildRepairPost({ ...base, range: { from: "xx", to: "2026-09-29" } })).toThrow(/range 契約不正/);
  });
});
