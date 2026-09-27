import { readFileSync } from "node:fs";
import { extractInvestorTypeCsvLinks } from "/tmp/jpx-reverify/jpx-derivatives-investor.pre-fix.ts";

const html = readFileSync("/tmp/jpx-reverify/index_adversarial.html", "utf-8");
const links = extractInvestorTypeCsvLinks(html);
console.log("count (pre-fix code, adversarial html):", links.length);
console.log("links[0] (would-be 'latest'):", JSON.stringify(links[0]));
