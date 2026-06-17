/**
 * EDINET CSV (書類取得 API type=5) のパーサ。
 *
 * EDINET の「CSV」は実体が UTF-16LE / TAB 区切り、全フィールドを二重引用符で
 * 囲んだ形式 (BOM 付き, CRLF 改行)。テキストブロック要素の「値」には HTML が
 * 入り、その中に TAB / 改行 / 引用符 ("" でエスケープ) を含む。したがって
 * 行で単純 split せず、引用符状態を持つトークナイザで分解する。
 *
 * ヘッダ: 要素ID / 項目名 / コンテキストID / 相対年度 / 連結・個別 /
 *         期間・時点 / ユニットID / 単位 / 値
 *
 * 1 ZIP に有報本体 (jpcrp...) と監査報告書 (jpaud...) の CSV が含まれる。
 * 受注高/受注残高 を含む本文は有報本体側のテキストブロック要素に入る。
 *
 * ルール2: 列構成が想定と違う / 本体 CSV が見つからない 等は throw。
 * 既定値で埋めて続行しない。
 */
import { unzip } from "./zip.js";

export interface EdinetCsvRow {
  /** 要素ID (XBRL 名前空間付き — 例: jpcrp_cor:XxxTextBlock) */
  elementId: string;
  /** 項目名 (日本語ラベル) */
  itemName: string;
  contextId: string;
  /** 相対年度 (例: CurrentYearDuration / Prior1YearDuration) */
  relativeYear: string;
  /** 連結・個別 */
  consolidatedOrNonConsolidated: string;
  /** 期間・時点 */
  periodOrInstant: string;
  unitId: string;
  unit: string;
  /** 値 (テキストブロックの場合 HTML 文字列が入る) */
  value: string;
}

const EXPECTED_HEADER = [
  "要素ID",
  "項目名",
  "コンテキストID",
  "相対年度",
  "連結・個別",
  "期間・時点",
  "ユニットID",
  "単位",
  "値",
];

function decodeUtf16le(buf: Buffer): string {
  let b = buf;
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) b = b.subarray(2);
  return b.toString("utf16le");
}

/**
 * 二重引用符付き TAB 区切りを RFC4180 風にトークナイズ。
 * - フィールド区切り: TAB / レコード区切り: LF (引用符外のみ)
 * - フィールドは "..." で囲まれ、"" は引用符 1 文字を表す
 * - CR は (引用符外で) 無視 (CRLF 対策)
 */
function tokenizeTsv(text: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let started = false; // フィールド開始済みか (空フィールドと未開始の区別)

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      started = true;
    } else if (ch === "\t") {
      row.push(field);
      field = "";
      started = false;
    } else if (ch === "\n") {
      row.push(field);
      records.push(row);
      row = [];
      field = "";
      started = false;
    } else if (ch === "\r") {
      // CRLF の CR は無視
    } else {
      field += ch;
      started = true;
    }
  }
  if (started || field.length > 0 || row.length > 0) {
    row.push(field);
    records.push(row);
  }
  return records;
}

/**
 * 有報本体 CSV (jpcrp で始まり jpaud でない) の行を返す。
 * @param zipBuf 書類取得 API type=5 の ZIP バイト列
 */
export function parseEdinetCsvZip(zipBuf: Buffer): EdinetCsvRow[] {
  const entries = unzip(zipBuf);

  const csvNames = [...entries.keys()].filter((n) =>
    n.toLowerCase().endsWith(".csv")
  );
  if (csvNames.length === 0) {
    throw new Error("EDINET CSV ZIP に .csv が含まれていません");
  }
  const mainName = csvNames.find((n) => {
    const base = n.split("/").pop() ?? n;
    return base.startsWith("jpcrp") && !base.startsWith("jpaud");
  });
  if (!mainName) {
    throw new Error(
      `有報本体 CSV (jpcrp*) が見つかりません: [${csvNames.join(", ")}]`
    );
  }

  const text = decodeUtf16le(entries.get(mainName)!);
  const records = tokenizeTsv(text);
  if (records.length === 0) {
    throw new Error(`EDINET CSV が空です: ${mainName}`);
  }

  const header = records[0];
  for (let i = 0; i < EXPECTED_HEADER.length; i++) {
    if (header[i] !== EXPECTED_HEADER[i]) {
      throw new Error(
        `EDINET CSV ヘッダが想定外: 期待[${EXPECTED_HEADER.join(",")}] 実際[${header.join(",")}]`
      );
    }
  }

  const rows: EdinetCsvRow[] = [];
  for (let i = 1; i < records.length; i++) {
    const c = records[i];
    if (c.length < 9) continue; // 末尾の空レコード等
    rows.push({
      elementId: c[0],
      itemName: c[1],
      contextId: c[2],
      relativeYear: c[3],
      consolidatedOrNonConsolidated: c[4],
      periodOrInstant: c[5],
      unitId: c[6],
      unit: c[7],
      value: c.slice(8).join("\t"),
    });
  }
  return rows;
}
