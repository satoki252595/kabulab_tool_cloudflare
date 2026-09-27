/**
 * moneyflow 取得元アダプタ: 財務省「対外及び対内証券売買契約等の状況 (指定報告機関ベース)」
 * (`../sources/mof-portfolio-flows.ts`) を Phase 1 の Notion 3 DB へつなぐ。
 *
 * ## spec (独立に公表される 2 ファイルを別々の spec にする)
 *   - `mof-portfolio-flows-weekly`  … 週次 CSV (week.csv)。集計週は日曜〜土曜、通常は翌週木曜に公表
 *   - `mof-portfolio-flows-monthly` … 月次 CSV (montha1.csv)。通常は翌月 8〜12 日頃に公表
 * 公表のタイミングが違うため 1 spec にまとめない (まとめると毎週、月次の行まで送り直す)。
 *
 * ## 冪等キー (期間 + 版)
 * 週次 `mof-portfolio-flows-weekly-YYYY-Www-updated-YYYY-MM-DD`
 * (最新週の最終日=土曜の ISO 週 + CSV 見出しの「最終更新日」)、
 * 月次 `mof-portfolio-flows-monthly-YYYY-MM-updated-YYYY-MM-DD` (最新の公表済み月 + 最終更新日)。
 * どちらのファイルも「固定 URL を毎回上書きし、中に 2005 年 1 月からの全期間の時系列が入る」
 * 方式で、軽い一覧ページや API は無い (公表予定ページはあるが、予定は変わりうると原本に
 * 明記されている)。そのため `resolve()` で本体 CSV を取得して最新期間からキーを決め、
 * `fetch()` はそのバイト列をそのまま返す (二重に取りに行かない)。
 * 最新期間が同じままでも財務省がファイルを差し替えれば (訂正) 最終更新日が変わるので、
 * 版 (最終更新日) をキーに含めて別バッチとして取り込み直す (統一規約「改訂されうる取得元は版も含める」)。
 * 最終更新日は見出しの和暦 (「最終更新日  令和8年9月17日」) と英語 (「Final Update  September 17, 2026」)
 * の両方を読み、食い違えば throw する (取得元モジュールは見出しの列配置・単位は検査するが最終更新日は読まないため、アダプタで読む)。
 *
 * ## 1 バッチの中身 (行数の上限)
 * 1 期間 = 2 方向 (対外/対内) × 11 系列 (株式・投資ファンド持分/中長期債/短期債 の取得・処分・
 * ネット + 小計ネット + 合計ネット) = 22 行。全期間 (週次 約1,130 週・月次 約260 か月) は
 * 行数の目安 (約 600 行) を大きく超えるため、**最新期間を含む直近 13 週 (286 行) /
 * 直近 12 か月 (264 行)** だけを観測行にする (固定規則)。毎回この窓を送り直すのは、
 * 取込を休んだ期間の埋め戻しと、原資料が過去の期間を訂正した場合の上書き (upsert) のため。
 *
 * ## 単位・区分・前期比
 * - 原資料は億円 (整数) → 円に換算 (×100,000,000)
 * - 区分は `対外証券投資 / 株式・投資ファンド持分` のように「方向 / 資産」。区分種別は最も
 *   細かい軸の「資産クラス」(小計・合計も資産クラスの軸上の集計値なので「資産クラス」)
 * - 前期比は同じファイル内の直前の期間 (前の週・前の月) の同じ系列との差を円で持つ
 *   (ファイル自体に前期の値があるため。窓の先頭の期間も、窓の 1 つ前の期間がファイルにある)
 * - 近似フラグ false (居住者⇔非居住者間の証券売買そのものの集計で、代理指標・残高・推計ではない)、
 *   実測推定は「実測」(指定報告機関からの報告の集計値)
 *
 * ## 取得について (モジュール API の制約)
 * 取得元モジュールには 2 ファイルを同時に取る `fetchMofPortfolioFlowsRaw()` しか無く、
 * 1 ファイルだけ取る関数が無い。取得処理 (UA・HTTP エラー処理) をモジュールに一元化したまま
 * にするため、各 spec の `resolve()` はこれを呼び、自分のファイルだけを使う (もう一方の
 * ファイルはその spec のバッチとして記録されるので、ここでは保管しない)。
 */
import {
  MOF_PORTFOLIO_FLOWS_INDEX_URL,
  MOF_PORTFOLIO_FLOWS_INDICATORS,
  MOF_PORTFOLIO_FLOWS_MONTHLY_URL,
  MOF_PORTFOLIO_FLOWS_SCHEDULE_URL,
  MOF_PORTFOLIO_FLOWS_WEEKLY_URL,
  decodeMofCsv,
  fetchMofPortfolioFlowsRaw,
  parseMofMonthlyFlows,
  parseMofWeeklyFlows,
  type MofAssetClass,
  type MofFlowDirection,
  type MofFlowFrequency,
  type MofFlowIndicatorKey,
  type MofFlowMetric,
  type MofIndicatorDefinition,
  type MofPortfolioFlowsParseResult,
} from "../sources/mof-portfolio-flows.js";
import type {
  IndicatorDefInput,
  MoneyflowCategoryKind,
  MoneyflowFlowType,
} from "../../../../src/shared/notion-archive/index.js";
import { isoWeekLabelOf, isoWeekToDateRange } from "../iso-week.js";
import {
  monthRange,
  requireSpecFile,
  type FetchedBatch,
  type MoneyflowSourceSpec,
  type ObservationDraft,
  type ResolvedBatch,
  type SpecFile,
} from "../source-spec.js";

