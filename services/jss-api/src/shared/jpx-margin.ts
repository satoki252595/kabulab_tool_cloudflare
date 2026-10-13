/** 既存日次JPX原本派生を読む。JSFの貸借項目へ変換しない。 */
import { sourceCodeToTicker } from "../../../../src/shared/jpx/stock-code";
import {
  MARGIN_DAILY_FORMAT,
  selectDailyMarginRows,
  validateDailyMarginSnapshot,
  type MarginDailyFigures,
  type MarginDailySnapshot,
} from "../../../vwap-analysis/lib/margin-daily";

const MAX_BYTES = 8 * 1024 ** 2;
export const JPX_PAGE_DAYS = 20;
export class MarginCursorError extends Error {}
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const isSupplyCode = (code: string) => /^[0-9]{3}[0-9A-Z][0-9]?$/.test(code);

export async function boundedBytes(object: R2ObjectBody, max: number): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(object.size) || object.size <= 0 || object.size > max) {
    throw new Error("需給R2 sizeが範囲外");
  }
  const reader = object.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      if (size > max || size > object.size) throw new Error("需給R2 bytesが範囲外");
      chunks.push(item.value);
    }
  } finally { await reader.cancel(); }
  if (size !== object.size) throw new Error("需給R2 bytes不一致");
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

async function json(bucket: R2Bucket, key: string, max: number): Promise<unknown> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`需給R2が無い: ${key}`);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await boundedBytes(object, max)));
}

export async function marginDates(bucket: R2Bucket): Promise<string[]> {
  const value = await json(bucket, "margin/dates.json", 128 * 1024);
  if (!Array.isArray(value) || value.length > 10000 || value.some(d => typeof d !== "string" || !DATE.test(d) || new Date(d).toISOString().slice(0, 10) !== d)) {
    throw new Error("JPX日付indexが不正");
  }
  if (new Set(value).size !== value.length) throw new Error("JPX日付indexが重複");
  return (value as string[]).sort().reverse();
}

function figures(value: MarginDailyFigures): void {
  if (!value || typeof value !== "object") throw new Error("JPX figures欠損");
  const fields = ["sellOutstanding", "sellChg", "sellListedRatio", "sellListedRatioRaw", "buyOutstanding", "buyChg", "buyListedRatio", "buyListedRatioRaw", "negSell", "negSellChg", "stdSell", "stdSellChg", "negBuy", "negBuyChg", "stdBuy", "stdBuyChg"];
  if (Object.keys(value).sort().join() !== [...fields].sort().join()) throw new Error("JPX figures shape不一致");
  for (const [name, v] of Object.entries(value)) {
    if (name.endsWith("Raw")) {
      if (typeof v !== "string" || !/^(?:\*|-|[0-9]+(?:\.[0-9]+)?%)$/.test(v)) throw new Error("JPX ratio原文不正");
    } else if (v === null) {
      if (!name.endsWith("Chg") && !name.endsWith("Ratio")) throw new Error("JPX残高欠損");
    } else if (typeof v !== "number" || !Number.isFinite(v) || (!name.endsWith("Ratio") && !Number.isSafeInteger(v))) {
      throw new Error("JPX数値不正");
    }
  }
  for (const side of ["sell", "buy"] as const) {
    const raw = value[`${side}ListedRatioRaw`], ratio = value[`${side}ListedRatio`];
    if ((raw === "*" || raw === "-") ? ratio !== null : ratio !== Number(raw.slice(0, -1))) throw new Error("JPX ratio原文値不一致");
  }
  for (const side of ["Sell", "Buy"] as const) {
    const total = value[side === "Sell" ? "sellOutstanding" : "buyOutstanding"];
    if (total < 0 || value[`neg${side}`] < 0 || value[`std${side}`] < 0 || value[`neg${side}`] + value[`std${side}`] !== total) throw new Error("JPX残高内訳不一致");
  }
}

