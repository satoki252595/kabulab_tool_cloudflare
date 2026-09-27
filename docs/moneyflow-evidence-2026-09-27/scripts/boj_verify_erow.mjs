import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";

const bytes = new Uint8Array(readFileSync("/tmp/boj-sjpre-check.xlsx"));
const wb = XLSX.read(bytes, { type: "array" });

function findRowByCode(sheetName, code, codeCol) {
  const sheet = wb.Sheets[sheetName];
  const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1:A1");
  for (let r = range.s.r; r <= range.e.r; r++) {
    const cell = sheet[XLSX.utils.encode_cell({ r, c: codeCol })];
    if (cell && String(cell.v).trim() === code) return r;
  }
  return -1;
}

function dumpRow(sheetName, r) {
  const sheet = wb.Sheets[sheetName];
  const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1:A1");
  const vals = [];
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = sheet[XLSX.utils.encode_cell({ r, c })];
    if (cell && cell.v !== undefined && cell.v !== "") vals.push(`c${c}=${JSON.stringify(cell.v)}`);
  }
  return vals.join(" | ");
}

// FLOW table (sheet 1 = page1, sheet 2 = page2). rowCode column in page1 = col2 (per row11 dump earlier "c2=A")
const flowRowE1 = findRowByCode("1", "E", 2);
console.log("FLOW page1 row for E:", flowRowE1, dumpRow("1", flowRowE1));
console.log("FLOW page2 row for E (same r):", dumpRow("2", flowRowE1));

// STOCK table sheets 19/20
const stockRowE1 = findRowByCode("19", "E", 2);
console.log("\nSTOCK page1(sheet19) row for E:", stockRowE1, dumpRow("19", stockRowE1));
console.log("STOCK page2(sheet20) row for E (same r):", dumpRow("20", stockRowE1));

// Also print title rows of sheet 19/20 to confirm headers align same pattern
console.log("\nsheet19 header rows 0-11:");
for (let r=0;r<=11;r++) console.log(r, dumpRow("19", r));
console.log("\nsheet20 header rows 0-11:");
for (let r=0;r<=11;r++) console.log(r, dumpRow("20", r));