export const MOF_PORTFOLIO_FLOWS_WEEKLY_SPEC_NAME = "mof-portfolio-flows-weekly";
export const MOF_PORTFOLIO_FLOWS_MONTHLY_SPEC_NAME = "mof-portfolio-flows-monthly";

/** 1 バッチで記録する週数 (最新週を含む直近 N 週)。固定規則。 */
export const MOF_WEEKLY_WINDOW_WEEKS = 13;
/** 1 バッチで記録する月数 (最新月を含む直近 N か月)。固定規則。 */
export const MOF_MONTHLY_WINDOW_MONTHS = 12;

/**
 * 週次の更新停止の検知: 最新週の最終日 (土曜) が実行日 (JST) の N 日より前なら throw する。
 * 通常は集計週の翌週木曜 (最終日の 5 日後) に公表され、祝日 (年末年始・大型連休) で
 * 最大 10 日前後まで遅れる。公表直前の最新週は「1 週前 + 公表の遅れ」で最大 18 日前後に
 * なるので、1 回分の公表遅れも許したうえで余裕を持たせて 35 日とする。
 */
export const MOF_WEEKLY_MAX_AGE_DAYS = 35;
/**
 * 月次の更新停止の検知: 最新月が「実行月 (JST) − N か月」より前なら throw する。
 * 通常は翌月 8〜12 日頃の公表で、最新月は実行月の 1〜2 か月前。1 回分の遅れを許して 3。
 */
export const MOF_MONTHLY_MAX_LAG_MONTHS = 3;

const OKU_YEN = 100_000_000;
const CSV_CONTENT_TYPE = "text/csv";
const DAY_MS = 86_400_000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 区分 (方向 × 資産) と系列の並び
// ---------------------------------------------------------------------------

/** 方向 (モジュールの識別子) → 区分ラベルの粗い軸。並び順 = 出力順。 */
const DIRECTIONS: ReadonlyArray<readonly [MofFlowDirection, string]> = [
  ["outward", "対外証券投資"],
  ["inward", "対内証券投資"],
];
/** 資産 (モジュールの識別子) → 区分ラベルの細かい軸。 */
const ASSET_CLASSES: ReadonlyArray<readonly [MofAssetClass, string]> = [
  ["equity", "株式・投資ファンド持分"],
  ["long_term_bond", "中長期債"],
  ["subtotal", "小計(株式・投資ファンド持分+中長期債)"],
  ["short_term_bond", "短期債"],
  ["total", "合計(株式・投資ファンド持分+中長期債+短期債)"],
];
const DIRECTION_LABELS: ReadonlyMap<string, string> = new Map(DIRECTIONS);
const ASSET_CLASS_LABELS: ReadonlyMap<string, string> = new Map(ASSET_CLASSES);

/**
 * 原資料の 1 方向 11 列の並び (取得・処分・ネット…小計ネット…合計ネット)。出力順もこれに揃え、
 * 1 期間の最後の行が「対内証券投資 / 合計 のネット」になる (バッチ全体の最後の行 = 取込完了の印)。
 * 小計・合計は原資料にネットしか無い。
 */
const SERIES: ReadonlyArray<readonly [MofAssetClass, MofFlowMetric]> = [
  ["equity", "acquisition"],
  ["equity", "disposition"],
  ["equity", "net"],
  ["long_term_bond", "acquisition"],
  ["long_term_bond", "disposition"],
  ["long_term_bond", "net"],
  ["subtotal", "net"],
  ["short_term_bond", "acquisition"],
  ["short_term_bond", "disposition"],
  ["short_term_bond", "net"],
  ["total", "net"],
];
/** 1 期間に揃っているべき行数 (2 方向 × 11 系列)。 */
const ROWS_PER_PERIOD = DIRECTIONS.length * SERIES.length;
const EXPECTED_SERIES: ReadonlySet<string> = new Set(
  DIRECTIONS.flatMap(([dir]) => SERIES.map(([asset, metric]) => `${dir}|${asset}|${metric}`))
);

export interface MofCategoryInfo {
  label: string;
  kind: MoneyflowCategoryKind;
}

/**
 * 方向・資産の識別子を観測ログの区分に変換する。
 * @throws 既知の方向 (outward/inward)・資産 (5 区分) 以外 (取得元モジュールの区分が増えた・変わった) の場合
 */
export function mofCategoryInfo(direction: string, assetClass: string): MofCategoryInfo {
  const dir = DIRECTION_LABELS.get(direction);
  if (!dir) {
    throw new Error(
      `[mof-portfolio-flows] 未知の方向です: ${JSON.stringify(direction)} (既知: ${[...DIRECTION_LABELS.keys()].join(", ")})`
    );
  }
  const asset = ASSET_CLASS_LABELS.get(assetClass);
  if (!asset) {
    throw new Error(
      `[mof-portfolio-flows] 未知の資産区分です: ${JSON.stringify(assetClass)} (既知: ${[...ASSET_CLASS_LABELS.keys()].join(", ")})`
    );
  }
  return { label: `${dir} / ${asset}`, kind: "資産クラス" };
}

// ---------------------------------------------------------------------------
// 指標定義 (モジュールの定義文・限界を引き継ぎ、単位換算後の説明と取込の限界を足す)
// ---------------------------------------------------------------------------

