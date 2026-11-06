/**
 * JPX「空売り集計・業種別集計」日次 PDF の取得・解析 (東証33業種別・無料)。
 *
 * 出典: https://www.jpx.co.jp/markets/statistics-equities/short-selling/index.html
 * の「業種別集計」列 (`YYMMDD-g.pdf`。「空売り集計」列の `YYMMDD-m.pdf` は
 * 市場全体・業種別ではないので本モジュールの対象外)。
 * 当月は index、過去月は select.backnumber の 00-archives-NN.html。要求日の
 * 行が無いときは別日へ代用しない。月次の欠け判定は
 * `src/shared/market-calendar.ts`（JPX 公式休業日）を使う。
 *
 * 列は 実注文(a) / 空売り・価格規制あり(b) / 空売り・価格規制なし(c) / 合計(d)。
 * 空売り比率 = (b+c)/d (計画書「使う指標」)。比率であって金額の流入出ではない点に注意
 * (指標定義 DB の説明文に明記する — indicators.ts)。
 *
 * 「その他（33業種外）」行は ETF・REIT・優先出資証券の合計値 (PDF 注記) なので
 * 33 業種には含めず、`other` として別に返す。
 *
 * ライセンス: JPX サイト統計は personal-only。moneyflow の Notion 保管のみに使う。
 */
import { marketClosure } from "../../../src/shared/market-calendar.js";
import { extractPdfText } from "./pdf-text.js";
import { assertExactly33Sectors, JPX_33_SECTORS } from "./sector-names.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const BASE = "https://www.jpx.co.jp";
const LISTING_PAGE = `${BASE}/markets/statistics-equities/short-selling/index.html`;
const OTHER_LABEL = "その他（33業種外）";

export interface ShortSellingRow {
  /** 実注文の売買代金 (a、百万円) */
  realOrder: number;
  /** 空売り・価格規制ありの売買代金 (b、百万円) */
  restrictedShort: number;
  /** 空売り・価格規制なしの売買代金 (c、百万円) */
  unrestrictedShort: number;
  /** 合計売買代金 (d = a+b+c、百万円) */
  total: number;
  /** 空売り比率 = (b+c)/d。0〜1。 */
  /** 空売り比率 (0〜1)。売買代金が 0 の日は比率が定義できないため null (0 で埋めない — ルール2)。 */
  shortRatio: number | null;
}

export interface ShortSellingData {
  /** YYYY-MM-DD */
  date: string;
  /** 33 業種別 (PDF 掲載順)。 */
  sectors: Array<ShortSellingRow & { sector: string }>;
  /** ETF・REIT・優先出資証券の合計値 (33業種には含めない)。 */
  other: ShortSellingRow;
  pdfBytes: Uint8Array;
  pdfUrl: string;
  /**
   * 公式一覧が明示した 0 件日（業種別 PDF が無い行）。
   * fetchShortSellingSector だけが付ける。未設定を空配列とみなさない。
   */
  officialZeroDates?: readonly string[];
}

const toInt = (s: string): number => parseInt(s.replace(/,/g, ""), 10);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface RawRow {
  name: string;
  realOrder: number;
  restrictedShort: number;
  unrestrictedShort: number;
  total: number;
}

function toRow(r: RawRow): ShortSellingRow {
  const shortAmount = r.restrictedShort + r.unrestrictedShort;
  return {
    realOrder: r.realOrder,
    restrictedShort: r.restrictedShort,
    unrestrictedShort: r.unrestrictedShort,
    total: r.total,
    shortRatio: r.total > 0 ? shortAmount / r.total : null,
  };
}

/**
 * PDF 抽出テキストを解析する (純関数)。
 *
 * @throws 日付が取れない、33 業種が過不足なく揃わない、「その他（33業種外）」
 *   行が見つからない場合 (様式変更を疑い throw — ルール2)。
 */
