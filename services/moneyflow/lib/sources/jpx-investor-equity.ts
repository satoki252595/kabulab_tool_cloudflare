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
 * 直近週のみを収録する様式に変えた (予告どおり。新旧の行が同じ表に混在する)。
 * 本モジュール作成時点 (2026-09-27) ではまだ旧様式 (val/vol 別ファイル、市場別シート)
 * の実ファイルしか存在しなかったが、2026-09-29 に実ファイル
 * (`stock_1_w_20260914_20260918.xlsx`、2026年9月第3週 9/14〜9/18 分) と実一覧ページで
 * 再検証済み:
 *   - 旧様式 (legacy) パーサ: 実際に配布されている週次・月次ファイルから検証。
 *   - 週次の新様式 (unified) パーサ: 上記の実ファイルで検証済み (単位は見出しどおり
 *     千株/千円。112レコード全件で 買い-売り=差引・売り+買い=合計が一致)。
 *     JPX 公式サンプルファイル (実データではなく仕様サンプル。値が円/株単位のまま)
 *     は桁の検査で throw する (実データではないことの傍証としてテストで確認)。
 *
 * 【2026-10-08 の様式変更 (月次・週次とは別告知)】月次一覧ページ (00-01.html) には
 * 週次とは別建てで、2026-10-08 掲載分から月次ファイルを株数/金額の2ファイルから
 * 1ファイルに統合し、ファイル名も `stock_1_mYYYYMM.xlsx` (週の概念なし) に変える
 * 予告が掲載されている (公式サンプル `stock_1_mYYYYMM.xlsx` で構造を確認済み)。
 * この新様式はヘッダ行が「年月週 Year, Month, Week」ではなく「年月 Year, Month」で
 * 始まるため、`parseUnifiedSheet` (週次の新様式用) では読めずヘッダ行が見つからず
 * throw する。月次専用の新様式パーサは未実装 (KNOWN_LIMITATIONS 参照)。
 *
 * 【新様式の検知】取込経路で実際に最初に新様式を目にするのはファイルではなく
 * 一覧ページ。週次は新旧の行をどちらも読む (上記)。月次は新様式 (2026-10-08 掲載分
 * から) が未検証のため、`parseMonthlyIndexHtml` は告知どおりのファイル名
 * (`stock_1_m<数字>`) のリンクや、表の中の想定外の行・セルを見つけた時点で throw
 * する (ルール2: 古い期間で黙って埋めない。旧様式だけを拾う実装のままだと新様式の
 * セルを読み飛ばして「1つ前の旧様式の月」を最新として黙って返してしまう — 再検証で
 * 実ページに新様式のセルを差し込んで再現済み)。
 *
 * 利用条件: JPX 利用規約により、許諾なしの商用二次利用・再配信・生成AIによる
 * 学習/解析利用は禁止されている。kabulab では「資金フロー」Notion ページ
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
  /** JPX がこの期間を帰属させている年月 (YYYY-MM)。表題「2026年9月第1週」「2026年8月」
   *  の年月そのもの。JPX の週次・月次の集計期間は週単位で区切られ、開始日の月とは
   *  一致しない (実ファイル: 「2026年9月第1週」= 8/31〜9/4。「2026年8月」= 8/3〜8/28 で
   *  営業日の 8/31 を含まない = 9月分は 8/31 から始まる)。月の識別 (冪等キー・月次の
   *  期間ラベル) には periodStart/periodEnd ではなくこれを使う。 */
  periodMonth: string;
  /** ISO 8601 (YYYY-MM-DD)。unified 様式でファイル名から取得できない場合は null
   *  (rule2: 分からない値を計算で埋めない。分からないことを型で表す) */
  periodStart: string | null;
  periodEnd: string | null;
  market: InvestorEquityMarket;
  /** JPX 表記そのままの投資部門名 (例: "自己計", "個人", "海外投資家法人") */
  investorCategory: string;
  /** このパーサが出すレコード集合の中で、他のレコードの合算になっている行なら true
   *  (旧様式: 委託計・総計・法人・金融機関。新様式: なし)。false の行だけを足すと各市場の
   *  「総計」の売り・買いに一致する (実ファイル全6本×4市場で検証済み)。「自己計」は
   *  自己現金+自己信用の合計だが、その内訳はレコードとして出さない (本パーサは主表のみを
   *  読む) ため、出力集合の中では葉として false にする。 */
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

/** 空セル (未定義・null・空白のみ) か。Excel の空セルは「値が無い」ことそのものであり、
 *  0 等の値では埋めない (呼び出し側が空であることを前提に分岐する)。 */
