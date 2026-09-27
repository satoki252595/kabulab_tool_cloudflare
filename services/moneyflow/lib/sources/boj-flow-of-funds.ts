// 日本銀行 資金循環統計 (Flow of Funds Accounts) 取得元アダプタ。
//
// 公表元: https://www.boj.or.jp/statistics/sj/index.htm (日本銀行調査統計局)
// 配布形式: 「（１）全体表」を含む速報 Excel (sjpre.xlsx、四半期ごとに同一 URL を
// 上書き配布) — 「国債等の保有者別内訳」(holdings01.pdf) と同じ「固定 URL・
// 都度上書き」運用。時系列統計データ検索サイト (stat-search.boj.or.jp) の API
// (2026-02 提供開始) は「短時間における高頻度のアクセス…を禁止」と明記されて
// いるため、本アダプタは stat-search API を使わず index.htm 経由の Excel 取得
// のみを使う (規約上より安全な経路。频度は四半期に 1 回)。
//
// 制度部門 (家計・民間非金融法人企業・一般政府・金融機関・海外 等) ×
// 金融商品 (現金・預金/貸出/債務証券/株式等・投資信託受益証券/保険・年金 等)
// で、四半期中の「金融取引表」(フロー、net_flow) と期末時点の
// 「金融資産・負債残高表」(ストック、holdings_stock) を横断的に集計する、
// 唯一の公的マクロ統計 (計画書 Phase 3 R2/R3 補助)。
//
// ルール1/2 対応:
//   - 値は全て取得した Excel セルの実測値をそのまま返す。既定値・穴埋めは無い。
//   - 想定した見出しテキスト・行/列コードが見つからない場合は必ず throw する
//     (様式変更を「たまたま近い値」で握り潰さない)。
// ルール3 対応: 本ファイルは秘密情報・環境依存値を一切使わない (API キー不要)。

import * as XLSX from "xlsx";

// ブラウザ相当 UA。共有定数モジュールは未整備 (Phase 0 未着手) のため、
// services/vwap-analysis/lib/margin.ts / src/shared/jpx/sectors.ts と
// 同一の値をこのファイル内に複製する。将来 Phase 0 で共有 UA 定数が
// 整備されたら、そちらへ差し替えること。
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export const BOJ_BASE_URL = "https://www.boj.or.jp";
/** 資金循環統計トップページ (公表日・対象期・最新ファイルへのリンクを持つ) */
export const BOJ_FLOW_OF_FUNDS_INDEX_URL = `${BOJ_BASE_URL}/statistics/sj/index.htm`;

// ---------------------------------------------------------------------------
// 制度部門 (資金循環統計の勘定主体区分)
// ---------------------------------------------------------------------------

/**
 * 資金循環統計の制度部門コード (葉レベルのみ; 集計コード 2/3/331 は含めない)。
 *
 * sjcode.pdf / 実 Excel の行・列見出しで確認した値:
 *   1=金融機関, 2=非金融法人企業(21+22の合計), 21=民間非金融法人企業,
 *   22=公的非金融法人企業, 3=一般政府(31+32+33の合計), 31=中央政府,
 *   32=地方公共団体, 33=社会保障基金 (331=うち公的年金は33の内数),
 *   4=家計, 5=対家計民間非営利団体, 6=海外
 *
 * 2・3・331 は他の葉コードの合計/内数であり、葉コードと並べて集計すると
 * 二重計上になるため BOJ_SECTORS には含めない (パース自体はエラーにせず
 * 生レコードとして保持する。BOJ_AGGREGATE_SECTOR_CODES 参照)。
 */
export type BojSectorCode = "1" | "21" | "22" | "31" | "32" | "33" | "4" | "5" | "6";

export interface BojSectorDefinition {
  code: BojSectorCode;
  /** 観測ログの「区分」に書く識別キー (英数字、Notion selectの安定キー用) */
  key: string;
  label: string;
  labelEn: string;
}

export const BOJ_SECTORS: readonly BojSectorDefinition[] = [
  { code: "1", key: "financial_institutions", label: "金融機関", labelEn: "Financial Institutions" },
  { code: "21", key: "private_nonfinancial_corporations", label: "民間非金融法人企業", labelEn: "Private Non-Financial Corporations" },
  { code: "22", key: "public_nonfinancial_corporations", label: "公的非金融法人企業", labelEn: "Public Non-Financial Corporations" },
  { code: "31", key: "central_government", label: "中央政府", labelEn: "Central Government" },
  { code: "32", key: "local_government", label: "地方公共団体", labelEn: "Local Governments" },
  { code: "33", key: "social_security_funds", label: "社会保障基金", labelEn: "Social Security Funds" },
  { code: "4", key: "households", label: "家計", labelEn: "Households" },
  { code: "5", key: "private_nonprofit_institutions", label: "対家計民間非営利団体", labelEn: "Private Non-Profit Institutions Serving Households" },
  { code: "6", key: "overseas", label: "海外", labelEn: "Rest of the World" },
] as const;

/** 集計/内数コード。生レコードには残すが、観測ログの葉区分としては使わない。 */
const BOJ_AGGREGATE_SECTOR_CODES = new Set(["2", "3", "331"]);

const BOJ_SECTOR_BY_CODE = new Map(BOJ_SECTORS.map((s) => [s.code, s]));

