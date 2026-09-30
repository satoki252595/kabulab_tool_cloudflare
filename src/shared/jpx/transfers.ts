/**
 * JPX 市場区分の変更銘柄一覧の取得・厳密パース (Issue #196)。
 * 源泉 (2026-09-30 実測): https://www.jpx.co.jp/listing/stocks/transfers/index.html
 * table#0 が当年表 (thead 一段 7 列)。table#1/#2 は年次アーカイブへの
 * 単行リンク表 (2022-04-03 以前 XLS・2023 再選択 XLS) で対象外。
 * XLS の取得は禁止のため触らない。被覆年は select.backnumber の唯一 selected。
 * 3477 (G→S) は適格のまま。
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
  type RawTable,
} from "./official-html.js";

export const JPX_TRANSFERS_URL =
  "https://www.jpx.co.jp/listing/stocks/transfers/index.html";
const JPX_TRANSFERS_PATH = "/listing/stocks/transfers/index.html";
const JPX_TRANSFERS_TITLE = "市場区分の変更銘柄一覧";

export type TransfersFetch = {
  url: string;
  fetchedAt: string;
  status: number;
  bytes: Uint8Array;
  sha256: string;
};

export async function fetchTransfersHtml(): Promise<TransfersFetch> {
  const started = Date.now();
  const res = await fetch(JPX_TRANSFERS_URL, {
    headers: { "user-agent": "kabulab-universe/1.0 (+issue196)" },
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  // 非200 も body 付きで返す。status 検査・parse除外は collector 側 (B/C同時fix)。
  return {
    url: JPX_TRANSFERS_URL,
    fetchedAt: new Date(started).toISOString(),
    status: res.status,
    bytes: buf,
    sha256: await sha256HexBytes(buf),
  };
}

export type TransferRow = {
  code: string;
  companyName: string;
  /** 変更日 (ISO)。不明行は throw。 */
  effectiveDate: string;
  fromMarket: string;
  toMarket: string;
  note: string;
};

/** 実測 thead cellText (2026-09-30)。完全一致のみ受理。 */
export const TRANSFERS_HEAD = [
  "変更日",
  "会社名 （注1）",
  "コード",
  "市場区分",
  "以前の市場区分",
  "幹事取引参加者 （注2）",
  "代表者インタビュー",
] as const;

/** 実測の市場値 (2026-09-30)。未知値は throw (fail-closed)。 */
export const TRANSFER_MARKETS = ["プライム", "スタンダード", "グロース"] as const;

function headMatches(table: RawTable): boolean {
  if (table.head.length !== 1) return false;
  const row = table.head[0] as { text: string }[];
  if (row.length !== TRANSFERS_HEAD.length) return false;
  return TRANSFERS_HEAD.every((h, i) => row[i]?.text === h);
}

/** thead 完全一致で表を選ぶ。0/複数は throw。 */
export function selectTransfersTable(
  tables: readonly RawTable[]
): RawTable {
  const cands = tables.filter(headMatches);
  if (cands.length !== 1 || cands[0] === undefined) {
    throw new Error(
      `transfers 表の特定に失敗: 候補=${cands.length} (総表=${tables.length})`
    );
  }
  return cands[0];
}

function knownMarket(text: string): boolean {
  return (
    text === TRANSFER_MARKETS[0] ||
    text === TRANSFER_MARKETS[1] ||
    text === TRANSFER_MARKETS[2]
  );
}

export function parseTransfersHtml(
  bytes: Uint8Array,
  opts: { yearWindow: readonly string[] }
): { rows: TransferRow[]; coveredYears: string[]; tableIndex: number } {
  const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assertPageTitle(html, JPX_TRANSFERS_TITLE, "transfers");
  const backNumber = extractBackNumber(html, JPX_TRANSFERS_PATH, "transfers");
  assertCoveredYears(backNumber, opts.yearWindow, "transfers");
  const table = selectTransfersTable(extractTables(html));

  const rows: TransferRow[] = [];
  for (let i = 0; i < table.body.length; i++) {
    const row = table.body[i] as { text: string; html: string }[];
    if (row.length !== 7) {
      throw new Error(`transfers 行 ${i}: 列数=${row.length} (期待 7)`);
    }
    const dateText = row[0]?.text ?? "";
    const effectiveDate = parseStrictDate(dateText);
    if (effectiveDate === null) {
      throw new Error(
        `transfers 行 ${i}: 変更日の厳密パースに失敗 (${JSON.stringify(dateText)})`
      );
    }
    const ctx = `transfers 行 ${i}`;
    const code = parseOfficialCode(row[2]?.text ?? "", ctx);
    const nameCell = row[1];
    if (nameCell === undefined || nameCell.text.length === 0) {
      throw new Error(`${ctx}: 会社名が空`);
    }
    const toMarket = row[3]?.text ?? "";
    const fromMarket = row[4]?.text ?? "";
    if (!knownMarket(toMarket) || !knownMarket(fromMarket)) {
      throw new Error(
        `${ctx}: 未知の市場 (${JSON.stringify(fromMarket)}→${JSON.stringify(toMarket)})`
      );
    }
    rows.push({
      code,
      companyName: companyNameFromCell(nameCell),
      effectiveDate,
      fromMarket,
      toMarket,
      note: row
        .map((c) => c.text)
        .filter((t) => t.length > 0)
        .join(" / "),
    });
  }
  return {
    rows,
    coveredYears: [backNumber.coveredYear],
    tableIndex: table.tableIndex,
  };
}