const METRIC_MODULE_KEY: Readonly<Record<MofFlowMetric, MofFlowIndicatorKey>> = {
  net: "mof_net_flow",
  acquisition: "mof_gross_acquisition",
  disposition: "mof_gross_disposition",
};
const METRICS: readonly MofFlowMetric[] = ["net", "acquisition", "disposition"];

/** 指標キー (モジュールのキー + 頻度)。週次と月次で頻度が違うので別の指標にする。 */
export function mofIndicatorKey(metric: MofFlowMetric, frequency: MofFlowFrequency): string {
  return `${METRIC_MODULE_KEY[metric]}_${frequency}`;
}

function moduleDefinition(key: MofFlowIndicatorKey): MofIndicatorDefinition {
  const hits = MOF_PORTFOLIO_FLOWS_INDICATORS.filter((d) => d.key === key);
  if (hits.length !== 1) {
    throw new Error(`[mof-portfolio-flows] 取得元モジュールの指標定義 ${key} が ${hits.length} 件です (1 件であるべき)`);
  }
  return hits[0] as MofIndicatorDefinition;
}

const COMMON_LIMITATIONS =
  "原資料は億円単位(四捨五入した整数)で、円に換算しても1億円未満の精度は無い。" +
  "JPXの投資部門別売買状況の「海外投資家」や、国際収支統計の証券投資とは集計の対象・計上方法が違うため、数値は一致しないのが普通。" +
  "出典: 財務省「対外及び対内証券売買契約等の状況(指定報告機関ベース)」。" +
  "公共データ利用規約(第1.0版、PDL1.0)に基づき利用し、出典の記載が必要。" +
  "ここでは単位を億円から円に換算して記録している(加工)。";

interface FrequencyText {
  frequencyLabel: "週次" | "月次";
  /** 説明文で使う「1 期間」の言い方。 */
  period: string;
  /** 例文で使う期間の言い方。 */
  periodShort: string;
  /** 前期比の比較相手。 */
  prev: string;
  limitations: string;
}

const FREQUENCY_TEXT: Readonly<Record<MofFlowFrequency, FrequencyText>> = {
  weekly: {
    frequencyLabel: "週次",
    period: "1週間(日曜〜土曜)",
    periodShort: "週",
    prev: "前の週",
    limitations:
      `1回の取込で記録するのは最新週を含む直近${MOF_WEEKLY_WINDOW_WEEKS}週だけ` +
      "(原資料には2005年1月からの全履歴があるが、1回に書ける行数の上限のため取り込まない)。" +
      "原資料は毎回、全期間の時系列を同じURLのファイル(week.csv)に上書きする方式で、" +
      "ファイル見出しの最終更新日が変われば(最新週が同じままの訂正でも)取り込み直し、" +
      `直近${MOF_WEEKLY_WINDOW_WEEKS}週の中の訂正は上書きされるが、${MOF_WEEKLY_WINDOW_WEEKS}週より前の週の訂正は反映されない。` +
      "対象期間のラベル(YYYY-Www)は集計週の最終日(土曜)が属するISO週(月曜始まり)で、" +
      "財務省の集計週(日曜〜土曜)とは1日ずれる(実際の集計期間は期間開始・期間終了の日付を見る)。" +
      "月をまたぐ週があるため、週次を足し合わせても月次の値と一致するとは限らない。" +
      "公表は通常、集計週の翌週の木曜(祝日などで後ろにずれる)午前8時50分。" +
      `ファイルの最新週の最終日が実行日(日本時間)の${MOF_WEEKLY_MAX_AGE_DAYS}日より前のままなら、` +
      "更新停止やURL変更を疑って取込を失敗させる。",
  },
  monthly: {
    frequencyLabel: "月次",
    period: "1か月(暦月)",
    periodShort: "月",
    prev: "前の月",
    limitations:
      `1回の取込で記録するのは最新月を含む直近${MOF_MONTHLY_WINDOW_MONTHS}か月だけ` +
      "(原資料には2005年1月からの全履歴があるが、1回に書ける行数の上限のため取り込まない)。" +
      "原資料は毎回、全期間の時系列を同じURLのファイル(montha1.csv)に上書きする方式で、" +
      "ファイル見出しの最終更新日が変われば(最新月が同じままの訂正でも)取り込み直し、" +
      `直近${MOF_MONTHLY_WINDOW_MONTHS}か月の中の訂正は上書きされるが、${MOF_MONTHLY_WINDOW_MONTHS}か月より前の月の訂正は反映されない。` +
      "原資料には当年のまだ来ていない月の行が値の空欄のまま置かれているが、公表前の月は記録しない(0として扱わない)。" +
      "原資料の暦年・年度の集計行と、末尾の「対外ネット−対内ネット」の2列は取り込まない。" +
      "公表は通常、翌月の8〜12日頃の午前8時50分。" +
      `ファイルの最新月が実行月(日本時間)の${MOF_MONTHLY_MAX_LAG_MONTHS}か月前より古いままなら、` +
      "更新停止やURL変更を疑って取込を失敗させる。",
  },
};

interface MetricText {
  displayName: string;
  flowType: MoneyflowFlowType;
  description(t: FrequencyText): string;
}

