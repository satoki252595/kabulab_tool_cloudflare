import { readFileSync } from "node:fs";
import { extractInvestorTypeCsvLinks } from "/Users/satoki252595/projects/kabulab-cf/.claude/worktrees/wf_a6c4999f-a98-8/services/moneyflow/lib/sources/jpx-derivatives-investor.ts";

const html = readFileSync("/tmp/jpx-reverify/index_adversarial.html", "utf-8");
const links = extractInvestorTypeCsvLinks(html);
console.log("count:", links.length);
for (const l of links) {
  console.log(JSON.stringify(l));
}
console.log("links[0] (would-be 'latest'):", JSON.stringify(links[0]));
