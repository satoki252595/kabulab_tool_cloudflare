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
import { chmodSync, closeSync, createReadStream, createWriteStream, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip, gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { moveToTrash, recordPrimaryData, verifyArchivedAttachments } from "../../../src/shared/notion-archive/index.js";
import { sha256HexBytes } from "../../../src/shared/sha256.js";
import { resolveRunId, writeSummaryLocal } from "../../../scripts/vwap/lib/ingest-guard.js";
import "dotenv/config";

// Schema は src/db/schema.ts に集約済み (D1/SQLite 版 — ADR-0001)。
// 銘柄マスタ stocks は core_stocks の再 export、yutai_genres / yutai_benefits は
// otakara 固有テーブル。インラインの pgTable 定義は廃止した。

type RawPage = {
  url: string; receivedAt: string; status: number | null; contentType: string | null;
  byteLength: number; bodyBase64: string;
};
type CapturePage = (page: RawPage) => void;

async function fetchPage(url: string, onRaw?: CapturePage): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(20_000),
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "ja,en;q=0.9",
    },
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  onRaw?.({ url, receivedAt: new Date().toISOString(), status: res.status,
    contentType: res.headers.get("content-type"), byteLength: bytes.length,
    bodyBase64: bytes.toString("base64") });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return bytes.toString("utf-8");
}

/** 部分取得も物理保管する。保管・全バイト照合に失敗したらD1取込へ進まない。 */
async function archivePages(pages: readonly RawPage[], runId: string, source: string): Promise<{ pageId: string; files: { filename: string; bytes: Uint8Array; contentType: string }[] } | undefined> {
  if (pages.length === 0) return undefined; // 応答前の通信失敗は原本未取得。
  const bytes = gzipSync(pages.map((page) => JSON.stringify(page)).join("\n") + "\n");
  const key = `yutai-source-${runId}`;
  const filename = `${key}.jsonl.gz`;
  const files = [{ filename, bytes: Uint8Array.from(bytes), contentType: "application/gzip" }];
  const local = writeSummaryLocal({ key, files }, "services/otakara-yutai/data-scripts/data/raw");
  if (!local.ok) throw new Error("優待原本のprivate保存に失敗したためSTOP");
  const saved = Uint8Array.from(readFileSync(local.path));
  if (await sha256HexBytes(saved) !== await sha256HexBytes(bytes)) {
    throw new Error("優待原本のprivate保存SHAが一致しないためSTOP");
  }
  return archiveRawFile(local.path, runId, source, pages.length,
    pages.reduce((sum, page) => sum + page.byteLength, 0), pages[pages.length - 1].receivedAt);
}

/** 確定済みprivate gzipだけを共有保管へ渡し、全bytes照合まで取込を止める。 */
async function archiveRawFile(path: string, runId: string, source: string, pages: number, rawBytes: number, fetchedAt: string) {
  const bytes = Uint8Array.from(readFileSync(path));
  const key = `yutai-source-${runId}`;
  const files = [{ filename: `${key}.jsonl.gz`, bytes, contentType: "application/gzip" }];
  const archived = await recordPrimaryData({ service: "otakara-yutai", key,
    source,
    fetchedAt,
    metadata: { runId, pages, bytes: bytes.length, rawBytes,
      sha256: await sha256HexBytes(bytes) }, files, force: false });
  if (archived.outcome !== "recorded" || archived.fileTooLarge) {
    throw new Error("優待原本の物理保管が確定しないためSTOP");
  }
  await verifyArchivedAttachments(archived.pageId, files, "優待取得原本");
  return { pageId: archived.pageId, files };
}

