import {
  bisBankingUrl,
  fetchBisBanking,
  parseBisBankingCsv,
  latestQuarterFromRows,
  mostRecentEndedQuarter,
  resolvePublicationStatus,
  toMoneyflowObservations,
  BIS_BANKING_INDICATORS,
} from "/Users/satoki252595/projects/kabulab-cf/.claude/worktrees/wf_a6c4999f-a98-15/services/moneyflow/lib/sources/bis-banking.ts";

async function main() {
  console.log("=== URLs ===");
  console.log(bisBankingUrl("claims", 2));
  console.log(bisBankingUrl("liabilities", 2));

  console.log("\n=== Live fetch (今回のセッションで独自に取得) ===");
  const { claims, liabilities } = await fetchBisBanking(2);
  console.log("claims status url:", claims.url);
  console.log("liabilities status url:", liabilities.url);
  console.log("claims csv lines:", claims.csvText.split("\n").filter(Boolean).length);
  console.log("liabilities csv lines:", liabilities.csvText.split("\n").filter(Boolean).length);

  const claimsRows = parseBisBankingCsv(claims.csvText, "claims");
  const liabRows = parseBisBankingCsv(liabilities.csvText, "liabilities");

  function find(rows: typeof claimsRows, country: string, quarter: string) {
    return rows.find(
      (r) => r.counterpartyCountry === country && r.quarter === quarter && r.counterpartySector === "A"
    );
  }

  console.log("\n=== 既知値突合 (原本 CSV との一致確認、独自取得データに対して実施) ===");
  const checks: [string, ReturnType<typeof find>, number][] = [
    ["claims US 2026-Q1", find(claimsRows, "US", "2026-Q1"), 2379304.268],
    ["claims GB 2026-Q1", find(claimsRows, "GB", "2026-Q1"), 458048.538],
    ["claims DE 2026-Q1", find(claimsRows, "DE", "2026-Q1"), 128644.097],
    ["liab US 2026-Q1", find(liabRows, "US", "2026-Q1"), 525905.198],
    ["liab GB 2026-Q1", find(liabRows, "GB", "2026-Q1"), 473663.377],
    ["liab DE 2026-Q1", find(liabRows, "DE", "2026-Q1"), 40403.103],
  ];
  for (const [label, row, expected] of checks) {
    const actual = row?.valueUsdMillion;
    const ok = actual === expected;
    console.log(`${ok ? "OK  " : "FAIL"} ${label}: actual=${actual} expected=${expected}`);
  }

  console.log("\n=== 世界合計行 (5J) ===");
  const anchorClaims = find(claimsRows, "5J", "2026-Q1");
  console.log("claims 5J 2026-Q1:", anchorClaims?.valueUsdMillion, "(期待値 5257195.619)");
  const anchorLiab = find(liabRows, "5J", "2026-Q1");
  console.log("liabilities 5J 2026-Q1:", anchorLiab?.valueUsdMillion);

  console.log("\n=== 整合性チェック: 世界合計 >= 各国合計? (国別内訳が世界合計の部分集合になっているか) ===");
  const sumCountries = claimsRows
    .filter((r) => r.quarter === "2026-Q1" && r.counterpartySector === "A" && r.counterpartyCountry !== "5J" && r.valueUsdMillion !== null)
    .reduce((s, r) => s + (r.valueUsdMillion ?? 0), 0);
  console.log("claims 2026-Q1 国別合計(5J除く):", sumCountries, " vs 5J:", anchorClaims?.valueUsdMillion);

  console.log("\n=== 期間判定 ===");
  console.log("latestQuarterFromRows(claims):", latestQuarterFromRows(claimsRows));
  console.log("latestQuarterFromRows(liab):", latestQuarterFromRows(liabRows));
  const now = new Date();
  console.log("mostRecentEndedQuarter(now=" + now.toISOString() + "):", mostRecentEndedQuarter(now));
  console.log("resolvePublicationStatus(claims, now):", JSON.stringify(resolvePublicationStatus(claimsRows, now)));

  console.log("\n=== 直接 API 問い合わせで 2026-Q2 の有無を確認 (パーサ外での独立検証) ===");
  const q2res = await fetch(
    "https://stats.bis.org/api/v2/data/dataflow/BIS/WS_LBS_D_PUB/1.0/Q.S.C.A.TO1.A.5J.A.JP.A.US.N?format=csv&startPeriod=2026-Q2",
    { headers: { "User-Agent": "kabulab-cf-moneyflow-verify/1.0" } }
  );
  console.log("2026-Q2 direct query status:", q2res.status);

  console.log("\n=== toMoneyflowObservations サンプル ===");
  const obs = toMoneyflowObservations(claimsRows);
  console.log("US 2026-Q1 obs:", JSON.stringify(obs.find((o) => o.category === "US" && o.period === "2026-Q1")));
  console.log("5J が含まれていないか:", obs.some((o) => o.category === "5J"));
  const nanRows = claimsRows.filter((r) => r.valueUsdMillion === null);
  console.log("NaN行数(claims):", nanRows.length, "例:", JSON.stringify(nanRows.slice(0, 3)));

  console.log("\n=== 指標定義 ===");
  console.log(JSON.stringify(BIS_BANKING_INDICATORS.map((d) => ({ key: d.key, flowType: d.flowType, requirements: d.requirements, unit: d.unit })), null, 2));
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
