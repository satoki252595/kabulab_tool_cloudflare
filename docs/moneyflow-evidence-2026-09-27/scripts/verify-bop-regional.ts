import { readFileSync } from "node:fs";
import {
  parseBopRegionalCsvText,
  extractBopRegionalObservations,
  extractBopRegionalZipHref,
  latestObservedPeriod,
  isPeriodObserved,
  BOP_REGIONS,
} from "/Users/satoki252595/projects/kabulab-cf/.claude/worktrees/wf_a6c4999f-a98-4/services/moneyflow/lib/sources/bop-regional.ts";

// Real CSV extracted from the live BOJ ZIP (fetched 2026-09-27), decoded shift_jis already via iconv upstream to utf8 for my own grep checks, but for the actual parser we must feed it shift_jis-decoded text as TextDecoder would produce. Let's decode directly here with Node's own shift_jis-ish handling using TextDecoder (available in Node 22).
const raw = readFileSync("/tmp/regbp_extract/regbp_q_jp.csv");
const csvText = new TextDecoder("shift_jis").decode(raw);

console.log("csv length:", csvText.length);

const parsed = parseBopRegionalCsvText(csvText);
console.log("periods:", parsed.periods.map((p) => p.label).join(","));
console.log("rows:", parsed.rows.length);

const observations = extractBopRegionalObservations(parsed);
console.log("observations:", observations.length);

console.log("latestObservedPeriod:", latestObservedPeriod(observations));
console.log("isPeriodObserved(2026,1):", isPeriodObserved(observations, 2026, 1));
console.log("isPeriodObserved(2026,2):", isPeriodObserved(observations, 2026, 2));

function find(period: string, metricKey: string, region: string) {
  return observations.find(
    (o) => o.period === period && o.metricKey === metricKey && o.region === region
  );
}

const checks: Array<[string, string, string, number]> = [
  ["2026Q1", "bop_regional_direct_investment_net", "中華人民共和国", -1631.38201514],
  ["2026Q1", "bop_regional_portfolio_investment_net", "アメリカ合衆国", -3214.85204568],
  ["2026Q1", "bop_regional_portfolio_investment_equity_asset", "アメリカ合衆国", 18925.53442],
  ["2026Q1", "bop_regional_portfolio_investment_debt_asset", "ドイツ", -2983.81395215],
  ["2026Q1", "bop_regional_direct_investment_net", "アジア計", 7230.99152397],
  ["2026Q1", "bop_regional_direct_investment_net", "地域別合計", 40673.64563458],
];

for (const [period, metricKey, region, expected] of checks) {
  const o = find(period, metricKey, region);
  const ok = o !== undefined && Math.abs(o.value - expected) < 1e-6;
  console.log(
    `${ok ? "OK  " : "FAIL"} ${period} ${metricKey} ${region} expected=${expected} actual=${o?.value}`
  );
}

// additional cross-checks: asset - liability = net, for a handful of region/metric combos
function checkAssetMinusLiabEqualsNet(period: string, assetKey: string, liabKey: string, netKey: string, region: string) {
  const a = find(period, assetKey, region)?.value;
  const l = find(period, liabKey, region)?.value;
  const n = find(period, netKey, region)?.value;
  if (a === undefined || l === undefined || n === undefined) {
    console.log(`SKIP asset-liab=net check for ${region}/${assetKey}: missing value(s) a=${a} l=${l} n=${n}`);
    return;
  }
  const diff = a - l - n;
  console.log(
    `${Math.abs(diff) < 1e-4 ? "OK  " : "FAIL"} asset-liab=net ${region} ${netKey}: a=${a} l=${l} n=${n} diff=${diff}`
  );
}

checkAssetMinusLiabEqualsNet(
  "2026Q1",
  "bop_regional_direct_investment_asset",
  "bop_regional_direct_investment_liability",
  "bop_regional_direct_investment_net",
  "中華人民共和国"
);
checkAssetMinusLiabEqualsNet(
  "2026Q1",
  "bop_regional_portfolio_investment_asset",
  "bop_regional_portfolio_investment_liability",
  "bop_regional_portfolio_investment_net",
  "アメリカ合衆国"
);

// check region kind counts
const kindCounts: Record<string, number> = {};
for (const r of BOP_REGIONS) {
  kindCounts[r.kind] = (kindCounts[r.kind] ?? 0) + 1;
}
console.log("region kind counts:", kindCounts);

// check for any observation whose region is not in BOP_REGIONS (shouldn't happen, since extraction throws otherwise, but confirm no throw happened i.e. we got here)
console.log("distinct regions observed:", new Set(observations.map((o) => o.region)).size);

// dload html check
const dloadRaw = readFileSync("/tmp/dload.html");
const dloadHtml = new TextDecoder("shift_jis").decode(dloadRaw);
console.log("extractBopRegionalZipHref:", extractBopRegionalZipHref(dloadHtml));

const observedRegions = new Set(observations.map((o) => o.region));
const missing = BOP_REGIONS.filter((r) => !observedRegions.has(r.name));
console.log("regions never observed:", missing.map((r) => r.name));

// classified row count sanity check (each row should map to exactly one metric)
const rowCodesByMetric = new Map<string, Set<string>>();
for (const o of observations) {
  if (!rowCodesByMetric.has(o.metricKey)) rowCodesByMetric.set(o.metricKey, new Set());
  rowCodesByMetric.get(o.metricKey)!.add(o.sourceCode);
}
let totalDistinctCodes = new Set<string>();
for (const [k, s] of rowCodesByMetric) {
  console.log(`metric ${k}: ${s.size} distinct source rows`);
  for (const c of s) totalDistinctCodes.add(c);
}
console.log("total distinct classified source rows:", totalDistinctCodes.size);
console.log("total parsed rows (all, incl. unclassified):", parsed.rows.length);
