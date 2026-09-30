/**
 * 優待銘柄 全量データ取得スクリプト (v2)
 *
 * Phase 1: minkabu.jp/yutai/search の全ページから銘柄コード一覧を取得
 * Phase 2: 各銘柄の個別ページ /stock/XXXX/yutai から詳細データを取得
 * Phase 3: 母集団 (core_stocks の active かつ equity) の銘柄の優待を作り直す。
 *          母集団外の銘柄の優待には触らない。D1 への書き込みと、削除の前に止める
 *          条件は yutai-full-import.ts (値のテストは src/tests/yutai-full-import.test.ts)
 */
import { createD1HttpBatchSender, createD1HttpDb } from "../../../src/shared/db/d1-http-client.js";
import { log } from "../../../src/shared/log.js";
import * as schema from "../src/db/schema.js";
import {
  importYutaiFull,
  type BenefitDetail,
  type StockYutaiData,
} from "./yutai-full-import.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { pathToFileURL } from "node:url";
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

/**
 * Phase 1: 全銘柄コードを検索ページから収集 (テスト用に fetcher 注入可)。
 *
 * 取得失敗は空ページの証拠ではない。例外を投げて run を止め、部分リストを
 * 完成扱いにしない (未確定の欠落を廃止として消さない。キャッシュも書かない)。
 * 連続 3 空ページの打ち切りは、正常取得の空ページだけ数える。
 */
