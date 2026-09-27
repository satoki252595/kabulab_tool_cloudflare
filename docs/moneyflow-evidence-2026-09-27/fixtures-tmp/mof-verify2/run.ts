import { readFileSync } from "node:fs";
import {
  parseMofWeeklyFlows,
  parseMofMonthlyFlows,
  MOF_PORTFOLIO_FLOWS_INDICATORS,
} from "/Users/satoki252595/projects/kabulab-cf/.claude/worktrees/wf_a6c4999f-a98-3/services/moneyflow/lib/sources/mof-portfolio-flows.ts";

const weekBytes = new Uint8Array(readFileSync("/tmp/mof-verify2/week.csv"));
const monthBytes = new Uint8Array(readFileSync("/tmp/mof-verify2/montha1.csv"));

const weekly = parseMofWeeklyFlows(weekBytes);
const monthly = parseMofMonthlyFlows(monthBytes);

console.log("weekly rows:", weekly.rows.length, "unpublished:", weekly.unpublishedPeriods.length);
console.log("monthly rows:", monthly.rows.length, "unpublished:", monthly.unpublishedPeriods);

function find(rows: typeof weekly.rows, periodKey: string, direction: string, assetClass: string, metric: string) {
  const r = rows.find(
    (r) => r.periodKey === periodKey && r.direction === direction && r.assetClass === assetClass && r.metric === metric
  );
  return r ? r.value : "NOT FOUND";
}

// Latest weekly period (2026-09-06_2026-09-12) checks
console.log("--- latest weekly 2026-09-06_2026-09-12 ---");
console.log("outward/equity/net:", find(weekly.rows, "2026-09-06_2026-09-12", "outward", "equity", "net"));
console.log("inward/equity/net:", find(weekly.rows, "2026-09-06_2026-09-12", "inward", "equity", "net"));
console.log("inward/total/net:", find(weekly.rows, "2026-09-06_2026-09-12", "inward", "total", "net"));
console.log("outward/equity/acquisition:", find(weekly.rows, "2026-09-06_2026-09-12", "outward", "equity", "acquisition"));
console.log("inward/short_term_bond/acquisition:", find(weekly.rows, "2026-09-06_2026-09-12", "inward", "short_term_bond", "acquisition"));

console.log("--- monthly 2026-08 ---");
console.log("outward/equity/net:", find(monthly.rows, "2026-08", "outward", "equity", "net"));
console.log("inward/long_term_bond/net:", find(monthly.rows, "2026-08", "inward", "long_term_bond", "net"));
console.log("inward/total/net:", find(monthly.rows, "2026-08", "inward", "total", "net"));

console.log("--- monthly 2026-01 ---");
console.log("outward/equity/net:", find(monthly.rows, "2026-01", "outward", "equity", "net"));

console.log("--- year-crossing week 2006-12-31_2007-01-06 ---");
const crossRow = weekly.rows.find((r) => r.periodKey === "2006-12-31_2007-01-06");
console.log(crossRow ? "found, periodStart/End: " + crossRow.periodStart + "/" + crossRow.periodEnd : "NOT FOUND");

console.log("--- unpublished monthly periods ---");
console.log(monthly.unpublishedPeriods);

console.log("--- indicator limitations text check ---");
for (const def of MOF_PORTFOLIO_FLOWS_INDICATORS) {
  console.log(def.key, "=>", /2014年1月/.test(def.limitations), /区分変更/.test(def.limitations));
}
