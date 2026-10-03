import { describe, expect, it } from "vitest";
import { assertRecordDate, assertRecordMonth, formatRecordMonth, isRecurringBenefit } from "../record-date.js";

describe("単発基準日", () => {
  it("公式8508の実基準日と従来月を区別する", () => {
    expect(() => assertRecordDate("2026-09-02")).not.toThrow();
    expect(isRecurringBenefit({ recordMonth: 9, recordDate: "2026-09-02" })).toBe(false);
    expect(isRecurringBenefit({ recordMonth: 6, recordDate: null })).toBe(true);
  });

  it("公式随時は0月へ変換せず、年間・月カレンダー対象から除く", () => {
    expect(formatRecordMonth(0)).toBe("随時");
    expect(formatRecordMonth(6)).toBe("6月");
    expect(isRecurringBenefit({ recordMonth: 0, recordDate: null })).toBe(false);
    expect(() => isRecurringBenefit({ recordMonth: 0, recordDate: "2026-09-02" })).toThrow(/混在/);
    for (const value of [undefined, null, "0", -1, 13, 0.5, NaN]) {
      expect(() => assertRecordMonth(value)).toThrow();
    }
  });

  it.each([undefined, "", "9月2日", "2026-9-2", "2026-02-30", "0000-01-01"])(
    "不明・不正な日付を月末やNULLへ変換せず停止する: %s",
    value => expect(() => assertRecordDate(value)).toThrow(),
  );
});
