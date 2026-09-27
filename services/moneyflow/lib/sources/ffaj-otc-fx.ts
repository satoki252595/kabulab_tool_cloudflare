/**
 * 取得元: 金融先物取引業協会 (FFAJ) 店頭FX月次速報
 *
 * https://www.ffaj.or.jp/library/performance/fx_flash/
 *
 * 資料室ページに毎月「取引状況」「主要通貨建玉」「通貨ペア別取引金額」
 * 「預託額情報」の 4 xls へのリンクが並ぶ。本モジュールはこのうち以下の
 * 3 ファイルのみ扱う（「通貨ペア別取引金額」は対象外 — 理由は下記）:
 *
 *   - trading_vol_and_position.xls : シート "ALL(TOTAL)" に全通貨ペア合計の
 *     月次「取引金額・売建・買建・建玉計」。ここが R1 の要求する
 *     「店頭FXの取引高・建玉」の本体。
 *   - open_position_with_mc.xls     : シート "Data" に主要9通貨
 *     (JPY/USD/EUR/GBP/AUD/NZD/CHF/CAD/ZAR) 別の取引金額・売建・買建・
 *     買越額(ネット)。通貨別の内訳が要るのはここだけ。
 *   - deposit_amount_information.xls: シート "DATA" に顧客区分管理必要額
 *     (預託証拠金) の月次入出金・残高・信託額・信託保全率。
 *
 * 「通貨ペア別取引金額 (trading_vol_by_cp.xls)」は対象外にした:
 *   (1) 全体の取引金額・建玉は trading_vol_and_position.xls の
 *       ALL(TOTAL) シートで、主要通貨別の内訳は open_position_with_mc.xls
 *       で既に取れる（取引金額・売建・買建の列がある）。
 *   (2) このファイルは月別シートが 2008 年分まで並ぶ 1.6MB 超の巨大な
 *       時系列アーカイブで、「最新月」だけを見る本取得元の範囲を超える。
 *   将来この取得元の担当が「マイナー通貨ペアの内訳」を必要とする場合は
 *   別途このファイル用のパーサを追加すること。
 *
 * ライセンス/利用条件 (2026-09-27 時点で確認できた事実。詳細は
 * `__fixtures__/ffaj-otc-fx/README.md` も参照):
 *   FFAJ サイトの著作権表示 (/exception/matters/) は「原則として協会が
 *   著作権を有する。著作権法を遵守すること」という一般的な文言のみで、
 *   JPX 統計のような「商用目的のデータ収集・二次利用・再配信の明示的
 *   禁止」条項は確認できなかった。ただし commercial_use は unknown
 *   (未確認) — 個人利用の範囲に留め、公開経路へ出す前に要確認。
 *
 * ブラウザ相当 UA について: このリポジトリには複数の取得元ファイル
 * (src/shared/jpx/sectors.ts, src/shared/yahoo/client.ts,
 * services/vwap-analysis/lib/margin.ts 等) が同じ UA 文字列をそれぞれ
 * ローカルに複製しており、import できる共有定数モジュールは存在しない
 * (2026-09-27 時点)。並行して他の取得元を実装しているエージェントとの
 * 衝突を避けるため、本ファイルでも同じ文字列をローカルに定義する。
 * 将来の統合時に共有モジュールへ抽出することを妨げない。
 */

import * as XLSX from "xlsx";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export const FFAJ_INDEX_URL = "https://www.ffaj.or.jp/library/performance/fx_flash/";
export const FFAJ_SOURCE_NAME = "金融先物取引業協会(FFAJ) 店頭FX月次速報";

// ---------------------------------------------------------------------------
// (1) 最新ファイルの URL 解決 + 取得
// ---------------------------------------------------------------------------

export interface FfajIndexPage {
  /** ページの「更新日」(YYYY-MM-DD) */
  updatedOn: string;
  /** ページ見出しの対象月 (YYYY-MM)。この月までのデータが公表済み。 */
  latestPublishedMonth: string;
  tradingVolAndPositionUrl: string;
  openPositionWithMcUrl: string;
  depositAmountInformationUrl: string;
}

function extractFileUrl(html: string, filename: string): string {
  const re = new RegExp(
    `href="(https://www\\.ffaj\\.or\\.jp/wp-content/uploads/\\d{4}/\\d{2}/${filename.replace(/\./g, "\\.")})"`
  );
  const m = html.match(re);
  if (!m) {
    throw new Error(
      `FFAJ 資料室ページ: ${filename} へのリンクが見つかりません（様式変更の可能性）`
    );
  }
  return m[1];
}

/**
 * FFAJ 資料室 (fx_flash) の index HTML から、更新日・対象月・3 ファイルの
 * URL を取り出す。見つからない要素があれば、様式変更を疑ってすぐ throw する
 * (ルール2: 見つからない時に空文字や null で黙って埋めない)。
 */
