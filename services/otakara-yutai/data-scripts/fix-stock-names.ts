/**
 * 銘柄名修正スクリプト
 * 「銘柄XXXX」になっている銘柄名をminkabuから正しい名前に更新
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq, like } from "drizzle-orm";
import "dotenv/config";
import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

const stocks = pgTable("stocks", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  market: text("market").notNull(),
  sector: text("sector"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL required");
  const sql = neon(databaseUrl);
  const db = drizzle(sql);

  // 名前が「銘柄XXXX」のものを取得
  const badNames = await db.select({ id: stocks.id, code: stocks.code, name: stocks.name })
    .from(stocks).where(like(stocks.name, "銘柄%"));

  console.log(`${badNames.length}件の銘柄名を修正します`);

  let fixed = 0;
  let failed = 0;

  for (const stock of badNames) {
    try {
      const res = await fetch(`https://minkabu.jp/stock/${stock.code}`, {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
      });
      const html = await res.text();

      // 複数パターンで名前を取得
      let name = "";
      const patterns = [
        /<h1[^>]*>([^<]+?)\s*\(\d{3}[0-9A-Z]\)/,
        /<title>([^<]+?)\s*\(\d{3}[0-9A-Z]\)/,
        /<title>([^<]+?)\s*[\|｜]/,
        /class="stock_name"[^>]*>([^<]+)/,
        /class="md_stockBoard_stockName"[^>]*>([^<]+)/,
      ];
      for (const p of patterns) {
        const m = html.match(p);
        if (m && m[1].trim() && !m[1].includes("みんかぶ") && m[1].trim().length < 50) {
          name = m[1].trim();
          break;
        }
      }

      // 市場情報も取得
      let market = "東証";
      if (html.includes("プライム")) market = "東証プライム";
      else if (html.includes("スタンダード")) market = "東証スタンダード";
      else if (html.includes("グロース")) market = "東証グロース";

      if (name) {
        await db.update(stocks)
          .set({ name, market })
          .where(eq(stocks.id, stock.id));
        fixed++;
        if (fixed % 100 === 0) console.log(`  ${fixed}/${badNames.length} 修正済み`);
      } else {
        failed++;
      }

      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      failed++;
    }
  }

  console.log(`\n完了: ${fixed}件修正, ${failed}件失敗`);
}

main().catch(e => { console.error(e); process.exit(1); });
