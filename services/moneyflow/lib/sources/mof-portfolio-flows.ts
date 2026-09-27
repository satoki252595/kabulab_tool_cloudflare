/**
 * 財務省「対外及び対内証券売買契約等の状況」(指定報告機関ベース) 取得元。
 *
 * https://www.mof.go.jp/policy/international_policy/reference/itn_transactions_in_securities/index.htm
 *
 * 指定報告機関 (銀行等・金融商品取引業者・保険会社・投資信託委託会社・資産運用会社) を
 * 経由した居住者⇔非居住者間の証券売買契約を、
 *   - 対外証券投資 【居住者による取得・処分】 ("outward": 日本の投資家が海外証券を売買した分)
 *   - 対内証券投資 【非居住者による取得・処分】 ("inward": 海外の投資家が日本の証券を売買した分)
 * の2方向 × 株式・投資ファンド持分/中長期債/短期債 (+小計/合計) で集計した、
 * いわゆる「外国人買い越し」報道の元データ。週次・月次の2つの CSV (時系列・累積) が
 * 固定 URL で公表される。国・地域別の内訳は無い (全世界合計)。
 *
 * ## この取得元固有の注意点
 * - 週次 CSV (`week.csv`)・月次 CSV (`montha1.csv`) とも Shift_JIS (cp932 相当)
 *   エンコードの単一ファイルで、公表の都度「最新行が追記された累積時系列」に
 *   差し替わる (ファイル名自体は固定)。JPX の週次信用残 PDFのように「最新ファイルの
 *   URL 自体を毎回探す」必要が無いため、URL 解決はこのファイル内の固定定数で足りる。
 * - 月次 CSV は当年の未到来月の行を "月ラベルのみ・値欄は全欄空欄" の形であらかじめ
 *   用意している (例: 2026-09 時点で 9〜12月の行が存在し値は空欄)。これを
 *   「まだ公表されていない」と判定し、値を捏造しない (ルール2)。週次 CSV は逆に
 *   未到来週の行を用意しない (行そのものが無い)。
 * - 数値は 3 桁ごとにカンマを含む場合のみ `"..."` で囲まれる (RFC4180 相当)。
 *   負値は "▲" ではなく ASCII の "-"。
 * - 月次 CSV には月次データの下に暦年 (CY) ・年度 (FY) の集計行が続くが、
 *   本パーサは対象としない (行の並びが「年,月ラベル,英語略称」の形に一致しないため
 *   自然にスキップされる)。将来これらの集計値が必要になった場合は別途拡張する。
 * - 月次 CSV には対外/対内それぞれの「小計ネット」「合計ネット」の差 (A-B, C-D =
 *   対外ネット-対内ネット) を MOF 自身が算出した2列が末尾に付くが、これは
 *   本パーサが返す `net` 行から呼び出し側で再計算可能 (かつ丸め誤差を含む) なため
 *   意図的に取り込まない。
 *
 * ## 利用条件
 * 無料ダウンロード。商用利用時は出典明記が必要 (attribution_required)。
 * ログイン・CAPTCHA 等の bot 対策は無い (調査時点)。
 */

const UA =
  // JPX 等 (`services/vwap-analysis/lib/margin.ts` / `src/shared/jpx/sectors.ts`)
  // と同じブラウザ相当 UA 文字列。リポジトリ内にこれを一元管理する共有定数が
  // まだ無いため、既存箇所と同じ値をこのファイル内に閉じて持つ。
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const BASE =
  "https://www.mof.go.jp/policy/international_policy/reference/itn_transactions_in_securities";

/** 一覧ページ (統計表一覧・出典表示用) */
export const MOF_PORTFOLIO_FLOWS_INDEX_URL = `${BASE}/index.htm`;
/** 週次・指定報告機関ベース (時系列データ、累積) */
export const MOF_PORTFOLIO_FLOWS_WEEKLY_URL = `${BASE}/week.csv`;
/** 月次・指定報告機関ベース (時系列データ、累積) */
export const MOF_PORTFOLIO_FLOWS_MONTHLY_URL = `${BASE}/montha1.csv`;
/** 公表予定 (毎回午前8:50。予定は変更されうる、と原本に明記) */
export const MOF_PORTFOLIO_FLOWS_SCHEDULE_URL = `${BASE}/schedule.htm`;