export function parseShortSellingSectorText(text: string): Omit<ShortSellingData, "pdfBytes" | "pdfUrl"> {
  const dateMatch = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(text);
  if (!dateMatch) {
    throw new Error("jpx-short-selling: 日付 (YYYY年M月D日) が見つかりません");
  }
  const date = `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}`;

  const candidates = [...JPX_33_SECTORS, OTHER_LABEL].map(escapeRegExp);
  const num = "([\\d,]+)";
  const pct = "[\\d.]+%";
  const pattern = `(${candidates.join("|")})\\s+${num}\\s+${pct}\\s+${num}\\s+${pct}\\s+${num}\\s+${pct}\\s+${num}`;
  const re = new RegExp(pattern, "g");

  const rows: RawRow[] = [];
  for (const m of text.matchAll(re)) {
    rows.push({
      name: m[1],
      realOrder: toInt(m[2]),
      restrictedShort: toInt(m[3]),
      unrestrictedShort: toInt(m[4]),
      total: toInt(m[5]),
    });
  }
  const byName = new Map(rows.map((r) => [r.name, r]));

  assertExactly33Sectors(
    JPX_33_SECTORS.filter((name) => byName.has(name)),
    "jpx-short-selling"
  );

  const sectors = JPX_33_SECTORS.map((name) => {
    const row = byName.get(name);
    if (!row) throw new Error(`jpx-short-selling: 業種「${name}」の行が見つかりません`);
    return { sector: name, ...toRow(row) };
  });

  const otherRaw = byName.get(OTHER_LABEL);
  if (!otherRaw) {
    throw new Error(`jpx-short-selling: 「${OTHER_LABEL}」行が見つかりません (様式変更の疑い)`);
  }

  return { date, sectors, other: toRow(otherRaw) };
}

/**
 * 日次一覧の「業種別集計」列から文字列比較で最新の URL を得る。
 * 取込は使わない。要求日は fetchShortSellingSector が index/archives から解決し、
 * 無い日を別日で代用しない。
 */
export async function latestShortSellingSectorPdfUrl(): Promise<{ url: string; date: string }> {
  const html = await (await fetch(LISTING_PAGE, { headers: { "User-Agent": UA } })).text();
  const m = [...html.matchAll(/href="([^"]*\/(\d{6})-g\.pdf)"/g)];
  if (!m.length) throw new Error("jpx-short-selling: 業種別集計 PDF リンクが見つかりません");
  m.sort((a, b) => a[2].localeCompare(b[2]));
  const [, path, yymmdd] = m[m.length - 1];
  const date = `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
  return { url: BASE + path, date };
}

const LISTING_PATH = "/markets/statistics-equities/short-selling/index.html";
const ARCHIVE_PATH_RE = /^\/markets\/statistics-equities\/short-selling\/00-archives-\d{2}\.html$/;
const ZERO_MARKERS = new Set(["-", "－", "―", "—", "0件", "該当なし"]);

export interface ShortSellingBackNumberOption {
  path: string;
  /** YYYY-MM */
  month: string;
  selected: boolean;
}

export interface ShortSellingListingEntry {
  date: string;
  /** null は公式行が業種別 PDF なし（明示の 0 件）。 */
  sectorPdfPath: string | null;
}

function assertIsoDate(date: string): string {
  const stamp = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== date) {
    throw new Error(`jpx-short-selling: 日付が不正です: ${date}`);
  }
  return date;
}

function eachIsoDate(from: string, through: string): string[] {
  const out: string[] = [];
  let cursor = from;
  while (cursor <= through) {
    out.push(cursor);
    cursor = new Date(Date.parse(`${cursor}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  }
  return out;
}

function plain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function assertListingPath(path: string): void {
  if (path === LISTING_PATH || ARCHIVE_PATH_RE.test(path)) return;
  throw new Error(`jpx-short-selling: バックナンバーの path が想定外です: ${path}`);
}

function monthFromLabel(label: string): string {
  const m = /^(20\d{2})年(\d{1,2})月$/.exec(label);
  if (!m?.[1] || !m[2]) {
    throw new Error(`jpx-short-selling: バックナンバーの月表示が想定外です: ${JSON.stringify(label)}`);
  }
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`jpx-short-selling: バックナンバーの月が不正です: ${label}`);
  return `${m[1]}-${String(month).padStart(2, "0")}`;
}

/** index / archives の select.backnumber。月ラベルは `2026年11月`。 */
export function parseShortSellingBackNumber(html: string): ShortSellingBackNumberOption[] {
  const selects = [...html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)]
    .filter((m) => /\bclass\s*=\s*["'][^"']*\bbacknumber\b/i.test(m[1] ?? ""));
  if (selects.length !== 1 || selects[0]?.[2] === undefined) {
    throw new Error(`jpx-short-selling: select.backnumber が ${selects.length} 個です`);
  }
  const options: ShortSellingBackNumberOption[] = [];
  for (const match of selects[0][2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)) {
    const attrs = match[1] ?? "";
    const label = plain(match[2] ?? "");
    const value = /\bvalue\s*=\s*"([^"]*)"/i.exec(attrs)?.[1];
    if (!value) throw new Error(`jpx-short-selling: バックナンバーの path がありません: ${label}`);
    assertListingPath(value);
    options.push({ path: value, month: monthFromLabel(label), selected: /\bselected\b/i.test(attrs) });
  }
  if (options.length === 0) throw new Error("jpx-short-selling: バックナンバーが空です");
  if (options.filter((o) => o.selected).length !== 1) {
    throw new Error(`jpx-short-selling: 選択中のバックナンバーが ${options.filter((o) => o.selected).length} 件です`);
  }
  const months = new Set<string>();
  const paths = new Set<string>();
  for (const option of options) {
    if (months.has(option.month)) throw new Error(`jpx-short-selling: バックナンバーの月 ${option.month} が重複しています`);
    if (paths.has(option.path)) throw new Error(`jpx-short-selling: バックナンバーの path が重複しています: ${option.path}`);
    months.add(option.month);
    paths.add(option.path);
  }
  return options;
}

