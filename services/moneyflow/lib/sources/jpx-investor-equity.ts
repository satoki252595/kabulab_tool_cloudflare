/**
 * moneyflow (Phase 2) — 取得元: JPX「投資部門別売買状況」(株式、週次・月次)
 *
 * ソース一覧ページ:
 *   週間 https://www.jpx.co.jp/markets/statistics-equities/investor-type/index.html
 *   月間 https://www.jpx.co.jp/markets/statistics-equities/investor-type/00-01.html
 *
 * 計測しているもの: 投資部門 (自己/委託の内訳=個人・海外投資家・証券会社・事業法人等・
 * 金融機関…) ごとの株式売買代金・売買高の「売り」「買い」と、その差 (買い-売り = 買い
 * 越し/売り越し)。市場区分 (プライム/スタンダード/グロース/二市場合算) 別に集計されて
 * おり、東証33業種別の内訳は無い (JPX公式に存在しない粒度。README/plan 参照)。
 *
 * 【2026-09-29 の様式変更 (週次)】JPX は 2026-09-29 掲載分の「週間」資料から、従来
 * 「売買代金(val)」「売買高(vol)」に分かれていた PDF/Excel を 1 ファイルに統合し、
 * 直近週のみを収録する様式に変える予告をしている (投資部門別売買状況 一覧ページの
 * お知らせ、及び同ページ掲載のサンプルファイル
 * `stock_1_w_YYYYMMDD_YYYYMMDD.xlsx` で確認)。本モジュール作成時点 (2026-09-27) では
 * まだ旧様式 (val/vol 別ファイル、市場別シート) の実ファイルしか存在しないため:
 *   - 旧様式 (legacy) パーサ: 実際に配布されている週次・月次ファイルから検証。
 *   - 新様式 (unified) パーサ: JPX 公式サンプルファイル (実データではなく仕様サンプル。
 *     ファイル名も `YYYYMMDD` の未置換プレースホルダ) の構造だけを検証。9/29 以降の
 *     実ファイルで再検証が必要 (このモジュールの既知の限界。下記 export
 *     `KNOWN_LIMITATIONS` にも明記)。
 *
 * 【2026-10-08 の様式変更 (月次・週次とは別告知)】月次一覧ページ (00-01.html) には
 * 週次とは別建てで、2026-10-08 掲載分から月次ファイルを株数/金額の2ファイルから
 * 1ファイルに統合し、ファイル名も `stock_1_mYYYYMM.xlsx` (週の概念なし) に変える
 * 予告が掲載されている (公式サンプル `stock_1_mYYYYMM.xlsx` で構造を確認済み)。
 * この新様式はヘッダ行が「年月週 Year, Month, Week」ではなく「年月 Year, Month」で
 * 始まり、市場ごとに株数行/金額行を分ける全く別のレイアウトのため、`parseUnifiedSheet`
 * (週次の新様式用) では読めず、ヘッダ行が見つからず throw する (ルール2的には安全側の
 * 失敗だが、月次専用の新様式パーサは未実装。KNOWN_LIMITATIONS 参照)。
 *
 * 利用条件: JPX 利用規約により、許諾なしの商用二次利用・再配信・生成AIによる
 * 学習/解析利用は禁止されている。kabulab では「資金フロー」個人用 Notion ページ
 * (非公開) にのみ保存し、公開Webへは出さない (license_tag=personal-only 相当)。
 * また規約は「高頻度・高負荷に繋がる可能性のある自動取得」の自粛を求めている。
 * 本モジュールの fetch 系関数は 1 回の呼び出しで一覧ページ 1 回 + 対象ファイル
 * (週次は val/vol 2 本、月次も 2 本) のみを取得し、業務日 1 回程度の頻度を前提にする。
 *
 * CLAUDE.md ルール2 (フォールバック禁止) の適用:
 *   - 数値セルが解釈できない/様式が想定と違う場合は必ず throw する (既定値で埋めない)。
 *   - 「今週/今月がまだ公表されていない」は一覧ページ自体が公表済みの行/リンクしか
 *     載せないという性質を使い、実際に観測できる事実 (行が無い/リンクが "-") から
 *     判定する。カレンダー計算 (第n営業日等の祝日推定) による予測はしない — 予測が
 *     外れて「公表済みなのに未公表」「未公表なのに公表済み」と誤判定するリスクを
 *     捏造値と同様に避けるため。
 *
 * Notion 一次データアーカイブ (ルール6) は本ファイルでは行わない (`recordPrimaryData`
 * を呼ばない)。`jpxInvestorEquityArchiveInput()` が入力を組み立てるだけで、実際の
 * 記録は統合担当のスクリプトが行う (`services/vwap-analysis/lib/margin.ts` の
 * `marginArchiveInput` と同じ分担)。
 */
import * as XLSX from "xlsx";