const METRIC_TEXT: Readonly<Record<MofFlowMetric, MetricText>> = {
  net: {
    displayName: "対外・対内証券投資 ネット(取得−処分)",
    flowType: "純買い越し",
    description: (t) =>
      "財務省が集計した、日本と海外の間の証券(株式・投資信託などのファンド持分・債券)の売買について、" +
      `「取得(買い)−処分(売り)」を差し引いた額(ネット)。${t.period}の流れ(フロー)で、` +
      "保有残高(ストック)ではなく、値上がり・値下がりによる増減も含まない。" +
      "区分の「対内証券投資」は海外の投資家(非居住者)が日本の証券を売買した分で、" +
      "プラスなら海外の投資家が日本の証券を差し引きで買い越した(海外から日本へ向かうお金)、マイナスなら売り越した。" +
      "「対外証券投資」は日本の投資家(居住者)が海外の証券を売買した分で、" +
      "プラスなら日本の投資家が海外の証券を買い越した(日本から海外へ向かうお金)、マイナスなら売り越した。" +
      "どちらも「プラス=取得超(買い越し)」だが、お金の向きは対内と対外で逆になる点に注意。" +
      `例: 対内証券投資の株式・投資ファンド持分が−1兆円なら、その${t.periodShort}に海外の投資家が日本の株式等を差し引き1兆円売り越した。` +
      "区分の資産は、株式・投資ファンド持分/中長期債(発行時の満期が1年を超える債券)/小計(その2つの計)/" +
      "短期債(発行時の満期が1年以内の債券)/合計(3つの計)。" +
      `単位は円(原資料の億円を換算)。前期比は同じファイルにある${t.prev}の値との差(円)。`,
  },
  acquisition: {
    displayName: "対外・対内証券投資 取得額(グロス)",
    flowType: "売買代金",
    description: (t) =>
      "財務省が集計した、日本と海外の間の証券売買のうち、取得(買い)の側の契約金額だけを足した総額(グロス)。" +
      `${t.period}の流れ(フロー)。` +
      "区分の「対内証券投資」なら海外の投資家(非居住者)が日本の証券を買った総額、" +
      "「対外証券投資」なら日本の投資家(居住者)が海外の証券を買った総額。" +
      "売った分(処分)を差し引いていないので、お金が正味どちら向きに動いたか(ネット)は分からない。" +
      "取引の規模・活発さの目安で、例えば取得額が40兆円でも同じ期間の処分額も40兆円なら、正味の流れはほぼゼロ。" +
      "区分の資産は株式・投資ファンド持分/中長期債/短期債の3つだけ(小計・合計は原資料にネットしか無い)。" +
      `単位は円(原資料の億円を換算)。前期比は同じファイルにある${t.prev}の取得額との差(円)。`,
  },
  disposition: {
    displayName: "対外・対内証券投資 処分額(グロス)",
    flowType: "売買代金",
    description: (t) =>
      "財務省が集計した、日本と海外の間の証券売買のうち、処分(売り)の側の契約金額だけを足した総額(グロス)。" +
      `${t.period}の流れ(フロー)。` +
      "区分の「対内証券投資」なら海外の投資家(非居住者)が日本の証券を売った総額、" +
      "「対外証券投資」なら日本の投資家(居住者)が海外の証券を売った総額。" +
      "買った分(取得)を差し引いていないので、お金が正味どちら向きに動いたか(ネット)は分からない。" +
      "取得額と並べて見ると売買の活発さが分かり、取得額−処分額がネットになる(四捨五入で1億円程度ずれることがある)。" +
      "区分の資産は株式・投資ファンド持分/中長期債/短期債の3つだけ(小計・合計は原資料にネットしか無い)。" +
      `単位は円(原資料の億円を換算)。前期比は同じファイルにある${t.prev}の処分額との差(円)。`,
  },
};

function buildIndicators(frequency: MofFlowFrequency): readonly IndicatorDefInput[] {
  const t = FREQUENCY_TEXT[frequency];
  return METRICS.map((metric) => {
    const m = METRIC_TEXT[metric];
    const def = moduleDefinition(METRIC_MODULE_KEY[metric]);
    return {
      key: mofIndicatorKey(metric, frequency),
      displayName: `${m.displayName}・${t.frequencyLabel}`,
      requirement: "R4",
      flowType: m.flowType,
      description: `${m.description(t)}正確な定義: ${def.definition}`,
      sourceUrl: MOF_PORTFOLIO_FLOWS_INDEX_URL,
      license: "attribution-required",
      frequency: t.frequencyLabel,
      limitations: `${def.limitations}${t.limitations}${COMMON_LIMITATIONS}`,
    };
  });
}

export const MOF_PORTFOLIO_FLOWS_WEEKLY_INDICATORS: readonly IndicatorDefInput[] = buildIndicators("weekly");
export const MOF_PORTFOLIO_FLOWS_MONTHLY_INDICATORS: readonly IndicatorDefInput[] = buildIndicators("monthly");

// ---------------------------------------------------------------------------
// 日付ユーティリティ (純関数)
// ---------------------------------------------------------------------------