// ---------------------------------------------------------------------------
// 金融商品 (行コード)。この取得元で観測ログに書き出す指標として採用する部分集合。
// 計画書 (notion-velvet-goose.md Phase 3) が明示する「現預金・貸出・国債財投債・
// 事業債・株式等・投資信託受益証券・対外証券投資等」に対応する。
// ---------------------------------------------------------------------------

export type BojRequirement = "R1" | "R2" | "R3" | "R4";

export interface BojInstrumentDefinition {
  /** Excel 上の行コード (例: "E") */
  rowCode: string;
  /** 指標キーの基底 (英語 slug) */
  instrumentKey: string;
  label: string;
  labelEn: string;
  requirements: readonly BojRequirement[];
  /** 平易な説明 (何を測るか) */
  measures: string;
  /** 財務的に正確な定義 */
  definition: string;
  limitations: readonly string[];
}

export const BOJ_INSTRUMENTS: readonly BojInstrumentDefinition[] = [
  {
    rowCode: "A",
    instrumentKey: "cash_and_deposits",
    label: "現金・預金",
    labelEn: "Cash and Deposits",
    requirements: ["R2"],
    measures:
      "その部門がどれだけ現金・銀行預金を持っている(残高)か、四半期にどれだけ増減したか(フロー)。",
    definition:
      "現金・日銀預け金・政府預金・流動性預金・定期性預金・譲渡性預金・外貨預金の合計。" +
      "フローは評価損益を含まない実際の受払額(取引額)、ストックは期末時点の残高。",
    limitations: [
      "外貨預金は円換算後の値で、為替変動による評価差を含む(取引によらない増減が混じりうる)。",
    ],
  },
  {
    rowCode: "C",
    instrumentKey: "loans",
    label: "貸出",
    labelEn: "Loans",
    requirements: ["R2"],
    measures: "その部門が銀行等からどれだけ借入をしているか、または貸し出しているか。",
    definition:
      "日銀貸出金・コール手形・民間金融機関貸出・公的金融機関貸出・非金融部門貸出金・" +
      "割賦債権・現先/債券貸借取引の合計。資産(A)側は「貸し手」、負債(L)側は「借り手」。",
    limitations: [
      "住宅ローン・消費者信用の内訳は民間金融機関貸出の内数としてのみ分かる(単独の四半期集計)。",
    ],
  },
  {
    rowCode: "D",
    instrumentKey: "debt_securities",
    label: "債務証券",
    labelEn: "Debt Securities",
    requirements: ["R2"],
    measures: "国債・社債など、利子の付く借用証書(債券)をどれだけ持っている/発行しているか。",
    definition:
      "国庫短期証券・国債財投債・地方債・政府関係機関債・金融債・事業債・居住者発行外債・CP・" +
      "信託受益権・債権流動化関連商品の合計(額面ではなく時価ベース)。",
    limitations: ["額面ベースの内訳は別表(E/E')でのみ提供され、この全体表は時価ベース。"],
  },
  {
    rowCode: "Db",
    instrumentKey: "jgb_and_filp_bonds",
    label: "国債・財投債",
    labelEn: "Japanese Government Bonds and FILP Bonds",
    requirements: ["R2"],
    measures: "国が発行する国債(と財政投融資債)を、誰がどれだけ持っているか。",
    definition: "国債(利付国庫債券等)と財投機関債である財投債の合計。時価ベース。",
    limitations: ["国庫短期証券(T-Bill)は別行(Da)で、Dbには含まれない。"],
  },
  {
    rowCode: "Df",
    instrumentKey: "corporate_bonds",
    label: "事業債",
    labelEn: "Corporate (Straight) Bonds",
    requirements: ["R2"],
    measures: "民間企業が発行する社債を、誰がどれだけ持っている/発行しているか。",
    definition: "事業法人が発行する社債(普通社債)の時価ベース残高・フロー。",
    limitations: ["転換社債等の扱いは公表資料(sjteigi.pdf)の定義に従う(本パーサでは区別しない)。"],
  },
  {
    rowCode: "E",
    instrumentKey: "equity_and_investment_fund_shares",
    label: "株式等・投資信託受益証券",
    labelEn: "Equities and Investment Fund Shares",
    requirements: ["R2", "R3"],
    measures:
      "株式(上場・非上場)と投資信託(投信)を合わせて、誰がどれだけ持っているか。" +
      "個人が『貯金』ではなく『投資』にどれだけお金を置いているかの中心指標。",
    definition:
      "株式等(Ea: 上場株式+非上場株式+その他の持分)と投資信託受益証券(Eb)の合計。時価ベース。" +
      "フローは四半期中の売買等による取得(資産側)・発行(負債側)の純額で、価格変動による" +
      "評価損益(キャピタルゲイン/ロス)は含まない。ストックは期末時価。",
    limitations: [
      "フローは『取引による増減』のみで、ストックの前期差分(=フロー+評価損益)とは一致しない" +
        "(評価損益の内訳は「３．調整表」で別途提供される)。",
    ],
  },
  {
    rowCode: "Ea",
    instrumentKey: "equities",
    label: "株式等",
    labelEn: "Equities",
    requirements: ["R2", "R3"],
    measures: "上場株式・非上場株式・その他出資持分を合わせて、誰がどれだけ持っているか。",
    definition: "上場株式(Eaa)+非上場株式(Eab)+その他の持分(Eac)の合計。投資信託は含まない。時価ベース。",
    limitations: ["非上場株式は市場価格が無いため、簿価等を用いた推計時価であることが多い。"],
  },
  {
    rowCode: "Eaa",
    instrumentKey: "listed_shares",
    label: "上場株式",
    labelEn: "Listed Shares",
    requirements: ["R2", "R3"],
    measures: "証券取引所に上場している株式だけを、誰がどれだけ持っているか。",
    definition: "上場株式の時価総額ベースの残高・四半期中の取引による純増減。",
    limitations: ["東証33業種のような業種別内訳は無い(部門別のみ)。R1(業種別)には使えない。"],
  },
  {
    rowCode: "Eb",
    instrumentKey: "investment_fund_shares",
    label: "投資信託受益証券",
    labelEn: "Investment Fund Shares",
    requirements: ["R2", "R3"],
    measures:
      "投資信託(いわゆる『投信』。株式や債券をまとめて運用する商品)を、誰がどれだけ持っているか。",
    definition: "公募・私募の株式投資信託、公社債投資信託、REIT投資口等を含む投資信託受益証券の時価ベース残高・フロー。",
    limitations: [
      "『設定額-解約額』(資金純増減)とは概念が異なる(あちらは投信会社側の集計、こちらは保有者側の残高変動)。",
    ],
  },
  {
    rowCode: "F",
    instrumentKey: "insurance_and_pensions",
    label: "保険・年金・定型保証",
    labelEn: "Insurance, Pensions and Standardized Guarantees",
    requirements: ["R2"],
    measures: "生命保険・年金(将来もらえる年金の権利)を、誰がどれだけ持っているか。",
    definition:
      "非生命保険準備金・生命保険受給権・年金保険受給権・年金受給権・年金基金の対年金責任者債権・" +
      "定型保証支払引当金の合計。",
    limitations: ["年金受給権は将来給付の現在価値相当であり、現金化できる残高ではない。"],
  },
  {
    rowCode: "K",
    instrumentKey: "outward_direct_investment",
    label: "対外直接投資",
    labelEn: "Outward Direct Investment",
    requirements: ["R4"],
    measures: "日本の企業などが海外の会社を買収・出資して保有している金額。",
    definition: "居住者による非居住者企業への直接投資(経営支配を伴う出資)の残高・フロー。国際収支の直接投資と整合。",
    limitations: ["海外のどの国・地域向けかの内訳はこの表には無い(国別内訳は国際収支統計を使う)。"],
  },
  {
    rowCode: "L",
    instrumentKey: "outward_portfolio_investment",
    label: "対外証券投資",
    labelEn: "Outward Portfolio Investment",
    requirements: ["R4", "R3"],
    measures: "日本の投資家が海外の株式・債券をどれだけ持っているか。",
    definition: "居住者が保有する非居住者発行証券(海外株式・海外債券)の残高・フロー。",
    limitations: ["国別内訳は無い。海外株と海外債券の内訳もこの全体表単体では分からない。"],
  },
] as const;

