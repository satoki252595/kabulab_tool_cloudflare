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
  benefitRowsOf,
  explicitRowRecordMonth,
  type BenefitDetail,
  type StockYutaiData,
} from "./yutai-full-import.js";
import { chmodSync, closeSync, createReadStream, createWriteStream, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip, gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { moveToTrash, recordPrimaryData, verifyArchivedAttachments } from "../../../src/shared/notion-archive/index.js";
import { sha256HexBytes } from "../../../src/shared/sha256.js";
import { resolveRunId, writeSummaryLocal } from "../../../scripts/vwap/lib/ingest-guard.js";
import { currentPublishingWriter, publishingReadOnly, publishingStore, withSharedPublishingWriter } from "../../../scripts/mechanical-publishing/shared-writer.js";
import "dotenv/config";
import { ANYTIME_RECORD_MONTH } from "../src/record-date.js";
import { sharedEnv } from "../../../src/shared/env.js";
import { installScheduledDeadline, nativeJobExecutionWindow, ScheduledSourceDeadlineError } from "../../../src/shared/scheduled-admission.js";
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { syncParent } from "../../../scripts/biztag-local/clef-journal.js";
import { notionEnv } from "../../../src/shared/notion-archive/env.js";
import { setNotionMaxRps } from "../../../src/shared/notion-archive/client.js";
import { assertNotCommittable } from "./private-path.js";
import { applyAtomicBatches } from "./atomic-apply.js";
import { fetchYieldInputs } from "./recompute-yields.js";
import { assertMonthScopePost, assertMonthScopeRowsEqual, loadMonthScopePreimage, planSavedMonthScope, qualifySavedMonthScopeArchive, readMonthScopePreimage, readSavedMonthScopePage, readMonthScopeRawBytes } from "./saved-month-scope.js";
import { adoptMusashinoOfficialSource, MUSASHINO_LISTING_URL, MUSASHINO_OFFICIAL_URL, MUSASHINO_NOTICE_URL } from "./musashino-source.js";
import { adoptNoteOfficialSource, NOTE_LISTING_URL, NOTE_OFFICIAL_URL, NOTE_NOTICE_URL } from "./note-source.js";
import { adoptKawasakiOfficialSource, KAWASAKI_LISTING_URL, KAWASAKI_OFFICIAL_URL, KAWASAKI_NOTICE_URL } from "./kawasaki-source.js";
import { extractPdfText } from "../../ir-catalog/src/services/pdf-sentiment/extract-text.js";
import { z } from "../../../src/shared/zod-mini.js";
import { assertMusashinoInitialPost, planMusashinoInitialEvent, planMusashinoSourceAdoption } from "./musashino-repair.js";

// Schema は src/db/schema.ts に集約済み (D1/SQLite 版 — ADR-0001)。
// 銘柄マスタ stocks は core_stocks の再 export、yutai_genres / yutai_benefits は
// otakara 固有テーブル。インラインの pgTable 定義は廃止した。

type RawPage = {
  url: string; receivedAt: string; status: number | null; contentType: string | null;
  byteLength: number; bodyBase64: string;
};
type CapturePage = (page: RawPage) => void;
type SavedOfficialPage = { page: RawPage; path: string; filename: string; contentType: string };

function saveOfficialSourcePage(page: RawPage, runId: string, dir: string, code: "8336" | "5243" | "3045" = "8336"): SavedOfficialPage {
  const contentType = page.contentType === null ? "application/octet-stream" : page.contentType.split(";")[0].trim().toLowerCase();
  const suffix = page.url === `https://minkabu.jp/stock/${code}/yutai` ? "provider" : page.url === (code === "8336" ? MUSASHINO_OFFICIAL_URL : code === "5243" ? NOTE_OFFICIAL_URL : KAWASAKI_OFFICIAL_URL) ? "official" : "notice";
  const filename = `yutai-official-${code}-${runId}-${suffix}.${contentType === "text/html" ? "html" : contentType === "application/pdf" ? "pdf" : "bin"}`;
  const saved = writeSummaryLocal({ key: `yutai-official-${code}-${runId}`, files: [{ filename, bytes: Buffer.from(page.bodyBase64, "base64"), contentType }] }, dir);
  if (!saved.ok) throw new Error("musashino_source_local_save_failed");
  return { page, path: saved.path, filename, contentType };
}

async function fetchRawPage(url: string, onRaw?: CapturePage, beforeRequest?: () => void, limit?: { bytes: number; contentType: string }): Promise<RawPage> {
  beforeRequest?.();
  const res = await fetch(url, {
    signal: AbortSignal.timeout(20_000),
    ...(limit === undefined ? {} : { redirect: "error" as const }),
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": limit === undefined ? "text/html,application/xhtml+xml" : limit.contentType,
      "Accept-Language": "ja,en;q=0.9",
    },
  });
  let bytes: Buffer;
  if (limit === undefined) bytes = Buffer.from(await res.arrayBuffer());
  else {
    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error("official_response_body_missing");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit.bytes) { await reader.cancel(); throw new Error("official_response_too_large"); }
      chunks.push(next.value);
    }
    bytes = Buffer.concat(chunks, size);
  }
  const page = { url, receivedAt: new Date().toISOString(), status: res.status,
    contentType: res.headers.get("content-type"), byteLength: bytes.length,
    bodyBase64: bytes.toString("base64") };
  onRaw?.(page);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  if (limit !== undefined && page.contentType?.split(";")[0].trim().toLowerCase() !== limit.contentType) throw new Error("official_response_type_changed");
  return page;
}

