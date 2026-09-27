import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";

const bytes = new Uint8Array(readFileSync("/tmp/boj-sjpre-check.xlsx"));
const wb = XLSX.read(bytes, { type: "array" });
console.log("Sheet names:", wb.SheetNames);

function sheetTitleText(sheet, maxRows = 8) {
  const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1:A1");
  const parts = [];
  for (let r = range.s.r; r <= Math.min(range.s.r + maxRows, range.e.r); r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (cell && String(cell.v).trim() !== "") parts.push(`[${r},${c}]=${JSON.stringify(cell.v)}`);
    }
  }
  return parts.join(" | ");
}

for (const name of wb.SheetNames) {
  const sheet = wb.Sheets[name];
  const t = sheetTitleText(sheet, 3);
  console.log(`\n=== sheet "${name}" (first 3 rows) ===`);
  console.log(t.slice(0, 500));
}