// -------------------- 型 --------------------

export type MofFlowFrequency = "weekly" | "monthly";
/** 対外 = 居住者による海外証券投資 / 対内 = 非居住者による対日証券投資 */
export type MofFlowDirection = "outward" | "inward";
export type MofAssetClass =
  | "equity" // 株式・投資ファンド持分
  | "long_term_bond" // 中長期債
  | "subtotal" // 小計 (株式+中長期債、ネットのみ原本に存在)
  | "short_term_bond" // 短期債
  | "total"; // 合計 (ネットのみ原本に存在)
export type MofFlowMetric = "acquisition" | "disposition" | "net";

/** 小計・合計はネットしか原本に存在しない (取得/処分の内訳が無い)。 */
const NET_ONLY_ASSET_CLASSES: ReadonlySet<MofAssetClass> = new Set([
  "subtotal",
  "total",
]);

export interface MofFlowRow {
  frequency: MofFlowFrequency;
  /** 冪等キーに使える期間キー (週次: "YYYY-MM-DD_YYYY-MM-DD"、月次: "YYYY-MM") */
  periodKey: string;
  periodStart: string; // ISO date (YYYY-MM-DD)
  periodEnd: string; // ISO date (YYYY-MM-DD)
  direction: MofFlowDirection;
  assetClass: MofAssetClass;
  metric: MofFlowMetric;
  /** 億円単位。プラス=取得超 (ネットの場合)、マイナス=処分超。 */
  value: number;
  unit: "億円";
}

export interface MofPortfolioFlowsParseResult {
  frequency: MofFlowFrequency;
  rows: MofFlowRow[];
  /**
   * 値欄が全欄空欄で「まだ公表されていない」と判定した期間キー
   * (rows には含めない。ルール2: 欠損を捏造せず明示する)。
   */
  unpublishedPeriods: string[];
  sourceUrl: string;
}

// -------------------- 指標定義 (ルール7の平易な説明 + 正確な定義を両立) --------------------

export type MofFlowIndicatorKey =
  | "mof_net_flow"
  | "mof_gross_acquisition"
  | "mof_gross_disposition";

export interface MofIndicatorDefinition {
  key: MofFlowIndicatorKey;
  label: string;
  /** この指標が答える計画上の要件 (R1〜R4)。このソースは R2 (株以外の比較の補助) と R4 (日本⇔海外) に該当し、業種別 (R1) の内訳は無い。 */
  requirements: string[];
  /** 何を測るか。差引ネットは净フロー、取得/処分は売買の規模(グロス)。 */
  measures: "net_flow" | "gross_turnover";
  /** 初心者向けの平易な説明 (1〜3文、具体例つき)。ルール7準拠。 */
  summary: string;
  /** 財務的に正確な定義。 */
  definition: string;
  unit: string;
  sourceUrl: string;
  usageTerms: string;
  frequency: string;
  limitations: string;
}