async function fetchPage(url: string, onRaw?: CapturePage, beforeRequest?: () => void): Promise<string> {
  const page = await fetchRawPage(url, onRaw, beforeRequest);
  return Buffer.from(page.bodyBase64, "base64").toString("utf-8");
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
export async function archiveRawFile(path: string, runId: string, source: string, pages: number, rawBytes: number, fetchedAt: string) {
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

/** 8336/5243/3045の両公式原本と元提供元を実体保管し、新本文を同じmanifestへ束縛する。 */
async function archiveOfficialSources(pages: readonly SavedOfficialPage[], runId: string, data: StockYutaiData | undefined, providerArchive: { key: string; sha256: string }, initialEvent = false, code: "8336" | "5243" | "3045" = "8336"): Promise<{ pageId: string } | undefined> {
  const urls = code === "8336" ? [MUSASHINO_OFFICIAL_URL, MUSASHINO_NOTICE_URL] : code === "5243" ? [NOTE_OFFICIAL_URL, NOTE_NOTICE_URL] : [KAWASAKI_OFFICIAL_URL, KAWASAKI_NOTICE_URL];
  if (!pages.some(({ page }) => urls.includes(page.url))) return;
  const sources = await Promise.all(pages.map(async ({ page, path, filename, contentType }) => {
    const bytes = Uint8Array.from(readFileSync(path));
    const sha256 = await sha256HexBytes(bytes);
    if (sha256 !== await sha256HexBytes(Buffer.from(page.bodyBase64, "base64"))) throw new Error("musashino_local_source_changed");
    return { file: { filename, bytes, contentType }, response: { url: page.url, receivedAt: page.receivedAt, status: page.status, contentType: page.contentType, byteLength: page.byteLength, sha256, filename } };
  }));
  const files = sources.map(source => source.file);
  const rows = data === undefined ? [] : await Promise.all(benefitRowsOf(data).rows.map(async row => ({ minShares: row.minShares, recordMonth: row.recordMonth, recordDate: initialEvent ? "2026-09-30" : null, descriptionSha256: await sha256HexBytes(Buffer.from(row.description)) })));
  const archived = await recordPrimaryData({ service: "otakara-yutai", key: `yutai-official-${code}-${runId}`,
    source: `${code} explicit official HTML/PDF adoption with original provider provenance`, fetchedAt: pages[pages.length - 1].page.receivedAt,
    metadata: { runId, providerArchive, responses: sources.map(source => source.response),
      adoption: data === undefined ? "unresolved" : "full_source_qualified", official: data === undefined ? null : data.official, rows }, files, force: false });
  if (archived.outcome !== "recorded" || archived.fileTooLarge) throw new Error("musashino_official_archive_unconfirmed");
  await verifyArchivedAttachments(archived.pageId, files, `${code}公式原本と提供元`);
  return { pageId: archived.pageId };
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
      if (e instanceof ScheduledSourceDeadlineError) throw e;
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

export async function fetchStockDetail(code: string, onRaw?: CapturePage, beforeRequest?: () => void): Promise<StockDetailResult> {
  let sourceFetchedAt: string | undefined;
  try {
    const html = await fetchPage(`https://minkabu.jp/stock/${code}/yutai`, page => {
      sourceFetchedAt = page.receivedAt;
      onRaw?.(page);
    }, beforeRequest);
    const result = parseStockDetail(code, html);
    if (result.status !== "ok") return result;
    result.data.sourceFetchedAt = sourceFetchedAt;
    if (code !== "8336" && code !== "5243" && code !== "3045") return result;
    // 明示公式採用。取得・全文資格に失敗したら旧提供元へ戻さずUNKNOWNにする。
    const official = await fetchRawPage(code === "8336" ? MUSASHINO_OFFICIAL_URL : code === "5243" ? NOTE_OFFICIAL_URL : KAWASAKI_OFFICIAL_URL, onRaw, beforeRequest, { bytes: 256 * 1024, contentType: "text/html" });
    const notice = await fetchRawPage(code === "8336" ? MUSASHINO_NOTICE_URL : code === "5243" ? NOTE_NOTICE_URL : KAWASAKI_NOTICE_URL, onRaw, beforeRequest, { bytes: 2 * 1024 * 1024, contentType: "application/pdf" });
    const pdf = Uint8Array.from(Buffer.from(notice.bodyBase64, "base64"));
    const pdfText = await extractPdfText(pdf);
    if (pdfText === null) throw new Error("musashino_official_pdf_unreadable");
    const adopt = code === "8336" ? adoptMusashinoOfficialSource : code === "5243" ? adoptNoteOfficialSource : adoptKawasakiOfficialSource;
    return { status: "ok", data: adopt(result.data, new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(official.bodyBase64, "base64")), pdf, pdfText, notice.receivedAt) };
  } catch (e) {
    if (e instanceof ScheduledSourceDeadlineError) throw e;
    const reason = `fetch: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160);
    return { status: "unknown", code, reason };
  }
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
      console.error(JSON.stringify({ event: "YUTAI_DETAIL_UNKNOWN", code: r.code, reason: r.reason.split(":")[0] }));
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

/** 公式「随時」は専用 enum、実月は 1〜12。未知表示は補わない。 */
function parseMonths(text: string): number[] {
  // 明記された非定期だけを専用 enum にする。他の無月・不明表示は補わない。
  if (text.trim() === "随時") return [ANYTIME_RECORD_MONTH];
  if (text.includes("随時")) return []; // 実月との混在など、意味が未確定な表示は HOLD。
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
 * 単一額面の「(n月のみ)」や正整数枚数の「※n月のみ」という全文セルは、表の月の
 * subsetとしてその行だけに適用する。利用・申込等の時期は権利月と推定しない。
 * h3 を跨いだ span は適用しない。ページ上部の valuations の union を
 * 推測で被せない (旧形は 8022 の 3 月限定の表に 9 月行 37956 を誤合成した)。
 * 公式 span の「随時」は専用 enum 0。span が無い表、表が無いページは `unknown`
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
    const tableRecordMonths = scopeMonths;
    const rows = ev.tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
    let lastNotes = "";
    let shareOnly = false;

    for (const row of rows) {
      const cells: string[] = [];
      const cellMatches = row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi);
      for (const cell of cellMatches) {
        cells.push(cell[1].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "").trim());
      }

      // 必要株数だけの公式表では優待名がh3に明記される専用形式。
      if (cells[0] === "必要株数") {
        shareOnly = cells.length === 1 && /<th\b/i.test(row[1]);
        continue;
      }
      if (shareOnly && (cells.length !== 1 || !heading)) {
        return { status: "unknown", code, reason: "invalid-share-only-table" };
      }
      if (!shareOnly && cells.length < 2) continue;

      // 株数パース
      const shareCell = cells[0]!; // 通常表は2列以上、株数のみの表は1列を確認済み。
      const sharesMatch = shareCell.match(/^(\d{1,3}(?:,\d{3})+|\d+)\s*株/);
      if (!sharesMatch) {
        if (/\d[\d,.]*\s*株/.test(shareCell)) {
          return { status: "unknown", code, reason: "invalid-min-shares" };
        }
        if (shareOnly) return { status: "unknown", code, reason: "invalid-share-only-table" };
        continue; // 非株数の継続行は従前どおり。
      }
      const minShares = parseInt(sharesMatch[1].replace(/,/g, ""), 10);
      if (!Number.isSafeInteger(minShares) || minShares <= 0) {
        return { status: "unknown", code, reason: "invalid-min-shares" };
      }

      const description = shareOnly ? heading : cells[1] || "";
      let localRecordMonths = tableRecordMonths;
      // 実原本の「1,000円相当\n（3月のみ）」「1枚※3月のみ」は
      // 行全体の適用月。複数商品や利用・開催・申込・発送の月は拾わない。
      const month = explicitRowRecordMonth(description);
      if (month !== undefined) {
        if (month < 1 || month > 12 || tableRecordMonths.includes(ANYTIME_RECORD_MONTH) ||
            !tableRecordMonths.includes(month)) {
          return { status: "unknown", code, reason: "row-month-scope-conflict" };
        }
        localRecordMonths = [month];
      }
      const notes = cells[2] || lastNotes;
      if (cells[2]) lastNotes = cells[2];

      benefits.push({ minShares, description, notes, localRecordMonths, ...(month === undefined ? {} : { tableRecordMonths }), heading });
    }
  }

  if (benefits.length === 0) {
    return { status: "unknown", code, reason: "no-benefit-tables" };
  }

  return { status: "ok", data: { code, name, market, category, benefits } };
}

// ===== Main =====
export async function main(argv: readonly string[] = []) {
  if (argv.includes("--adopt-musashino-source") || argv.includes("--add-musashino-initial-event") || argv.includes("--adopt-note-source") || argv.includes("--adopt-kawasaki-source")) return adoptSavedOfficialSource(argv);
  if (argv.length > 0) return repairSavedMonthScope(argv);
  const window = nativeJobExecutionWindow(Date.now(), sharedEnv.BATCH_JOB_STARTED_AT(), 360, 10);
  const assertSource = () => {
    if (window !== undefined && Date.now() >= window.sourceDeadline) {
      throw new ScheduledSourceDeadlineError("優待の新規取得期限です（未完・取込なし）");
    }
  };
  assertSource();
  const restore = window === undefined ? undefined : installScheduledDeadline(window.deadline);
  try {
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
  let musashinoData: StockYutaiData | undefined;
  const musashinoPages: SavedOfficialPage[] = [];
  let noteData: StockYutaiData | undefined;
  const notePages: SavedOfficialPage[] = [];
  let kawasakiData: StockYutaiData | undefined;
  const kawasakiPages: SavedOfficialPage[] = [];
  const capture: CapturePage = (page) => {
    if ([MUSASHINO_LISTING_URL, MUSASHINO_OFFICIAL_URL, MUSASHINO_NOTICE_URL].includes(page.url)) {
      musashinoPages.push(saveOfficialSourcePage(page, runId, dir));
      // 公式原本は別の実体添付へ送る。既存provider gzipの形式・保管契約を変えない。
      if (page.url !== MUSASHINO_LISTING_URL) return;
    }
    if ([NOTE_LISTING_URL, NOTE_OFFICIAL_URL, NOTE_NOTICE_URL].includes(page.url)) {
      notePages.push(saveOfficialSourcePage(page, runId, dir, "5243"));
      if (page.url !== NOTE_LISTING_URL) return;
    }
    if ([KAWASAKI_LISTING_URL, KAWASAKI_OFFICIAL_URL, KAWASAKI_NOTICE_URL].includes(page.url)) {
      kawasakiPages.push(saveOfficialSourcePage(page, runId, dir, "3045"));
      if (page.url !== KAWASAKI_LISTING_URL) return;
    }
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
    const codes = await collectAllStockCodes((page) => fetchPage(`https://minkabu.jp/yutai/search?order=&page=${page}`, capture, assertSource));
    log.info(`\n✅ ${codes.length}銘柄のコードを収集\n`);
    log.info("📊 Phase 2: 各銘柄の詳細データを取得中...");
    allData = await collectStockDetails(codes, async (code) => {
      const result = await fetchStockDetail(code, capture, assertSource);
      if (code === "8336" && result.status === "ok") musashinoData = result.data;
      if (code === "5243" && result.status === "ok") noteData = result.data;
      if (code === "3045" && result.status === "ok") kawasakiData = result.data;
      return result;
    });
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
      const raw = await archiveRawFile(gzipPath, runId, "minkabu search/detail response bytes (gzip lossless)", pages, rawBytes, lastClock);
      const providerArchive = { key: `yutai-source-${runId}`, sha256: await sha256HexBytes(raw.files[0].bytes) };
      await archiveOfficialSources(musashinoPages, runId, musashinoData, providerArchive);
      await archiveOfficialSources(notePages, runId, noteData, providerArchive, false, "5243");
      await archiveOfficialSources(kawasakiPages, runId, kawasakiData, providerArchive, false, "3045");
    }
  }
  if (lastClock === null) throw new Error("優待原本の実取得時計が無いためSTOP");
  await importCollectedYutaiData(allData, runId, lastClock);
  } finally { restore?.(); }
}