export function parseFfajIndexPage(html: string): FfajIndexPage {
  const updatedMatch = html.match(/更新日[：:]\s*(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  if (!updatedMatch) {
    throw new Error('FFAJ 資料室ページ: 「更新日」が見つかりません（様式変更の可能性）');
  }
  const updatedOn = `${updatedMatch[1]}-${updatedMatch[2].padStart(2, "0")}-${updatedMatch[3].padStart(2, "0")}`;

  const monthMatch = html.match(/component-header-B01__heading">\s*(\d{4})年(\d{1,2})月/);
  if (!monthMatch) {
    throw new Error("FFAJ 資料室ページ: 対象月の見出しが見つかりません（様式変更の可能性）");
  }
  const latestPublishedMonth = `${monthMatch[1]}-${monthMatch[2].padStart(2, "0")}`;

  return {
    updatedOn,
    latestPublishedMonth,
    tradingVolAndPositionUrl: extractFileUrl(html, "trading_vol_and_position.xls"),
    openPositionWithMcUrl: extractFileUrl(html, "open_position_with_mc.xls"),
    depositAmountInformationUrl: extractFileUrl(html, "deposit_amount_information.xls"),
  };
}

/** 資料室ページを 1 回だけ取得して構造化する。 */
export async function fetchFfajIndexPage(): Promise<{ html: string; page: FfajIndexPage }> {
  const res = await fetch(FFAJ_INDEX_URL, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    throw new Error(
      `FFAJ 資料室ページ HTTP エラー: ${res.status} ${res.statusText} (${FFAJ_INDEX_URL})`
    );
  }
  const html = await res.text();
  return { html, page: parseFfajIndexPage(html) };
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    throw new Error(`FFAJ ファイル取得 HTTP エラー: ${res.status} ${res.statusText} (${url})`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

export interface FfajOtcFxRawFiles {
  page: FfajIndexPage;
  tradingVolAndPosition: Uint8Array;
  openPositionWithMc: Uint8Array;
  depositAmountInformation: Uint8Array;
}

/**
 * 最新の 3 ファイルを取得する。1 回の実行で index ページ 1 回 + xls 3 回、
 * 計 4 リクエストのみ (JPX 等と同様、実行あたり必要最小限のアクセスに絞る)。
 *
 * 取得直後に、資料室ページが宣言する最新公表月 (`page.latestPublishedMonth`) と、
 * 実際にダウンロードした 3 ファイルの内容 (先頭行の月) が一致するかを検証する
 * (`assertFfajOtcFxMonthConsistency`)。ページと xls の間にキャッシュ遅延・様式変更
 * などによるズレが生じていないかをその場で確かめ、不一致なら throw する
 * (ルール2: 不整合を無視して処理を続けない)。
 */
export async function fetchLatestFfajOtcFx(): Promise<FfajOtcFxRawFiles> {
  const { page } = await fetchFfajIndexPage();
  const [tradingVolAndPosition, openPositionWithMc, depositAmountInformation] = await Promise.all([
    fetchBytes(page.tradingVolAndPositionUrl),
    fetchBytes(page.openPositionWithMcUrl),
    fetchBytes(page.depositAmountInformationUrl),
  ]);
  const parsed = parseFfajOtcFxFiles({ tradingVolAndPosition, openPositionWithMc, depositAmountInformation });
  assertFfajOtcFxMonthConsistency(page, parsed);
  return { page, tradingVolAndPosition, openPositionWithMc, depositAmountInformation };
}

// ---------------------------------------------------------------------------
// (2) 純関数パーサ: バイト列 → 型付きレコード
// ---------------------------------------------------------------------------

function assertFiniteNumber(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`FFAJ ${where}: 数値ではありません: ${JSON.stringify(value)}`);
  }
  return value;
}

/** 月次シートの 1 行から YYYY-MM を作る。年/月どちらの並びの列かは呼び出し側が指定する。 */
function monthKey(year: unknown, month: unknown, where: string): string {
  if (typeof year !== "number" || typeof month !== "number") {
    throw new Error(
      `FFAJ ${where}: 年/月が数値ではありません (year=${JSON.stringify(year)}, month=${JSON.stringify(month)})`
    );
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`FFAJ ${where}: 月の値が不正です: ${month}`);
  }
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error(`FFAJ ${where}: 年の値が不正です: ${year}`);
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** データ行が終わり、シート末尾の空行パディングに入ったかどうか。 */
function isBlankRow(row: unknown[] | undefined): boolean {
  return !row || (row[0] === "" && row[1] === "");
}

/**
 * `start` 行目から最初の空行 (年/月の列が空) の直前までをデータ行として返す。
 * 空行より後ろに 1 セルでも値がある行が残っていれば throw する。実ファイル
 * (2026-09-27 取得) は末尾が完全な空行パディングのみ (SheetJS の範囲で
 * ALL(TOTAL) は 239 行中データ 214 行 + 空行 15 行、DATA は 152 行中データ
 * 137 行 + 空行 3 行)。途中に空行が挟まる様式変更 (年の区切り行の追加等) が
 * あった場合に、そこから後ろの履歴を黙って切り捨てないため (ルール2)。
 */
function takeDataRows(rows: unknown[][], start: number, where: string): unknown[][] {
  let end = start;
  while (end < rows.length && !isBlankRow(rows[end])) end++;
  for (let j = end; j < rows.length; j++) {
    const row = rows[j];
    if (Array.isArray(row) && row.some((cell) => cell !== "")) {
      throw new Error(
        `FFAJ ${where}: 空行 (${end} 行目) より後ろの ${j} 行目に値があります（途中の空行・様式変更の可能性）: ` +
          `${JSON.stringify(row.filter((cell) => cell !== ""))}`
      );
    }
  }
  return rows.slice(start, end);
}

/**
 * 同じ月の行が 2 回現れたら throw する。観測ログは「期間|指標|区分」で冪等 upsert
 * されるため、重複月があると後の行が先の行を黙って上書きしてしまう (ルール2)。
 * 実ファイル (2026-09-27 取得) では全シートで月は重複しない (新しい月から降順)。
 */
function assertUniqueMonth(seen: Set<string>, month: string, where: string): void {
  if (seen.has(month)) {
    throw new Error(`FFAJ ${where}: 同じ月 (${month}) の行が重複しています（様式変更・原資料の誤りの可能性）`);
  }
  seen.add(month);
}

const MONTHLY_DATA_START_ROW = 10;
/** trading_vol_and_position.xls / open_position_with_mc.xls 共通: 「単位: 百万円」行の位置。 */
const UNIT_LABEL_ROW = 6;

/**
 * シート冒頭の「単位: ○○」表示行に、期待する単位の文字列 (例: "百万円") が
 * 含まれているかを検証する。ヘッダー列のラベル (取引金額/売建/買建 等) が変わらない
 * まま単位だけが変更された場合、列名の一致検証だけでは気づけず、値を誤った桁で
 * 読み違えたまま処理が進んでしまう (ルール2: 想定外の状態を無視して続行しない)。
 */
function assertUnitLabel(rows: unknown[][], rowIndex: number, expectedUnit: string, where: string): void {
  const row = rows[rowIndex];
  const ok = Array.isArray(row) && row.some((cell) => typeof cell === "string" && cell.includes(expectedUnit));
  if (!ok) {
    throw new Error(
      `FFAJ ${where}: 単位表示 ("${expectedUnit}") が見つかりません（単位変更・様式変更の可能性）: ` +
        `${JSON.stringify(row)}`
    );
  }
}

export interface FfajMarketTotalRow {
  /** YYYY-MM */
  month: string;
  turnoverMillionYen: number;
  shortPositionMillionYen: number;
  longPositionMillionYen: number;
  totalPositionMillionYen: number;
}

/** trading_vol_and_position.xls のシート "ALL(TOTAL)" を解析する。 */
export function parseTradingVolAndPosition(bytes: Uint8Array): FfajMarketTotalRow[] {
  const workbook = XLSX.read(bytes, { type: "array" });
  const sheet = workbook.Sheets["ALL(TOTAL)"];
  if (!sheet) {
    throw new Error('FFAJ trading_vol_and_position.xls: シート "ALL(TOTAL)" が見つかりません（様式変更の可能性）');
  }
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });

  const header = rows[9];
  const expectedHeaders = ["取引金額", "売建", "買建", "建玉計"];
  const headerOk =
    Array.isArray(header) &&
    expectedHeaders.every(
      (label, i) => typeof header[2 + i] === "string" && (header[2 + i] as string).includes(label)
    );
  if (!headerOk) {
    throw new Error(
      "FFAJ trading_vol_and_position.xls: ヘッダー列 (取引金額/売建/買建/建玉計) が想定と異なります（様式変更の可能性）"
    );
  }
  // 実ファイル (2026-09-27 取得) の 7 行目は "単位: 百万円" (半角コロン)。
  assertUnitLabel(rows, UNIT_LABEL_ROW, "百万円", "trading_vol_and_position.xls ALL(TOTAL)");

  const result: FfajMarketTotalRow[] = [];
  const seen = new Set<string>();
  for (const row of takeDataRows(rows, MONTHLY_DATA_START_ROW, "trading_vol_and_position.xls ALL(TOTAL)")) {
    const month = monthKey(row[1], row[0], "trading_vol_and_position.xls ALL(TOTAL)");
    assertUniqueMonth(seen, month, "trading_vol_and_position.xls ALL(TOTAL)");
    result.push({
      month,
      turnoverMillionYen: assertFiniteNumber(row[2], `${month} 取引金額`),
      shortPositionMillionYen: assertFiniteNumber(row[3], `${month} 売建`),
      longPositionMillionYen: assertFiniteNumber(row[4], `${month} 買建`),
      totalPositionMillionYen: assertFiniteNumber(row[5], `${month} 建玉計`),
    });
  }
  if (result.length === 0) {
    throw new Error("FFAJ trading_vol_and_position.xls: データ行が 0 件です");
  }
  return result;
}

export const FFAJ_CURRENCY_CODES = ["JPY", "USD", "EUR", "GBP", "AUD", "NZD", "CHF", "CAD", "ZAR"] as const;
export type FfajCurrencyCode = (typeof FFAJ_CURRENCY_CODES)[number];

export interface FfajCurrencyPositionRow {
  month: string;
  currency: FfajCurrencyCode;
  turnoverMillionYen: number;
  shortPositionMillionYen: number;
  longPositionMillionYen: number;
  /** 買建-売建 (原資料の表記どおり「②-①＝買越額」)。プラス=ネット買い持ち。 */
  netLongMillionYen: number;
}

/** open_position_with_mc.xls のシート "Data" を解析する。 */
export function parseOpenPositionWithMc(bytes: Uint8Array): FfajCurrencyPositionRow[] {
  const workbook = XLSX.read(bytes, { type: "array" });
  const sheet = workbook.Sheets["Data"];
  if (!sheet) {
    throw new Error('FFAJ open_position_with_mc.xls: シート "Data" が見つかりません（様式変更の可能性）');
  }
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });

  const currencyHeaderRow = rows[8];
  const labelHeaderRow = rows[9];
  if (!Array.isArray(currencyHeaderRow) || !Array.isArray(labelHeaderRow)) {
    throw new Error("FFAJ open_position_with_mc.xls: ヘッダー行が見つかりません（様式変更の可能性）");
  }

  const blockStarts: number[] = [];
  for (const currency of FFAJ_CURRENCY_CODES) {
    const idx = currencyHeaderRow.findIndex(
      (cell) => typeof cell === "string" && cell.trim().endsWith(currency)
    );
    if (idx === -1) {
      throw new Error(
        `FFAJ open_position_with_mc.xls: 通貨見出し "${currency}" が見つかりません（様式変更の可能性）`
      );
    }
    blockStarts.push(idx);
  }

  const expectedSubLabels = ["Trading Volume", "Short Positions", "Long Positions", "Net Long"];
  for (const start of blockStarts) {
    for (let j = 0; j < expectedSubLabels.length; j++) {
      const cellValue = labelHeaderRow[start + j];
      if (typeof cellValue !== "string" || !cellValue.includes(expectedSubLabels[j])) {
        throw new Error(
          `FFAJ open_position_with_mc.xls: 列 ${start + j} のヘッダーが想定と異なります（様式変更の可能性）: ${JSON.stringify(cellValue)}`
        );
      }
    }
  }

  // 実ファイル (2026-09-27 取得) の 7 行目は "単位：百万円" (全角コロン)。
  assertUnitLabel(rows, UNIT_LABEL_ROW, "百万円", "open_position_with_mc.xls Data");

  const result: FfajCurrencyPositionRow[] = [];
  const seen = new Set<string>();
  for (const row of takeDataRows(rows, MONTHLY_DATA_START_ROW, "open_position_with_mc.xls Data")) {
    const month = monthKey(row[1], row[0], "open_position_with_mc.xls Data");
    assertUniqueMonth(seen, month, "open_position_with_mc.xls Data");
    for (let b = 0; b < FFAJ_CURRENCY_CODES.length; b++) {
      const start = blockStarts[b];
      const currency = FFAJ_CURRENCY_CODES[b];
      result.push({
        month,
        currency,
        turnoverMillionYen: assertFiniteNumber(row[start], `${month} ${currency} 取引金額`),
        shortPositionMillionYen: assertFiniteNumber(row[start + 1], `${month} ${currency} 売建`),
        longPositionMillionYen: assertFiniteNumber(row[start + 2], `${month} ${currency} 買建`),
        netLongMillionYen: assertFiniteNumber(row[start + 3], `${month} ${currency} 買越額`),
      });
    }
  }
  if (result.length === 0) {
    throw new Error("FFAJ open_position_with_mc.xls: データ行が 0 件です");
  }
  return result;
}

