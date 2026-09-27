import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";

const bytes = new Uint8Array(readFileSync("/tmp/boj-sjpre-check.xlsx"));
const wb = XLSX.read(bytes, { type: "array" });

function dumpRows(sheetName, rStart, rEnd) {
  const sheet = wb.Sheets[sheetName];
  const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1:A1");
  console.log(`\n=== sheet "${sheetName}" range=${sheet["!ref"]} rows ${rStart}-${rEnd} ===`);
  for (let r = rStart; r <= rEnd; r++) {
    const rowVals = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (cell && cell.v !== undefined && cell.v !== "") {
        rowVals.push(`c${c}=${JSON.stringify(cell.v)}`);
      }
    }
    console.log(`row ${r}: ${rowVals.join(" | ")}`);
  }
}

// page1 = sheet "1" (flow), page2 = sheet "2"
dumpRows("1", 0, 12);
console.log("\n\n---- PAGE2 (sheet 2) ----");
dumpRows("2", 0, 12);
