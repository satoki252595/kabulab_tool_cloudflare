/**
 * 取得元: 国際収支統計 地域別（証券投資・直接投資、国・地域別、四半期）
 *
 * 財務省・日本銀行が共同作成する国際収支統計のうち、日本銀行「時系列統計
 * データ検索サイト」(stat-search.boj.or.jp) が一括ダウンロードで配布する
 * 「地域別国際収支（四半期）」CSV (regbp_q_jp.csv, ZIP 圧縮) を取得元とする。
 *
 * このファイルには、東証33業種のような国内業種別データではなく、日本から
 * 見て「どの国・地域」に対する資金の流れかが、直接投資・証券投資（株式・
 * 投資ファンド持分／債券）を含む金融収支の内訳として、資産（対外投資の
 * 純増）・負債（対内投資の純増）・ネット（資産−負債）の3方向で収録されて
 * いる。財務省サイト (mof.go.jp) の地域別国際収支ページは経常収支や金融収支
 * の「合計」までしか個別 CSV を配っておらず、直接投資・証券投資への内訳は
 * この日本銀行の一括ダウンロードでしか機械可読に取得できない
 * (2026-09-27 時点で実地調査済み)。
 *
 * - 出典: 日本銀行「時系列統計データ検索サイト」一括ダウンロード
 *   https://www.stat-search.boj.or.jp/info/dload.html
 *   (ダウンロード本体 URL は本ファイル内で都度解決する。固定名だが将来の
 *   変更に備えて resolveBopRegionalZipUrl() で毎回ページから解決する)
 * - 頻度: 四半期。対象四半期の最終月から数えて5か月後に公表 (例: 1〜3月期
 *   → 8月に公表)。翌年・翌々年5月に年次改訂 (遡及改定) がある。
 * - 利用条件: 統計数値そのものの利用を妨げる明文の禁止はないが、日本銀行
 *   本体サイトからの転載や公開サービスでの掲載には日本銀行調査統計局への
 *   事前通知と指定クレジット文言の掲示が求められる (同サイトの利用上の
 *   注意による)。今回の用途は個人利用に限定する前提。財務省側の統計数値
 *   自体は公共データ利用規約 (出典明記で商用利用・改変・再配布が自由) の
 *   対象。
 * - bot 対策: 確認されず。ブラウザ相当 User-Agent は不要 (単純な GET で
 *   200 が返る。JPX とは異なる)。それでも取得元を名乗るため UA は付与する。
 *
 * 本モジュールは Node 実行の取込スクリプト (scripts/moneyflow/ingest.ts 等)
 * からの利用を想定する (`node:zlib` を使うため。margin.ts と同じ位置づけ)。
 * Notion への一次データ記録・観測ログ書込はこのモジュールでは行わない
 * (bopRegionalArchiveInput() が入力を組み立てるのみ。実際の記録は統合担当が
 * `src/shared/notion-archive/` 経由で行う — CLAUDE.md ルール6)。
 */
import { inflateRawSync } from "node:zlib";

const UA = "kabulab-cf-moneyflow/1.0 (+https://kabulab-cf.satoki252595.workers.dev/)";

const DLOAD_PAGE_URL = "https://www.stat-search.boj.or.jp/info/dload.html";
const DLOAD_LABEL = "地域別国際収支（四半期）";
const ZIP_ENTRY_NAME = "regbp_q_jp.csv";

const EXPECTED_CATEGORY = "地域別国際収支（四半期）（6版基準）";
const EXPECTED_UNIT = "億円";

// ---------------------------------------------------------------------------
// 地域の分類 (CLAUDE.md ルール2: 未知の地域名は黙って通さず throw する)
// ---------------------------------------------------------------------------

/**
 * - world_total: 全地域合計 (「地域別合計」。個別地域の単純合計の検算に使える)
 * - country: 単一の国・地域 (相互に排他)
 * - continent_group: 大陸区分の計 (例: 「アジア計」。配下の country を含む)
 * - cross_cutting_group: 大陸区分を横断する集計 (例: 「EU」。country や
 *   continent_group と重複するため、これらを合算すると二重計上になる)
 * - other: 国・地域そのものではない区分 (国際機関・非分類)
 */
export type BopRegionKind =
  | "world_total"
  | "country"
  | "continent_group"
  | "cross_cutting_group"
  | "other";

export interface BopRegionDef {
  /** CSV 上の地域名 (日本語、そのまま区分値として使う) */
  name: string;
  kind: BopRegionKind;
}

/**
 * 日本銀行「地域別国際収支（四半期）」が収録する地域区分の全量 (2026-09-27
 * 時点で実データから確認した 47 区分)。ここに無い地域名が現れたら様式変更
 * とみなし throw する (extractBopRegionalObservations 参照)。
 */
