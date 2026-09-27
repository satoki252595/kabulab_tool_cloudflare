import { readFileSync } from "node:fs";
import {
  parseBisBankingCsv,
  latestQuarterFromRows,
  resolvePublicationStatus,
  toMoneyflowObservations,
  mostRecentEndedQuarter,
} from "/Users/satoki252595/projects/kabulab-cf/.claude/worktrees/wf_a6c4999f-a98-15/services/moneyflow/lib/sources/bis-banking.ts";

const claimsCsv = readFileSync("/tmp/verify_claims_live.csv", "utf-8");
const liabCsv = readFileSync("/tmp/verify_liab_live.csv", "utf-8");

const claimsRows = parseBisBankingCsv(claimsCsv, "claims");
const liabRows = parseBisBankingCsv(liabCsv, "liabilities");

console.log("claims rows:", claimsRows.length, "liab rows:", liabRows.length);

const latestClaims = latestQuarterFromRows(claimsRows);
const latestLiab = latestQuarterFromRows(liabRows);
console.log("latest quarter (claims):", latestClaims);
console.log("latest quarter (liab):", latestLiab);

const status = resolvePublicationStatus(claimsRows, new Date());
console.log("resolvePublicationStatus:", JSON.stringify(status));
console.log("mostRecentEndedQuarter(now):", mostRecentEndedQuarter(new Date()));

// Known-value spot checks against the raw CSV (independent of fixtures)
function findRaw(rows: typeof claimsRows, cc: string, q: string) {
  return rows.find((r) => r.counterpartyCountry === cc && r.quarter === q);
}

const checks: Array<[string, number | undefined, number]> = [
  ["claims US 2026-Q1", findRaw(claimsRows, "US", "2026-Q1")?.valueUsdMillion ?? undefined, 2379304.268],
  ["claims GB 2026-Q1", findRaw(claimsRows, "GB", "2026-Q1")?.valueUsdMillion ?? undefined, 458048.538],
  ["claims DE 2026-Q1", findRaw(claimsRows, "DE", "2026-Q1")?.valueUsdMillion ?? undefined, 128644.097],
  ["liab US 2026-Q1", findRaw(liabRows, "US", "2026-Q1")?.valueUsdMillion ?? undefined, 525905.198],
  ["liab GB 2026-Q1", findRaw(liabRows, "GB", "2026-Q1")?.valueUsdMillion ?? undefined, 473663.377],
  ["liab DE 2026-Q1", findRaw(liabRows, "DE", "2026-Q1")?.valueUsdMillion ?? undefined, 40403.103],
  ["claims 5J 2026-Q1", findRaw(claimsRows, "5J", "2026-Q1")?.valueUsdMillion ?? undefined, 5257195.619],
  ["claims 1C 2026-Q1", findRaw(claimsRows, "1C", "2026-Q1")?.valueUsdMillion ?? undefined, 14873.514],
  ["liab 1C 2026-Q1", findRaw(liabRows, "1C", "2026-Q1")?.valueUsdMillion ?? undefined, 890.125],
];

let allOk = true;
for (const [label, actual, expected] of checks) {
  const ok = actual === expected;
  if (!ok) allOk = false;
  console.log(`${ok ? "OK" : "MISMATCH"}: ${label} = ${actual} (expected ${expected})`);
}

// Now verify toMoneyflowObservations excludes 1C and 5J from the LIVE data (not fixture)
const claimsObs = toMoneyflowObservations(claimsRows);
const liabObs = toMoneyflowObservations(liabRows);

const has1CClaims = claimsObs.some((o) => o.category === "1C");
const has5JClaims = claimsObs.some((o) => o.category === "5J");
const has1CLiab = liabObs.some((o) => o.category === "1C");
const has5JLiab = liabObs.some((o) => o.category === "5J");

console.log("claimsObs contains 1C:", has1CClaims, "(expect false)");
console.log("claimsObs contains 5J:", has5JClaims, "(expect false)");
console.log("liabObs contains 1C:", has1CLiab, "(expect false)");
console.log("liabObs contains 5J:", has5JLiab, "(expect false)");

if (has1CClaims || has5JClaims || has1CLiab || has5JLiab) {
  allOk = false;
}

// Confirm the observation for US 2026-Q1 in claimsObs matches raw
const usObs = claimsObs.find((o) => o.category === "US" && o.period === "2026-Q1");
console.log("US claims obs value:", usObs?.value, "(expect 2379304.268)");
if (usObs?.value !== 2379304.268) allOk = false;

console.log(allOk ? "\nALL INDEPENDENT CHECKS PASSED" : "\nSOME CHECKS FAILED");
process.exit(allOk ? 0 : 1);