export const MOF_PORTFOLIO_FLOWS_INDICATORS: MofIndicatorDefinition[] = [
  {
    key: "mof_net_flow",
    label: "対外・対内証券売買 ネット(取得-処分)",
    requirements: ["R2", "R4"],
    measures: "net_flow",
    summary:
      "海外の投資家が日本の株や債券を「差し引きでどれだけ多く買ったか(または売ったか)」、逆に日本の投資家が海外の株や債券を「差し引きでどれだけ多く買ったか」を、金額(億円)で表したもの。プラスなら買い越し(取得のほうが多い)、マイナスなら売り越し(処分のほうが多い)。例えば対内(海外→日本)がある週+5,000億円なら、その週は海外投資家が日本の証券を差し引き5,000億円分多く買った。",
    definition:
      "指定報告機関(銀行等・金融商品取引業者・保険会社・投資信託委託会社・資産運用会社)経由で成立した居住者⇔非居住者間の証券売買契約について、取得金額から処分金額を差し引いた値(取得-処分)。「対外」は日本の居住者が海外証券を売買した分、「対内」は非居住者(海外投資家)が日本の証券を売買した分。ストック(保有残高)ではなくフロー(期間中の取引の差引)であり、時価変動による評価損益は含まない。国・地域別の内訳は無い(全世界合計)。",
    unit: "億円",
    sourceUrl: MOF_PORTFOLIO_FLOWS_INDEX_URL,
    usageTerms: "無料でダウンロード可能。商用利用時は出典明記が必要(attribution_required)。二次配布時も出典(財務省)を明記すること。",
    frequency: "週次(通常木または金曜、公表予定時刻は毎回午前8時50分)・月次(毎月8〜12日頃、同時刻)。予定は変更されうる(原本に明記)。",
    limitations:
      "投資部門別(誰が買ったか)・国地域別の内訳は無い(全世界合計かつ「指定報告機関」経由分のみで、指定報告機関を介さない取引は含まれない)。四捨五入により小計・合計が内訳の合計と一致しないことがある(原本の注記)。速報値であり、後日の確報改定を反映しない。月次CSVには未到来月の空欄行があらかじめ用意されているが、これは「まだ公表されていない」であり0ではない。",
  },
  {
    key: "mof_gross_acquisition",
    label: "対外・対内証券 取得額(グロス)",
    requirements: ["R2", "R4"],
    measures: "gross_turnover",
    summary:
      "その期間に新しく買われた金額の合計(売った分は含まない、買っただけの総額)。取引の活発さ(規模)を見る指標で、ネット(差引)がゼロ近くでも取得額自体は大きい、ということがありうる。",
    definition:
      "指定報告機関経由の居住者⇔非居住者間の証券売買契約のうち、取得(買い)側の契約金額の合計。処分(売り)側は含まない。小計・合計の区分については原本に取得の内訳が無い(ネットのみ)ため、この指標は株式・投資ファンド持分/中長期債/短期債の3区分にのみ存在する。",
    unit: "億円",
    sourceUrl: MOF_PORTFOLIO_FLOWS_INDEX_URL,
    usageTerms: "無料でダウンロード可能。商用利用時は出典明記が必要(attribution_required)。",
    frequency: "週次・月次(mof_net_flowと同じ公表スケジュール)。",
    limitations:
      "小計(株式+中長期債)・合計の区分には取得額の内訳が原本に存在しない(ネットのみ)。国・地域別、投資部門別の内訳は無い。",
  },
  {
    key: "mof_gross_disposition",
    label: "対外・対内証券 処分額(グロス)",
    requirements: ["R2", "R4"],
    measures: "gross_turnover",
    summary:
      "その期間に売られた金額の合計(買った分は含まない、売っただけの総額)。取得額と合わせて見ることで、売買がどれだけ活発だったかが分かる。",
    definition:
      "指定報告機関経由の居住者⇔非居住者間の証券売買契約のうち、処分(売り)側の契約金額の合計。取得(買い)側は含まない。小計・合計の区分については原本に処分の内訳が無い(ネットのみ)ため、この指標は株式・投資ファンド持分/中長期債/短期債の3区分にのみ存在する。",
    unit: "億円",
    sourceUrl: MOF_PORTFOLIO_FLOWS_INDEX_URL,
    usageTerms: "無料でダウンロード可能。商用利用時は出典明記が必要(attribution_required)。",
    frequency: "週次・月次(mof_net_flowと同じ公表スケジュール)。",
    limitations:
      "小計(株式+中長期債)・合計の区分には処分額の内訳が原本に存在しない(ネットのみ)。国・地域別、投資部門別の内訳は無い。",
  },
];

// -------------------- CSV トークナイザ --------------------

/**
 * RFC4180 相当の最小 CSV パーサ (引用符内のカンマ・改行・二重引用符エスケープに対応)。
 * この取得元のヘッダ行には引用符内改行を含むセルが実在するため、行単位の
 * 文字列分割ではなく全文を状態機械で走査する。
 */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** MOF CSV は Shift_JIS (cp932 相当) で配布される。 */
export function decodeMofCsv(bytes: Uint8Array): string {
  return new TextDecoder("shift_jis").decode(bytes);
}

