/**
 * JPX 新規上場銘柄一覧 (株式) の取得・厳密パース (Issue #196)。
 * 源泉 (2026-09-30 実測): https://www.jpx.co.jp/listing/stocks/new/index.html
 * 1 表・thead 二段 (上場日/会社名は rowspan=2)・tbody は 2 行 1 組
 * (奇行: 上場日・会社名・コード等 / 偶行: 市場区分等)。
 * 上場日セルは `上場日 （承認日）` 形式。承認日は使わない。
 * 被覆年は select.backnumber の唯一 selected。
 * 未来の上場予定も含むため listingDate<=target の判定は呼び出し側。
 * 会社概要/確認書のリンク先 PDF は取得しない (CompanyPDF=0)。
 */
import { sha256HexBytes } from "../sha256.js";
import {
  assertCoveredYears,
  assertPageTitle,
  companyNameFromCell,
  extractBackNumber,
  extractTables,
  parseOfficialCode,
  parseStrictDate,
  type RawCell,
  type RawTable,
} from "./official-html.js";

export const JPX_NEW_LISTINGS_URL =
  "https://www.jpx.co.jp/listing/stocks/new/index.html";
const JPX_NEW_LISTINGS_PATH = "/listing/stocks/new/index.html";
const JPX_NEW_LISTINGS_TITLE = "新規上場銘柄一覧";

export type NewListingsFetch = {
  url: string;
  fetchedAt: string;
  status: number;
  bytes: Uint8Array;
  sha256: string;
};

export async function fetchNewListingsHtml(): Promise<NewListingsFetch> {
  const started = Date.now();
  const res = await fetch(JPX_NEW_LISTINGS_URL, {
    headers: { "user-agent": "kabulab-universe/1.0 (+issue196)" },
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  // 非200 も body 付きで返す。status 検査・parse除外は collector 側 (B/C同時fix)。
  return {
    url: JPX_NEW_LISTINGS_URL,
    fetchedAt: new Date(started).toISOString(),
    status: res.status,
    bytes: buf,
    sha256: await sha256HexBytes(buf),
  };
}

export type NewListingRow = {
  code: string;
  companyName: string;
  /** 上場日 (ISO)。カッコ内承認日は使わない。 */
  listingDate: string;
  market: string;
  note: string;
};

/** 実測 thead cellText 展開形 (2026-09-30)。完全一致のみ受理。 */
export const NEW_LISTINGS_HEAD: readonly (readonly string[])[] = [
  [
    "上場日 （上場承認日）",
    "会社名 （注3）",
    "コード",
    "会社概要 （注4）",
    "確認書 （注6）",
    "仮条件（円）",
    "公募（千株）",
    "売買 単位",
  ],
  [
    "上場日 （上場承認日）",
    "会社名 （注3）",
    "市場区分",
    "Iの部 （注5）",
    "CG 報告書",
    "公募・売出価格 （円）",
    "売出（千株） （注7）",
    "決算 短信 （注8）",
  ],
];

/** 実測の市場値 (2026-09-30, 44/44組)。未知値は throw (fail-closed)。 */
export const NEW_LISTING_MARKETS = ["プライム", "スタンダード", "グロース"] as const;

function headMatches(table: RawTable): boolean {
  if (table.head.length !== NEW_LISTINGS_HEAD.length) return false;
  return NEW_LISTINGS_HEAD.every((want, r) => {
    const row = table.head[r] as RawCell[];
    if (row.length !== want.length) return false;
    return want.every((h, i) => row[i]?.text === h);
  });
}

/** thead 完全一致で表を選ぶ。0/複数は throw。 */
export function selectNewListingsTable(
  tables: readonly RawTable[]
): RawTable {
  const cands = tables.filter(headMatches);
  if (cands.length !== 1 || cands[0] === undefined) {
    throw new Error(
      `新規上場表の特定に失敗: 候補=${cands.length} (総表=${tables.length})`
    );
  }
  return cands[0];
}

/** 上場日セル: カッコ内承認日を捨て、最初の厳密日付だけ採用。 */
export function splitListingDateCell(cell: RawCell): string {
  const head = cell.text.split(/[（(]/, 1)[0]?.trim() ?? "";
  const iso = parseStrictDate(head);
  if (iso === null) {
    throw new Error(
      `新規上場日の厳密パースに失敗 (${JSON.stringify(cell.text)})`
    );
  }
  return iso;
}

export function parseNewListingsHtml(
  bytes: Uint8Array,
  opts: { yearWindow: readonly string[] }
): { rows: NewListingRow[]; coveredYears: string[]; tableIndex: number } {
  const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assertPageTitle(html, JPX_NEW_LISTINGS_TITLE, "new-listings");
  const backNumber = extractBackNumber(html, JPX_NEW_LISTINGS_PATH, "new-listings");
  assertCoveredYears(backNumber, opts.yearWindow, "new-listings");
  const table = selectNewListingsTable(extractTables(html));

  if (table.body.length % 2 !== 0) {
    throw new Error(`新規上場の行数が奇数: ${table.body.length}`);
  }
  const rows: NewListingRow[] = [];
  for (let p = 0; p < table.body.length; p += 2) {
    const odd = table.body[p] as RawCell[];
    const even = table.body[p + 1] as RawCell[];
    if (odd.length !== 8 || even.length !== 8) {
      throw new Error(
        `新規上場の組 ${p / 2}: 列数=${odd.length}/${even.length} (期待 8/8)`
      );
    }
    // rowspan=2 の複製検証 (構造変化の検知器)。
    if (
      even[0]?.text !== odd[0]?.text ||
      even[1]?.text !== odd[1]?.text
    ) {
      throw new Error(`新規上場の組 ${p / 2}: 2行組の複製不一致`);
    }
    const ctx = `新規上場の組 ${p / 2}`;
    const listingDate = splitListingDateCell(odd[0] as RawCell);
    const code = parseOfficialCode(odd[2]?.text ?? "", ctx);
    const nameCell = odd[1];
    if (nameCell === undefined || nameCell.text.length === 0) {
      throw new Error(`${ctx}: 会社名が空`);
    }
    const market = even[2]?.text ?? "";
    if (
      market !== NEW_LISTING_MARKETS[0] &&
      market !== NEW_LISTING_MARKETS[1] &&
      market !== NEW_LISTING_MARKETS[2]
    ) {
      throw new Error(`${ctx}: 未知の市場区分 (${JSON.stringify(market)})`);
    }
    const note = [...odd, ...even]
      .map((c) => c.text)
      .filter((t) => t.length > 0)
      .join(" / ");
    rows.push({
      code,
      companyName: companyNameFromCell(nameCell),
      listingDate,
      market,
      note,
    });
  }
  return {
    rows,
    coveredYears: [backNumber.coveredYear],
    tableIndex: table.tableIndex,
  };
}
