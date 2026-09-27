/**
 * moneyflow アダプタ: 世界の主要株価指数・為替・金利・金・原油の週次騰落 (Phase 5 世界の概況)。
 *
 * 取得元モジュール `../sources/global-indices.ts` (取得・解析・独自の指標定義) を
 * `MoneyflowSourceSpec` (`../source-spec.ts`) に揃える。規約は `./README.md`。
 * 対象のモジュール API は verify/global-indices の 4d11769 以降 (週の決め方・週足の集計・
 * 取得時の応答検査を直した版: `resolveLatestCompletedWeek` / `resolveWeeklyChangeForPeriod`)。
 * b683c80 以降、取得時点スナップショットは常に除外される (週足の終値が欠落した週は
 * スナップショットで代用されず、週足なし = 行なしになる)。
 *
 * ## spec
 * `global-indices` の 1 本。モジュールの固定カタログ 16 銘柄 (`GLOBAL_INDEX_CATALOG`) の
 * Yahoo Finance 週足チャート応答 JSON 16 ファイルで 1 バッチ。指標は 17 件
 * (16 銘柄の週次騰落率 + 米10年国債利回りのポイント差)。
 *
 * ## 冪等キー・対象週
 * `global-indices-<YYYY-Www>`。週は「`now` の時点で終わっている直近の ISO 週 (月曜〜日曜、
 * UTC の日曜 23:59:59.999 を過ぎたもの)」で、`resolve(now)` がモジュールの
 * `resolveLatestCompletedWeek` だけで決める (取得元への通信なし。Yahoo のチャート API は
 * 公表ラグが無いので、週が終われば取れる)。平日の定時実行では月曜の初回だけ取得し、
 * 火〜金は保管済みとして取得元へ行かない。
 *
 * ## 1 バッチの中身 (固定の規則)
 * 対象週とその前の 12 週 (計 13 週) × 17 指標 = 最大 221 行。毎週の取込で 13 週分を
 * 記録し直す (Yahoo 側の修正を反映し、取込が止まった週も 12 週前までなら後から埋まる)。
 * 各週の値はモジュールの `resolveWeeklyChangeForPeriod` (取引所の現地時間の暦週で集計した
 * Yahoo の週足の終値と、その銘柄に週足のある直前の週との比較)。休場で週足の無い週
 * (`no_bar_in_period`) はその銘柄の行を作らない (0 で埋めない)。ただし対象週とその前の週の
 * 両方に週足が無い銘柄は、銘柄の廃止・シンボル変更を疑って throw する。記録する 13 週の
 * どの週でも、比較元が 2 週より前 (2 週以上続けて週足が無い) なら同じく throw する。
 * 取得は `range=6mo` (モジュール既定の 3mo では 13 週 + 比較元の 1 週に足りない)。
 */
import type {
  IndicatorDefInput,
  MoneyflowCategoryKind,
  MoneyflowUnit,
  PrimaryFile,
} from "../../../../src/shared/notion-archive/index.js";
import {
  requireSpecFile,
  type FetchedBatch,
  type MoneyflowSourceSpec,
  type ObservationDraft,
  type ResolvedBatch,
  type SpecFile,
} from "../source-spec.js";
import {
  GLOBAL_INDEX_CATALOG,
  GLOBAL_INDEX_INDICATORS,
  fetchGlobalIndexWeeklyChart,
  parseGlobalIndexWeeklyChart,
  resolveLatestCompletedWeek,
  resolveObservationPeriod,
  resolveWeeklyChangeForPeriod,
  toGlobalIndexObservationRows,
  type GlobalIndexCatalogEntry,
  type GlobalIndexChartSnapshot,
  type MoneyflowIndicatorDefinition,
  type MoneyflowObservationRow,
  type ObservationPeriod,
  type WeeklyChangeResult,
} from "../sources/global-indices.js";

export const GLOBAL_INDICES_SPEC_NAME = "global-indices";
/** Yahoo Chart API の `range`。13 週 + 比較元の週を確実に含む長さ (約 26 週)。 */
export const GLOBAL_INDICES_CHART_RANGE = "6mo";
/** 1 バッチで記録する週の数 (対象週を含む)。 */
export const GLOBAL_INDICES_WEEKS_PER_BATCH = 13;

const TNX_POINT_INDICATOR_KEY = "global_tnx_weekly_change_pt";
const PCT_INDICATOR_RE = /^global_(.+)_weekly_change_pct$/;
const KEY_RE = /^global-indices-(\d{4}-W\d{2})$/;
const WEEK_LABEL_RE = /^(\d{4})-W(\d{2})$/;
const DAY_MS = 86_400_000;
/** Yahoo Finance のデータは個人利用に限る (README の規約: personal-only (JPX・Yahoo 等))。 */
const YAHOO_LICENSE = "personal-only" as const;
const YAHOO_QUOTE_BASE = "https://finance.yahoo.com/quote/";

const tag = `[${GLOBAL_INDICES_SPEC_NAME}]`;

// ---------------------------------------------------------------------------
// 週 (ISO 週) の扱い
// ---------------------------------------------------------------------------