function parseYen100M(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const cleaned = trimmed.replace(/,/g, "");
  if (!/^-?\d+$/.test(cleaned)) {
    // ルール2: "-" 等の想定外トークンを 0 やnullに丸めず throw する。
    throw new Error(`MOF CSV: 数値として解釈できない値です: ${JSON.stringify(raw)}`);
  }
  return Number(cleaned);
}

function toIsoDate(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    throw new Error(`MOF CSV: 実在しない日付です: ${year}-${month}-${day}`);
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// -------------------- 対外/対内 各ブロックの列レイアウト --------------------

interface FieldSpec {
  assetClass: MofAssetClass;
  metric: MofFlowMetric;
  index: number;
}

/**
 * 「株式取得,株式処分,株式ネット,中長期債取得,処分,ネット,小計ネット,
 *  短期債取得,処分,ネット,合計ネット」の11列ブロックを offset から読む列指定を作る。
 * 週次CSVは対外=offset 1・対内=offset 12 (期間列の直後から)。
 * 月次CSVは対外=offset 3・対内=offset 14 (年・月・英語略称の3列の後)。
 */
function blockFieldSpecs(offset: number): FieldSpec[] {
  return [
    { assetClass: "equity", metric: "acquisition", index: offset },
    { assetClass: "equity", metric: "disposition", index: offset + 1 },
    { assetClass: "equity", metric: "net", index: offset + 2 },
    { assetClass: "long_term_bond", metric: "acquisition", index: offset + 3 },
    { assetClass: "long_term_bond", metric: "disposition", index: offset + 4 },
    { assetClass: "long_term_bond", metric: "net", index: offset + 5 },
    { assetClass: "subtotal", metric: "net", index: offset + 6 },
    { assetClass: "short_term_bond", metric: "acquisition", index: offset + 7 },
    { assetClass: "short_term_bond", metric: "disposition", index: offset + 8 },
    { assetClass: "short_term_bond", metric: "net", index: offset + 9 },
    { assetClass: "total", metric: "net", index: offset + 10 },
  ];
}

interface PeriodInfo {
  periodKey: string;
  start: string;
  end: string;
}

/**
 * 1行分 (対外11列+対内11列=22列) から MofFlowRow[] を作る。
 * 値欄が全欄空欄なら「まだ公表されていない」(null を返す=呼び出し側で
 * unpublishedPeriods に積む)。一部だけ空欄は様式異常として throw する。
 */
function rowsFromFields(
  frequency: MofFlowFrequency,
  period: PeriodInfo,
  fields: string[],
  outwardOffset: number,
  inwardOffset: number
): MofFlowRow[] | null {
  const outwardSpecs = blockFieldSpecs(outwardOffset);
  const inwardSpecs = blockFieldSpecs(inwardOffset);
  const allSpecs = [
    ...outwardSpecs.map((s) => ({ ...s, direction: "outward" as const })),
    ...inwardSpecs.map((s) => ({ ...s, direction: "inward" as const })),
  ];
  const rawValues = allSpecs.map((s) => (fields[s.index] ?? "").trim());
  const blankCount = rawValues.filter((v) => v === "").length;
  if (blankCount === rawValues.length) {
    return null; // 全欄空欄 = 未公表
  }
  if (blankCount > 0) {
    throw new Error(
      `MOF CSV: 期間 ${period.periodKey} の値欄が一部だけ空欄です (様式変更の可能性): ${JSON.stringify(fields)}`
    );
  }
  const rows: MofFlowRow[] = [];
  for (const spec of allSpecs) {
    if (NET_ONLY_ASSET_CLASSES.has(spec.assetClass) && spec.metric !== "net") {
      // blockFieldSpecs は subtotal/total に net しか生成しないため到達しない防御的分岐。
      continue;
    }
    const value = parseYen100M(fields[spec.index] ?? "");
    if (value === null) {
      throw new Error(
        `MOF CSV: 期間 ${period.periodKey} の ${spec.direction}/${spec.assetClass}/${spec.metric} が空欄です`
      );
    }
    rows.push({
      frequency,
      periodKey: period.periodKey,
      periodStart: period.start,
      periodEnd: period.end,
      direction: spec.direction,
      assetClass: spec.assetClass,
      metric: spec.metric,
      value,
      unit: "億円",
    });
  }
  return rows;
}

// -------------------- 週次 CSV --------------------

// 例: "2026．9．6～9．12" (同一年) / "2006．12．31～ 2007．1．6" (年をまたぐ場合は終了年を明記)。
// 全角ピリオド(U+FF0E)・全角チルダ(U+FF5E)。前後の空白は trim 済み想定。
const WEEKLY_PERIOD_RE =
  /^(\d{4})．(\d{1,2})．(\d{1,2})～\s*(?:(\d{4})．)?(\d{1,2})．(\d{1,2})\s*$/;

function parseWeeklyPeriod(raw: string): PeriodInfo | null {
  const trimmed = raw.trim();
  const m = WEEKLY_PERIOD_RE.exec(trimmed);
  if (!m) return null;
  const [, y1, mo1, d1, y2opt, mo2, d2] = m;
  const year1 = Number(y1);
  const month1 = Number(mo1);
  const day1 = Number(d1);
  const month2 = Number(mo2);
  const day2 = Number(d2);
  let year2: number;
  if (y2opt) {
    year2 = Number(y2opt);
  } else {
    year2 = year1;
    if (month2 < month1) {
      // 年またぎ週は原本が必ず終了年を明記する (2006-12-31~2007-1-6 等、実データで確認済み)。
      // 明記の無い年またぎは仕様外なので推測せず throw する (ルール2)。
      throw new Error(
        `MOF 週次CSV: 年をまたぐ期間なのに終了年の記載がありません: ${JSON.stringify(raw)}`
      );
    }
  }
  const start = toIsoDate(year1, month1, day1);
  const end = toIsoDate(year2, month2, day2);
  return { periodKey: `${start}_${end}`, start, end };
}

export function parseMofWeeklyFlows(
  bytes: Uint8Array,
  sourceUrl: string = MOF_PORTFOLIO_FLOWS_WEEKLY_URL
): MofPortfolioFlowsParseResult {
  const text = decodeMofCsv(bytes);
  const csvRows = parseCsvRows(text);
  const rows: MofFlowRow[] = [];
  const unpublishedPeriods: string[] = [];
  for (const fields of csvRows) {
    const period = parseWeeklyPeriod(fields[0] ?? "");
    if (!period) continue; // 見出し・注記・空行はここで自然にスキップされる
    const parsed = rowsFromFields("weekly", period, fields, 1, 12);
    if (parsed === null) {
      unpublishedPeriods.push(period.periodKey);
      continue;
    }
    rows.push(...parsed);
  }
  if (rows.length === 0 && unpublishedPeriods.length === 0) {
    throw new Error(
      `MOF 週次CSV: データ行を1件も抽出できませんでした (様式変更の可能性): ${sourceUrl}`
    );
  }
  return { frequency: "weekly", rows, unpublishedPeriods, sourceUrl };
}

// -------------------- 月次 CSV --------------------

const MONTH_ABBREVIATIONS: Record<string, number> = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  May: 5,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
};