const BOJ_INSTRUMENT_BY_ROW_CODE = new Map(BOJ_INSTRUMENTS.map((i) => [i.rowCode, i]));

// ---------------------------------------------------------------------------
// 指標定義 (観測ログの「指標」列が参照する正本)
// ---------------------------------------------------------------------------

export type BojFlowType = "net_flow" | "holdings_stock";
export type BojTable = "flow" | "stock";

export interface BojIndicatorDefinition {
  /** 観測ログで使う安定キー (例: "boj_ffa_equity_and_investment_fund_shares_flow") */
  key: string;
  instrumentKey: string;
  rowCode: string;
  table: BojTable;
  flowType: BojFlowType;
  label: string;
  requirements: readonly BojRequirement[];
  measures: string;
  definition: string;
  unit: string;
  sourceUrl: string;
  usageTerms: string;
  frequency: string;
  /** 速報から確報までの目安 (研究時点で確認した実績ベースの近似。BOJは公表日を確約していない) */
  latencyNote: string;
  limitations: readonly string[];
}

function buildIndicatorDefinitions(): readonly BojIndicatorDefinition[] {
  const defs: BojIndicatorDefinition[] = [];
  for (const instrument of BOJ_INSTRUMENTS) {
    for (const table of ["flow", "stock"] as const) {
      const tableLabel = table === "flow" ? "フロー(四半期中の純増減)" : "ストック(期末残高)";
      defs.push({
        key: `boj_ffa_${instrument.instrumentKey}_${table}`,
        instrumentKey: instrument.instrumentKey,
        rowCode: instrument.rowCode,
        table,
        flowType: table === "flow" ? "net_flow" : "holdings_stock",
        label: `${instrument.label}(${tableLabel})`,
        requirements: instrument.requirements,
        measures: `${instrument.measures} [${tableLabel}]`,
        definition: `${instrument.definition} 単位は${tableLabel}。`,
        unit: "億円",
        sourceUrl: BOJ_FLOW_OF_FUNDS_INDEX_URL,
        usageTerms:
          "無料・登録不要。二次利用時は出典(日本銀行「資金循環統計」)の明記が必要 " +
          "(commercial_use=attribution_required)。時系列統計データ検索サイトのAPIは規約で" +
          "高頻度アクセスを禁止しているため、本アダプタはExcel配布(index.htm経由)のみを使う。",
        frequency: "四半期",
        latencyNote:
          "速報は四半期末から概ね2〜3か月後(2026年第2四半期分は6/30締めで9/17公表=約2.5か月後を" +
          "本調査で実測)。BOJは曜日・日付を確約していないため、実際の判定は" +
          "isPeriodAlreadyPublished()で取得済みファイルの申告期と比較すること。",
        limitations: instrument.limitations,
      });
    }
  }
  return defs;
}