function weekBefore(period: ObservationPeriod): ObservationPeriod {
  return resolveObservationPeriod("week", new Date(Date.parse(`${period.start}T00:00:00.000Z`) - DAY_MS));
}

/**
 * `YYYY-Www` から ISO 週の期間を作る。
 * @throws 形式が違う・その年に存在しない週番号 (例: 52 週しかない年の W53) の場合。
 */
export function weekPeriodFromLabel(label: string): ObservationPeriod {
  const m = WEEK_LABEL_RE.exec(label);
  if (!m) throw new Error(`${tag} 週のラベルが YYYY-Www ではありません: ${label}`);
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) throw new Error(`${tag} 週番号が 1〜53 ではありません: ${label}`);
  // 1 月 4 日を含む週が第 1 週 (ISO 8601)。
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Dow = new Date(jan4).getUTCDay() || 7;
  const monday = jan4 - (jan4Dow - 1) * DAY_MS + (week - 1) * 7 * DAY_MS;
  const period = resolveObservationPeriod("week", new Date(monday));
  if (period.label !== label) {
    throw new Error(`${tag} 存在しない ISO 週です: ${label} (計算上は ${period.label})`);
  }
  return period;
}

/** 対象週を最後にした、記録する週の並び (古い順、`GLOBAL_INDICES_WEEKS_PER_BATCH` 週)。 */
export function globalIndicesBatchWeeks(target: ObservationPeriod): ObservationPeriod[] {
  const weeks: ObservationPeriod[] = [target];
  while (weeks.length < GLOBAL_INDICES_WEEKS_PER_BATCH) {
    weeks.unshift(weekBefore(weeks[0] as ObservationPeriod));
  }
  return weeks;
}

// ---------------------------------------------------------------------------
// キー・ファイル名
// ---------------------------------------------------------------------------

export function globalIndicesBatchKey(target: ObservationPeriod): string {
  // ラベルから作り直して一致を確かめる (週でない期間を渡されたら throw)。
  const week = weekPeriodFromLabel(target.label);
  if (week.start !== target.start || week.end !== target.end) {
    throw new Error(`${tag} ISO 週ではない期間です: ${JSON.stringify(target)}`);
  }
  return `${GLOBAL_INDICES_SPEC_NAME}-${target.label}`;
}

function parseBatchKey(key: string): ObservationPeriod {
  const m = KEY_RE.exec(key);
  if (!m) throw new Error(`${tag} キーの形式が違います (global-indices-YYYY-Www): ${key}`);
  return weekPeriodFromLabel(m[1] as string);
}

/** 保管ファイル名 (銘柄のカタログキー + 対象週)。キーだけから決まる。 */
export function globalIndicesFilename(catalogKey: string, weekLabel: string): string {
  return `global-indices-${catalogKey}-${weekLabel}.json`;
}

// ---------------------------------------------------------------------------
// 指標定義 (モジュールの定義 → IndicatorDefInput)
// ---------------------------------------------------------------------------

interface InstrumentText {
  /** 何の値か (説明欄に入れる)。 */
  what: string;
  /** 銘柄固有の限界 (限界欄に入れる。無ければ空文字)。 */
  caveat: string;
}

/**
 * 各銘柄の応答の通貨 (`meta.currency`、2026-09-27 取得の実ファイルで確認)。モジュールの
 * カタログと 1 対 1 で、過不足があれば読み込み時に throw する。解析時に応答の通貨と
 * 突き合わせ、違えば throw する (取り違え・様式変更の検知)。
 */
export const GLOBAL_INDICES_EXPECTED_CURRENCY: Readonly<Record<string, string>> = {
  gspc: "USD",
  ixic: "USD",
  stoxx50e: "EUR",
  ftse: "GBP",
  gdaxi: "EUR",
  hsi: "HKD",
  sse: "CNY",
  ks11: "KRW",
  bsesn: "INR",
  n225: "JPY",
  "topix-etf": "JPY",
  jpy: "JPY",
  eurusd: "USD",
  gold: "USD",
  crudeoil: "USD",
  tnx: "USD",
};

/**
 * 株価指数・商品先物の説明 (カタログキー → 文)。為替と金利は向きや単位の説明が銘柄ごとに
 * 違うため、`describePct` の中で銘柄ごとに書く (既定の文で吸収しない)。
 */