// JPX 系ソースが共有しているブラウザ相当 UA と同一の値
// (services/vwap-analysis/lib/margin.ts, src/shared/jpx/sectors.ts 参照)。
// UA を付けない既定の fetch は JPX 側の WAF に 403 で弾かれることを確認済み
// (docs/moneyflow 調査ログ参照)。共有定数モジュールは Phase 0 側の管轄のため、
// このソース単体の担当範囲では新設せず、既存コードと同一のリテラル値を使う。
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const BASE = "https://www.jpx.co.jp";
const WEEKLY_INDEX_PATH = "/markets/statistics-equities/investor-type/index.html";
const MONTHLY_INDEX_PATH = "/markets/statistics-equities/investor-type/00-01.html";
export const WEEKLY_INDEX_URL = `${BASE}${WEEKLY_INDEX_PATH}`;
export const MONTHLY_INDEX_URL = `${BASE}${MONTHLY_INDEX_PATH}`;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    throw new Error(`JPX 投資部門別売買状況: HTTP エラー ${res.status} ${res.statusText} (${url})`);
  }
  return res.text();
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    throw new Error(`JPX 投資部門別売買状況: HTTP エラー ${res.status} ${res.statusText} (${url})`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

export type InvestorEquityPeriodType = "weekly" | "monthly";
export type InvestorEquityMetric = "value" | "volume";
export type InvestorEquityMarket =
  | "TSE Prime"
  | "TSE Standard"
  | "TSE Growth"
  | "Tokyo & Nagoya";

export type WorkbookFormatVersion = "legacy_split_files" | "unified_single_file";

/** 1 市場 × 1 投資部門 × 1 指標 (金額 or 株数) の 1 レコード */
export interface InvestorEquityRecord {
  formatVersion: WorkbookFormatVersion;
  periodType: InvestorEquityPeriodType;
  /** 例: "2026年9月第2週" / "2026年8月" */
  periodLabel: string;
  /** ISO 8601 (YYYY-MM-DD)。unified 様式でファイル名から取得できない場合は null
   *  (rule2: 分からない値を計算で埋めない。分からないことを型で表す) */
  periodStart: string | null;
  periodEnd: string | null;
  market: InvestorEquityMarket;
  /** JPX 表記そのままの投資部門名 (例: "自己計", "個人", "海外投資家法人") */
  investorCategory: string;
  /** 委託計/自己計/総計/金融機関など、他カテゴリの合算である行なら true */
  isAggregateCategory: boolean;
  metric: InvestorEquityMetric;
  /** value="thousand_yen" (千円) / volume="thousand_shares" (千株) */
  unit: "thousand_yen" | "thousand_shares";
  sell: number;
  buy: number;
  /** buy - sell (買い越しなら正、売り越しなら負)。JPX の「差引」欄をそのまま拾わず
   *  自前で再計算する (差引欄は符号によって売り行/買い行のどちらかにしか出ない
   *  表示上の癖があり、常に同じ列位置に出るとは限らないため)。 */
  net: number;
  /** sell + buy (売買合計)。JPX が明示している「合計」列との突き合わせ済み */
  total: number;
}

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

function normalizeCategoryLabel(raw: unknown): string {
  const s = String(raw ?? "");
  // 全角スペース(U+3000)・半角スペースを除去 (例: 表記上「総」と「計」の間に
  // 全角スペースが入る行があるため正規化して「総計」に揃える)
  return s.replace(/[\s\u3000]/g, "");
}

/** JPX 表の数値セルを解釈する。カンマ区切り・"▲"(マイナス表記) に対応。
 *  解釈できなければ throw する (ルール2: 既定値で埋めない)。 */
export function parseJpxAmount(value: unknown): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`JPX 投資部門別売買状況: 数値が不正です (${String(value)})`);
    }
    return value;
  }
  const s = String(value ?? "").trim();
  if (s === "") {
    throw new Error("JPX 投資部門別売買状況: 数値セルが空です (想定外の様式)");
  }
  const cleaned = s.replace(/,/g, "").replace(/▲\s*/g, "-");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) {
    throw new Error(`JPX 投資部門別売買状況: 数値として解釈できません: "${s}"`);
  }
  return n;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** URL の最終パスセグメント (ファイル名) を取り出す。取れなければ throw する
 *  (アーカイブ入力のファイル名を "value.xls" 等の作り物で埋めない)。 */
function urlBasename(url: string): string {
  const name = url.split("/").pop();
  if (!name) {
    throw new Error(`JPX 投資部門別売買状況: URL からファイル名を取得できません: "${url}"`);
  }
  return name;
}

// ---------------------------------------------------------------------------
// 旧様式 (legacy_split_files): 市場別4シート (TSE Prime/Standard/Growth/Tokyo & Nagoya)
// 各シート内に「今週」「前週(または前月)」の2ブロック (無い方は空欄)。
// ---------------------------------------------------------------------------

const LEGACY_MARKET_SHEET_NAMES: readonly InvestorEquityMarket[] = [
  "TSE Prime",
  "TSE Standard",
  "TSE Growth",
  "Tokyo & Nagoya",
];

interface LegacyPeriodInfo {
  periodType: InvestorEquityPeriodType;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  /** row10 のうち、この期間のデータが入っている列群 (値・比率・差引) */
  columns: { value: number; ratio: number; balance: number };
}

// 例:
//  週次 "2026年9月第2週 2026/9 week2  ( 9/7 - 9/11 )"
//  週次(月またぎ) "2026年9月第1週 2026/9 week1  ( 8/31 - 9/4 )"
//  月次 "2026年8月 2026/8  ( 8/3 - 8/28 )"
const TITLE_RE =
  /^(\d{4})年(\d{1,2})月(?:第(\d)週)?\s+\d{4}\/\d{1,2}(?:\s*week\d)?\s*\(\s*(\d{1,2})\/(\d{1,2})\s*-\s*(\d{1,2})\/(\d{1,2})\s*\)/;

function parseLegacyTitle(titleRaw: unknown): {
  periodType: InvestorEquityPeriodType;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
} {
  const title = String(titleRaw ?? "").trim();
  const m = TITLE_RE.exec(title);
  if (!m) {
    throw new Error(
      `JPX 投資部門別売買状況: 期間タイトルの様式が想定と異なります: "${title}"`
    );
  }
  const [, yearStr, monthStr, weekStr, startMonthStr, startDayStr, endMonthStr, endDayStr] = m;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const startMonth = Number(startMonthStr);
  const startDay = Number(startDayStr);
  const endMonth = Number(endMonthStr);
  const endDay = Number(endDayStr);

  if (endMonth !== month) {
    // タイトルの月 (例: "9月") と終了日の月が一致しない = 想定外の様式変更
    throw new Error(
      `JPX 投資部門別売買状況: タイトルの月(${month})と期間終了日の月(${endMonth})が一致しません: "${title}"`
    );
  }
  // 開始日が終了日より後の月 (例: 8月31日 → 9月4日) は年をまたがない前提で、
  // 開始月が終了月より大きい場合のみ前年に繰り下げる (12月→1月のまたぎ想定)。
  const startYear = startMonth > endMonth ? year - 1 : year;

  const periodType: InvestorEquityPeriodType = weekStr !== undefined ? "weekly" : "monthly";
  const periodLabel =
    periodType === "weekly" ? `${year}年${month}月第${weekStr}週` : `${year}年${month}月`;

  return {
    periodType,
    periodLabel,
    periodStart: `${startYear}-${pad2(startMonth)}-${pad2(startDay)}`,
    periodEnd: `${year}-${pad2(endMonth)}-${pad2(endDay)}`,
  };
}

/** row10 (0-indexed) の日付ヘッダ ("MM/DD～MM/DD" 相当) を月日ペアに分解する。
 *  空白/未使用ブロックなら null を返す。 */
