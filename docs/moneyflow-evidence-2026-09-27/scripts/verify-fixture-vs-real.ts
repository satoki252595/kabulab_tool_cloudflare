import { readFileSync } from "node:fs";
import {
  decodeBopRegionalZip,
  parseBopRegionalCsvText,
} from "/Users/satoki252595/projects/kabulab-cf/.claude/worktrees/wf_a6c4999f-a98-4/services/moneyflow/lib/sources/bop-regional.ts";

// fixture
const fixtureZip = new Uint8Array(
  readFileSync(
    "/Users/satoki252595/projects/kabulab-cf/.claude/worktrees/wf_a6c4999f-a98-4/services/moneyflow/lib/sources/fixtures/regbp-q-jp-sample.zip"
  )
);
const fixtureCsv = decodeBopRegionalZip(fixtureZip);
const fixtureParsed = parseBopRegionalCsvText(fixtureCsv);

// real (live fetch, full history)
const realRaw = readFileSync("/tmp/regbp_extract/regbp_q_jp.csv");
const realCsv = new TextDecoder("shift_jis").decode(realRaw);
const realParsed = parseBopRegionalCsvText(realCsv);

console.log("fixture periods:", fixtureParsed.periods.map((p) => p.label).join(","));
console.log("fixture rows:", fixtureParsed.rows.length);

// build lookup for real: code -> period label -> value
const realByCode = new Map<string, Map<string, number | null>>();
for (const row of realParsed.rows) {
  const m = new Map<string, number | null>();
  row.values.forEach((v, i) => m.set(realParsed.periods[i].label, v));
  realByCode.set(row.code, m);
}

let compared = 0;
let mismatches = 0;
let missingCodeInReal = 0;

for (const frow of fixtureParsed.rows) {
  const realValues = realByCode.get(frow.code);
  if (!realValues) {
    missingCodeInReal++;
    console.log("MISSING CODE IN REAL:", frow.code);
    continue;
  }
  frow.values.forEach((fv, i) => {
    const period = fixtureParsed.periods[i].label;
    const rv = realValues.get(period);
    compared++;
    const same =
      (fv === null && rv === null) ||
      (fv !== null && rv !== null && Math.abs(fv - rv) < 1e-6);
    if (!same) {
      mismatches++;
      console.log(`MISMATCH ${frow.code} ${period}: fixture=${fv} real=${rv}`);
    }
  });
}

console.log(`compared ${compared} cells across ${fixtureParsed.rows.length} rows`);
console.log(`mismatches: ${mismatches}, missing codes: ${missingCodeInReal}`);

let nullCells = 0;
for (const row of fixtureParsed.rows) {
  for (const v of row.values) if (v === null) nullCells++;
}
console.log("fixture null cells:", nullCells, "expected observations:", 1710 - nullCells);