// ponytail: 2026-10-21保存providerの8336/5243/3045だけ。別cohortは通常collectorで再資格化する。
const OfficialSavedPacket = z.strictObject({
  version: z.literal(1),
  providerArchiveKey: z.literal("yutai-source-local-411af4c3"),
  providerArchiveSha256: z.literal("0e9167f08f4a7c74a081b97db90b25eb87e265ac88a9c8ab4a17cede470053a4"),
  providerBatchFetchedAt: z.literal("2026-10-21T16:56:22.538Z"),
  pages: z.array(z.strictObject({ url: z.string(), receivedAt: z.string(), status: z.literal(200), contentType: z.string(),
    byteLength: z.number().check(z.int(), z.positive()), bodyBase64: z.string() })).check(z.minLength(3), z.maxLength(3)),
});

/** 保存済み3issuerの原本だけ。応答時計は変えず、DTOの検証時計だけ既存ISO形式へ正規化する。 */
async function readSavedOfficialPacket(path: string, sha256: string, code: "8336" | "5243" | "3045") {
  const prefix = code === "8336" ? "musashino" : code === "5243" ? "note" : "kawasaki";
  const bytes = readMonthScopeRawBytes(path, sha256);
  if (bytes.length > 4 * 1024 * 1024) throw new Error(`${prefix}_saved_packet_too_large`);
  const packet = OfficialSavedPacket.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  const urls = code === "8336" ? [MUSASHINO_LISTING_URL, MUSASHINO_OFFICIAL_URL, MUSASHINO_NOTICE_URL] : code === "5243" ? [NOTE_LISTING_URL, NOTE_OFFICIAL_URL, NOTE_NOTICE_URL] : [KAWASAKI_LISTING_URL, KAWASAKI_OFFICIAL_URL, KAWASAKI_NOTICE_URL];
  const savedClocks = code === "5243" ? ["2026-10-21T16:30:29.082Z", "2026-10-25T20:29:07.105213+00:00", "2026-10-25T20:29:07.337103+00:00"] : ["2026-10-21T16:16:52.221Z", "2026-10-25T20:29:30.806839+00:00", "2026-10-25T20:29:41.991941+00:00"];
  for (const [i, page] of packet.pages.entries()) {
    const body = Buffer.from(page.bodyBase64, "base64"), clock = new Date(page.receivedAt);
    if (page.url !== urls[i] || body.length !== page.byteLength || body.toString("base64") !== page.bodyBase64 ||
        !Number.isFinite(clock.getTime()) || (code === "8336" ? clock.toISOString() !== page.receivedAt : page.receivedAt !== savedClocks[i]) ||
        page.contentType.split(";")[0].trim().toLowerCase() !== (i === 2 ? "application/pdf" : "text/html")) throw new Error(`${prefix}_saved_response_invalid`);
  }
  if (packet.pages[0].receivedAt !== (code === "8336" ? "2026-10-21T16:47:17.281Z" : savedClocks[0]) ||
      await sha256HexBytes(Buffer.from(packet.pages[0].bodyBase64, "base64")) !== (code === "8336" ? "be11f714fba48c731c1959d910ef6921afd7e04d16ae1f40ed5354463a6cbccc" : code === "5243" ? "360fd72f9de01d861f52b2aa102409e75b951b78186baa130be81ce032a7ddcb" : "25981f5c8eb26e19e8d11e59ed2f05a82e3e7c28892608c0bb3cc97d30b57f8d")) throw new Error(`${prefix}_saved_provider_changed`);
  const decoded = (page: RawPage) => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(page.bodyBase64, "base64"));
  const provider = parseStockDetail(code, decoded(packet.pages[0]));
  if (provider.status !== "ok") throw new Error(`${prefix}_saved_provider_unreadable`);
  provider.data.sourceFetchedAt = packet.pages[0].receivedAt;
  const pdf = Uint8Array.from(Buffer.from(packet.pages[2].bodyBase64, "base64")), pdfText = await extractPdfText(pdf);
  if (pdfText === null) throw new Error(`${prefix}_saved_notice_unreadable`);
  return { packet, provider: provider.data, html: decoded(packet.pages[1]), pdf, pdfText,
    verifiedAt: new Date(packet.pages[2].receivedAt).toISOString() };
}

