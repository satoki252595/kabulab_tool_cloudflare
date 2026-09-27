import { readFileSync } from "node:fs";
import {
  parseInvestorEquityWorkbook,
  parseWeeklyIndexHtml,
  parseMonthlyIndexHtml,
  pickLatestPublishedMonth,
  latestWeeklyEntry,
} from "/Users/satoki252595/projects/kabulab-cf/.claude/worktrees/wf_a6c4999f-a98-1/services/moneyflow/lib/sources/jpx-investor-equity.ts";

function loadBytes(p: string): Uint8Array {
  return new Uint8Array(readFileSync(p));
}

// --- 1) parse the files I independently downloaded just now from JPX (not the fixtures) ---
const weeklyValue = parseInvestorEquityWorkbook(loadBytes("/tmp/stock_val_1_260902.xls"), "stock_val_1_260902.xls");
const weeklyVolume = parseInvestorEquityWorkbook(loadBytes("/tmp/stock_vol_1_260902.xls"), "stock_vol_1_260902.xls");
const monthlyValue = parseInvestorEquityWorkbook(loadBytes("/tmp/stock_val_1_m2608.xls"), "stock_val_1_m2608.xls");
const monthlyVolume = parseInvestorEquityWorkbook(loadBytes("/tmp/stock_vol_1_m2608.xls"), "stock_vol_1_m2608.xls");
const weeklyValueW1 = parseInvestorEquityWorkbook(loadBytes("/tmp/stock_val_1_260901.xls"), "stock_val_1_260901.xls");

function find(records: any[], market: string, category: string) {
  const r = records.find((r) => r.market === market && r.investorCategory === category);
  if (!r) throw new Error(`not found: ${market}/${category}`);
  return r;
}

console.log("=== weekly value W2 (2026-09-07..09-11), TSE Prime, 自己計 ===");
const p = find(weeklyValue, "TSE Prime", "自己計");
console.log(JSON.stringify(p, null, 2));
console.log("expect sell=5349098396 buy=5659975243 total=11009073639 net=310876847");
console.log("match:", p.sell === 5349098396 && p.buy === 5659975243 && p.total === 11009073639 && p.net === 310876847);

console.log("\n=== weekly volume W2, Tokyo & Nagoya, 総計 ===");
const t = find(weeklyVolume, "Tokyo & Nagoya", "総計");
console.log(JSON.stringify(t, null, 2));
console.log("expect total=35820577");
console.log("match:", t.total === 35820577);

console.log("\n=== monthly value 2026-08, TSE Prime, 自己計 ===");
const m = find(monthlyValue, "TSE Prime", "自己計");
console.log(JSON.stringify(m, null, 2));
console.log("expect sell=18077441828 buy=18547327192 total=36624769020");
console.log("match:", m.sell === 18077441828 && m.buy === 18547327192 && m.total === 36624769020);

console.log("\n=== monthly value 2026-08, Tokyo & Nagoya, 総計 ===");
const mt = find(monthlyValue, "Tokyo & Nagoya", "総計");
console.log(JSON.stringify(mt, null, 2));
console.log("expect total=407516356670");
console.log("match:", mt.total === 407516356670);

console.log("\n=== weekly value W1 (month-crossing 8/31-9/4) period resolution ===");
const w1 = find(weeklyValueW1, "TSE Prime", "自己計");
console.log("periodLabel", w1.periodLabel, "periodStart", w1.periodStart, "periodEnd", w1.periodEnd);
console.log("match:", w1.periodLabel === "2026年9月第1週" && w1.periodStart === "2026-08-31" && w1.periodEnd === "2026-09-04");

console.log("\n=== record counts ===");
console.log("weeklyValue.length", weeklyValue.length, "expect", 4 * 15);
console.log("weeklyVolume.length", weeklyVolume.length, "expect", 4 * 15);

// --- 2) index page parsing against freshly-fetched index pages ---
const weeklyHtml = readFileSync("/tmp/jpx-weekly-index.html", "utf-8");
const weeklyEntries = parseWeeklyIndexHtml(weeklyHtml);
const latestWeekly = latestWeeklyEntry(weeklyEntries);
console.log("\n=== latest weekly entry from freshly-fetched index page ===");
console.log(latestWeekly);

const monthlyHtml = readFileSync("/tmp/jpx-monthly-index.html", "utf-8");
const monthlyEntries = parseMonthlyIndexHtml(monthlyHtml);
const latestMonthly = pickLatestPublishedMonth(monthlyEntries);
console.log("\n=== latest published month from freshly-fetched index page ===");
console.log(latestMonthly);
console.log("published months:", monthlyEntries.filter(e => e.valueXlsUrl !== null).map(e => e.month));
console.log("unpublished months:", monthlyEntries.filter(e => e.valueXlsUrl === null).map(e => e.month));

// --- 3) sanity: does summing all 14 unified-format groups reproduce any '総計' if present? ---
console.log("\n=== unified format group coverage check (no 総計/自己計/委託計 present) ===");
const unifiedBytes = loadBytes(
  "/Users/satoki252595/projects/kabulab-cf/.claude/worktrees/wf_a6c4999f-a98-1/services/moneyflow/lib/sources/__fixtures__/jpx-investor-equity/unified-format-sample-jpx-official.xlsx"
);
const unifiedRecords = parseInvestorEquityWorkbook(unifiedBytes, "stock_1_w_YYYYMMDD_YYYYMMDD.xlsx");
const categories = new Set(unifiedRecords.map((r: any) => r.investorCategory));
console.log("categories:", [...categories].sort());
console.log("has 総計/自己計/委託計?", [...categories].some((c) => c === "総計" || c === "自己計" || c === "委託計"));
