import { describe, expect, it } from "vitest";
import { lastJpxSessionOnOrBefore, marketClosure } from "./market-calendar.js";

describe("公式市場休業日", () => {
  it("日本のみ休場する10/12と米国のみ休場する9/7を区別する", () => {
    expect(marketClosure("JPX", "2026-10-12")?.reason).toBe("スポーツの日");
    expect(marketClosure("NYSE", "2026-10-12")).toBeNull();
    expect(marketClosure("JPX", "2026-09-07")).toBeNull();
    expect(marketClosure("NYSE", "2026-09-07")?.reason).toBe("Labor Day");
  });
  it("JPX年末休場・振替休日を含み、米短縮取引は休場にしない", () => {
    expect(marketClosure("JPX", "2026-12-31")?.reason).toBe("休業日");
    expect(marketClosure("JPX", "2027-03-22")?.reason).toBe("振替休日");
    expect(marketClosure("NYSE", "2026-11-27")).toBeNull();
    expect(marketClosure("NYSE", "2026-12-24")).toBeNull();
    expect(marketClosure("JPX", "2026-10-11")?.reason).toBe("土日休場");
  });
  it("未収録年と暦不正を営業日に倒さない", () => {
    expect(() => marketClosure("JPX", "2028-01-04")).toThrow("未収録");
    expect(() => marketClosure("JPX", "2026-02-30")).toThrow("不正");
  });
});

it("公式年末原典だけで2025年末sessionを資格化し、2025通年を推定しない", () => {
  expect(lastJpxSessionOnOrBefore("2025-12-31")).toMatchObject({ date: "2025-12-30", closedDates: ["2025-12-31"],
    calendarSources: [expect.objectContaining({ readback: true }), expect.objectContaining({ readback: true }), expect.objectContaining({ readback: true })] });
  expect(lastJpxSessionOnOrBefore("2025-11-30")).toBeUndefined();
  expect(() => marketClosure("JPX", "2025-12-31")).toThrow("未収録");
});
it("記録済み公式休日だけ遡り、営業日なら同日を要求し、不正日付は拒否する", () => {
  expect(lastJpxSessionOnOrBefore("2026-05-31")).toMatchObject({ date: "2026-05-29", closedDates: ["2026-05-31", "2026-05-30"] });
  expect(lastJpxSessionOnOrBefore("2026-06-30")).toEqual({ date: "2026-06-30", closedDates: [], calendarSources: [] });
  expect(lastJpxSessionOnOrBefore("2026-01-01")).toMatchObject({ date: "2025-12-30", closedDates: ["2026-01-01", "2025-12-31"] });
  expect(() => lastJpxSessionOnOrBefore("2026-02-30")).toThrow("不正");
});

it("2025土日は同原本の直前金曜sessionがある場合だけ採り、金曜を推測しない", () => {
  for (const [date, friday] of [["2025-08-31", "2025-08-29"], ["2025-11-30", "2025-11-28"], ["2025-12-20", "2025-12-19"]]) {
    expect(lastJpxSessionOnOrBefore(date, new Set([friday]))).toMatchObject({ date: friday,
      calendarSources: [expect.objectContaining({ sha256: "f6d90126fcbc85407d464044e434e79780f43d71ee3eb05d1b9e0699421ef006", readback: true })] });
    expect(lastJpxSessionOnOrBefore(date)).toBeUndefined();
    expect(lastJpxSessionOnOrBefore(date, new Set())).toBeUndefined();
  }
  for (const date of ["2025-11-28", "2025-11-24", "2025-01-04", "2025-01-05", "2024-11-30"]) {
    expect(lastJpxSessionOnOrBefore(date, new Set(["2025-11-28", "2025-11-21", "2025-01-03", "2024-11-29"]))).toBeUndefined();
  }
  expect(lastJpxSessionOnOrBefore("2025-12-31", new Set(["2025-12-29"]))?.date).toBe("2025-12-30");
});
