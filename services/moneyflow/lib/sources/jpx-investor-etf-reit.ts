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
 * 禁止 (`commercial_use: prohibited`)。個人利用の範囲に限る (`personal-only`)。
 * 規約は「高頻度・高負荷に繋がる可能性のある自動取得等はご遠慮いただいて
 * おります」と明記しており、1 回の実行につき一覧ページ 1 回・ファイル 1 回
 * (月次更新なので月 1 回) に留めること。
 */

import * as XLSX from "xlsx";

export type JpxInvestorProduct = "etf" | "reit";

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
  ext: "xls" | "xlsx";
}

/**
 * 一覧ページ HTML から月次ファイル (etf_mYYMM.xls[x] / reit_mYYMM.xls[x]) への
 * リンクを抽出する。サンプルファイル (`etf_mYYYYMM.xlsx` 等、月が数字でない)
 * や revision_information 系のリンクは正規表現の `\d{4}` 制約により対象外。
 *
 * @throws リンクが 1 件も見つからない場合 (ページ構造が変わった可能性)
 */
export function parseJpxInvestorMonthLinks(
  html: string,
  product: JpxInvestorProduct
): JpxInvestorMonthLink[] {
  const prefix = FILE_PREFIX[product];
  const re = new RegExp(
    `href="([^"]*${prefix}(\\d{4})\\.(xlsx?))"`,
    "g"
  );
  const byYearMonth = new Map<string, JpxInvestorMonthLink>();
  for (const m of html.matchAll(re)) {
    const href = m[1]!;
    const yymm = m[2]!;
    const ext = m[3] as "xls" | "xlsx";
    const yy = Number(yymm.slice(0, 2));
    const mo = Number(yymm.slice(2, 4));
    if (mo < 1 || mo > 12) {
      throw new Error(
        `JPX ${product} investor-type: リンクの月が不正です ("${yymm}" in ${href})`
      );
    }
    // JPXの YYMM 命名は 2000年代を前提にした2桁年。21世紀中は一意に復元できる。
    const yearMonth = `${2000 + yy}-${String(mo).padStart(2, "0")}`;
    const absoluteHref = href.startsWith("http") ? href : `${JPX_BASE}${href}`;
    const existing = byYearMonth.get(yearMonth);
    // 移行期に同じ月へ xls/xlsx 両方のリンクが載る可能性がある。新拡張子を優先する。
    if (!existing || (existing.ext === "xls" && ext === "xlsx")) {
      byYearMonth.set(yearMonth, { yearMonth, href: absoluteHref, ext });
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
  const yymm = latest.yearMonth.replace("-", "").slice(2);
  return {
    product,
    yearMonth: latest.yearMonth,
    sourceUrl: latest.href,
    filename: `${FILE_PREFIX[product]}${yymm}.${latest.ext}`,
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

    const reportedBalanceRaw = [cell(rowSales, 6), cell(rowPurchases, 6)].find(
      (s) => s.trim() !== ""
    );
    if (reportedBalanceRaw !== undefined) {
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

  const volume = parseInvestorSheet(volumeRows, "volume", `${product}/Volume`);
  const value = parseInvestorSheet(valueRows, "value", `${product}/Value`);

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

const COMMON_LIMITATIONS =
  "集計対象は資本金30億円以上の取引参加者のみ (全数調査ではない)。" +
  "個人/自己内の現金・信用取引別、海外投資家内の法人/個人別の内訳は原本には" +
  "存在するが本パーサでは未抽出。" +
  FORMAT_CHANGE_NOTE +
  "外国ETF/私募REIT等は集計対象外 (ETFの場合)。";

/**
 * 市場全体 総売買代金/総売買高 (marketTotal) 専用の limitations。
 * COMMON_LIMITATIONS と異なり「資本金30億円以上の取引参加者のみ」という
 * 制約は当てはまらない (marketTotal は市場参加者全体の実測合計であり、
 * むしろ投資部門別の内訳の方が資本金30億円以上の参加者に限定されている)。
 * 実データで確認済み: ETF 2026年8月は marketTotal=14,633,061,770 千円に対し
 * 投資部門別「総計」=14,556,190,891 千円 (母集団が異なるため約0.53%小さい)。
 */
const MARKET_TOTAL_LIMITATIONS =
  "資本金30億円未満の取引参加者を含む市場参加者全体の実測合計 (全数)。" +
  "投資部門別の内訳 (本取得元の他4指標・「総計」を含む) は資本金30億円以上の" +
  "取引参加者に限定した集計であり母集団が異なるため、本指標とは一致しない " +
  "(実測ではおおむね0.5%前後、本指標の方が大きい)。両者を突き合わせて" +
  "「不一致」と扱わないこと。" +
  FORMAT_CHANGE_NOTE +
  "外国ETF/私募REIT等は集計対象外 (ETFの場合)。";

const USAGE_CONDITIONS = "personal-only" as const;
const USAGE_NOTE =
  "JPX利用規約により無許諾での商用データ収集・二次利用・再配信は禁止。個人利用の範囲に限る。";

/** この取得元 (ETF or REIT) が提供する指標の定義一覧。 */
export function jpxInvestorIndicatorDefinitions(
  product: JpxInvestorProduct
): JpxInvestorIndicatorDefinition[] {
  const label = PRODUCT_LABEL_JA[product];
  const sourceUrl = jpxInvestorListingUrl(product);
  const volumeUnit: JpxInvestorUnit = product === "etf" ? "lot_100units" : "unit";

  return [
    {
      key: `jpx-${product}-investor-net-flow-value`,
      displayName: `${label} 投資部門別 買い越し額 (金額)`,
      flowType: "net_flow",
      plainDescription:
        `投資家のタイプ (海外投資家・個人・国内の法人など) ごとに、その月に` +
        `${label}をいくら多く買ったか(買い越し)、多く売ったか(売り越し)を金額(千円)で示す。` +
        `例えば海外投資家の値が「+1,293億円(1,293,417円×1000)」ならその月は海外投資家が` +
        `約1,293億円分多く買った(=資金が流入した)ことを意味する。マイナスなら逆に売り越し。`,
      preciseDefinition:
        `JPXが資本金30億円以上の取引参加者から集計した「投資部門別${label}売買状況」の` +
        `金額(千円)ベースの買付金額-売付金額。プラスは買い越し(純買い)、マイナスは売り越し` +
        `(純売り)。あくまで${label}市場「内」での投資家間の資金の付け替えの結果であり、` +
        `市場外からの新規資金流入 (設定・解約等) そのものではない点に注意。`,
      unit: "thousand_yen",
      sourceUrl,
      usageConditions: USAGE_CONDITIONS,
      usageNote: USAGE_NOTE,
      frequency: "monthly",
      limitations: COMMON_LIMITATIONS,
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
        `投資部門別の売付金額+買付金額 (グロスの合計)。委託計/自己計または総計に対する` +
        `構成比(%)が原文に付随する (本パーサの totalRatioPercent)。`,
      unit: "thousand_yen",
      sourceUrl,
      usageConditions: USAGE_CONDITIONS,
      usageNote: USAGE_NOTE,
      frequency: "monthly",
      limitations: COMMON_LIMITATIONS,
    },
    {
      key: `jpx-${product}-investor-net-flow-volume`,
      displayName: `${label} 投資部門別 買い越し (口数)`,
      flowType: "net_flow",
      plainDescription:
        `${label}投資部門別 買い越し額(金額)と同じ考え方を、口数(取引された` +
        (product === "etf" ? "ETFの持分" : "投資口") +
        `の数)で示したもの。値動きの影響を受けないぶん「量」としての買い越し・売り越しが分かる。`,
      preciseDefinition: `投資部門別の買付口数-売付口数。単位は` +
        (product === "etf" ? "百口 (100単位)" : "口 (1単位)") +
        `。`,
      unit: volumeUnit,
      sourceUrl,
      usageConditions: USAGE_CONDITIONS,
      usageNote: USAGE_NOTE,
      frequency: "monthly",
      limitations: COMMON_LIMITATIONS,
    },
    {
      key: `jpx-${product}-investor-turnover-volume`,
      displayName: `${label} 投資部門別 売買高`,
      flowType: "gross_turnover",
      plainDescription: `${label} 投資部門別 売買代金と同じ考え方を口数で示したもの。`,
      preciseDefinition: `投資部門別の売付口数+買付口数 (グロスの合計)。`,
      unit: volumeUnit,
      sourceUrl,
      usageConditions: USAGE_CONDITIONS,
      usageNote: USAGE_NOTE,
      frequency: "monthly",
      limitations: COMMON_LIMITATIONS,
    },
    {
      key: `jpx-${product}-market-turnover-value`,
      displayName: `${label} 市場全体 総売買代金`,
      flowType: "gross_turnover",
      plainDescription:
        `その月に${label}市場全体で成立した売買の金額の合計 (自己・委託、売り・買いの` +
        `すべてを合算した値)。市場がどれだけ活発だったかの目安。`,
      preciseDefinition:
        `シート冒頭の「総売買代金 (売り買い合計)」の値。資本金30億円未満の取引参加者を` +
        `含む市場参加者全体の実測合計であり、投資部門別の内訳 (本取得元の他4指標・` +
        `「総計」) が対象とする資本金30億円以上の取引参加者限定の集計とは母集団が異なる` +
        `ため一致しない (実測ではおおむね0.5%前後の差)。`,
      unit: "thousand_yen",
      sourceUrl,
      usageConditions: USAGE_CONDITIONS,
      usageNote: USAGE_NOTE,
      frequency: "monthly",
      limitations: MARKET_TOTAL_LIMITATIONS,
    },
    {
      key: `jpx-${product}-market-turnover-volume`,
      displayName: `${label} 市場全体 総売買高`,
      flowType: "gross_turnover",
      plainDescription: `${label} 市場全体 総売買代金と同じ考え方を口数で示したもの。`,
      preciseDefinition:
        `シート冒頭の「総売買高 (売り買い合計)」の値。市場参加者全体の実測合計であり、` +
        `投資部門別の内訳 (総計) とは母集団が異なるため一致しない。`,
      unit: volumeUnit,
      sourceUrl,
      usageConditions: USAGE_CONDITIONS,
      usageNote: USAGE_NOTE,
      frequency: "monthly",
      limitations: MARKET_TOTAL_LIMITATIONS,
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
  return {
    workbook,
    report,
    archiveInput: jpxInvestorArchiveInput(workbook),
    observationRows: toJpxInvestorObservationRows(report),
  };
}