const INSTRUMENT_TEXT: Readonly<Record<string, InstrumentText>> = {
  gspc: {
    what: "S&P500 は、米国の代表的な大型株約500銘柄の株価を時価総額 (株価×株数) で重み付けしてまとめた株価指数 (米ドル建て・配当を含まない価格指数)。",
    caveat: "",
  },
  ixic: {
    what: "NASDAQ総合指数は、米国のナスダック市場に上場する全銘柄 (3,000社以上) の株価を時価総額で重み付けしてまとめた株価指数 (米ドル建て・配当を含まない価格指数)。IT などハイテク企業の比重が大きい。",
    caveat: "",
  },
  stoxx50e: {
    what: "ユーロ・ストックス50 は、ユーロ圏の代表的な大型株50銘柄の株価を時価総額で重み付けしてまとめた株価指数 (ユーロ建て・配当を含まない価格指数)。",
    caveat: "",
  },
  ftse: {
    what: "FTSE100 は、ロンドン証券取引所に上場する時価総額の大きい100銘柄をまとめた英国の株価指数 (英ポンド建て・配当を含まない価格指数)。",
    caveat: "",
  },
  gdaxi: {
    what: "DAX は、ドイツの代表的な大型株40銘柄をまとめた株価指数 (ユーロ建て)。多くの株価指数と違い、配当を受け取って再投資したとみなして計算する「パフォーマンス指数」なので、配当の分も値上がりとして含まれる。",
    caveat: "DAX は配当込みの指数なので、配当を含まない他の株価指数と騰落率をそのまま比べると、配当の分だけ高めに出やすい。",
  },
  hsi: {
    what: "ハンセン指数は、香港証券取引所に上場する代表的な大型株をまとめた株価指数 (香港ドル建て・配当を含まない価格指数)。中国本土の企業も多く含む。",
    caveat: "",
  },
  sse: {
    what: "上海総合指数は、上海証券取引所に上場する株式を幅広く対象に時価総額で重み付けした、中国本土の株価指数 (人民元建て・配当を含まない価格指数)。",
    caveat: "中国本土は春節・国慶節などの長い連休で1週間近く休場することがある。",
  },
  ks11: {
    what: "KOSPI総合指数は、韓国取引所の KOSPI 市場に上場する全銘柄の株価を時価総額で重み付けしてまとめた株価指数 (韓国ウォン建て・配当を含まない価格指数)。",
    caveat: "",
  },
  bsesn: {
    what: "SENSEX は、インドのボンベイ証券取引所に上場する代表的な大型株30銘柄をまとめた株価指数 (インドルピー建て・配当を含まない価格指数)。",
    caveat: "",
  },
  n225: {
    what: "日経平均株価は、東証プライム市場の代表的な225銘柄の株価を平均する方式でまとめた株価指数 (円建て・配当を含まない)。時価総額ではなく株価の高さで重みが決まるため、株価の高い一部の銘柄の動きに大きく左右される。",
    caveat: "日経平均は株価を平均する方式なので、TOPIX など時価総額で重み付けする指数と動きが食い違うことがある。",
  },
  "topix-etf": {
    what:
      "TOPIX (東証株価指数) そのものではなく、TOPIX に連動することを目指す ETF「NEXT FUNDS TOPIX連動型上場投信」(銘柄コード1306) の東証での取引価格 (市場価格・円建て) を代わりに使った値。" +
      "TOPIX は東証に上場する幅広い銘柄を時価総額で重み付けした指数。",
    caveat:
      "TOPIX 指数そのものは Yahoo Finance のチャート API に無い (2026-09-27 に ^TOPX・998405.T 等の候補がすべて 404 Not Found と確認) ため、" +
      "TOPIX 連動 ETF (1306) の市場価格で代替した近似値。市場価格は基準価額 (ETF の1口あたり純資産) とも TOPIX とも完全には一致しない" +
      " (信託報酬の差し引き・指数との追随誤差・市場での売買による乖離)。" +
      "ETF の分配金の権利落ち日を含む週は、分配金の分だけ ETF の値段が下がるため TOPIX より低い騰落率になり、" +
      "逆に多くの上場企業の配当の権利落ち日 (3月末・9月末ごろ) を含む週は TOPIX のほうが下がりやすい。",
  },
  gold: {
    what:
      "金先物 (米国 COMEX の金先物を Yahoo Finance がつないだ系列。期日が最も近い限月ではなく、取引の中心になっている限月の価格で、" +
      "2026-09-27 取得時点では 2026年12月限。1トロイオンス=約31グラムあたりの米ドル価格)。",
    caveat: "",
  },
  crudeoil: {
    what:
      "WTI 原油先物 (米国 NYMEX の原油先物を Yahoo Finance がつないだ系列。取引の中心になっている限月の価格で、" +
      "2026-09-27 取得時点では 2026年11月限。1バレル=約159リットルあたりの米ドル価格)。",
    caveat: "",
  },
};

const UNIT_PCT_TEXT =
  " 観測ログの値は比率で記録する (0.012 = +1.2%、-0.02 = -2%)。プラスは前の週より上がった、" +
  "マイナスは下がったことを表す。対象期間は ISO 週 (月曜〜日曜) で「YYYY-Www」と書き、" +
  "期間開始はその週の月曜、期間終了は日曜。";

const UNIT_PT_TEXT =
  " 観測ログの値は%ポイントのまま記録する (0.2 = 0.2%ポイント上昇、-0.1 = 0.1%ポイント低下)。" +
  "対象期間は ISO 週 (月曜〜日曜) で「YYYY-Www」と書き、期間開始はその週の月曜、期間終了は日曜。";

const INDEX_NOT_FLOW =
  " 株価指数は株の「値段」をまとめた指標で、その市場にお金がいくら流れ込んだか (資金の流れ=フロー) も、" +
  "置かれているお金の量 (残高=ストック) の金額も直接は表さない。株の売買では買い手が払うお金と売り手が受け取るお金は" +
  "必ず同じ額なので、値上がりは「買われた金額が売られた金額より多かった」ことではなく、" +
  "高い値段でも買いたい勢いが売りたい勢いより強かった結果であって、流入額そのものではない。";