/** 要求月の一覧 path。無ければ throw し、隣の月では代用しない。 */
export function shortSellingListingPathForMonth(
  options: readonly ShortSellingBackNumberOption[],
  month: string,
): string {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`jpx-short-selling: 要求月が不正です: ${month}`);
  const hits = options.filter((o) => o.month === month);
  if (hits.length !== 1 || hits[0] === undefined) {
    throw new Error(`jpx-short-selling: 要求月 ${month} は index/archives にありません (${hits.length} 件)`);
  }
  return hits[0].path;
}

function hrefsOf(cell: string): string[] {
  return [...cell.matchAll(/href="([^"]*)"/g)].map((m) => m[1] ?? "").filter((href) => href !== "");
}

function pdfPathForCell(cell: string, rowDate: string, kind: "g" | "m"): string | null {
  const text = plain(cell);
  const hrefs = hrefsOf(cell);
  if (hrefs.length === 0) {
    if (text === "") throw new Error(`jpx-short-selling: ${rowDate} のセルが空です`);
    if (!ZERO_MARKERS.has(text)) {
      throw new Error(`jpx-short-selling: ${rowDate} のセルがPDFでも0件でもありません: ${JSON.stringify(text)}`);
    }
    return null;
  }
  if (hrefs.length !== 1) throw new Error(`jpx-short-selling: ${rowDate} のリンクが ${hrefs.length} 件です`);
  const path = hrefs[0] as string;
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("..")) {
    throw new Error(`jpx-short-selling: PDF path が不正です: ${path}`);
  }
  const matched = new RegExp(`/(\\d{2})(\\d{2})(\\d{2})-${kind}\\.pdf$`).exec(path);
  if (!matched?.[1] || !matched[2] || !matched[3]) {
    throw new Error(`jpx-short-selling: ${rowDate} の ${kind} PDF のファイル名が不正です: ${path}`);
  }
  const fileDate = assertIsoDate(`20${matched[1]}-${matched[2]}-${matched[3]}`);
  if (fileDate !== rowDate) {
    throw new Error(`jpx-short-selling: ファイル名の日付 ${fileDate} が行の日付 ${rowDate} と一致しません (${path})`);
  }
  return path;
}

/** 1 か月分の日次表。pagePath は選択中 option の value と一致しなければならない。 */
export function parseShortSellingListingHtml(
  html: string,
  pagePath: string,
): { month: string; entries: ShortSellingListingEntry[] } {
  assertListingPath(pagePath);
  const selected = parseShortSellingBackNumber(html).find((option) => option.selected);
  if (!selected || selected.path !== pagePath) {
    throw new Error(`jpx-short-selling: 一覧の選択月がページ ${pagePath} と一致しません`);
  }
  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)];
  const hits = tables.filter((table) => {
    const body = table[1] ?? "";
    return body.includes("業種別集計") && body.includes("空売り集計") && body.includes("日付");
  });
  if (hits.length !== 1 || hits[0]?.[1] === undefined) {
    throw new Error(`jpx-short-selling: 日次集計表が ${hits.length} 個です`);
  }
  const entries: ShortSellingListingEntry[] = [];
  for (const row of hits[0][1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const tds = [...(row[1] ?? "").matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1] ?? "");
    if (tds.length === 0) continue;
    if (tds.length !== 3) throw new Error(`jpx-short-selling: 日次集計の列数が ${tds.length} です`);
    const label = plain(tds[0] ?? "");
    const dm = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(label);
    if (!dm?.[1] || !dm[2] || !dm[3]) throw new Error(`jpx-short-selling: 日付セルが不正です: ${JSON.stringify(label)}`);
    const date = assertIsoDate(`${dm[1]}-${dm[2].padStart(2, "0")}-${dm[3].padStart(2, "0")}`);
    if (date.slice(0, 7) !== selected.month) {
      throw new Error(`jpx-short-selling: 行 ${date} が一覧の月 ${selected.month} の外です`);
    }
    if (entries.some((entry) => entry.date === date)) {
      throw new Error(`jpx-short-selling: 掲載日 ${date} が重複しています`);
    }
    const market = pdfPathForCell(tds[1] ?? "", date, "m");
    const sector = pdfPathForCell(tds[2] ?? "", date, "g");
    if ((market === null) !== (sector === null)) {
      throw new Error(`jpx-short-selling: ${date} の空売り集計と業種別集計の有無が一致しません`);
    }
    entries.push({ date, sectorPdfPath: sector });
  }
  return { month: selected.month, entries };
}