const DEPOSIT_DATA_START_ROW = 12;
/** deposit_amount_information.xls: 列ごとの単位表示行 (実ファイルでは "円(Yen)" ×5 列 + "％")。 */
const DEPOSIT_UNIT_ROW = 11;

/**
 * deposit_amount_information.xls の列ごとの単位表示を検証する。金額 5 列
 * (入金額/出金額/必要額/正味増減額/信託額) は「円」単位 ("円(Yen)")、
 * 信託保全率は「％」であること。金額列は "千円"/"百万円" のように倍率付きの
 * 単位に変わると値の桁が変わるため、セルが "円" で**始まる**ことを要求する
 * ("百万円(…)" 等は "円" で始まらないので検知できる)。
 */
function assertDepositUnitRow(rows: unknown[][]): void {
  const row = rows[DEPOSIT_UNIT_ROW];
  const cellAt = (i: number): string | undefined => {
    const v = Array.isArray(row) ? row[i] : undefined;
    return typeof v === "string" ? v.trim() : undefined;
  };
  const yenColumnsOk = [2, 3, 4, 5, 6].every((i) => cellAt(i)?.startsWith("円") === true);
  const ratioCell = cellAt(7);
  const ratioOk = ratioCell === "％" || ratioCell === "%";
  if (!yenColumnsOk || !ratioOk) {
    throw new Error(
      "FFAJ deposit_amount_information.xls DATA: 単位表示 (金額列=\"円(Yen)\"・信託保全率=\"％\") が想定と異なります" +
        `（単位変更・様式変更の可能性）: ${JSON.stringify(row)}`
    );
  }
}