/** 月末日を計算する (フォーマット原本には無い派生値だが、暦の事実であり捏造ではない)。 */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function parseMofMonthlyFlows(
  bytes: Uint8Array,
  sourceUrl: string = MOF_PORTFOLIO_FLOWS_MONTHLY_URL
): MofPortfolioFlowsParseResult {
  const text = decodeMofCsv(bytes);
  const csvRows = parseCsvRows(text);
  const rows: MofFlowRow[] = [];
  const unpublishedPeriods: string[] = [];
  // 西暦年は1月の行にのみ記載され (例: "2026"), 2月の行はその年の和暦表記
  // ("(令和8年)") が入るが3月以降は空欄。年は最後に見た西暦4桁を引き継ぐ。
  let currentYear: number | null = null;
  for (const fields of csvRows) {
    const yearCell = (fields[0] ?? "").trim();
    if (/^\d{4}$/.test(yearCell)) {
      currentYear = Number(yearCell);
    }
    const monthAbbrRaw = (fields[2] ?? "").trim();
    const month = MONTH_ABBREVIATIONS[monthAbbrRaw];
    if (!month || currentYear === null) continue; // 見出し・注記・暦年/年度集計行はここでスキップ
    const monthKey = `${currentYear}-${String(month).padStart(2, "0")}`;
    const period: PeriodInfo = {
      periodKey: monthKey,
      start: `${monthKey}-01`,
      end: `${monthKey}-${String(lastDayOfMonth(currentYear, month)).padStart(2, "0")}`,
    };
    const parsed = rowsFromFields("monthly", period, fields, 3, 14);
    if (parsed === null) {
      unpublishedPeriods.push(period.periodKey);
      continue;
    }
    rows.push(...parsed);
  }
  if (rows.length === 0 && unpublishedPeriods.length === 0) {
    throw new Error(
      `MOF 月次CSV: データ行を1件も抽出できませんでした (様式変更の可能性): ${sourceUrl}`
    );
  }
  return { frequency: "monthly", rows, unpublishedPeriods, sourceUrl };
}