function isBlankCell(c: unknown): boolean {
  return c === undefined || c === null || String(c).trim() === "";
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
  periodMonth: string;
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
  periodMonth: string;
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
    // タイトルの月 (例: "9月") と終了日の月が一致しない = 本実装が未検証の期間の切り方。
    // 実ファイルで確認できているのは「月またぎの週は終了日の月に属する」例
    // (2026年9月第1週 = 8/31〜9/4) のみ。終了日が翌月に入る週 (例: 9/28〜10/2) を
    // JPX がどちらの月に帰属させるかは未確認のため、推測で受け入れず throw する
    // (KNOWN_LIMITATIONS 参照)。
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
    periodMonth: `${year}-${pad2(month)}`,
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

// 旧様式の主表に並ぶ投資部門 (表の上から順)。この集合と1件でも違えば様式変更として
// throw する (行の欠落・追加を黙って受け入れない)。
const LEGACY_CATEGORY_LABELS: readonly string[] = [
  "自己計",
  "委託計",
  "総計",
  "法人",
  "個人",
  "海外投資家",
  "証券会社",
  "投資信託",
  "事業法人",
  "その他法人等",
  "金融機関",
  "生保・損保",
  "都銀・地銀等",
  "信託銀行",
  "その他金融機関",
];

// 出力レコード集合の中で「他のレコードの合算」になっている行。実ファイル
// (週次2本・月次1本 × 金額/株数 × 4市場) で実測して恒等式を確認済み:
//   総計 = 自己計 + 委託計
//   委託計 = 法人 + 個人 + 海外投資家 + 証券会社
//   法人 = 投資信託 + 事業法人 + その他法人等 + 金融機関
//   金融機関 = 生保・損保 + 都銀・地銀等 + 信託銀行 + その他金融機関
// 「自己計」は自己現金+自己信用の合計だが、その内訳はレコードとして出さないため
// 集計行に含めない (含めると isAggregateCategory===false の行の合計が総計から
// 自己取引分だけ欠ける)。「法人」を漏らすと法人とその子を二重計上する。
const AGGREGATE_CATEGORIES = new Set(["委託計", "総計", "法人", "金融機関"]);

function parseLegacySheet(
  sheetName: string,
  rows: unknown[][]
): { records: Omit<InvestorEquityRecord, "formatVersion" | "market">[]; period: LegacyPeriodInfo; metric: InvestorEquityMetric; unit: "thousand_yen" | "thousand_shares" } {
  const title = String(rows[0]?.[0] ?? "");
  let metric: InvestorEquityMetric;
  let unit: "thousand_yen" | "thousand_shares";
  let unitPrefix: string;
  if (title.includes("[金額]")) {
    metric = "value";
    unit = "thousand_yen";
    unitPrefix = "千円";
  } else if (title.includes("[株数]")) {
    metric = "volume";
    unit = "thousand_shares";
    unitPrefix = "千株";
  } else {
    throw new Error(
      `JPX 投資部門別売買状況 (${sheetName}): シート見出しに [金額]/[株数] が見つかりません: "${title}"`
    );
  }

  // 単位はシート右上の単位表記 (実ファイル: "千円,%  1,000 yen, %" / "千株,%  1,000 shs., %")
  // を正のソースにする。見出しの [金額]/[株数] から単位を決め打ちしない
  // (単位が円/株に変わると値が1000倍ずれて黙って保存されるため)。
  const unitCell = (rows[4] ?? []).map((c) => String(c).trim()).find((s) => /^千(?:円|株)/.test(s));
  if (unitCell === undefined || !unitCell.startsWith(unitPrefix)) {
    throw new Error(
      `JPX 投資部門別売買状況 (${sheetName}): 単位表記が想定 (${unitPrefix}) と異なります: ` +
        `${JSON.stringify(rows[4] ?? [])} (様式変更の可能性)`
    );
  }

  const period = resolveLegacyPeriod(rows);
  const valueCol = period.columns.value;
  const balanceCol = period.columns.balance;

  const records: Omit<InvestorEquityRecord, "formatVersion" | "market">[] = [];
  for (let i = 12; i + 2 < rows.length; i++) {
    const r0 = rows[i] ?? [];
    const r1 = rows[i + 1] ?? [];
    const r2 = rows[i + 2] ?? [];
    if (r0[2] !== "Sales" || r1[2] !== "Purchases" || r2[2] !== "Total") continue;

    const label = normalizeCategoryLabel(r0[0]);
    if (label === "") {
      throw new Error(
        `JPX 投資部門別売買状況 (${sheetName}): 行${i}の売り/買い/合計の組に投資部門名がありません (様式変更の可能性)`
      );
    }

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

    // 符号の向きを JPX 自身の「差引き」欄で確認する (注記「-は売越しを示す」)。
    // 差引きは売り越しなら売り行、買い越しなら買い行の片方にだけ載る。net=買い-売り と
    // 一致しなければ列ずれ・符号の取り違えとして throw する。
    const net = buy - sell;
    const balanceCells = [r0[balanceCol], r1[balanceCol]].filter((c) => !isBlankCell(c));
    if (balanceCells.length > 1) {
      throw new Error(
        `JPX 投資部門別売買状況 (${sheetName}/${label}): 差引き欄が売り行・買い行の両方にあります (様式変更の可能性)`
      );
    }
    if (balanceCells.length === 1) {
      const balance = parseJpxAmount(balanceCells[0]);
      if (Math.abs(balance - net) > 1) {
        throw new Error(
          `JPX 投資部門別売買状況 (${sheetName}/${label}): 差引き欄 (${balance}) が 買い-売り (${net}) と一致しません`
        );
      }
    } else if (net !== 0) {
      throw new Error(
        `JPX 投資部門別売買状況 (${sheetName}/${label}): 差引き欄が空なのに 買い-売り が ${net} です (様式変更の可能性)`
      );
    }

    records.push({
      periodType: period.periodType,
      periodLabel: period.periodLabel,
      periodMonth: period.periodMonth,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      investorCategory: label,
      isAggregateCategory: AGGREGATE_CATEGORIES.has(label),
      metric,
      unit,
      sell,
      buy,
      net,
      total,
    });
  }

  if (records.length === 0) {
    throw new Error(
      `JPX 投資部門別売買状況 (${sheetName}): 投資部門の行が1件も見つかりません (様式変更の可能性)`
    );
  }
  const labels = records.map((r) => r.investorCategory);
  if (labels.join("|") !== LEGACY_CATEGORY_LABELS.join("|")) {
    throw new Error(
      `JPX 投資部門別売買状況 (${sheetName}): 投資部門の並びが想定と異なります ` +
        `(実際: ${labels.join(",")} / 想定: ${LEGACY_CATEGORY_LABELS.join(",")}) — 様式変更の可能性`
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

/** サンプルファイルから読み取った列オフセット→投資部門名の対応。見出しは3段
 *  (大分類: 自己/個人/海外投資家/証券会社/法人 → 中分類 → 小分類) で、各エントリの
 *  `parent` は大分類の段 (ヘッダ行の3行上。マージセルのため左方向に直近の非空セルを
 *  見る)、`guardSubstring` は小分類の段 (ヘッダ行の1行上) に含まれているはずの部分
 *  文字列。どちらか一致しなければ throw する (列の並べ替えで「自己現金」と
 *  「個人現金」、「海外投資家法人」と「法人」を取り違えないための様式変更検知)。 */
const UNIFIED_GROUPS: ReadonlyArray<{
  col: number;
  label: string;
  parent: string;
  guardSubstring: string;
}> = [
  { col: 3, label: "自己現金", parent: "自己", guardSubstring: "現金取引" },
  { col: 7, label: "自己信用", parent: "自己", guardSubstring: "信用取引" },
  { col: 11, label: "個人現金", parent: "個人", guardSubstring: "現金取引" },
  { col: 15, label: "個人信用", parent: "個人", guardSubstring: "信用取引" },
  { col: 19, label: "海外投資家法人", parent: "海外投資家", guardSubstring: "法人" },
  { col: 23, label: "海外投資家個人", parent: "海外投資家", guardSubstring: "個人" },
  { col: 27, label: "証券会社", parent: "証券会社", guardSubstring: "証券会社" },
  { col: 31, label: "投資信託", parent: "法人", guardSubstring: "投資信託" },
  { col: 35, label: "事業法人", parent: "法人", guardSubstring: "事業法人" },
  { col: 39, label: "その他法人等", parent: "法人", guardSubstring: "その他法人等" },
  { col: 43, label: "生保・損保", parent: "法人", guardSubstring: "生保" },
  { col: 47, label: "都銀・地銀等", parent: "法人", guardSubstring: "都銀" },
  { col: 51, label: "信託銀行", parent: "法人", guardSubstring: "信託銀行" },
  { col: 55, label: "その他金融機関", parent: "法人", guardSubstring: "その他金融機関" },
];

/** 新様式の売り/買い/差引/合計の4列見出し (実ファイル・公式サンプル共通の原文そのまま)。
 *  各投資部門の4列はこの順序で並ぶ。 */
const UNIFIED_SUB_HEADERS: readonly string[] = ["売 Sales", "買 Purchases", "差引 Balance", "合計 Total"];

/** 新様式の1セル (1市場×1投資部門×1期間の売り/買い/合計) として、見出しの単位
 *  (千円/千株) で読んだときに物理的にありえない大きさ。JPX 公式サンプル (週次・月次) は
 *  見出しが「千株/千円」なのに全数値が 1000 の倍数で、千円として読むと例えば週次の
 *  プライム自己現金の売りだけで 6,094,207,109,000 千円 (約6,000兆円) になる。旧様式の
 *  実ファイルでは二市場・全投資部門の総計の売買合計でさえ月次 2026年8月で
 *  407,516,356,670 千円 (約408兆円)・140,925,051 千株。値が円/株単位のまま「千円/千株」と
 *  表記されたファイルを 1000 倍の値として黙って保存しないため、1セルがこれを超えたら
 *  throw する (上限は旧様式実データの月次総計の約5倍/約14倍で、1部門・1期間の値が正当に
 *  超えることは無い)。 */
const UNIFIED_IMPLAUSIBLE_ABS: Record<InvestorEquityMetric, number> = {
  value: 2e12, // 千円 (= 2,000兆円)
  volume: 2e9, // 千株 (= 2兆株)
};

function parseUnifiedPeriodCode(code: unknown): { periodLabel: string; year: number; month: number; week: number } {
  const s = String(code ?? "").trim();
  const m = /^(\d{4})(\d{2})(\d)$/.exec(s);
  if (!m) {
    throw new Error(`JPX 投資部門別売買状況 (新様式): 年月週コードの様式が想定外です: "${s}"`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const week = Number(m[3]);
  if (month < 1 || month > 12 || week < 1 || week > 6) {
    throw new Error(`JPX 投資部門別売買状況 (新様式): 年月週コードの月/週が範囲外です: "${s}"`);
  }
  return { periodLabel: `${year}年${month}月第${week}週`, year, month, week };
}

/** ファイル名 `stock_1_w_YYYYMMDD_YYYYMMDD.xlsx` から期間の開始日・終了日を取る。
 *  新様式は年月週コードだけでは正確な日付が復元できない (何週目が暦週と一致する
 *  保証がない) ため、ファイル名を正のソースにする。サンプルファイルは
 *  プレースホルダ名 (`YYYYMMDD`) のままなので null を返す (捏造しない)。
 *  数字ではあるが暦日として成り立たない・開始>終了の場合は throw する。 */
export function parseUnifiedFilenamePeriod(
  filename: string
): { periodStart: string; periodEnd: string } | null {
  const m = /stock_1_w_(\d{8})_(\d{8})\./.exec(filename);
  if (!m) return null;
  const toIso = (yyyymmdd: string): string => {
    const iso = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) {
      throw new Error(`JPX 投資部門別売買状況 (新様式): ファイル名の日付が暦日として不正です: "${filename}"`);
    }
    return iso;
  };
  const periodStart = toIso(m[1]);
  const periodEnd = toIso(m[2]);
  if (periodStart > periodEnd) {
    throw new Error(`JPX 投資部門別売買状況 (新様式): ファイル名の開始日が終了日より後です: "${filename}"`);
  }
  return { periodStart, periodEnd };
}

/** 見出し行 `row` の列 `col` から左へ、直近の非空セルの文字列を返す
 *  (横方向マージセルは先頭列にだけ値が入るため)。見つからなければ null。 */
function nearestLeftText(row: readonly unknown[], col: number): string | null {
  for (let c = col; c >= 0; c--) {
    if (!isBlankCell(row[c])) return String(row[c]);
  }
  return null;
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
  const headerRow = rows[headerRowIdx] ?? [];

  // 単位は見出しセル (サンプル: "株数／金額 Shares／Value 千株／千円 1,000 Shares／1,000 yen")
  // を正のソースにする。千株/千円 以外の表記なら throw (値の桁を決め打ちしない)。
  const unitHeader = String(headerRow[2]);
  if (!unitHeader.includes("千株") || !unitHeader.includes("千円")) {
    throw new Error(
      `JPX 投資部門別売買状況 (新様式): 単位表記が想定 (千株/千円) と異なります: "${unitHeader}" (様式変更の可能性)`
    );
  }

  // 列の見出しを先に検証する (データ行の数に依らず一度だけ)。
  const parentRow = rows[headerRowIdx - 3] ?? [];
  const guardRow = rows[headerRowIdx - 1] ?? [];
  for (const group of UNIFIED_GROUPS) {
    const parentText = nearestLeftText(parentRow, group.col);
    const guardText = String(guardRow[group.col]);
    if (parentText === null || !parentText.startsWith(group.parent) || !guardText.includes(group.guardSubstring)) {
      throw new Error(
        `JPX 投資部門別売買状況 (新様式): 列${group.col}の見出しが想定と異なります ` +
          `(期待: 大分類 "${group.parent}"・小分類 "${group.guardSubstring}", 実際: "${parentText}"・"${guardText}") — 様式変更の可能性`
      );
    }
    // 売り/買い/差引/合計の4列見出しと並び順も検証する (実ファイル・公式サンプルとも
    // ["売 Sales", "買 Purchases", "差引 Balance", "合計 Total"]。サンプルは末尾に
    // 空白があるセルがあるため前後空白は除いて比べる)。列ずれ・未知見出しは
    // 売買の取り違えに直結するため、1列でも違えば throw する。
    const subHeaders = [0, 1, 2, 3].map((j) => String(headerRow[group.col + j] ?? "").trim());
    for (let j = 0; j < UNIFIED_SUB_HEADERS.length; j++) {
      if (subHeaders[j] !== UNIFIED_SUB_HEADERS[j]) {
        throw new Error(
          `JPX 投資部門別売買状況 (新様式): 列${group.col + j}の見出しが想定と異なります ` +
            `(期待: "${UNIFIED_SUB_HEADERS[j]}", 実際: "${subHeaders[j]}") — 様式変更の可能性`
        );
      }
    }
  }

  const filenamePeriod = filename ? parseUnifiedFilenamePeriod(filename) : null;

  // 元シートは「年月週」(col0) と「市場」(col1) を複数行 (株数行・金額行の2行) に
  // またがるマージセルで表現しており、2行目以降は空文字になる。直前に見つかった
  // 非空値を引き継ぐ (Excel のマージセル読み取りの標準的な扱い。値の捏造ではなく
  // マージ構造の素直な展開)。引き継ぎを誤ると (市場, 株数/金額) が重複するため、
  // 重複と欠落 (4市場×2指標が揃わない) は throw で検知する。
  let periodCode: string | null = null;
  let carryMarketRaw: string | null = null;
  const seenMarketMetric = new Set<string>();

  const records: Omit<InvestorEquityRecord, "formatVersion">[] = [];
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    if (row.every((c) => isBlankCell(c))) continue; // 末尾の空行
    const metricRaw = String(row[2]).trim();

    if (!isBlankCell(row[0])) {
      const code = String(row[0]).trim();
      if (periodCode !== null && code !== periodCode) {
        throw new Error(
          `JPX 投資部門別売買状況 (新様式): 1ファイルに複数の年月週コードがあります ("${periodCode}" と "${code}")。直近週のみの様式のはずです`
        );
      }
      periodCode = code;
    }
    if (periodCode === null) {
      throw new Error(`JPX 投資部門別売買状況 (新様式): 年月週コードが確定していません (行${i})`);
    }
    const { periodLabel, year, month } = parseUnifiedPeriodCode(periodCode);
    const periodMonth = `${year}-${pad2(month)}`;
    if (filenamePeriod !== null) {
      // 週の日付 (ファイル名) は年月週コードの月と重なっていなければならない
      // (月またぎの週がどちらの月に属するかは決め打ちせず、重なりだけを確かめる)。
      const monthStart = `${periodMonth}-01`;
      const monthEnd = `${periodMonth}-${pad2(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;
      if (filenamePeriod.periodEnd < monthStart || filenamePeriod.periodStart > monthEnd) {
        throw new Error(
          `JPX 投資部門別売買状況 (新様式): ファイル名の期間 (${filenamePeriod.periodStart}〜${filenamePeriod.periodEnd}) ` +
            `が年月週コード ${periodCode} の月と重なりません`
        );
      }
    }

    const rowMarketRaw = String(row[1]).split(/\r?\n/)[0].trim();
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
    const marketMetric = `${market}|${metric}`;
    if (seenMarketMetric.has(marketMetric)) {
      throw new Error(
        `JPX 投資部門別売買状況 (新様式): ${market} の${metricRaw}行が重複しています (行${i}) — 様式変更の可能性`
      );
    }
    seenMarketMetric.add(marketMetric);

    for (const group of UNIFIED_GROUPS) {
      const sell = parseJpxAmount(row[group.col]);
      const buy = parseJpxAmount(row[group.col + 1]);
      const balance = parseJpxAmount(row[group.col + 2]);
      const total = parseJpxAmount(row[group.col + 3]);
      const limit = UNIFIED_IMPLAUSIBLE_ABS[metric];
      if ([sell, buy, total].some((v) => Math.abs(v) > limit)) {
        throw new Error(
          `JPX 投資部門別売買状況 (新様式/${market}/${group.label}/${metricRaw}): 値 (売り ${sell}, 買い ${buy}, 合計 ${total}) が ` +
            `見出しの単位 (${unit === "thousand_yen" ? "千円" : "千株"}) では桁としてありえません (上限 ${limit})。` +
            "値が円/株単位のまま千円/千株と表記されている可能性があり、1000倍の値を保存しないため停止します"
        );
      }
      // 公式セルの厳密整合: 売り+買い=表の合計、買い-売り=差引欄。±1 の許容はしない
      // (実ファイル 112件全件で厳密一致を確認済み。JPX に丸めの文書が無い以上、
      // 推測の許容は捏造と同様に避ける)。食い違えば throw する。
      if (sell + buy !== total) {
        throw new Error(
          `JPX 投資部門別売買状況 (新様式/${group.label}): 売買合計の不整合 (売り+買い=${sell + buy}, 表の合計=${total})`
        );
      }
      if (buy - sell !== balance) {
        throw new Error(
          `JPX 投資部門別売買状況 (新様式/${group.label}): 差引欄 (${balance}) が 買い-売り (${buy - sell}) と一致しません`
        );
      }

      records.push({
        periodType: "weekly",
        periodLabel,
        periodMonth,
        periodStart: filenamePeriod === null ? null : filenamePeriod.periodStart,
        periodEnd: filenamePeriod === null ? null : filenamePeriod.periodEnd,
        market,
        investorCategory: group.label,
        isAggregateCategory: false,
        metric,
        unit,
        sell,
        buy,
        // net は公式の差引欄そのもの (再計算値で置き換えない。派生値との区別のため)。
        net: balance,
        total,
      });
    }
  }

  if (records.length === 0) {
    throw new Error("JPX 投資部門別売買状況 (新様式): データ行が1件も見つかりません");
  }
  const expectedMarketMetrics = Object.values(JA_MARKET_TO_CANONICAL).length * 2;
  if (seenMarketMetric.size !== expectedMarketMetrics) {
    throw new Error(
      `JPX 投資部門別売買状況 (新様式): 市場×株数/金額の行が ${seenMarketMetric.size} 組しかありません ` +
        `(${expectedMarketMetrics} 組のはず: ${[...seenMarketMetric].join(", ")})`
    );
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
    let firstSheetSignature: string | null = null;
    for (const marketName of LEGACY_MARKET_SHEET_NAMES) {
      const sheet = workbook.Sheets[marketName];
      if (!sheet) {
        throw new Error(`JPX 投資部門別売買状況: シート "${marketName}" が見つかりません`);
      }
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
      const { records, period, metric } = parseLegacySheet(marketName, rows);
      // 1ファイル内の4シートは同じ期間・同じ指標 (金額 or 株数) のはず。食い違えば
      // どれか1つを代表値として採らず throw する。
      const signature = `${metric}|${period.periodLabel}|${period.periodStart}|${period.periodEnd}`;
      if (firstSheetSignature === null) {
        firstSheetSignature = signature;
      } else if (signature !== firstSheetSignature) {
        throw new Error(
          `JPX 投資部門別売買状況: シート "${marketName}" の期間/指標 (${signature}) が他のシート (${firstSheetSignature}) と異なります`
        );
      }
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

export interface WeeklyIndexEntryLegacy {
  kind: "legacy";
  /** 例: "2026年9月第2週(9月7日～9月11日)" (一覧ページ表記そのまま) */
  label: string;
  valueXlsUrl: string;
  volumeXlsUrl: string;
}

export interface WeeklyIndexEntryUnified {
  kind: "unified";
  /** 例: "2026年9月第3週(9月14日～9月18日)" (一覧ページ表記そのまま) */
  label: string;
  unifiedXlsxUrl: string;
}

/**
 * 週次一覧の1行。2026-09-29 掲載分から新様式の単一 xlsx 行が先頭に載り、
 * それ以前の週は旧様式の4リンク行のまま残る (同じ表に混在する)。
 */
export type WeeklyIndexEntry = WeeklyIndexEntryLegacy | WeeklyIndexEntryUnified;

// 一覧ページの HTML は JPX の CMS が出す固定の表組み。<table>/<tr>/<td> を入れ子なしで
// 使っている (2026-09-27 の実ページで確認) ので、行単位・セル単位に区切ってから読む
// (ページ全体に1本の正規表現を掛けると、想定外の行をまたいで一致し、その行を
// 黙って読み飛ばしうる — 再検証で実際に再現した)。
const HTML_TABLE_RE = /<table\b[^>]*>([\s\S]*?)<\/table>/g;
const HTML_TR_RE = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
const HTML_TD_RE = /<td\b[^>]*>([\s\S]*?)<\/td>/g;
const LEADING_HREF_RE = /^<a href="([^"]+)"/;

/** 新様式ファイル名 (週次 2026-09-29〜: stock_1_w_YYYYMMDD_YYYYMMDD.pdf/.xlsx)。
 *  一覧ページ下部のサンプルファイルは "YYYYMMDD" の文字のままなので一致しない。
 *  資料の表の特定に使う (行の読解は UNIFIED_ROW_FILE_RE 側で行う)。 */
const WEEKLY_NEW_FORMAT_FILE_RE = /stock_1_w_\d{8}_\d{8}\.(?:xlsx|pdf)/;
/** 告知された新様式ファイル名 (月次 2026-10-08〜: stock_1_mYYYYMM.pdf/.xlsx)。
 *  サンプル (stock_1_mYYYYMM.*) は文字のままなので一致しない。 */
const MONTHLY_NEW_FORMAT_FILE_RE = /stock_1_m\d+\.(?:xlsx|pdf)/;

/** <table> 内の各行の <td> の中身 (前後空白除去) を返す。<th> だけの見出し行は除く。 */
function tableRowsCells(tableHtml: string): string[][] {
  const out: string[][] = [];
  for (const tr of tableHtml.matchAll(HTML_TR_RE)) {
    const cells = [...tr[1].matchAll(HTML_TD_RE)].map((td) => td[1].trim());
    if (cells.length > 0) out.push(cells);
  }
  return out;
}

function toAbsoluteUrl(href: string): string {
  return href.startsWith("http") ? href : `${BASE}${href}`;
}

// 旧様式の週次行: [日付ラベル, 株数PDF, 株数Excel, 金額PDF, 金額Excel]。
// 週コード (YYMMWW, 例 260902 = 2026年9月第2週) は4リンクで同一のはず。
const WEEKLY_LINK_CELLS: ReadonlyArray<{ re: RegExp; what: string }> = [
  { re: /stock_vol_1_(\d{6})\.pdf$/, what: "株数PDF" },
  { re: /stock_vol_1_(\d{6})\.xls$/, what: "株数Excel" },
  { re: /stock_val_1_(\d{6})\.pdf$/, what: "金額PDF" },
  { re: /stock_val_1_(\d{6})\.xls$/, what: "金額Excel" },
];

// 新様式の週次行: [日付ラベル, PDF, Excel, "-", "-"]。PDF/Excel は同じ週の
// 単一ファイル (stock_1_w_YYYYMMDD_YYYYMMDD.pdf/.xlsx、2026-09-29 掲載分から)。
const UNIFIED_ROW_FILE_RE = /stock_1_w_(\d{8})_(\d{8})\.(xlsx|pdf)$/;
// 行ラベル: "2026年9月第3週(9月14日～9月18日)" / "2026年9月第1週(8月31日～9月4日)"
const WEEKLY_ROW_LABEL_RE = /^(\d{4})年(\d{1,2})月第(\d)週\((\d{1,2})月(\d{1,2})日[～〜~](\d{1,2})月(\d{1,2})日\)$/;

/** ラベルの開始・終了を ISO 日付にする。開始月>終了月なら開始は前年 (年またぎの週)。 */
function weeklyRowLabelPeriod(label: string): { start: string; end: string } {
  const m = WEEKLY_ROW_LABEL_RE.exec(label.trim());
  if (!m) {
    throw new Error(`JPX 投資部門別売買状況 (週次一覧): 行の日付ラベルの様式が想定外です: "${label}"`);
  }
  const year = Number(m[1]);
  const startMonth = Number(m[4]);
  const startDay = Number(m[5]);
  const endMonth = Number(m[6]);
  const endDay = Number(m[7]);
  const startYear = startMonth > endMonth ? year - 1 : year;
  const start = `${startYear}-${pad2(startMonth)}-${pad2(startDay)}`;
  const end = `${year}-${pad2(endMonth)}-${pad2(endDay)}`;
  for (const [iso, what] of [[start, "開始日"], [end, "終了日"]] as const) {
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) {
      throw new Error(`JPX 投資部門別売買状況 (週次一覧): 「${label}」の${what}が暦日として不正です`);
    }
  }
  return { start, end };
}

/**
 * 週次一覧ページ (index.html) から、公表済みの週を新しい順に取り出す。
 * 2026-09-29 掲載分から新様式の単一 xlsx 行が先頭に載り、旧様式の4リンク行は
 * それ以前の週として残る (同じ表に混在する。2026-09-29 の実ページで確認)。
 * 次の場合は throw する (最新週を取り違えて古い週を黙って返さないため。ルール2):
 *   - 新旧いずれかの様式リンクを含む表が1つに定まらない
 *   - 表の中に「旧様式の4リンク行」「新様式の PDF/Excel 行」のどちらでもない行がある
 *   - 旧様式行: 1行の4リンクの週コードが揃っていない / 日付ラベルと週コードが別の週
 *   - 新様式行: PDF と Excel が別の週 / 日付ラベルの期間とファイル名の期間が一致しない /
 *     3セル目以降に "-" 以外の余分なセルがある
 *   - 新様式行が旧様式行より後に載っている (新様式は新しい週にだけ載るため)
 *   - 行が新しい順に並んでいない (latestWeeklyEntry の前提が崩れる)
 *   - 行が1件も無い
 */
export function parseWeeklyIndexHtml(html: string): WeeklyIndexEntry[] {
  const tables = [...html.matchAll(HTML_TABLE_RE)]
    .map((m) => m[1])
    .filter((t) => /stock_(?:vol|val)_1_\d+\.xls/.test(t) || WEEKLY_NEW_FORMAT_FILE_RE.test(t));
  if (tables.length !== 1) {
    throw new Error(
      `JPX 投資部門別売買状況 (週次一覧): 新旧いずれかの様式ファイルへのリンクを含む表が ${tables.length} 個あります ` +
        "(1個のはず)。ページ構造が変わった可能性があります。"
    );
  }

  const entries: WeeklyIndexEntry[] = [];
  // 新旧の並び順の検査用: 新様式行は開始日の降順・旧様式行は週コードの降順で、
  // 新様式行はすべて旧様式行より前 (新様式は新しい週だけに載るため)。
  const orderKeys: Array<{ kind: WeeklyIndexEntry["kind"]; key: number }> = [];
  for (const cells of tableRowsCells(tables[0])) {
    const rowText = cells.join(" | ");
    const label = cells[0];
    if (label === "" || label === undefined || label.includes("<")) {
      throw new Error(`JPX 投資部門別売買状況 (週次一覧): 行の日付ラベルが読めません: ${rowText.slice(0, 300)}`);
    }
    const isUnifiedLink = (cell: string | undefined): boolean => {
      if (cell === undefined) return false;
      const href = LEADING_HREF_RE.exec(cell)?.[1] ?? "";
      return UNIFIED_ROW_FILE_RE.test(href);
    };
    // 2・3セル目のどちらかが新様式リンクなら新様式行として読む (片方だけ "-" の
    // 未掲載・PDF/Excel の食い違いは parseUnifiedWeeklyRow 側で throw する)。
    const isUnifiedRow = cells.length >= 3 && (isUnifiedLink(cells[1]) || isUnifiedLink(cells[2]));
    if (isUnifiedRow) {
      const entry = parseUnifiedWeeklyRow(label, cells);
      entries.push(entry);
      // parse 成功時は cells[2] が単一 xlsx のリンクであることが確定している
      const startCode = UNIFIED_ROW_FILE_RE.exec(entry.unifiedXlsxUrl)?.[1] as string;
      orderKeys.push({ kind: "unified", key: Number(startCode) });
      continue;
    }
    const { entry, code } = parseLegacyWeeklyRow(label, cells, rowText);
    entries.push(entry);
    orderKeys.push({ kind: "legacy", key: Number(code) });
  }
  if (entries.length === 0) {
    throw new Error(
      "JPX 投資部門別売買状況 (週次一覧): 想定した行 (旧様式の4リンク行・新様式の単一ファイル行) が" +
        "見つかりません。ページ構造が変わった可能性があります。"
    );
  }
  let seenLegacy = false;
  for (let i = 0; i < orderKeys.length; i++) {
    const cur = orderKeys[i];
    if (cur.kind === "legacy") {
      seenLegacy = true;
    } else if (seenLegacy) {
      throw new Error(
        `JPX 投資部門別売買状況 (週次一覧): 新様式の行「${entries[i].label}」が旧様式の行より後にあります。` +
          "新様式は新しい週だけに載るはずで、順序が崩れています"
      );
    }
    if (i > 0 && cur.kind === orderKeys[i - 1].kind && cur.key >= orderKeys[i - 1].key) {
      throw new Error(
        `JPX 投資部門別売買状況 (週次一覧): 行が新しい週から順に並んでいません ` +
          `(${entries[i - 1].label} の次に ${entries[i].label})。先頭行=最新週の前提が崩れています`
      );
    }
  }
  return entries;
}

/** 新様式の週次行 ([日付ラベル, PDF, Excel] + "-" の空セル) を読む。 */
function parseUnifiedWeeklyRow(label: string, cells: string[]): WeeklyIndexEntryUnified {
  for (const [idx, what] of [[1, "PDF"], [2, "Excel"]] as const) {
    if (cells[idx].includes("-") && LEADING_HREF_RE.exec(cells[idx]) === null) {
      throw new Error(
        `JPX 投資部門別売買状況 (週次一覧): 「${label}」の新様式${what}が未掲載です ` +
          "(PDF と Excel は対で掲載されるはず)"
      );
    }
  }
  const hrefs = [1, 2].map((idx) => {
    const hrefMatch = LEADING_HREF_RE.exec(cells[idx]);
    const fileMatch = hrefMatch === null ? null : UNIFIED_ROW_FILE_RE.exec(hrefMatch[1]);
    if (hrefMatch === null || fileMatch === null) {
      throw new Error(
        `JPX 投資部門別売買状況 (週次一覧): 「${label}」のリンクが新様式の単一ファイル名ではありません: ${cells[idx].slice(0, 200)}`
      );
    }
    return { href: hrefMatch[1], start: fileMatch[1], end: fileMatch[2], ext: fileMatch[3] };
  });
  const [pdf, xlsx] = hrefs as [{ href: string; start: string; end: string; ext: string }, { href: string; start: string; end: string; ext: string }];
  if (pdf.ext !== "pdf" || xlsx.ext !== "xlsx") {
    throw new Error(
      `JPX 投資部門別売買状況 (週次一覧): 「${label}」の新様式行は [PDF, Excel] の順のはずです`
    );
  }
  if (pdf.start !== xlsx.start || pdf.end !== xlsx.end) {
    throw new Error(
      `JPX 投資部門別売買状況 (週次一覧): 「${label}」の PDF と Excel が別の週を指しています ` +
        `(${pdf.start}_${pdf.end} と ${xlsx.start}_${xlsx.end})`
    );
  }
  // 日付ラベルの期間 (例 "2026年9月第3週(9月14日～9月18日)" → 9/14〜9/18) と
  // ファイル名の期間 (stock_1_w_20260914_20260918) が一致することを確かめる。
  // 食い違うとラベル上は最新週なのに別の週のファイルを「最新」として取ってしまう。
  const labelPeriod = weeklyRowLabelPeriod(label);
  const fileStart = `${xlsx.start.slice(0, 4)}-${xlsx.start.slice(4, 6)}-${xlsx.start.slice(6, 8)}`;
  const fileEnd = `${xlsx.end.slice(0, 4)}-${xlsx.end.slice(4, 6)}-${xlsx.end.slice(6, 8)}`;
  if (labelPeriod.start !== fileStart || labelPeriod.end !== fileEnd) {
    throw new Error(
      `JPX 投資部門別売買状況 (週次一覧): 行の日付ラベル「${label}」の期間 (${labelPeriod.start}〜${labelPeriod.end}) と` +
        `リンクのファイル名の期間 (${fileStart}〜${fileEnd}) が一致しません`
    );
  }
  for (const extra of cells.slice(3)) {
    if (extra !== "-") {
      throw new Error(
        `JPX 投資部門別売買状況 (週次一覧): 「${label}」の新様式行に想定外のセルがあります: ${extra.slice(0, 200)}`
      );
    }
  }
  return { kind: "unified", label, unifiedXlsxUrl: toAbsoluteUrl(xlsx.href) };
}

/** 旧様式の週次行 ([日付ラベル, 株数PDF, 株数Excel, 金額PDF, 金額Excel]) を読む。 */
function parseLegacyWeeklyRow(
  label: string,
  cells: string[],
  rowText: string
): { entry: WeeklyIndexEntryLegacy; code: string } {
  if (cells.length !== 1 + WEEKLY_LINK_CELLS.length) {
    throw new Error(
      `JPX 投資部門別売買状況 (週次一覧): 旧様式の4リンク行・新様式の単一ファイル行のどちらでもない行があります: ${rowText.slice(0, 300)}`
    );
  }
  const rowCodes = new Set<string>();
  const urls = WEEKLY_LINK_CELLS.map(({ re, what }, idx) => {
    const hrefMatch = LEADING_HREF_RE.exec(cells[idx + 1]);
    const fileMatch = hrefMatch === null ? null : re.exec(hrefMatch[1]);
    if (hrefMatch === null || fileMatch === null) {
      throw new Error(
        `JPX 投資部門別売買状況 (週次一覧): 「${label}」の${what}のリンクが想定の名前ではありません: ${cells[idx + 1].slice(0, 200)}`
      );
    }
    rowCodes.add(fileMatch[1]);
    return toAbsoluteUrl(hrefMatch[1]);
  });
  if (rowCodes.size !== 1) {
    throw new Error(
      `JPX 投資部門別売買状況 (週次一覧): 「${label}」の4リンクの週コードが揃っていません (${[...rowCodes].join(", ")})`
    );
  }
  // 行の日付ラベル (例 "2026年9月第2週(…)") とリンクの週コード (例 260902) が同じ週を
  // 指していることを確かめる。食い違ったまま先頭行を採ると、ラベル上は最新週なのに
  // 1つ前の週のファイルを「最新」として取得してしまう (再検証で実ページの先頭行の
  // リンクを前週のものに差し替えて再現)。
  const code = [...rowCodes][0];
  const labelMatch = /^(\d{4})年(\d{1,2})月第(\d)週/.exec(label);
  const expectedCode =
    labelMatch === null
      ? null
      : `${labelMatch[1].slice(2)}${pad2(Number(labelMatch[2]))}${pad2(Number(labelMatch[3]))}`;
  if (expectedCode !== code) {
    throw new Error(
      `JPX 投資部門別売買状況 (週次一覧): 行の日付ラベル「${label}」とリンクの週コード (${code}) が一致しません`
    );
  }
  return { entry: { kind: "legacy", label, volumeXlsUrl: urls[1], valueXlsUrl: urls[3] }, code };
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

// 旧様式の月次表: 株数 (PDF行・Excel行)、金額 (PDF行・Excel行) の4行 × 1〜12月。
const MONTHLY_TABLE_ROWS: ReadonlyArray<{ metric: "vol" | "val"; ext: "pdf" | "xls"; label: string | null }> = [
  { metric: "vol", ext: "pdf", label: "株数" },
  { metric: "vol", ext: "xls", label: null },
  { metric: "val", ext: "pdf", label: "金額" },
  { metric: "val", ext: "xls", label: null },
];

/**
 * 月次一覧ページ (00-01.html) を解析する。当年 (ページ見出しの year) について
 * 1〜12月それぞれの公表有無を返す。JPX はまだ来ていない月をリンク無し ("-" 表示)
 * にする仕様なので、これがそのまま「まだ公表されていない」の判定になる
 * (カレンダー計算による推測はしない)。
 *
 * 「リンクが無い = 未公表」と言い切るため、表の全48セル (4行×12か月) が
 * 「"-"」か「その行・その月の旧様式ファイル (stock_{vol|val}_1_mYYMM.{pdf|xls}) への
 * リンク」のどちらかであることを確かめ、それ以外 (告知どおりの新様式ファイル
 * stock_1_m<数字> を含む) があれば throw する。新様式の月を「未公表」と誤認して
 * 1つ前の旧様式の月を最新として返さないため (ルール2)。
 */
export function parseMonthlyIndexHtml(html: string): MonthlyIndexEntry[] {
  const newFormat = MONTHLY_NEW_FORMAT_FILE_RE.exec(html);
  if (newFormat) {
    throw new Error(
      `JPX 投資部門別売買状況 (月次一覧): 新様式のファイル (${newFormat[0]}) が掲載されています。` +
        "旧様式のリンクだけを読むと最新月を取り違えるため停止します。月次新様式への対応が必要です。"
    );
  }
  const yearMatch = /<th class="w-space">(\d{4})年<\/th>/.exec(html);
  if (!yearMatch) {
    throw new Error(
      "JPX 投資部門別売買状況 (月次一覧): 年見出しが見つかりません (様式変更の可能性)"
    );
  }
  const year = Number(yearMatch[1]);
  const yy = String(year).slice(2);
  const tables = [...html.matchAll(HTML_TABLE_RE)].map((m) => m[1]).filter((t) => t.includes(yearMatch[0]));
  if (tables.length !== 1) {
    throw new Error(
      `JPX 投資部門別売買状況 (月次一覧): ${year}年の表が ${tables.length} 個あります (1個のはず。様式変更の可能性)`
    );
  }
  const rows = tableRowsCells(tables[0]);
  if (rows.length !== MONTHLY_TABLE_ROWS.length) {
    throw new Error(
      `JPX 投資部門別売買状況 (月次一覧): 表の行数が ${rows.length} です (株数PDF/株数Excel/金額PDF/金額Excel の4行のはず)`
    );
  }

  // 公表済みの月: PDF は月の集合だけ、Excel は取得に使う URL も持つ
  const links = {
    vol: { pdf: new Set<number>(), xls: new Map<number, string>() },
    val: { pdf: new Set<number>(), xls: new Map<number, string>() },
  };
  MONTHLY_TABLE_ROWS.forEach((spec, rowIdx) => {
    let monthCells = rows[rowIdx];
    if (spec.label !== null) {
      if (monthCells[0] !== spec.label) {
        throw new Error(
          `JPX 投資部門別売買状況 (月次一覧): ${rowIdx + 1}行目の見出しが "${spec.label}" ではありません: "${monthCells[0]}"`
        );
      }
      monthCells = monthCells.slice(1);
    }
    if (monthCells.length !== 12) {
      throw new Error(
        `JPX 投資部門別売買状況 (月次一覧): ${rowIdx + 1}行目の月セルが ${monthCells.length} 個です (12個のはず)`
      );
    }
    monthCells.forEach((cell, monthIdx) => {
      const month = monthIdx + 1;
      if (cell === "-") return; // 未公表
      const hrefMatch = LEADING_HREF_RE.exec(cell);
      const expected = new RegExp(`stock_${spec.metric}_1_m${yy}${pad2(month)}\\.${spec.ext}$`);
      if (hrefMatch === null || !expected.test(hrefMatch[1])) {
        throw new Error(
          `JPX 投資部門別売買状況 (月次一覧): ${year}年${month}月の${spec.metric === "vol" ? "株数" : "金額"}` +
            `${spec.ext === "pdf" ? "PDF" : "Excel"}欄が "-" でも旧様式ファイルへのリンクでもありません: ${cell.slice(0, 200)}`
        );
      }
      if (spec.ext === "pdf") {
        links[spec.metric].pdf.add(month);
      } else {
        links[spec.metric].xls.set(month, toAbsoluteUrl(hrefMatch[1]));
      }
    });
  });
  for (const metric of ["vol", "val"] as const) {
    const pdfMonths = [...links[metric].pdf].sort((a, b) => a - b).join(",");
    const xlsMonths = [...links[metric].xls.keys()].sort((a, b) => a - b).join(",");
    if (pdfMonths !== xlsMonths) {
      throw new Error(
        `JPX 投資部門別売買状況 (月次一覧): ${metric === "vol" ? "株数" : "金額"}の PDF (${pdfMonths}) と Excel (${xlsMonths}) で公表済みの月が一致しません`
      );
    }
  }
  const valMap = links.val.xls;
  const volMap = links.vol.xls;
  if (valMap.size === 0 && volMap.size === 0) {
    throw new Error(
      "JPX 投資部門別売買状況 (月次一覧): 月次ファイルへのリンクが1件も見つかりません (様式変更の可能性)"
    );
  }

  const entries: MonthlyIndexEntry[] = [];
  for (let month = 1; month <= 12; month++) {
    const valueXlsUrl = valMap.get(month);
    const volumeXlsUrl = volMap.get(month);
    entries.push({
      year,
      month,
      // Map に無い = 表のセルが "-" (未公表) であることを上で確認済み。null はその事実の表現
      valueXlsUrl: valueXlsUrl === undefined ? null : valueXlsUrl,
      volumeXlsUrl: volumeXlsUrl === undefined ? null : volumeXlsUrl,
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

/** 1つのバッチ (同じ週/月の 金額ファイル + 株数ファイル) のレコードが、全件同じ期間で
 *  あることを確かめる。食い違えば先頭の1件を代表値として採らず throw する。 */
function assertSinglePeriod(
  records: readonly InvestorEquityRecord[],
  periodType: InvestorEquityPeriodType
): InvestorEquityRecord {
  const first = records[0];
  if (!first) {
    throw new Error("JPX 投資部門別売買状況: レコードが空です");
  }
  const signature = (r: InvestorEquityRecord): string =>
    `${r.periodType}|${r.periodLabel}|${r.periodMonth}|${r.periodStart}|${r.periodEnd}|${r.formatVersion}`;
  if (first.periodType !== periodType) {
    throw new Error(`JPX 投資部門別売買状況: ${periodType} のはずが ${first.periodType} のファイルでした`);
  }
  const mismatched = records.find((r) => signature(r) !== signature(first));
  if (mismatched) {
    throw new Error(
      `JPX 投資部門別売買状況: 1バッチ内で期間が食い違っています (${signature(first)} と ${signature(mismatched)})`
    );
  }
  return first;
}

/**
 * 金額ファイルと株数ファイルのレコードを1バッチにまとめる純関数 (旧様式用。
 * 新様式は単一ファイルに金額・株数の両方を含むため merge 不要で、
 * 単一期間の確認は `assertSinglePeriod` を直接使う)。金額側が全件
 * metric="value"・株数側が全件 metric="volume"・両方が同じ期間であることを確かめ、
 * 違えば throw する (リンクの取り違えで株数を金額として保存しないため)。
 * 取込 CLI が保管済みファイルから観測を作り直すときも、この関数を通す。
 */
export function mergeValueAndVolumeRecords(
  valueRecords: readonly InvestorEquityRecord[],
  volumeRecords: readonly InvestorEquityRecord[],
  periodType: InvestorEquityPeriodType
): InvestorEquityRecord[] {
  if (valueRecords.length === 0 || valueRecords.some((r) => r.metric !== "value")) {
    throw new Error("JPX 投資部門別売買状況: 金額ファイルのはずが金額 (value) 以外のレコードを含むか空です");
  }
  if (volumeRecords.length === 0 || volumeRecords.some((r) => r.metric !== "volume")) {
    throw new Error("JPX 投資部門別売買状況: 株数ファイルのはずが株数 (volume) 以外のレコードを含むか空です");
  }
  const merged = [...valueRecords, ...volumeRecords];
  assertSinglePeriod(merged, periodType);
  return merged;
}

export interface FetchedInvestorEquityLegacy {
  kind: "legacy";
  periodType: InvestorEquityPeriodType;
  /** 取得元 URL (アーカイブ入力・来歴用) */
  valueUrl: string;
  volumeUrl: string;
  valueBytes: Uint8Array;
  volumeBytes: Uint8Array;
  records: InvestorEquityRecord[];
}

export interface FetchedInvestorEquityUnified {
  kind: "unified";
  periodType: InvestorEquityPeriodType;
  /** 取得元 URL (アーカイブ入力・来歴用) */
  unifiedUrl: string;
  unifiedBytes: Uint8Array;
  records: InvestorEquityRecord[];
}

/** 1 週 (旧様式は金額+株数の2ファイル、新様式は単一ファイル) の取得結果。 */
export type FetchedInvestorEquity = FetchedInvestorEquityLegacy | FetchedInvestorEquityUnified;

/**
 * 最新の週次ファイルを解決して取得する。旧様式の週は金額 xls + 株数 xls の2本、
 * 新様式の週 (2026-09-29 掲載分から) は単一 xlsx の1本を取る。
 */
export async function fetchLatestJpxInvestorEquityWeekly(): Promise<FetchedInvestorEquity> {
  const html = await fetchText(WEEKLY_INDEX_URL);
  const entries = parseWeeklyIndexHtml(html);
  const latest = latestWeeklyEntry(entries);

  if (latest.kind === "unified") {
    const unifiedBytes = await fetchBytes(latest.unifiedXlsxUrl);
    const records = parseInvestorEquityWorkbook(unifiedBytes, urlBasename(latest.unifiedXlsxUrl));
    assertSinglePeriod(records, "weekly");
    return {
      kind: "unified",
      periodType: "weekly",
      unifiedUrl: latest.unifiedXlsxUrl,
      unifiedBytes,
      records,
    };
  }

  const [valueBytes, volumeBytes] = await Promise.all([
    fetchBytes(latest.valueXlsUrl),
    fetchBytes(latest.volumeXlsUrl),
  ]);

  const records = mergeValueAndVolumeRecords(
    parseInvestorEquityWorkbook(valueBytes, urlBasename(latest.valueXlsUrl)),
    parseInvestorEquityWorkbook(volumeBytes, urlBasename(latest.volumeXlsUrl)),
    "weekly"
  );

  return {
    kind: "legacy",
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
  const valueXlsUrl = latest.valueXlsUrl;
  const volumeXlsUrl = latest.volumeXlsUrl;
  if (valueXlsUrl === null || volumeXlsUrl === null) {
    // pickLatestPublishedMonth が保証しているので到達しない。型の絞り込みを明示するための検査
    throw new Error(`JPX 投資部門別売買状況 (月次): ${latest.year}年${latest.month}月のファイル URL が揃っていません`);
  }

  const [valueBytes, volumeBytes] = await Promise.all([
    fetchBytes(valueXlsUrl),
    fetchBytes(volumeXlsUrl),
  ]);

  const records = mergeValueAndVolumeRecords(
    parseInvestorEquityWorkbook(valueBytes, urlBasename(valueXlsUrl)),
    parseInvestorEquityWorkbook(volumeBytes, urlBasename(volumeXlsUrl)),
    "monthly"
  );
  if (records[0].periodMonth !== `${latest.year}-${pad2(latest.month)}`) {
    throw new Error(
      `JPX 投資部門別売買状況 (月次): 一覧ページの ${latest.year}年${latest.month}月 のリンク先ファイルが ` +
        `${records[0].periodLabel} 分でした (一覧とファイルの食い違い)`
    );
  }

  return {
    kind: "legacy",
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

/**
 * ルール6 の `recordPrimaryData()` に渡す入力を組み立てる純関数。
 * 冪等キー: `jpx-investor-equity-weekly-<期間終了日 YYYY-MM-DD>` /
 * `jpx-investor-equity-monthly-<JPX の帰属年月 YYYY-MM>`。
 * 月次は periodStart の月を使ってはいけない (JPX の月次は週単位で区切るため、例えば
 * 2026年9月分は 8/31 から始まり、開始日の月を使うと8月分と同じキーになって9月分が
 * 「保管済み」として黙って捨てられる)。期間が確定しない (新様式でファイル名から
 * 日付が取れない) レコードは、別表記のキーで保管せず throw する。
 */
export function jpxInvestorEquityArchiveInput(
  fetched: FetchedInvestorEquity
): JpxInvestorEquityArchiveInput {
  const first = assertSinglePeriod(fetched.records, fetched.periodType);
  let keyPeriod: string;
  if (fetched.periodType === "weekly") {
    if (first.periodEnd === null) {
      throw new Error(
        `jpxInvestorEquityArchiveInput: ${first.periodLabel} の期間終了日が不明です (ファイル名から復元できない)。冪等キーを作れません`
      );
    }
    keyPeriod = first.periodEnd;
  } else {
    keyPeriod = first.periodMonth;
  }
  const metadata = {
    periodType: fetched.periodType,
    periodLabel: first.periodLabel,
    periodMonth: first.periodMonth,
    periodStart: first.periodStart,
    periodEnd: first.periodEnd,
    recordCount: fetched.records.length,
    formatVersion: first.formatVersion,
  };
  const key = `jpx-investor-equity-${fetched.periodType}-${keyPeriod}`;
  if (fetched.kind === "unified") {
    const unifiedFilename = urlBasename(fetched.unifiedUrl);
    return {
      service: "moneyflow",
      key,
      source: fetched.unifiedUrl,
      metadata,
      files: [
        {
          bytes: fetched.unifiedBytes,
          filename: `investor-equity-unified-${unifiedFilename}`,
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      ],
    };
  }
  const valueFilename = urlBasename(fetched.valueUrl);
  const volumeFilename = urlBasename(fetched.volumeUrl);
  const contentType = valueFilename.endsWith(".xlsx")
    ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    : "application/vnd.ms-excel";

  return {
    service: "moneyflow",
    key,
    source: `${fetched.valueUrl} , ${fetched.volumeUrl}`,
    metadata,
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
  "禁止。kabulabでは非公開のNotionページにのみ保存し、公開Webには出さない " +
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
      "の手元から日本株へ3000億円分のお金が向かったとみなせる。ただし取引には必ず売り手が" +
      "いるので、ほぼ同じ額をほかの部門(個人など)が売り越しており、市場全体にお金が" +
      "増えたという意味ではない。",
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
      "内国普通株式が対象でETF/REIT/優先株式等は含まない。ToSTNeT(立会外)取引を含む。" +
      "33業種別の内訳は存在しない" +
      "(市場区分別のみ)。週次は2026-09-29公表分から単一ファイルの新様式になり、" +
      "実ファイル(2026年9月第3週分)で検証済み。月次の新様式(2026-10-08公表分〜)は" +
      "未公表のため未対応。",
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
      "上と同じ買い越し/売り越しを、金額ではなく株数(千株単位)で見たもの。株価が高い株" +
      "(値嵩株)と安い株(低位株)では同じ株数でも金額が大きく違うため、金額版と併せて見る。",
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
  "週次は 2026-09-29 掲載分から単一ファイルの新様式になった。新様式パーサは実ファイル" +
    "(stock_1_w_20260914_20260918.xlsx、2026年9月第3週 9/14〜9/18 分) で検証済み:" +
    " 単位は見出しどおり千株/千円、112レコード全件で 買い-売り=差引・売り+買い=合計が" +
    "一致、桁の検査も通過。JPX公式サンプル (stock_1_w_YYYYMMDD_YYYYMMDD.xlsx、" +
    "ファイル名未置換=実データではない仕様サンプル) は値が円/株単位のままのため" +
    "桁の検査で throw する。",
  "新様式ではファイル名 (stock_1_w_YYYYMMDD_YYYYMMDD.xlsx) から期間の開始日・終了日を" +
    "取得する設計。サンプルファイルはプレースホルダ名のため periodStart/periodEnd は" +
    "null になる (捏造しない)。",
  "週次の「まだ公表されていない」は一覧ページに行が無いことでのみ判定する" +
    "(カレンダー/祝日推定はしない)。月次は年間テーブルのセルが空(ハイフン表示)であることで判定。",
  "月次一覧ページは当年の1テーブルのみ解析対象。年またぎ (12月→翌1月) の過去年" +
    "アーカイブページ (00-01-archives-*.html) の解析は未対応。",
  "週次の様式変更 (2026-09-29) とは別に、月次一覧ページ (00-01.html) には " +
    "2026-10-08 掲載分から月次ファイルを株数/金額の2ファイルから1ファイルに統合し、" +
    "ファイル名も stock_1_mYYYYMM.xlsx に変える予告が掲載されている (JPX公式サンプル " +
    "stock_1_mYYYYMM.xlsx で確認済み)。サンプルはヘッダ行が「年月」(コード YYYYMM) で" +
    "ある以外は週次新様式と同じ列構成だが、parseUnifiedSheet (週次新様式用) はヘッダ行を" +
    "検知できず throw する (月次専用の新様式パーサは未実装)。取込経路では、一覧ページに" +
    "stock_1_m<数字> のリンクが載った時点で parseMonthlyIndexHtml が throw する" +
    "(旧様式の前月を最新として黙って返さない)。10/8以降、実ページ・実ファイルでの" +
    "月次新様式対応が必須。",
  "週次一覧ページは新旧の行が同じ表に混在する (2026-09-29 の実ページで確認。新様式行が" +
    "先頭側)。新様式行は [日付ラベル, PDF, Excel] (+ 空セルは \"-\" のみ) を読み、PDF と" +
    " Excel が同じ週・日付ラベルの期間とファイル名の期間が一致することを確かめる。" +
    "新様式行が旧様式行より後に載る・同形式内で新しい順でない・想定外の行があれば" +
    " throw する (最新週の取り違え防止)。行ラベルの「第n週」の数字自体の妥当性" +
    " (JPX の週番号付け規則) は検証していない — 期間はラベルの日付範囲とファイル名で" +
    "確定させる。",
  "JPX公式サンプル (週次・月次とも) の数値は、見出しの単位「千株/千円」で読むと実データ" +
    "(旧様式の同じ市場の総計) の約900〜1100倍の桁になる (例: 週次サンプルのプライム14部門の" +
    "売り合計 42,220,588,401,000 を千円で読むと約4京円。旧様式実ファイル 2026年9月第2週の" +
    "プライム総計の売りは 47,799,720,998 千円 ≒ 47.8兆円)。サンプルの値が円/株単位で" +
    "作られている (サンプルの全数値セルが1000の倍数) 。新様式パーサは見出しの単位表記に" +
    "従い千株/千円として扱うが、1セル (1市場×1部門×1期間の売り/買い/合計) が 2,000兆円" +
    "(2e12千円) / 2兆株 (2e9千株) を超えたら単位の取り違えとして throw する — そのため" +
    "JPX公式サンプルそのものは throw する。実ファイル (2026年9月第3週分) では全セルが" +
    "上限内で桁の検査を通過した。なお新旧は公表週が重ならないため旧様式の同じ週の総計と" +
    "の直接突合はできず、単位の裏付けは新様式ファイル内の見出し・算術一致と同期間の" +
    "新様式 PDF の突合による (旧ファイルの値への倍率合わせはしない)。",
  "旧様式の期間表題は「タイトルの月 = 期間終了日の月」を前提に検証している " +
    "(実ファイルで確認できたのは 2026年9月第1週 = 8/31〜9/4 のみ)。終了日が翌月に入る" +
    "週 (例: 9/28〜10/2) を JPX がどちらの月に帰属させるかは未確認で、そのような表題は" +
    "throw する。月次新様式の初回が 2026-10-08 掲載 (= 前月最終週の週次と同日) である" +
    "ことからは 9/28〜10/2 が9月扱いである可能性があり、過去の旧様式ファイルを" +
    "バックフィルする際は実ファイルで確認すること。",
  "旧様式の主表のみを読む。表下の「個人・自己の現金/信用の内訳」「海外投資家の法人/" +
    "個人の内訳」は読んでいない。新様式はこの内訳 (自己現金/自己信用/個人現金/個人信用/" +
    "海外投資家法人/海外投資家個人) を列として持ち、逆に自己計/委託計/総計/法人/金融機関/" +
    "個人/海外投資家の行は無い。両様式で名前が同じ8部門 (証券会社・投資信託・事業法人・" +
    "その他法人等・生保・損保・都銀・地銀等・信託銀行・その他金融機関) は JPX の定義が同一" +
    "のため同じ系列として扱い、それ以外の新旧の系列は名前が違うため混ざらない" +
    " (2026-09-29 の user 決定: 旧系列へ無言合流しない。旧方式の互換・移行は要件外)。",
  "投資部門別の内訳は東証33業種別には存在しない (JPX公式統計としてそもそも提供されて" +
    "いない粒度)。R1(33業種)の主指標ではなく補足指標として使う設計。",
  "集計対象は資本金30億円以上の取引参加者経由の取引のみ (JPX注記)。全取引の網羅では" +
    "ない。",
];