export interface FfajDepositRow {
  month: string;
  customerDepositInYen: number;
  customerWithdrawalOutYen: number;
  requiredBalanceYen: number;
  /**
   * =③-前月③-①+② (原資料の定義そのまま)。前月データが無く計算不能な月
   * (実ファイル確認済み: 系列先頭の 2015-04 が原資料そのもので "na" と
   * 記載されている) は `null`。`??` 等で 0 に読み替えない — 「計算不能」と
   * 「変化なし(0)」は別の事実であり、欠損は欠損のまま表現する (ルール2)。
   */
  netChangeYen: number | null;
  trustBalanceYen: number;
  trustCoverageRatioPercent: number;
}

/**
 * 正味増減額セルを解釈する。原資料は前月データが無い月にだけ文字列 "na" を
 * 置く (系列先頭の 2015-04 で実測確認済み)。それ以外の非数値は様式変更を
 * 疑って throw する。
 */
function parseNetChangeCell(value: unknown, where: string): number | null {
  if (typeof value === "string" && value.trim().toLowerCase() === "na") {
    return null;
  }
  return assertFiniteNumber(value, where);
}

/**
 * deposit_amount_information.xls のシート "DATA" を解析する。
 * 注意: この xls のみ列順が「年,月」(他の2ファイルは「月,年」)。原資料の
 * 並びをそのまま踏襲する (勝手に揃えて表現を変えない)。
 */
export function parseDepositAmountInformation(bytes: Uint8Array): FfajDepositRow[] {
  const workbook = XLSX.read(bytes, { type: "array" });
  const sheet = workbook.Sheets["DATA"];
  if (!sheet) {
    throw new Error('FFAJ deposit_amount_information.xls: シート "DATA" が見つかりません（様式変更の可能性）');
  }
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });

  const labelRow = rows[7];
  const subLabelRow = rows[9];
  const headerOk =
    Array.isArray(labelRow) &&
    Array.isArray(subLabelRow) &&
    subLabelRow[0] === "年" &&
    subLabelRow[1] === "月" &&
    typeof subLabelRow[2] === "string" &&
    (subLabelRow[2] as string).includes("入金額") &&
    typeof subLabelRow[3] === "string" &&
    (subLabelRow[3] as string).includes("出金額") &&
    typeof subLabelRow[4] === "string" &&
    (subLabelRow[4] as string).includes("必要額") &&
    typeof labelRow[5] === "string" &&
    (labelRow[5] as string).includes("正味増減額") &&
    typeof labelRow[6] === "string" &&
    (labelRow[6] as string).includes("信託額");
  if (!headerOk) {
    throw new Error("FFAJ deposit_amount_information.xls: ヘッダー列が想定と異なります（様式変更の可能性）");
  }
  assertDepositUnitRow(rows);

  const result: FfajDepositRow[] = [];
  const seen = new Set<string>();
  for (const row of takeDataRows(rows, DEPOSIT_DATA_START_ROW, "deposit_amount_information.xls DATA")) {
    const month = monthKey(row[0], row[1], "deposit_amount_information.xls DATA");
    assertUniqueMonth(seen, month, "deposit_amount_information.xls DATA");
    result.push({
      month,
      customerDepositInYen: assertFiniteNumber(row[2], `${month} 入金額`),
      customerWithdrawalOutYen: assertFiniteNumber(row[3], `${month} 出金額`),
      requiredBalanceYen: assertFiniteNumber(row[4], `${month} 必要額`),
      netChangeYen: parseNetChangeCell(row[5], `${month} 正味増減額`),
      trustBalanceYen: assertFiniteNumber(row[6], `${month} 信託額`),
      trustCoverageRatioPercent: assertFiniteNumber(row[7], `${month} 信託保全率`),
    });
  }
  if (result.length === 0) {
    throw new Error("FFAJ deposit_amount_information.xls: データ行が 0 件です");
  }
  return result;
}

export interface FfajOtcFxParsed {
  marketTotal: FfajMarketTotalRow[];
  currencyPositions: FfajCurrencyPositionRow[];
  deposits: FfajDepositRow[];
}

/** 3 ファイルまとめてパースする合成関数 (各パーサはこれ単体でも使える純関数)。 */
export function parseFfajOtcFxFiles(files: {
  tradingVolAndPosition: Uint8Array;
  openPositionWithMc: Uint8Array;
  depositAmountInformation: Uint8Array;
}): FfajOtcFxParsed {
  return {
    marketTotal: parseTradingVolAndPosition(files.tradingVolAndPosition),
    currencyPositions: parseOpenPositionWithMc(files.openPositionWithMc),
    deposits: parseDepositAmountInformation(files.depositAmountInformation),
  };
}

/**
 * 資料室ページが宣言する最新公表月 (`page.latestPublishedMonth`) と、実際にパースした
 * 3 ファイルの先頭行 (各パーサが新しい月を先頭に返す実データの並び順により、最新月の行) の
 * 月が一致するかを検証する。一致しなければ throw する (キャッシュ遅延・様式変更などで
 * ページと実ファイルの間にズレが生じた可能性があり、黙って処理を続けない — ルール2)。
 */
