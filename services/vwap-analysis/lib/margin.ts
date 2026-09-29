// JPX「銘柄別信用取引週末残高」週次PDFを取得・解析（全銘柄・無料）。
import { createHash } from "node:crypto";
import { extractText, getDocumentProxy } from "unpdf";
import { marginCodeToKey } from "../../../src/shared/jpx/stock-code.js";
import type { MarginDailySnapshot } from "./margin-daily.js";
import { parseDailyMarginText } from "./margin-daily.js";
import { assertDistinctMarginCodes } from "./margin-select.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const BASE = "https://www.jpx.co.jp";
/**
 * 銘柄別信用取引週末残高の一覧ページ。
 * 2026-09-28 実測で週末残高 PDF (syumatsu*.pdf) は 05.html から 01.html
 * (銘柄別信用取引残高) へ移転した。05.html は信用取引現在高表のみになり
 * syumatsu リンクが 0 件のため、05.html のままでは発見できない。
 */
const PAGE = `${BASE}/markets/statistics-equities/margin/01.html`;

export interface MarginRow { code: string; sell: number; buy: number; sell_chg: number; buy_chg: number; }
export interface MarginData {
  week: string;
  rows: MarginRow[];
  /** 取得した PDF の実体 (ルール6: Notion 一次データへの実体アップロード用) */
  pdfBytes: Uint8Array;
  /** 取得元 PDF の URL (来歴用) */
  pdfUrl: string;
}

/**
 * 保存前の検証 (純関数)。週・行・物理原本のいずれかが空なら throw する。
 * 全 PUT (R2) より前に呼ぶこと — 保管失敗時の部分保存を防ぐため。
 */
export function validateMarginData(data: MarginData): void {
  if (!data.week) throw new Error("margin parse empty: 申込週が読めません");
  if (data.rows.length === 0) throw new Error("margin parse empty: 行が 0 件です");
  if (data.pdfBytes.byteLength === 0) {
    throw new Error("margin pdf empty: 原本バイト列が空です (保管できない)");
  }
  // 種類株崩壊の取込 (同一コードの複数行) は保存しない。崩壊週を R2 に書くと
  // 利用側が普通株・種類株を区別できなくなる (JSON に ISIN が無いため)。
  assertDistinctMarginCodes(data.rows);
}

