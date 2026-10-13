/** 株式保有の当期明細。平文化CSV・株価・会社名から株数や上場区分を推定しない。 */
import { unzip } from "./zip.js";
import { extractTables, tableToGridExpanded, unitToYenFactor } from "./html-table.js";
import { stripHtml } from "./text-sections.js";

export interface ShareholdingsSource {
  docId: string;
  stockCode: string;
  edinetCode: string | null;
  fiscalYearEnd: string;
}

export interface Shareholding {
  name: string;
  kind: "特定投資株式" | "みなし保有株式";
  shares: number | null;
  sharesRaw: number | null;
  sharesUnit: "株" | "千株";
  bookValueYen: number | null;
  bookValueRaw: number | null;
  bookValueUnit: "円" | "千円" | "百万円";
  listingStatus: "unknown";
  price: null;
  priceDate: null;
  priceCurrency: null;
  tableIndex: number;
  rowIndex: number;
}

export interface ShareholdingsExtraction {
  status: "ok" | "no_detail_table" | "unsupported";
  reason: string | null;
  source: ShareholdingsSource;
  filename: string | null;
  elementId: "jpcrp_cor:ShareholdingsTextBlock";
  contextRef: string | null;
  holdings: Shareholding[];
}

const normalize = (text: string) => text.normalize("NFKC").replace(/\s/g, "");

