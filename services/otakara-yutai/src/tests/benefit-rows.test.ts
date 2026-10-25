import { drizzle } from "drizzle-orm/sqlite-proxy";
import { expect, it, vi } from "vitest";
import { loadBenefitRows, type OtakaraD1 } from "../../data-scripts/benefit-rows.js";

it("手動reviewのcode集合をactiveと同じSQLで限定し、tier条件やLIMITは加えない", async () => {
  const query = vi.fn(async () => ({ rows: [] })), db = drizzle(query) as OtakaraD1;
  await loadBenefitRows(db, "active-equity", ["7502", "5527"]);
  const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
  expect(sql).toContain('"core_stocks"."code" in (?, ?)'); expect(params).toEqual([1, "equity", "7502", "5527"]);
  expect(sql).not.toMatch(/\blimit\b|"min_shares"\s*=/i);
  query.mockClear();
  for (const codes of [[], ["7502", "7502"], ["1"]]) await expect(loadBenefitRows(db, "active-equity", codes)).rejects.toThrow();
  await expect(loadBenefitRows(db, "all", ["7502"])).rejects.toThrow(); expect(query).not.toHaveBeenCalled();
});