export const BOP_REGIONS: readonly BopRegionDef[] = [
  { name: "地域別合計", kind: "world_total" },
  { name: "アジア計", kind: "continent_group" },
  { name: "中華人民共和国", kind: "country" },
  { name: "香港", kind: "country" },
  { name: "台湾", kind: "country" },
  { name: "大韓民国", kind: "country" },
  { name: "シンガポール", kind: "country" },
  { name: "タイ", kind: "country" },
  { name: "インドネシア", kind: "country" },
  { name: "マレーシア", kind: "country" },
  { name: "フィリピン", kind: "country" },
  { name: "ベトナム", kind: "country" },
  { name: "インド", kind: "country" },
  { name: "北米計", kind: "continent_group" },
  { name: "アメリカ合衆国", kind: "country" },
  { name: "カナダ", kind: "country" },
  { name: "中南米計", kind: "continent_group" },
  { name: "メキシコ", kind: "country" },
  { name: "ブラジル", kind: "country" },
  { name: "ケイマン諸島", kind: "country" },
  { name: "大洋州計", kind: "continent_group" },
  { name: "オーストラリア", kind: "country" },
  { name: "ニュージーランド", kind: "country" },
  { name: "欧州計", kind: "continent_group" },
  { name: "ドイツ", kind: "country" },
  { name: "英国", kind: "country" },
  { name: "フランス", kind: "country" },
  { name: "オランダ", kind: "country" },
  { name: "イタリア", kind: "country" },
  { name: "ベルギー", kind: "country" },
  { name: "ルクセンブルク", kind: "country" },
  { name: "スイス", kind: "country" },
  { name: "スウェーデン", kind: "country" },
  { name: "スペイン", kind: "country" },
  { name: "ロシア", kind: "country" },
  { name: "中東計", kind: "continent_group" },
  { name: "サウジアラビア", kind: "country" },
  { name: "アラブ首長国連邦", kind: "country" },
  { name: "イラン", kind: "country" },
  { name: "アフリカ計", kind: "continent_group" },
  { name: "南アフリカ共和国", kind: "country" },
  { name: "国際機関", kind: "other" },
  { name: "非分類", kind: "other" },
  { name: "OECD諸国", kind: "cross_cutting_group" },
  { name: "ASEAN", kind: "cross_cutting_group" },
  { name: "EU", kind: "cross_cutting_group" },
  { name: "東欧・ロシア等", kind: "cross_cutting_group" },
];

const BOP_REGION_BY_NAME = new Map(BOP_REGIONS.map((r) => [r.name, r]));

// ---------------------------------------------------------------------------
// 指標定義 (CLAUDE.md ルール7: 何を測るか・正確な定義・平易な説明を持つ)
// ---------------------------------------------------------------------------

export type BopRegionalMetricKey =
  | "bop_regional_direct_investment_net"
  | "bop_regional_direct_investment_asset"
  | "bop_regional_direct_investment_liability"
  | "bop_regional_portfolio_investment_net"
  | "bop_regional_portfolio_investment_asset"
  | "bop_regional_portfolio_investment_liability"
  | "bop_regional_portfolio_investment_equity_asset"
  | "bop_regional_portfolio_investment_equity_liability"
  | "bop_regional_portfolio_investment_debt_asset"
  | "bop_regional_portfolio_investment_debt_liability";

/** この取得元が測る現象の種類。すべて BPM6 の金融収支ベースのネットフロー。 */
export type BopRegionalFlowType = "net_flow";

export interface BopRegionalIndicatorDef {
  key: BopRegionalMetricKey;
  displayName: string;
  /** この指標が答える設計上の要件 (docs 計画の R1〜R4)。 */
  requirements: readonly string[];
  flowType: BopRegionalFlowType;
  /** 財務的に正確な定義。噛み砕きと引き換えに誤らせない (ルール1)。 */
  measures: string;
  /** 中学生でも分かる平易な説明 + 具体例 (ルール7)。 */
  plainExplanation: string;
  unit: "億円";
  sourceUrl: string;
  license: string;
  frequency: string;
  limitations: string;
}

const COMMON_LIMITATIONS =
  "地域区分には重複がある: 「アジア計」等の大陸区分は配下の個別国の合計と" +
  "必ずしも一致しない (未掲載国分を含みうる)。「OECD諸国」「ASEAN」「EU」" +
  "「東欧・ロシア等」は大陸区分を横断する集計で、大陸区分や個別国と重複する" +
  "ため単純合算すると二重計上になる。「国際機関」「非分類」は国・地域では" +
  "ない別区分。速報ではなく、翌年・翌々年5月の年次改訂で遡及改定されうる" +
  "確報ベースの計数。フロー統計であり、残高 (ストック) ではない。";

const COMMON_LICENSE =
  "財務省・日本銀行共同作成。統計数値自体の利用を妨げる明文の禁止はないが、" +
  "日本銀行サイトからの転載や公開サービスでの掲載には日本銀行調査統計局への" +
  "事前通知と指定クレジット文言の掲示が求められる。個人利用の範囲では通知" +
  "不要、公開する場合は要対応。";