export function assertFfajOtcFxMonthConsistency(page: FfajIndexPage, parsed: FfajOtcFxParsed): void {
  const [market] = parsed.marketTotal;
  const [currency] = parsed.currencyPositions;
  const [deposit] = parsed.deposits;
  if (!market || !currency || !deposit) {
    // 各パーサは 0 件なら throw するので通常は到達しない。直接呼ばれた場合も
    // 空の側を推測で埋めず、そのまま失敗させる (ルール2)。
    throw new Error(
      "FFAJ: 最新月の整合検証に必要なデータ行がありません " +
        `(trading_vol_and_position=${parsed.marketTotal.length} 行, ` +
        `open_position_with_mc=${parsed.currencyPositions.length} 行, ` +
        `deposit_amount_information=${parsed.deposits.length} 行)`
    );
  }
  if (
    market.month !== page.latestPublishedMonth ||
    currency.month !== page.latestPublishedMonth ||
    deposit.month !== page.latestPublishedMonth
  ) {
    throw new Error(
      `FFAJ: 資料室ページの最新公表月 (${page.latestPublishedMonth}) と取得したファイルの先頭行の月が` +
        `一致しません (trading_vol_and_position=${market.month}, ` +
        `open_position_with_mc=${currency.month}, ` +
        `deposit_amount_information=${deposit.month})。` +
        "取得タイミングのズレ (CDN キャッシュ等)・様式変更のいずれかの可能性があります。"
    );
  }
}

// ---------------------------------------------------------------------------
// (3) 期間 (月次) と「まだ公表されていない」の判定
// ---------------------------------------------------------------------------

/** この取得元は月次速報のみで、週/四半期/年次の版は無い。 */
export type FfajPeriodGranularity = "month";

export type FfajPeriodStatus =
  | { status: "published"; month: string }
  | { status: "not_yet_published"; month: string; latestPublishedMonth: string }
  | { status: "before_series_start"; month: string; seriesStartMonth: string };

/**
 * 対象月が観測可能かを判定する。
 *
 * - 上限: 資料室ページが宣言する最新公表月 (`latestPublishedMonth`) より後なら
 *   `not_yet_published`。公表予定日から逆算するなどの推測はせず、実際にページが
 *   宣言した最新月とだけ比較する (ルール2: 未取得を推測で埋めない)。
 * - 下限: 系列の最古月 (`seriesStartMonth`) より前なら `before_series_start`
 *   (その月のデータは原資料に存在しない。`published` と誤答しない)。
 *   系列ごとに開始月が異なる (実ファイル 2026-09-27 時点: 取引状況・主要通貨建玉は
 *   2008-11、預託額情報は 2015-04 で、正味増減額は "na" のため実値は 2015-05 から)
 *   ので、呼び出し側は `ffajOtcFxSeriesStartMonths()` で実ファイルから求めた値を渡す
 *   (開始月を定数で埋め込まない)。
 */
export function resolveFfajOtcFxPeriodStatus(
  targetMonth: string,
  latestPublishedMonth: string,
  seriesStartMonth: string
): FfajPeriodStatus {
  const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
  if (!monthPattern.test(targetMonth)) {
    throw new Error(`FFAJ: 対象月の形式が不正です (YYYY-MM 以外): ${targetMonth}`);
  }
  if (!monthPattern.test(latestPublishedMonth)) {
    throw new Error(`FFAJ: latestPublishedMonth の形式が不正です (YYYY-MM 以外): ${latestPublishedMonth}`);
  }
  if (!monthPattern.test(seriesStartMonth)) {
    throw new Error(`FFAJ: seriesStartMonth の形式が不正です (YYYY-MM 以外): ${seriesStartMonth}`);
  }
  if (seriesStartMonth > latestPublishedMonth) {
    throw new Error(
      `FFAJ: seriesStartMonth (${seriesStartMonth}) が latestPublishedMonth (${latestPublishedMonth}) より後です`
    );
  }
  if (targetMonth > latestPublishedMonth) {
    return { status: "not_yet_published", month: targetMonth, latestPublishedMonth };
  }
  if (targetMonth < seriesStartMonth) {
    return { status: "before_series_start", month: targetMonth, seriesStartMonth };
  }
  return { status: "published", month: targetMonth };
}

export interface FfajOtcFxSeriesStartMonths {
  /** trading_vol_and_position.xls ALL(TOTAL) の最古月 */
  marketTotal: string;
  /** open_position_with_mc.xls Data の最古月 */
  currencyPositions: string;
  /** deposit_amount_information.xls DATA の最古月 (必要額・信託額) */
  deposits: string;
  /** 正味増減額が数値で存在する最古月 (原資料が "na" の月は含めない) */
  depositNetChange: string;
}

function oldestMonth(months: readonly string[], where: string): string {
  if (months.length === 0) {
    throw new Error(`FFAJ ${where}: 最古月を求めるデータ行がありません`);
  }
  return months.reduce((a, b) => (b < a ? b : a));
}

/** パース済みデータから系列ごとの最古月を求める (`resolveFfajOtcFxPeriodStatus` の下限に使う)。 */
export function ffajOtcFxSeriesStartMonths(parsed: FfajOtcFxParsed): FfajOtcFxSeriesStartMonths {
  return {
    marketTotal: oldestMonth(parsed.marketTotal.map((r) => r.month), "trading_vol_and_position.xls"),
    currencyPositions: oldestMonth(parsed.currencyPositions.map((r) => r.month), "open_position_with_mc.xls"),
    deposits: oldestMonth(parsed.deposits.map((r) => r.month), "deposit_amount_information.xls"),
    depositNetChange: oldestMonth(
      parsed.deposits.filter((r) => r.netChangeYen !== null).map((r) => r.month),
      "deposit_amount_information.xls 正味増減額"
    ),
  };
}

// ---------------------------------------------------------------------------
// (4) 指標定義
// ---------------------------------------------------------------------------

export type FfajFlowType =
  | "net_flow"
  | "gross_turnover"
  | "holdings_stock"
  | "positions"
  | "fund_flow"
  /**
   * 損益 (実現損益・評価損益増減・スワップ損益等の合計)。資金の入出金 (fund_flow) では
   * ない値をここに区別して分類する。moneyflow プロジェクト全体で「資金フロー」指標群に
   * 混ぜて集計してはいけない値、という意味を持つ。
   */
  | "pnl"
  | "estimated"
  | "price_only";

export interface FfajOtcFxIndicatorDefinition {
  key: string;
  displayName: string;
  requirements: ReadonlyArray<"R1" | "R2" | "R3" | "R4">;
  flowType: FfajFlowType;
  /** 平易な説明 (投資初心者向け、具体例つき)。ルール7の精神に合わせ、噛み砕きと引き換えに誤った定義を教えない。 */
  plainExplanation: string;
  /** 財務的に正確な定義。 */
  preciseDefinition: string;
  unit: string;
  sourceUrl: string;
  usageTerms: string;
  frequency: string;
  limitations: string;
}

