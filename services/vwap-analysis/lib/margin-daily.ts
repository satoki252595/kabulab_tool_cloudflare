/**
 * JPX 信用残高 (日次・2026-09-29 公表分〜の `YYYYMMDD_mtall.pdf`) の純粋パーサ。
 *
 * 週次版 (`margin.ts` の `parseMarginText`・4 数字) とは別契約。週次 PDF の公表は
 * 廃止されたため、通常の取込・API・UI はこの日次スキーマだけを使う (旧互換なし)。
 *
 * 1 銘柄 = 株数行 + 金額行。各行は原文のまま 14 セル。公式見出しの
 * センサス (2026-09-28 分の全ページ。株数/金額ブロック共通):
 *   0 売残高 Outstanding Sales (株|円) / 1 前日比 Daily change / 2 上場比 Ratio to listed shares (%)
 *   3 買残高 Outstanding Purchases / 4 前日比 / 5 上場比
 *   6 一般信用 Negotiable / 7 前日比 / 8 制度信用 Standardized / 9 前日比 (売残側)
 *   10 一般信用 Negotiable / 11 前日比 / 12 制度信用 Standardized / 13 前日比 (買残側)
 * すなわち 12 数値系 + 2 率系 = 14 列。「14数値+2比率」(16列) ではない。
 * 一般信用/制度信用の売買対応は見出しが裸 (売買の区別なし) のため、一般+制度=総計
 * の exact 照合 (全 8518 行で成立確認) で位置意味を確定している。架空列は無い。
 * 金額行の上場比は常に `-`。前日比 `-` セル (2026-09-28 分は 643A0/644A0 の
 * 12 セル) と上場比 `*` セル (受益証券の全 464 行・投資証券の 19 行・14900) は
 * 値なしとして `null` + 原文セル保持し、`0` にしない — ルール2。`-`/`*` の意味の
 * 推測 (新規・対象外等の断定) はしない (単位注記「一株、一円」も検証)。
 *
 * 検証は合計で閉じる: 一般+制度=総計 (全行 exact)、市場小計=分類合計=総合計、
 * 明細行数=総合計件数、明細残高和=総合計。null 混じりの合計突合は未知として STOP
 * し、0 扱いで一致させない。明細の前日比和は合計突合の対象外 (観測事実と理由は
 * validateDailyMarginSnapshot の注記。原因の断定・0 補完はしない)。
 * 1 つでも外れたら throw する (部分保存しない — ルール2)。
 *
 * このモジュールは純関数のみ (unpdf・fetch 非依存) で、Worker (app.ts) からも
 * import できる。取得・テキスト抽出は `margin.ts` の日次関数が行う。
 */
import { sourceCodeToTicker } from "../../../src/shared/jpx/stock-code.js";

/** 日次スナップショットの形式タグ。様式が変わったら上げる (推測で読まない)。 */
export const MARGIN_DAILY_FORMAT = "jpx-margin-daily-v1";

/** 株数行・金額行のセル数 (12 数値系 + 2 率系)。 */
export const MARGIN_DAILY_CELLS = 14;

/** 原文注記にある売買単位の字母 (A=1株 J=10株 K=50株 B=100株 M=200株 C=500株 T=1000株 F=3000株)。 */
const UNIT_LETTERS = new Set(["A", "J", "K", "B", "M", "C", "T", "F"]);

/** 市場区分 (原文表記)。 */
const MARKETS = ["プライム", "スタンダード", "グロース", "投信等"] as const;

/** 貸借区分 (原文の1文字)。 */
const LOAN_KINDS = new Set(["貸", "制", "他"]);

/**
 * 銘柄種別 (原文表記)。2026-09-28 分の実測で確認したものだけを列挙する。
 * 未知の種別は黙って銘柄名へ溶かさず throw する (ルール2)。
 */
const SECTYPES = [
  "普通株式",
  "社債型種類株式",
  "第１種優先株式",
  "受益証券",
  "投資証券",
  "優先出資証券",
  "ＪＤＲ",
];

/** 合計行の和文ラベル → 対応する英文ラベル (金額行の突合用)。 */
const TOTAL_LABEL_PAIRS: ReadonlyMap<string, string> = new Map([
  ["貸借銘柄", "loan trading issue"],
  ["制度信用銘柄", "standardized margin trading issue"],
  ["その他", "other issues"],
  ["総合計", "total"],
  ["プライム 小計", "Prime sub-total"],
  ["スタンダード 小計", "Standard sub-total"],
  ["グロース 小計", "Growth sub-total"],
  ["投信等 小計", "Investment trusts sub-total"],
]);

