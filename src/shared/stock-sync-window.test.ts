import { describe, expect, it } from "vitest";
import { assertStockSyncDeadline, assertStockSyncStart, stockSyncRunDate } from "./stock-sync-window.js";

describe("通常株式UTC対象日と実clockの窓", () => {
  it("JST翌未開場でもUTC対象日を変えず、正常runと保存原本に同じ窓を適用する", () => {
    // 実8303原本capture/V6読取clockと、JST日跨ぎの機構境界。
    for (const instant of ["2026-10-14T10:15:47.400Z", "2026-10-14T14:52:16.588Z", "2026-10-14T15:00:00.000Z", "2026-10-14T20:59:59.999Z"]) {
      const at = Date.parse(instant);
      expect(stockSyncRunDate(at)).toBe("2026-10-14");
      expect(() => assertStockSyncStart(at)).not.toThrow();
      expect(() => assertStockSyncDeadline("2026-10-14", at)).not.toThrow();
    }
    expect(stockSyncRunDate(Date.parse("2026-10-15T00:00:00Z"))).toBe("2026-10-15");
  });

  it("元の06:30開始と21:00書込期限の境界・例外文を保持する", () => {
    expect(() => assertStockSyncStart(Date.parse("2026-10-14T06:29:59.999Z"))).toThrow("東証15:30 JST終了後");
    expect(() => assertStockSyncStart(Date.parse("2026-10-14T06:30:00.000Z"))).not.toThrow();
    expect(() => assertStockSyncStart(Date.parse("2026-10-14T21:00:00.000Z"))).toThrow("翌06:00 JST基準");
    expect(() => assertStockSyncDeadline("2026-10-14", Date.parse("2026-10-14T21:00:00.000Z"))).toThrow("21:00 UTC期限");
  });
});
