import { describe, expect, it } from "vitest";
import { isDailySyncIncomplete } from "./daily.js";

describe("isDailySyncIncomplete", () => {
  it("全対象成功かつマクロ成功だけを完全成功とする", () => {
    expect(
      isDailySyncIncomplete({
        totalStocks: 3_716,
        successStocks: 3_716,
        failedStocks: 0,
        marketContextOk: true,
      })
    ).toBe(false);
  });

  it("個別失敗・マクロ失敗・空母集団を監視上の失敗にする", () => {
    expect(
      isDailySyncIncomplete({
        totalStocks: 3_716,
        successStocks: 3_715,
        failedStocks: 1,
        marketContextOk: true,
      })
    ).toBe(true);
    expect(
      isDailySyncIncomplete({
        totalStocks: 3_716,
        successStocks: 3_716,
        failedStocks: 0,
        marketContextOk: false,
      })
    ).toBe(true);
    expect(
      isDailySyncIncomplete({
        totalStocks: 0,
        successStocks: 0,
        failedStocks: 0,
        marketContextOk: true,
      })
    ).toBe(true);
    expect(
      isDailySyncIncomplete({
        totalStocks: 3_716,
        successStocks: 3_715,
        failedStocks: 0,
        marketContextOk: true,
      })
    ).toBe(true);
  });
});