const USAGE_TERMS =
  "FFAJ サイトの著作権表示 (/exception/matters/, 2026-09-27 確認) は「原則として協会が著作権を有する。" +
  "著作権法を遵守すること」という一般的な文言のみで、JPX 統計のような『商用目的のデータ収集・二次利用・" +
  "再配信を許諾なく禁止する』条項は確認できなかった。ただし commercial_use は unknown (未確認) — " +
  "個人利用の範囲に留め、公開経路 (Notion 含む) へ出す前に協会へ確認するか、出典明記の範囲に限定すること。";

/**
 * 取引状況・主要通貨建玉の 2 ファイル (trading_vol_and_position.xls / open_position_with_mc.xls)
 * の note シートの記載 (2026-09-27 取得) に基づく注意書き。
 * - 注記1: 「当協会の行う店頭外国為替証拠金取引月次報告に協力する会員からの報告値を集計したもの」
 *   → 国内の全FX業者の網羅を保証する値ではない。
 * - 注記2: 外貨建ての取引・建玉は「各月末日における」日銀公表レート等で円換算している。
 */
const COVERAGE_NOTE =
  "FFAJの月次報告に協力する会員業者からの報告値の集計であり(FFAJ注記)、国内の全FX業者を網羅する" +
  "ことは保証されていない。";
const MONTH_END_RATE_POSITION_NOTE =
  "外貨建ての建玉は各月末日の為替レート(日銀公表レート等)で円換算されている(FFAJ注記)ため、" +
  "前月比の増減には建玉そのものの増減だけでなく、為替レートの変動による円換算額の変化も含まれる。";

