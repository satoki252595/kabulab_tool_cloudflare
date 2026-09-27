import { describe, expect, it } from "vitest";
import { isoWeekLabelOf, isoWeekToDateRange, mostRecentMondayOf } from "./iso-week.js";

describe("isoWeekLabelOf / isoWeekToDateRange の往復", () => {
  it("週内の任意の曜日を与えても同じ週ラベルを返す", () => {
    // 2026-09-14(月)〜09-20(日) は 2026-W38。
    for (const iso of ["2026-09-14", "2026-09-16", "2026-09-20"]) {
      expect(isoWeekLabelOf(new Date(`${iso}T00:00:00.000Z`))).toBe("2026-W38");
    }
  });

  it("ラベル→範囲→ラベルが往復一致する (2026年通年で検証)", () => {
    for (let w = 1; w <= 52; w++) {
      const label = `2026-W${String(w).padStart(2, "0")}`;
      const range = isoWeekToDateRange(label);
      expect(isoWeekLabelOf(new Date(`${range.from}T00:00:00.000Z`))).toBe(label);
    }
  });

  it("年またぎ (2026-W01 は 2025年12月開始) を正しく扱う", () => {
    expect(isoWeekToDateRange("2026-W01")).toEqual({ from: "2025-12-29", to: "2026-01-04" });
    expect(isoWeekLabelOf(new Date("2025-12-30T00:00:00.000Z"))).toBe("2026-W01");
  });
});

describe("mostRecentMondayOf", () => {
  it("月曜自身なら同じ日を返す", () => {
    expect(mostRecentMondayOf(new Date("2026-09-14T00:00:00.000Z"))).toBe("2026-09-14");
  });

  it("週の途中 (木曜) ならその週の月曜を返す", () => {
    expect(mostRecentMondayOf(new Date("2026-09-17T00:00:00.000Z"))).toBe("2026-09-14");
  });

  it("日曜ならその週 (月曜始まり) の月曜を返す", () => {
    expect(mostRecentMondayOf(new Date("2026-09-20T00:00:00.000Z"))).toBe("2026-09-14");
  });
});
