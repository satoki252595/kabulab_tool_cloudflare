/**
 * 取得元: JPX (日本取引所グループ) 投資部門別売買状況 — ETF / REIT (月次)
 *
 *   ETF  一覧ページ: https://www.jpx.co.jp/markets/statistics-equities/investor-type/02.html
 *   REIT 一覧ページ: https://www.jpx.co.jp/markets/statistics-equities/investor-type/03.html
 *
 * 投資家のタイプ (海外投資家・個人・国内法人・証券会社 等) ごとに、その月の
 * ETF / J-REIT 市場での買付・売付金額(・口数)と差引(買い越し/売り越し)を示す。
 * 「市場全体で誰が買い越したか」に最も近い統計 (計画書 R1補足・R2)。
 *
 * 様式 (現行, 〜2026年9月分掲載):
 *   - 1 ファイルに Volume(口数) / Value(金額) の 2 シート。
 *   - 各シートは「自己計/委託計/総計」→「委託内訳 (法人/個人/海外投資家/証券会社)」
 *     →「法人内訳 (投資信託/事業法人/その他法人等/金融機関)」
 *     →「金融機関内訳 (生保・損保/銀行/その他金融機関)」の順で、
 *     カテゴリごとに [売り, 買い, 合計] の 3 行が並ぶ固定テンプレート。
 *   - セルは数値も含めてテキスト (カンマ区切り文字列) として格納されている。
 *
 * **既知の様式変更 (未対応)**: JPX は 2026年10月13日掲載分 (=2026年9月分の
 * データ) から、PDF は 1 ページ、Excel は 1 シートへ統合すると告知済み
 * (`etf_mYYYYMM.xlsx` / `reit_mYYYYMM.xlsx` としてサンプルファイルを先行公開)。
 * 新様式は列見出しが多段のワイドテーブルで、現行の行ベース様式とは非互換。
 * 本パーサは **現行様式のみ** に対応し、新様式のファイルを渡すと明示的に
 * throw する (ルール2: 誤った行として読み違えるより、様式が変わったことを
 * 分からせて止める)。新様式への対応は別途この関数を更新すること。
 *
 * 利用条件: JPX利用規約により、無許諾での商用データ収集・二次利用・再配信は
 * 禁止 (`commercial_use: prohibited`)。非公開の範囲に限る (`personal-only`)。
 * 規約は「高頻度・高負荷に繋がる可能性のある自動取得等はご遠慮いただいて
 * おります」と明記しており、1 回の実行につき一覧ページ 1 回・ファイル 1 回
 * (月次更新なので月 1 回) に留めること。
 */

import * as XLSX from "xlsx";

export type JpxInvestorProduct = "etf" | "reit";

// ブラウザ相当の User-Agent。既存の JPX 取得コード (src/shared/jpx/sectors.ts・
// services/vwap-analysis/lib/margin.ts) と同じ対処に揃えている。
// 「既定 UA だと 403 になる」という前提は、2026-09-27 の反証検証環境
// (素の fetch/curl/空 UA) では 200 が返り再現できていない (未確認)。
// Cloudflare Workers / CI の egress からの実行ログで一度確認し、不要なら外すこと。
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const JPX_BASE = "https://www.jpx.co.jp";

const LISTING_PATH: Record<JpxInvestorProduct, string> = {
  etf: "/markets/statistics-equities/investor-type/02.html",
  reit: "/markets/statistics-equities/investor-type/03.html",
};

const FILE_PREFIX: Record<JpxInvestorProduct, string> = {
  etf: "etf_m",
  reit: "reit_m",
};

const PRODUCT_LABEL_JA: Record<JpxInvestorProduct, string> = {
  etf: "ETF",
  reit: "J-REIT (不動産投資信託証券)",
};

/**
 * 原本シート冒頭の表題 (例: "投資部門別 ETF売買状況 [口数] 全 52 社"。区切りは全角空白) に
 * 含まれるはずの語。呼び出し側が渡した product と実ファイルの中身が食い違う
 * (ETF のファイルを REIT として読む等) と、指標キー `jpx-<product>-…` に
 * 別商品の値が黙って載ってしまうため、パース時に照合して throw する。
 */
const TITLE_MARKER: Record<JpxInvestorProduct, string> = {
  etf: "ETF売買状況",
  reit: "不動産投資信託証券売買状況",
};

/**
 * 口数シートの単位 (原本の単位表記で確認済み: ETF=「百口」、REIT=「口」)。
 * 指標定義の unit と観測行の unit が同じ値になるよう、パース時にも照合する
 * (JPX が単位を変えたら指標定義が誤りになるので、黙って通さず throw する)。
 */
const VOLUME_UNIT: Record<JpxInvestorProduct, JpxInvestorUnit> = {
  etf: "lot_100units",
  reit: "unit",
};

export function jpxInvestorListingUrl(product: JpxInvestorProduct): string {
  return `${JPX_BASE}${LISTING_PATH[product]}`;
}

// ---------------------------------------------------------------------------
// (1) 最新ファイルの URL 解決 + 取得
// ---------------------------------------------------------------------------

export interface JpxInvestorMonthLink {
  /** "2026-08" */
  yearMonth: string;
  /** 絶対 URL */
  href: string;
  /** リンク先の実ファイル名 (例: "etf_m2608.xls" / 新様式なら "etf_m202609.xlsx") */
  filename: string;
  ext: "xls" | "xlsx";
}

