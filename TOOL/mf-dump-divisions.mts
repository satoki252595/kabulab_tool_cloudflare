/**
 * 現行単語帳 (台帳が正本) から labelJa -> notionColumn の対応だけを
 * TOOL/mf-vocab-divisions.json へ書き出す (mf-biztag-precompute.py 用)。
 * 読み取りのみ。実行手順は TOOL/README.md (受入済み Mac runtime から実行する)。
 */
import { writeFileSync } from "node:fs";
import { resolveActiveVocabulary } from "../services/yuho-quant/src/biztag/active-vocab.js";

const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
const { vocab } = await resolveActiveVocabulary(today, { dryRun: true });
const map: Record<string, string> = {};
for (const t of vocab.business) map[t.labelJa] = t.notionColumn;
const out = new URL("./mf-vocab-divisions.json", import.meta.url);
writeFileSync(out, JSON.stringify({ version: vocab.version, divisions: map }, null, 0));
const counts: Record<string, number> = {};
for (const v of Object.values(map)) counts[v] = (counts[v] ?? 0) + 1;
console.log(JSON.stringify({ version: vocab.version, terms: Object.keys(map).length, counts }));