const COMMON_FREQUENCY =
  "四半期 (年4回)。対象四半期の最終月から数えて5か月後に公表 " +
  "(例: 1〜3月期分は8月に公表)。翌年・翌々年5月に年次改訂。";

const COMMON_SOURCE_URL = "https://www.stat-search.boj.or.jp/info/dload.html";

export const BOP_REGIONAL_INDICATORS: readonly BopRegionalIndicatorDef[] = [
  {
    key: "bop_regional_direct_investment_net",
    displayName: "対外・対内直接投資の純増減（地域別・ネット）",
    requirements: ["R4"],
    flowType: "net_flow",
    measures:
      "国際収支マニュアル第6版ベースの金融収支のうち直接投資について、地域" +
      "別に「資産の増減（対外直接投資の実行−回収）」から「負債の増減（対内" +
      "直接投資の実行−回収）」を差し引いた純額。プラスは資産側の増加（資金" +
      "の対外流出）が負債側の増加（資金の対内流入）を上回っていることを示す" +
      "フロー統計 (ストックではない)。",
    plainExplanation:
      "日本企業がその国・地域の会社に出資・買収した金額と、逆にその国・地域" +
      "の企業や政府系ファンドが日本の会社に出資した金額の差。プラスなら" +
      "日本から出て行くお金の方が多く、マイナスなら逆（例: ある四半期に" +
      "+100億円なら、その分だけ日本からその国・地域への直接投資が、逆方向の" +
      "直接投資より多かったことを示す）。その四半期の「動き」であり、これ" +
      "までの投資の合計残高ではない。",
    unit: "億円",
    sourceUrl: COMMON_SOURCE_URL,
    license: COMMON_LICENSE,
    frequency: COMMON_FREQUENCY,
    limitations: COMMON_LIMITATIONS,
  },
  {
    key: "bop_regional_direct_investment_asset",
    displayName: "対外直接投資（資産側・地域別）",
    requirements: ["R4"],
    flowType: "net_flow",
    measures:
      "日本の居住者がその国・地域に対して行った直接投資の純増 (実行−回収)。" +
      "対外資産の増減であり、プラスは日本からその国・地域への資金の純流出" +
      "を意味する。",
    plainExplanation:
      "日本の会社や投資家が、その国・地域の会社に出資・買収した金額（回収" +
      "した分は差し引く）。日本から海外への一方向の投資規模を見る指標。",
    unit: "億円",
    sourceUrl: COMMON_SOURCE_URL,
    license: COMMON_LICENSE,
    frequency: COMMON_FREQUENCY,
    limitations: COMMON_LIMITATIONS,
  },
  {
    key: "bop_regional_direct_investment_liability",
    displayName: "対内直接投資（負債側・地域別）",
    requirements: ["R4"],
    flowType: "net_flow",
    measures:
      "その国・地域の居住者が日本に対して行った直接投資の純増 (実行−回収)。" +
      "対内負債の増減であり、プラスはその国・地域から日本への資金の純流入" +
      "を意味する。",
    plainExplanation:
      "その国・地域の会社や投資家が、日本の会社に出資・買収した金額（回収" +
      "した分は差し引く）。海外から日本への一方向の投資規模を見る指標。",
    unit: "億円",
    sourceUrl: COMMON_SOURCE_URL,
    license: COMMON_LICENSE,
    frequency: COMMON_FREQUENCY,
    limitations: COMMON_LIMITATIONS,
  },
  {
    key: "bop_regional_portfolio_investment_net",
    displayName: "対外・対内証券投資の純増減（地域別・ネット、株式＋債券）",
    requirements: ["R4"],
    flowType: "net_flow",
    measures:
      "金融収支のうち証券投資 (株式・投資ファンド持分＋債券) について、地域" +
      "別に資産の増減から負債の増減を差し引いた純額。直接投資と異なり経営" +
      "参加を伴わない証券への投資 (上場株・投信・国債・社債等) が対象。",
    plainExplanation:
      "日本の投資家がその国・地域の株式や債券を買い越した金額と、逆にその" +
      "国・地域の投資家が日本の株式や債券を買い越した金額の差。買収や" +
      "出資（直接投資）とは違い、経営に関与しない「証券」への投資が対象。",
    unit: "億円",
    sourceUrl: COMMON_SOURCE_URL,
    license: COMMON_LICENSE,
    frequency: COMMON_FREQUENCY,
    limitations: COMMON_LIMITATIONS,
  },
  {
    key: "bop_regional_portfolio_investment_asset",
    displayName: "対外証券投資（資産側・地域別、株式＋債券）",
    requirements: ["R4"],
    flowType: "net_flow",
    measures:
      "日本の居住者によるその国・地域の証券 (株式・投資ファンド持分＋債券)" +
      "への投資の純増 (取得−処分)。対外資産の増減。",
    plainExplanation:
      "日本の投資家（機関投資家や個人を含む）が、その国・地域の株式や債券" +
      "をどれだけ買い越したか。",
    unit: "億円",
    sourceUrl: COMMON_SOURCE_URL,
    license: COMMON_LICENSE,
    frequency: COMMON_FREQUENCY,
    limitations: COMMON_LIMITATIONS,
  },
  {
    key: "bop_regional_portfolio_investment_liability",
    displayName: "対内証券投資（負債側・地域別、株式＋債券）",
    requirements: ["R4"],
    flowType: "net_flow",
    measures:
      "その国・地域の居住者による日本の証券 (株式・投資ファンド持分＋債券)" +
      "への投資の純増 (取得−処分)。対内負債の増減。",
    plainExplanation:
      "その国・地域の投資家が、日本の株式や債券をどれだけ買い越したか。",
    unit: "億円",
    sourceUrl: COMMON_SOURCE_URL,
    license: COMMON_LICENSE,
    frequency: COMMON_FREQUENCY,
    limitations: COMMON_LIMITATIONS,
  },
  {
    key: "bop_regional_portfolio_investment_equity_asset",
    displayName: "対外証券投資（資産側・地域別、株式・投資ファンド持分のみ）",
    requirements: ["R4"],
    flowType: "net_flow",
    measures:
      "証券投資のうち株式・投資ファンド持分に限定した、日本の居住者による" +
      "その国・地域への投資の純増 (取得−処分)。債券は含まない。",
    plainExplanation:
      "日本の投資家が、その国・地域の「株」や「投資信託の持分」をどれだけ" +
      "買い越したか（国債・社債などの「債券」は含まない）。",
    unit: "億円",
    sourceUrl: COMMON_SOURCE_URL,
    license: COMMON_LICENSE,
    frequency: COMMON_FREQUENCY,
    limitations: COMMON_LIMITATIONS,
  },
  {
    key: "bop_regional_portfolio_investment_equity_liability",
    displayName: "対内証券投資（負債側・地域別、株式・投資ファンド持分のみ）",
    requirements: ["R4"],
    flowType: "net_flow",
    measures:
      "証券投資のうち株式・投資ファンド持分に限定した、その国・地域の居住者" +
      "による日本への投資の純増 (取得−処分)。債券は含まない。",
    plainExplanation:
      "その国・地域の投資家が、日本の「株」や「投資信託の持分」をどれだけ" +
      "買い越したか。",
    unit: "億円",
    sourceUrl: COMMON_SOURCE_URL,
    license: COMMON_LICENSE,
    frequency: COMMON_FREQUENCY,
    limitations: COMMON_LIMITATIONS,
  },
  {
    key: "bop_regional_portfolio_investment_debt_asset",
    displayName: "対外証券投資（資産側・地域別、債券のみ）",
    requirements: ["R4"],
    flowType: "net_flow",
    measures:
      "証券投資のうち債券に限定した、日本の居住者によるその国・地域への" +
      "投資の純増 (取得−処分)。株式・投資ファンド持分は含まない。",
    plainExplanation:
      "日本の投資家が、その国・地域の国債や社債などの「債券」をどれだけ" +
      "買い越したか（株は含まない）。",
    unit: "億円",
    sourceUrl: COMMON_SOURCE_URL,
    license: COMMON_LICENSE,
    frequency: COMMON_FREQUENCY,
    limitations: COMMON_LIMITATIONS,
  },
  {
    key: "bop_regional_portfolio_investment_debt_liability",
    displayName: "対内証券投資（負債側・地域別、債券のみ）",
    requirements: ["R4"],
    flowType: "net_flow",
    measures:
      "証券投資のうち債券に限定した、その国・地域の居住者による日本への" +
      "投資の純増 (取得−処分)。株式・投資ファンド持分は含まない。",
    plainExplanation:
      "その国・地域の投資家が、日本の国債や社債などの「債券」をどれだけ" +
      "買い越したか。",
    unit: "億円",
    sourceUrl: COMMON_SOURCE_URL,
    license: COMMON_LICENSE,
    frequency: COMMON_FREQUENCY,
    limitations: COMMON_LIMITATIONS,
  },
] as const;