/** 要求日の業種別 PDF。0 件行・行なしは throw し、別日の path は返さない。 */
export function resolveShortSellingSectorPdf(
  entries: readonly ShortSellingListingEntry[],
  requestedDate: string,
): { url: string } {
  assertIsoDate(requestedDate);
  const hits = entries.filter((entry) => entry.date === requestedDate);
  if (hits.length !== 1 || hits[0] === undefined) {
    const published = entries.map((entry) => entry.date).join(", ") || "なし";
    throw new Error(`jpx-short-selling: 要求日 ${requestedDate} は index/archives にありません (掲載日: ${published})`);
  }
  if (hits[0].sectorPdfPath === null) {
    throw new Error(`jpx-short-selling: 要求日 ${requestedDate} は公式の0件のため業種別PDFがありません`);
  }
  return { url: BASE + hits[0].sectorPdfPath };
}

export function shortSellingDateFromArchiveKey(key: string): string {
  const matched = /^jpx-short-selling-sector-(\d{4}-\d{2}-\d{2})$/.exec(key);
  if (!matched?.[1]) throw new Error(`jpx-short-selling: 保管キーの日付が読めません: ${key}`);
  return assertIsoDate(matched[1]);
}

/**
 * 対象月の 1 日〜 through の JPX 営業日のうち、保管 PDF も公式 0 件もない日。
 * 休場は `src/shared/market-calendar.ts` の `marketClosure("JPX")`
 * （出典 https://www.jpx.co.jp/corporate/about-jpx/calendar/ 、データは
 * `src/shared/market-calendar.json`）。未収録年は営業日を推定せず例外のまま止める。
 * through より後は対象外（将来日・当月のまだ来ていない日）。
 */
export function missingShortSellingBusinessDays(input: {
  through: string;
  storedDates: readonly string[];
  officialZeroDates: readonly string[];
}): string[] {
  const through = assertIsoDate(input.through);
  const month = through.slice(0, 7);
  const stored = new Set<string>();
  for (const raw of input.storedDates) {
    const date = assertIsoDate(raw);
    if (date.slice(0, 7) !== month) throw new Error(`jpx-short-selling: 保管日 ${date} は対象月 ${month} の外です`);
    if (date > through) continue;
    if (stored.has(date)) throw new Error(`jpx-short-selling: 保管日 ${date} が重複しています`);
    const closed = marketClosure("JPX", date);
    if (closed) throw new Error(`jpx-short-selling: 保管日 ${date} はJPX休場（${closed.reason}）です`);
    stored.add(date);
  }
  const zeros = new Set<string>();
  for (const raw of input.officialZeroDates) {
    const date = assertIsoDate(raw);
    if (date.slice(0, 7) !== month) throw new Error(`jpx-short-selling: 公式0件 ${date} は対象月 ${month} の外です`);
    if (date > through) continue;
    if (zeros.has(date)) throw new Error(`jpx-short-selling: 公式0件 ${date} が重複しています`);
    const closed = marketClosure("JPX", date);
    if (closed) throw new Error(`jpx-short-selling: 公式0件 ${date} はJPX休場（${closed.reason}）です`);
    if (stored.has(date)) throw new Error(`jpx-short-selling: ${date} は公式0件なのに保管PDFがあります`);
    zeros.add(date);
  }
  const missing: string[] = [];
  for (const date of eachIsoDate(`${month}-01`, through)) {
    if (marketClosure("JPX", date)) continue;
    if (!stored.has(date) && !zeros.has(date)) missing.push(date);
  }
  return missing;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`jpx-short-selling: 一覧取得失敗 status=${res.status} url=${url}`);
  return res.text();
}