function parseBlockDateRange(cell: unknown): { startMonth: number; startDay: number; endMonth: number; endDay: number } | null {
  const s = String(cell ?? "").trim();
  if (s === "") return null;
  const m = /^(\d{2})\/(\d{2}).(\d{2})\/(\d{2})$/.exec(s);
  if (!m) return null;
  return {
    startMonth: Number(m[1]),
    startDay: Number(m[2]),
    endMonth: Number(m[3]),
    endDay: Number(m[4]),
  };
}

function resolveLegacyPeriod(rows: unknown[][]): LegacyPeriodInfo {
  const parsedTitle = parseLegacyTitle(rows[3]?.[0]);
  const header = rows[10] ?? [];
  const left = parseBlockDateRange(header[3]);
  const right = parseBlockDateRange(header[7]);

  const matches = (
    r: { startMonth: number; startDay: number; endMonth: number; endDay: number } | null
  ): boolean => {
    if (!r) return false;
    const [sm, sd] = parsedTitle.periodStart.split("-").slice(1).map(Number);
    const [em, ed] = parsedTitle.periodEnd.split("-").slice(1).map(Number);
    return r.startMonth === sm && r.startDay === sd && r.endMonth === em && r.endDay === ed;
  };

  // 列位置の注記: row10 の期間見出しテキスト自体は col3(左)/col7(右) にあるが、
  // 実際の「金額 Value」列は原本シート上でその1列右 (col4/col8) にずれている
  // (col3/col7 はテキスト用の空白スペーサー列で、数値は常に1列右に入る実測仕様。
  // 週次・月次いずれの実ファイルでも確認済み)。比率(col5/col9)・差引(col6/col10)は
  // ずれない。
  if (matches(left)) {
    return { ...parsedTitle, columns: { value: 4, ratio: 5, balance: 6 } };
  }
  if (matches(right)) {
    return { ...parsedTitle, columns: { value: 8, ratio: 9, balance: 10 } };
  }
  throw new Error(
    `JPX 投資部門別売買状況: 期間ヘッダ(${JSON.stringify(header[3])} / ${JSON.stringify(
      header[7]
    )})とタイトル(${parsedTitle.periodStart}〜${parsedTitle.periodEnd})が一致しません (様式変更の可能性)`
  );
}

// 「法人」は「金融機関」と同じ構造 (自分の子カテゴリの合算) の集計行。
// 実ファイル (monthly-value-2026-08.xls TSE Prime) で実測して確認済み:
// 法人 = 投資信託 + 事業法人 + その他法人等 + 金融機関 (売り・買いとも円単位で一致)。
// 金融機関のみ集計行として扱い法人を漏らすと、下流の市場合計集計で
// 法人と各子カテゴリを二重計上してしまう (isAggregateCategory===false の行だけを
// 合算する想定の呼び出し側を壊す)。
const AGGREGATE_CATEGORIES = new Set(["自己計", "委託計", "総計", "法人", "金融機関"]);

function parseLegacySheet(
  sheetName: string,
  rows: unknown[][]
): { records: Omit<InvestorEquityRecord, "formatVersion" | "market">[]; period: LegacyPeriodInfo; metric: InvestorEquityMetric; unit: "thousand_yen" | "thousand_shares" } {
  const title = String(rows[0]?.[0] ?? "");
  let metric: InvestorEquityMetric;
  let unit: "thousand_yen" | "thousand_shares";
  if (title.includes("[金額]")) {
    metric = "value";
    unit = "thousand_yen";
  } else if (title.includes("[株数]")) {
    metric = "volume";
    unit = "thousand_shares";
  } else {
    throw new Error(
      `JPX 投資部門別売買状況 (${sheetName}): シート見出しに [金額]/[株数] が見つかりません: "${title}"`
    );
  }

  const period = resolveLegacyPeriod(rows);
  const valueCol = period.columns.value;

  const records: Omit<InvestorEquityRecord, "formatVersion" | "market">[] = [];
  for (let i = 12; i + 2 < rows.length; i++) {
    const r0 = rows[i] ?? [];
    const r1 = rows[i + 1] ?? [];
    const r2 = rows[i + 2] ?? [];
    if (r0[2] !== "Sales" || r1[2] !== "Purchases" || r2[2] !== "Total") continue;

    const label = normalizeCategoryLabel(r0[0]);
    if (label === "") continue;

    const sell = parseJpxAmount(r0[valueCol]);
    const buy = parseJpxAmount(r1[valueCol]);
    const total = parseJpxAmount(r2[valueCol]);
    const computedTotal = sell + buy;
    // 合計列との整合チェック (千円/千株の丸めで±1程度のズレは許容)。
    if (Math.abs(computedTotal - total) > 1) {
      throw new Error(
        `JPX 投資部門別売買状況 (${sheetName}/${label}): 売買合計の不整合 (売り+買い=${computedTotal}, 表の合計=${total})`
      );
    }

    records.push({
      periodType: period.periodType,
      periodLabel: period.periodLabel,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      investorCategory: label,
      isAggregateCategory: AGGREGATE_CATEGORIES.has(label),
      metric,
      unit,
      sell,
      buy,
      net: buy - sell,
      total,
    });
  }

  if (records.length === 0) {
    throw new Error(
      `JPX 投資部門別売買状況 (${sheetName}): 投資部門の行が1件も見つかりません (様式変更の可能性)`
    );
  }

  return { records, period, metric, unit };
}

// ---------------------------------------------------------------------------
// 新様式 (unified_single_file): 2026-09-29 以降を想定。単一シートに全市場・
// 全指標(株数/金額)を1行ずつ縦持ち。JPX 公式サンプルファイル
// (`stock_1_w_YYYYMMDD_YYYYMMDD.xlsx`) の構造から実装。実データでの再検証が必要
// (KNOWN_LIMITATIONS 参照)。
// ---------------------------------------------------------------------------

const JA_MARKET_TO_CANONICAL: Record<string, InvestorEquityMarket> = {
  東証プライム: "TSE Prime",
  東証スタンダード: "TSE Standard",
  東証グロース: "TSE Growth",
  二市場: "Tokyo & Nagoya",
};

/** サンプルファイルから読み取った列オフセット→投資部門名の対応。各エントリの
 *  guard 文字列は実行時に対応する見出しセルに含まれているはずの部分文字列で、
 *  一致しなければ throw する (様式変更の検知)。 */
