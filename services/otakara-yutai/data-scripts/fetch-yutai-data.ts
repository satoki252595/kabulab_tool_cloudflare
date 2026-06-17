/**
 * 優待銘柄の全量データ取得スクリプト
 * minkabu.jp のランキングページから全月・全ジャンルのデータを取得
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq } from "drizzle-orm";
import "dotenv/config";
import { pgTable, serial, text, integer, real, timestamp, date, boolean } from "drizzle-orm/pg-core";

const yutaiGenres = pgTable("yutai_genres", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
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
const yutaiBenefits = pgTable("yutai_benefits", {
  id: serial("id").primaryKey(),
  stockId: integer("stock_id").references(() => stocks.id).notNull(),
  genreId: integer("genre_id").references(() => yutaiGenres.id).notNull(),
  description: text("description").notNull(),
  minShares: integer("min_shares").notNull(),
  recordMonth: integer("record_month").notNull(),
  estimatedValue: integer("estimated_value"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

const GENRE_MAP: Record<string, { name: string; slug: string; desc: string }> = {
  grocery: { name: "食品・飲料", slug: "food", desc: "食品、飲料、食料品" },
  syokujiken: { name: "食事券・外食", slug: "dining", desc: "食事券、外食割引" },
  rice: { name: "お米", slug: "rice", desc: "お米、米関連" },
  traffic_travel: { name: "交通・旅行", slug: "travel", desc: "交通、旅行、航空" },
  sport: { name: "レジャー・娯楽", slug: "leisure", desc: "スポーツ、レジャー、娯楽" },
  beauty_fashion: { name: "美容・ファッション", slug: "beauty", desc: "化粧品、衣料品" },
  lifestyle: { name: "暮らし・住まい", slug: "living", desc: "日用品、住居関連" },
  gift_card: { name: "ギフトカード", slug: "gift-card", desc: "ギフトカード" },
  quo_card: { name: "QUOカード", slug: "quo-card", desc: "QUOカード" },
  kinken: { name: "金券", slug: "voucher", desc: "金券、商品券" },
  catalog_gift: { name: "カタログギフト", slug: "catalog", desc: "カタログギフト" },
  point_service: { name: "ポイント", slug: "point", desc: "ポイントサービス" },
  financial_service: { name: "金融サービス", slug: "financial", desc: "銀行、証券、保険、金融サービス" },
  childcare_nursingcare_medical: { name: "医療・介護", slug: "medical", desc: "医療、介護、育児" },
  social_contribution: { name: "社会貢献", slug: "social", desc: "社会貢献、寄付" },
};

type StockEntry = {
  code: string;
  name: string;
  months: Set<number>;
  genres: Set<string>;
  description: string;
};

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "ja,en;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

/** HTMLから銘柄コードと名前を抽出 */
function extractStocks(html: string): Array<{ code: string; name: string; description: string }> {
  const results: Array<{ code: string; name: string; description: string }> = [];
  const seen = new Set<string>();

  // alt="XXXの株主優待" と /stock/XXXX/yutai を組み合わせ
  const altPattern = /alt="([^"]+)の株主優待"/g;
  const codePattern = /\/stock\/(\d{3}[0-9A-Z])\/yutai/g;

  // コードを全取得
  const codes: string[] = [];
  let m;
  while ((m = codePattern.exec(html)) !== null) {
    if (!seen.has(m[1])) {
      codes.push(m[1]);
      seen.add(m[1]);
    }
  }

  // 名前を全取得
  const names: string[] = [];
  while ((m = altPattern.exec(html)) !== null) {
    names.push(m[1]);
  }

  // メタdescriptionからも優待内容を取得
  const metaDesc = html.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i);
  const descriptions = new Map<string, string>();
  if (metaDesc) {
    // 【銘柄名（コード）最低投資金額：XX / 優待利回り：XX / 優待内容：XX】のパターン
    const entryPattern = /【([^（]+)（(\d{3}[0-9A-Z])）[^/]*\/[^/]*\/\s*優待内容：([^】]+)】/g;
    let em;
    while ((em = entryPattern.exec(metaDesc[1])) !== null) {
      descriptions.set(em[2], em[3].trim());
    }
  }

  // ユニークなコードだけ返す
  const uniqueCodes = [...new Set(codes)];
  for (let i = 0; i < uniqueCodes.length; i++) {
    const code = uniqueCodes[i];
    const name = i < names.length ? names[i] : `銘柄${code}`;
    const desc = descriptions.get(code) || "株主優待";
    results.push({ code, name, description: desc });
  }

  return results;
}