/** 期間キーが「まだ公表されていない」と判定されたかを調べる。 */
export function isMofPeriodUnpublished(
  result: MofPortfolioFlowsParseResult,
  periodKey: string
): boolean {
  return result.unpublishedPeriods.includes(periodKey);
}

// -------------------- 取得 --------------------

export interface MofPortfolioFlowsFetchResult {
  weekly: { bytes: Uint8Array; url: string };
  monthly: { bytes: Uint8Array; url: string };
}

/**
 * 週次・月次の両 CSV を取得する。この取得元はファイル名が固定 (JPX の週次
 * PDFのように「最新ファイルの URL を毎回探す」必要が無い) なので、1回の
 * 実行で厳密に2回だけ fetch する。
 */
export async function fetchMofPortfolioFlowsRaw(): Promise<MofPortfolioFlowsFetchResult> {
  const [weeklyRes, monthlyRes] = await Promise.all([
    fetch(MOF_PORTFOLIO_FLOWS_WEEKLY_URL, { headers: { "User-Agent": UA } }),
    fetch(MOF_PORTFOLIO_FLOWS_MONTHLY_URL, { headers: { "User-Agent": UA } }),
  ]);
  if (!weeklyRes.ok) {
    throw new Error(
      `MOF 週次CSV HTTPエラー: ${weeklyRes.status} ${weeklyRes.statusText} (${MOF_PORTFOLIO_FLOWS_WEEKLY_URL})`
    );
  }
  if (!monthlyRes.ok) {
    throw new Error(
      `MOF 月次CSV HTTPエラー: ${monthlyRes.status} ${monthlyRes.statusText} (${MOF_PORTFOLIO_FLOWS_MONTHLY_URL})`
    );
  }
  const weeklyBytes = new Uint8Array(await weeklyRes.arrayBuffer());
  const monthlyBytes = new Uint8Array(await monthlyRes.arrayBuffer());
  return {
    weekly: { bytes: weeklyBytes, url: MOF_PORTFOLIO_FLOWS_WEEKLY_URL },
    monthly: { bytes: monthlyBytes, url: MOF_PORTFOLIO_FLOWS_MONTHLY_URL },
  };
}

export interface MofPortfolioFlows {
  weekly: MofPortfolioFlowsParseResult;
  monthly: MofPortfolioFlowsParseResult;
  raw: MofPortfolioFlowsFetchResult;
}

/** 取得+パースをまとめて行う (ingest スクリプトから呼ぶ想定のエントリポイント)。 */
export async function fetchMofPortfolioFlows(): Promise<MofPortfolioFlows> {
  const raw = await fetchMofPortfolioFlowsRaw();
  return {
    weekly: parseMofWeeklyFlows(raw.weekly.bytes, raw.weekly.url),
    monthly: parseMofMonthlyFlows(raw.monthly.bytes, raw.monthly.url),
    raw,
  };
}

// -------------------- 縦長の観測ログ行への変換 --------------------

export interface MofObservationRow {
  frequency: MofFlowFrequency;
  period: string;
  periodStart: string;
  periodEnd: string;
  indicatorKey: MofFlowIndicatorKey;
  /** 区分 (投資部門/資産クラス/国地域/商品など): ここでは方向×資産クラス。 */
  category: string;
  value: number;
  unit: "億円";
  /** この取得元は近似ではなく原本の確定値そのもの。 */
  isApproximate: boolean;
  /** この取得元は推定ではなく実測(報告ベース)の値。 */
  isEstimated: boolean;
  sourceUrl: string;
}

