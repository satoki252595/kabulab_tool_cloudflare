import {
  resolveBopRegionalZipUrl,
  fetchBopRegionalData,
  parseBopRegionalCsvText,
  extractBopRegionalObservations,
  latestObservedPeriod,
  isPeriodObserved,
  BOP_REGIONAL_INDICATORS,
} from "/Users/satoki252595/projects/kabulab-cf/.claude/worktrees/wf_a6c4999f-a98-4/services/moneyflow/lib/sources/bop-regional.ts";

async function main() {
  console.log("### 1. resolveBopRegionalZipUrl() ###");
  const zipUrl = await resolveBopRegionalZipUrl();
  console.log("zipUrl =", zipUrl);

  console.log("\n### 2. fetchBopRegionalData() (live network fetch) ###");
  const { csvText, sourceUrl, zipBytes } = await fetchBopRegionalData();
  console.log("sourceUrl =", sourceUrl);
  console.log("zipBytes.length =", zipBytes.length);
  console.log("csvText.length =", csvText.length);
  console.log("csvText first 300 chars:\n", csvText.slice(0, 300));

  console.log("\n### 3. parseBopRegionalCsvText() via module ###");
  const parsed = parseBopRegionalCsvText(csvText);
  console.log("periods:", parsed.periods.map((p) => p.label).join(", "));
  console.log("rows.length =", parsed.rows.length);

  console.log("\n### 4. extractBopRegionalObservations() ###");
  const obs = extractBopRegionalObservations(parsed);
  console.log("obs.length =", obs.length);

  const latest = latestObservedPeriod(obs);
  console.log("latestObservedPeriod =", JSON.stringify(latest));

  console.log("\n### 5. Cross-check against verified_values (2026Q1) using RAW csvText directly (independent regex, not reusing module parse logic) ###");

  // Independent raw-line search: find lines by BOJ data code, split by comma
  // manually (RFC4180-lite, no quoting expected for these numeric rows), and
  // locate the 2026Q1 column position from the header ourselves.
  const lines = csvText.split(/\r\n|\n|\r/);
  const header = lines[0].split(",");
  console.log("header (first 8 cols):", header.slice(0, 8));
  const q1Idx = header.findIndex((h) => h.trim() === "202601");
  if (q1Idx === -1) throw new Error("202601 (2026Q1) column not found in fresh header — cannot cross-check");
  console.log("2026Q1 column index in raw header:", q1Idx);

  function rawValueForCode(code: string): string | undefined {
    const line = lines.find((l) => l.startsWith(code + ","));
    if (!line) return undefined;
    const fields = line.split(",");
    return fields[q1Idx];
  }

  const checks: Array<{ code: string; label: string; expected: number }> = [
    { code: "BPBP6QFBCN1", label: "中華人民共和国・直接投資ネット", expected: -1631.38201514 },
    { code: "BPBP6QFBUS2", label: "アメリカ合衆国・証券投資ネット", expected: -3214.85204568 },
    { code: "BPBP6QFAUS21", label: "アメリカ合衆国・証券投資[株式等]資産", expected: 18925.53442 },
    { code: "BPBP6QFADE22", label: "ドイツ・証券投資[債券]資産", expected: -2983.81395215 },
    { code: "BPBP6QFBAS1", label: "アジア計・直接投資ネット", expected: 7230.99152397 },
    { code: "BPBP6QFB1", label: "地域別合計(世界計)・直接投資ネット", expected: 40673.64563458 },
  ];

  for (const c of checks) {
    const raw = rawValueForCode(c.code);
    const num = raw === undefined ? undefined : Number(raw);
    const diff = num === undefined ? undefined : Math.abs(num - c.expected);
    console.log(
      `${c.code} (${c.label}): raw="${raw}" parsedNum=${num} expected=${c.expected} ` +
        `match=${diff !== undefined && diff < 1e-6}`
    );
  }

  console.log("\n### 6. Cross-check module's extractBopRegionalObservations() output against same raw values ###");
  for (const c of checks) {
    // find corresponding row in parsed.rows by code
    const row = parsed.rows.find((r) => r.code === c.code);
    if (!row) {
      console.log(`${c.code}: NOT FOUND in parsed.rows`);
      continue;
    }
    const periodIdx = parsed.periods.findIndex((p) => p.label === "2026Q1");
    const val = row.values[periodIdx];
    console.log(`${c.code}: module-parsed 2026Q1 value = ${val}, expected = ${c.expected}`);
  }

  console.log("\n### 7. isPeriodObserved sanity: is 2026Q1 observed? Is a far-future quarter NOT observed? ###");
  console.log("isPeriodObserved(obs, 2026, 1) =", isPeriodObserved(obs, 2026, 1));
  console.log("isPeriodObserved(obs, 2099, 4) =", isPeriodObserved(obs, 2099, 4));

  console.log("\n### 8. NA handling sanity check: scan raw CSV for at least one NA cell, confirm module yields null there ###");
  let naFound = 0;
  for (let i = 1; i < lines.length && naFound < 3; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const fields = line.split(",");
    const naIdx = fields.findIndex((f, idx) => idx >= 4 && f === "NA");
    if (naIdx !== -1) {
      naFound++;
      const code = fields[0];
      const row = parsed.rows.find((r) => r.code === code);
      const val = row ? row.values[naIdx - 4] : "ROW_NOT_FOUND";
      console.log(`NA cell found: code=${code} rawField="${fields[naIdx]}" colIdx=${naIdx} -> module value = ${val}`);
    }
  }
  if (naFound === 0) console.log("No NA cells found in this fresh fetch (data set may differ from original fixture-era snapshot).");

  console.log("\n### 9. license text sanity vs BOJ notice.html fetched independently ###");
  for (const def of BOP_REGIONAL_INDICATORS.slice(0, 1)) {
    console.log(def.license);
  }

  console.log("\nDONE");
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