async function main() {
  console.log("🚀 優待銘柄データの全量取得を開始します\n");

  const allStocks = new Map<string, StockEntry>();

  // 1. 権利月別にデータ取得
  for (let month = 1; month <= 12; month++) {
    console.log(`📅 ${month}月の優待銘柄を取得中...`);
    try {
      const url = `https://minkabu.jp/yutai/popular_ranking/total?month=${month}`;
      const html = await fetchPage(url);
      const items = extractStocks(html);
      console.log(`   ${items.length}銘柄を検出`);

      for (const item of items) {
        if (allStocks.has(item.code)) {
          allStocks.get(item.code)!.months.add(month);
          if (item.description !== "株主優待") {
            allStocks.get(item.code)!.description = item.description;
          }
        } else {
          allStocks.set(item.code, {
            code: item.code,
            name: item.name,
            months: new Set([month]),
            genres: new Set(),
            description: item.description,
          });
        }
      }
      await new Promise(r => setTimeout(r, 800));
    } catch (e) {
      console.error(`   ❌ 失敗:`, e instanceof Error ? e.message : e);
    }
  }

  console.log(`\n✅ 権利月別: ユニーク ${allStocks.size}銘柄\n`);

  // 2. ジャンル別にデータ取得
  for (const [key, genre] of Object.entries(GENRE_MAP)) {
    console.log(`🏷️  ${genre.name} の銘柄を取得中...`);
    try {
      const url = `https://minkabu.jp/yutai/popular_ranking/${key}`;
      const html = await fetchPage(url);
      const items = extractStocks(html);
      console.log(`   ${items.length}銘柄を検出`);

      for (const item of items) {
        if (allStocks.has(item.code)) {
          allStocks.get(item.code)!.genres.add(genre.slug);
        } else {
          allStocks.set(item.code, {
            code: item.code,
            name: item.name,
            months: new Set(),
            genres: new Set([genre.slug]),
            description: item.description,
          });
        }
      }
      await new Promise(r => setTimeout(r, 800));
    } catch (e) {
      console.error(`   ❌ 失敗:`, e instanceof Error ? e.message : e);
    }
  }

  console.log(`\n✅ 全体: ユニーク ${allStocks.size}銘柄\n`);

  // 3. ジャンル未割当の銘柄は「その他」
  for (const stock of allStocks.values()) {
    if (stock.genres.size === 0) {
      stock.genres.add("other");
    }
  }

  // 4. DBにインポート
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const sql = neon(databaseUrl);
  const db = drizzle(sql);

  console.log("📦 DBにインポート中...\n");

  // ジャンル作成
  const genreCache = new Map<string, number>();
  const allGenreData = [
    ...Object.values(GENRE_MAP).map(g => ({ name: g.name, slug: g.slug, description: g.desc })),
    { name: "その他", slug: "other", description: "その他の株主優待" },
  ];
  for (const g of allGenreData) {
    const existing = await db.select().from(yutaiGenres).where(eq(yutaiGenres.slug, g.slug)).limit(1);
    if (existing.length > 0) {
      genreCache.set(g.slug, existing[0].id);
    } else {
      try {
        const [newG] = await db.insert(yutaiGenres).values(g).returning({ id: yutaiGenres.id });
        genreCache.set(g.slug, newG.id);
      } catch {
        const ex = await db.select().from(yutaiGenres).where(eq(yutaiGenres.slug, g.slug)).limit(1);
        if (ex.length > 0) genreCache.set(g.slug, ex[0].id);
      }
    }
  }
  console.log(`   ジャンル: ${genreCache.size}件`);

  // 銘柄 + 優待情報 作成
  let stockCount = 0;
  let benefitCount = 0;
  let skipCount = 0;

  for (const stock of allStocks.values()) {
    try {
      // 銘柄 find or create
      let stockId: number;
      const existing = await db.select().from(stocks).where(eq(stocks.code, stock.code)).limit(1);
      if (existing.length > 0) {
        stockId = existing[0].id;
      } else {
        const [newS] = await db.insert(stocks).values({
          code: stock.code,
          name: stock.name,
          market: "東証",
        }).returning({ id: stocks.id });
        stockId = newS.id;
        stockCount++;
      }

      // 優待情報を作成（月×ジャンル）
      for (const month of stock.months) {
        for (const genreSlug of stock.genres) {
          const genreId = genreCache.get(genreSlug);
          if (!genreId) continue;
          try {
            await db.insert(yutaiBenefits).values({
              stockId,
              genreId,
              description: stock.description,
              minShares: 100,
              recordMonth: month,
              estimatedValue: null,
            });
            benefitCount++;
          } catch {
            skipCount++;
          }
        }
      }
    } catch (e) {
      skipCount++;
    }
  }

  console.log("\n" + "=".repeat(50));
  console.log("📊 インポート結果:");
  console.log(`   ジャンル: ${genreCache.size}件`);
  console.log(`   新規銘柄: ${stockCount}件`);
  console.log(`   優待情報: ${benefitCount}件`);
  console.log(`   スキップ: ${skipCount}件`);
  console.log(`   全ユニーク銘柄: ${allStocks.size}件`);
  console.log("=".repeat(50));
}

main().catch((e) => { console.error("❌ Fatal:", e); process.exit(1); });
