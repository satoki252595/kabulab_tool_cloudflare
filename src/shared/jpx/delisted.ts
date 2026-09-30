/**
 * JPX 上場廃止銘柄一覧 (株式) の取得・厳密パース (Issue #196)。
 * 源泉 (2026-09-30 実測): https://www.jpx.co.jp/listing/stocks/delisted/index.html
 * 1 表・thead 一段 [上場廃止日,銘柄名,コード,市場区分,上場廃止理由]・span 無し。
 * 被覆年は select.backnumber の唯一 selected (行の未来日付は証拠にしない)。
 * 未来の廃止予定日も含むため effectiveDate<=eligibility の判定は呼び出し側。
 */
import { sha256Hex, sha256HexBytes } from "../sha256.js";
import {
  assertCoveredYears,
  assertPageTitle,
  companyNameFromCell,
  extractBackNumber,
  extractTables,
  parseOfficialCode,
  parseStrictDate,
  type RawTable,
} from "./official-html.js";

export const JPX_DELISTED_URL =
  "https://www.jpx.co.jp/listing/stocks/delisted/index.html";
const JPX_DELISTED_PATH = "/listing/stocks/delisted/index.html";
const JPX_DELISTED_TITLE = "上場廃止銘柄一覧";

/** 取得生バイト束 (custody へ直送する中間形式)。 */
export type DelistedFetch = {
  url: string;
  fetchedAt: string;
  status: number;
  bytes: Uint8Array;
  sha256: string;
};

export async function fetchDelistedHtml(): Promise<DelistedFetch> {
  const started = Date.now();
  const res = await fetch(JPX_DELISTED_URL, {
    headers: { "user-agent": "kabulab-universe/1.0 (+issue196)" },
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  // 非200 も body 付きで返す。status 検査・parse除外は collector 側 (B/C同時fix)。
  return {
    url: JPX_DELISTED_URL,
    fetchedAt: new Date(started).toISOString(),
    status: res.status,
    bytes: buf,
    sha256: await sha256HexBytes(buf),
  };
}

export type DelistedRow = {
  code: string;
  companyName: string;
  /** 上場廃止日 (ISO)。不明・非形式の行は落とさず throw。 */
  effectiveDate: string;
  market: string;
  reason: string;
};

/** 実測 thead cellText (2026-09-30)。完全一致のみ受理。 */
export const DELISTED_HEAD = [
  "上場廃止日",
  "銘柄名",
  "コード",
  "市場区分",
  "上場廃止理由",
] as const;

function headMatches(table: RawTable): boolean {
  if (table.head.length !== 1) return false;
  const row = table.head[0] as { text: string }[];
  if (row.length !== DELISTED_HEAD.length) return false;
  return DELISTED_HEAD.every((h, i) => row[i]?.text === h);
}

/** thead 完全一致で表を選ぶ。0/複数は throw。 */
export function selectDelistedTable(tables: readonly RawTable[]): RawTable {
  const cands = tables.filter(headMatches);
  if (cands.length !== 1 || cands[0] === undefined) {
    throw new Error(
      `delisted 表の特定に失敗: 候補=${cands.length} (総表=${tables.length})`
    );
  }
  return cands[0];
}

/**
 * delisted 生バイト → 厳密行列。opts.yearWindow は (base, elig] 被覆。
 * 行内列数は 5 固定。日付・コード・銘柄名のいずれかが欠ければ throw。
 */
export function parseDelistedHtml(
  bytes: Uint8Array,
  opts: { yearWindow: readonly string[] }
): { rows: DelistedRow[]; coveredYears: string[]; tableIndex: number } {
  const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assertPageTitle(html, JPX_DELISTED_TITLE, "delisted");
  const backNumber = extractBackNumber(html, JPX_DELISTED_PATH, "delisted");
  assertCoveredYears(backNumber, opts.yearWindow, "delisted");
  const table = selectDelistedTable(extractTables(html));

  const rows: DelistedRow[] = [];
  for (let i = 0; i < table.body.length; i++) {
    const row = table.body[i] as { text: string; html: string }[];
    if (row.length !== 5) {
      throw new Error(`delisted 行 ${i}: 列数=${row.length} (期待 5)`);
    }
    const dateText = row[0]?.text ?? "";
    const effectiveDate = parseStrictDate(dateText);
    if (effectiveDate === null) {
      throw new Error(
        `delisted 行 ${i}: 廃止日の厳密パースに失敗 (${JSON.stringify(dateText)})`
      );
    }
    const code = parseOfficialCode(row[2]?.text ?? "", `delisted 行 ${i}`);
    const nameCell = row[1];
    if (nameCell === undefined || nameCell.text.length === 0) {
      throw new Error(`delisted 行 ${i}: 銘柄名が空`);
    }
    rows.push({
      code,
      companyName: companyNameFromCell(nameCell),
      effectiveDate,
      market: row[3]?.text ?? "",
      reason: row[4]?.text ?? "",
    });
  }
  return {
    rows,
    coveredYears: [backNumber.coveredYear],
    tableIndex: table.tableIndex,
  };
}

/**
 * custody archiveKey。3 ソースの生 SHA を順序固定で連結して SHA256 化し
 * 先頭 12hex を取る。delisted 先頭だけでは IPO/transfers 変化が落ちる。
 */
export async function officialEventsArchiveKey(rawShas: {
  delisted: string;
  newListings: string;
  transfers: string;
}): Promise<string> {
  const joined = rawShas.delisted + rawShas.newListings + rawShas.transfers;
  const digest = await sha256Hex(joined);
  return digest.slice(0, 12);
}