/** 固定private8336原本だけを再解析する。初回と年次の既存形を保つ。 */
export async function readSavedMusashinoSource(path: string, sha256: string, initialEvent = false) {
  const source = await readSavedOfficialPacket(path, sha256, "8336");
  const annual = adoptMusashinoOfficialSource(source.provider, source.html, source.pdf, source.pdfText, source.verifiedAt);
  return { packet: source.packet, annual, data: initialEvent ? adoptMusashinoOfficialSource(source.provider, source.html, source.pdf, source.pdfText, source.verifiedAt, true) : annual };
}

/** 固定private5243原本だけ。毎年11月の2行を導き、5月や初回の行を作らない。 */
export async function readSavedNoteSource(path: string, sha256: string) {
  const source = await readSavedOfficialPacket(path, sha256, "5243");
  const data = adoptNoteOfficialSource(source.provider, source.html, source.pdf, source.pdfText, source.verifiedAt);
  return { packet: source.packet, annual: data, data };
}

/** 固定private3045原本だけ。変更前/2027年拡充後を含む2全文・年次4行。 */
export async function readSavedKawasakiSource(path: string, sha256: string) {
  const source = await readSavedOfficialPacket(path, sha256, "3045");
  const data = adoptKawasakiOfficialSource(source.provider, source.html, source.pdf, source.pdfText, source.verifiedAt);
  return { packet: source.packet, annual: data, data };
}