const COMMON_LIMITATIONS =
  "価格・利回りの変化だけを表し、資金の純流入・純流出の額は測れない (世界の概況をつかむための参考指標で、" +
  "観測ログの近似フラグは全行オン)。取得元は Yahoo Finance のチャート API (週足・直近6か月) で、" +
  "取引所や指数の算出会社の公式データそのものではない (まれに誤りや後日の修正がありうる)。" +
  " 週は各取引所の現地時間の月曜〜日曜 (ISO 週)。Yahoo の週足の終値 (その週の最後の取引日の終値) を" +
  "週末値とし、その銘柄に週足のある直前の週の終値と比べる。取得した時点の最新値 (週足とは別に付く値) は使わない。" +
  "休場で1週間まるごと取引の無かった週は行を作らない (0 で埋めない。2週以上続けて週足が無い場合は取込を止める)。" +
  "その次の週は休場前の最後の週の終値と比べる (休場中は値が動かないので、騰落は休場明けの週の取引の分)。" +
  "休場日は国ごとに違うため、同じ週でも国によって最終取引日がずれる。" +
  " 公表の遅れは無いが、週が終わってから (日本時間の月曜 9 時以降の取込で) 記録する。" +
  "1回の取込では、終わった最新の週とその前の12週 (計13週) をまとめて記録し直す: Yahoo 側で過去の値が" +
  "直ると上書きされ、取込が止まった週も12週前までなら後から埋まる。前期比の列は使わない (空欄)。" +
  " 利用条件: Yahoo Finance のデータは個人利用に限る (公開の画面や再配布には使わない)。";

const FX_LIMITATIONS =
  " 為替は土日を除きほぼ24時間取引されるため、株式ほどはっきりした週の区切りが無い (Yahoo の為替の基準の" +
  "ロンドン時間で月曜〜日曜に区切った週足の終値を使う近似)。Yahoo の為替の週足の終値は、週末に配信される" +
  "最新の気配値と一致しないことがある (2026-09-27 取得のドル円: 9/21 の週の週足の終値 158.811 に対し、" +
  "土曜に配信された最新値は 157.185)。ここでは週足の終値を使い、土日の気配値は使わない。";

const COMMODITY_LIMITATIONS =
  " 取引の中心になっている限月の価格を Yahoo がつないだ系列なので、限月の切り替わり (ロールオーバー) の週は、実際の値動きと" +
  "関係なく価格が不連続に動くことがある。米ドル建ての値段なので、円で見た値段の動き (為替の影響を含む) とは違う。";

const TNX_NOTE =
  " ^TNX (CBOE の米10年国債利回り指数) の値がそのまま利回り (%) を表す (2026-09-27 取得時点で 5.184 = 5.184%)。";

type IndicatorKind = "pct" | "pt";

function catalogEntryByKey(catalogKey: string, where: string): GlobalIndexCatalogEntry {
  const entry = GLOBAL_INDEX_CATALOG.find((e) => e.key === catalogKey);
  if (!entry) throw new Error(`${tag} ${where}: カタログに無い銘柄キーです: ${catalogKey}`);
  return entry;
}

function instrumentText(entry: GlobalIndexCatalogEntry): InstrumentText {
  const text = INSTRUMENT_TEXT[entry.key];
  if (!text) throw new Error(`${tag} 銘柄 ${entry.key} (${entry.yahooSymbol}) の説明文がアダプタにありません`);
  return text;
}

function expectedCurrency(entry: GlobalIndexCatalogEntry): string {
  const currency = GLOBAL_INDICES_EXPECTED_CURRENCY[entry.key];
  if (!currency) throw new Error(`${tag} 銘柄 ${entry.key} (${entry.yahooSymbol}) の通貨がアダプタにありません`);
  return currency;
}

function localCurrencyNote(entry: GlobalIndexCatalogEntry): string {
  // 円建て (日経平均・TOPIX ETF) 以外は現地通貨建て。為替の影響を含まないことを明記する。
  if (expectedCurrency(entry) === "JPY") return "";
  return " 値は現地通貨建ての指数の動きで、円高・円安による円換算の増減は含まない。";
}