function isoDateToUtc(iso: string, context: string): Date {
  const d = new Date(`${iso}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== iso) {
    throw new Error(`${context}: 日付が YYYY-MM-DD ではありません: ${iso}`);
  }
  return d;
}

function addDays(iso: string, days: number, context: string): string {
  return new Date(isoDateToUtc(iso, context).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

function jstNow(now: Date): Date {
  const t = now.getTime();
  if (!Number.isFinite(t)) throw new Error(`[mof-portfolio-flows] 不正な実行日時です: ${String(now)}`);
  return new Date(t + JST_OFFSET_MS);
}

const YM_RE = /^(\d{4})-(\d{2})$/;

/** "YYYY-MM" を delta か月ずらす。 */
function shiftMonth(yyyyMm: string, delta: number): string {
  const m = YM_RE.exec(yyyyMm);
  if (!m) throw new Error(`[mof-portfolio-flows] YYYY-MM ではありません: ${yyyyMm}`);
  const index = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// 頻度ごとの設定
// ---------------------------------------------------------------------------

/** 観測ログ上の 1 期間。 */
interface PeriodSlot {
  /** モジュールの期間キー (週次 "YYYY-MM-DD_YYYY-MM-DD" / 月次 "YYYY-MM")。 */
  moduleKey: string;
  /** 観測ログの期間ラベル (週次 "YYYY-Www" / 月次 "YYYY-MM")。 */
  label: string;
  start: string;
  end: string;
}

interface FrequencyConfig {
  frequency: MofFlowFrequency;
  specName: string;
  url: string;
  windowSize: number;
  indicators: readonly IndicatorDefInput[];
  parse(bytes: Uint8Array, sourceUrl: string): MofPortfolioFlowsParseResult;
  /** 期間の形を検証して観測ログのラベルを付ける。 */
  slotOf(moduleKey: string, start: string, end: string, context: string): PeriodSlot;
  /** `next` が `prev` の直後の期間か。 */
  isNext(prev: PeriodSlot, next: PeriodSlot, context: string): boolean;
  /** キーの期間ラベルの形式を検証する (実在しない週・月なら throw)。 */
  checkLabel(label: string, context: string): void;
  labelPattern: string;
  /** 最新期間の鮮度を検証する。 */
  assertFresh(latest: PeriodSlot, now: Date, context: string): void;
}

const WEEKLY: FrequencyConfig = {
  frequency: "weekly",
  specName: MOF_PORTFOLIO_FLOWS_WEEKLY_SPEC_NAME,
  url: MOF_PORTFOLIO_FLOWS_WEEKLY_URL,
  windowSize: MOF_WEEKLY_WINDOW_WEEKS,
  indicators: MOF_PORTFOLIO_FLOWS_WEEKLY_INDICATORS,
  parse: parseMofWeeklyFlows,
  slotOf(moduleKey, start, end, context) {
    const startDate = isoDateToUtc(start, context);
    if (startDate.getUTCDay() !== 0 || addDays(start, 6, context) !== end) {
      throw new Error(`${context}: 週 ${moduleKey} が日曜〜土曜の7日間ではありません (${start}〜${end}。様式変更の可能性)`);
    }
    return { moduleKey, label: isoWeekLabelOf(isoDateToUtc(end, context)), start, end };
  },
  isNext: (prev, next, context) => next.start === addDays(prev.end, 1, context),
  checkLabel(label) {
    isoWeekToDateRange(label);
  },
  labelPattern: "\\d{4}-W\\d{2}",
  assertFresh(latest, now, context) {
    const today = jstNow(now).toISOString().slice(0, 10);
    if (latest.end >= today) {
      throw new Error(
        `${context}: 最新週の最終日 ${latest.end} が実行日 ${today} (JST) 以降です ` +
          `(集計週が終わる前に公表されることは無い。ファイルか時計の異常)`
      );
    }
    const oldest = addDays(today, -MOF_WEEKLY_MAX_AGE_DAYS, context);
    if (latest.end < oldest) {
      throw new Error(
        `${context}: ファイルの最新週が ${latest.start}〜${latest.end} のままです ` +
          `(実行日 ${today} の ${MOF_WEEKLY_MAX_AGE_DAYS} 日前 ${oldest} より古い)。` +
          `財務省の更新停止・URL 変更を確認してください (${MOF_PORTFOLIO_FLOWS_SCHEDULE_URL})`
      );
    }
  },
};

const MONTHLY: FrequencyConfig = {
  frequency: "monthly",
  specName: MOF_PORTFOLIO_FLOWS_MONTHLY_SPEC_NAME,
  url: MOF_PORTFOLIO_FLOWS_MONTHLY_URL,
  windowSize: MOF_MONTHLY_WINDOW_MONTHS,
  indicators: MOF_PORTFOLIO_FLOWS_MONTHLY_INDICATORS,
  parse: parseMofMonthlyFlows,
  slotOf(moduleKey, start, end, context) {
    const range = monthRange(moduleKey);
    if (range.start !== start || range.end !== end) {
      throw new Error(`${context}: 月 ${moduleKey} の期間 ${start}〜${end} が暦月 ${range.start}〜${range.end} と一致しません`);
    }
    return { moduleKey, label: moduleKey, start, end };
  },
  isNext: (prev, next) => next.label === shiftMonth(prev.label, 1),
  checkLabel(label) {
    monthRange(label);
  },
  labelPattern: "\\d{4}-\\d{2}",
  assertFresh(latest, now, context) {
    const jst = jstNow(now);
    const current = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}`;
    if (latest.label >= current) {
      throw new Error(
        `${context}: ファイルの最新月 ${latest.label} が実行月 ${current} (JST) 以降です ` +
          `(その月の分は翌月にしか公表されない。ファイルか時計の異常)`
      );
    }
    const required = shiftMonth(current, -MOF_MONTHLY_MAX_LAG_MONTHS);
    if (latest.label < required) {
      throw new Error(
        `${context}: ファイルの最新月が ${latest.label} のままです ` +
          `(実行月 ${current} の ${MOF_MONTHLY_MAX_LAG_MONTHS} か月前 ${required} 分まで無い)。` +
          `財務省の更新停止・URL 変更を確認してください (${MOF_PORTFOLIO_FLOWS_SCHEDULE_URL})`
      );
    }
  },
};