/** 8336/5243/3045の固定入力mode。既存state/unknownを再送しない。 */
export function parseMusashinoAdoptionArgs(argv: readonly string[]) {
  const { values, tokens } = parseArgs({ args: [...argv], strict: true, allowPositionals: false, tokens: true, options: {
    "adopt-musashino-source": { type: "boolean" }, "add-musashino-initial-event": { type: "boolean" }, "adopt-note-source": { type: "boolean" }, "adopt-kawasaki-source": { type: "boolean" }, "saved-source": { type: "string" }, "saved-source-sha256": { type: "string" },
    "expected-pre": { type: "string" }, "expected-pre-sha256": { type: "string" }, "state-dir": { type: "string" },
  } });
  const seen = new Set<string>();
  for (const token of tokens) if (token.kind === "option") { if (seen.has(token.name)) throw new Error("musashino_duplicate_option"); seen.add(token.name); }
  if ([values["adopt-musashino-source"], values["add-musashino-initial-event"], values["adopt-note-source"], values["adopt-kawasaki-source"]].filter(value => value === true).length !== 1 || !values["saved-source"] || !values["expected-pre"] || !values["state-dir"] ||
      !values["saved-source-sha256"] || !/^[a-f0-9]{64}$/.test(values["saved-source-sha256"]) ||
      !values["expected-pre-sha256"] || !/^[a-f0-9]{64}$/.test(values["expected-pre-sha256"])) throw new Error("musashino_fixed_inputs_required");
  return { path: values["saved-source"], sha256: values["saved-source-sha256"], expectedPre: values["expected-pre"], preSha256: values["expected-pre-sha256"], state: resolve(values["state-dir"]), initialEvent: values["add-musashino-initial-event"] === true };
}