const UNIFIED_GROUPS: ReadonlyArray<{
  col: number;
  label: string;
  guardAncestorOffset: number; // headerRowIdx からの相対行 (-1 or -2)
  guardSubstring: string;
}> = [
  { col: 3, label: "自己現金", guardAncestorOffset: -1, guardSubstring: "現金取引" },
  { col: 7, label: "自己信用", guardAncestorOffset: -1, guardSubstring: "信用取引" },
  { col: 11, label: "個人現金", guardAncestorOffset: -1, guardSubstring: "現金取引" },
  { col: 15, label: "個人信用", guardAncestorOffset: -1, guardSubstring: "信用取引" },
  { col: 19, label: "海外投資家法人", guardAncestorOffset: -1, guardSubstring: "法人" },
  { col: 23, label: "海外投資家個人", guardAncestorOffset: -1, guardSubstring: "個人" },
  { col: 27, label: "証券会社", guardAncestorOffset: -1, guardSubstring: "証券会社" },
  { col: 31, label: "投資信託", guardAncestorOffset: -1, guardSubstring: "投資信託" },
  { col: 35, label: "事業法人", guardAncestorOffset: -1, guardSubstring: "事業法人" },
  { col: 39, label: "その他法人等", guardAncestorOffset: -1, guardSubstring: "その他法人等" },
  { col: 43, label: "生保・損保", guardAncestorOffset: -1, guardSubstring: "生保" },
  { col: 47, label: "都銀・地銀等", guardAncestorOffset: -1, guardSubstring: "都銀" },
  { col: 51, label: "信託銀行", guardAncestorOffset: -1, guardSubstring: "信託銀行" },
  { col: 55, label: "その他金融機関", guardAncestorOffset: -1, guardSubstring: "その他金融機関" },
];

