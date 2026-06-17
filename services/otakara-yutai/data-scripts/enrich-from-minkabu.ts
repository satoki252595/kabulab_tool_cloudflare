/**
 * minkabu.jpから PER・配当利回り等の財務指標を取得し、stockFinancialsを補完するスクリプト
 *
 * minkabu.jp/stock/{code} ページの :record 属性に埋め込まれたJSONから抽出。
 * Yahoo Finance APIで取得できないPER・配当利回りを補完する用途。
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq, desc, isNull, and } from "drizzle-orm";
import "dotenv/config";
import { pgTable, serial, text, integer, real, timestamp, date, boolean } from "drizzle-orm/pg-core";

// インラインスキーマ
const stocks = pgTable("stocks", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
});
const stockFinancials = pgTable("stock_financials", {
  id: serial("id").primaryKey(),
  stockId: integer("stock_id").notNull(),
  price: real("price"), per: real("per"), pbr: real("pbr"),
  dividendYield: real("dividend_yield"), eps: real("eps"), bps: real("bps"),
  roe: real("roe"), roa: real("roa"), marketCap: real("market_cap"),
  ma5: real("ma_5"), ma25: real("ma_25"), ma75: real("ma_75"),
  rsi14: real("rsi_14"), macd: real("macd"), macdSignal: real("macd_signal"),
  yutaiYield: real("yutai_yield"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
  dataDate: date("data_date").notNull(),
});

/** minkabuページ内の :record JSON から財務指標を抽出 */
type MinkabuRecord = {
  per: number | null;
  pbr: number | null;
  dividendYield: number | null;
  eps: number | null;
  bps: number | null;
  roe: number | null;
  roa: number | null;
};

async function fetchMinkabuData(code: string): Promise<MinkabuRecord | null> {
  const url = `https://minkabu.jp/stock/${code}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "ja,en;q=0.9",
    },
  });
  if (!res.ok) return null;
  const html = await res.text();

  // :record="{...}" 属性からJSONを抽出
  const recordMatch = html.match(/:record="(\{[^"]+\})"/);
  if (!recordMatch) return null;

  // HTMLエンティティをデコード
  const jsonStr = recordMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

  try {
    const data = JSON.parse(jsonStr);
    return {
      per: parseFloat(data.per) || null,
      pbr: parseFloat(data.pbr) || null,
      dividendYield: parseFloat(data.dividend_yield) || null,
      eps: parseFloat(data.eps) || null,
      bps: parseFloat(data.bps) || null,
      roe: parseFloat(data.roe) || null,
      roa: parseFloat(data.roa) || null,
    };
  } catch {
    return null;
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL required");
  const sql = neon(databaseUrl);
  const db = drizzle(sql);

  // アクティブ銘柄の最新stockFinancialsを取得（PERがnullのもの）
  const allStocks = await db.select({
    id: stocks.id,
    code: stocks.code,
    name: stocks.name,
  }).from(stocks).where(eq(stocks.isActive, true));

  console.log(`=== minkabu財務データ補完 (${allStocks.length}銘柄) ===\n`);

  let updated = 0;
  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < allStocks.length; i++) {
    const stock = allStocks[i];

    if (i % 50 === 0 && i > 0) {
      console.log(`  [${i}/${allStocks.length}] 更新:${updated} 新規:${created} スキップ:${skipped} 失敗:${failed}`);
    }

    try {
      // 最新のstockFinancialsレコードを取得
      const [latestFin] = await db.select({ id: stockFinancials.id, per: stockFinancials.per, dividendYield: stockFinancials.dividendYield })
        .from(stockFinancials)
        .where(eq(stockFinancials.stockId, stock.id))
        .orderBy(desc(stockFinancials.fetchedAt))
        .limit(1);

      // stockFinancialsレコードがない場合 → minkabuから取得して新規作成
      if (!latestFin) {
        const minkabu = await fetchMinkabuData(stock.code);
        if (!minkabu) { failed++; await new Promise(r => setTimeout(r, 400)); continue; }

        await db.insert(stockFinancials).values({
          stockId: stock.id,
          per: minkabu.per,
          pbr: minkabu.pbr,
          dividendYield: minkabu.dividendYield,
          eps: minkabu.eps,
          bps: minkabu.bps,
          roe: minkabu.roe,
          roa: minkabu.roa,
          dataDate: new Date().toISOString().slice(0, 10),
        });
        created++;
        if (created <= 10) {
          console.log(`  🆕 ${stock.code} (${stock.name}): PER=${minkabu.per} 配当=${minkabu.dividendYield}%`);
        }
        await new Promise(r => setTimeout(r, 400));
        continue;
      }

      // PERと配当利回りの両方が既にある場合はスキップ
      if (latestFin.per !== null && latestFin.dividendYield !== null) {
        skipped++;
        continue;
      }

      // minkabuからデータ取得
      const minkabu = await fetchMinkabuData(stock.code);
      if (!minkabu) {
        failed++;
        await new Promise(r => setTimeout(r, 400));
        continue;
      }

      // NULLフィールドのみ更新
      const updates: Record<string, number> = {};
      if (latestFin.per === null && minkabu.per !== null) updates.per = minkabu.per;
      if (latestFin.dividendYield === null && minkabu.dividendYield !== null) updates.dividendYield = minkabu.dividendYield;

      if (Object.keys(updates).length === 0) {
        skipped++;
        continue;
      }

      await db.update(stockFinancials).set(updates).where(eq(stockFinancials.id, latestFin.id));
      updated++;

      if (updated <= 10) {
        console.log(`  ✅ ${stock.code} (${stock.name}): PER=${minkabu.per} 配当=${minkabu.dividendYield}%`);
      }
    } catch (e) {
      failed++;
      if (failed <= 5) {
        console.log(`  ❌ ${stock.code}: ${(e as Error).message?.substring(0, 60)}`);
      }
    }

    // レート制限（minkabuへの配慮）
    await new Promise(r => setTimeout(r, 400));
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`✅ 完了: ${updated}銘柄更新, ${created}銘柄新規作成, ${skipped}スキップ, ${failed}失敗`);
  console.log(`${"=".repeat(50)}`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