export async function marginSnapshot(bucket: R2Bucket, basis: string): Promise<MarginDailySnapshot> {
  const s = await json(bucket, `margin/daily/${basis}.json`, MAX_BYTES) as MarginDailySnapshot;
  if (!s || s.format !== MARGIN_DAILY_FORMAT || s.basisDate !== basis || !DATE.test(s.publicationDate) || !Number.isFinite(Date.parse(s.publicationDate)) || new Date(s.publicationDate).toISOString().slice(0, 10) !== s.publicationDate || s.publicationDate < basis || !/^https:\/\/www\.jpx\.co\.jp\//.test(s.sourceUrl) || !/^[a-f0-9]{64}$/.test(s.rawSha256) || typeof s.rawPageId !== "string" || !/^[a-f0-9-]{32,36}$/.test(s.rawPageId)) throw new Error("JPX原本来歴が不正");
  if (!Array.isArray(s.rows) || s.rows.length === 0 || s.rows.length > 10000 || !Array.isArray(s.totals) || s.totals.length !== 19) throw new Error("JPX行数が範囲外");
  const seen = new Set<string>();
  for (const row of s.rows) {
    if (Object.keys(row).sort().join() !== ["sourceCode", "name", "ordinaryTicker", "eligible", "unitLetter", "sectype", "market", "loanKind", "isin", "shares", "amounts"].sort().join() || !isSupplyCode(row.sourceCode) || row.sourceCode.length !== 5 || seen.has(row.sourceCode) || typeof row.name !== "string" || !row.name || (row.sectype !== null && typeof row.sectype !== "string") || (row.isin !== null && (typeof row.isin !== "string" || !/^[A-Z0-9]{12}$/.test(row.isin))) || row.eligible !== (row.ordinaryTicker !== null && row.sectype === "普通株式") || (row.ordinaryTicker !== sourceCodeToTicker(row.sourceCode)) || !["A", "J", "K", "B", "M", "C", "T", "F"].includes(row.unitLetter) || !["プライム", "スタンダード", "グロース", "投信等"].includes(row.market) || !["貸", "制", "他"].includes(row.loanKind)) throw new Error("JPX銘柄同定が不正");
    seen.add(row.sourceCode); figures(row.shares); figures(row.amounts);
  }
  for (const total of s.totals) {
    if (Object.keys(total).sort().join() !== ["label", "scope", "market", "count", "shares", "amounts"].sort().join() || !Number.isSafeInteger(total.count) || total.count < 0) throw new Error("JPX合計shape不正");
    figures(total.shares); figures(total.amounts);
  }
  validateDailyMarginSnapshot(s);
  return s;
}

function source(s: MarginDailySnapshot) {
  return { url: s.sourceUrl, raw_sha256: s.rawSha256, archive_page_id: s.rawPageId, basis_date: s.basisDate, publication_date: s.publicationDate, fetched_at: null };
}

export async function marginLatest(bucket: R2Bucket): Promise<Record<string, unknown>[]> {
  const dates = await marginDates(bucket);
  if (!dates.length) return [];
  const s = await marginSnapshot(bucket, dates[0]!);
  return s.rows.map(row => ({ code: row.ordinaryTicker === null ? row.sourceCode : row.ordinaryTicker, data_type: "jpx_margin", data_date: s.basisDate, ...row, units: { shares: "shares", amounts: "JPY", listed_ratio: "percent" }, source: source(s), license_tag: "personal-only" }));
}

export function marginPage(dates: string[], options: { from?: string; to?: string; cursor?: string }) {
  if (options.cursor && !dates.includes(options.cursor)) throw new MarginCursorError("JPX cursorがindexに無い");
  const filtered = dates.filter(d => (!options.from || d >= options.from) && (!options.to || d <= options.to) && (!options.cursor || d <= options.cursor));
  return { selected: filtered.slice(0, JPX_PAGE_DAYS), cursor: filtered[JPX_PAGE_DAYS] ?? null };
}

export async function marginSeries(bucket: R2Bucket, code: string, options: { from?: string; to?: string; cursor?: string }) {
  const all = await marginDates(bucket);
  const { selected, cursor } = marginPage(all, options);
  const points: Record<string, unknown>[] = [];
  for (const date of selected) {
    const s = await marginSnapshot(bucket, date);
    const result = selectDailyMarginRows(s.rows, code);
    if (result.status === "ambiguous") throw new Error("JPX銘柄が曖昧");
    if (result.status === "ok") points.push({ d: s.basisDate, ...result.row, units: { shares: "shares", amounts: "JPY", listed_ratio: "percent" }, source: source(s) });
  }
  return { points: points.reverse(), cursor };
}