function parseUnifiedPeriodCode(code: unknown): { periodLabel: string; year: number; month: number; week: number } {
  const s = String(code ?? "").trim();
  const m = /^(\d{4})(\d{2})(\d)$/.exec(s);
  if (!m) {
    throw new Error(`JPX 投資部門別売買状況 (新様式): 年月週コードの様式が想定外です: "${s}"`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const week = Number(m[3]);
  return { periodLabel: `${year}年${month}月第${week}週`, year, month, week };
}

/** ファイル名 `stock_1_w_YYYYMMDD_YYYYMMDD.xlsx` から期間の開始日・終了日を取る。
 *  新様式は年月週コードだけでは正確な日付が復元できない (何週目が暦週と一致する
 *  保証がない) ため、ファイル名を正のソースにする。サンプルファイルは
 *  プレースホルダ名 (`YYYYMMDD`) のままなので null を返す (捏造しない)。 */
export function parseUnifiedFilenamePeriod(
  filename: string
): { periodStart: string; periodEnd: string } | null {
  const m = /stock_1_w_(\d{8})_(\d{8})\./.exec(filename);
  if (!m) return null;
  const toIso = (yyyymmdd: string): string =>
    `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
  return { periodStart: toIso(m[1]), periodEnd: toIso(m[2]) };
}

function parseUnifiedSheet(
  rows: unknown[][],
  filename: string | undefined
): Omit<InvestorEquityRecord, "formatVersion">[] {
  const headerRowIdx = rows.findIndex(
    (r) => typeof r[0] === "string" && r[0].startsWith("年月週")
  );
  if (headerRowIdx < 4) {
    throw new Error(
      "JPX 投資部門別売買状況 (新様式): ヘッダ行 (「年月週」列) が見つかりません (様式変更の可能性)"
    );
  }

  const filenamePeriod = filename ? parseUnifiedFilenamePeriod(filename) : null;

  // 元シートは「年月週」(col0) と「市場」(col1) を複数行 (株数行・金額行の2行) に
  // またがるマージセルで表現しており、2行目以降は空文字になる。直前に見つかった
  // 非空値を引き継ぐ (Excel のマージセル読み取りの標準的な扱い。値の捏造ではなく
  // マージ構造の素直な展開)。
  let carryPeriodCode: unknown = null;
  let carryMarketRaw: string | null = null;

  const records: Omit<InvestorEquityRecord, "formatVersion">[] = [];
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const metricRaw = String(row[2] ?? "");
    if (metricRaw === "") continue; // データ行ではない (末尾の空行など)

    if (row[0] !== "" && row[0] !== undefined && row[0] !== null) {
      carryPeriodCode = row[0];
    }
    if (carryPeriodCode === null) {
      throw new Error(`JPX 投資部門別売買状況 (新様式): 年月週コードが確定していません (行${i})`);
    }
    const { periodLabel } = parseUnifiedPeriodCode(carryPeriodCode);

    const rowMarketRaw = String(row[1] ?? "").split(/\r?\n/)[0]?.trim() ?? "";
    if (rowMarketRaw !== "") {
      carryMarketRaw = rowMarketRaw;
    }
    if (carryMarketRaw === null) {
      throw new Error(`JPX 投資部門別売買状況 (新様式): 市場名が確定していません (行${i})`);
    }
    const market = JA_MARKET_TO_CANONICAL[carryMarketRaw];
    if (!market) {
      throw new Error(
        `JPX 投資部門別売買状況 (新様式): 市場名を認識できません: "${carryMarketRaw}" (行${i})`
      );
    }

    let metric: InvestorEquityMetric;
    let unit: "thousand_yen" | "thousand_shares";
    if (metricRaw.startsWith("株数")) {
      metric = "volume";
      unit = "thousand_shares";
    } else if (metricRaw.startsWith("金額")) {
      metric = "value";
      unit = "thousand_yen";
    } else {
      throw new Error(
        `JPX 投資部門別売買状況 (新様式): 指標種別(株数/金額)を認識できません: "${metricRaw}" (行${i})`
      );
    }

    for (const group of UNIFIED_GROUPS) {
      const guardRow = rows[headerRowIdx + group.guardAncestorOffset] ?? [];
      const guardText = String(guardRow[group.col] ?? "");
      if (!guardText.includes(group.guardSubstring)) {
        throw new Error(
          `JPX 投資部門別売買状況 (新様式): 列${group.col}の見出しが想定と異なります ` +
            `(期待: "${group.guardSubstring}" を含む, 実際: "${guardText}") — 様式変更の可能性`
        );
      }
      const sell = parseJpxAmount(row[group.col]);
      const buy = parseJpxAmount(row[group.col + 1]);
      const total = parseJpxAmount(row[group.col + 3]);
      const computedTotal = sell + buy;
      if (Math.abs(computedTotal - total) > 1) {
        throw new Error(
          `JPX 投資部門別売買状況 (新様式/${group.label}): 売買合計の不整合 (売り+買い=${computedTotal}, 表の合計=${total})`
        );
      }

      records.push({
        periodType: "weekly",
        periodLabel,
        periodStart: filenamePeriod?.periodStart ?? null,
        periodEnd: filenamePeriod?.periodEnd ?? null,
        market,
        investorCategory: group.label,
        isAggregateCategory: false,
        metric,
        unit,
        sell,
        buy,
        net: buy - sell,
        total,
      });
    }
  }

  if (records.length === 0) {
    throw new Error("JPX 投資部門別売買状況 (新様式): データ行が1件も見つかりません");
  }
  return records;
}

// ---------------------------------------------------------------------------
// 公開 API: ワークブック → 型付きレコード (純関数パーサ)
// ---------------------------------------------------------------------------

/**
 * 取得した xls/xlsx バイト列を型付きレコードへ変換する純関数パーサ。
 * 新旧どちらの様式かはシート構成から自動判別する。どちらの既知様式とも一致
 * しなければ throw する (ルール2)。
 *
 * @param filename 新様式でファイル名から期間を復元するために使う (省略可。
 *   旧様式では使わない)。
 */
export function parseInvestorEquityWorkbook(
  bytes: Uint8Array,
  filename?: string
): InvestorEquityRecord[] {
  const workbook = XLSX.read(bytes, { type: "array" });
  const sheetNames = workbook.SheetNames;

  const isLegacy =
    sheetNames.length === LEGACY_MARKET_SHEET_NAMES.length &&
    LEGACY_MARKET_SHEET_NAMES.every((name) => sheetNames.includes(name));

  if (isLegacy) {
    const out: InvestorEquityRecord[] = [];
    for (const marketName of LEGACY_MARKET_SHEET_NAMES) {
      const sheet = workbook.Sheets[marketName];
      if (!sheet) {
        throw new Error(`JPX 投資部門別売買状況: シート "${marketName}" が見つかりません`);
      }
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
      const { records } = parseLegacySheet(marketName, rows);
      for (const rec of records) {
        out.push({ ...rec, formatVersion: "legacy_split_files", market: marketName });
      }
    }
    return out;
  }

  if (sheetNames.length === 1) {
    const sheet = workbook.Sheets[sheetNames[0]];
    if (!sheet) {
      throw new Error("JPX 投資部門別売買状況: シートが見つかりません");
    }
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
    const records = parseUnifiedSheet(rows, filename);
    return records.map((rec) => ({ ...rec, formatVersion: "unified_single_file" as const }));
  }

  throw new Error(
    `JPX 投資部門別売買状況: 未知のブック形式です (シート: ${sheetNames.join(", ")}) — ` +
      "既知の様式 (旧: 市場別4シート / 新: 単一シート) のいずれとも一致しません"
  );
}

// ---------------------------------------------------------------------------
// 一覧ページ (週次) の解析 + 最新ファイル URL 解決
// ---------------------------------------------------------------------------

export interface WeeklyIndexEntry {
  /** 例: "2026年9月第2週(9月7日～9月11日)" (一覧ページ表記そのまま) */
  label: string;
  valueXlsUrl: string;
  volumeXlsUrl: string;
}

const WEEKLY_ROW_RE =
  /<tr>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*><a href="([^"]+)"[^>]*>[\s\S]*?<\/a><\/td>\s*<td[^>]*><a href="([^"]+)"[^>]*>[\s\S]*?<\/a><\/td>\s*<td[^>]*><a href="([^"]+)"[^>]*>[\s\S]*?<\/a><\/td>\s*<td[^>]*><a href="([^"]+)"[^>]*>[\s\S]*?<\/a><\/td>\s*<\/tr>/g;

/**
 * 週次一覧ページ (index.html) から、公表済みの週を新しい順に取り出す。
 * 旧様式 (株数PDF/株数XLS/金額PDF/金額XLS の4リンク行) のみ対応。
 * 一致する行が1件も無ければ throw する (2026-09-29 の様式変更で表の形が変わった
 * 場合はここで検知される想定)。
 */
export function parseWeeklyIndexHtml(html: string): WeeklyIndexEntry[] {
  const entries: WeeklyIndexEntry[] = [];
  for (const m of html.matchAll(WEEKLY_ROW_RE)) {
    const [, label, volPdf, volXls, valPdf, valXls] = m;
    if (!/stock_vol_1_\d+\.pdf$/.test(volPdf)) continue;
    if (!/stock_vol_1_\d+\.xls$/.test(volXls)) continue;
    if (!/stock_val_1_\d+\.pdf$/.test(valPdf)) continue;
    if (!/stock_val_1_\d+\.xls$/.test(valXls)) continue;
    entries.push({
      label: label.trim(),
      valueXlsUrl: valXls.startsWith("http") ? valXls : `${BASE}${valXls}`,
      volumeXlsUrl: volXls.startsWith("http") ? volXls : `${BASE}${volXls}`,
    });
  }
  if (entries.length === 0) {
    throw new Error(
      "JPX 投資部門別売買状況 (週次一覧): 想定した行 (株数/金額 各PDF/XLS の4リンク) が" +
        "見つかりません。2026-09-29 の様式変更でページ構造が変わった可能性があります。"
    );
  }
  return entries;
}

/** 一覧ページの並び順 (新しい週が先頭) を前提に最新行を返す。 */
export function latestWeeklyEntry(entries: readonly WeeklyIndexEntry[]): WeeklyIndexEntry {
  const first = entries[0];
  if (!first) {
    throw new Error("JPX 投資部門別売買状況 (週次一覧): エントリが空です");
  }
  return first;
}

// ---------------------------------------------------------------------------
// 一覧ページ (月次) の解析 + 「まだ公表されていない」の判定
// ---------------------------------------------------------------------------

export interface MonthlyIndexEntry {
  year: number;
  month: number;
  /** null = その月はまだ公表されていない (ページ上でリンクが無い/"-" 表示) */
  valueXlsUrl: string | null;
  volumeXlsUrl: string | null;
}

function extractMonthlyXlsLinks(
  html: string,
  metric: "val" | "vol",
  year: number
): Map<number, string> {
  const yy = String(year).slice(2);
  const re = new RegExp(`href="([^"]*?stock_${metric}_1_m${yy}(\\d{2})\\.xls)"`, "g");
  const map = new Map<number, string>();
  for (const m of html.matchAll(re)) {
    const month = Number(m[2]);
    map.set(month, m[1].startsWith("http") ? m[1] : `${BASE}${m[1]}`);
  }
  return map;
}