// ---------------------------------------------------------------------------
// 期間 (四半期)
// ---------------------------------------------------------------------------

export interface BopRegionalPeriod {
  year: number;
  quarter: 1 | 2 | 3 | 4;
  /** 表示用ラベル (例: "2026Q1") */
  label: string;
}

const PERIOD_CODE_RE = /^(\d{4})(0[1-4])$/;

/**
 * CSV ヘッダの期間コード (例: "202601" = 2026年第1四半期) を検証しつつ
 * 変換する。形式が想定と違えば throw する (ルール2)。
 */
export function parseBopRegionalPeriodCode(code: string): BopRegionalPeriod {
  const m = PERIOD_CODE_RE.exec(code);
  if (!m) {
    throw new Error(
      `BOP地域別: 期間コードの形式が想定と異なります: "${code}" (期待形式: YYYYQQ 例 "202601")`
    );
  }
  const year = Number(m[1]);
  const quarter = Number(m[2]) as 1 | 2 | 3 | 4;
  return { year, quarter, label: `${year}Q${quarter}` };
}

/**
 * 公式アナウンス「対象四半期の最終月から数えて5か月後に公表」に基づく、
 * 参考の公表予定年月 (推測ではなく公表済みルールそのものを計算しているだけ)。
 * これはスキップ判定の事前フィルタに使う参考値であり、実際に公表された
 * かどうかの最終判断は isPeriodObserved() で実データの有無を見て行う。
 */
