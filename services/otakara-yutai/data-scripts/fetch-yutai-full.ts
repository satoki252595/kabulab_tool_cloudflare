/**
 * 優待銘柄 全量データ取得スクリプト (v2)
 *
 * Phase 1: minkabu.jp/yutai/search の全ページから銘柄コード一覧を取得
 * Phase 2: 各銘柄の個別ページ /stock/XXXX/yutai から詳細データを取得
 * Phase 3: 既存データを削除してクリーンインポート
 */
import { createD1HttpDb } from "../../../src/shared/db/d1-http-client.js";
import * as schema from "../src/db/schema.js";
import { yutaiGenres, yutaiBenefits, stocks } from "../src/db/schema.js";
import { sql, eq, inArray } from "drizzle-orm";
import { benefitKey } from "./benefit-key.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import "dotenv/config";

// Schema は src/db/schema.ts に集約済み (D1/SQLite 版 — ADR-0001)。
// 銘柄マスタ stocks は core_stocks の再 export、yutai_genres / yutai_benefits は
// otakara 固有テーブル。インラインの pgTable 定義は廃止した。

// ジャンルマッピング（minkabuのカテゴリ名→slug）
const GENRE_SLUG_MAP: Record<string, string> = {
  "食事券": "dining", "食品": "food", "飲料": "food", "お米": "rice",
  "交通・旅行": "travel", "旅行": "travel", "交通": "travel",
  "スポーツ": "leisure", "レジャー施設": "leisure", "娯楽": "leisure", "映画": "leisure",
  "美容": "beauty", "ファッション": "beauty", "化粧品": "beauty",
  "暮らし": "living", "日用品": "living", "住まい": "living",
  "ギフトカード": "gift-card", "ギフト券": "gift-card",
  "QUOカード": "quo-card", "クオカード": "quo-card",
  "金券": "voucher", "商品券": "voucher",
  "カタログギフト": "catalog", "特産品": "catalog",
  "ポイント": "point",
  "金融": "financial", "銀行": "financial", "保険": "financial", "証券": "financial",
  "クレジット": "financial", "リース": "financial", "FX": "financial", "信託": "financial",
  "医療": "medical", "介護": "medical", "ヘルスケア": "medical",
  "社会貢献": "social", "寄付": "social",
};

function guessGenreSlug(title: string, description: string): string {
  const text = title + " " + description;
  for (const [keyword, slug] of Object.entries(GENRE_SLUG_MAP)) {
    if (text.includes(keyword)) return slug;
  }
  if (text.match(/食|グルメ|弁当|菓子/)) return "food";
  if (text.match(/割引券|優待券|施設利用/)) return "voucher";
  if (text.match(/自社製品|自社商品/)) return "living";
  return "other";
}

type BenefitDetail = {
  minShares: number;
  description: string;
  notes: string;
};