/** 株数・金額それぞれ 12 数値 + 2 率 (+ 率の原文セル)。 */
export interface MarginDailyFigures {
  /** 売残高 (株|円)。 */
  sellOutstanding: number;
  /** 売前日比。`-` (未公表) は null。 */
  sellChg: number | null;
  /** 売上場比 (百分率の値。`0.1%` → 0.1)。`*`/`-` は null。 */
  sellListedRatio: number | null;
  /** 売上場比の原文セル (`0.1%` / `*` / `-`)。 */
  sellListedRatioRaw: string;
  buyOutstanding: number;
  buyChg: number | null;
  buyListedRatio: number | null;
  buyListedRatioRaw: string;
  /** 一般信用 (Negotiable) 売残・売前日比・買残・買前日比。 */
  negSell: number;
  negSellChg: number | null;
  negBuy: number;
  negBuyChg: number | null;
  /** 制度信用 (Standardized) 売残・売前日比・買残・買前日比。 */
  stdSell: number;
  stdSellChg: number | null;
  stdBuy: number;
  stdBuyChg: number | null;
}

export interface MarginDailyRow {
  /** 原文の5文字コード (例 `13010`・`130A0`・`50765`)。 */
  sourceCode: string;
  /** 原文の和文銘柄名。 */
  name: string;
  /**
   * 適格判定用の普通株ティッカー。末尾 `0` の 5 文字 → 先頭 4 文字
   * (`sourceCodeToTicker` と同一規則)。種類株等は null。
   */
  ordinaryTicker: string | null;
  /**
   * 取引 ok/ng = 原本内在の普通株フラグ。`ordinaryTicker !== null &&
   * sectype === "普通株式"` のときだけ true。非普通株・不明は raw 明細を保持した
   * まま false。銘柄マスタ (activeEq) との突合による真の集計適格は writer/reader
   * 側で既存述語 (WITH/ON) により判定する (この純粋層では銘柄値を読まない)。
   */
  eligible: boolean;
  /** 売買単位の字母 (原文)。 */
  unitLetter: string;
  /** 銘柄種別 (原文)。原文欠落 (14900 の実測) は null で明示する。 */
  sectype: string | null;
  /** 市場区分 (原文)。 */
  market: string;
  /** 貸借区分 (原文の1文字: 貸/制/他)。 */
  loanKind: string;
  /** ISIN 等 (原文にある場合のみ。なければ null)。 */
  isin: string | null;
  /** 株数行の 14 セル (単位: 株・率)。 */
  shares: MarginDailyFigures;
  /** 金額行の 14 セル (単位: 円。率は常に null・raw `-`)。 */
  amounts: MarginDailyFigures;
}

export type MarginDailyTotalScope = "loan" | "standardized" | "other" | "grand";

export interface MarginDailyTotal {
  /** 和文ラベル (原文。例 `貸借銘柄`・`プライム 小計`)。 */
  label: string;
  scope: MarginDailyTotalScope;
  /** 市場小計の市場 (原文)。分類合計行は null。 */
  market: string | null;
  /** 対象銘柄数。 */
  count: number;
  shares: MarginDailyFigures;
  amounts: MarginDailyFigures;
}

export interface MarginDailySnapshot {
  format: typeof MARGIN_DAILY_FORMAT;
  /** 申込み現在日 (基準日。YYYY-MM-DD)。 */
  basisDate: string;
  /** 公表日 (YYYY-MM-DD)。 */
  publicationDate: string;
  /** 取得元 PDF の URL。 */
  sourceUrl: string;
  /** PDF バイト列の SHA-256 (hex)。 */
  rawSha256: string;
  /** 一次データ保管の Notion ページ ID。保管前は null。 */
  rawPageId: string | null;
  rows: MarginDailyRow[];
  totals: MarginDailyTotal[];
}

function fail(msg: string): never {
  throw new Error(`margin-daily: ${msg}`);
}

/** 3桁区切り整数の厳密検証 (`1,2`・`1,,2`・末尾カンマを拒否) + 安全整数。 */
function toSafeInt(grouped: string, where: string): number {
  if (!/^\d{1,3}(,\d{3})*$/.test(grouped)) {
    fail(`${where} が整数(3桁区切り)ではありません: ${grouped.slice(0, 40)}`);
  }
  const v = Number(grouped.replace(/,/g, ""));
  if (!Number.isSafeInteger(v)) fail(`${where} が安全整数を超えています: ${grouped.slice(0, 40)}`);
  return v;
}

function toIntStrict(raw: string, where: string): number {
  return toSafeInt(raw, `${where}`);
}

/** 合計行の銘柄数。原文はカンマ無し (`2670`) のため4桁までの素朴数字も許す。 */
function toCountStrict(raw: string, where: string): number {
  if (!/^(\d{1,4}|\d{1,3}(,\d{3})+)$/.test(raw)) {
    fail(`${where} が件数ではありません: ${raw.slice(0, 40)}`);
  }
  const v = Number(raw.replace(/,/g, ""));
  if (!Number.isSafeInteger(v)) fail(`${where} が安全整数を超えています: ${raw.slice(0, 40)}`);
  return v;
}