export function expectedBopRegionalPublicationMonth(
  year: number,
  quarter: 1 | 2 | 3 | 4
): { year: number; month: number } {
  const quarterEndMonthIndex0 = quarter * 3 - 1; // Q1→2(3月), Q2→5(6月), ...
  const totalMonthIndex0 = year * 12 + quarterEndMonthIndex0 + 5;
  return {
    year: Math.floor(totalMonthIndex0 / 12),
    month: (totalMonthIndex0 % 12) + 1,
  };
}

// ---------------------------------------------------------------------------
// CSV パース (純関数)
// ---------------------------------------------------------------------------

/** RFC4180 相当の1行 CSV パーサ (引用符内のカンマ・エスケープに対応)。 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

export interface BopRegionalRawRow {
  /** 日本銀行のデータコード (例: "BPBP6QFBCN2")。来歴用。 */
  code: string;
  /** 項目ラベル (例: "金融/証券投資/中華人民共和国/ネット")。 */
  label: string;
  /** 期間ごとの値。欠損 (未公表・非開示) は null のまま保持し、0 で埋めない。 */
  values: Array<number | null>;
}

export interface BopRegionalParsedCsv {
  periods: BopRegionalPeriod[];
  rows: BopRegionalRawRow[];
}

/**
 * 「地域別国際収支（四半期）」CSV (regbp_q_jp.csv、デコード済みテキスト) を
 * 型付きの行データへパースする純関数。列数不一致・区分名/単位の想定外・
 * 数値化できないセルは throw する (ルール2)。欠損セル (空文字) はその期間
 * だけ null にし、他の期間の値で埋めたりしない。
 */
export function parseBopRegionalCsvText(csvText: string): BopRegionalParsedCsv {
  const lines = csvText.split(/\r\n|\n|\r/);
  if (lines.length < 2) {
    throw new Error("BOP地域別 CSV: 行数が想定より少なすぎます (ヘッダのみ、または空)");
  }
  const header = parseCsvLine(lines[0]);
  if (header.length < 5) {
    throw new Error(`BOP地域別 CSV: ヘッダの列数が想定と異なります (${header.length} 列)`);
  }
  const periods = header.slice(4).map(parseBopRegionalPeriodCode);

  const rows: BopRegionalRawRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const fields = parseCsvLine(line);
    if (fields.length !== header.length) {
      throw new Error(
        `BOP地域別 CSV: ${i + 1} 行目の列数がヘッダと一致しません ` +
          `(${fields.length} / ${header.length}) — 様式変更の可能性`
      );
    }
    const [code, category, label, unit, ...valueFields] = fields;
    if (category !== EXPECTED_CATEGORY) {
      throw new Error(
        `BOP地域別 CSV: ${i + 1} 行目の区分名が想定外です: "${category}" ` +
          `(期待値: "${EXPECTED_CATEGORY}")`
      );
    }
    if (unit !== EXPECTED_UNIT) {
      throw new Error(
        `BOP地域別 CSV: ${i + 1} 行目の単位が想定外です: "${unit}" (期待値: "${EXPECTED_UNIT}")`
      );
    }
    const values = valueFields.map((raw, idx) => {
      // 実ファイルでの欠損表現は2種: 空文字 (系列が存在しない) と "NA"
      // (秘匿・非開示。同一行内で他の期間は数値というケースが実データに
      // 多数ある — 統計的秘匿による欠測であり「まだ集計されていない」とは
      // 別概念だが、どちらも「値が無い」ことは共通なので同じく null にする。
      // 0 など別の値へ読み替えない (ルール2)。
      if (raw === "" || raw === "NA") return null;
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        throw new Error(
          `BOP地域別 CSV: ${i + 1} 行目 ${idx + 1} 列目の値が数値でも欠損表現 ("" / "NA") でも` +
            `ありません: "${raw}"`
        );
      }
      return n;
    });
    rows.push({ code, label, values });
  }
  if (rows.length === 0) {
    throw new Error("BOP地域別 CSV: データ行が 0 件です");
  }
  return { periods, rows };
}