/** この取得元が export する指標定義一覧 (12商品 × flow/stock = 24件)。 */
export const BOJ_FLOW_OF_FUNDS_INDICATORS: readonly BojIndicatorDefinition[] = buildIndicatorDefinitions();

// ---------------------------------------------------------------------------
// 期間 (四半期) の型と判定
// ---------------------------------------------------------------------------

export type BojQuarter = 1 | 2 | 3 | 4;
export type BojVintage = "preliminary" | "final";

export interface BojQuarterPeriod {
  year: number;
  quarter: BojQuarter;
  vintage: BojVintage;
  /** Excel から読み取った元のラベル文字列 (例: "2026年 4〜6月期(速報)") */
  rawLabel: string;
}

/** 比較用に (year, quarter) を単調増加の整数へ変換する。 */
function periodOrdinal(p: { year: number; quarter: BojQuarter }): number {
  return p.year * 10 + p.quarter;
}

/**
 * 対象四半期が、取得済みの最新公表期以前 (=既に公表済み) かどうかを判定する。
 *
 * ルール2: 「たぶん公表されているはず」という推測ではなく、実際に取得した
 * ファイルの申告期 (latestPublished) と突き合わせて判定する。
 */
export function isPeriodAlreadyPublished(
  target: { year: number; quarter: BojQuarter },
  latestPublished: { year: number; quarter: BojQuarter }
): boolean {
  return periodOrdinal(target) <= periodOrdinal(latestPublished);
}

/**
 * 次の四半期の公表予想時期 (近似の目安)。
 *
 * BOJ自身は「速報は当該四半期の約2〜3か月後」としか案内しておらず、公表日を
 * 確約する一次情報は無い。ここでの日付は本調査時点(2026-09)の実測1件
 * (2026年Q2分→2026-09-17公表、四半期末+2.5か月)を基にした**近似の目安**で
 * あり、確定スケジュールではない。呼び出し側は、この関数の返り値だけで
 * 「公表された」と判断せず、必ず isPeriodAlreadyPublished() で実ファイルと
 * 突き合わせること。
 */
export function estimateNextReleaseWindow(latestPublished: { year: number; quarter: BojQuarter }): {
  targetPeriod: { year: number; quarter: BojQuarter };
  earliestExpected: string;
  latestExpected: string;
  note: string;
} {
  const nextQuarter = ((latestPublished.quarter % 4) + 1) as BojQuarter;
  const nextYear = latestPublished.quarter === 4 ? latestPublished.year + 1 : latestPublished.year;
  const quarterEndMonth = nextQuarter * 3; // 1Q末=3月, 2Q末=6月, 3Q末=9月, 4Q末=12月
  const quarterEndDate = new Date(Date.UTC(nextYear, quarterEndMonth, 0)); // 月末日
  const earliest = new Date(quarterEndDate);
  earliest.setUTCMonth(earliest.getUTCMonth() + 2);
  const latest = new Date(quarterEndDate);
  latest.setUTCMonth(latest.getUTCMonth() + 4);
  return {
    targetPeriod: { year: nextYear, quarter: nextQuarter },
    earliestExpected: earliest.toISOString().slice(0, 10),
    latestExpected: latest.toISOString().slice(0, 10),
    note:
      "近似の目安 (実測1件ベース)。BOJは公表日を確約していないため、実行のたびに" +
      "resolveLatestBojFlowOfFundsFile()/fetchLatestBojFlowOfFunds()で実際の公表状況を確認すること。",
  };
}

/**
 * 「2026年  4〜6月期(速報)」「2026年  4〜6月期(確報)」のようなフロー表の期間見出しを
 * 構造化する。想定外の書式は throw する (ルール2)。
 */
export function parseFlowPeriodLabel(text: string): BojQuarterPeriod {
  const m = text.match(/(\d{4})年\s*(\d{1,2})[〜~～\-−](\d{1,2})月期\s*[(（](速報|確報)[)）]/);
  if (!m) {
    throw new Error(
      `BOJ資金循環統計: フロー表の期間見出しを解釈できません(様式が変わった可能性): ${JSON.stringify(text)}`
    );
  }
  const year = Number(m[1]);
  const startMonth = Number(m[2]);
  const quarter = Math.ceil(startMonth / 3) as BojQuarter;
  const vintage: BojVintage = m[4] === "確報" ? "final" : "preliminary";
  return { year, quarter, vintage, rawLabel: text.trim() };
}

/**
 * 「2026年 6月末(速報)」のようなストック表(残高表)の期間見出しを構造化する。
 */