// ---------------------------------------------------------------------------
// 解析結果の検証と索引 (純関数)
// ---------------------------------------------------------------------------

function contextOf(cfg: FrequencyConfig): string {
  return `[${cfg.specName}]`;
}

function checkFrequency(cfg: FrequencyConfig, parsed: MofPortfolioFlowsParseResult): void {
  if (parsed.frequency !== cfg.frequency) {
    throw new Error(`${contextOf(cfg)} 解析結果の頻度が ${parsed.frequency} です (${cfg.frequency} であるべき)`);
  }
}

/** 公表済みの最新期間 (期間キー最大の行)。 */
function latestSlot(cfg: FrequencyConfig, parsed: MofPortfolioFlowsParseResult): PeriodSlot {
  const context = contextOf(cfg);
  checkFrequency(cfg, parsed);
  const first = parsed.rows[0];
  if (!first) throw new Error(`${context} 公表済みのデータ行が 0 件です`);
  let latest = first;
  for (const r of parsed.rows) if (r.periodKey > latest.periodKey) latest = r;
  return cfg.slotOf(latest.periodKey, latest.periodStart, latest.periodEnd, context);
}

interface IndexedFile {
  /** 窓の 1 つ前の期間 (前期比の比較相手) + 窓の期間。古い順。長さ = windowSize + 1。 */
  slots: PeriodSlot[];
  latest: PeriodSlot;
  /** 値 (億円)。無ければ throw。 */
  value(moduleKey: string, direction: MofFlowDirection, asset: MofAssetClass, metric: MofFlowMetric): number;
}

/**
 * 解析結果を検証して索引を作る。
 * @throws 未知の方向・資産・指標・単位、同じ系列の重複、1 期間の行の欠け、
 *         公表済みの期間より前に未公表 (全欄空欄) の期間がある、窓に必要な期間が無い・連続していない場合
 */
function indexParsed(cfg: FrequencyConfig, parsed: MofPortfolioFlowsParseResult): IndexedFile {
  const context = contextOf(cfg);
  checkFrequency(cfg, parsed);
  const values = new Map<string, number>();
  const periods = new Map<string, { start: string; end: string; rows: number }>();
  for (const r of parsed.rows) {
    const where = `${context} ${r.periodKey} ${r.direction}/${r.assetClass}/${r.metric}`;
    if (r.frequency !== cfg.frequency) throw new Error(`${where}: 行の頻度が ${r.frequency} です`);
    if ((r.unit as string) !== "億円") throw new Error(`${where}: 未知の単位です: ${JSON.stringify(r.unit)}`);
    mofCategoryInfo(r.direction, r.assetClass);
    if (!EXPECTED_SERIES.has(`${r.direction}|${r.assetClass}|${r.metric}`)) {
      throw new Error(`${where}: 想定外の系列です (小計・合計はネットのみ、指標は取得/処分/ネットのみ)`);
    }
    if (!Number.isSafeInteger(r.value)) throw new Error(`${where}: 値が整数ではありません (${r.value})`);
    const k = `${r.periodKey}|${r.direction}|${r.assetClass}|${r.metric}`;
    if (values.has(k)) throw new Error(`${where}: 同じ期間・系列の行が重複しています`);
    values.set(k, r.value);
    const p = periods.get(r.periodKey);
    if (!p) {
      periods.set(r.periodKey, { start: r.periodStart, end: r.periodEnd, rows: 1 });
    } else {
      if (p.start !== r.periodStart || p.end !== r.periodEnd) {
        throw new Error(`${where}: 同じ期間キーで集計期間が違います (${p.start}〜${p.end} と ${r.periodStart}〜${r.periodEnd})`);
      }
      p.rows += 1;
    }
  }
  const keys = [...periods.keys()].sort();
  for (const k of keys) {
    const rows = periods.get(k)?.rows;
    if (rows !== ROWS_PER_PERIOD) {
      throw new Error(`${context} 期間 ${k} の行が ${rows} 件です (${ROWS_PER_PERIOD} 件であるべき)`);
    }
  }
  const latestKey = keys[keys.length - 1];
  if (latestKey === undefined) throw new Error(`${context} 公表済みのデータ行が 0 件です`);
  const early = parsed.unpublishedPeriods.filter((u) => u <= latestKey);
  if (early.length > 0) {
    throw new Error(
      `${context} 公表済みの最新期間 ${latestKey} より前に値が全欄空欄の期間があります (${early.join(", ")})。` +
        `未公表の予定行は最新期間より後にしか無いはずなので、様式変更か原資料の異常を疑ってください`
    );
  }
  if (keys.length < cfg.windowSize + 1) {
    throw new Error(
      `${context} 公表済みの期間が ${keys.length} 件しかありません (直近 ${cfg.windowSize} 期間 + 前期比用の 1 期間が必要)`
    );
  }
  const slots = keys.slice(keys.length - (cfg.windowSize + 1)).map((k) => {
    const p = periods.get(k);
    if (!p) throw new Error(`${context} 期間 ${k} の索引がありません`);
    return cfg.slotOf(k, p.start, p.end, context);
  });
  for (let i = 1; i < slots.length; i += 1) {
    const prev = slots[i - 1] as PeriodSlot;
    const next = slots[i] as PeriodSlot;
    if (!cfg.isNext(prev, next, context)) {
      throw new Error(
        `${context} 期間 ${prev.moduleKey} の次が ${next.moduleKey} で、連続していません (抜けている期間がある。様式変更の可能性)`
      );
    }
  }
  return {
    slots,
    latest: slots[slots.length - 1] as PeriodSlot,
    value(moduleKey, direction, asset, metric) {
      const v = values.get(`${moduleKey}|${direction}|${asset}|${metric}`);
      if (v === undefined) throw new Error(`${context} ${moduleKey} ${direction}/${asset}/${metric} の行がありません`);
      return v;
    },
  };
}