async function adoptSavedOfficialSource(argv: readonly string[]): Promise<void> {
  const code = argv.includes("--adopt-note-source") ? "5243" : argv.includes("--adopt-kawasaki-source") ? "3045" : "8336";
  const options = parseMusashinoAdoptionArgs(argv), started = Date.now(), native = nativeJobExecutionWindow(started, sharedEnv.BATCH_JOB_STARTED_AT(), 360, 10);
  const deadline = Math.min(started + 15 * 60_000, native === undefined ? Infinity : native.deadline);
  const sourceDeadline = Math.min(started + 10 * 60_000, native === undefined ? Infinity : native.sourceDeadline);
  const assertActive = () => { if (Date.now() >= deadline) throw new Error("musashino_adoption_deadline"); };
  const assertSource = () => { assertActive(); if (Date.now() >= sourceDeadline) throw new Error("musashino_adoption_source_deadline"); };
  assertSource();
  if (existsSync(options.state)) throw new Error("musashino_adoption_state_already_started");
  const pre = readMonthScopePreimage(options.expectedPre, options.preSha256), source = code === "8336" ? await readSavedMusashinoSource(options.path, options.sha256, options.initialEvent) : code === "5243" ? await readSavedNoteSource(options.path, options.sha256) : await readSavedKawasakiSource(options.path, options.sha256);
  assertSource();
  for (const getter of [sharedEnv.R2_ACCOUNT_ID, sharedEnv.R2_ACCESS_KEY_ID, sharedEnv.R2_SECRET_ACCESS_KEY, sharedEnv.R2_BUCKET_RAW,
    notionEnv.NOTION_TOKEN, notionEnv.NOTION_ARCHIVE_PAGE_ID]) getter();
  const rps = notionEnv.NOTION_MAX_RPS(); if (rps !== undefined) setNotionMaxRps(rps);
  assertNotCommittable(join(options.state, "INTENT.private.json"));
  mkdirSync(options.state, { mode: 0o700 }); syncParent(options.state);
  const st = lstatSync(options.state);
  if (realpathSync(options.state) !== options.state || !st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700) throw new Error("musashino_private_state_required");
  const save = (name: string, value: unknown) => { const path = join(options.state, name); writeFileSync(path, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx", flush: true }); syncParent(path); };
  save("INTENT.private.json", { version: 1, code, ...options, startedAt: new Date(started).toISOString(), deadline: new Date(deadline).toISOString() });
  const restore = installScheduledDeadline(deadline);
  try {
    const db = createD1HttpDb(schema), runId = resolveRunId();
    await withSharedPublishingWriter(async () => {
      const writer = currentPublishingWriter(); if (writer === undefined) throw new Error("musashino_adoption_writer_missing");
      const plan = await publishingReadOnly(async () => {
        assertSource(); const current = await loadMonthScopePreimage(db, code); assertMonthScopeRowsEqual(pre, current);
        const inputs = await fetchYieldInputs(db, [Number(pre.parent.id)]);
        return options.initialEvent ? planMusashinoInitialEvent(db, pre, source.annual, source.data, source.packet.providerBatchFetchedAt, inputs) :
          planMusashinoSourceAdoption(db, pre, source.data, source.packet.providerBatchFetchedAt, inputs);
      });
      save("PRE.private.json", pre); save("PLAN.private.json", plan);
      if (plan.batch === null) { save("FINISHED.private.json", { code, updatedRows: 0, SQL: 0, sourceArchiveThisRun: false }); return; }
      const publication = await writer.reserve("yutai-source-import", { kind: code === "3045" ? "kawasaki-source-adoption-v1" : code === "5243" ? "note-source-adoption-v1" : options.initialEvent ? "musashino-initial-event-v1" : "musashino-source-adoption-v1", sourceSha256: options.sha256, preSha256: options.preSha256 }, JSON.stringify({ options, source, pre, plan }));
      const pages = source.packet.pages.map(page => saveOfficialSourcePage(page, runId, join(options.state, "sources"), code));
      assertSource();
      const original = await archiveOfficialSources(pages, runId, source.data, { key: source.packet.providerArchiveKey, sha256: source.packet.providerArchiveSha256 }, options.initialEvent, code);
      if (original === undefined) throw new Error("musashino_official_archive_missing");
      const archive = async (phase: "pre" | "post", rows: unknown) => {
        const bytes = Buffer.from(JSON.stringify(rows));
        const saved = await archivePages([{ url: `D1:stock ${code} source adoption ${phase}`, receivedAt: new Date().toISOString(), status: null,
          contentType: "application/json", byteLength: bytes.length, bodyBase64: bytes.toString("base64") }], `${runId}-${code === "8336" ? "musashino" : code === "5243" ? "note" : "kawasaki"}-${phase}`, `D1 complete four-table ${code} source adoption ${phase}`);
        if (saved === undefined) throw new Error("musashino_snapshot_archive_missing");
        return { saved, bytes };
      };
      const before = await archive("pre", pre);
      assertSource(); await applyAtomicBatches(createD1HttpBatchSender(), [plan.batch]);
      assertActive(); const post = await publishingReadOnly(() => loadMonthScopePreimage(db, code));
      if (options.initialEvent) assertMusashinoInitialPost(plan.expected, post); else assertMonthScopePost(plan, post);
      save("POST.private.json", post);
      const after = await archive("post", post);
      assertActive(); await publication.complete({ sourceArchivePageId: original.pageId, preArchivePageId: before.saved.pageId, postArchivePageId: after.saved.pageId,
        observedPostSha256: await sha256HexBytes(after.bytes), observedPostRows: post.benefits.length, updatedRows: options.initialEvent ? 0 : pre.benefits.length, insertedRows: options.initialEvent ? 3 : 0, sourceSha256: options.sha256 });
      save("FINISHED.private.json", { code, updatedRows: options.initialEvent ? 0 : pre.benefits.length, insertedRows: options.initialEvent ? 3 : 0, sourceRequests: 0, modelCalls: 0 });
    }, publishingStore(deadline));
  } finally { restore(); }
}

/** 明示saved modeだけを受け付ける。単一銘柄を全量/廃止判定へ渡さない。 */
export function parseSavedMonthScopeArgs(argv: readonly string[]) {
  const { values, tokens } = parseArgs({ args: [...argv], strict: true, allowPositionals: false, tokens: true, options: {
    "repair-month-scope": { type: "boolean" }, code: { type: "string" },
    "saved-raw": { type: "string" }, "saved-raw-sha256": { type: "string" },
    "raw-archive-page-id": { type: "string" }, "raw-filename": { type: "string" },
    "expected-pre": { type: "string" }, "expected-pre-sha256": { type: "string" }, "state-dir": { type: "string" },
  } });
  const seen = new Set<string>();
  for (const token of tokens) if (token.kind === "option") { if (seen.has(token.name)) throw new Error("月限定是正の引数が重複しています"); seen.add(token.name); }
  if (values["repair-month-scope"] !== true || !values.code || !/^\d{3}[0-9A-Z]$/.test(values.code) ||
      !values["saved-raw"] || !values["expected-pre"] || !values["state-dir"] ||
      !values["saved-raw-sha256"] || !/^[a-f0-9]{64}$/.test(values["saved-raw-sha256"]) ||
      !values["expected-pre-sha256"] || !/^[a-f0-9]{64}$/.test(values["expected-pre-sha256"]) ||
      !values["raw-archive-page-id"] || !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(values["raw-archive-page-id"]) ||
      !values["raw-filename"] || !/^yutai-source-[a-zA-Z0-9_-]+\.jsonl\.gz$/.test(values["raw-filename"])) throw new Error("保存月限定是正には全固定入力/完全SHA/原本保管先/専用stateが必要です");
  return { code: values.code, path: values["saved-raw"], sha256: values["saved-raw-sha256"],
    archivePageId: values["raw-archive-page-id"], filename: values["raw-filename"],
    expectedPre: values["expected-pre"], preSha256: values["expected-pre-sha256"], state: resolve(values["state-dir"]) };
}

async function repairSavedMonthScope(argv: readonly string[]): Promise<void> {
  const options = parseSavedMonthScopeArgs(argv);
  const started = Date.now(), native = nativeJobExecutionWindow(started, sharedEnv.BATCH_JOB_STARTED_AT(), 360, 10);
  const deadline = Math.min(started + 15 * 60_000, native === undefined ? Infinity : native.deadline);
  const sourceDeadline = Math.min(started + 10 * 60_000, native === undefined ? Infinity : native.sourceDeadline);
  const assertActive = () => { if (Date.now() >= deadline) throw new Error("保存月限定是正の閉鎖期限です。再送せず保全します"); };
  const assertSource = () => { assertActive(); if (Date.now() >= sourceDeadline) throw new Error("保存月限定是正の新規送信開始期限です。再送せず保全します"); };
  assertSource();
  if (existsSync(options.state)) throw new Error("保存月限定是正は開始済みstateを再利用しません");
  const restore = installScheduledDeadline(deadline);
  try {
    const pre = readMonthScopePreimage(options.expectedPre, options.preSha256);
    const raw = await readSavedMonthScopePage(options.path, options.sha256, options.code);
    const parsed = parseStockDetail(options.code, raw.html);
    if (parsed.status !== "ok") throw new Error("保存原本の通常parseが未確定です");
    parsed.data.sourceFetchedAt = raw.receivedAt;
    const db = createD1HttpDb(schema), sender = createD1HttpBatchSender();
    for (const getter of [sharedEnv.R2_ACCOUNT_ID, sharedEnv.R2_ACCESS_KEY_ID, sharedEnv.R2_SECRET_ACCESS_KEY, sharedEnv.R2_BUCKET_RAW,
      notionEnv.NOTION_TOKEN, notionEnv.NOTION_ARCHIVE_PAGE_ID]) getter();
    const rps = notionEnv.NOTION_MAX_RPS(); if (rps !== undefined) setNotionMaxRps(rps);
    assertNotCommittable(join(options.state, "INTENT.private.json"));
    // 完全SHAと実受信時計は元rawからのみ得る。保管済み原本を別keyへ再保存しない。
    const original = readMonthScopeRawBytes(options.path, options.sha256);
    assertSource();
    await qualifySavedMonthScopeArchive(options.archivePageId, options.filename, raw);
    await verifyArchivedAttachments(options.archivePageId, [{ filename: options.filename, bytes: original }], "保存月限定是正の元原本");
    mkdirSync(options.state, { mode: 0o700 }); syncParent(options.state); // 既存stateは成功/不明を問わず再利用しない。
    const stateStat = lstatSync(options.state);
    if (realpathSync(options.state) !== options.state || !stateStat.isDirectory() || stateStat.isSymbolicLink() || stateStat.uid !== process.getuid?.() || (stateStat.mode & 0o777) !== 0o700) throw new Error("月限定stateは所有者限定0700の実体directoryが必要です");
    const save = (name: string, value: unknown) => { const path = join(options.state, name); writeFileSync(path, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx", flush: true }); syncParent(path); };
    save("INTENT.private.json", { version: 1, ...options, startedAt: new Date(started).toISOString(), deadline: new Date(deadline).toISOString() });
    const runId = resolveRunId();
    await withSharedPublishingWriter(async () => {
      const writer = currentPublishingWriter(); if (writer === undefined) throw new Error("保存月限定是正の共有writerがありません");
      assertSource();
      const plan = await publishingReadOnly(async () => {
        const current = await loadMonthScopePreimage(db, options.code); assertMonthScopeRowsEqual(pre, current);
        const inputs = await fetchYieldInputs(db, [Number(pre.parent.id)]);
        return planSavedMonthScope(pre, parsed.data, raw, inputs, Date.now());
      });
      assertActive(); save("PRE.private.json", pre); save("PLAN.private.json", plan);
      const publication = await writer.reserve("yutai-source-import", { kind: "saved-month-scope-v1", code: options.code, rawSha256: options.sha256, preSha256: options.preSha256, excessId: plan.excessId }, JSON.stringify({ options, raw: { ...raw, html: undefined }, pre, plan }));
      const archive = async (phase: "pre" | "post", value: unknown) => {
        const bytes = Buffer.from(JSON.stringify(value));
        const archived = await archivePages([{ url: `D1:stock ${options.code} saved month scope ${phase}`, receivedAt: new Date().toISOString(), status: null,
          contentType: "application/json", byteLength: bytes.length, bodyBase64: bytes.toString("base64") }], `${runId}-month-scope-${phase}`, `D1 complete scoped rows ${phase} saved month scope repair (HTTP status not exposed)`);
        if (archived === undefined) throw new Error("月限定是正の物理PRE/POSTがありません");
        return { archived, bytes };
      };
      const before = await archive("pre", pre);
      assertSource(); await applyAtomicBatches(sender, [plan.batch]);
      assertActive();
      const post = await publishingReadOnly(() => loadMonthScopePreimage(db, options.code));
      assertMonthScopePost(plan, post); save("POST.private.json", post);
      const after = await archive("post", post); assertActive();
      await publication.complete({ preArchivePageId: before.archived.pageId, postArchivePageId: after.archived.pageId,
        observedPostSha256: await sha256HexBytes(after.bytes), observedPostRows: post.benefits.length, deletedRows: 1, code: options.code, rawSha256: options.sha256 });
    }, publishingStore(deadline));
    save("FINISHED.private.json", { code: options.code, deletedRows: 1, retainedRows: pre.benefits.length - 1, modelCalls: 0, sourceRequests: 0 });
    console.info(JSON.stringify({ kind: "saved-month-scope", code: options.code, deletedRows: 1, retainedRows: pre.benefits.length - 1, modelCalls: 0, sourceRequests: 0 }));
  } finally { restore(); }
}

/** 全量・物理原本の照合済み収集結果を、通常のPRE保管・原子取込へ渡す。 */
export async function importCollectedYutaiData(allData: StockYutaiData[], runId: string, sourceFetchedAt: string): Promise<void> {
  const window = nativeJobExecutionWindow(Date.now(), sharedEnv.BATCH_JOB_STARTED_AT(), 360, 10);
  const assertActive = () => {
    if (window !== undefined && Date.now() >= window.deadline) throw new Error("優待の原本閉鎖期限です（未完・再送なし）");
  };
  assertActive();
  const restore = window === undefined ? undefined : installScheduledDeadline(window.deadline);
  try {
    return await withSharedPublishingWriter(() => importCollectedYutaiDataOwned(allData, runId, sourceFetchedAt, assertActive),
      window === undefined ? undefined : publishingStore(window.deadline));
  } finally { restore?.(); }
}

async function importCollectedYutaiDataOwned(allData: StockYutaiData[], runId: string, sourceFetchedAt: string, assertActive: () => void): Promise<void> {
  assertActive();
  const writer = currentPublishingWriter();
  if (writer === undefined) throw new Error("優待原文取込の共有writerがありません");
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
  const db = await publishingReadOnly(async () => createD1HttpDb(schema));
  // 取得経路だけでなく上書き前の全優待行を復元可能にする。原文・解釈をログには出さない。
  const previous = await publishingReadOnly(() => db.select().from(schema.yutaiBenefits));
  assertActive();
  const preimageBytes = Buffer.from(JSON.stringify(previous));
  const publication = await writer.reserve("yutai-source-import", { runId, sourceFetchedAt },
    JSON.stringify({ runId, sourceFetchedAt, previous, allData }));
  const preimage = await archivePages([{
    url: "D1:yutai_benefits before source import", receivedAt: new Date().toISOString(),
    status: null, contentType: "application/json", byteLength: preimageBytes.length,
    bodyBase64: preimageBytes.toString("base64"),
  }], `${runId}-preimage`, "D1 yutai_benefits complete row snapshot before source import (HTTP status not exposed)");
  if (preimage === undefined) throw new Error("優待の更新前スナップショットが無いためSTOP");
  assertActive();
  const result = await importYutaiFull(db, allData, createD1HttpBatchSender(), sourceFetchedAt);
  assertActive();
  const postRows = await publishingReadOnly(() => db.select().from(schema.yutaiBenefits));
  const postBytes = Buffer.from(JSON.stringify(postRows));
  const postimage = await archivePages([{
    url: "D1:yutai_benefits after source import", receivedAt: new Date().toISOString(),
    status: null, contentType: "application/json", byteLength: postBytes.length,
    bodyBase64: postBytes.toString("base64"),
  }], `${runId}-postimage`, "D1 yutai_benefits complete observed row snapshot after source import (HTTP status not exposed)");
  if (postimage === undefined) throw new Error("優待の取込後スナップショットが無いためSTOP");
  assertActive();
  const retired = await moveToTrash({ service: "otakara-yutai", originPageId: preimage.pageId,
    reason: `優待原文取込 ${runId} が成功。更新前の全行スナップショットを復元用に保管。` });
  await verifyArchivedAttachments(retired.trashPageId, preimage.files, "優待更新前スナップショット退避");
  assertActive();
  await publication.complete({ preArchivePageId: preimage.pageId, postArchivePageId: postimage.pageId,
    observedPostSha256: await sha256HexBytes(postBytes), observedPostRows: postRows.length,
    stockCount: result.stockCount, benefitCount: result.benefitCount });

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
  main(process.argv.slice(2)).catch(() => { console.error("優待取得・原本保管・取込のいずれかが失敗しました。取込開始後は更新済み銘柄があり得ます。原本と更新前スナップショットを保持してSTOP。再実行しないでください。"); process.exit(process.argv.length > 2 ? 2 : 1); });
}