// ---------------------------------------------------------------------------
// ラベル分類 → 指標キー
// ---------------------------------------------------------------------------

type AssetClass =
  | "direct_investment"
  | "portfolio_investment"
  | "portfolio_investment_equity"
  | "portfolio_investment_debt";
type Direction = "net" | "asset" | "liability";

interface ClassifiedLabel {
  assetClass: AssetClass;
  direction: Direction;
  region: string;
}

// 判定順が重要: 株式・投資ファンド持分/債券の内訳は「証券投資」の一般形にも
// マッチしてしまうため、内訳の正規表現を先に試す。
const EQUITY_RE = /^金融\/証券投資\/株式・投資ファンド持分\/(.+)\/(ネット|資産|負債)$/;
const DEBT_RE = /^金融\/証券投資\/債券\/(.+)\/(ネット|資産|負債)$/;
const PORTFOLIO_RE = /^金融\/証券投資\/(.+)\/(ネット|資産|負債)$/;
const DIRECT_RE = /^金融\/直接投資\/(.+)\/(ネット|資産|負債)$/;

function directionFromSuffix(suffix: string): Direction {
  switch (suffix) {
    case "ネット":
      return "net";
    case "資産":
      return "asset";
    case "負債":
      return "liability";
    default:
      throw new Error(`BOP地域別: 未知の方向区分です: "${suffix}"`);
  }
}

/**
 * 項目ラベルを (資産クラス, 方向, 地域名) へ分類する。直接投資・証券投資
 * (株式/債券内訳を含む) 以外の項目 (経常収支・金融派生商品・その他投資等)
 * は対象外として null を返す (このモジュールのスコープ外。throw しない —
 * 未対応は「対象外」であって「異常」ではないため)。
 */
function classifyLabel(label: string): ClassifiedLabel | null {
  let m = EQUITY_RE.exec(label);
  if (m) {
    return {
      assetClass: "portfolio_investment_equity",
      region: m[1],
      direction: directionFromSuffix(m[2]),
    };
  }
  m = DEBT_RE.exec(label);
  if (m) {
    return {
      assetClass: "portfolio_investment_debt",
      region: m[1],
      direction: directionFromSuffix(m[2]),
    };
  }
  m = PORTFOLIO_RE.exec(label);
  if (m) {
    return {
      assetClass: "portfolio_investment",
      region: m[1],
      direction: directionFromSuffix(m[2]),
    };
  }
  m = DIRECT_RE.exec(label);
  if (m) {
    return {
      assetClass: "direct_investment",
      region: m[1],
      direction: directionFromSuffix(m[2]),
    };
  }
  return null;
}

const METRIC_KEY_MAP: Record<string, BopRegionalMetricKey> = {
  "direct_investment:net": "bop_regional_direct_investment_net",
  "direct_investment:asset": "bop_regional_direct_investment_asset",
  "direct_investment:liability": "bop_regional_direct_investment_liability",
  "portfolio_investment:net": "bop_regional_portfolio_investment_net",
  "portfolio_investment:asset": "bop_regional_portfolio_investment_asset",
  "portfolio_investment:liability": "bop_regional_portfolio_investment_liability",
  "portfolio_investment_equity:asset": "bop_regional_portfolio_investment_equity_asset",
  "portfolio_investment_equity:liability": "bop_regional_portfolio_investment_equity_liability",
  "portfolio_investment_debt:asset": "bop_regional_portfolio_investment_debt_asset",
  "portfolio_investment_debt:liability": "bop_regional_portfolio_investment_debt_liability",
};

function resolveMetricKey(assetClass: AssetClass, direction: Direction): BopRegionalMetricKey {
  const lookupKey = `${assetClass}:${direction}`;
  const metricKey = METRIC_KEY_MAP[lookupKey];
  if (!metricKey) {
    throw new Error(`BOP地域別: 未知の指標の組み合わせです: "${lookupKey}"`);
  }
  return metricKey;
}

// ---------------------------------------------------------------------------
// 観測ログ (縦長レコード)
// ---------------------------------------------------------------------------

/**
 * 観測ログ1行分。「期間・指標キー・区分（国・地域）・値・単位・近似か・
 * 推定か」の縦長形式 (docs 計画のフォーマットに合わせる)。
 */
export interface BopRegionalObservation {
  period: string;
  year: number;
  quarter: 1 | 2 | 3 | 4;
  metricKey: BopRegionalMetricKey;
  /** 区分: 国・地域名 (日本語、CSV 表記そのまま) */
  region: string;
  regionKind: BopRegionKind;
  value: number;
  unit: "億円";
  /** この取得元は実測値のみを扱うため常に false。 */
  approximate: false;
  /** この取得元は実測値のみを扱うため常に false。 */
  estimated: false;
  /** 来歴用: 元の日本銀行データコード。 */
  sourceCode: string;
}