/**
 * 月次ファイル名 `<prefix><年月>.xls[x]` の年月部分を "YYYY-MM" にする。
 *
 * - 現行 (〜2026年8月分): `etf_m2608.xls` のように 2 桁年+月 (YYMM)。
 * - 新様式 (2026年10月13日掲載分〜): JPX の先行サンプルが `etf_mYYYYMM.xlsx` と
 *   4 桁年+月 (YYYYMM) で命名されている (株式の投資部門別も同じ時期に
 *   `stock_val_1_m2608.xls` → `stock_1_mYYYYMM.xlsx` へ変わる)。
 *   YYMM しか認識しないと新様式のリンクを黙って無視し、最新月が旧月のまま
 *   「未公表」と判定され続ける (取込が永久に黙ってスキップされる) ため、両方を読む。
 * - サンプル (`etf_mYYYYMM.xlsx` の文字どおりの "YYYYMM") は月次データではないので除外。
 * - それ以外の見慣れない名前は、命名規則が変わった可能性があるので throw する
 *   (黙って読み飛ばさない — ルール2)。
 *
 * @returns 年月。サンプルファイルなら null。
 */
function yearMonthFromMonthlyToken(token: string, href: string, product: JpxInvestorProduct): string | null {
  if (/^Y{2,4}M{2}/.test(token)) return null;
  let year: number;
  let month: number;
  if (/^\d{4}$/.test(token)) {
    // JPXの YYMM 命名は 2000年代を前提にした2桁年。21世紀中は一意に復元できる。
    year = 2000 + Number(token.slice(0, 2));
    month = Number(token.slice(2, 4));
  } else if (/^\d{6}$/.test(token)) {
    year = Number(token.slice(0, 4));
    month = Number(token.slice(4, 6));
    if (year < 2000 || year > 2099) {
      throw new Error(
        `JPX ${product} investor-type: リンクの年が不正です ("${token}" in ${href})`
      );
    }
  } else {
    throw new Error(
      `JPX ${product} investor-type: 月次ファイル名の年月部分を解釈できません ("${token}" in ${href})。` +
        "ファイル命名規則が変わった可能性があります"
    );
  }
  if (month < 1 || month > 12) {
    throw new Error(
      `JPX ${product} investor-type: リンクの月が不正です ("${token}" in ${href})`
    );
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * 一覧ページ HTML から月次ファイル (etf_mYYMM / etf_mYYYYMM .xls[x]、REIT は reit_m…) への
 * リンクを抽出する。PDF リンクは対象外。サンプルファイル (`etf_mYYYYMM.xlsx` 等、
 * 年月が文字の "YYYYMM") は除外する。`<prefix>` で始まる Excel リンクのうち
 * 年月として解釈できない名前があれば throw する。
 *
 * @throws リンクが 1 件も見つからない場合 (ページ構造が変わった可能性)
 * @throws 月次ファイル名の年月部分が解釈できない場合 (命名規則が変わった可能性)
 */
export function parseJpxInvestorMonthLinks(
  html: string,
  product: JpxInvestorProduct
): JpxInvestorMonthLink[] {
  const prefix = FILE_PREFIX[product];
  const re = /href="([^"]+)"/g;
  const byYearMonth = new Map<string, JpxInvestorMonthLink>();
  for (const m of html.matchAll(re)) {
    const href = m[1]!;
    const filename = href.split(/[?#]/)[0]!.split("/").pop()!;
    const fm = filename.match(/^([a-z]+_m)([^.]+)\.(xlsx?)$/);
    if (!fm || fm[1] !== prefix) continue;
    const token = fm[2]!;
    const ext = fm[3] as "xls" | "xlsx";
    const yearMonth = yearMonthFromMonthlyToken(token, href, product);
    if (yearMonth === null) continue;
    const absoluteHref = href.startsWith("http") ? href : `${JPX_BASE}${href}`;
    const existing = byYearMonth.get(yearMonth);
    // 移行期に同じ月へ xls/xlsx 両方のリンクが載る可能性がある。新拡張子を優先する。
    if (!existing || (existing.ext === "xls" && ext === "xlsx")) {
      byYearMonth.set(yearMonth, { yearMonth, href: absoluteHref, filename, ext });
    }
  }
  if (byYearMonth.size === 0) {
    throw new Error(
      `JPX ${product} investor-type: 月次ファイルへのリンクが1件も見つかりません。` +
        `一覧ページの構造が変わった可能性があります (${jpxInvestorListingUrl(product)})`
    );
  }
  return [...byYearMonth.values()].sort((a, b) =>
    a.yearMonth.localeCompare(b.yearMonth)
  );
}

/** 一覧ページを取得し、月次ファイルへのリンク一覧を年月の昇順で返す。 */
export async function fetchJpxInvestorMonthLinks(
  product: JpxInvestorProduct
): Promise<JpxInvestorMonthLink[]> {
  const url = jpxInvestorListingUrl(product);
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    throw new Error(
      `JPX ${product} investor-type 一覧ページ HTTP エラー: ${res.status} ${res.statusText} (${url})`
    );
  }
  const html = await res.text();
  return parseJpxInvestorMonthLinks(html, product);
}

export function latestJpxInvestorMonthLink(
  links: JpxInvestorMonthLink[]
): JpxInvestorMonthLink {
  if (links.length === 0) {
    throw new Error("JPX investor-type: 月次リンクが空です");
  }
  return links[links.length - 1]!;
}

export interface JpxInvestorWorkbookFile {
  product: JpxInvestorProduct;
  yearMonth: string;
  sourceUrl: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

const CONTENT_TYPE: Record<"xls" | "xlsx", string> = {
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/**
 * 一覧ページから最新月のファイル URL を解決し、実ファイルをダウンロードする。
 * 1 回の呼び出しで一覧ページ 1 回・ファイル 1 回のアクセスに限る (利用規約の
 * 自粛要請への配慮)。
 *
 * @throws 一覧ページ/ファイルの HTTP エラー、リンクが見つからない場合
 */
export async function fetchLatestJpxInvestorWorkbook(
  product: JpxInvestorProduct
): Promise<JpxInvestorWorkbookFile> {
  const links = await fetchJpxInvestorMonthLinks(product);
  const latest = latestJpxInvestorMonthLink(links);
  const res = await fetch(latest.href, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    throw new Error(
      `JPX ${product} investor-type ファイル HTTP エラー: ${res.status} ${res.statusText} (${latest.href})`
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return {
    product,
    yearMonth: latest.yearMonth,
    sourceUrl: latest.href,
    // リンク先の実ファイル名をそのまま使う (年月から組み立て直すと、
    // 新様式の YYYYMM 命名を YYMM に書き換えてしまい原本名と食い違う)。
    filename: latest.filename,
    contentType: CONTENT_TYPE[latest.ext],
    bytes,
  };
}

// ---------------------------------------------------------------------------
// (2) 純関数パーサ
// ---------------------------------------------------------------------------

export type JpxInvestorMetric = "value" | "volume";
export type JpxInvestorUnit = "thousand_yen" | "lot_100units" | "unit";

export interface JpxInvestorCategoryRow {
  /** JPX原文の日本語カテゴリ名 (空白除去済み。例: "海外投資家" "総計") */
  category: string;
  /** JPX原文の英語カテゴリ名 (例: "Foreigners") */
  categoryEn: string;
  /** どの内訳見出しの下にあるか (トップレベルの3行 = null) */
  group: string | null;
  /** 売付 */
  sales: number;
  salesRatioPercent: number;
  /** 買付 */
  purchases: number;
  purchasesRatioPercent: number;
  /** 買付 - 売付。プラス=買い越し、マイナス=売り越し。JPX原文の「差引」欄と
   * 一致することを検証済み (一致しなければ parseJpxInvestorWorkbook が throw) */
  balance: number;
  /** 売付 + 買付 (合計・取引の活発さ) */
  total: number;
  totalRatioPercent: number;
}

export interface JpxInvestorSheet {
  metric: JpxInvestorMetric;
  unit: JpxInvestorUnit;
  /** JPX原文の期間表記 (例: "2026年8月 2026/8  ( 8/3 - 8/31 )") */
  periodLabel: string;
  /** "2026-08" */
  yearMonth: string;
  rangeStart: string;
  rangeEnd: string;
  /** シート冒頭の「総売買代金」「総売買高」(自己+委託・売り+買いの市場全体合計) */
  marketTotal: number;
  categories: JpxInvestorCategoryRow[];
}

export interface JpxInvestorReport {
  product: JpxInvestorProduct;
  sourceUrl: string;
  yearMonth: string;
  value: JpxInvestorSheet;
  volume: JpxInvestorSheet;
}

function cell(row: unknown[] | undefined, idx: number): string {
  const v = row?.[idx];
  if (typeof v === "string") return v;
  if (v === undefined || v === null) return "";
  return String(v);
}

/** カンマ区切りテキストのセルを数値化する。空/非数値は throw (ルール2: 黙って0や欠損値で埋めない)。 */
function parseSignedNumber(text: string, context: string): number {
  const trimmed = text.trim();
  if (trimmed === "") {
    throw new Error(`JPX investor-type: 数値セルが空です (${context})`);
  }
  const normalized = trimmed.replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(
      `JPX investor-type: 数値として解釈できないセルです: "${text}" (${context})`
    );
  }
  return Number(normalized);
}

const PERIOD_RE =
  /^(\d{4})年(\d{1,2})月\s+\d{4}\/\d{1,2}\s*\(\s*(\d{1,2})\/(\d{1,2})\s*-\s*(\d{1,2})\/(\d{1,2})\s*\)/;

function parseInvestorSheet(
  rows: unknown[][],
  metric: JpxInvestorMetric,
  context: string
): JpxInvestorSheet {
  let periodRowIdx = -1;
  let periodMatch: RegExpMatchArray | null = null;
  for (let i = 0; i < rows.length; i++) {
    const m = cell(rows[i], 0).match(PERIOD_RE);
    if (m) {
      periodRowIdx = i;
      periodMatch = m;
      break;
    }
  }
  if (periodRowIdx === -1 || !periodMatch) {
    throw new Error(
      `JPX investor-type (${context}): 対象期間の行が見つかりません。様式が変わった可能性があります`
    );
  }
  const [, year, month, startMonth, startDay, endMonth, endDay] = periodMatch;
  const yearMonth = `${year}-${month.padStart(2, "0")}`;
  const rangeStart = `${year}-${startMonth.padStart(2, "0")}-${startDay.padStart(2, "0")}`;
  const rangeEnd = `${year}-${endMonth.padStart(2, "0")}-${endDay.padStart(2, "0")}`;

  let unit: JpxInvestorUnit | null = null;
  outer: for (
    let i = periodRowIdx;
    i < Math.min(periodRowIdx + 5, rows.length);
    i++
  ) {
    for (const raw of rows[i] ?? []) {
      const text = typeof raw === "string" ? raw.trim() : "";
      if (text.startsWith("千円")) {
        unit = "thousand_yen";
        break outer;
      }
      if (text.startsWith("百口")) {
        unit = "lot_100units";
        break outer;
      }
      if (text.startsWith("口")) {
        unit = "unit";
        break outer;
      }
    }
  }
  if (!unit) {
    throw new Error(
      `JPX investor-type (${context}): 単位表記 (千円/百口/口) が見つかりません`
    );
  }
  const expectedUnit: JpxInvestorUnit = metric === "value" ? "thousand_yen" : unit;
  if (metric === "value" && unit !== "thousand_yen") {
    throw new Error(
      `JPX investor-type (${context}): 金額シートの単位が想定外です ("${unit}")`
    );
  }
  if (metric === "volume" && unit === "thousand_yen") {
    throw new Error(
      `JPX investor-type (${context}): 口数シートの単位が想定外です ("${unit}")`
    );
  }

  let marketTotal: number | null = null;
  for (let i = periodRowIdx + 1; i < rows.length; i++) {
    if (i - periodRowIdx > 10) break;
    const c0 = cell(rows[i], 0);
    const c1 = cell(rows[i], 1).trim();
    if (c0 === "" && c1 !== "" && /^-?[\d,]+$/.test(c1)) {
      marketTotal = parseSignedNumber(c1, `${context} 総売買代金/総売買高`);
      break;
    }
  }
  if (marketTotal === null) {
    throw new Error(
      `JPX investor-type (${context}): 総売買代金/総売買高のセルが見つかりません`
    );
  }

  const categories: JpxInvestorCategoryRow[] = [];
  let currentGroup: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const c0 = cell(row, 0);
    const c1 = cell(row, 1);
    const c2 = cell(row, 2);

    if (c0.includes("内訳") && c1 === "" && c2 === "") {
      currentGroup = c0.trim();
      continue;
    }

    if (c1 !== "売り" || c2 !== "Sales") continue;

    const rowSales = row;
    const rowPurchases = rows[i + 1];
    const rowTotal = rows[i + 2];
    if (
      cell(rowPurchases, 1) !== "買い" ||
      cell(rowPurchases, 2) !== "Purchases" ||
      cell(rowTotal, 1) !== "合計" ||
      cell(rowTotal, 2) !== "Total"
    ) {
      throw new Error(
        `JPX investor-type (${context}): カテゴリブロックの行構成が想定外です ` +
          `(row ${i}: "${c0}"). 様式が変わった可能性があります`
      );
    }

    const categoryJa = c0.trim().replace(/[\s\u3000]+/g, "");
    const categoryEn = [cell(rowPurchases, 0), cell(rowTotal, 0)]
      .map((s) => s.trim())
      .filter((s) => s !== "")
      .join(" ");
    if (categoryJa === "") {
      throw new Error(
        `JPX investor-type (${context}): カテゴリ名が空です (row ${i})`
      );
    }

    const label = `${context} ${categoryJa}`;
    const sales = parseSignedNumber(cell(rowSales, 4), `${label} 売り`);
    const salesRatioPercent = parseSignedNumber(cell(rowSales, 5), `${label} 売り比率`);
    const purchases = parseSignedNumber(cell(rowPurchases, 4), `${label} 買い`);
    const purchasesRatioPercent = parseSignedNumber(
      cell(rowPurchases, 5),
      `${label} 買い比率`
    );
    const total = parseSignedNumber(cell(rowTotal, 4), `${label} 合計`);
    const totalRatioPercent = parseSignedNumber(cell(rowTotal, 5), `${label} 合計比率`);
    const balance = purchases - sales;

    // 原本の「差引き」は売り行・買い行のどちらか一方 (売り越しなら売り行、
    // 買い越しなら買い行) にだけ載る。欄が見つからないのに 買い-売り が 0 で
    // ない、あるいは両方の行に値がある場合は、位置ずれ・様式変更を疑って止める
    // (照合を黙ってスキップしない — ルール2)。差引き 0 のときに欄が空になるか
    // "0" と書かれるかは未確認のため、買い-売り=0 に限り空欄を許す。
    const reportedBalanceCells = [cell(rowSales, 6), cell(rowPurchases, 6)].filter(
      (s) => s.trim() !== ""
    );
    if (reportedBalanceCells.length > 1) {
      throw new Error(
        `JPX investor-type (${label}): 差引き欄が売り行・買い行の両方にあります ` +
          `(${reportedBalanceCells.join(" / ")})。様式が変わった可能性があります`
      );
    }
    const [reportedBalanceRaw] = reportedBalanceCells;
    if (reportedBalanceRaw === undefined) {
      if (balance !== 0) {
        throw new Error(
          `JPX investor-type (${label}): 差引き欄が空ですが 買い-売り は ${balance} です。` +
            "列の位置ずれ・様式変更の可能性があります"
        );
      }
    } else {
      const reportedBalance = parseSignedNumber(reportedBalanceRaw, `${label} 差引`);
      if (reportedBalance !== balance) {
        throw new Error(
          `JPX investor-type (${label}): 差引き(${reportedBalance}) が 買い-売り(${balance}) と一致しません`
        );
      }
    }
    if (Math.round(sales + purchases) !== Math.round(total)) {
      throw new Error(
        `JPX investor-type (${label}): 合計(${total}) が 売り+買い(${sales + purchases}) と一致しません`
      );
    }

    categories.push({
      category: categoryJa,
      categoryEn,
      group: currentGroup,
      sales,
      salesRatioPercent,
      purchases,
      purchasesRatioPercent,
      balance,
      total,
      totalRatioPercent,
    });
    i += 2;
  }

  if (categories.length === 0) {
    throw new Error(
      `JPX investor-type (${context}): カテゴリ内訳の行を1件も抽出できませんでした`
    );
  }

  return {
    metric,
    unit: expectedUnit,
    periodLabel: cell(rows[periodRowIdx], 0),
    yearMonth,
    rangeStart,
    rangeEnd,
    marketTotal,
    categories,
  };
}

/**
 * シート冒頭 (期間行より前) の表題が、呼び出し側の指定した product のものか照合する。
 * @throws 表題に product の目印語 (TITLE_MARKER) が無い場合
 */
function assertSheetTitleMatchesProduct(
  rows: unknown[][],
  product: JpxInvestorProduct,
  sheetName: string
): void {
  const marker = TITLE_MARKER[product];
  const headRows = rows.slice(0, 5);
  const found = headRows.some((row) =>
    row.some((v) => typeof v === "string" && v.replace(/[\s\u3000]+/g, "").includes(marker))
  );
  if (!found) {
    const firstCell = cell(rows[0], 0);
    throw new Error(
      `JPX ${product} investor-type (${sheetName}): シート表題に「${marker}」がありません ` +
        `(先頭セル: "${firstCell}")。別商品のファイルを渡している可能性があります`
    );
  }
}

/**
 * xls/xlsx バイト列から投資部門別売買状況を抽出する純関数。
 *
 * @throws シート構成が現行様式 (Volume + Value の2シート) と異なる場合。
 *   2026年10月13日掲載分からの新様式 (1シート統合) は本パーサでは未対応で、
 *   これに該当する場合は原因を明示して throw する。
 * @throws 期間行・単位・カテゴリブロックの行構成など、様式の前提が崩れている場合
 * @throws 差引き/合計がJPX原文の値と一致しない場合 (パース位置ズレの検知)
 */
export function parseJpxInvestorWorkbook(
  bytes: Uint8Array,
  product: JpxInvestorProduct,
  sourceUrl: string
): JpxInvestorReport {
  const workbook = XLSX.read(bytes, { type: "array" });
  const sheetNames = workbook.SheetNames;
  const hasCurrentShape =
    sheetNames.includes("Volume") && sheetNames.includes("Value");
  if (!hasCurrentShape) {
    throw new Error(
      `JPX ${product} investor-type: 未対応のシート構成です (シート: [${sheetNames.join(", ")}])。` +
        "JPXは2026年10月13日掲載分からExcelをVolume/Valueの2シートから1シートへ統合すると告知している。" +
        "この形なら新様式の可能性が高い。新様式に対応するには " +
        "services/moneyflow/lib/sources/jpx-investor-etf-reit.ts の parseJpxInvestorWorkbook を更新すること。"
    );
  }

  const volumeSheet = workbook.Sheets["Volume"]!;
  const valueSheet = workbook.Sheets["Value"]!;
  const volumeRows = XLSX.utils.sheet_to_json<unknown[]>(volumeSheet, {
    header: 1,
    defval: "",
    raw: true,
  });
  const valueRows = XLSX.utils.sheet_to_json<unknown[]>(valueSheet, {
    header: 1,
    defval: "",
    raw: true,
  });

  assertSheetTitleMatchesProduct(volumeRows, product, "Volume");
  assertSheetTitleMatchesProduct(valueRows, product, "Value");

  const volume = parseInvestorSheet(volumeRows, "volume", `${product}/Volume`);
  const value = parseInvestorSheet(valueRows, "value", `${product}/Value`);

  if (volume.unit !== VOLUME_UNIT[product]) {
    throw new Error(
      `JPX ${product} investor-type: 口数シートの単位が "${volume.unit}" です ` +
        `(想定は "${VOLUME_UNIT[product]}")。指標定義の単位と食い違うため取り込みを止めます。` +
        "JPXが単位を変更した場合は VOLUME_UNIT と指標定義を更新すること"
    );
  }

  if (volume.yearMonth !== value.yearMonth) {
    throw new Error(
      `JPX ${product} investor-type: Volume/Valueシートの対象期間が一致しません ` +
        `(${volume.yearMonth} / ${value.yearMonth})`
    );
  }

  return {
    product,
    sourceUrl,
    yearMonth: value.yearMonth,
    value,
    volume,
  };
}

// ---------------------------------------------------------------------------
// (3) 期間 (月次) と「まだ公表されていない」の判定
//
// 公表予定は「毎月第8営業日15:30」だが、祝日・休場日を自前で計算すると
// 誤りうる (ルール2: 推測しない)。実際に一覧ページへ載っているかどうかで
// 判定する (=一次情報そのものを見て判断する。休日計算による予測はしない)。
// ---------------------------------------------------------------------------

/**
 * 基準日から見て「本来ならもう公表されているはず」の対象月 (基準日の前月)。
 *
 * JPXの公表基準は JST (日本時間) の暦月。`now.getUTCMonth()` をそのまま
 * 使うと UTC の暦日で「前月」を判定してしまい、月末境界の約9時間
 * (JST 00:00〜09:00 = 前日 UTC 15:00〜24:00) でずれる
 * (例: JST 2026-10-01 05:00 = UTC 2026-09-30 20:00 を渡すと、
 * UTC 暦では「まだ9月」なので前月=8月と誤判定してしまう)。
 * `now` を +9時間シフトしてから UTC 暦フィールドを読むことで、
 * JST の暦日として「前月」を計算する。
 */
export function expectedJpxInvestorYearMonth(now: Date): string {
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const jstNow = new Date(now.getTime() + JST_OFFSET_MS);
  const y = jstNow.getUTCFullYear();
  const m = jstNow.getUTCMonth(); // 0-indexed (JST 暦)
  const prevMonth = new Date(Date.UTC(y, m - 1, 1));
  return `${prevMonth.getUTCFullYear()}-${String(prevMonth.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface JpxInvestorPublicationStatus {
  /** 基準日の前月 (=本来ならもう出ているはずの月) */
  expectedYearMonth: string;
  /** 一覧ページに実際に載っている最新月 */
  latestAvailableYearMonth: string;
  /** expectedYearMonth が一覧ページに載っているか */
  isExpectedMonthPublished: boolean;
}

/**
 * 一覧ページの実際のリンク一覧から公表状況を判定する純関数。
 * `isExpectedMonthPublished` が false の場合は「まだ公表されていない」ので、
 * 呼び出し側はその月の取込をスキップし、次回に回すこと (架空値で埋めない)。
 */
export function resolveJpxInvestorPublicationStatus(
  now: Date,
  links: JpxInvestorMonthLink[]
): JpxInvestorPublicationStatus {
  const expectedYearMonth = expectedJpxInvestorYearMonth(now);
  const latest = latestJpxInvestorMonthLink(links);
  return {
    expectedYearMonth,
    latestAvailableYearMonth: latest.yearMonth,
    isExpectedMonthPublished: links.some((l) => l.yearMonth === expectedYearMonth),
  };
}

// ---------------------------------------------------------------------------
// (4) 指標定義
// ---------------------------------------------------------------------------

export type JpxInvestorFlowType = "net_flow" | "gross_turnover";

export interface JpxInvestorIndicatorDefinition {
  key: string;
  displayName: string;
  /** 何を測るか (計画書の分類に合わせる) */
  flowType: JpxInvestorFlowType;
  /** 初心者向けの平易な説明 (1〜3文、具体例つき。ルール7の水準に合わせる) */
  plainDescription: string;
  /** 財務的に正確な定義 */
  preciseDefinition: string;
  unit: JpxInvestorUnit;
  sourceUrl: string;
  /**
   * ライセンスタグ。既存の `services/jss-api/src/shared/license.ts` の
   * `PERSONAL_ONLY` と同じ語彙 (JPX由来データは無許諾の商用二次利用・
   * 再配信が禁止のため常にこの値)。
   */
  usageConditions: "personal-only";
  /** usageConditions の意味をこの取得元に即して説明した文 */
  usageNote: string;
  frequency: "monthly";
  limitations: string;
}

const FORMAT_CHANGE_NOTE =
  "JPXは2026年10月13日掲載分からExcel様式を1シートへ統合すると告知しており、" +
  "本パーサは現行様式 (〜2026年9月分掲載) のみ対応。";

/**
 * 集計範囲の注記 (原本の(注) と JPX「資料の見方」ページ
 * https://www.jpx.co.jp/markets/statistics-equities/investor-type/06.html で確認済み):
 * 取引所取引のみ (取引所外取引は対象外)・ToSTNeT 取引を含む。
 * 「外国ETFは含まない」は ETF の原本にだけある注記なので ETF に限って書く。
 */
const SCOPE_NOTE: Record<JpxInvestorProduct, string> = {
  etf: "取引所取引のみ (取引所外取引は対象外)・ToSTNeT取引を含む・外国ETFは含まない (JPX原本の注記および「資料の見方」ページ)。",
  reit: "取引所取引のみ (取引所外取引は対象外)・ToSTNeT取引を含む (JPX原本の注記および「資料の見方」ページ)。",
};

/**
 * 投資部門の区分は入れ子になっている (2026年8月分の実データで売り・買いとも
 * 各階層の合計が完全一致することを確認済み)。区分をまたいで足すと二重計上になる。
 */
const CATEGORY_HIERARCHY_NOTE =
  "区分は入れ子: 総計=自己計+委託計、委託計=法人+個人+海外投資家+証券会社、" +
  "法人=投資信託+事業法人+その他法人等+金融機関、金融機関=生保・損保+銀行+その他金融機関。" +
  "区分をまたいで足し合わせると二重計上になる。";

function categoryLimitations(product: JpxInvestorProduct): string {
  return (
    "集計対象は資本金30億円以上の取引参加者のみ (全数調査ではない。市場全体の" +
    "総売買代金に対するカバー率は2026年8月で約99.5%)。" +
    CATEGORY_HIERARCHY_NOTE +
    "個人/自己内の現金・信用取引別、海外投資家内の法人/個人別の内訳は原本には" +
    "存在するが本パーサでは未抽出。" +
    SCOPE_NOTE[product] +
    FORMAT_CHANGE_NOTE
  );
}

/**
 * 市場全体 総売買代金/総売買高 (marketTotal) 専用の limitations。
 * 投資部門別の limitations と異なり「資本金30億円以上の取引参加者のみ」という
 * 制約は当てはまらない (marketTotal は市場参加者全体の実測合計であり、
 * むしろ投資部門別の内訳の方が資本金30億円以上の参加者に限定されている)。
 * 実データで確認済み: ETF 2026年8月は marketTotal=14,633,061,770 千円に対し
 * 投資部門別「総計」=14,556,190,891 千円 (原本の「総売買代金に占める合計」
 * 比率 99.47% と一致。母集団が異なるため約0.53%小さい)。
 */
function marketTotalLimitations(product: JpxInvestorProduct): string {
  return (
    "資本金30億円未満の取引参加者を含む市場参加者全体の実測合計 (全数)。" +
    "投資部門別の内訳 (本取得元の他4指標・「総計」を含む) は資本金30億円以上の" +
    "取引参加者に限定した集計であり母集団が異なるため、本指標とは一致しない " +
    "(2026年8月の実測で0.5〜0.7%程度、本指標の方が大きい)。両者を突き合わせて" +
    "「不一致」と扱わないこと。" +
    SCOPE_NOTE[product] +
    FORMAT_CHANGE_NOTE
  );
}

/**
 * 取引所での売買 (流通市場) の外で資金が出入りする経路。ETF は追加型の投資信託
 * なので指定参加者経由の「設定・解約 (交換)」で口数が増減するが、J-REIT は
 * 投資法人のクローズドエンド型で払い戻し (解約) が無く、口数が増えるのは
 * 公募増資等の新投資口発行 (減るのは自己投資口の取得・消却等) に限られる。
 * REIT の説明に「設定・解約」と書くと存在しない仕組みを教えることになる (ルール7)。
 */
const PRIMARY_FLOW_NOTE: Record<JpxInvestorProduct, string> = {
  etf: "指定参加者を通じた設定・解約 (交換) による口数の増減",
  reit: "公募増資等の新投資口発行。J-REITは解約(払い戻し)ができない仕組み",
};

const USAGE_CONDITIONS = "personal-only" as const;
const USAGE_NOTE =
  "JPX利用規約により無許諾での商用データ収集・二次利用・再配信は禁止。非公開の範囲に限る。";

/** この取得元 (ETF or REIT) が提供する指標の定義一覧。 */
export function jpxInvestorIndicatorDefinitions(
  product: JpxInvestorProduct
): JpxInvestorIndicatorDefinition[] {
  const label = PRODUCT_LABEL_JA[product];
  const sourceUrl = jpxInvestorListingUrl(product);
  const volumeUnit = VOLUME_UNIT[product];
  const volumeUnitJa = product === "etf" ? "百口 (100口単位)" : "口 (1口単位)";
  const categoryLimits = categoryLimitations(product);
  const marketLimits = marketTotalLimitations(product);

  return [
    {
      key: `jpx-${product}-investor-net-flow-value`,
      displayName: `${label} 投資部門別 買い越し額 (金額)`,
      flowType: "net_flow",
      plainDescription:
        `投資家のタイプ (海外投資家・個人・国内の法人など) ごとに、その月に` +
        `${label}を売った額より買った額がいくら多かったか(買い越し)、少なかったか(売り越し)を` +
        `金額で示す。原表の単位は千円なので、例えば海外投資家の値が「+100,000,000」なら` +
        `100,000,000×1,000円=1,000億円の買い越し (その投資家層から${label}へお金が向かった)。` +
        `マイナスなら逆に売り越し。`,
      preciseDefinition:
        `JPXが資本金30億円以上の取引参加者から集計した「投資部門別${label}売買状況」の` +
        `金額(千円)ベースの買付金額-売付金額。プラスは買い越し(純買い)、マイナスは売り越し` +
        `(純売り)。あくまで${label}市場「内」での投資家間の資金の付け替えの結果であり、` +
        `市場外からの新規資金流入そのもの (${PRIMARY_FLOW_NOTE[product]}) ではない点に注意。`,
      unit: "thousand_yen",
      sourceUrl,
      usageConditions: USAGE_CONDITIONS,
      usageNote: USAGE_NOTE,
      frequency: "monthly",
      limitations: categoryLimits,
    },
    {
      key: `jpx-${product}-investor-turnover-value`,
      displayName: `${label} 投資部門別 売買代金`,
      flowType: "gross_turnover",
      plainDescription:
        `投資家のタイプごとに、その月に${label}を売った金額と買った金額を足した` +
        `「取引の活発さ」を金額(千円)で示す。買い越し額と違い、売り買いが同額でも` +
        `取引量が多いほどこの値は大きくなる (資金が流入したとは限らない)。`,
      preciseDefinition:
        `投資部門別の売付金額+買付金額 (グロスの合計)。原文に付随する構成比(%) ` +
        `(本パーサの totalRatioPercent) は、自己計・委託計が「総計」に対する比率、` +
        `各投資部門 (法人・個人・海外投資家・証券会社とその内訳) が「委託計」に対する比率` +
        ` (JPX原本の注記による)。`,
      unit: "thousand_yen",
      sourceUrl,
      usageConditions: USAGE_CONDITIONS,
      usageNote: USAGE_NOTE,
      frequency: "monthly",
      limitations: categoryLimits,
    },
    {
      key: `jpx-${product}-investor-net-flow-volume`,
      displayName: `${label} 投資部門別 買い越し (口数)`,
      flowType: "net_flow",
      plainDescription:
        `${label}投資部門別 買い越し額(金額)と同じ考え方を、口数(取引された` +
        (product === "etf" ? "ETFの持分" : "投資口") +
        `の数)で示したもの。値動きの影響を受けないぶん「量」としての買い越し・売り越しが分かる。`,
      preciseDefinition: `投資部門別の買付口数-売付口数。単位は${volumeUnitJa}。`,
      unit: volumeUnit,
      sourceUrl,
      usageConditions: USAGE_CONDITIONS,
      usageNote: USAGE_NOTE,
      frequency: "monthly",
      limitations: categoryLimits,
    },
    {
      key: `jpx-${product}-investor-turnover-volume`,
      displayName: `${label} 投資部門別 売買高`,
      flowType: "gross_turnover",
      plainDescription: `${label} 投資部門別 売買代金と同じ考え方を口数で示したもの。`,
      preciseDefinition: `投資部門別の売付口数+買付口数 (グロスの合計)。単位は${volumeUnitJa}。`,
      unit: volumeUnit,
      sourceUrl,
      usageConditions: USAGE_CONDITIONS,
      usageNote: USAGE_NOTE,
      frequency: "monthly",
      limitations: categoryLimits,
    },
    {
      key: `jpx-${product}-market-turnover-value`,
      displayName: `${label} 市場全体 総売買代金`,
      flowType: "gross_turnover",
      plainDescription:
        `その月に${label}市場全体で行われた売りの金額と買いの金額をすべて足した値 ` +
        `(自己・委託を含む)。1回の売買を売り手側と買い手側の両方で数えるので、` +
        `ニュース等でいう「売買代金」(1回の売買を1回と数える) のおよそ2倍の大きさになる。` +
        `市場がどれだけ活発だったかの目安で、お金が流れ込んだ量ではない。`,
      preciseDefinition:
        `シート冒頭の「総売買代金 (売り買い合計)」の値 (売付代金+買付代金)。` +
        `資本金30億円未満の取引参加者を含む市場参加者全体の実測合計であり、` +
        `投資部門別の内訳 (本取得元の他4指標・「総計」) が対象とする資本金30億円以上の` +
        `取引参加者限定の集計とは母集団が異なるため一致しない (2026年8月の実測で` +
        `0.5〜0.7%程度の差)。`,
      unit: "thousand_yen",
      sourceUrl,
      usageConditions: USAGE_CONDITIONS,
      usageNote: USAGE_NOTE,
      frequency: "monthly",
      limitations: marketLimits,
    },
    {
      key: `jpx-${product}-market-turnover-volume`,
      displayName: `${label} 市場全体 総売買高`,
      flowType: "gross_turnover",
      plainDescription:
        `${label} 市場全体 総売買代金と同じ考え方を口数で示したもの ` +
        `(売り手側・買い手側の両方で数えるため、売買が成立した口数のおよそ2倍になる)。`,
      preciseDefinition:
        `シート冒頭の「総売買高 (売り買い合計)」の値 (売付口数+買付口数、単位は${volumeUnitJa})。` +
        `市場参加者全体の実測合計であり、投資部門別の内訳 (総計) とは母集団が異なるため一致しない。`,
      unit: volumeUnit,
      sourceUrl,
      usageConditions: USAGE_CONDITIONS,
      usageNote: USAGE_NOTE,
      frequency: "monthly",
      limitations: marketLimits,
    },
  ];
}

// ---------------------------------------------------------------------------
// 観測ログ (縦長) 形式への変換 — 期間・指標キー・区分・値・単位・近似/推定フラグ
// ---------------------------------------------------------------------------

export interface JpxInvestorObservationRow {
  /** "2026-08" */
  period: string;
  indicatorKey: string;
  /** 投資部門 (例: "海外投資家") または "市場全体" */
  category: string;
  value: number;
  unit: JpxInvestorUnit;
  /** 集計対象が資本金30億円以上の取引参加者に限られる等の理由で、市場全体の
   * 完全な実測ではなく近似であることを示す。市場全体 (category="市場全体") の
   * 総売買代金/総売買高は資本金30億円未満の参加者も含む実測合計なので false、
   * 投資部門別の各カテゴリ (海外投資家・個人 等) は資本金30億円以上の取引参加者
   * 限定の集計なので true。 */
  isApproximate: boolean;
  /** モデル推定値か (本取得元はJPXの実測集計そのものなので常にfalse) */
  isEstimated: boolean;
}

/** JpxInvestorReport を観測ログ用の縦長レコードへ変換する。Notion書込は行わない (統合担当の責務)。 */
export function toJpxInvestorObservationRows(
  report: JpxInvestorReport
): JpxInvestorObservationRow[] {
  const rows: JpxInvestorObservationRow[] = [];
  const push = (
    indicatorKey: string,
    category: string,
    value: number,
    unit: JpxInvestorUnit,
    isApproximate: boolean
  ): void => {
    rows.push({
      period: report.yearMonth,
      indicatorKey,
      category,
      value,
      unit,
      isApproximate,
      isEstimated: false,
    });
  };

  for (const sheet of [report.value, report.volume]) {
    const netKey = `jpx-${report.product}-investor-net-flow-${sheet.metric}`;
    const turnoverKey = `jpx-${report.product}-investor-turnover-${sheet.metric}`;
    const marketKey = `jpx-${report.product}-market-turnover-${sheet.metric}`;
    // 市場全体の総売買代金/総売買高は資本金30億円未満の参加者も含む実測合計
    // (投資部門別の内訳とは異なり全数に近い) — isApproximate=false。
    push(marketKey, "市場全体", sheet.marketTotal, sheet.unit, false);
    for (const category of sheet.categories) {
      push(netKey, category.category, category.balance, sheet.unit, true);
      push(turnoverKey, category.category, category.total, sheet.unit, true);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// ルール6: 一次データ Notion アーカイブ入力を組み立てる純関数
// (recordPrimaryData() 自体は呼ばない。呼ぶのは統合担当の ingest スクリプト)
// ---------------------------------------------------------------------------

export interface JpxInvestorArchiveInput {
  service: string;
  key: string;
  source: string;
  metadata: Record<string, unknown>;
  files: Array<{ bytes: Uint8Array; filename: string; contentType: string }>;
}

export function jpxInvestorArchiveInput(
  workbook: JpxInvestorWorkbookFile
): JpxInvestorArchiveInput {
  return {
    service: "moneyflow",
    key: `jpx-${workbook.product}-investor-${workbook.yearMonth}`,
    source: workbook.sourceUrl,
    metadata: {
      product: workbook.product,
      yearMonth: workbook.yearMonth,
      filename: workbook.filename,
      bytes: workbook.bytes.byteLength,
    },
    files: [
      {
        bytes: workbook.bytes,
        filename: workbook.filename,
        contentType: workbook.contentType,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 便宜的な一括関数: 最新月を解決・取得・パースし、アーカイブ入力まで組み立てる
// ---------------------------------------------------------------------------

export interface JpxInvestorFetchResult {
  workbook: JpxInvestorWorkbookFile;
  report: JpxInvestorReport;
  archiveInput: JpxInvestorArchiveInput;
  observationRows: JpxInvestorObservationRow[];
}

export async function fetchAndParseLatestJpxInvestor(
  product: JpxInvestorProduct
): Promise<JpxInvestorFetchResult> {
  const workbook = await fetchLatestJpxInvestorWorkbook(product);
  const report = parseJpxInvestorWorkbook(
    workbook.bytes,
    product,
    workbook.sourceUrl
  );
  // アーカイブの冪等キー (リンクの年月) と観測行の period (ファイル中身の年月) が
  // 食い違ったまま記録されないよう、ここで照合して止める (ルール2)。
  if (report.yearMonth !== workbook.yearMonth) {
    throw new Error(
      `JPX ${product} investor-type: リンクの年月 (${workbook.yearMonth}, ${workbook.filename}) と ` +
        `ファイル中の対象期間 (${report.yearMonth}) が一致しません (${workbook.sourceUrl})`
    );
  }
  return {
    workbook,
    report,
    archiveInput: jpxInvestorArchiveInput(workbook),
    observationRows: toJpxInvestorObservationRows(report),
  };
}