const DIRECTION_LABEL: Record<MofFlowDirection, string> = {
  outward: "対外(居住者による海外投資)",
  inward: "対内(非居住者による対日投資)",
};

const ASSET_CLASS_LABEL: Record<MofAssetClass, string> = {
  equity: "株式・投資ファンド持分",
  long_term_bond: "中長期債",
  subtotal: "小計(株式等+中長期債)",
  short_term_bond: "短期債",
  total: "合計",
};

const METRIC_INDICATOR: Record<MofFlowMetric, MofFlowIndicatorKey> = {
  net: "mof_net_flow",
  acquisition: "mof_gross_acquisition",
  disposition: "mof_gross_disposition",
};

/**
 * パース結果を「期間・指標キー・区分・値・単位・近似か・推定か」の縦長形式へ変換する。
 * 観測ログ (Notion 等) への書込みはこの形を使う想定 (この関数自体は書込みを行わない)。
 */
export function toMofObservationRows(
  result: MofPortfolioFlowsParseResult
): MofObservationRow[] {
  return result.rows.map((r) => ({
    frequency: r.frequency,
    period: r.periodKey,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    indicatorKey: METRIC_INDICATOR[r.metric],
    category: `${DIRECTION_LABEL[r.direction]}・${ASSET_CLASS_LABEL[r.assetClass]}`,
    value: r.value,
    unit: r.unit,
    isApproximate: false,
    isEstimated: false,
    sourceUrl: result.sourceUrl,
  }));
}

// -------------------- ルール6: 一次データアーカイブ入力 (呼出しは統合担当) --------------------

export interface MofArchiveFileInput {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}

export interface MofArchiveInput {
  service: string;
  key: string;
  source: string;
  metadata: Record<string, unknown>;
  files: MofArchiveFileInput[];
}

function latestPeriodKey(rows: MofFlowRow[]): string | null {
  if (rows.length === 0) return null;
  let latest = rows[0]!;
  for (const r of rows) {
    if (r.periodEnd > latest.periodEnd) latest = r;
  }
  return latest.periodKey;
}

/**
 * `recordPrimaryData()` (src/shared/notion-archive) にそのまま渡せる入力を組む純関数。
 * 冪等キーは「週次CSVの最新期間・月次CSVの最新期間」から作るため、まだ新しいデータが
 * 公表されていない再実行では同じキーになり、Notion 側で重複アップロードされない
 * (ルール6の冪等要件)。このモジュール自体は Notion へは書き込まない。
 */
export function mofPortfolioFlowsArchiveInput(
  raw: MofPortfolioFlowsFetchResult,
  parsed: { weekly: MofPortfolioFlowsParseResult; monthly: MofPortfolioFlowsParseResult }
): MofArchiveInput {
  const latestWeek = latestPeriodKey(parsed.weekly.rows);
  const latestMonth = latestPeriodKey(parsed.monthly.rows);
  if (!latestWeek || !latestMonth) {
    throw new Error(
      "MOF portfolio flows: 記録対象のデータが空です (アーカイブ入力を組めません)"
    );
  }
  return {
    service: "moneyflow",
    key: `mof-portfolio-flows-w${latestWeek}-m${latestMonth}`,
    source: MOF_PORTFOLIO_FLOWS_INDEX_URL,
    metadata: {
      weeklyUrl: raw.weekly.url,
      monthlyUrl: raw.monthly.url,
      weeklyBytes: raw.weekly.bytes.byteLength,
      monthlyBytes: raw.monthly.bytes.byteLength,
      latestWeeklyPeriod: latestWeek,
      latestMonthlyPeriod: latestMonth,
      weeklyUnpublishedPeriods: parsed.weekly.unpublishedPeriods,
      monthlyUnpublishedPeriods: parsed.monthly.unpublishedPeriods,
    },
    files: [
      {
        bytes: raw.weekly.bytes,
        filename: `mof-week-${latestWeek}.csv`,
        contentType: "text/csv",
      },
      {
        bytes: raw.monthly.bytes,
        filename: `mof-montha1-${latestMonth}.csv`,
        contentType: "text/csv",
      },
    ],
  };
}