export const FFAJ_OTC_FX_INDICATORS: readonly FfajOtcFxIndicatorDefinition[] = [
  {
    key: "ffaj_otc_fx_turnover",
    displayName: "店頭FX 取引金額（月間）",
    requirements: ["R3"],
    flowType: "gross_turnover",
    plainExplanation:
      "その月にFX会社とその顧客(個人投資家など)の間で成立した取引の合計金額（円換算）。買いも売りも合算するので" +
      "『どちらが増えたか』はこれだけではわからないが、市場がどれだけ活発だったかの目安になる。" +
      "例: 2026年8月は約8,257,164億円（≈825兆円）。",
    preciseDefinition:
      "FFAJ会員が協会へ報告した、顧客と会員業者間で成立した店頭外国為替証拠金取引の月間約定金額の合計" +
      "（カバー取引・自己取引は含まない）。買い・売りを区別しない総額(グロス)であり、資金の純流入出" +
      "(ネット)を意味しない。",
    unit: "百万円",
    sourceUrl: FFAJ_INDEX_URL,
    usageTerms: USAGE_TERMS,
    frequency: "月次",
    limitations:
      "グロス売買代金であり方向(誰が買い越したか)は示さない。媒介取引(他社経由の取次)は二重計上を避ける" +
      "ため媒介元の会員には計上されない。" +
      COVERAGE_NOTE +
      "また外貨建ての取引金額は、約定時のレートではなく各月末日の為替レート(日銀公表レート等)で円換算" +
      "されている(FFAJ注記)ため、月中の各約定時点のレートで換算した額とは一致しない。",
  },
  {
    key: "ffaj_otc_fx_short_position",
    displayName: "店頭FX 売建玉（月末残高）",
    requirements: ["R3"],
    flowType: "positions",
    plainExplanation:
      "月末時点で、まだ決済されずに残っている「売り」のポジション(建玉)の合計金額。前月と比べた増減で、" +
      "売り持ちが積み上がっているかの目安になる(ただし外貨建ての建玉は月末の為替レートで円に換算されるので、" +
      "建玉が変わらなくても為替が動けば金額は増減する)。",
    preciseDefinition: "各月末日時点で顧客が保有する、基準通貨を売った未決済建玉の合計金額(円換算)。",
    unit: "百万円",
    sourceUrl: FFAJ_INDEX_URL,
    usageTerms: USAGE_TERMS,
    frequency: "月次",
    limitations:
      "残高(ストック)であり、当月中に建てて解消したポジションは反映されない(月末の一時点のみ)。" +
      MONTH_END_RATE_POSITION_NOTE +
      COVERAGE_NOTE,
  },
  {
    key: "ffaj_otc_fx_long_position",
    displayName: "店頭FX 買建玉（月末残高）",
    requirements: ["R3"],
    flowType: "positions",
    plainExplanation: "月末時点で、まだ決済されずに残っている「買い」のポジション(建玉)の合計金額。",
    preciseDefinition: "各月末日時点で顧客が保有する、基準通貨を買った未決済建玉の合計金額(円換算)。",
    unit: "百万円",
    sourceUrl: FFAJ_INDEX_URL,
    usageTerms: USAGE_TERMS,
    frequency: "月次",
    limitations:
      "残高(ストック)であり、月中の建て直し・解消は反映されない。" + MONTH_END_RATE_POSITION_NOTE + COVERAGE_NOTE,
  },
  {
    key: "ffaj_otc_fx_open_position_total",
    displayName: "店頭FX 建玉合計（月末残高）",
    requirements: ["R3"],
    flowType: "positions",
    plainExplanation: "売建玉と買建玉を単純に足した合計。ポジション全体の大きさ(レバレッジの積み上がり)の目安。",
    preciseDefinition: "売建玉と買建玉の合計金額(円換算)。売り・買いが相殺されるわけではない点に注意。",
    unit: "百万円",
    sourceUrl: FFAJ_INDEX_URL,
    usageTerms: USAGE_TERMS,
    frequency: "月次",
    limitations:
      "売り買い方向を打ち消し合わない単純合計であり、市場の『ネットの持ち高』を示す指標ではない。" +
      "原資料の建玉計は個別に四捨五入された公表値のため、売建+買建と ±1百万円ずれる月がある。" +
      MONTH_END_RATE_POSITION_NOTE +
      COVERAGE_NOTE,
  },
  {
    key: "ffaj_otc_fx_net_long_position",
    displayName: "店頭FX 通貨別ネット買い越し建玉",
    requirements: ["R3"],
    flowType: "positions",
    plainExplanation:
      "通貨ごとに「買建玉－売建玉」を計算した値。プラスなら投資家全体がその通貨を買い持ち(その通貨の" +
      "値上がりを期待)、マイナスなら売り持ち(値下がりを期待)と読める。例: 2026年8月末の日本円は" +
      "約-2兆8,771億円で、円を売る持ち高(=円安で得をする持ち高)の方が多かった。",
    preciseDefinition:
      "主要9通貨それぞれについて、月末時点の買建玉から売建玉を差し引いた金額(円換算)。原資料の表記" +
      "(②-①＝買越額)をそのまま使う。通貨ペア単位の値ではなく、取引された通貨ペアを個別の通貨に" +
      "分解して集計した値(FFAJ注記: 例えば USDJPY の買いは USD=買い・JPY=売りとして両方に計上)。",
    unit: "百万円",
    sourceUrl: FFAJ_INDEX_URL,
    usageTerms: USAGE_TERMS,
    frequency: "月次",
    limitations:
      "主要9通貨(JPY/USD/EUR/GBP/AUD/NZD/CHF/CAD/ZAR)のみで、それ以外の通貨は別ファイル" +
      "(通貨ペア別取引金額)にしかなく本モジュールは対象外。1つの取引が2つの通貨の両方に計上されるため" +
      "(FFAJ注記: 各通貨の合計は通貨ペア合計の2倍になる)、通貨をまたいで足し合わせてはならない。" +
      "原資料の買越額は個別に四捨五入された公表値のため、買建-売建と ±1百万円ずれる月がある。" +
      MONTH_END_RATE_POSITION_NOTE +
      COVERAGE_NOTE,
  },
  {
    key: "ffaj_otc_fx_customer_deposit_net_change",
    displayName: "店頭FX 顧客区分管理必要額 正味増減額（月間、実質損益相当）",
    requirements: ["R3"],
    flowType: "pnl",
    plainExplanation:
      "名前は「増減額」だが、中身は入出金の差額ではない。その月に顧客全体が確定させた損益(決済損益)・" +
      "まだ決済していない含み損益の増減・スワップ(金利差)損益、この3つを合わせた合計。FFAJ自身が" +
      "「実現損益額・評価損益増減額・スワップポイント損益額の合計値に相当する」と説明している。プラスなら" +
      "その月に顧客全体の資産が実質的に増えた、マイナスなら減ったことを意味する。例: 2026年8月は約+673億円" +
      "(顧客全体で儲かった月)、7月は約-373億円(顧客全体で損をした月)。",
    preciseDefinition:
      "当月末の顧客区分管理必要額(③)から前月末の値を差し引き、当月の顧客入金額(①)を控除、当月の顧客" +
      "出金額(②)を加算した値(原資料の定義: =③-前月③-①+②)。FFAJ公式解説" +
      "(https://www.ffaj.or.jp/library/performance/deposit/) は、この計算式による値が" +
      "「1か月間のFXによる実現損益額、評価損益増減額、スワップポイント損益額の合計値に相当」すると" +
      "明記しており、資金の入出金そのもの(資金フロー)ではなく顧客全体の運用損益を表す統計である。",
    unit: "円",
    sourceUrl: FFAJ_INDEX_URL,
    usageTerms: USAGE_TERMS,
    frequency: "月次",
    limitations:
      "資金フロー(純粋な入出金)の指標ではない。式に入出金額(①②)を含むが、その目的は「入出金による" +
      "見かけ上の増減」を取り除いて損益部分だけを取り出すことにあり、値そのものは損益(実現損益+評価損益" +
      "増減+スワップ損益)である。他の資金フロー系指標(fund_flow)と合算・混同してはならない。FFAJ自身が" +
      "「FX業者の損益額とは異なる」と注意書きしており、マイナスの月を「FX業者の儲け」と読んではならない。" +
      "また前月データが無く計算できない月は原資料が \"na\" を記載する (系列先頭の2015-04で実測確認済み) — " +
      "この場合は値を作らず観測ログへ記録しない。",
  },
  {
    key: "ffaj_otc_fx_deposit_required_balance",
    displayName: "店頭FX 顧客区分管理必要額（月末残高）",
    requirements: ["R3"],
    flowType: "holdings_stock",
    plainExplanation:
      "顧客の証拠金として、FX会社が分別管理(信託等)しなければならない金額の月末時点の合計。" +
      "入金した額そのものではなく、まだ決済していない含み損益やスワップ損益も足し引きした額" +
      "(顧客全体の、含み損益込みの口座残高に近い)。例: 2026年8月末は約1兆9,207億円。",
    preciseDefinition:
      "金融商品取引法の分別管理規制上、会員が顧客区分管理しなければならない必要額の月末残高。FFAJ公式解説" +
      "によれば、顧客が預託した金銭に、顧客が保有する建玉の評価損益額・スワップポイント損益額を合計した額。",
    unit: "円",
    sourceUrl: FFAJ_INDEX_URL,
    usageTerms: USAGE_TERMS,
    frequency: "月次",
    limitations:
      "残高(ストック)。前月末残高との単純な差分には当月の顧客入出金額(①②)も混ざってしまうため、" +
      "入出金を除いた損益部分(実現損益+評価損益増減+スワップ損益相当)だけを見たい場合は" +
      "ffaj_otc_fx_customer_deposit_net_change を使うこと。",
  },
  {
    key: "ffaj_otc_fx_deposit_trust_balance",
    displayName: "店頭FX 顧客区分管理信託額（月末残高）",
    requirements: ["R3"],
    flowType: "holdings_stock",
    plainExplanation: "実際に信託銀行等へ信託されている、顧客資産の保全額。必要額(上記)を上回っていれば保全は充足している。",
    preciseDefinition: "月末時点で会員が信託している顧客区分管理信託額の残高。",
    unit: "円",
    sourceUrl: FFAJ_INDEX_URL,
    usageTerms: USAGE_TERMS,
    frequency: "月次",
    limitations:
      "業界合算値。個社の保全状況(信託保全率)のばらつきは合算値には表れない。FFAJ公式解説のとおり、" +
      "必要額は毎日計算され不足分は2日以内に信託されるため、適切に保全していても計算日と信託日のズレで" +
      "月末時点の信託額が必要額を下回る(信託保全率が100%未満になる)ことがある。",
  },
] as const;

// ---------------------------------------------------------------------------
// 縦長 (観測ログ) 形式への変換
// ---------------------------------------------------------------------------