function describePct(entry: GlobalIndexCatalogEntry): { description: string; limitations: string } {
  switch (entry.category) {
    case "index": {
      const text = instrumentText(entry);
      return {
        description:
          `${entry.displayName} の週次騰落率: その週の終値 (その週の最後の取引日の終値) が、前の週の終値から何%動いたか。` +
          `${text.what} 例えば +2% (観測ログの値 0.02) なら「この1週間でその市場の株価が全体として約2%上がった」という意味。` +
          INDEX_NOT_FLOW +
          localCurrencyNote(entry) +
          UNIT_PCT_TEXT,
        limitations: `${COMMON_LIMITATIONS}${text.caveat === "" ? "" : ` ${text.caveat}`}`,
      };
    }
    case "fx":
      if (entry.key === "jpy") {
        return {
          description:
            "ドル円相場 (1米ドルが何円か) の週次騰落率: その週の終値が、前の週の終値から何%動いたか。" +
            "例えば +1% (観測ログの値 0.01) なら、1ドルを買うのに必要な円が1%増えた=ドルに対して円安が1%進んだ" +
            "という意味で、マイナスなら円高。為替の取引額 (お金の流れ=フロー) や残高 (ストック) ではなく、" +
            "通貨の交換レートの変化率。" +
            UNIT_PCT_TEXT,
          limitations: `${COMMON_LIMITATIONS}${FX_LIMITATIONS}`,
        };
      }
      if (entry.key === "eurusd") {
        return {
          description:
            "ユーロドル相場 (1ユーロが何米ドルか) の週次騰落率: その週の終値が、前の週の終値から何%動いたか。" +
            "例えば +1% (観測ログの値 0.01) なら、ユーロが米ドルに対して1%値上がりした (ユーロ高・ドル安) という意味で、" +
            "マイナスならユーロ安・ドル高。このペアに日本円は含まれない。為替の取引額 (フロー) や残高 (ストック) ではなく、" +
            "通貨の交換レートの変化率。" +
            UNIT_PCT_TEXT,
          limitations: `${COMMON_LIMITATIONS}${FX_LIMITATIONS}`,
        };
      }
      // 通貨ペアごとに向きの説明が違うため、既定の文で吸収しない (ルール2・ルール7)。
      throw new Error(`${tag} 説明文の無い通貨ペアです: ${entry.key} (${entry.yahooSymbol})`);
    case "commodity": {
      const text = instrumentText(entry);
      return {
        description:
          `${entry.displayName} の週次騰落率: その週の終値が、前の週の終値から何%動いたか。${text.what}` +
          "例えば +2% (観測ログの値 0.02) なら、この1週間で値段が2%上がったという意味。先物の値段の変化であって、" +
          "買うために動いたお金の量 (フロー) や、在庫・保有残高 (ストック) の増減ではない。" +
          UNIT_PCT_TEXT,
        limitations: `${COMMON_LIMITATIONS}${COMMODITY_LIMITATIONS}${text.caveat === "" ? "" : ` ${text.caveat}`}`,
      };
    }
    case "rate":
      // 説明文は米10年国債 (^TNX) 専用。ほかの金利が増えたら文を足す (既定の文で吸収しない)。
      if (entry.key !== "tnx") throw new Error(`${tag} 説明文の無い金利です: ${entry.key} (${entry.yahooSymbol})`);
      return {
        description:
          "米国の10年国債の利回り (年率%) の週次の相対変化率: その週の終値が、前の週の終値の何%分動いたか。" +
          "例えば利回りが4.00%から4.20%に上がると、この指標は +5% (観測ログの値 0.05) になる。" +
          "市場でよく言う「0.20%ポイント (20bp) の上昇」とは別物で、利回りの上がり幅そのものは" +
          `「米10年国債利回り 週次変化 (ポイント差)」(${TNX_POINT_INDICATOR_KEY}) を見ること。` +
          "利回りは債券の値段の裏返し (利回りが上がる=すでに発行された債券の値段は下がる) で、" +
          "債券市場に出入りしたお金の量 (フロー) や残高 (ストック) ではない。" +
          UNIT_PCT_TEXT,
        limitations:
          `${COMMON_LIMITATIONS} 相対変化率は、利回りの水準が低いほど小さな変化でも大きく見える` +
          ` (例: 1.0%→1.1% は +10% だが、実際の変化は 0.1%ポイント)。変化の大きさを比べるときは ${TNX_POINT_INDICATOR_KEY} を使う。` +
          TNX_NOTE,
      };
    default: {
      const exhaustive: never = entry.category;
      throw new Error(`${tag} 未対応のカテゴリです: ${String(exhaustive)}`);
    }
  }
}

function describePt(): { description: string; limitations: string } {
  return {
    description:
      "米国の10年国債の利回り (年率%) の週の終値が、前の週の終値から何%ポイント動いたか (差)。" +
      "例えば4.00%から4.20%になった週は +0.20 (市場でいう +20bp)。相対変化率 (%) ではなく、利回りの実際の変化幅。" +
      "利回りは債券の値段の裏返し (利回りが上がる=すでに発行された債券の値段は下がる) で、" +
      "資金の流れ (フロー) や残高 (ストック) ではない。" +
      UNIT_PT_TEXT,
    limitations: `${COMMON_LIMITATIONS} 利回りの変化幅だけを表し、その理由 (金融政策・インフレの見通しなど) は分からない。${TNX_NOTE}`,
  };
}

function classifyIndicator(def: MoneyflowIndicatorDefinition): { entry: GlobalIndexCatalogEntry; kind: IndicatorKind } {
  if (def.key === TNX_POINT_INDICATOR_KEY) return { entry: catalogEntryByKey("tnx", def.key), kind: "pt" };
  const m = PCT_INDICATOR_RE.exec(def.key);
  if (!m) throw new Error(`${tag} 想定外の指標キーです (アダプタの更新が必要): ${def.key}`);
  return { entry: catalogEntryByKey(m[1] as string, def.key), kind: "pct" };
}