/**
 * 月次一覧ページ (00-01.html) を解析する。当年 (ページ見出しの year) について
 * 1〜12月それぞれの公表有無を返す。JPX はまだ来ていない月をリンク無し ("-" 表示)
 * にする仕様なので、これがそのまま「まだ公表されていない」の判定になる
 * (カレンダー計算による推測はしない)。
 */
export function parseMonthlyIndexHtml(html: string): MonthlyIndexEntry[] {
  const yearMatch = /<th class="w-space">(\d{4})年<\/th>/.exec(html);
  if (!yearMatch) {
    throw new Error(
      "JPX 投資部門別売買状況 (月次一覧): 年見出しが見つかりません (様式変更の可能性)"
    );
  }
  const year = Number(yearMatch[1]);
  const valMap = extractMonthlyXlsLinks(html, "val", year);
  const volMap = extractMonthlyXlsLinks(html, "vol", year);
  if (valMap.size === 0 && volMap.size === 0) {
    throw new Error(
      "JPX 投資部門別売買状況 (月次一覧): 月次ファイルへのリンクが1件も見つかりません (様式変更の可能性)"
    );
  }

  const entries: MonthlyIndexEntry[] = [];
  for (let month = 1; month <= 12; month++) {
    entries.push({
      year,
      month,
      valueXlsUrl: valMap.get(month) ?? null,
      volumeXlsUrl: volMap.get(month) ?? null,
    });
  }
  return entries;
}

/**
 * 公表済みの最新月を返す。全月未公表なら throw。最新月が金額/株数の片方だけ
 * 公表されている (想定外の部分公開) 場合も throw する — 前の月へ黙って
 * フォールバックしない (ルール2)。
 */
export function pickLatestPublishedMonth(entries: readonly MonthlyIndexEntry[]): MonthlyIndexEntry {
  const published = entries.filter((e) => e.valueXlsUrl !== null || e.volumeXlsUrl !== null);
  if (published.length === 0) {
    const year = entries[0]?.year;
    throw new Error(`JPX 投資部門別売買状況 (月次一覧): ${year ?? "?"}年の月次データがまだ1件も公表されていません`);
  }
  const latest = published[published.length - 1];
  if (latest.valueXlsUrl === null || latest.volumeXlsUrl === null) {
    throw new Error(
      `JPX 投資部門別売買状況 (月次一覧): ${latest.year}年${latest.month}月分は金額/株数の` +
        `一方のみ公表されており想定外です (value=${latest.valueXlsUrl ?? "null"}, ` +
        `volume=${latest.volumeXlsUrl ?? "null"})`
    );
  }
  return latest;
}

// ---------------------------------------------------------------------------
// 最新ファイルの解決 + 取得 (ネットワークI/O)
// ---------------------------------------------------------------------------

export interface FetchedInvestorEquity {
  periodType: InvestorEquityPeriodType;
  /** 取得元 URL (アーカイブ入力・来歴用) */
  valueUrl: string;
  volumeUrl: string;
  valueBytes: Uint8Array;
  volumeBytes: Uint8Array;
  records: InvestorEquityRecord[];
}

/** 最新の週次ファイルを解決して取得する。 */
export async function fetchLatestJpxInvestorEquityWeekly(): Promise<FetchedInvestorEquity> {
  const html = await fetchText(WEEKLY_INDEX_URL);
  const entries = parseWeeklyIndexHtml(html);
  const latest = latestWeeklyEntry(entries);

  const [valueBytes, volumeBytes] = await Promise.all([
    fetchBytes(latest.valueXlsUrl),
    fetchBytes(latest.volumeXlsUrl),
  ]);

  const valueFilename = urlBasename(latest.valueXlsUrl);
  const volumeFilename = urlBasename(latest.volumeXlsUrl);
  const records = [
    ...parseInvestorEquityWorkbook(valueBytes, valueFilename),
    ...parseInvestorEquityWorkbook(volumeBytes, volumeFilename),
  ];

  return {
    periodType: "weekly",
    valueUrl: latest.valueXlsUrl,
    volumeUrl: latest.volumeXlsUrl,
    valueBytes,
    volumeBytes,
    records,
  };
}

/** 最新 (公表済み) の月次ファイルを解決して取得する。今年分がまだ1件も
 *  無ければ throw する (pickLatestPublishedMonth 参照)。 */
export async function fetchLatestJpxInvestorEquityMonthly(): Promise<FetchedInvestorEquity> {
  const html = await fetchText(MONTHLY_INDEX_URL);
  const entries = parseMonthlyIndexHtml(html);
  const latest = pickLatestPublishedMonth(entries);
  // pickLatestPublishedMonth は valueXlsUrl/volumeXlsUrl が非null であることを保証する
  const valueXlsUrl = latest.valueXlsUrl as string;
  const volumeXlsUrl = latest.volumeXlsUrl as string;

  const [valueBytes, volumeBytes] = await Promise.all([
    fetchBytes(valueXlsUrl),
    fetchBytes(volumeXlsUrl),
  ]);

  const records = [
    ...parseInvestorEquityWorkbook(valueBytes, urlBasename(valueXlsUrl)),
    ...parseInvestorEquityWorkbook(volumeBytes, urlBasename(volumeXlsUrl)),
  ];

  return {
    periodType: "monthly",
    valueUrl: valueXlsUrl,
    volumeUrl: volumeXlsUrl,
    valueBytes,
    volumeBytes,
    records,
  };
}

// ---------------------------------------------------------------------------
// ルール6: Notion 一次データアーカイブの「入力」を組み立てる純関数
// (実際の recordPrimaryData() 呼び出しは統合担当が行う)
// ---------------------------------------------------------------------------

export interface JpxInvestorEquityArchiveInput {
  service: string;
  key: string;
  source: string;
  metadata: Record<string, unknown>;
  files: Array<{ bytes: Uint8Array; filename: string; contentType: string }>;
}