/** nonNumericは入れ子と自己閉じnilを含む。最初の閉じタグでは切らない。 */
function shareholdingsBlocks(html: string): Array<{ html: string; contextRef: string | null; continued: boolean }> {
  const blocks: Array<{ html: string; contextRef: string | null; continued: boolean }> = [];
  let start = -1, depth = 0, contextRef: string | null = null, continued = false;
  for (const match of html.matchAll(/<\/?ix:nonNumeric\b[^>]*>/gi)) {
    const tag = match[0];
    const closing = tag.startsWith("</"), selfClosing = /\/\s*>$/.test(tag);
    if (start < 0) {
      if (closing || !/\bname=["']jpcrp_cor:ShareholdingsTextBlock["']/.test(tag)) continue;
      if (selfClosing) continue;
      start = match.index + tag.length;
      depth = 1;
      const context = /\bcontextRef=["']([^"']+)["']/.exec(tag);
      contextRef = context === null ? null : context[1];
      continued = /\bcontinuedAt=/.test(tag);
      continue;
    }
    if (!selfClosing) depth += closing ? -1 : 1;
    if (depth !== 0) continue;
    blocks.push({ html: html.slice(start, match.index), contextRef, continued });
    start = -1;
  }
  if (start >= 0) throw new Error("株式保有TextBlockの終端が不明です");
  return blocks;
}

/** 明示非開示はNULL。注記付き・桁区切り不正などは構造を確定させない。 */
function numberCell(text: string): number | null | undefined {
  const value = normalize(text);
  if (/^(?:-|－|―|—)$/.test(value)) return null;
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value)) return undefined;
  const number = Number(value.replaceAll(",", ""));
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

export function parseShareholdingsData(zip: Buffer, source: ShareholdingsSource): ShareholdingsExtraction {
  if (!/^S[0-9A-Z]+$/.test(source.docId) || !/^[0-9A-Z]{4}$/.test(source.stockCode) ||
      (source.edinetCode !== null && !/^E\d{5}$/.test(source.edinetCode)) || !/^\d{4}-\d{2}-\d{2}$/.test(source.fiscalYearEnd) ||
      new Date(`${source.fiscalYearEnd}T00:00:00Z`).toISOString().slice(0, 10) !== source.fiscalYearEnd) {
    throw new Error("株式保有の書類識別・会計期末が不正です");
  }
  const result: ShareholdingsExtraction = { status: "no_detail_table", reason: "株数・単位・当期を確認できる明細表がありません", source,
    filename: null, elementId: "jpcrp_cor:ShareholdingsTextBlock", contextRef: null, holdings: [] };
  if (source.edinetCode === null) return { ...result, status: "unsupported", reason: "提出者EDINETコードが未確定です" };
  const candidates = [];
  for (const [filename, bytes] of unzip(zip)) {
    if (!/\/PublicDoc\//.test(filename) || !/\.html?$/.test(filename)) continue;
    for (const block of shareholdingsBlocks(bytes.toString("utf8"))) candidates.push({ filename, ...block });
  }
  if (candidates.length === 0) return result;
  if (candidates.length !== 1) return { ...result, status: "unsupported", reason: "株式保有TextBlockが複数あり、採用元を確定できません" };
  const block = candidates[0];
  result.filename = block.filename;
  result.contextRef = block.contextRef;
  if (!block.filename.includes(`_${source.edinetCode}-`) || !block.filename.includes(`_${source.fiscalYearEnd}_`) ||
      block.contextRef !== "FilingDateInstant" || block.continued) {
    return { ...result, status: "unsupported", reason: "提出者・会計期末・本文の完全性を確認できません" };
  }
  const tables = extractTables(block.html);
  let lastEnd = 0;
  for (const [tableIndex, table] of tables.entries()) {
    const start = block.html.indexOf(table, lastEnd);
    const before = stripHtml(block.html.slice(0, start));
    lastEnd = start + table.length;
    const grid = tableToGridExpanded(table);
    if (grid.length < 4 || !grid[0].some(c => normalize(c) === "銘柄") ||
        !grid.slice(0, 3).some(row => row.some(c => c.includes("株式数")))) continue;
    if (grid.some(row => row.length < 3)) {
      return { ...result, status: "unsupported", reason: "明細表の列数が不足しています", holdings: [] };
    }
    const kind = [...before.matchAll(/特定投資株式|みなし保有株式/g)].at(-1)?.[0];
    const sharesUnit = /^株式数\((株|千株)\)$/.exec(normalize(grid[1][1]));
    const bookUnit = /^貸借対照表計上額\((円|千円|百万円)\)$/.exec(normalize(grid[2][1]));
    if ((kind !== "特定投資株式" && kind !== "みなし保有株式") ||
        normalize(grid[0][0]) !== "銘柄" || normalize(grid[0][1]) !== "当事業年度" ||
        normalize(grid[0][2]) !== "前事業年度" || !sharesUnit || !bookUnit ||
        normalize(grid[1][2]) !== normalize(grid[1][1]) || normalize(grid[2][2]) !== normalize(grid[2][1]) ||
        (grid.length - 3) % 2 !== 0) {
      return { ...result, status: "unsupported", reason: "明細表の保有種別・当期列・株数単位・金額単位を確認できません", holdings: [] };
    }
    for (let rowIndex = 3; rowIndex < grid.length; rowIndex += 2) {
      const row = grid[rowIndex], book = grid[rowIndex + 1];
      const sharesRaw = numberCell(row[1]), bookValueRaw = numberCell(book[1]);
      if (!row[0] || normalize(row[0]) !== normalize(book[0]) || /^\d+$/.test(normalize(row[0])) ||
          sharesRaw === undefined || bookValueRaw === undefined) {
        return { ...result, status: "unsupported", reason: "銘柄名と株数・帳簿価額の行対応を確認できません", holdings: [] };
      }
      const shareLabel = sharesUnit[1] as "株" | "千株", moneyLabel = bookUnit[1] as "円" | "千円" | "百万円";
      const shares = sharesRaw === null ? null : sharesRaw * (shareLabel === "千株" ? 1000 : 1);
      const bookValueYen = bookValueRaw === null ? null : bookValueRaw * unitToYenFactor(moneyLabel);
      if ((shares !== null && (!Number.isFinite(shares) || shares > Number.MAX_SAFE_INTEGER)) ||
          (bookValueYen !== null && !Number.isSafeInteger(bookValueYen))) {
        return { ...result, status: "unsupported", reason: "単位換算後の数値を安全に保存できません", holdings: [] };
      }
      result.holdings.push({ name: row[0], kind, shares, sharesRaw, sharesUnit: shareLabel, bookValueYen, bookValueRaw,
        bookValueUnit: moneyLabel, listingStatus: "unknown", price: null, priceDate: null, priceCurrency: null, tableIndex, rowIndex });
    }
  }
  if (new Set(result.holdings.map(holding => normalize(holding.name))).size !== result.holdings.length) {
    return { ...result, status: "unsupported", reason: "同名銘柄の複数明細があり、既存行との対応を一意に確定できません", holdings: [] };
  }
  if (result.holdings.length > 0) return { ...result, status: "ok", reason: null };
  return result;
}