export async function collectAllStockCodes(
  fetchListPage: (page: number) => Promise<string> = (p) =>
    fetchPage(`https://minkabu.jp/yutai/search?page=${p}`),
): Promise<string[]> {
  const allCodes = new Set<string>();
  let page = 1;
  let emptyCount = 0;

  while (emptyCount < 3) {
    let html: string;
    try {
      html = await fetchListPage(page);
    } catch (e) {
      throw new Error(
        `検索ページの取得に失敗したため中断します (page=${page}。` +
          `部分リストを完成扱い・キャッシュしません): ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
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
  }

  return [...allCodes].sort();
}

/**
 * Phase 2: 個別銘柄ページから詳細データ取得。
 * 限定 READ (切詰め対応の突合せ等) のため export する。呼出側で 400ms 以上の
 * 間隔を空けること (本ファイル main と同じ rate 制限)。
 * `unknown` は取得・パースの未確定 (廃止ではない)。落とさず run を止めること。
 */
/**
 * 個別ページ 1 件の取得・パース結果。`unknown` は「廃止」ではない
 * (取得失敗・表の月が無い等の未確定)。呼び出し側は unknown を黙って
 * 落とさず、 run を止める (`collectStockDetails`)。廃止の正信号は
 * Phase 1 の一覧に載らないこと (import 側の abolish 経路) だけ。
 */
export type StockDetailResult =
  | { status: "ok"; data: StockYutaiData }
  | { status: "unknown"; code: string; reason: string };

export async function fetchStockDetail(code: string): Promise<StockDetailResult> {
  let html: string;
  try {
    html = await fetchPage(`https://minkabu.jp/stock/${code}/yutai`);
  } catch (e) {
    const reason = `fetch: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160);
    console.error(`  ${code} 取得失敗:`, reason);
    return { status: "unknown", code, reason };
  }
  return parseStockDetail(code, html);
}

/**
 * Phase 2 の収集。全件 ok のときだけ `StockYutaiData[]` を返す。
 * 1 件でも unknown があれば import の前に throw する (書く前に止める。
 * unknown を廃止として削除しない)。`fetchDetail` 注入でテスト可能。
 */
export async function collectStockDetails(
  codes: readonly string[],
  fetchDetail: (code: string) => Promise<StockDetailResult>,
): Promise<StockYutaiData[]> {
  const allData: StockYutaiData[] = [];
  const unknowns: string[] = [];
  let progress = 0;
  for (const code of codes) {
    const r = await fetchDetail(code);
    if (r.status === "unknown") unknowns.push(`${r.code} (${r.reason})`);
    else allData.push(r.data);
    progress++;
    if (progress % 50 === 0) {
      log.info(`  ${progress}/${codes.length} (成功: ${allData.length}, 未確定: ${unknowns.length})`);
    }
    await new Promise((r) => setTimeout(r, 400)); // レート制限
  }
  if (unknowns.length > 0) {
    throw new Error(
      `個別ページの取得・パースに未確定 (UNKNOWN) が ${unknowns.length} 件あります。` +
        `未確定を廃止として削除しないため、取り込みません: ${unknowns.slice(0, 20).join(", ")}` +
        `${unknowns.length > 20 ? " ..." : ""}`,
    );
  }
  return allData;
}

/** 「3月」「3月,9月」→ [3] / [3, 9]。1〜12 以外は落とす。 */
function parseMonths(text: string): number[] {
  const months: number[] = [];
  for (const m of text.match(/(\d{1,2})月/g) ?? []) {
    const num = parseInt(m.replace("月", ""), 10);
    if (num >= 1 && num <= 12 && !months.includes(num)) months.push(num);
  }
  return months;
}

/**
 * 個別ページ HTML の純パース (fetch しない。テストと offline rerender 用に export)。
 *
 * 権利月は h3 セクション (優待の表) ごとの「優待権利確定月」span から取り、
 * その表の優待にだけ付ける (表ローカル。h3 セクションが、配下の全優待に月を
 * 明示する親スコープ)。ページ上部の valuations の union を全部の表に被せない
 * (旧形は 8022 の 3 月限定の表に 9 月行 37956 を誤合成した)。
 * 表があるのに月 span が無いセクション、表が無いページは `unknown`
 * (月の推測・100 株の仮優待フォールバックはしない。廃止の意味では使わない)。
 */
export function parseStockDetail(code: string, html: string): StockDetailResult {
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

  // カテゴリ/タイトル
  const titleMatch = html.match(/<h3[^>]*class="ulno"[^>]*>([^<]+)/);
  const category = titleMatch ? titleMatch[1].trim() : "株主優待";

  // h3 セクションごとに (見出し, 表ローカルの月, 株数別優待テーブル) を取る。
  const benefits: BenefitDetail[] = [];
  const sections = html.split(/<h3[^>]*class="ulno"[^>]*>/i);
  // 最初の h3 より前の優待テーブルは月を帰属できない (unknown。落とさない)。
  const preTables = sections[0].match(/<table[^>]*class="md_table[^"]*"[^>]*>([\s\S]*?)<\/table>/gi) ?? [];
  if (preTables.some((t) => t.includes("必要株数") || /\d+株以上/.test(t))) {
    return { status: "unknown", code, reason: "unscoped-table-before-first-h3" };
  }
  for (const section of sections.slice(1)) {
    const heading = (section.match(/^([^<]*)/)?.[1] ?? "").trim();
    const tables = [
      ...section.matchAll(/<table[^>]*class="md_table[^"]*"[^>]*>([\s\S]*?)<\/table>/gi),
    ].filter(
      (t) => t[1].includes("必要株数") || /\d+株以上/.test(t[1]),
    );
    if (tables.length === 0) continue;
    // 表より前の span (h3 と表の間) がこのセクションの明示スコープ。
    const beforeTables = section.slice(0, section.indexOf(tables[0][0]));
    const spanMatch = beforeTables.match(/優待権利確定月：<span[^>]*>([^<]+)/i);
    const localRecordMonths = spanMatch ? parseMonths(spanMatch[1]) : [];
    if (localRecordMonths.length === 0) {
      return { status: "unknown", code, reason: `no-local-month: ${heading.slice(0, 60)}` };
    }

    for (const tableMatch of tables) {
      const tableHtml = tableMatch[1];
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

        benefits.push({ minShares, description, notes, localRecordMonths, heading });
      }
    }
  }

  if (benefits.length === 0) {
    return { status: "unknown", code, reason: "no-benefit-tables" };
  }

  return { status: "ok", data: { code, name, market, category, benefits } };
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

  // Phase 2: 個別ページから詳細取得。1 件でも unknown があれば
  // Phase 3 (import) の前に throw する (未確定を廃止として消さない)。
  log.info("📊 Phase 2: 各銘柄の詳細データを取得中...");
  const allData = await collectStockDetails(codes, fetchStockDetail);
  log.info(`\n✅ ${allData.length}銘柄の詳細データを取得\n`);

  // データ品質サマリー (表示用の union。合成には表ローカル月だけを使う)
  const monthsOf = (d: StockYutaiData) =>
    [...new Set(d.benefits.flatMap((b) => b.localRecordMonths))].sort((a, b) => a - b);
  const multiMonth = allData.filter(d => monthsOf(d).length > 1).length;
  const multiShare = allData.filter(d => d.benefits.length > 1).length;
  log.info(`  複数権利月: ${multiMonth}銘柄`);
  log.info(`  複数株数条件: ${multiShare}銘柄`);
  log.info(`  サンプル: ${allData[0]?.name} (${allData[0]?.code})`);
  if (allData[0]) {
    log.info(`    権利月: ${monthsOf(allData[0]).join(",")}`);
    for (const b of allData[0].benefits) {
      log.info(`    ${b.minShares}株: ${b.description.substring(0, 50)}`);
    }
  }

  // Phase 3: DB import
  log.info("\n📦 Phase 3: DBにインポート中...");
  const result = await importYutaiFull(createD1HttpDb(schema), allData, createD1HttpBatchSender());

  log.info("\n" + "=".repeat(60));
  log.info("📊 最終結果:");
  log.info(`  銘柄数: ${result.stockCount}`);
  log.info(`  優待レコード数: ${result.benefitCount}`);
  console.info(`  母集団に無く飛ばした銘柄 (既存の優待行は保持): ${result.outOfUniverse.length}`);
  console.info(`  取得できず優待行を消した銘柄: ${result.abolishedCount}`);
  console.info(`  戻せなかった解釈: ${result.droppedInterpretations}`);
  console.info(`  取り込み失敗: ${result.failedCodes.length}`);
  console.info(`  利回り再計算を適用: ${result.recompute.updated}銘柄 / スコア: ${result.recompute.scoresUpdated}銘柄`);
  console.info(
    `  財務行が無く対象外: ${result.recompute.skippedNoRow.length} / スコア行が無くスコアだけ対象外: ${result.recompute.skippedNoScore.length}`
  );
  log.info(`  複数権利月の銘柄: ${multiMonth}`);
  log.info(`  複数株数条件の銘柄: ${multiShare}`);
  log.info("=".repeat(60));
}

// CLI として直接実行されたときだけ動かす (限定 READ 再利用のため import 可能にする)。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error("❌ Fatal:", e); process.exit(1); });
}