export function parseStockPeriodLabel(text: string): BojQuarterPeriod {
  const m = text.match(/(\d{4})年\s*(\d{1,2})月末\s*[(（](速報|確報)[)）]/);
  if (!m) {
    throw new Error(
      `BOJ資金循環統計: ストック表の期間見出しを解釈できません(様式が変わった可能性): ${JSON.stringify(text)}`
    );
  }
  const year = Number(m[1]);
  const endMonth = Number(m[2]);
  const quarter = Math.ceil(endMonth / 3) as BojQuarter;
  const vintage: BojVintage = m[3] === "確報" ? "final" : "preliminary";
  return { year, quarter, vintage, rawLabel: text.trim() };
}

// ---------------------------------------------------------------------------
// URL 解決・取得
// ---------------------------------------------------------------------------

export interface ResolvedBojFlowOfFundsFile {
  /** 速報 Excel (全体表・時系列を含む「全体版」ではなく「速報」xlsx) の絶対URL */
  url: string;
  /** index.htm の表に載っている「掲載日」(YYYY-MM-DD)。見つからなければ null */
  announcedAt: string | null;
  /** index.htm の表に載っている「公表対象期」の生テキスト。見つからなければ null */
  periodLabelHint: string | null;
}

/**
 * index.htm の HTML から、最新の速報 Excel (sjpre.xlsx 相当) の URL と
 * 掲載日・対象期のヒントを取り出す純関数パーサ。
 *
 * @throws 速報 Excel へのリンクが見つからない場合 (様式変更の可能性)
 */
export function parseIndexPageForLatestFile(html: string): ResolvedBojFlowOfFundsFile {
  const linkMatch = html.match(/href="(\/statistics\/sj\/sjpre\.xlsx)"/);
  if (!linkMatch) {
    throw new Error(
      "BOJ資金循環統計: index.htmから速報Excel(sjpre.xlsx)へのリンクが見つかりません" +
        "(様式が変わった可能性があります)"
    );
  }
  const url = `${BOJ_BASE_URL}${linkMatch[1]}`;

  // 表の行 (掲載日 / 公表対象期 / [XLSX ...]) を素朴にテキスト化して、
  // sjpre.xlsx を指す行の直前にある日付行・対象期行を拾う。
  // (このページはテーブルレイアウトが将来変わりうるため、あくまでヒント
  // 扱い。真の期間は Excel 本体の parseFlowPeriodLabel/parseStockPeriodLabel
  // が正とする。)
  const plainText = html
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const linkLineIndex = plainText.findIndex((line) => line.includes("[XLSX"));
  let announcedAt: string | null = null;
  let periodLabelHint: string | null = null;
  if (linkLineIndex >= 0) {
    for (let i = linkLineIndex - 1; i >= Math.max(0, linkLineIndex - 4); i--) {
      const line = plainText[i];
      const dateMatch = line.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
      if (dateMatch && announcedAt === null) {
        announcedAt = `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}`;
        continue;
      }
      if (/四半期|月期|月末/.test(line) && periodLabelHint === null) {
        periodLabelHint = line;
      }
    }
  }
  return { url, announcedAt, periodLabelHint };
}