/** 前日比セル: `-` → null、`▲1,000` → -1000、`1,000` → 1000。 */
function parseChg(raw: string, where: string): number | null {
  if (raw === "-") return null;
  const neg = raw.startsWith("▲");
  const body = neg ? raw.slice(1) : raw;
  const v = toSafeInt(body, `${where} の前日比`);
  return neg ? -v : v;
}

/** 上場比セル: `*`/`-` → null、`0.1%` → 0.1 (百分率の値のまま)。 */
function parseRatio(raw: string, where: string): number | null {
  if (raw === "*" || raw === "-") return null;
  if (!/^[0-9]+(\.[0-9]+)?%$/.test(raw)) fail(`${where} の上場比が不正です: ${raw.slice(0, 40)}`);
  const v = Number(raw.slice(0, -1));
  if (!Number.isFinite(v)) fail(`${where} の上場比が数値ではありません: ${raw.slice(0, 40)}`);
  return v;
}

/** 14 セル → MarginDailyFigures。位置と文法を厳密に検証する。 */
function parseFigures(cells: readonly string[], where: string): MarginDailyFigures {
  if (cells.length !== MARGIN_DAILY_CELLS) {
    fail(`${where} のセル数が ${cells.length} です (14 が必要): ${cells.join(" ").slice(0, 120)}`);
  }
  const [c0, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12, c13] = cells as [
    string, string, string, string, string, string, string,
    string, string, string, string, string, string, string,
  ];
  return {
    sellOutstanding: toIntStrict(c0, where),
    sellChg: parseChg(c1, where),
    sellListedRatio: parseRatio(c2, where),
    sellListedRatioRaw: c2,
    buyOutstanding: toIntStrict(c3, where),
    buyChg: parseChg(c4, where),
    buyListedRatio: parseRatio(c5, where),
    buyListedRatioRaw: c5,
    negSell: toIntStrict(c6, where),
    negSellChg: parseChg(c7, where),
    stdSell: toIntStrict(c8, where),
    stdSellChg: parseChg(c9, where),
    negBuy: toIntStrict(c10, where),
    negBuyChg: parseChg(c11, where),
    stdBuy: toIntStrict(c12, where),
    stdBuyChg: parseChg(c13, where),
  };
}

/**
 * 一般+制度=総計 (残高2組 exact。前日比は 3 値揃う組だけ exact。null 混じりの組は
 * 未知として素通りさせ (0 扱いにせず)、欠損 raw は null のまま保持する)。
 */
function assertBreakdown(fig: MarginDailyFigures, where: string): void {
  const pairs: [number, number, number, string][] = [
    [fig.sellOutstanding, fig.negSell, fig.stdSell, "売残高"],
    [fig.buyOutstanding, fig.negBuy, fig.stdBuy, "買残高"],
  ];
  for (const [total, neg, std, name] of pairs) {
    if (total !== neg + std) fail(`${where} の${name}内訳が合いません: ${total} != ${neg}+${std}`);
  }
  const chgPairs: [number | null, number | null, number | null, string][] = [
    [fig.sellChg, fig.negSellChg, fig.stdSellChg, "売前日比"],
    [fig.buyChg, fig.negBuyChg, fig.stdBuyChg, "買前日比"],
  ];
  for (const [total, neg, std, name] of chgPairs) {
    if (total !== null && neg !== null && std !== null && total !== neg + std) {
      fail(`${where} の${name}内訳が合いません: ${total} != ${neg}+${std}`);
    }
  }
}

const DATE_LINE_RE =
  /^(\d{4})\/(\d{1,2})\/(\d{1,2}) 申込み現在 .* （単位：一株、一円） (\d{4})\/(\d{1,2})\/(\d{1,2})$/;
const EN_DATE_RE = /^As of (\d{4})\/(\d{1,2})\/(\d{1,2}) application based\b/;

/**
 * 公式 14 列見出しの原文シーケンス (2026-09-28 分の全 109 ページで同一を確認。
 * キャッシュ: /tmp 1795979B SHA 7a0c2e21…12ce314 の pure replay)。
 * 位置固定の parseFigures (c0–c13) と 1 対 1 に対応する:
 *  売残高/前日比/上場比/買残高/前日比/上場比/
 *  一般(売)/前日比/制度(売)/前日比/一般(買)/前日比/制度(買)/前日比。
 * 数量 12 (残高6+前日比6) + 比率 2 (上場比)。単位は日付行の
 * （単位：一株、一円）で固定 (DATE_LINE_RE が検証)。列交換は合計ガードでは
 * 見逃すため、入口で厳密一致を要求する。
 */