// 一覧ページから syumatsu*.pdf のリンクを抜き出す純関数。
// stamp は `syumatsu2026091800.pdf` の `2026091800` 部分 (日付 YYYYMMDD + `00`)。
export function extractMarginPdfLinks(html: string): Array<{ url: string; stamp: string }> {
  const m = [...html.matchAll(/\/markets\/statistics-equities\/margin\/[^"']*?syumatsu(\d+)\.pdf/g)];
  return m.map((x) => ({ url: x[0], stamp: x[1] }));
}

/** 一覧 HTML から最新の syumatsu*.pdf の URL を得る純関数。無ければ throw する。 */
export function latestMarginPdfUrlFromHtml(html: string): string {
  const links = extractMarginPdfLinks(html);
  if (!links.length) throw new Error("margin pdf link not found");
  links.sort((a, b) => a.stamp.localeCompare(b.stamp));
  return BASE + links[links.length - 1]!.url;
}

/**
 * 一覧 HTML から指定週 (YYYYMMDD) の syumatsu*.pdf の URL を得る純関数。
 * 欠落週の手動補修 (`--week`) 用。該当が無ければ throw し、最新週で
 * 代用しない (ルール2: 別週の値を黙って使わない)。
 */
export function marginPdfUrlForWeekFromHtml(html: string, yyyymmdd: string): string {
  if (!/^\d{8}$/.test(yyyymmdd)) {
    throw new Error(`margin week の形式が不正です (YYYYMMDD): ${yyyymmdd}`);
  }
  const links = extractMarginPdfLinks(html).filter((l) => l.stamp.startsWith(yyyymmdd));
  if (!links.length) {
    throw new Error(`margin pdf link not found for week=${yyyymmdd} (一覧に該当週がありません)`);
  }
  links.sort((a, b) => a.stamp.localeCompare(b.stamp));
  return BASE + links[links.length - 1]!.url;
}

// 一覧ページから最新の syumatsu*.pdf の URL を得る。
export async function latestMarginPdfUrl(): Promise<string> {
  const html = await (await fetch(PAGE, { headers: { "User-Agent": UA } })).text();
  return latestMarginPdfUrlFromHtml(html);
}

/** 一覧ページから指定週 (YYYYMMDD) の syumatsu*.pdf の URL を得る。 */
export async function marginPdfUrlForWeek(yyyymmdd: string): Promise<string> {
  const html = await (await fetch(PAGE, { headers: { "User-Agent": UA } })).text();
  return marginPdfUrlForWeekFromHtml(html, yyyymmdd);
}

/**
 * 保存済み週 (R2 `margin/weeks.json` の内容) と今回の週から、欠落週を列挙する純関数。
 * 週ラベルは申込金曜 (YYYY-MM-DD)。保存済みと今回週の両端を結ぶ 7 日刻みの
 * 期待週のうち、保存済みになく今回でもない週を返す。末尾の欠落だけでなく
 * 区間内部の欠落 (7/3・7/10 の実例) も検出する。
 * 7/3・7/10 のように土曜 job を落とした週は後続の最新のみ取得で永久に飛ばされる
 * ため、欠落の検出だけでも明示する (推測補完はしない)。
 */
export function weeksMissing(savedWeeks: readonly string[], currentWeek: string): string[] {
  const fmt = /^\d{4}-\d{2}-\d{2}$/;
  if (!fmt.test(currentWeek)) {
    throw new Error(`margin week の形式が不正です (YYYY-MM-DD): ${currentWeek}`);
  }
  for (const w of savedWeeks) {
    if (!fmt.test(w)) throw new Error(`margin weeks.json の週形式が不正です (YYYY-MM-DD): ${w}`);
  }
  if (savedWeeks.length === 0) return [];
  const saved = new Set(savedWeeks);
  const lo = [...saved].reduce((a, b) => (a < b ? a : b));
  const hi = [...saved, currentWeek].reduce((a, b) => (a > b ? a : b));
  const out: string[] = [];
  const d = new Date(`${lo}T00:00:00Z`);
  for (;;) {
    const w = d.toISOString().slice(0, 10);
    if (w >= hi) break;
    if (w !== lo && !saved.has(w) && w !== currentWeek) out.push(w);
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
}

const toInt = (s: string) => parseInt(s.replace(/,/g, "").replace(/▲/g, "-").replace(/\s/g, ""), 10) || 0;

export function parseMarginText(
  text: string
): Pick<MarginData, "week" | "rows"> {
  const wk = text.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s*申込/);
  const week = wk ? `${wk[1]}-${wk[2].padStart(2, "0")}-${wk[3].padStart(2, "0")}` : "";
  const num = "(?:▲\\s*)?[\\d,]+";
  // 5桁コード(末尾照合) + JP始まりISIN + 売残/前週比/買残/前週比
  const re = new RegExp(`(\\d{3}[0-9A-Z]\\d)\\s+(JP\\w{10})\\s+(${num})\\s+(${num})\\s+(${num})\\s+(${num})`, "g");
  const rows: MarginRow[] = [];
  for (const mm of text.matchAll(re)) {
    // 末尾 "0" は 4 文字ティッカー、末尾 "1"-"9" (種類株) は 5 文字のまま。
    // 以前は無条件に slice(0, 4) しており、実 PDF で毎週 7 行の種類株を同社普通株の
    // コードへ潰していた (stockStock docs/CONTRACTS.md 銘柄コード契約)。
    // sourceCodeToTicker だとこの 7 行を落とすので使わない。
    const code = marginCodeToKey(mm[1]);
    // 正規表現が 5 文字目を数字に限るので null は起こり得ない。起きたら別銘柄として
    // 書くより、その回を失敗させる (ルール2: 不正値を黙って別の値にしない)。
    if (code === null) throw new Error(`margin code not interpretable: ${mm[1]}`);
    rows.push({
      code,
      sell: toInt(mm[3]), sell_chg: toInt(mm[4]),
      buy: toInt(mm[5]), buy_chg: toInt(mm[6]),
    });
  }
  return { week, rows };
}

/**
 * PDF バイト列から週・全銘柄行を抽出する。引数のバイト列は変更しない。
 *
 * unpdf の `getDocumentProxy()` は渡した Uint8Array の ArrayBuffer を worker へ
 * transfer して detach する (呼び出し後に byteLength が 0 になる。unpdf 1.6.2 /
 * Node 22 で実 PDF 873,311 bytes → 0 を実測)。原本を直接渡すと後段の Notion
 * 実体アップロードが「空ファイルはアップロードできません」で落ちる (#117) ため、
 * コピーを渡す (moneyflow の pdf-text.ts / run-spec.ts と同じ方式)。
 */
export async function parseMarginPdf(
  bytes: Uint8Array
): Promise<Pick<MarginData, "week" | "rows">> {
  const pdf = await getDocumentProxy(bytes.slice());
  const { text } = await extractText(pdf, { mergePages: true });
  return parseMarginText(text);
}

/**
 * 指定週 (YYYYMMDD) を取得する。省略時は最新週。
 * 指定週の場合は URL の stamp と PDF 本文の申込週が一致しなければ throw する
 * (JPX 側の取り違えを別週の値として保存しない)。
 */
export async function fetchMargin(requestedWeek?: string): Promise<MarginData> {
  const url = requestedWeek === undefined ? await latestMarginPdfUrl() : await marginPdfUrlForWeek(requestedWeek);
  const buf = await (await fetch(url, { headers: { "User-Agent": UA } })).arrayBuffer();
  const bytes = new Uint8Array(buf);
  const parsed = await parseMarginPdf(bytes);
  if (requestedWeek !== undefined && parsed.week.replaceAll("-", "") !== requestedWeek) {
    throw new Error(
      `margin week 不一致: 要求=${requestedWeek} に対して PDF 本文の申込週=${parsed.week} (URL=${url})`
    );
  }
  return { ...parsed, pdfBytes: bytes, pdfUrl: url };
}

/**
 * 日次 PDF (`YYYYMMDD_mtall.pdf`) 用の取得・解析。週次版とは別契約で、
 * 通常の取込・API・UI はこちらだけを使う (週次 PDF の公表は廃止)。
 */
export interface MarginDailyData {
  snapshot: MarginDailySnapshot;
  /** 取得した PDF の実体 (ルール6: Notion 一次データへの実体アップロード用) */
  pdfBytes: Uint8Array;
  /** 取得元 PDF の URL (来歴用) */
  pdfUrl: string;
}

// 一覧ページから YYYYMMDD_mtall.pdf のリンクを抜き出す純関数。
export function extractDailyMarginPdfLinks(html: string): Array<{ url: string; stamp: string }> {
  const m = [...html.matchAll(/\/markets\/statistics-equities\/margin\/[^"']*?(\d{8})_mtall\.pdf/g)];
  return m.map((x) => ({ url: x[0], stamp: x[1] }));
}

/** 一覧 HTML から最新の日次 PDF の URL を得る純関数。無ければ throw する。 */
export function latestDailyMarginPdfUrlFromHtml(html: string): string {
  const links = extractDailyMarginPdfLinks(html);
  if (!links.length) throw new Error("margin daily pdf link not found");
  links.sort((a, b) => a.stamp.localeCompare(b.stamp));
  return BASE + links[links.length - 1]!.url;
}

/**
 * 一覧 HTML から指定基準日 (YYYYMMDD) の日次 PDF の URL を得る純関数。
 * 該当が無ければ throw し、最新で代用しない (ルール2)。
 */
export function dailyMarginPdfUrlForDateFromHtml(html: string, yyyymmdd: string): string {
  if (!/^\d{8}$/.test(yyyymmdd)) {
    throw new Error(`margin date の形式が不正です (YYYYMMDD): ${yyyymmdd}`);
  }
  const links = extractDailyMarginPdfLinks(html).filter((l) => l.stamp === yyyymmdd);
  if (!links.length) {
    throw new Error(`margin daily pdf link not found for date=${yyyymmdd} (一覧に該当基準日がありません)`);
  }
  links.sort((a, b) => a.stamp.localeCompare(b.stamp));
  return BASE + links[links.length - 1]!.url;
}

/** 一覧ページから最新の日次 PDF の URL を得る。 */
export async function latestDailyMarginPdfUrl(): Promise<string> {
  const html = await (await fetch(PAGE, { headers: { "User-Agent": UA } })).text();
  return latestDailyMarginPdfUrlFromHtml(html);
}

/** 一覧ページから指定基準日 (YYYYMMDD) の日次 PDF の URL を得る。 */
export async function dailyMarginPdfUrlForDate(yyyymmdd: string): Promise<string> {
  const html = await (await fetch(PAGE, { headers: { "User-Agent": UA } })).text();
  return dailyMarginPdfUrlForDateFromHtml(html, yyyymmdd);
}

/**
 * PDF バイト列から日次スナップショットを抽出する。引数のバイト列は変更しない
 * (parseMarginPdf と同じくコピーを unpdf へ渡す — ArrayBuffer detach 対策)。
 * ページ結合はしない (行単位の正規表現のため。ページ跨ぎの行割れは
 * parseDailyMarginText が行スキャン+突合で吸収する)。
 */
export async function parseDailyMarginPdf(
  bytes: Uint8Array,
  provenance: { sourceUrl: string; rawSha256: string; rawPageId?: string | null }
): Promise<MarginDailySnapshot> {
  const pdf = await getDocumentProxy(bytes.slice());
  const { text } = await extractText(pdf);
  return parseDailyMarginText(text.join("\n"), provenance);
}

/**
 * 指定基準日 (YYYYMMDD) を取得する。省略時は最新。
 * 指定日の場合は PDF 本文の基準日が一致しなければ throw する
 * (JPX 側の取り違えを別日の値として保存しない)。
 */
export async function fetchDailyMargin(requestedDate?: string): Promise<MarginDailyData> {
  const url =
    requestedDate === undefined ? await latestDailyMarginPdfUrl() : await dailyMarginPdfUrlForDate(requestedDate);
  const buf = await (await fetch(url, { headers: { "User-Agent": UA } })).arrayBuffer();
  const bytes = new Uint8Array(buf);
  const rawSha256 = createHash("sha256").update(bytes).digest("hex");
  const snapshot = await parseDailyMarginPdf(bytes, { sourceUrl: url, rawSha256, rawPageId: null });
  if (requestedDate !== undefined && snapshot.basisDate.replaceAll("-", "") !== requestedDate) {
    throw new Error(
      `margin date 不一致: 要求=${requestedDate} に対して PDF 本文の基準日=${snapshot.basisDate} (URL=${url})`
    );
  }
  return { snapshot, pdfBytes: bytes, pdfUrl: url };
}

/**
 * ルール6: Notion 一次データ記録の入力を組み立てる純関数。
 * キーは基準日で冪等 (`jpx-margin-daily-YYYY-MM-DD`)。ファイルは PDF 実体。
 */
export function dailyMarginArchiveInput(data: MarginDailyData): {
  service: string;
  key: string;
  source: string;
  metadata: Record<string, unknown>;
  files: Array<{ bytes: Uint8Array; filename: string; contentType: string }>;
} {
  return {
    service: "vwap-analysis",
    key: `jpx-margin-daily-${data.snapshot.basisDate}`,
    source: data.pdfUrl,
    metadata: {
      basisDate: data.snapshot.basisDate,
      publicationDate: data.snapshot.publicationDate,
      format: data.snapshot.format,
      rowCount: data.snapshot.rows.length,
      bytes: data.pdfBytes.byteLength,
      sha256: data.snapshot.rawSha256,
    },
    files: [
      {
        bytes: data.pdfBytes,
        filename: `margin-daily-${data.snapshot.basisDate}.pdf`,
        contentType: "application/pdf",
      },
    ],
  };
}

/**
 * ルール6: Notion 一次データ記録の入力を組み立てる純関数。
 * キーは週次で冪等 (`jpx-margin-YYYY-MM-DD`)。ファイルは PDF 実体。
 */
export function marginArchiveInput(data: MarginData): {
  service: string;
  key: string;
  source: string;
  metadata: Record<string, unknown>;
  files: Array<{ bytes: Uint8Array; filename: string; contentType: string }>;
} {
  return {
    service: "vwap-analysis",
    key: `jpx-margin-${data.week}`,
    source: data.pdfUrl,
    metadata: {
      week: data.week,
      rowCount: data.rows.length,
      bytes: data.pdfBytes.byteLength,
    },
    files: [
      {
        bytes: data.pdfBytes,
        filename: `margin-${data.week}.pdf`,
        contentType: "application/pdf",
      },
    ],
  };
}
