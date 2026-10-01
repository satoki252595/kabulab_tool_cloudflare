import { describe, expect, it } from "vitest";
import { assertRecordDate, isRecurringBenefit } from "../record-date.js";

describe("単発基準日", () => {
  it("公式8508の実基準日と従来月を区別する", () => {
    expect(() => assertRecordDate("2026-09-02")).not.toThrow();
    expect(isRecurringBenefit({ recordDate: "2026-09-02" })).toBe(false);
    expect(isRecurringBenefit({ recordDate: null })).toBe(true);
  });

  it.each([undefined, "", "9月2日", "2026-9-2", "2026-02-30", "0000-01-01"])(
    "不明・不正な日付を月末やNULLへ変換せず停止する: %s",
    value => expect(() => assertRecordDate(value)).toThrow(),
  );
});
