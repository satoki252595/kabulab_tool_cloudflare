import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { downloadJpxListing } from "../src/shared/jpx/sectors.ts";
import fs from "node:fs/promises";

console.log("JPX 公式 XLS から東証全銘柄を取得中...");
const all = await downloadJpxListing();
console.log(`  total: ${all.length} 銘柄 (ETF/REIT/上場廃止予定含む)`);

// 国内株のみフィルタ: 市場・商品区分が「プライム」「スタンダード」「グロース」「TOKYO PRO Market」
// ETF/REIT/外国株/その他は除外
const STOCK_MARKETS = ["プライム（内国株式）", "スタンダード（内国株式）", "グロース（内国株式）", "TOKYO PRO Market"];
const stocks = all.filter(r => STOCK_MARKETS.includes(r.marketCategory));
console.log(`  国内株 (プライム/スタンダード/グロース/PRO): ${stocks.length}`);

const marketBreakdown = {};
for (const s of stocks) marketBreakdown[s.marketCategory] = (marketBreakdown[s.marketCategory] ?? 0) + 1;
console.log("  内訳:", marketBreakdown);

// core.stocks との差分
const sql = neon(process.env.DATABASE_URL);
const core = await sql`SELECT code FROM core.stocks WHERE is_active = true`;
const coreSet = new Set(core.map(r => r.code));
const inCore = stocks.filter(s => coreSet.has(s.code));
const notInCore = stocks.filter(s => !coreSet.has(s.code));
console.log(`  core.stocks に存在: ${inCore.length} 銘柄 (= テスト済)`);
console.log(`  core.stocks に未登録: ${notInCore.length} 銘柄 (= 追加テスト対象)`);

await fs.mkdir("/tmp/fm_validation", { recursive: true });
await fs.writeFile("/tmp/fm_validation/jpx_all.json", JSON.stringify(stocks));
await fs.writeFile("/tmp/fm_validation/jpx_untested.json", JSON.stringify(notInCore));
console.log(`\nSaved:`);
console.log(`  /tmp/fm_validation/jpx_all.json (${stocks.length} 銘柄)`);
console.log(`  /tmp/fm_validation/jpx_untested.json (${notInCore.length} 銘柄)`);