function toIndicatorDef(def: MoneyflowIndicatorDefinition): IndicatorDefInput {
  const { entry, kind } = classifyIndicator(def);
  if (def.requirements.length !== 1 || def.requirements[0] !== "R4") {
    throw new Error(`${tag} ${def.key}: 要件が想定 (R4 のみ) と違います: ${def.requirements.join(",")}`);
  }
  if (def.flowType !== "price_only") {
    throw new Error(`${tag} ${def.key}: 対応付けの無い flowType です: ${def.flowType}`);
  }
  if (!def.frequency.startsWith("週次")) {
    throw new Error(`${tag} ${def.key}: 対応付けの無い頻度です: ${def.frequency}`);
  }
  // 観測行と同じ換算規則を指標定義にも通す (単位の組み合わせが想定外なら throw)。
  const expectedUnit = kind === "pct" ? "%" : "ポイント(%pt)";
  if (def.unit !== expectedUnit) {
    throw new Error(`${tag} ${def.key}: 単位が想定 (${expectedUnit}) と違います: ${def.unit}`);
  }
  if (!def.usageTerms.includes("個人利用のみ")) {
    throw new Error(`${tag} ${def.key}: 利用条件の記述が想定 (個人利用のみ) と違います: ${def.usageTerms}`);
  }
  if (!def.sourceUrl.startsWith("https://finance.yahoo.com/")) {
    throw new Error(`${tag} ${def.key}: 出典が Yahoo Finance ではありません: ${def.sourceUrl}`);
  }
  const text = kind === "pct" ? describePct(entry) : describePt();
  return {
    key: def.key,
    displayName: def.displayName,
    requirement: "R4",
    flowType: "価格",
    description: text.description,
    // 銘柄ごとの Yahoo Finance の銘柄ページ (モジュールの出典はトップページ)。
    sourceUrl: `${YAHOO_QUOTE_BASE}${encodeURIComponent(entry.yahooSymbol)}/`,
    license: YAHOO_LICENSE,
    frequency: "週次",
    limitations: text.limitations,
  };
}

function buildIndicators(): IndicatorDefInput[] {
  const catalogKeys = GLOBAL_INDEX_CATALOG.map((e) => e.key).sort();
  const currencyKeys = Object.keys(GLOBAL_INDICES_EXPECTED_CURRENCY).sort();
  if (currencyKeys.join(",") !== catalogKeys.join(",")) {
    throw new Error(
      `${tag} アダプタの通貨表 (${currencyKeys.join(",")}) とモジュールのカタログ (${catalogKeys.join(",")}) が一致しません`
    );
  }
  const textKeys = Object.keys(INSTRUMENT_TEXT).sort();
  const indexOrCommodityKeys = GLOBAL_INDEX_CATALOG.filter((e) => e.category === "index" || e.category === "commodity")
    .map((e) => e.key)
    .sort();
  if (textKeys.join(",") !== indexOrCommodityKeys.join(",")) {
    throw new Error(
      `${tag} アダプタの銘柄説明 (${textKeys.join(",")}) とモジュールの株価指数・商品 (${indexOrCommodityKeys.join(",")}) が一致しません`
    );
  }
  const defs = GLOBAL_INDEX_INDICATORS.map(toIndicatorDef);
  const keys = new Set(defs.map((d) => d.key));
  if (keys.size !== defs.length) throw new Error(`${tag} 指標キーが重複しています`);
  for (const entry of GLOBAL_INDEX_CATALOG) {
    if (!keys.has(`global_${entry.key}_weekly_change_pct`)) {
      throw new Error(`${tag} 銘柄 ${entry.key} の騰落率の指標定義がモジュールにありません`);
    }
  }
  if (!keys.has(TNX_POINT_INDICATOR_KEY)) {
    throw new Error(`${tag} ${TNX_POINT_INDICATOR_KEY} の指標定義がモジュールにありません`);
  }
  return defs;
}

export const GLOBAL_INDICES_ADAPTER_INDICATORS: readonly IndicatorDefInput[] = buildIndicators();

const INDICATOR_KEYS: ReadonlySet<string> = new Set(GLOBAL_INDICES_ADAPTER_INDICATORS.map((d) => d.key));

// ---------------------------------------------------------------------------
// ファイル (Yahoo Chart API 週足応答 JSON) → 観測行 (純関数)
// ---------------------------------------------------------------------------

function decodeUtf8(file: SpecFile): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch (e) {
    throw new Error(`${tag} ${file.filename}: UTF-8 として読めません: ${(e as Error).message}`, { cause: e });
  }
}

function toUnit(row: MoneyflowObservationRow): { unit: MoneyflowUnit; value: number } {
  // モジュールの "%" (騰落率×100) は比率 (0.012 = 1.2%) に、"ポイント(%pt)" は%ポイントのまま。
  if (row.unit === "%") return { unit: "比率", value: row.value / 100 };
  if (row.unit === "ポイント(%pt)") return { unit: "%ポイント", value: row.value };
  throw new Error(`${tag} ${row.indicatorKey}: 対応付けの無い単位です: ${row.unit}`);
}