/** index.htm を取得し、最新の速報Excelファイルの所在を解決する (ネットワークアクセス1回)。 */
export async function resolveLatestBojFlowOfFundsFile(): Promise<ResolvedBojFlowOfFundsFile> {
  const res = await fetch(BOJ_FLOW_OF_FUNDS_INDEX_URL, {
    headers: { "User-Agent": BROWSER_USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(
      `BOJ資金循環統計: index.htm取得に失敗しました: HTTP ${res.status} ${res.statusText} (${BOJ_FLOW_OF_FUNDS_INDEX_URL})`
    );
  }
  const html = await res.text();
  return parseIndexPageForLatestFile(html);
}

export interface FetchedBojFlowOfFunds {
  bytes: Uint8Array;
  url: string;
  fetchedAt: string;
  announcedAt: string | null;
}

/**
 * 最新の資金循環統計 速報Excelを取得する。
 *
 * ネットワークアクセスは 1 回の実行につき index.htm (URL解決) + xlsx本体 の
 * 計2回のみ (JPX等と同様、ブラウザ相当UAで最小限のアクセスに留める)。
 * stat-search.boj.or.jp のAPIは規約で高頻度アクセスを禁止しているため使わない。
 *
 * @throws HTTP エラー時
 */
export async function fetchLatestBojFlowOfFunds(): Promise<FetchedBojFlowOfFunds> {
  const resolved = await resolveLatestBojFlowOfFundsFile();
  const res = await fetch(resolved.url, { headers: { "User-Agent": BROWSER_USER_AGENT } });
  if (!res.ok) {
    throw new Error(
      `BOJ資金循環統計: Excel取得に失敗しました: HTTP ${res.status} ${res.statusText} (${resolved.url})`
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, url: resolved.url, fetchedAt: new Date().toISOString(), announcedAt: resolved.announcedAt };
}

// ---------------------------------------------------------------------------
// Excel パース (純関数)
// ---------------------------------------------------------------------------

type BojPosition = "asset" | "liability";

/**
 * 行コード ("A","Aa","Ccc","Z","W" 等) の形。BOJ_INSTRUMENTS を含む全行コードは
 * 大文字1字+小文字0〜2字のみで構成される (sjcode.pdf の命名規則、実データでも確認済み)。
 * ページ末尾に印刷用途と思われる無関係な文字列 (例: シート"2"のO71セルに
 * 混入していた"金融取引表 (Financial Transactions)"という次表の見出し文字列)
 * が紛れることがあるため、この形に一致しないセルは行コードとして扱わない。
 */
const ROW_CODE_PATTERN = /^[A-Z][a-z]{0,2}$/;

interface RawCellRecord {
  rowCode: string;
  sectorCode: string;
  position: BojPosition;
  value: number;
}

interface ColumnAssignment {
  sectorCode: string;
  position: BojPosition;
}

/**
 * ヘッダ領域 (先頭20行以内) から「資産(A)」という文字列を含むセルの行番号
 * (0-based) を探す。その1つ上の行が制度部門コード行という前提 (実データで確認済み)。
 */
function findPositionRow(sheet: XLSX.WorkSheet): number {
  const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1:A1");
  for (let r = range.s.r; r <= Math.min(range.s.r + 20, range.e.r); r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (cell && String(cell.v).trim() === "資産(A)") {
        return r;
      }
    }
  }
  throw new Error(
    "BOJ資金循環統計: 「資産(A)」の見出し行が見つかりません(表の様式が変わった可能性)"
  );
}

/**
 * 資産(A)/負債(L) の列見出し行と、その1行上の制度部門コード行から、
 * 列番号 → {sectorCode, position} の対応表を作る。
 *
 * 資産列は「同じ列」に部門コードがあり、負債列は「直前の列」の部門コードを
 * 引き継ぐ (実データで確認したレイアウト規則)。部門コードが見つからない
 * 列 (合計欄など) は対応表に含めない。
 */
function buildColumnAssignments(sheet: XLSX.WorkSheet): Map<number, ColumnAssignment> {
  const posRow = findPositionRow(sheet);
  const codeRow = posRow - 1;
  const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1:A1");
  const map = new Map<number, ColumnAssignment>();
  for (let c = range.s.c; c <= range.e.c; c++) {
    const posCell = sheet[XLSX.utils.encode_cell({ r: posRow, c })];
    if (!posCell) continue;
    const posVal = String(posCell.v).trim();
    if (posVal === "資産(A)") {
      const codeCell = sheet[XLSX.utils.encode_cell({ r: codeRow, c })];
      if (!codeCell || String(codeCell.v).trim() === "") continue;
      map.set(c, { sectorCode: String(codeCell.v).trim(), position: "asset" });
    } else if (posVal === "負債(L)") {
      const codeCell = sheet[XLSX.utils.encode_cell({ r: codeRow, c: c - 1 })];
      if (!codeCell || String(codeCell.v).trim() === "") continue;
      map.set(c, { sectorCode: String(codeCell.v).trim(), position: "liability" });
    }
  }
  return map;
}

/** 行コード列 (page1シート最左の短いコード、例 "E") の列番号を探す。 */
function findRowCodeColumn(sheet: XLSX.WorkSheet, posRow: number): number {
  const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1:A1");
  // データ行 (posRow より数行下) を1つ見て、資産(A)列より左側で
  // 短い英字コード ("A","Aa","Ea" 等) が入っている列を探す。
  const sampleRow = posRow + 2;
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = sheet[XLSX.utils.encode_cell({ r: sampleRow, c })];
    if (cell && typeof cell.v === "string" && ROW_CODE_PATTERN.test(cell.v.trim())) {
      return c;
    }
  }
  throw new Error("BOJ資金循環統計: 行コード列が見つかりません(表の様式が変わった可能性)");
}

/**
 * page1/page2 の2シート (同一表が列方向に分割されたもの) から生レコードを作る。
 * 行番号は page1/page2 で一致している前提で、page1 の行コード列を正とし、
 * page2 側の末尾コード列と一致することを突き合わせて検証する。
 */
function parseSectorTablePages(page1: XLSX.WorkSheet, page2: XLSX.WorkSheet): RawCellRecord[] {
  const posRow1 = findPositionRow(page1);
  // page2 側にも「資産(A)」見出しが存在すること自体を検証する (無ければ throw)。
  // 実際の列対応は buildColumnAssignments(page2) が内部で再計算する。
  findPositionRow(page2);
  const rowCodeCol1 = findRowCodeColumn(page1, posRow1);
  const range1 = XLSX.utils.decode_range(page1["!ref"] ?? "A1:A1");
  const range2 = XLSX.utils.decode_range(page2["!ref"] ?? "A1:A1");
  // page2 の行コード列は最終列 (末尾に部門コードとは別に行コードが繰り返される)。
  const rowCodeCol2 = range2.e.c;

  const colMap1 = buildColumnAssignments(page1);
  const colMap2 = buildColumnAssignments(page2);

  const records: RawCellRecord[] = [];
  const lastRow = Math.max(range1.e.r, range2.e.r);
  for (let r = posRow1 + 1; r <= lastRow; r++) {
    const rowCodeCell1 = page1[XLSX.utils.encode_cell({ r, c: rowCodeCol1 })];
    const rowCode = rowCodeCell1 ? String(rowCodeCell1.v).trim() : "";
    if (rowCode === "") continue; // 空行 (区切り) はスキップ

    // page2側の末尾コード列と突き合わせ、行がずれていないことを検証する。
    // ただし、この列には印刷時の見出し文字列等、行コードの形をしていない
    // 無関係なテキストが混入することがある (実データで確認: シート"2"の
    // O71セルに次表の見出し文字列が混入していた)。行コードの形
    // (ROW_CODE_PATTERN) に一致するときだけ突き合わせに使う。
    const rowCodeCell2 = page2[XLSX.utils.encode_cell({ r, c: rowCodeCol2 })];
    const rawRowCode2 = rowCodeCell2 ? String(rowCodeCell2.v).trim() : "";
    const rowCode2 = ROW_CODE_PATTERN.test(rawRowCode2) ? rawRowCode2 : "";
    if (rowCode2 !== "" && rowCode2 !== rowCode) {
      throw new Error(
        `BOJ資金循環統計: page1とpage2で行コードが一致しません(row=${r + 1}): ` +
          `page1="${rowCode}" page2="${rowCode2}" (表の様式が変わった可能性)`
      );
    }

    for (const [sheet, colMap] of [
      [page1, colMap1],
      [page2, colMap2],
    ] as const) {
      for (const [col, assignment] of colMap) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c: col })];
        if (!cell || cell.v === "" || cell.v === undefined) continue;
        if (typeof cell.v !== "number") {
          throw new Error(
            `BOJ資金循環統計: 数値であるべきセルが数値以外です (row=${r + 1}, rowCode=${rowCode}): ${JSON.stringify(cell.v)}`
          );
        }
        records.push({
          rowCode,
          sectorCode: assignment.sectorCode,
          position: assignment.position,
          value: cell.v,
        });
      }
    }
  }
  return records;
}