/** 要求日の業種別 PDF だけを取る。最新日や別月では埋めない。 */
export async function fetchShortSellingSector(requestedDate: string): Promise<ShortSellingData> {
  assertIsoDate(requestedDate);
  const today = new Date().toISOString().slice(0, 10);
  if (requestedDate > today) {
    throw new Error(`jpx-short-selling: 要求日 ${requestedDate} は将来日のため取得しません (今日 ${today})`);
  }
  const indexHtml = await fetchText(LISTING_PAGE);
  const path = shortSellingListingPathForMonth(parseShortSellingBackNumber(indexHtml), requestedDate.slice(0, 7));
  const pageHtml = path === LISTING_PATH ? indexHtml : await fetchText(`${BASE}${path}`);
  const listing = parseShortSellingListingHtml(pageHtml, path);
  if (listing.month !== requestedDate.slice(0, 7)) {
    throw new Error(`jpx-short-selling: 一覧の月 ${listing.month} が要求月 ${requestedDate.slice(0, 7)} と一致しません`);
  }
  const { url } = resolveShortSellingSectorPdf(listing.entries, requestedDate);
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`jpx-short-selling: PDF 取得失敗 status=${res.status} url=${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error(`jpx-short-selling: PDF が空です url=${url}`);
  // bytes は一次データとして保管するため、解析にはコピーを渡す (pdf-text.ts 参照)
  const parsed = parseShortSellingSectorText(await extractPdfText(bytes));
  if (parsed.date !== requestedDate) {
    throw new Error(`jpx-short-selling: PDF本文の日付 ${parsed.date} が要求日 ${requestedDate} と一致しません (url=${url})`);
  }
  return {
    ...parsed,
    pdfBytes: bytes,
    pdfUrl: url,
    officialZeroDates: listing.entries.filter((entry) => entry.sectorPdfPath === null).map((entry) => entry.date),
  };
}

/** ルール6: Notion 一次データ記録の入力を組み立てる純関数。キーは日次で冪等。 */
export function shortSellingArchiveInput(data: ShortSellingData): {
  service: string;
  key: string;
  source: string;
  metadata: Record<string, unknown>;
  files: Array<{ bytes: Uint8Array; filename: string; contentType: string }>;
} {
  return {
    service: "moneyflow",
    key: `jpx-short-selling-sector-${data.date}`,
    source: data.pdfUrl,
    metadata: {
      date: data.date,
      sectorCount: data.sectors.length,
      other: data.other,
      bytes: data.pdfBytes.byteLength,
    },
    files: [
      {
        bytes: data.pdfBytes,
        filename: `jpx-short-selling-sector-${data.date}.pdf`,
        contentType: "application/pdf",
      },
    ],
  };
}

/**
 * 日次データを月次に集計する (観測ログには月次のみ書く設計)。
 * 比率は単純平均ではなく、業種別に「その月の売買代金合計に占める空売り売買代金合計」
 * (加重平均) で求める (1 日ごとの比率を単純平均すると、出来高の小さい日の比率が
 * 出来高の大きい日と同じ重みになり歪む)。
 *
 * @param dailyRows 同一月内の日次データ。空配列は throw (集計対象が無いのに
 *   「0」を返さない — ルール2)。
 */
export function aggregateMonthlyShortSellingRatio(
  dailyRows: readonly Omit<ShortSellingData, "pdfBytes" | "pdfUrl">[]
): {
  month: string;
  /** shortRatio は当月の売買代金合計が 0 の業種だけ null (比率が定義できない。0 で埋めない — ルール2)。 */
  sectors: Array<{ sector: string; shortRatio: number | null; totalTurnover: number; tradingDays: number }>;
} {
  if (dailyRows.length === 0) {
    throw new Error("aggregateMonthlyShortSellingRatio: 集計対象の日次データが 0 件です");
  }
  const months = new Set(dailyRows.map((r) => r.date.slice(0, 7)));
  if (months.size !== 1) {
    throw new Error(
      `aggregateMonthlyShortSellingRatio: 複数の月が混在しています: ${[...months].join(", ")}`
    );
  }
  const month = [...months][0];

  const bySector = new Map<string, { shortAmount: number; total: number; tradingDays: number }>();
  for (const day of dailyRows) {
    for (const row of day.sectors) {
      const cur = bySector.get(row.sector) ?? { shortAmount: 0, total: 0, tradingDays: 0 };
      cur.shortAmount += row.restrictedShort + row.unrestrictedShort;
      cur.total += row.total;
      cur.tradingDays += 1;
      bySector.set(row.sector, cur);
    }
  }

  const sectors = JPX_33_SECTORS.map((sector) => {
    const agg = bySector.get(sector);
    if (!agg) {
      throw new Error(`aggregateMonthlyShortSellingRatio: 業種「${sector}」のデータがありません`);
    }
    return {
      sector,
      shortRatio: agg.total > 0 ? agg.shortAmount / agg.total : null,
      totalTurnover: agg.total,
      tradingDays: agg.tradingDays,
    };
  });

  return { month, sectors };
}