function toCategoryKind(row: MoneyflowObservationRow, entry: GlobalIndexCatalogEntry): MoneyflowCategoryKind {
  // モジュールは為替・商品を「資産クラス」にまとめるが、規約の区分種別は最も細かい軸
  // (通貨ペア → 通貨、個別の先物 → 商品) にする。
  if (row.segmentType === "国地域" && (entry.category === "index" || entry.category === "rate")) return "国地域";
  if (row.segmentType === "資産クラス" && entry.category === "fx") return "通貨";
  if (row.segmentType === "資産クラス" && entry.category === "commodity") return "商品";
  throw new Error(
    `${tag} ${row.indicatorKey}: 区分種別の対応付けがありません (モジュール: ${row.segmentType}, カテゴリ: ${entry.category})`
  );
}

function toDraft(row: MoneyflowObservationRow, entry: GlobalIndexCatalogEntry, week: ObservationPeriod): ObservationDraft {
  if (!INDICATOR_KEYS.has(row.indicatorKey)) {
    throw new Error(`${tag} 指標定義に無い指標キーの行です: ${row.indicatorKey}`);
  }
  if (row.period !== week.label) {
    throw new Error(`${tag} ${row.indicatorKey}: 行の週 ${row.period} が対象の週 ${week.label} と違います`);
  }
  if (row.segment !== entry.segmentLabel || row.segment.trim() === "") {
    throw new Error(`${tag} ${row.indicatorKey}: 区分 "${row.segment}" がカタログ (${entry.segmentLabel}) と違います`);
  }
  if (row.isEstimated) {
    throw new Error(`${tag} ${row.indicatorKey}: モジュールが推定値の行を返しました (想定外)`);
  }
  const { unit, value } = toUnit(row);
  return {
    period: week.label,
    periodStart: week.start,
    periodEnd: week.end,
    indicatorKey: row.indicatorKey,
    category: row.segment,
    categoryKind: toCategoryKind(row, entry),
    value,
    unit,
    changeFromPrev: null,
    // 価格・利回りの変化は資金の流れそのものではない代理指標 (規約: 流れそのものでなければ true)。
    // TOPIX を ETF で代替している点 (モジュールの isApproximate) も含めて全行 true。
    approximate: true,
    measureKind: "実測",
  };
}

/** 1 銘柄分: 記録する各週の騰落の行 (週 → 行の配列。週足の無い週は入れない)。 */
function instrumentRows(
  entry: GlobalIndexCatalogEntry,
  snapshot: GlobalIndexChartSnapshot,
  weeks: readonly ObservationPeriod[]
): Map<string, ObservationDraft[]> {
  const results: WeeklyChangeResult[] = weeks.map((week) => resolveWeeklyChangeForPeriod(snapshot, week));
  const target = results[results.length - 1] as WeeklyChangeResult;
  const beforeTarget = results[results.length - 2] as WeeklyChangeResult;
  if (target.status === "no_bar_in_period" && beforeTarget.status === "no_bar_in_period") {
    // 1 週の休場は正常 (行を作らない) だが、2 週続けて週足が無いのは銘柄の廃止・シンボル変更・
    // 取得の異常を疑う。黙って行を減らし続けないよう止める (ルール2)。
    throw new Error(
      `${tag} ${entry.yahooSymbol}: 対象週 ${target.period.label} とその前の週のどちらにも週足がありません ` +
        `(1週より長い休場なら規則の見直しが必要): ${target.reason}`
    );
  }
  const out = new Map<string, ObservationDraft[]>();
  weeks.forEach((week, i) => {
    const result = results[i] as WeeklyChangeResult;
    if (result.status === "no_bar_in_period") return; // 休場で週足の無い週は行を作らない (0 で埋めない)
    if (result.observation.period.label !== week.label) {
      throw new Error(
        `${tag} ${entry.yahooSymbol}: 求めた週 ${week.label} と結果の週 ${result.observation.period.label} が違います`
      );
    }
    // 比較元の週は「直前の週」か、1 週の休場を挟んだ「2 週前」まで。それより前と比べると
    // 2 週以上の騰落を週次騰落として記録してしまう (対象週だけでなく 13 週すべてに同じ規則)。
    const gapWeeks =
      (Date.parse(`${week.start}T00:00:00.000Z`) - Date.parse(`${result.observation.previousPeriod.start}T00:00:00.000Z`)) /
      (7 * DAY_MS);
    if (gapWeeks > 2) {
      throw new Error(
        `${tag} ${entry.yahooSymbol}: ${week.label} の比較元が ${result.observation.previousPeriod.label} (${gapWeeks} 週前) です。` +
          "2 週以上続けて週足が無く、週次騰落として記録できません (1週より長い休場なら規則の見直しが必要)"
      );
    }
    if (result.observation.previousClose === 0) {
      throw new Error(
        `${tag} ${entry.yahooSymbol}: ${result.observation.previousPeriod.label} の終値が 0 のため騰落率が定義できません`
      );
    }
    const rows = toGlobalIndexObservationRows([{ key: entry.key, result }]);
    const expectedRows = entry.key === "tnx" ? 2 : 1;
    if (rows.length !== expectedRows) {
      throw new Error(`${tag} ${entry.key}: モジュールの行数が想定 (${expectedRows}) と違います: ${rows.length}`);
    }
    out.set(
      week.label,
      rows.map((r) => toDraft(r, entry, week))
    );
  });
  return out;
}

