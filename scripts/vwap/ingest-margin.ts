import "dotenv/config";
// JPX週次PDF(銘柄別信用取引週末残高)を解析→ R2 margin/{week}.json + margin/weeks.json
// ルール6: 物理ファイルの一次取得物なので PDF 実体を Notion へ冪等記録する。
// 実行: npx tsx scripts/ingest-margin.ts
import {
  fetchMargin,
  marginArchiveInput,
} from "../../services/vwap-analysis/lib/margin.js";
import { recordPrimaryData } from "../../src/shared/notion-archive/index.js";
import { r2Get, r2Put } from "./lib/r2.js";

async function main() {
  const data = await fetchMargin();
  const { week, rows } = data;
  if (!week || !rows.length) throw new Error("margin parse empty");
  await r2Put(`margin/${week}.json`, JSON.stringify({ week, rows }));
  const wl = await r2Get("margin/weeks.json");
  const weeks: string[] = wl ? JSON.parse(wl) : [];
  if (!weeks.includes(week)) weeks.push(week);
  weeks.sort();
  await r2Put("margin/weeks.json", JSON.stringify(weeks));
  await recordPrimaryData(marginArchiveInput(data));
  console.info(JSON.stringify({ week, count: rows.length }));
}
main();
