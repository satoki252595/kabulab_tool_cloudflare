/**
 * 優待銘柄 全量データ取得スクリプト (v2)
 *
 * Phase 1: minkabu.jp/yutai/search の全ページから銘柄コード一覧を取得
 * Phase 2: 各銘柄の個別ページ /stock/XXXX/yutai から詳細データを取得
 * Phase 3: 母集団 (core_stocks の active かつ equity) の銘柄の優待を作り直す。
 *          母集団外の銘柄の優待には触らない。D1 への書き込みと、削除の前に止める
 *          条件は yutai-full-import.ts (値のテストは src/tests/yutai-full-import.test.ts)
 */
import { createD1HttpDb } from "../../../src/shared/db/d1-http-client.js";
import { log } from "../../../src/shared/log.js";
import * as schema from "../src/db/schema.js";
import {
  importYutaiFull,
  type BenefitDetail,
  type StockYutaiData,
} from "./yutai-full-import.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import "dotenv/config";

// Schema は src/db/schema.ts に集約済み (D1/SQLite 版 — ADR-0001)。
// 銘柄マスタ stocks は core_stocks の再 export、yutai_genres / yutai_benefits は
// otakara 固有テーブル。インラインの pgTable 定義は廃止した。

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
        log.info(`  Page ${page}: 累計 ${allCodes.size}銘柄`);
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

// ===== Main =====
async function main() {
  log.info("🚀 優待銘柄データ全量取得 v2\n");

  // Phase 1: 銘柄コード収集（キャッシュ利用可）
  const CACHE_FILE = "/tmp/yutai-codes-cache.json";
  let codes: string[];
  if (existsSync(CACHE_FILE)) {
    codes = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    log.info(`📋 Phase 1: キャッシュから ${codes.length}銘柄のコードを読込\n`);
  } else {
    log.info("📋 Phase 1: 全銘柄コードを収集中...");
    codes = await collectAllStockCodes();
    writeFileSync(CACHE_FILE, JSON.stringify(codes));
    log.info(`\n✅ ${codes.length}銘柄のコードを収集\n`);
  }

  // Phase 2: 個別ページから詳細取得
  log.info("📊 Phase 2: 各銘柄の詳細データを取得中...");
  const allData: StockYutaiData[] = [];
  let progress = 0;

  for (const code of codes) {
    const data = await fetchStockDetail(code);
    if (data) {
      allData.push(data);
    }
    progress++;
    if (progress % 50 === 0) {
      log.info(`  ${progress}/${codes.length} (成功: ${allData.length})`);
    }
    await new Promise(r => setTimeout(r, 400)); // レート制限
  }
  log.info(`\n✅ ${allData.length}銘柄の詳細データを取得\n`);

  // データ品質サマリー
  const multiMonth = allData.filter(d => d.recordMonths.length > 1).length;
  const multiShare = allData.filter(d => d.benefits.length > 1).length;
  log.info(`  複数権利月: ${multiMonth}銘柄`);
  log.info(`  複数株数条件: ${multiShare}銘柄`);
  log.info(`  サンプル: ${allData[0]?.name} (${allData[0]?.code})`);
  if (allData[0]) {
    log.info(`    権利月: ${allData[0].recordMonths.join(",")}`);
    for (const b of allData[0].benefits) {
      log.info(`    ${b.minShares}株: ${b.description.substring(0, 50)}`);
    }
  }

  // Phase 3: DB import
  log.info("\n📦 Phase 3: DBにインポート中...");
  const result = await importYutaiFull(createD1HttpDb(schema), allData);

  log.info("\n" + "=".repeat(60));
  log.info("📊 最終結果:");
  log.info(`  銘柄数: ${result.stockCount}`);
  log.info(`  優待レコード数: ${result.benefitCount}`);
  console.info(`  母集団に無く飛ばした銘柄 (既存の優待行は保持): ${result.outOfUniverse.length}`);
  console.info(`  取得できず優待行を消した銘柄: ${result.abolishedCount}`);
  console.info(`  戻せなかった解釈: ${result.droppedInterpretations}`);
  console.info(`  取り込み失敗: ${result.failedCodes.length}`);
  log.info(`  複数権利月の銘柄: ${multiMonth}`);
  log.info(`  複数株数条件の銘柄: ${multiShare}`);
  log.info("=".repeat(60));
}

main().catch(e => { console.error("❌ Fatal:", e); process.exit(1); });