/** 検索結果と明示ページ送りだけを読む。推薦欄・欠落したページ送りは採用しない。 */
export function parseStockListPage(html: string, page: number): { codes: string[]; nextPage: number | null; total: number } {
  const results = [...html.matchAll(/<div\b[^>]*\bid\s*=\s*["']yutai_search["'][^>]*>/g)];
  const paginations = [...html.matchAll(/<div\b[^>]*class=["'][^"']*\bpaginate_box\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/g)];
  if (results.length !== 1 || paginations.length !== 1 || results[0].index >= paginations[0].index) {
    throw new Error(`検索結果・ページ送り領域が未確定のためSTOP (page=${page})`);
  }
  const result = html.slice(results[0].index, paginations[0].index);
  const lists = [...result.matchAll(/<div\b[^>]*class=["'][^"']*\bcont_search\b[^"']*["'][^>]*>[\s\S]*?<ul\b[^>]*>([\s\S]*?)<\/ul>/g)];
  const totals = [...result.matchAll(/全(\d+)件/g)];
  if (lists.length !== 1 || totals.length !== 1 || !/<h2>検索結果<\/h2>/.test(result)) {
    throw new Error(`検索結果一覧・全件数が未確定のためSTOP (page=${page})`);
  }
  const cards = [...lists[0][1].matchAll(/<a\b[^>]*class=["']empty_link_area["'][^>]*>/g)];
  const codes = cards.map(([tag]) => {
    const href = tag.match(/\bhref=["']\/stock\/(\d{3}[0-9A-Z])\/yutai["']/);
    if (!href) throw new Error(`検索結果の銘柄リンクが未確定のためSTOP (page=${page})`);
    return href[1];
  });
  const total = Number(totals[0][1]);
  if (!Number.isSafeInteger(total) || total <= 0 || codes.length === 0 || new Set(codes).size !== codes.length) {
    throw new Error(`検索結果の銘柄集合が不正・重複のためSTOP (page=${page})`);
  }
  const pagination = paginations[0][1];
  const current = [...pagination.matchAll(/<span\b[^>]*class=["']current["'][^>]*>(\d+)<\/span>/g)];
  const next = [...pagination.matchAll(/<(?:a|span)\b[^>]*class=["'][^"']*\bnext_page\b[^"']*["'][^>]*>[\s\S]*?<\/(?:a|span)>/g)];
  if (current.length !== 1 || Number(current[0][1]) !== page || next.length !== 1) {
    throw new Error(`現在ページ・次ページが未確定のためSTOP (page=${page})`);
  }
  if (/^<span\b[^>]*class=["']disabled next_page["']/.test(next[0][0])) {
    return { codes, nextPage: null, total }; // 既知の最終ページだけ。404/空HTMLは末尾ではない。
  }
  const href = next[0][0].match(/^<a\b[^>]*\bhref=["']([^"']+)["']/);
  if (!href) throw new Error(`次ページのリンクが未確定のためSTOP (page=${page})`);
  const url = new URL(href[1].replaceAll("&amp;", "&"), "https://minkabu.jp");
  const pages = url.searchParams.getAll("page");
  const orders = url.searchParams.getAll("order");
  // 公式「並び替え」の空optionを明示する。利回り順はページ境界の重複・欠落を実観測した。
  const orderMatches = orders.length === 1 && orders[0] === "";
  if (url.origin !== "https://minkabu.jp" || url.pathname !== "/yutai/search" || url.hash ||
      pages.length !== 1 || !/^\d+$/.test(pages[0]) || Number(pages[0]) !== page + 1 ||
      !orderMatches ||
      [...url.searchParams.keys()].some(key => key !== "page" && key !== "order")) {
    throw new Error(`次ページのリンクが不整合のためSTOP (page=${page})`);
  }
  return { codes, nextPage: Number(pages[0]), total };
}

/**
 * Phase 1: 検索結果から全銘柄コードを収集。既知のページ送りの最終信号で終える。
 * 取得・構造失敗は部分リストを完成扱いにしない (廃止判定・D1取込へ進まない)。
 */
export async function collectAllStockCodes(
  fetchListPage: (page: number) => Promise<string> = (p) =>
    fetchPage(`https://minkabu.jp/yutai/search?order=&page=${p}`),
): Promise<string[]> {
  const allCodes = new Set<string>();
  const seenPages = new Set<string>();
  let page = 1;
  let expectedTotal: number | undefined;
  while (true) {
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
    const parsed = parseStockListPage(html, page);
    if (expectedTotal !== undefined && parsed.total !== expectedTotal) throw new Error("検索全件数が途中で変化したためSTOP");
    expectedTotal = parsed.total;
    const signature = [...parsed.codes].sort().join(",");
    if (seenPages.has(signature)) throw new Error(`検索ページの銘柄集合が重複したためSTOP (page=${page})`);
    seenPages.add(signature);
    for (const code of parsed.codes) allCodes.add(code);
    if (page % 10 === 0) log.info(`  Page ${page}: 累計 ${allCodes.size}銘柄`);
    if (parsed.nextPage === null) {
      if (allCodes.size !== expectedTotal) throw new Error("検索結果の全件数と銘柄集合が一致しないためSTOP");
      return [...allCodes].sort();
    }
    page = parsed.nextPage;
    await new Promise(r => setTimeout(r, 1_000));
  }
}

/**
 * Phase 2: 個別銘柄ページから詳細データ取得。
 * 限定 READ (切詰め対応の突合せ等) のため export する。呼出側で 400ms 以上の
 * 間隔を空けること。本ファイルmainは1秒間隔の直列取得。
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

export async function fetchStockDetail(code: string, onRaw?: CapturePage): Promise<StockDetailResult> {
  let html: string;
  try {
    html = await fetchPage(`https://minkabu.jp/stock/${code}/yutai`, onRaw);
  } catch (e) {
    const reason = `fetch: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160);
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
  let progress = 0;
  for (const code of codes) {
    const r = await fetchDetail(code);
    if (r.status === "unknown") {
      // 最初の取得・パース失敗で以後の新取得を止める。部分取込・廃止判定は禁止。
      throw new Error(`個別ページの取得・パースに未確定 (UNKNOWN) が 1 件あります。` +
        `未確定を廃止として削除しないため、取り込みません: ${r.code} (${r.reason})`);
    }
    allData.push(r.data);
    progress++;
    if (progress % 50 === 0) {
      log.info(`  ${progress}/${codes.length} (成功: ${allData.length})`);
    }
    if (progress < codes.length) await new Promise((r) => setTimeout(r, 1_000)); // 直列取得、再試行なし。
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
 * 権利月は各優待テーブルに直近で先行する「優待権利確定月」span から取る。
 * セクション先頭の span は配下の表への明示スコープとして継承でき (親スコープ
 * 継承)、表ごとの span があればそちらが優先する (表ローカル override)。
 * h3 を跨いだ span は適用しない。ページ上部の valuations の union を
 * 推測で被せない (旧形は 8022 の 3 月限定の表に 9 月行 37956 を誤合成した)。
 * span が無い表、表が無いページは `unknown`
 * (月の推測・100 株の仮優待フォールバックはしない。廃止の意味では使わない)。
 */
export function parseStockDetail(code: string, html: string): StockDetailResult {
  // 銘柄名（複数パターンで取得）
  let name: string | null = null;
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
  let market: string | null = null;
  if (html.includes("プライム")) market = "東証プライム";
  else if (html.includes("スタンダード")) market = "東証スタンダード";
  else if (html.includes("グロース")) market = "東証グロース";

  // カテゴリ/タイトル
  const titleMatch = html.match(/<h3[^>]*class="ulno"[^>]*>([^<]+)/);
  const category = titleMatch ? titleMatch[1].trim() : null;

  // h3 / 月 span / テーブルを文書順に辿り、表ごとに直近の適用 span を取る。
  // 同一セクション内の後発 span はその表だけに優先 (表ローカル override)、
  // 無ければセクション先頭 span を継承する。h3 を跨いだ span は使わない。
  type DocEvent =
    | { kind: "h3"; index: number; heading: string }
    | { kind: "span"; index: number; months: number[] }
    | { kind: "table"; index: number; tableHtml: string };
  const events: DocEvent[] = [];
  for (const m of html.matchAll(/<h3[^>]*class="ulno"[^>]*>([^<]*)/gi)) {
    events.push({ kind: "h3", index: m.index ?? 0, heading: (m[1] ?? "").trim() });
  }
  for (const m of html.matchAll(/優待権利確定月：<span[^>]*>([^<]+)/gi)) {
    events.push({ kind: "span", index: m.index ?? 0, months: parseMonths(m[1]) });
  }
  for (const m of html.matchAll(/<table[^>]*class="md_table[^"]*"[^>]*>([\s\S]*?)<\/table>/gi)) {
    events.push({ kind: "table", index: m.index ?? 0, tableHtml: m[1] });
  }
  events.sort((a, b) => a.index - b.index);

  const benefits: BenefitDetail[] = [];
  let heading = "";
  let scopeMonths: number[] | null = null;
  for (const ev of events) {
    if (ev.kind === "h3") {
      heading = ev.heading;
      scopeMonths = null;
      continue;
    }
    if (ev.kind === "span") {
      scopeMonths = ev.months;
      continue;
    }
    // 優待テーブル以外 (利回り表など) は月スコープに触らない。
    if (!ev.tableHtml.includes("必要株数") && !/\d+株以上/.test(ev.tableHtml)) continue;
    if (scopeMonths === null || scopeMonths.length === 0) {
      const where = heading ? `h3=${heading.slice(0, 60)}` : "pre-h3";
      return { status: "unknown", code, reason: `no-local-month: ${where}` };
    }
    const localRecordMonths = scopeMonths;
    const rows = ev.tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
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

  if (benefits.length === 0) {
    return { status: "unknown", code, reason: "no-benefit-tables" };
  }

  return { status: "ok", data: { code, name, market, category, benefits } };
}

// ===== Main =====
export async function main() {
  log.info("🚀 優待銘柄データ全量取得 v2\n");

  const runId = resolveRunId();
  const dir = "services/otakara-yutai/data-scripts/data/raw";
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = `${dir}/yutai-source-${runId}.jsonl`;
  const fd = openSync(path, "wx", 0o600);
  let pages = 0;
  let rawBytes = 0;
  let lastClock: string | null = null;
  const capture: CapturePage = (page) => {
    // 次GETより先に全bytesをdurable保存。全量base64をRAMへ保持しない。
    writeFileSync(fd, JSON.stringify(page) + "\n");
    fsyncSync(fd);
    pages++;
    rawBytes += page.byteLength;
    lastClock = page.receivedAt;
  };
  let allData: StockYutaiData[];
  try {
    // 毎回現行一覧を確認する。期限のない共有/tmpキャッシュでは新規・廃止を検出できない。
    log.info("📋 Phase 1: 全銘柄コードを収集中...");
    const codes = await collectAllStockCodes((page) => fetchPage(`https://minkabu.jp/yutai/search?order=&page=${page}`, capture));
    log.info(`\n✅ ${codes.length}銘柄のコードを収集\n`);
    log.info("📊 Phase 2: 各銘柄の詳細データを取得中...");
    allData = await collectStockDetails(codes, (code) => fetchStockDetail(code, capture));
  } finally {
    closeSync(fd);
    // UNKNOWNでも取得済み原本を残す。成功時もD1更新より先に保管・照合する。
    if (pages > 0 && lastClock !== null) {
      const gzipPath = `${path}.gz`;
      const gzipFd = openSync(gzipPath, "wx", 0o600);
      try {
        await pipeline(createReadStream(path), createGzip(), createWriteStream(gzipPath, { fd: gzipFd, autoClose: false }));
        fsyncSync(gzipFd);
      } finally { closeSync(gzipFd); }
      await archiveRawFile(gzipPath, runId, "minkabu search/detail response bytes (gzip lossless)", pages, rawBytes, lastClock);
    }
  }
  log.info(`\n✅ ${allData.length}銘柄の詳細データを取得\n`);

  // データ品質サマリー (表示用の union。合成には表ローカル月だけを使う)
  const monthsOf = (d: StockYutaiData) =>
    [...new Set(d.benefits.flatMap((b) => b.localRecordMonths))].sort((a, b) => a - b);
  const multiMonth = allData.filter(d => monthsOf(d).length > 1).length;
  const multiShare = allData.filter(d => d.benefits.length > 1).length;
  log.info(`  複数権利月: ${multiMonth}銘柄`);
  log.info(`  複数株数条件: ${multiShare}銘柄`);

  // Phase 3: DB import
  log.info("\n📦 Phase 3: DBにインポート中...");
  const db = createD1HttpDb(schema);
  // 取得経路だけでなく上書き前の全優待行を復元可能にする。原文・解釈をログには出さない。
  const previous = await db.select().from(schema.yutaiBenefits);
  const preimageBytes = Buffer.from(JSON.stringify(previous));
  const preimage = await archivePages([{
    url: "D1:yutai_benefits before source import", receivedAt: new Date().toISOString(),
    status: null, contentType: "application/json", byteLength: preimageBytes.length,
    bodyBase64: preimageBytes.toString("base64"),
  }], `${runId}-preimage`, "D1 yutai_benefits complete row snapshot before source import (HTTP status not exposed)");
  if (preimage === undefined) throw new Error("優待の更新前スナップショットが無いためSTOP");
  const result = await importYutaiFull(db, allData, createD1HttpBatchSender());
  const retired = await moveToTrash({ service: "otakara-yutai", originPageId: preimage.pageId,
    reason: `優待原文取込 ${runId} が成功。更新前の全行スナップショットを復元用に保管。` });
  await verifyArchivedAttachments(retired.trashPageId, preimage.files, "優待更新前スナップショット退避");

  log.info("\n" + "=".repeat(60));
  log.info("📊 最終結果:");
  log.info(`  銘柄数: ${result.stockCount}`);
  log.info(`  優待レコード数: ${result.benefitCount}`);
  console.info(`  母集団に無く飛ばした銘柄 (既存の優待行は保持): ${result.outOfUniverse.length}`);
  console.info(`  現行一覧に無く優待廃止を反映した銘柄: ${result.abolishedCount}`);
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
  main().catch(() => { console.error("優待取得・原本保管・取込のいずれかが失敗しました。取込開始後は更新済み銘柄があり得ます。原本と更新前スナップショットを保持してSTOP。"); process.exit(1); });
}