/** シート内の先頭数行に含まれるテキストを1つの文字列に連結する (タイトル検出用)。 */
function sheetTitleText(sheet: XLSX.WorkSheet, maxRows = 6): string {
  const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1:A1");
  const parts: string[] = [];
  for (let r = range.s.r; r <= Math.min(range.s.r + maxRows, range.e.r); r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (cell && String(cell.v).trim() !== "") parts.push(String(cell.v));
    }
  }
  return parts.join(" ");
}

export interface BojFlowOfFundsTable {
  period: BojQuarterPeriod;
  unit: string;
  records: RawCellRecord[];
}

export interface BojFlowOfFundsDocument {
  flow: BojFlowOfFundsTable;
  stock: BojFlowOfFundsTable;
}

const EXPECTED_UNIT_TEXT = "単位　億円";

function assertExpectedUnit(titleText: string, context: string): string {
  if (!titleText.includes(EXPECTED_UNIT_TEXT)) {
    throw new Error(
      `BOJ資金循環統計: ${context}の単位表記(「${EXPECTED_UNIT_TEXT}」)が見つかりません` +
        "(単位が変わった可能性があるため、値をそのまま使うのは危険です)"
    );
  }
  return "億円";
}

/**
 * 資金循環統計 速報Excel (sjpre.xlsx) から「（１）全体表」の
 * 金融取引表(フロー)・金融資産負債残高表(ストック)を抽出する純関数パーサ。
 *
 * ワークシート名 (例: "1","2","19","20") はテンプレートの内部コードで、将来
 * 変わりうるため固定名には依存しない。各シートの先頭数行のテキストから
 * 「１．金融取引表」「２．金融資産・負債残高表」を含み、かつ「（１）全体表」
 * である page1 シートを探し、その直後 (SheetNames上の次) を page2 として扱う。
 *
 * @throws 期待する見出し・シート構成が見つからない場合 (様式変更の可能性)
 */
export function parseBojFlowOfFunds(bytes: Uint8Array): BojFlowOfFundsDocument {
  const workbook = XLSX.read(bytes, { type: "array" });
  const names = workbook.SheetNames;

  function findPage1Index(sectionMarker: string): number {
    return names.findIndex((name) => {
      const sheet = workbook.Sheets[name];
      const title = sheetTitleText(sheet);
      return title.includes(sectionMarker) && title.includes("全体表");
    });
  }

  const flowIdx = findPage1Index("１．金融取引表");
  if (flowIdx < 0 || flowIdx + 1 >= names.length) {
    throw new Error(
      "BOJ資金循環統計: 「１．金融取引表」の全体表シートが見つかりません(様式が変わった可能性)"
    );
  }
  const stockIdx = findPage1Index("２．金融資産・負債残高表");
  if (stockIdx < 0 || stockIdx + 1 >= names.length) {
    throw new Error(
      "BOJ資金循環統計: 「２．金融資産・負債残高表」の全体表シートが見つかりません(様式が変わった可能性)"
    );
  }

  const flowPage1 = workbook.Sheets[names[flowIdx]];
  const flowPage2 = workbook.Sheets[names[flowIdx + 1]];
  const stockPage1 = workbook.Sheets[names[stockIdx]];
  const stockPage2 = workbook.Sheets[names[stockIdx + 1]];

  const flowTitle = sheetTitleText(flowPage1) + " " + sheetTitleText(flowPage2);
  const stockTitle = sheetTitleText(stockPage1) + " " + sheetTitleText(stockPage2);

  const flowPeriodMatch = flowTitle.match(/\d{4}年\s*\d{1,2}[〜~～\-−]\d{1,2}月期\s*[(（](?:速報|確報)[)）]/);
  if (!flowPeriodMatch) {
    throw new Error("BOJ資金循環統計: フロー表の期間見出しがシート内に見つかりません");
  }
  const stockPeriodMatch = stockTitle.match(/\d{4}年\s*\d{1,2}月末\s*[(（](?:速報|確報)[)）]/);
  if (!stockPeriodMatch) {
    throw new Error("BOJ資金循環統計: ストック表の期間見出しがシート内に見つかりません");
  }

  const flowPeriod = parseFlowPeriodLabel(flowPeriodMatch[0]);
  const stockPeriod = parseStockPeriodLabel(stockPeriodMatch[0]);
  const flowUnit = assertExpectedUnit(flowTitle, "フロー表");
  const stockUnit = assertExpectedUnit(stockTitle, "ストック表");

  const flowRecords = parseSectorTablePages(flowPage1, flowPage2);
  const stockRecords = parseSectorTablePages(stockPage1, stockPage2);

  return {
    flow: { period: flowPeriod, unit: flowUnit, records: flowRecords },
    stock: { period: stockPeriod, unit: stockUnit, records: stockRecords },
  };
}