export interface FfajOtcFxObservation {
  /** YYYY-MM */
  period: string;
  indicatorKey: string;
  /** 区分。市場全体は "market"、通貨別は通貨コード。 */
  segment: string;
  value: number;
  unit: string;
  /** 概念上の近似か (例: グロス取引金額を資金フローの目安として使う等)。 */
  isApproximate: boolean;
  /** この値自体が推定値か (FFAJ の公表値そのものであれば false)。 */
  isEstimated: boolean;
}

/** パース済みデータを「期間・指標キー・区分・値・単位・近似か・推定か」の縦長形式に変換する。 */
export function toFfajOtcFxObservations(data: FfajOtcFxParsed): FfajOtcFxObservation[] {
  const observations: FfajOtcFxObservation[] = [];

  for (const row of data.marketTotal) {
    observations.push(
      {
        period: row.month,
        indicatorKey: "ffaj_otc_fx_turnover",
        segment: "market",
        value: row.turnoverMillionYen,
        unit: "百万円",
        isApproximate: true,
        isEstimated: false,
      },
      {
        period: row.month,
        indicatorKey: "ffaj_otc_fx_short_position",
        segment: "market",
        value: row.shortPositionMillionYen,
        unit: "百万円",
        isApproximate: false,
        isEstimated: false,
      },
      {
        period: row.month,
        indicatorKey: "ffaj_otc_fx_long_position",
        segment: "market",
        value: row.longPositionMillionYen,
        unit: "百万円",
        isApproximate: false,
        isEstimated: false,
      },
      {
        period: row.month,
        indicatorKey: "ffaj_otc_fx_open_position_total",
        segment: "market",
        value: row.totalPositionMillionYen,
        unit: "百万円",
        isApproximate: false,
        isEstimated: false,
      }
    );
  }

  for (const row of data.currencyPositions) {
    observations.push({
      period: row.month,
      indicatorKey: "ffaj_otc_fx_net_long_position",
      segment: row.currency,
      value: row.netLongMillionYen,
      unit: "百万円",
      isApproximate: false,
      isEstimated: false,
    });
  }

  for (const row of data.deposits) {
    if (row.netChangeYen === null) {
      // 原資料が "na" (計算不能) を明示した月。0 で埋めず、観測ログにも
      // レコードを作らない (欠損は欠損のまま)。運用者が気づけるよう警告する。
      console.warn(
        `FFAJ ffaj_otc_fx_customer_deposit_net_change: ${row.month} は前月データ欠落のため原資料が計算不能("na")と記載しており、観測ログへ記録しない`
      );
    } else {
      observations.push({
        period: row.month,
        indicatorKey: "ffaj_otc_fx_customer_deposit_net_change",
        segment: "market",
        value: row.netChangeYen,
        unit: "円",
        // flowType は "pnl" (資金フローではない、実現+評価損益+スワップ損益相当の値)。
        // FFAJ公式解説の計算式そのままの厳密値であり、概念上の近似ではない。
        isApproximate: false,
        isEstimated: false,
      });
    }
    observations.push(
      {
        period: row.month,
        indicatorKey: "ffaj_otc_fx_deposit_required_balance",
        segment: "market",
        value: row.requiredBalanceYen,
        unit: "円",
        isApproximate: false,
        isEstimated: false,
      },
      {
        period: row.month,
        indicatorKey: "ffaj_otc_fx_deposit_trust_balance",
        segment: "market",
        value: row.trustBalanceYen,
        unit: "円",
        isApproximate: false,
        isEstimated: false,
      }
    );
  }

  return observations;
}

// ---------------------------------------------------------------------------
// ルール6: Notion 一次データ記録の入力を組み立てる純関数 (Notion への実書込は行わない)
// ---------------------------------------------------------------------------

export interface FfajOtcFxArchiveInput {
  service: string;
  key: string;
  source: string;
  metadata: Record<string, unknown>;
  files: Array<{ bytes: Uint8Array; filename: string; contentType: string }>;
}

/**
 * 一次データの冪等キー `ffaj-otc-fx-<最新公表月>-updated-<更新日>` を作る。
 *
 * 最新公表月だけでなく資料室ページの「更新日」も含める。FFAJ は xls の note
 * シートで「過去の数値を修正することがありますので、データの更新日を確認して
 * ください」と明記しており、実際に過去月の修正履歴が多数ある。同じ最新公表月の
 * まま差し替え公表された場合に、月だけのキーでは recordPrimaryData() が
 * `skipped_existing` になって修正後のファイルが保管されず、観測ログの値と
 * 一次データの実体が食い違う (ルール6)。index ページだけで計算できるので、
 * xls を取得する前に isArchived() で既取得判定にも使える。同じ最新公表月で
 * キーが変わった (差し替え) 場合、旧キーの記録は moveToTrash() で退避する。
 */
export function ffajOtcFxArchiveKey(page: Pick<FfajIndexPage, "latestPublishedMonth" | "updatedOn">): string {
  return `ffaj-otc-fx-${page.latestPublishedMonth}-updated-${page.updatedOn}`;
}

/** raw ファイル取得結果から recordPrimaryData() 呼び出し用の入力を組む (呼び出しは統合担当が行う)。 */
export function ffajOtcFxArchiveInput(raw: FfajOtcFxRawFiles): FfajOtcFxArchiveInput {
  const month = raw.page.latestPublishedMonth;
  return {
    service: "moneyflow",
    key: ffajOtcFxArchiveKey(raw.page),
    source: FFAJ_INDEX_URL,
    metadata: {
      month,
      updatedOn: raw.page.updatedOn,
      tradingVolAndPositionUrl: raw.page.tradingVolAndPositionUrl,
      openPositionWithMcUrl: raw.page.openPositionWithMcUrl,
      depositAmountInformationUrl: raw.page.depositAmountInformationUrl,
      tradingVolAndPositionBytes: raw.tradingVolAndPosition.byteLength,
      openPositionWithMcBytes: raw.openPositionWithMc.byteLength,
      depositAmountInformationBytes: raw.depositAmountInformation.byteLength,
    },
    files: [
      {
        bytes: raw.tradingVolAndPosition,
        filename: `ffaj-trading-vol-and-position-${month}.xls`,
        contentType: "application/vnd.ms-excel",
      },
      {
        bytes: raw.openPositionWithMc,
        filename: `ffaj-open-position-with-mc-${month}.xls`,
        contentType: "application/vnd.ms-excel",
      },
      {
        bytes: raw.depositAmountInformation,
        filename: `ffaj-deposit-amount-information-${month}.xls`,
        contentType: "application/vnd.ms-excel",
      },
    ],
  };
}
