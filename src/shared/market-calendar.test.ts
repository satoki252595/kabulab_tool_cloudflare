import { describe, expect, it } from "vitest";
import { marketClosure } from "./market-calendar.js";

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