// ---------------------------------------------------------------------------
// 観測ログ用の縦長レコードへの変換
// ---------------------------------------------------------------------------

export interface BojFlowOfFundsObservation {
  /** 対象期間 (例: "2026Q2") */
  period: string;
  /** BOJ_FLOW_OF_FUNDS_INDICATORS の key と一致 */
  indicatorKey: string;
  /** 区分。制度部門名 + 資産/負債 (例: "家計(資産)") */
  category: string;
  value: number;
  unit: string;
  /** この値がKPIの近似(代理指標)にとどまるか。資金循環統計は直接測定値のため常に false */
  isApproximate: boolean;
  /** この値が実測値ではなく推定値か。速報も含め常に false (公的統計の実測値) */
  isEstimated: boolean;
  /** 速報(preliminary)か確報(final)か。速報は将来の確報で改定されうる。 */
  vintage: BojVintage;
}

function periodLabel(p: { year: number; quarter: BojQuarter }): string {
  return `${p.year}Q${p.quarter}`;
}

/**
 * parseBojFlowOfFunds() の結果を、観測ログに書き込む縦長レコードへ変換する純関数。
 *
 * BOJ_INSTRUMENTS で採用した行コードのみを対象にし (指標として定義していない
 * その他の行は出力しない)、制度部門は葉コードのみ (集計コード2/3/331は除外、
 * 二重計上防止)。資産側・負債側は別カテゴリとして両方出力する
 * (値が存在する組み合わせのみ。欠損は欠損のまま出力しない=行自体を作らない)。
 */
export function toObservations(doc: BojFlowOfFundsDocument): BojFlowOfFundsObservation[] {
  const observations: BojFlowOfFundsObservation[] = [];
  for (const table of ["flow", "stock"] as const) {
    const { period, unit, records } = doc[table];
    const label = periodLabel(period);
    for (const record of records) {
      if (BOJ_AGGREGATE_SECTOR_CODES.has(record.sectorCode)) continue;
      const instrument = BOJ_INSTRUMENT_BY_ROW_CODE.get(record.rowCode);
      if (!instrument) continue; // この取得元が採用していない行コードは出力しない
      const sector = BOJ_SECTOR_BY_CODE.get(record.sectorCode as BojSectorCode);
      if (!sector) {
        throw new Error(
          `BOJ資金循環統計: 未知の制度部門コードです: ${record.sectorCode} (BOJ_SECTORSの更新が必要)`
        );
      }
      const positionLabel = record.position === "asset" ? "資産" : "負債";
      observations.push({
        period: label,
        indicatorKey: `boj_ffa_${instrument.instrumentKey}_${table}`,
        category: `${sector.label}(${positionLabel})`,
        value: record.value,
        unit,
        isApproximate: false,
        isEstimated: false,
        vintage: period.vintage,
      });
    }
  }
  return observations;
}

// ---------------------------------------------------------------------------
// ルール6: Notion 一次データ記録の入力を組み立てる純関数
// (実際の recordPrimaryData() 呼び出しは統合担当が行う。ここでは形だけ用意する)
// ---------------------------------------------------------------------------

export interface BojFlowOfFundsArchiveInput {
  service: string;
  key: string;
  source: string;
  metadata: Record<string, unknown>;
  files: Array<{ bytes: Uint8Array; filename: string; contentType: string }>;
}

/**
 * ルール6準拠のアーカイブ入力を組み立てる。
 * 冪等キーは対象四半期 (同じ四半期の速報→確報の更新は `force` で上書きする想定。
 * ここでは force フラグの決定は統合担当に委ねる)。
 */
export function buildArchiveInput(
  fetched: Pick<FetchedBojFlowOfFunds, "bytes" | "url">,
  doc: BojFlowOfFundsDocument
): BojFlowOfFundsArchiveInput {
  const label = periodLabel(doc.flow.period);
  return {
    service: "moneyflow",
    key: `boj-flow-of-funds-${label}-${doc.flow.period.vintage}`,
    source: fetched.url,
    metadata: {
      flowPeriod: doc.flow.period,
      stockPeriod: doc.stock.period,
      flowRecordCount: doc.flow.records.length,
      stockRecordCount: doc.stock.records.length,
      bytes: fetched.bytes.byteLength,
    },
    files: [
      {
        bytes: fetched.bytes,
        filename: `boj-sjpre-${label}.xlsx`,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    ],
  };
}
