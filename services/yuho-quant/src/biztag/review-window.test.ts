import { firstMondayOfAugust, reviewDeadline, reviewWindowOf } from "./review-window.js";

describe("review-window", () => {
  it("8 月第 1 月曜 (実際のカレンダー)", () => {
    expect(firstMondayOfAugust(2026)).toBe("2026-08-03");
    expect(firstMondayOfAugust(2027)).toBe("2027-08-02");
    expect(firstMondayOfAugust(2022)).toBe("2022-08-01"); // 8/1 が月曜の年
    expect(firstMondayOfAugust(2021)).toBe("2021-08-02");
  });

  it("期限は開始日 + 7 日", () => {
    expect(reviewDeadline(2027)).toBe("2027-08-09");
  });

  it("開始日〜期限の間だけ open", () => {
    expect(reviewWindowOf("2027-08-01").open).toBe(false);
    expect(reviewWindowOf("2027-08-02").open).toBe(true);
    expect(reviewWindowOf("2027-08-09").open).toBe(true);
    expect(reviewWindowOf("2027-08-10").open).toBe(false);
    expect(reviewWindowOf("2027-08-09")).toEqual({
      todayJst: "2027-08-09",
      start: "2027-08-02",
      deadline: "2027-08-09",
      open: true,
    });
  });

  it("形式の不正な日付は throw する", () => {
    expect(() => reviewWindowOf("2027/08/02")).toThrow();
  });
});