const DAILY_MARGIN_HEADER_LINES: readonly string[] = [
  "売残高", "Outstanding Sales",
  "前日比", "Daily change",
  "上場比", "Ratio to", "listed shares",
  "買残高", "Outstanding", "Purchases",
  "前日比", "Daily change",
  "上場比", "Ratio to", "listed shares",
  "一般信用", "Negotiable",
  "前日比", "Daily change",
  "制度信用", "Standardized",
  "前日比", "Daily change",
  "一般信用", "Negotiable",
  "前日比", "Daily change",
  "制度信用", "Standardized",
  "前日比", "Daily change",
];
/** 売グループ→買グループの順序を固定する組見出し (全ページに同一行)。 */
const DAILY_MARGIN_GROUP_LINE = "合計 Total 売残高 Outstanding Sales 買残高 Outstanding Purchases";

/**
 * 公式列見出しの厳密検証 (parseDailyMarginText の入口で呼ぶ)。
 * `売残高` で始まる箇所はすべて 31 行シーケンスと厳密一致が必須
 * (1 箇所でも崩れたら列位置が変わっている可能性のため STOP)。
 */
export function assertDailyMarginHeaders(text: string): void {
  const lines = text.split("\n").map((l) => l.trim());
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (l === "売残高") starts.push(i);
  });
  if (starts.length === 0) fail("日次信用残の公式列見出し (売残高…) が見つかりません");
  for (const s of starts) {
    for (let k = 0; k < DAILY_MARGIN_HEADER_LINES.length; k++) {
      const got = s + k < lines.length ? (lines[s + k] as string) : "(なし)";
      if (got !== DAILY_MARGIN_HEADER_LINES[k]) {
        fail(
          `公式列見出しの不一致です (行 ${s + k + 1}: ${got} — 列位置が変わっている可能性のため STOP)`
        );
      }
    }
  }
  const firstRow = lines.findIndex((l) => l.includes("株数 Shs."));
  if (firstRow >= 0 && (starts[0] as number) > firstRow) {
    fail("公式列見出しが最初の明細行より後にあります");
  }
  if (!lines.includes(DAILY_MARGIN_GROUP_LINE)) {
    fail(`売買グループ見出しが見つかりません: ${DAILY_MARGIN_GROUP_LINE}`);
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function toISODate(y: string, m: string, d: string, where: string): string {
  const yi = Number(y);
  const mi = Number(m);
  const di = Number(d);
  const iso = `${y}-${pad2(mi)}-${pad2(di)}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) fail(`${where} の日付が不正です: ${y}/${m}/${d}`);
  // 暦に無い日付 (2026/2/30 等) を拒否する (Date.UTC 往復検査)。
  const round = new Date(Date.UTC(yi, mi - 1, di));
  if (round.getUTCFullYear() !== yi || round.getUTCMonth() !== mi - 1 || round.getUTCDate() !== di) {
    fail(`${where} の日付が暦にありません: ${y}/${m}/${d}`);
  }
  return iso;
}

/** 全ページの日付行から基準日・公表日を取る (全行一致が必須。単位注記も検証)。 */
export function parseDailyMarginDates(text: string): { basisDate: string; publicationDate: string } {
  const found = new Set<string>();
  for (const line of text.split("\n")) {
    const m = DATE_LINE_RE.exec(line.trim());
    if (m) found.add(`${m[1]}/${m[2]}/${m[3]}|${m[4]}/${m[5]}/${m[6]}`);
  }
  if (found.size === 0) fail("日付行 (申込み現在…単位：一株、一円…公表日) が見つかりません");
  if (found.size > 1) fail(`日付行がページ間で不一致です: ${[...found].join(" / ").slice(0, 120)}`);
  const [[b, p]] = [...found].map((s) => s.split("|") as [string, string]);
  const [by, bm, bd] = b.split("/");
  const [py, pm, pd] = p.split("/");
  const basisDate = toISODate(by, bm, bd, "基準日");
  const publicationDate = toISODate(py, pm, pd, "公表日");
  for (const line of text.split("\n")) {
    const m = EN_DATE_RE.exec(line.trim());
    if (m && `${m[1]}-${pad2(Number(m[2]))}-${pad2(Number(m[3]))}` !== basisDate) {
      fail(`英文 As of 日が基準日と不一致です: ${line.trim().slice(0, 60)}`);
    }
  }
  return { basisDate, publicationDate };
}

const SHS_ROW_RE =
  /^([A-Z]) (.+) ([貸制他]) (\d{3}[0-9A-Z]\d) ([A-Z]{2}[A-Z0-9]{10}) 株数 Shs\. (.*)$/;
const VAL_ROW_RE = /^(.*) (\d{3}[0-9A-Z]\d) ([A-Z]{2}[A-Z0-9]{10}) 金額 Val\. (.*)$/;

/** `▲ 1,000` の分かれを結合してセル分割する。 */
function splitCells(segment: string): string[] {
  return segment
    .replace(/▲\s+/g, "▲")
    .split(" ")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 株数行の中央部 (銘柄名+種別+市場) を右から切り分ける。
 * 市場は必須、種別は allowlist 一致のみ・なければ `（` 終端 (14900 の原文欠落) の
 * ときだけ null、それ以外は throw (未知種別の黙殺防止)。
 */
function splitNameSectypeMarket(mid: string, where: string): { name: string; sectype: string | null; market: string } {
  let market: string | null = null;
  let marketIdx = -1;
  for (const cand of MARKETS) {
    const i = mid.lastIndexOf(cand);
    if (i >= 0 && i > marketIdx) {
      marketIdx = i;
      market = cand;
    }
  }
  if (market === null || marketIdx < 0) fail(`${where} の市場区分が不明です: ${mid.slice(-60)}`);
  const rest = mid.slice(0, marketIdx).replace(/\s+$/, "");
  let sectype: string | null = null;
  let name = rest;
  for (const cand of SECTYPES) {
    if (rest.endsWith(cand)) {
      sectype = cand;
      name = rest.slice(0, rest.length - cand.length).replace(/\s+$/, "");
      break;
    }
  }
  if (sectype === null && !name.endsWith("（")) {
    fail(`${where} の銘柄種別が不明です (allowlist 外・欠落形でもない): ${rest.slice(-60)}`);
  }
  if (name.length === 0) fail(`${where} の銘柄名が空です`);
  return { name, sectype, market };
}

interface ShsLine {
  unitLetter: string;
  name: string;
  sectype: string | null;
  market: string;
  loanKind: string;
  code: string;
  isin: string;
  figures: MarginDailyFigures;
}

function parseShsLine(line: string): ShsLine | null {
  const m = SHS_ROW_RE.exec(line);
  if (!m) return null;
  const [, unitLetter, mid, loanKind, code, isin, segment] = m as unknown as [
    string, string, string, string, string, string, string,
  ];
  const where = `株数行 ${code}`;
  if (!UNIT_LETTERS.has(unitLetter)) fail(`${where} の売買単位字母が未知です: ${unitLetter}`);
  if (!LOAN_KINDS.has(loanKind)) fail(`${where} の貸借区分が未知です: ${loanKind}`);
  const { name, sectype, market } = splitNameSectypeMarket(mid, where);
  const figures = parseFigures(splitCells(segment), where);
  assertBreakdown(figures, where);
  return { unitLetter, name, sectype, market, loanKind, code, isin, figures };
}

interface ValLine {
  code: string;
  isin: string;
  figures: MarginDailyFigures;
}

function parseValLine(line: string): ValLine | null {
  const m = VAL_ROW_RE.exec(line);
  if (!m) return null;
  const [, , code, isin, segment] = m as unknown as [string, string, string, string, string];
  if (!/^\d{3}[0-9A-Z]\d$/.test(code)) return null;
  if (!/^[A-Z]{2}[A-Z0-9]{10}$/.test(isin)) return null;
  const where = `金額行 ${code}`;
  const figures = parseFigures(splitCells(segment), where);
  assertBreakdown(figures, where);
  return { code, isin, figures };
}

const TOTAL_SHS_RE =
  /^(貸借銘柄|制度信用銘柄|その他|総合計|プライム 小計|スタンダード 小計|グロース 小計|投信等 小計) (\d[\d,]*) 銘柄\s*株数 Shs\. (.*)$/;
const TOTAL_VAL_RE = /^(.*) 金額 Val\. (.*)$/;
const TOTAL_SCOPE: ReadonlyMap<string, MarginDailyTotalScope> = new Map([
  ["貸借銘柄", "loan"],
  ["制度信用銘柄", "standardized"],
  ["その他", "other"],
  ["総合計", "grand"],
]);
const TOTAL_SUB_MARKET: ReadonlyMap<string, string> = new Map([
  ["プライム 小計", "プライム"],
  ["スタンダード 小計", "スタンダード"],
  ["グロース 小計", "グロース"],
  ["投信等 小計", "投信等"],
]);
const TOTAL_EN_LABELS: ReadonlySet<string> = new Set(TOTAL_LABEL_PAIRS.values());

interface TotalLine {
  label: string;
  market: string | null;
  count: number;
  figures: MarginDailyFigures;
}

function parseTotalShsLine(line: string): TotalLine | null {
  const m = TOTAL_SHS_RE.exec(line);
  if (!m) return null;
  const [, label, countRaw, segment] = m as unknown as [string, string, string, string];
  const where = `合計株数行 ${label}`;
  const subMarket = TOTAL_SUB_MARKET.get(label) ?? null;
  return {
    label,
    market: subMarket,
    count: toCountStrict(countRaw, where),
    figures: parseFigures(splitCells(segment), where),
  };
}

function parseTotalValLine(line: string, wantLabel: string): MarginDailyFigures {
  const m = TOTAL_VAL_RE.exec(line);
  if (!m) fail(`合計金額行が不正です (${wantLabel} 対応): ${line.slice(0, 80)}`);
  const [, enLabel, segment] = m as unknown as [string, string, string];
  const wantEn = TOTAL_LABEL_PAIRS.get(wantLabel);
  if (enLabel.trim() !== wantEn) {
    fail(`合計金額行のラベル不一致です: ${enLabel.trim().slice(0, 40)} (株数行 ${wantLabel} に対応する ${wantEn} が必要)`);
  }
  const where = `合計金額行 ${wantLabel}`;
  return parseFigures(splitCells(segment), where);
}

/**
 * PDF 全文テキスト → 日次スナップショット (provenance 除外。呼び出し側で付与)。
 * ページ境界をまたぐ行割れは行スキャン+突合で吸収する (ページ構造に依存しない)。
 */
export function parseDailyMarginText(
  text: string,
  provenance: { sourceUrl: string; rawSha256: string; rawPageId?: string | null }
): MarginDailySnapshot {
  assertDailyMarginHeaders(text);
  const { basisDate, publicationDate } = parseDailyMarginDates(text);
  const shsByCode = new Map<string, ShsLine>();
  const valByCode = new Map<string, ValLine>();
  const totalShs: TotalLine[] = [];
  const totalValLines: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.includes("株数 Shs.")) {
      const total = parseTotalShsLine(line);
      if (total) {
        totalShs.push(total);
        continue;
      }
      const row = parseShsLine(line);
      if (row) {
        if (shsByCode.has(row.code)) fail(`株数行のコード重複です: ${row.code}`);
        shsByCode.set(row.code, row);
        continue;
      }
      // 見出し・注記はマーカー行に現れない (2026-09-28 分の全ページで確認)。
      // 合計・明細のどちらの文法にも一致しないマーカー行は未知として STOP し、
      // 件数突合まかせで黙殺しない (未知コード/貸借/ISIN の取込漏れ防止)。
      fail(`未知の株数行です: ${line.slice(0, 100)}`);
    }
    if (line.includes("金額 Val.")) {
      const enLabel = line.split("金額 Val.")[0].trim();
      if (TOTAL_EN_LABELS.has(enLabel)) {
        totalValLines.push(line);
        continue;
      }
      const row = parseValLine(line);
      if (row) {
        if (valByCode.has(row.code)) fail(`金額行のコード重複です: ${row.code}`);
        valByCode.set(row.code, row);
        continue;
      }
      fail(`未知の金額行です: ${line.slice(0, 100)}`);
    }
  }
  // 明細の株数/金額突合。
  const rows: MarginDailyRow[] = [];
  for (const [code, shs] of shsByCode) {
    const val = valByCode.get(code);
    if (!val) fail(`金額行がありません: ${code}`);
    if (val.isin !== shs.isin) fail(`ISIN 不一致です (${code}): 株数 ${shs.isin} vs 金額 ${val.isin}`);
    const ordinaryTicker = sourceCodeToTicker(code);
    rows.push({
      sourceCode: code,
      name: shs.name,
      ordinaryTicker,
      eligible: ordinaryTicker !== null && shs.sectype === "普通株式",
      unitLetter: shs.unitLetter,
      sectype: shs.sectype,
      market: shs.market,
      loanKind: shs.loanKind,
      isin: shs.isin,
      shares: shs.figures,
      amounts: val.figures,
    });
  }
  for (const code of valByCode.keys()) {
    if (!shsByCode.has(code)) fail(`株数行がありません: ${code}`);
  }
  // PDF 出現順をそのまま保持する (CF-CANONICAL-DESIGN の確定仕様。2026-09-28 分は
  // 出現順=コード順のため sort しても同一だが、並び替えはしない)。
  // 合計の株数/金額突合 (順序対応 + EN ラベル照合)。
  if (totalShs.length !== totalValLines.length) {
    fail(`合計行数が不一致です: 株数 ${totalShs.length} vs 金額 ${totalValLines.length}`);
  }
  const totals: MarginDailyTotal[] = totalShs.map((t, i) => {
    const figures = parseTotalValLine(totalValLines[i], t.label);
    assertBreakdown(t.figures, `合計株数行 ${t.label}`);
    assertBreakdown(figures, `合計金額行 ${t.label}`);
    const scope = TOTAL_SCOPE.get(t.label);
    return {
      label: t.label,
      scope: scope ?? currentScope(totalShs, i),
      market: t.market,
      count: t.count,
      shares: t.figures,
      amounts: figures,
    };
  });
  const snapshot: MarginDailySnapshot = {
    format: MARGIN_DAILY_FORMAT,
    basisDate,
    publicationDate,
    sourceUrl: provenance.sourceUrl,
    rawSha256: provenance.rawSha256,
    rawPageId: provenance.rawPageId ?? null,
    rows,
    totals,
  };
  validateDailyMarginSnapshot(snapshot);
  return snapshot;
}

/** 市場小計が属する分類 (直前の分類合計行から継承。順序検証つき)。 */
function currentScope(totalShs: readonly TotalLine[], index: number): MarginDailyTotalScope {
  for (let i = index - 1; i >= 0; i--) {
    const scope = TOTAL_SCOPE.get(totalShs[i].label);
    if (scope) return scope;
  }
  fail(`合計 ${totalShs[index].label} の属する分類がありません`);
}

/** 合計セクションの順序検証 (分類合計→市場小計の順。投信等小計は 0 件省略あり)。 */
function assertTotalSequence(totals: readonly MarginDailyTotal[]): void {
  const cats: MarginDailyTotalScope[] = ["loan", "standardized", "other", "grand"];
  let pos = 0;
  for (const cat of cats) {
    const head = totals[pos];
    if (!head || head.market !== null || head.scope !== cat) {
      fail(`合計セクションの順序が不正です: ${cat} の分類合計が必要 (位置 ${pos})`);
    }
    pos++;
    for (const market of ["プライム", "スタンダード", "グロース"] as const) {
      const sub = totals[pos];
      if (!sub || sub.market !== market || sub.scope !== cat) {
        fail(`合計セクションの順序が不正です: ${cat}/${market} 小計が必要 (位置 ${pos})`);
      }
      pos++;
    }
    const maybeT = totals[pos];
    if (maybeT && maybeT.market === "投信等" && maybeT.scope === cat) pos++;
  }
  if (pos !== totals.length) fail(`合計行に余分があります (位置 ${pos} 以降 ${totals.length - pos} 行)`);
}

type FigKey =
  | "sellOutstanding" | "sellChg" | "buyOutstanding" | "buyChg"
  | "negSell" | "negSellChg" | "stdSell" | "stdSellChg"
  | "negBuy" | "negBuyChg" | "stdBuy" | "stdBuyChg";
const FIG_KEYS: readonly FigKey[] = [
  "sellOutstanding", "sellChg", "buyOutstanding", "buyChg",
  "negSell", "negSellChg", "stdSell", "stdSellChg",
  "negBuy", "negBuyChg", "stdBuy", "stdBuyChg",
];

/**
 * 合計突合のための和。null が 1 つでも混ざったら throw する (null を 0 扱い
 * して「一致」を捏造しない。欠損 raw はスナップショットに null のまま保持し、
 * 合計の確定は未知として STOP する — 突合不能を成功にしない)。
 */
function sumAllOrThrow(values: readonly (number | null)[], where: string): number {
  let sum = 0;
  for (const v of values) {
    if (v === null) fail(`${where}: null セルを含むため合計を確定できません`);
    sum += v;
  }
  return sum;
}

/**
 * スナップショットの完全検証 (純関数)。件数・内訳・小計・総合計・明細合計を
 * すべて exact 照合する。1 つでも外れたら throw (部分保存させない)。
 */
export function validateDailyMarginSnapshot(snapshot: MarginDailySnapshot): void {
  if (snapshot.format !== MARGIN_DAILY_FORMAT) fail(`形式タグが未知です: ${snapshot.format}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.basisDate)) fail(`基準日が不正です: ${snapshot.basisDate}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.publicationDate)) fail(`公表日が不正です: ${snapshot.publicationDate}`);
  assertTotalSequence(snapshot.totals);
  const headOf = (scope: MarginDailyTotalScope): MarginDailyTotal => {
    const t = snapshot.totals.find((x) => x.scope === scope && x.market === null);
    if (!t) fail(`分類合計がありません: ${scope}`);
    return t;
  };
  const subsOf = (scope: MarginDailyTotalScope): MarginDailyTotal[] =>
    snapshot.totals.filter((x) => x.scope === scope && x.market !== null);
  // 件数: 小計和=分類件数、分類和=総合計件数、明細数=総合計件数。
  for (const scope of ["loan", "standardized", "other"] as const) {
    const head = headOf(scope);
    const subs = subsOf(scope);
    const subCount = subs.reduce((a, s) => a + s.count, 0);
    if (subCount !== head.count) fail(`件数が合いません (${scope}): 小計和 ${subCount} != ${head.count}`);
  }
  const grand = headOf("grand");
  const grandSubCount = subsOf("grand").reduce((a, s) => a + s.count, 0);
  if (grandSubCount !== grand.count) fail(`件数が合いません (grand): 小計和 ${grandSubCount} != ${grand.count}`);
  const catCount = (["loan", "standardized", "other"] as const).reduce((a, s) => a + headOf(s).count, 0);
  if (catCount !== grand.count) fail(`件数が合いません: 分類和 ${catCount} != 総合計 ${grand.count}`);
  if (snapshot.rows.length !== grand.count) {
    fail(`明細行数が合いません: ${snapshot.rows.length} != 総合計 ${grand.count}`);
  }
  // 金額の閉じ方 (すべて exact。null 混じりは突合不能として STOP):
  //   - 小計和=分類、分類和=総合計: 12 数値すべて (合計行同士は内部整合する)。
  //   - 明細和=総合計: 残高6項目のみ。
  //   明細の前日比和は合計突合の対象外とする。観測事実 (2026-09-28 分。原因の
  //   断定ではない): 明細の買前日比和 (-1,457,071) と総合計 (▲1,453,024) が
  //   4,047 だけ一致しない。内訳として (a) 前日比 `-` の 2 行 (643A0/644A0) の
  //   買残合計がちょうど 4,047 であること、(b) 634A0 の当日一般買残 122,400 と
  //   前日比 ▲150,500 から逆算される前日残 272,900 が、制度/その他の前日比の
  //   行合計との差 (±272,900) と一致すること、の 2 点の数値的一致を確認した。
  //   ただし原文に `-` の集計扱いや区分変更の集計定義を述べた注記は無く、
  //   単日ファイルからは検証不能のため、0 補完・原因断定はしない。明細側の
  //   前日比は「14セル文法+一般+制度=総計」の行内整合 (assertBreakdown) で守る。
  const sumFigs = (figs: readonly MarginDailyFigures[], key: FigKey, where: string): number =>
    sumAllOrThrow(
      figs.map((f) => f[key]),
      where
    );
  const wantOf = (fig: MarginDailyFigures, key: FigKey, where: string): number => {
    const v = fig[key];
    if (v === null) fail(`${where}: 合計セルが null のため突合できません`);
    return v;
  };
  for (const scope of ["loan", "standardized", "other", "grand"] as const) {
    const head = headOf(scope);
    const subs = subsOf(scope);
    for (const side of ["shares", "amounts"] as const) {
      for (const key of FIG_KEYS) {
        const where = `${scope}/${side}/${key}`;
        const want = wantOf(head[side], key, where);
        const got = sumFigs(
          subs.map((s) => s[side]),
          key,
          where
        );
        if (want !== got) fail(`合計が合いません (${where}): 小計和 ${got} != ${want}`);
      }
    }
  }
  const BALANCE_KEYS: readonly FigKey[] = [
    "sellOutstanding",
    "buyOutstanding",
    "negSell",
    "stdSell",
    "negBuy",
    "stdBuy",
  ];
  for (const side of ["shares", "amounts"] as const) {
    for (const key of FIG_KEYS) {
      const where = `grand/${side}/${key}`;
      const want = wantOf(grand[side], key, where);
      const catSum = sumFigs(
        (["loan", "standardized", "other"] as const).map((s) => headOf(s)[side]),
        key,
        where
      );
      if (want !== catSum) fail(`合計が合いません (${where}): 分類和 ${catSum} != ${want}`);
    }
    for (const key of BALANCE_KEYS) {
      const where = `grand/${side}/${key}`;
      const want = wantOf(grand[side], key, where);
      const rowSum = sumFigs(
        snapshot.rows.map((r) => r[side]),
        key,
        where
      );
      if (want !== rowSum) fail(`合計が合いません (${where}): 明細和 ${rowSum} != ${want}`);
    }
  }
}

export type MarginDailyRowSelection =
  | { status: "ok"; row: MarginDailyRow }
  | { status: "missing" }
  | { status: "ambiguous"; count: number };

/**
 * 日次スナップショットの行から指定コードの行を選ぶ純関数。
 * 5 文字原文コードと 4 文字普通株ティッカーの両方で引ける。同一ティッカーの
 * 複数行 (普通株+種類株等) は先頭行を黙って返さず ambiguous で明示する (ルール2)。
 */
export function selectDailyMarginRows(
  rows: readonly MarginDailyRow[],
  code: string
): MarginDailyRowSelection {
  const hits = rows.filter((r) => r.sourceCode === code || r.ordinaryTicker === code);
  if (hits.length === 0) return { status: "missing" };
  if (hits.length === 1) return { status: "ok", row: hits[0] as MarginDailyRow };
  return { status: "ambiguous", count: hits.length };
}