/**
 * パース済み CSV から、直接投資・証券投資 (株式/債券内訳含む) の観測ログを
 * 抽出する純関数。対象外の項目 (経常収支等) は無視する。未知の地域名が
 * 現れた場合は様式変更とみなし throw する (ルール2)。欠損値 (null) の期間は
 * レコードを出力しない (0 で埋めない — 「欠損は欠損のまま」)。
 */
export function extractBopRegionalObservations(
  parsed: BopRegionalParsedCsv
): BopRegionalObservation[] {
  const out: BopRegionalObservation[] = [];
  for (const row of parsed.rows) {
    const classified = classifyLabel(row.label);
    if (!classified) continue;
    const regionDef = BOP_REGION_BY_NAME.get(classified.region);
    if (!regionDef) {
      throw new Error(
        `BOP地域別: 未知の地域名です「${classified.region}」` +
          `(row=${row.code}, label="${row.label}") — 様式変更の可能性があります`
      );
    }
    const metricKey = resolveMetricKey(classified.assetClass, classified.direction);
    row.values.forEach((value, i) => {
      if (value === null) return;
      const period = parsed.periods[i];
      out.push({
        period: period.label,
        year: period.year,
        quarter: period.quarter,
        metricKey,
        region: classified.region,
        regionKind: regionDef.kind,
        value,
        unit: "億円",
        approximate: false,
        estimated: false,
        sourceCode: row.code,
      });
    });
  }
  return out;
}

function periodSortKey(o: { year: number; quarter: number }): number {
  return o.year * 10 + o.quarter;
}

/** 観測ログの中で最新の期間ラベルを返す (0 件なら undefined)。 */
export function latestObservedPeriod(
  observations: readonly BopRegionalObservation[]
): string | undefined {
  if (observations.length === 0) return undefined;
  let best = observations[0];
  for (const o of observations) {
    if (periodSortKey(o) > periodSortKey(best)) best = o;
  }
  return best.period;
}

/**
 * 指定した四半期のデータが観測ログに (1件でも) 存在するか。
 * 「まだ公表されていない」の最終判定はこれで行う (実データの有無)。
 * expectedBopRegionalPublicationMonth() は事前スキップ判定の参考値に過ぎない。
 */
export function isPeriodObserved(
  observations: readonly BopRegionalObservation[],
  year: number,
  quarter: 1 | 2 | 3 | 4
): boolean {
  return observations.some((o) => o.year === year && o.quarter === quarter);
}

// ---------------------------------------------------------------------------
// ZIP 展開 (依存追加なしの最小 ZIP リーダー。stored(0) / deflate(8) のみ対応)
// ---------------------------------------------------------------------------
// services/yuho-quant/src/services/edinet/zip.ts と同じ設計 (EOCD → Central
// Directory → Local File Header)。ZIP64・暗号化・未知の圧縮法は throw する。

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

function findEocdOffset(buf: Buffer): number {
  const minPos = Math.max(0, buf.length - (0xffff + 22));
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error("BOP地域別 ZIP: End Of Central Directory が見つかりません (壊れた ZIP)");
}