function buildDrafts(key: string, files: readonly SpecFile[]): ObservationDraft[] {
  const target = parseBatchKey(key);
  const expected = GLOBAL_INDEX_CATALOG.map((e) => globalIndicesFilename(e.key, target.label));
  const unexpected = files.filter((f) => !expected.includes(f.filename)).map((f) => f.filename);
  if (unexpected.length > 0) {
    throw new Error(`${tag} 想定外のファイルがあります (取り違えの疑い): ${unexpected.join(", ")}`);
  }
  const weeks = globalIndicesBatchWeeks(target);
  const perInstrument = GLOBAL_INDEX_CATALOG.map((entry) => {
    const file = requireSpecFile(
      files,
      (f) => f === globalIndicesFilename(entry.key, target.label),
      `${tag} ${entry.displayName} (${entry.yahooSymbol})`
    );
    const snapshot = parseGlobalIndexWeeklyChart(decodeUtf8(file), entry.key, entry.yahooSymbol);
    if (snapshot.currency !== expectedCurrency(entry)) {
      throw new Error(
        `${tag} ${entry.yahooSymbol}: 応答の通貨 ${snapshot.currency} が想定 (${expectedCurrency(entry)}) と違います`
      );
    }
    return instrumentRows(entry, snapshot, weeks);
  });
  // 行の順序: 週の古い順 → カタログの順 (米10年債は騰落率 → ポイント差)。
  // 最後の行 (対象週の最後の銘柄) が「このバッチの取込完了」の印になる。
  const drafts: ObservationDraft[] = [];
  for (const week of weeks) {
    for (const rowsByWeek of perInstrument) {
      const rows = rowsByWeek.get(week.label);
      // 値の無い週 (休場) は行を作らない (instrumentRows で判定済み)。
      if (rows !== undefined) drafts.push(...rows);
    }
  }
  if (drafts.length === 0) throw new Error(`${tag} ${key}: 観測行が 1 行もできませんでした`);
  return drafts;
}

// ---------------------------------------------------------------------------
// 取得 (resolve / fetch)
// ---------------------------------------------------------------------------

async function fetchBatch(key: string, target: ObservationPeriod): Promise<FetchedBatch> {
  const encoder = new TextEncoder();
  const files: PrimaryFile[] = [];
  const symbols: Array<Record<string, unknown>> = [];
  // 16 銘柄を順番に取る (Yahoo への同時アクセスを増やさない)。モジュールの取得関数は
  // HTTP ステータスが 2xx でない応答・週足チャートとして読めない応答を throw するので、
  // エラー応答の本文がこの週のキーで一次データとして保管されることは無い。
  for (const entry of GLOBAL_INDEX_CATALOG) {
    const res = await fetchGlobalIndexWeeklyChart(entry.key, GLOBAL_INDICES_CHART_RANGE);
    if (res.key !== entry.key || res.yahooSymbol !== entry.yahooSymbol) {
      throw new Error(`${tag} 取得結果の銘柄が違います: ${res.key}=${res.yahooSymbol} (期待 ${entry.key}=${entry.yahooSymbol})`);
    }
    const bytes = encoder.encode(res.raw);
    files.push({ filename: globalIndicesFilename(entry.key, target.label), bytes, contentType: "application/json" });
    symbols.push({ key: entry.key, yahooSymbol: res.yahooSymbol, fetchedAt: res.fetchedAt, bytes: bytes.byteLength });
  }
  return {
    key,
    source:
      "Yahoo Finance Chart API v8 (query1.finance.yahoo.com/v8/finance/chart/<symbol>" +
      `?range=${GLOBAL_INDICES_CHART_RANGE}&interval=1wk、src/shared/yahoo/client.ts の fetchYahooChartRaw 経由)`,
    metadata: {
      targetWeek: target.label,
      targetWeekStart: target.start,
      targetWeekEnd: target.end,
      weeksPerBatch: GLOBAL_INDICES_WEEKS_PER_BATCH,
      range: GLOBAL_INDICES_CHART_RANGE,
      interval: "1wk",
      symbols,
      license: "Yahoo Finance (個人利用のみ)",
    },
    files,
  };
}

async function resolveGlobalIndices(now: Date): Promise<ResolvedBatch> {
  const target = resolveLatestCompletedWeek(now);
  const key = globalIndicesBatchKey(target);
  return {
    key,
    fetch: () => fetchBatch(key, target),
  };
}

/** 世界の主要株価指数・為替・金利・金・原油の週次騰落 (16 銘柄・17 指標・13 週分)。 */
export const globalIndicesSpec: MoneyflowSourceSpec = {
  name: GLOBAL_INDICES_SPEC_NAME,
  indicators: GLOBAL_INDICES_ADAPTER_INDICATORS,
  resolve: resolveGlobalIndices,
  toObservations({ key, files }) {
    return buildDrafts(key, files);
  },
};