export function jpxInvestorEquityArchiveInput(
  fetched: FetchedInvestorEquity
): JpxInvestorEquityArchiveInput {
  const first = fetched.records[0];
  if (!first) {
    throw new Error("jpxInvestorEquityArchiveInput: records が空です");
  }
  // 冪等キーの期間部分: 実日付 (periodEnd/periodStart) が取れていればそれを使い、
  // 新様式でファイル名から日付を復元できなかった場合のみ periodLabel (例:
  // "2026年9月第2週") にフォールバックする (値の捏造ではなく、識別子として
  // 常に一意な periodLabel を使うだけ)。
  const keyPeriod =
    fetched.periodType === "weekly"
      ? (first.periodEnd ?? first.periodLabel)
      : (first.periodStart?.slice(0, 7) ?? first.periodLabel);
  const valueFilename = urlBasename(fetched.valueUrl);
  const volumeFilename = urlBasename(fetched.volumeUrl);
  const contentType = valueFilename.endsWith(".xlsx")
    ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    : "application/vnd.ms-excel";

  return {
    service: "moneyflow",
    key: `jpx-investor-equity-${fetched.periodType}-${keyPeriod}`,
    source: `${fetched.valueUrl} , ${fetched.volumeUrl}`,
    metadata: {
      periodType: fetched.periodType,
      periodLabel: first.periodLabel,
      periodStart: first.periodStart,
      periodEnd: first.periodEnd,
      recordCount: fetched.records.length,
      formatVersion: first.formatVersion,
    },
    files: [
      { bytes: fetched.valueBytes, filename: `investor-equity-value-${valueFilename}`, contentType },
      { bytes: fetched.volumeBytes, filename: `investor-equity-volume-${volumeFilename}`, contentType },
    ],
  };
}

// ---------------------------------------------------------------------------
// 指標定義 (観測ログ / 指標定義 DB へ書くためのメタデータ。Notion 書込はしない)
// ---------------------------------------------------------------------------

export type MoneyflowRequirement = "R1" | "R2" | "R3" | "R4";
export type MoneyflowMeasureKind =
  | "net_flow"
  | "gross_turnover"
  | "holdings_stock"
  | "positions"
  | "fund_flow"
  | "estimated"
  | "price_only";

export interface MoneyflowIndicatorDef {
  key: string;
  displayName: string;
  requirement: readonly MoneyflowRequirement[];
  measures: MoneyflowMeasureKind;
  /** 初心者向けの平易な説明 (1〜3文、具体例つき。CLAUDE.md ルール7 の精神) */
  explanation: string;
  /** 財務的に正確な定義 */
  definition: string;
  unit: string;
  sourceUrl: string;
  usageTerms: string;
  frequency: string;
  limitations: string;
}

const USAGE_TERMS_JA =
  "JPX利用規約により、許諾なしの商用二次利用・再配信・生成AIによる学習/解析利用は" +
  "禁止。kabulabでは個人用Notionページ (非公開) にのみ保存し、公開Webには出さない " +
  "(personal-only)。";

export const JPX_INVESTOR_EQUITY_INDICATORS: readonly MoneyflowIndicatorDef[] = [
  {
    key: "jpx_investor_equity_net_flow_value",
    displayName: "投資部門別 買い越し額 (株式)",
    requirement: ["R1", "R3", "R4"],
    measures: "net_flow",
    explanation:
      "個人・海外投資家・証券会社・事業法人などの投資部門ごとに、株を「買った金額」から" +
      "「売った金額」を引いた値。プラスなら買い越し(その部門がお金を株に振り向けた)、" +
      "マイナスなら売り越し。例: 海外投資家が買い越し+3000億円なら、その週は海外投資家" +
      "から日本株へ3000億円分お金が流れ込んだとみなせる。",
    definition:
      "投資部門別 (自己/委託の内訳。個人・海外投資家・証券会社・事業法人・投資信託・" +
      "金融機関等) の株式売買代金について、買付金額-売付金額。市場区分 (プライム/" +
      "スタンダード/グロース/二市場合算) 別。東証33業種別の内訳は無い。",
    unit: "千円",
    sourceUrl: WEEKLY_INDEX_URL,
    usageTerms: USAGE_TERMS_JA,
    frequency: "週次(毎週第4営業日・通常木曜、祝日等で後ろ倒しの場合あり、午後3時30分公表)/月次(前月最終週の週次発表と同日、午後3時30分公表)",
    limitations:
      "集計対象は資本金30億円以上の取引参加者経由の取引のみ (全取引の網羅ではない)。" +
      "内国普通株式が対象でETF/REIT/優先株式等は含まない。33業種別の内訳は存在しない" +
      "(市場区分別のみ)。2026-09-29公表分からファイル様式が変わる予告があり、新様式の" +
      "パーサは公式サンプルでのみ検証済み(実データでの再検証が必要)。",
  },
  {
    key: "jpx_investor_equity_gross_turnover_value",
    displayName: "投資部門別 売買代金 (株式)",
    requirement: ["R1", "R3"],
    measures: "gross_turnover",
    explanation:
      "ある投資部門が売った金額と買った金額を単純に足し合わせた「取引の活発さ」の指標。" +
      "買い越し/売り越しのようなプラスマイナスの向きは無く、その部門がどれだけ活発に" +
      "売買したかを示す。",
    definition:
      "投資部門別の株式売買代金について、売付金額+買付金額(=総売買代金)。市場区分別。",
    unit: "千円",
    sourceUrl: WEEKLY_INDEX_URL,
    usageTerms: USAGE_TERMS_JA,
    frequency: "週次(毎週第4営業日・通常木曜、祝日等で後ろ倒しの場合あり、午後3時30分公表)/月次(前月最終週の週次発表と同日、午後3時30分公表)",
    limitations:
      "集計対象は資本金30億円以上の取引参加者経由の取引のみ。33業種別の内訳は無い。",
  },
  {
    key: "jpx_investor_equity_net_flow_volume",
    displayName: "投資部門別 買い越し株数 (株式)",
    requirement: ["R1", "R3", "R4"],
    measures: "net_flow",
    explanation:
      "上と同じ買い越し/売り越しを、金額ではなく株数(千株単位)で見たもの。値嵩株と" +
      "低位株では同じ買い越し株数でも金額の意味が違うため、金額版と併せて見る。",
    definition:
      "投資部門別の株式売買高について、買付株数-売付株数。市場区分別。単位: 千株。",
    unit: "千株",
    sourceUrl: WEEKLY_INDEX_URL,
    usageTerms: USAGE_TERMS_JA,
    frequency: "週次(毎週第4営業日・通常木曜、祝日等で後ろ倒しの場合あり、午後3時30分公表)/月次(前月最終週の週次発表と同日、午後3時30分公表)",
    limitations:
      "集計対象は資本金30億円以上の取引参加者経由の取引のみ。33業種別の内訳は無い。",
  },
  {
    key: "jpx_investor_equity_gross_turnover_volume",
    displayName: "投資部門別 売買高 (株式)",
    requirement: ["R1", "R3"],
    measures: "gross_turnover",
    explanation: "売買代金の株数版。売った株数と買った株数を足し合わせた取引の活発さ。",
    definition: "投資部門別の株式売買高について、売付株数+買付株数。市場区分別。",
    unit: "千株",
    sourceUrl: WEEKLY_INDEX_URL,
    usageTerms: USAGE_TERMS_JA,
    frequency: "週次(毎週第4営業日・通常木曜、祝日等で後ろ倒しの場合あり、午後3時30分公表)/月次(前月最終週の週次発表と同日、午後3時30分公表)",
    limitations:
      "集計対象は資本金30億円以上の取引参加者経由の取引のみ。33業種別の内訳は無い。",
  },
];