/** 億円 → 円 (整数のまま換算できることを確かめる)。 */
function okuYenToYen(v: number, context: string): number {
  const yen = v * OKU_YEN;
  if (!Number.isSafeInteger(yen)) throw new Error(`${context}: 円換算の結果が安全な整数の範囲を超えます (${v} 億円)`);
  return yen;
}

// ---------------------------------------------------------------------------
// キー・ファイル名
// ---------------------------------------------------------------------------

function batchFilename(key: string): string {
  return `${key}.csv`;
}

const ENGLISH_MONTHS: readonly string[] = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
/** 見出しの「最終更新日  令和8年9月17日」。令和元年は「元」。 */
const UPDATED_JA_RE = /最終更新日\s*令和\s*(元|\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
/** 見出しの「Final Update  September  17 , 2026」。 */
const UPDATED_EN_RE = /Final Update\s+([A-Za-z]+)\s+(\d{1,2})\s*,\s*(\d{4})/g;

function isoDateOf(year: number, month: number, day: number, context: string): string {
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  isoDateToUtc(iso, context);
  return iso;
}

/**
 * CSV 見出しの「最終更新日」(財務省がファイルを差し替えた日 = 版) を YYYY-MM-DD で返す。
 * 和暦と英語の両方が 1 回ずつあり、同じ日を指していることを確かめる。
 * @throws どちらかが無い・2 回以上ある・実在しない日付・和暦と英語が食い違う場合 (様式変更の可能性)
 */
export function mofFileUpdatedOn(bytes: Uint8Array, context: string): string {
  const text = decodeMofCsv(bytes);
  const ja = [...text.matchAll(UPDATED_JA_RE)];
  const en = [...text.matchAll(UPDATED_EN_RE)];
  if (ja.length !== 1 || en.length !== 1) {
    throw new Error(
      `${context} 見出しの最終更新日が読めません (和暦 ${ja.length} 件・英語 ${en.length} 件。各 1 件であるべき。様式変更の可能性)`
    );
  }
  const [, eraYear, jaMonth, jaDay] = ja[0] as RegExpMatchArray;
  const [, enMonthName, enDay, enYear] = en[0] as RegExpMatchArray;
  const reiwa = eraYear === "元" ? 1 : Number(eraYear);
  const jaIso = isoDateOf(2018 + reiwa, Number(jaMonth), Number(jaDay), `${context} 最終更新日(和暦)`);
  const enMonth = ENGLISH_MONTHS.indexOf(String(enMonthName));
  if (enMonth < 0) throw new Error(`${context} 最終更新日(英語)の月名が不明です: ${JSON.stringify(enMonthName)}`);
  const enIso = isoDateOf(Number(enYear), enMonth + 1, Number(enDay), `${context} 最終更新日(英語)`);
  if (jaIso !== enIso) {
    throw new Error(`${context} 最終更新日の和暦 ${jaIso} と英語 ${enIso} が食い違います`);
  }
  return jaIso;
}

/**
 * 最終更新日が最新期間の終了日より後であることを確かめる (期間が終わる前にその期間の値は公表されない)。
 * @throws 最終更新日が最新期間の終了日以前の場合 (見出しと本体の食い違い)
 */
function assertUpdatedAfterPeriod(updatedOn: string, latest: PeriodSlot, context: string): void {
  if (updatedOn <= latest.end) {
    throw new Error(
      `${context} 最終更新日 ${updatedOn} が最新期間 ${latest.label} (${latest.start}〜${latest.end}) の終了日以前です ` +
        `(見出しと本体の食い違い。様式変更の可能性)`
    );
  }
}

function batchKey(cfg: FrequencyConfig, latest: PeriodSlot, updatedOn: string): string {
  return `${cfg.specName}-${latest.label}-updated-${updatedOn}`;
}

function parseKey(cfg: FrequencyConfig, key: string): { label: string; updatedOn: string } {
  const m = new RegExp(`^${cfg.specName}-(${cfg.labelPattern})-updated-(\\d{4}-\\d{2}-\\d{2})$`).exec(key);
  const label = m?.[1];
  const updatedOn = m?.[2];
  if (label === undefined || updatedOn === undefined) {
    throw new Error(
      `${contextOf(cfg)} 冪等キーの形式が不正です (${cfg.specName}-${cfg.frequency === "weekly" ? "YYYY-Www" : "YYYY-MM"}-updated-YYYY-MM-DD であるべき): ${key}`
    );
  }
  cfg.checkLabel(label, contextOf(cfg));
  isoDateToUtc(updatedOn, `${contextOf(cfg)} 冪等キーの最終更新日`);
  return { label, updatedOn };
}

// ---------------------------------------------------------------------------
// toObservations / resolve
// ---------------------------------------------------------------------------

function observationsOf(cfg: FrequencyConfig, key: string, files: readonly SpecFile[]): ObservationDraft[] {
  const context = contextOf(cfg);
  const { label, updatedOn } = parseKey(cfg, key);
  const file = requireSpecFile(files, (n) => n === batchFilename(key), `${context} 財務省 ${cfg.frequency} CSV`);
  const indexed = indexParsed(cfg, cfg.parse(file.bytes, cfg.url));
  if (indexed.latest.label !== label) {
    throw new Error(
      `${context} キー ${key} の期間 ${label} とファイルの最新期間 ${indexed.latest.label} ` +
        `(${indexed.latest.start}〜${indexed.latest.end}) が一致しません`
    );
  }
  const fileUpdatedOn = mofFileUpdatedOn(file.bytes, context);
  if (fileUpdatedOn !== updatedOn) {
    throw new Error(`${context} キー ${key} の版 (最終更新日 ${updatedOn}) とファイルの最終更新日 ${fileUpdatedOn} が一致しません`);
  }
  assertUpdatedAfterPeriod(updatedOn, indexed.latest, context);
  const out: ObservationDraft[] = [];
  for (let i = 1; i < indexed.slots.length; i += 1) {
    const prev = indexed.slots[i - 1] as PeriodSlot;
    const cur = indexed.slots[i] as PeriodSlot;
    for (const [direction] of DIRECTIONS) {
      for (const [asset, metric] of SERIES) {
        const category = mofCategoryInfo(direction, asset);
        const ctx = `${context} ${cur.label} ${category.label} ${metric}`;
        const value = indexed.value(cur.moduleKey, direction, asset, metric);
        const prevValue = indexed.value(prev.moduleKey, direction, asset, metric);
        out.push({
          period: cur.label,
          periodStart: cur.start,
          periodEnd: cur.end,
          indicatorKey: mofIndicatorKey(metric, cfg.frequency),
          category: category.label,
          categoryKind: category.kind,
          value: okuYenToYen(value, ctx),
          unit: "円",
          changeFromPrev: okuYenToYen(value - prevValue, `${ctx} の前期差`),
          approximate: false,
          measureKind: "実測",
        });
      }
    }
  }
  return out;
}

async function downloadCsv(cfg: FrequencyConfig): Promise<{ bytes: Uint8Array; url: string }> {
  // モジュールには 1 ファイルだけ取る関数が無いため、両方を取って自分の分を使う (ファイル冒頭の説明)。
  const raw = await fetchMofPortfolioFlowsRaw();
  return cfg.frequency === "weekly" ? raw.weekly : raw.monthly;
}

async function resolveOf(cfg: FrequencyConfig, now: Date): Promise<ResolvedBatch> {
  const context = contextOf(cfg);
  const dl = await downloadCsv(cfg);
  const parsed = cfg.parse(dl.bytes, dl.url);
  const latest = latestSlot(cfg, parsed);
  cfg.assertFresh(latest, now, context);
  const updatedOn = mofFileUpdatedOn(dl.bytes, context);
  assertUpdatedAfterPeriod(updatedOn, latest, context);
  const today = jstNow(now).toISOString().slice(0, 10);
  if (updatedOn > today) {
    throw new Error(`${context} 最終更新日 ${updatedOn} が実行日 ${today} (JST) より後です (ファイルか時計の異常)`);
  }
  const key = batchKey(cfg, latest, updatedOn);
  const batch: FetchedBatch = {
    key,
    source: dl.url,
    metadata: {
      url: dl.url,
      indexUrl: MOF_PORTFOLIO_FLOWS_INDEX_URL,
      scheduleUrl: MOF_PORTFOLIO_FLOWS_SCHEDULE_URL,
      frequency: cfg.frequency,
      latestPeriod: latest.label,
      latestPeriodStart: latest.start,
      latestPeriodEnd: latest.end,
      fileUpdatedOn: updatedOn,
      windowSize: cfg.windowSize,
      unpublishedPeriods: parsed.unpublishedPeriods,
      parsedRowCount: parsed.rows.length,
      encoding: "Shift_JIS",
      bytes: dl.bytes.byteLength,
      resolvedAt: now.toISOString(),
      license: "公共データ利用規約 (第1.0版、PDL1.0)。出典: 財務省「対外及び対内証券売買契約等の状況」",
    },
    files: [{ bytes: dl.bytes, filename: batchFilename(key), contentType: CSV_CONTENT_TYPE }],
  };
  return { key, fetch: async () => batch };
}

function specOf(cfg: FrequencyConfig): MoneyflowSourceSpec {
  return {
    name: cfg.specName,
    indicators: cfg.indicators,
    resolve: (now) => resolveOf(cfg, now),
    toObservations: ({ key, files }) => observationsOf(cfg, key, files),
  };
}

export const mofPortfolioFlowsWeeklySpec: MoneyflowSourceSpec = specOf(WEEKLY);
export const mofPortfolioFlowsMonthlySpec: MoneyflowSourceSpec = specOf(MONTHLY);

/** この取得元の全 spec (取込 CLI の登録用。週次 → 月次の順)。 */
export const MOF_PORTFOLIO_FLOWS_SPECS: readonly MoneyflowSourceSpec[] = [
  mofPortfolioFlowsWeeklySpec,
  mofPortfolioFlowsMonthlySpec,
];
