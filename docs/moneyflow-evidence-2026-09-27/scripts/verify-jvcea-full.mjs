import { readFileSync } from "node:fs";
import { extractText, getDocumentProxy } from "unpdf";
import { parseJvceaCryptoText } from "./services/moneyflow/lib/sources/jvcea-crypto.js";

const bytes = readFileSync("/tmp/jvcea-full.pdf");
const pdf = await getDocumentProxy(new Uint8Array(bytes));
const { text } = await extractText(pdf, { mergePages: false });
console.log("page count:", text.length);
for (let i = 0; i < text.length; i++) {
  console.log(`--- page ${i} (first 200 chars) ---`);
  console.log(text[i].slice(0, 300));
}
try {
  const rows = parseJvceaCryptoText(text);
  console.log("SUCCESS, rows:", rows.length);
} catch (e) {
  console.log("THREW:", e.message);
}