// ---------------------------------------------------------------------------
// 観測ログ用の縦長レコード
// ---------------------------------------------------------------------------

export interface MoneyflowObservationRow {
  indicatorKey: string;
  periodType: InvestorEquityPeriodType;
  periodLabel: string;
  periodStart: string | null;
  periodEnd: string | null;
  /** 区分の種類。この取得元は「投資部門」(市場区分は marketSegment に分離) */
  breakdownKind: "investor_type";
  breakdownValue: string;
  marketSegment: InvestorEquityMarket;
  value: number;
  unit: string;
  /** この取得元は東証公式の実測値であり近似ではない (33業種別への按分等は行っていない) */
  isApproximate: boolean;
  isEstimated: boolean;
}

/**
 * InvestorEquityRecord[] を観測ログ用の縦長レコードへ変換する純関数。
 * 1レコードにつき「買い越し額/株数」と「売買代金/高」の2行を出す
 * (net_flow 系・gross_turnover 系の両方の指標定義に対応する行)。
 */
export function toObservationRows(records: readonly InvestorEquityRecord[]): MoneyflowObservationRow[] {
  const rows: MoneyflowObservationRow[] = [];
  for (const rec of records) {
    const netKey =
      rec.metric === "value" ? "jpx_investor_equity_net_flow_value" : "jpx_investor_equity_net_flow_volume";
    const grossKey =
      rec.metric === "value"
        ? "jpx_investor_equity_gross_turnover_value"
        : "jpx_investor_equity_gross_turnover_volume";
    const common = {
      periodType: rec.periodType,
      periodLabel: rec.periodLabel,
      periodStart: rec.periodStart,
      periodEnd: rec.periodEnd,
      breakdownKind: "investor_type" as const,
      breakdownValue: rec.investorCategory,
      marketSegment: rec.market,
      unit: rec.unit,
      isApproximate: false,
      isEstimated: false,
    };
    rows.push({ ...common, indicatorKey: netKey, value: rec.net });
    rows.push({ ...common, indicatorKey: grossKey, value: rec.total });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 既知の限界 (返り値の「制約・保留事項」に転記する用)
// ---------------------------------------------------------------------------

export const KNOWN_LIMITATIONS: readonly string[] = [
  "2026-09-29 公表分から週次ファイルが単一化される予告があるが、本モジュール作成時点" +
    "(2026-09-27) では実ファイルが存在しないため、新様式パーサはJPX公式サンプル" +
    "(stock_1_w_YYYYMMDD_YYYYMMDD.xlsx、ファイル名未置換=実データではない仕様サンプル)" +
    "でのみ検証済み。9/29以降、実ファイルでの再検証が必須。",
  "新様式ではファイル名 (stock_1_w_YYYYMMDD_YYYYMMDD.xlsx) から期間の開始日・終了日を" +
    "取得する設計。サンプルファイルはプレースホルダ名のため periodStart/periodEnd は" +
    "null になる (捏造しない)。",
  "週次の「まだ公表されていない」は一覧ページに行が無いことでのみ判定する" +
    "(カレンダー/祝日推定はしない)。月次は年間テーブルのセルが空(ハイフン表示)であることで判定。",
  "月次一覧ページは当年の1テーブルのみ解析対象。年またぎ (12月→翌1月) の過去年" +
    "アーカイブページ (00-01-archives-*.html) の解析は未対応。",
  "週次の様式変更 (2026-09-29) とは別に、月次一覧ページ (00-01.html) には " +
    "2026-10-08 掲載分から月次ファイルを株数/金額の2ファイルから1ファイルに統合し、" +
    "ファイル名も stock_1_mYYYYMM.xlsx (週の概念なし) に変える予告が掲載されている " +
    "(JPX公式サンプル stock_1_mYYYYMM.xlsx で確認済み)。この新様式はヘッダ行が" +
    "「年月週」ではなく「年月」で始まり、市場ごとに株数行/金額行を分ける全く別の" +
    "レイアウトのため parseUnifiedSheet (週次新様式用) では読めない。現状は" +
    "ヘッダ行が見つからず throw する (ルール2的には安全側だが、月次専用の新様式" +
    "パーサは未実装)。10/8以降、実ファイルでの月次専用パーサの実装・検証が必須。",
  "週次一覧ページの行マッチ (WEEKLY_ROW_RE) は旧様式4リンク行にのみ一致する。" +
    "2026-09-29の様式変更で表全体ではなく行単位で新旧が混在した場合 " +
    "(最新週だけ新様式化し、より下の過去週は旧様式のまま残る等)、entriesは空に" +
    "ならずthrowされないため、latestWeeklyEntry()が本当の最新週ではなく1つ前の" +
    "旧様式週を無言で返す可能性がある。現時点 (2026-09-27) では9/29以降の実ページ" +
    "構造が不明なため検知ロジックは未実装。9/29以降、実ページで表全体が一括更新" +
    "されるか行単位で混在するかを確認し、必要なら検知を追加すること。",
  "投資部門別の内訳は東証33業種別には存在しない (JPX公式統計としてそもそも提供されて" +
    "いない粒度)。R1(33業種)の主指標ではなく補足指標として使う設計。",
  "集計対象は資本金30億円以上の取引参加者経由の取引のみ (JPX注記)。全取引の網羅では" +
    "ない。",
];
