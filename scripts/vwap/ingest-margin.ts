import "dotenv/config";
// JPX週次PDF(銘柄別信用取引週末残高)を解析→ R2 margin/{week}.json + margin/weeks.json
// 実行: npx tsx scripts/ingest-margin.ts
import { fetchMargin } from "../../services/vwap-analysis/lib/margin.js";
import { r2Get, r2Put } from "./lib/r2.js";

async function main() {
  const { week, rows } = await fetchMargin();
  if (!week || !rows.length) throw new Error("margin parse empty");
  await r2Put(`margin/${week}.json`, JSON.stringify({ week, rows }));
  const wl = await r2Get("margin/weeks.json");
  const weeks: string[] = wl ? JSON.parse(wl) : [];
  if (!weeks.includes(week)) weeks.push(week);
  weeks.sort();
  await r2Put("margin/weeks.json", JSON.stringify(weeks));
  console.log(JSON.stringify({ week, count: rows.length }));
}
main();