type StockYutaiData = {
  code: string;
  name: string;
  market: string;
  recordMonths: number[];
  category: string;
  benefits: BenefitDetail[];
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

/** Phase 1: 全銘柄コードを検索ページから収集 */
async function collectAllStockCodes(): Promise<string[]> {
  const allCodes = new Set<string>();
  let page = 1;
  let emptyCount = 0;

  while (emptyCount < 3) {
    try {
      const url = `https://minkabu.jp/yutai/search?page=${page}`;
      const html = await fetchPage(url);
      // 数字 4 桁 + JPX 英数字コード (例: 130A) の両方を拾う (cf. src/shared/jpx)
      const codes = [...html.matchAll(/\/stock\/(\d{3}[0-9A-Z])\/yutai/g)].map(m => m[1]);
      const unique = [...new Set(codes)];

      if (unique.length === 0) {
        emptyCount++;
      } else {
        emptyCount = 0;
        for (const c of unique) allCodes.add(c);
      }

      if (page % 10 === 0) {
        console.log(`  Page ${page}: 累計 ${allCodes.size}銘柄`);
      }

      page++;
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.error(`  Page ${page} エラー:`, e instanceof Error ? e.message : e);
      emptyCount++;
    }
  }

  return [...allCodes].sort();
}

/** Phase 2: 個別銘柄ページから詳細データ取得 */
async function fetchStockDetail(code: string): Promise<StockYutaiData | null> {
  try {
    const html = await fetchPage(`https://minkabu.jp/stock/${code}/yutai`);

    // 銘柄名（複数パターンで取得）
    let name = `銘柄${code}`;
    const namePatterns = [
      /class="md_stockBoard_stockName"[^>]*>([^<]+)/,
      /class="stock_name"[^>]*>([^<]+)/,
      /<h1[^>]*>([^<]+?)\s*\(\d{3}[0-9A-Z]\)/,
      /<title>([^<]+?)(?:\s*の株主優待|\s*\|)/,
    ];
    for (const pat of namePatterns) {
      const m = html.match(pat);
      if (m && m[1].trim() && !m[1].includes("みんかぶ") && m[1].trim().length < 50) {
        name = m[1].trim();
        break;
      }
    }

    // 市場
    let market = "東証";
    if (html.includes("プライム")) market = "東証プライム";
    else if (html.includes("スタンダード")) market = "東証スタンダード";
    else if (html.includes("グロース")) market = "東証グロース";

    // 権利確定月（<td>の中身を取得）
    const recordMonths: number[] = [];
    const monthPatterns = [
      /優待権利確定月<\/th>\s*<td[^>]*>([^<]+)/i,
      /優待権利確定月：<span[^>]*>([^<]+)/i,
    ];
    for (const pat of monthPatterns) {
      const monthMatch = html.match(pat);
      if (monthMatch) {
        const months = monthMatch[1].match(/(\d{1,2})月/g);
        if (months) {
          for (const m of months) {
            const num = parseInt(m.replace("月", ""), 10);
            if (num >= 1 && num <= 12 && !recordMonths.includes(num)) recordMonths.push(num);
          }
        }
        if (recordMonths.length > 0) break;
      }
    }

    // カテゴリ/タイトル
    const titleMatch = html.match(/<h3[^>]*class="ulno"[^>]*>([^<]+)/);
    const category = titleMatch ? titleMatch[1].trim() : "株主優待";

    // 株数別優待テーブル（複数テーブルに分かれている場合がある）
    const benefits: BenefitDetail[] = [];
    const allTables = [...html.matchAll(/<table[^>]*class="md_table[^"]*"[^>]*>([\s\S]*?)<\/table>/gi)];

    for (const tableMatch of allTables) {
      const tableHtml = tableMatch[1];
      // テーブルに「必要株数」ヘッダーがあるか確認（優待テーブルのみ対象）
      if (!tableHtml.includes("必要株数") && !tableHtml.match(/\d+株以上/)) continue;

      const rows = tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
      let lastNotes = "";

      for (const row of rows) {
        const cells: string[] = [];
        const cellMatches = row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi);
        for (const cell of cellMatches) {
          cells.push(cell[1].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "").trim());
        }

        // ヘッダー行スキップ
        if (cells[0] === "必要株数" || cells.length < 2) continue;

        // 株数パース
        const sharesMatch = cells[0]?.match(/(\d[\d,]+)\s*株/);
        if (!sharesMatch) continue;
        const minShares = parseInt(sharesMatch[1].replace(/,/g, ""), 10);

        const description = cells[1] || "";
        const notes = cells[2] || lastNotes;
        if (cells[2]) lastNotes = cells[2];

        benefits.push({ minShares, description, notes });
      }
    }

    // テーブルがない場合、ページ内の優待情報テキストから取得
    if (benefits.length === 0) {
      benefits.push({
        minShares: 100,
        description: category,
        notes: "",
      });
    }

    if (recordMonths.length === 0) {
      return null; // 権利月不明はスキップ
    }

    return { code, name, market, recordMonths, category, benefits };
  } catch (e) {
    console.error(`  ${code} 取得失敗:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/** 退避した解釈 (step3 の産物)。key は benefitKey(銘柄コード, description)。 */
type CarriedInterpretation = {
  shortSummary: string | null;
  estimatedValue: number | null;
};

/**
 * 全削除の前に short_summary / estimated_value を退避する。
 *
 * どちらも step3 のローカル LLM 解釈でしか作れず、このスクリプトの INSERT は
 * 値を入れない。退避しないと再フェッチのたびに全銘柄の解釈が消える。
 */
async function carryOverInterpretations(
  db: ReturnType<typeof createD1HttpDb<typeof schema>>,
): Promise<Map<string, CarriedInterpretation>> {
  const rows = await db
    .select({
      code: stocks.code,
      description: yutaiBenefits.description,
      shortSummary: yutaiBenefits.shortSummary,
      estimatedValue: yutaiBenefits.estimatedValue,
    })
    .from(yutaiBenefits)
    .innerJoin(stocks, eq(stocks.id, yutaiBenefits.stockId));

  const carried = new Map<string, CarriedInterpretation>();
  for (const row of rows) {
    if (row.shortSummary == null && row.estimatedValue == null) continue;
    // 同一キーが複数行 (権利月違い) ある。解釈は文言単位なのでどれでも同じ。
    carried.set(benefitKey(row.code, row.description), {
      shortSummary: row.shortSummary,
      estimatedValue: row.estimatedValue,
    });
  }
  return carried;
}

/** Phase 3: DBにインポート */
async function importToDb(allData: StockYutaiData[]) {
  const db = createD1HttpDb(schema);

  // 既存の優待データのみ削除する。
  // core.stocks は東証内国普通株 (~3,700) の共有母集団なので **削除しない**。
  //
  // is_yutai は「事前に全 false → ループで true」だと D1 HTTP クライアントが
  // トランザクション非対応のためループ途中で落ちると全優待が消える窓が
  // できる。よって upsert を全件成功させた **後** に、今回スクレイプできた
  // code の補集合だけ false へ落とす後処理方式にする (CLAUDE.md ルール2)。
  // 全削除の前に、**作り直せない派生値**を退避する。
  // short_summary / estimated_value は step3 (ローカル LLM 解釈) の産物で、
  // このスクリプトの INSERT では値を入れない。退避せずに消すと、step3 を
  // 人手で回し終わるまで公開面の優待内容が全銘柄で空になる
  // (掲載文 description は公開面に出せないため代わりが無い)。
  // キーは (銘柄コード, description) の内容アドレスなので、文言が変わらない
  // 限り再フェッチ後も同じ解釈に戻せる。
  const carried = await carryOverInterpretations(db);
  console.log(`  既存の解釈を退避: ${carried.size}件`);

  console.log("  既存の優待データを削除中 (core.stocks は保持)...");
  await db.delete(yutaiBenefits);
  await db.delete(yutaiGenres);

  // ジャンル作成
  const GENRES = [
    { name: "食品・飲料", slug: "food", description: "食品、飲料、食料品" },
    { name: "食事券・外食", slug: "dining", description: "食事券、外食割引、レストラン" },
    { name: "お米", slug: "rice", description: "お米、米関連" },
    { name: "交通・旅行", slug: "travel", description: "交通、旅行、航空、鉄道" },
    { name: "レジャー・娯楽", slug: "leisure", description: "スポーツ、レジャー、映画、娯楽" },
    { name: "美容・ファッション", slug: "beauty", description: "化粧品、衣料品、ファッション" },
    { name: "暮らし・住まい", slug: "living", description: "日用品、住居関連、自社製品" },
    { name: "ギフトカード", slug: "gift-card", description: "ギフトカード" },
    { name: "QUOカード", slug: "quo-card", description: "QUOカード" },
    { name: "金券・商品券", slug: "voucher", description: "金券、商品券、割引券" },
    { name: "カタログギフト", slug: "catalog", description: "カタログギフト、特産品" },
    { name: "ポイント", slug: "point", description: "ポイントサービス" },
    { name: "金融サービス", slug: "financial", description: "銀行、証券、保険、金融サービス" },
    { name: "医療・介護", slug: "medical", description: "医療、介護、ヘルスケア" },
    { name: "社会貢献", slug: "social", description: "社会貢献、寄付" },
    { name: "その他", slug: "other", description: "その他の株主優待" },
  ];

  const genreCache = new Map<string, number>();
  for (const g of GENRES) {
    const [row] = await db.insert(yutaiGenres).values(g).returning({ id: yutaiGenres.id });
    genreCache.set(g.slug, row.id);
  }
  console.log(`  ジャンル: ${genreCache.size}件作成`);

  let stockCount = 0;
  let benefitCount = 0;
  const scrapedCodes: string[] = [];
  const failedCodes: string[] = [];

  for (const data of allData) {
    try {
      // JPX 母集団 seed で既に存在する可能性があるため upsert。
      // is_yutai=true を立て、name/market は minkabu 由来で更新する。
      const [stockRow] = await db.insert(stocks).values({
        code: data.code,
        name: data.name,
        market: data.market,
        isYutai: true,
      }).onConflictDoUpdate({
        target: stocks.code,
        set: {
          name: sql`excluded.name`,
          market: sql`excluded.market`,
          isYutai: sql`true`,
          updatedAt: sql`(unixepoch())`,
        },
      }).returning({ id: stocks.id });
      stockCount++;
      scrapedCodes.push(data.code);

      const genreSlug = guessGenreSlug(data.category, data.benefits.map(b => b.description).join(" "));
      const genreId = genreCache.get(genreSlug) ?? genreCache.get("other")!;

      // 各権利月 × 各株数条件で優待レコードを作成
      for (const month of data.recordMonths) {
        for (const benefit of data.benefits) {
          const desc = benefit.notes
            ? `${benefit.description}${benefit.notes ? "\n" + benefit.notes.substring(0, 200) : ""}`
            : benefit.description;

          const stored = desc.substring(0, 500);
          // 同じ (銘柄, 文言) なら退避した解釈をそのまま戻す。新規/文言変更は
          // 未解釈のまま入り、step3 の対象になる。
          const previous = carried.get(benefitKey(data.code, stored));
          await db.insert(yutaiBenefits).values({
            stockId: stockRow.id,
            genreId,
            description: stored,
            shortSummary: previous?.shortSummary ?? null,
            minShares: benefit.minShares,
            recordMonth: month,
            estimatedValue: previous?.estimatedValue ?? null,
          });
          benefitCount++;
        }
      }
    } catch (e) {
      // 個別銘柄の失敗は握り潰さず記録する (CLAUDE.md ルール2: オペレータ通知)
      failedCodes.push(data.code);
      console.error(
        `  [warn] ${data.code} の取り込み失敗:`,
        e instanceof Error ? e.message : e
      );
    }
  }

  // 全件失敗 = スクレイプ/DB が壊れている。後処理で全優待を false に
  // 落とすと otakara が全滅するので早期 throw する (ルール2: 早期失敗)。
  if (scrapedCodes.length === 0) {
    throw new Error(
      `優待銘柄を 1 件も取り込めませんでした (失敗 ${failedCodes.length} 件)。` +
        `minkabu スクレイプか DB 接続を確認してください。`
    );
  }

  // 後処理: 今回スクレイプできなかった既存 is_yutai 銘柄を false へ。
  // (優待を廃止した銘柄が翌月 false に落ちる。core_stocks 行自体は残す)
  //
  // D1 の bind 上限 (100/文) のため notInArray(全スクレイプコード ~1,600) は
  // 使えない。is_yutai=true を読み出して in-memory で差集合を取り、ID で
  // 分割更新する (monthly.ts と同じ D1 方言パターン)。
  const scrapedSet = new Set(scrapedCodes);
  const currentYutai = await db
    .select({ id: stocks.id, code: stocks.code })
    .from(stocks)
    .where(eq(stocks.isYutai, true));
  const toFalseIds = currentYutai
    .filter((s) => !scrapedSet.has(s.code))
    .map((s) => s.id);
  const RESET_CHUNK = 80;
  for (let i = 0; i < toFalseIds.length; i += RESET_CHUNK) {
    await db
      .update(stocks)
      .set({ isYutai: false, updatedAt: sql`(unixepoch())` })
      .where(inArray(stocks.id, toFalseIds.slice(i, i + RESET_CHUNK)));
  }

  if (failedCodes.length > 0) {
    console.warn(
      `  取り込み失敗 ${failedCodes.length} 件: ${failedCodes.slice(0, 30).join(", ")}${
        failedCodes.length > 30 ? " ..." : ""
      }`
    );
  }

  return { stockCount, benefitCount };
}

// ===== Main =====
async function main() {
  console.log("🚀 優待銘柄データ全量取得 v2\n");

  // Phase 1: 銘柄コード収集（キャッシュ利用可）
  const CACHE_FILE = "/tmp/yutai-codes-cache.json";
  let codes: string[];
  if (existsSync(CACHE_FILE)) {
    codes = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    console.log(`📋 Phase 1: キャッシュから ${codes.length}銘柄のコードを読込\n`);
  } else {
    console.log("📋 Phase 1: 全銘柄コードを収集中...");
    codes = await collectAllStockCodes();
    writeFileSync(CACHE_FILE, JSON.stringify(codes));
    console.log(`\n✅ ${codes.length}銘柄のコードを収集\n`);
  }

  // Phase 2: 個別ページから詳細取得
  console.log("📊 Phase 2: 各銘柄の詳細データを取得中...");
  const allData: StockYutaiData[] = [];
  let progress = 0;

  for (const code of codes) {
    const data = await fetchStockDetail(code);
    if (data) {
      allData.push(data);
    }
    progress++;
    if (progress % 50 === 0) {
      console.log(`  ${progress}/${codes.length} (成功: ${allData.length})`);
    }
    await new Promise(r => setTimeout(r, 400)); // レート制限
  }
  console.log(`\n✅ ${allData.length}銘柄の詳細データを取得\n`);

  // データ品質サマリー
  const multiMonth = allData.filter(d => d.recordMonths.length > 1).length;
  const multiShare = allData.filter(d => d.benefits.length > 1).length;
  console.log(`  複数権利月: ${multiMonth}銘柄`);
  console.log(`  複数株数条件: ${multiShare}銘柄`);
  console.log(`  サンプル: ${allData[0]?.name} (${allData[0]?.code})`);
  if (allData[0]) {
    console.log(`    権利月: ${allData[0].recordMonths.join(",")}`);
    for (const b of allData[0].benefits) {
      console.log(`    ${b.minShares}株: ${b.description.substring(0, 50)}`);
    }
  }

  // Phase 3: DB import
  console.log("\n📦 Phase 3: DBにインポート中...");
  const result = await importToDb(allData);

  console.log("\n" + "=".repeat(60));
  console.log("📊 最終結果:");
  console.log(`  銘柄数: ${result.stockCount}`);
  console.log(`  優待レコード数: ${result.benefitCount}`);
  console.log(`  複数権利月の銘柄: ${multiMonth}`);
  console.log(`  複数株数条件の銘柄: ${multiShare}`);
  console.log("=".repeat(60));
}

main().catch(e => { console.error("❌ Fatal:", e); process.exit(1); });