function unzipBopRegional(buf: Buffer): Map<string, Buffer> {
  const eocd = findEocdOffset(buf);
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || totalEntries === 0xffff) {
    throw new Error("BOP地域別 ZIP: ZIP64 形式は未対応です");
  }

  const entries = new Map<string, Buffer>();
  let p = cdOffset;
  for (let n = 0; n < totalEntries; n++) {
    if (buf.readUInt32LE(p) !== CD_SIG) {
      throw new Error(`BOP地域別 ZIP: Central Directory ヘッダ破損 (entry ${n})`);
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lfhOffset = buf.readUInt32LE(p + 42);
    if (lfhOffset === 0xffffffff || compSize === 0xffffffff) {
      throw new Error("BOP地域別 ZIP: ZIP64 形式は未対応です");
    }
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue;

    if (buf.readUInt32LE(lfhOffset) !== LFH_SIG) {
      throw new Error(`BOP地域別 ZIP: Local File Header 破損 (${name})`);
    }
    const lfhNameLen = buf.readUInt16LE(lfhOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(lfhOffset + 28);
    const dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
    const rawData = buf.subarray(dataStart, dataStart + compSize);

    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(rawData);
    } else if (method === 8) {
      data = inflateRawSync(rawData);
    } else {
      throw new Error(`BOP地域別 ZIP: 未対応の圧縮法 method=${method} (${name})`);
    }
    if (data.length !== uncompSize) {
      throw new Error(
        `BOP地域別 ZIP: 展開サイズ不一致 ${name} expected=${uncompSize} got=${data.length}`
      );
    }
    entries.set(name, data);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// 取得 (fetch)
// ---------------------------------------------------------------------------

/**
 * 一括ダウンロードページの HTML (デコード済みテキスト) から「地域別国際収支
 * （四半期）」の ZIP へのリンクを抽出する純関数。ページ構成が変わりリンクが
 * 見つからない場合は throw する (ルール2)。
 */
export function extractBopRegionalZipHref(html: string): string {
  const re = new RegExp(`<a href="([^"]+)">${DLOAD_LABEL}</a>`);
  const m = re.exec(html);
  if (!m) {
    throw new Error(
      `BOP地域別: 一括ダウンロードページに「${DLOAD_LABEL}」のリンクが見つかりません ` +
        `— ページ構成が変わった可能性があります`
    );
  }
  const href = m[1];
  if (!href.endsWith(".zip")) {
    throw new Error(`BOP地域別: 想定外のファイル形式です: "${href}" (.zip を期待)`);
  }
  return href;
}

/**
 * 一括ダウンロードページから「地域別国際収支（四半期）」の ZIP リンクを
 * 解決する。ページ構成が変わりリンクが見つからない場合は throw する。
 */
export async function resolveBopRegionalZipUrl(): Promise<string> {
  const res = await fetch(DLOAD_PAGE_URL, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    throw new Error(
      `BOP地域別: 一括ダウンロードページの取得に失敗しました: HTTP ${res.status} (${DLOAD_PAGE_URL})`
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const html = new TextDecoder("shift_jis").decode(bytes);
  const href = extractBopRegionalZipHref(html);
  return new URL(href, DLOAD_PAGE_URL).toString();
}

export interface BopRegionalFetchResult {
  /** shift_jis からデコード済みの CSV テキスト。 */
  csvText: string;
  /** 取得した ZIP の実体バイト列 (ルール6: Notion への実体アップロード用)。 */
  zipBytes: Uint8Array;
  /** 解決済みの取得元 URL (来歴用)。 */
  sourceUrl: string;
  /** 取得日時 (ISO 8601)。 */
  fetchedAt: string;
}

/**
 * ZIP バイト列 → 中の CSV を shift_jis でデコードしたテキスト。
 * fetchBopRegionalData() の展開処理を切り出したもの (ネットワークなしで
 * フィクスチャの実 ZIP から直接テストできるように公開する)。
 */
export function decodeBopRegionalZip(zipBytes: Uint8Array): string {
  const entries = unzipBopRegional(Buffer.from(zipBytes));
  const csvBuf = entries.get(ZIP_ENTRY_NAME);
  if (!csvBuf) {
    throw new Error(
      `BOP地域別: ZIP に想定エントリ「${ZIP_ENTRY_NAME}」が見つかりません ` +
        `(実エントリ: ${[...entries.keys()].join(", ") || "(なし)"})`
    );
  }
  return new TextDecoder("shift_jis").decode(csvBuf);
}

/**
 * 「地域別国際収支（四半期）」ZIP を取得し、中の CSV を shift_jis で
 * デコードして返す。ZIP 内に想定エントリが無ければ throw する。
 */
export async function fetchBopRegionalData(): Promise<BopRegionalFetchResult> {
  const url = await resolveBopRegionalZipUrl();
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    throw new Error(`BOP地域別: ZIP の取得に失敗しました: HTTP ${res.status} (${url})`);
  }
  const zipBytes = new Uint8Array(await res.arrayBuffer());
  const csvText = decodeBopRegionalZip(zipBytes);
  return { csvText, zipBytes, sourceUrl: url, fetchedAt: new Date().toISOString() };
}

/**
 * ルール6: Notion 一次データ記録の入力を組み立てる純関数。実際の記録
 * (recordPrimaryData 呼び出し) はこのモジュールでは行わない。
 * キーは最新観測期間で冪等 (`boj-bop-regional-YYYYQn`)。ファイルは ZIP 実体。
 */
export function bopRegionalArchiveInput(
  result: Pick<BopRegionalFetchResult, "zipBytes" | "sourceUrl">,
  observations: readonly BopRegionalObservation[]
): {
  service: string;
  key: string;
  source: string;
  metadata: Record<string, unknown>;
  files: Array<{ bytes: Uint8Array; filename: string; contentType: string }>;
} {
  const latest = latestObservedPeriod(observations);
  if (!latest) {
    throw new Error("BOP地域別: 観測レコードが 0 件のため一次データ記録キーを決定できません");
  }
  return {
    service: "moneyflow",
    key: `boj-bop-regional-${latest}`,
    source: result.sourceUrl,
    metadata: {
      latestPeriod: latest,
      observationCount: observations.length,
      bytes: result.zipBytes.byteLength,
    },
    files: [
      {
        bytes: result.zipBytes,
        filename: `regbp_q_jp-${latest}.zip`,
        contentType: "application/zip",
      },
    ],
  };
}
