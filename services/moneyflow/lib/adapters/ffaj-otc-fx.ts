/**
 * moneyflow アダプタ: 金融先物取引業協会 (FFAJ) 店頭FX月次速報 (Phase 4 資産クラス横断・R3)。
 *
 * 取得元モジュール `../sources/ffaj-otc-fx.ts` (取得・解析・独自の指標定義) を
 * `MoneyflowSourceSpec` (`../source-spec.ts`) に揃える。規約は `./README.md`。
 *
 * ## spec
 * `ffaj-otc-fx` の 1 本。資料室ページ (https://www.ffaj.or.jp/library/performance/fx_flash/)
 * には毎月、同じ更新日で「取引状況」「主要通貨建玉」「預託額情報」の xls がまとめて
 * 差し替え掲載されるため、この 3 ファイル + 資料室ページ HTML を 1 バッチにする。
 * 指標はモジュールの 8 件 (取引金額・売建玉・買建玉・建玉合計・通貨別ネット買い越し建玉・
 * 顧客区分管理必要額の正味増減額 (損益相当)・必要額残高・信託額残高)。
 *
 * ## 冪等キー
 * `ffaj-otc-fx-<最新公表月 YYYY-MM>-updated-<資料室ページの更新日 YYYY-MM-DD>`
 * (モジュールの `ffajOtcFxArchiveKey()` そのもの)。FFAJ は note シートで「過去の数値を
 * 修正することがある」と明記しているため、同じ最新公表月のまま差し替えられた版を
 * 取りこぼさないよう更新日まで含める。キーは資料室ページだけで決まるので、`resolve()` は
 * 資料室ページ 1 回の取得で済む (本体の xls は `fetch()` で取る)。
 *
 * ## 記録する範囲 (行数)
 * xls は全期間 (取引状況・主要通貨建玉は 2008-11 から、預託額情報は 2015-04 から) を持つが、
 * 全部を観測ログにすると 1 バッチ 3,000 行を超える。固定の規則として **キーの最新公表月を
 * 含む直近 24 か月** だけを記録する (1 か月 = 市場全体 4 + 通貨 9 + 預託額 3 = 16 行、
 * 24 か月で 384 行)。窓の月が 1 つでも xls に無ければ throw する (黙って欠かさない)。
 * それより前の月は一次データとして保管した xls には残る (各指標の「限界」に明記)。
 *
 * ## 単位・区分
 * 百万円の値は円に換算 (×1,000,000)。預託額情報は原資料が円単位なのでそのまま。
 * 区分は全通貨ペア合計の 4 指標が「全通貨ペア合計」、預託額情報の 3 指標が「報告会員合算」
 * (いずれも区分種別「全体」)、通貨別ネット買い越し建玉が原資料の通貨名 (例「日本円 (JPY)」、
 * 区分種別「通貨」)。
 */
import type {
  IndicatorDefInput,
  MoneyflowCategoryKind,
  MoneyflowFlowType,
  MoneyflowFrequency,
  MoneyflowRequirement,
} from "../../../../src/shared/notion-archive/index.js";
import {
  isMoneyflowFrequency,
  isMoneyflowRequirement,
} from "../../../../src/shared/notion-archive/moneyflow.js";
import {
  monthRange,
  requireSpecFile,
  type FetchedBatch,
  type MoneyflowSourceSpec,
  type ObservationDraft,
  type ResolvedBatch,
  type SpecFile,
} from "../source-spec.js";
import {
  FFAJ_CURRENCY_CODES,
  FFAJ_INDEX_URL,
  FFAJ_OTC_FX_INDICATORS,
  fetchFfajIndexPage,
  fetchLatestFfajOtcFx,
  ffajOtcFxArchiveInput,
  ffajOtcFxArchiveKey,
  parseFfajIndexPage,
  parseFfajOtcFxFiles,
  toFfajOtcFxObservations,
  type FfajCurrencyCode,
  type FfajOtcFxIndicatorDefinition,
  type FfajOtcFxParsed,
} from "../sources/ffaj-otc-fx.js";

export const FFAJ_OTC_FX_SPEC_NAME = "ffaj-otc-fx";

/** 観測ログへ記録する月数 (キーの最新公表月を含む直近 N か月)。固定。 */
export const FFAJ_OTC_FX_WINDOW_MONTHS = 24;

/**
 * 更新停止の検知: 最新公表月が「実行月 (JST) − N か月」より前なら throw する。
 * FFAJ の月次速報は翌月中旬に公表される (実測: 2026年8月分の資料室ページ更新日は 2026-09-14)。
 * 月初〜中旬の実行では 2 か月前が最新になるのが通常なので 3 か月前までは許し、それより古い
 * ままなら掲載停止・資料室ページの様式変更を疑って失敗させる (古い版を「最新」として黙って
 * 記録し続けない — ルール2)。
 */
export const FFAJ_OTC_FX_MAX_LAG_MONTHS = 3;

const MILLION = 1_000_000;
const XLS_CONTENT_TYPE = "application/vnd.ms-excel";
/**
 * 資料室ページ HTML の contentType。パラメータ (`; charset=utf-8`) を付けない素の MIME 型にする:
 * Notion File Upload API は拡張子と content_type を allowlist で検証し (file-upload.ts)、
 * 他の取得元アダプタも素の "text/html" で保管している。バイト列は UTF-8 (TextEncoder)。
 */
const INDEX_CONTENT_TYPE = "text/html";
const tag = `[${FFAJ_OTC_FX_SPEC_NAME}]`;

// ---------------------------------------------------------------------------
// 指標ごとの対応表 (固定)
// ---------------------------------------------------------------------------

/** 期間の取り方: 月間の合計 (フロー) か、月末時点の残高 (ストック) か。 */
type PeriodShape = "monthTotal" | "monthEnd";
/** 観測行の区分の軸: 市場全体の 1 行か、主要 9 通貨別か。 */
type SegmentAxis = "total" | "currency";

interface IndicatorMapping {
  flowType: MoneyflowFlowType;
  shape: PeriodShape;
  axis: SegmentAxis;
  /** axis=total のときの区分名。 */
  totalCategory: string | null;
  /** モジュールの観測行の単位 (これ以外なら throw)。 */
  moduleUnit: "百万円" | "円";
  /** 説明の末尾に足す、符号・単位・期間の明記。 */
  note: string;
}

const CAT_ALL_PAIRS = "全通貨ペア合計";
const CAT_MEMBERS = "報告会員合算";

const NOT_NET_INFLOW =
  "店頭FXへ正味いくらお金が入ったか (純流入額 = 入ったお金 − 出たお金) を表す数字ではない。前期比は記録しない (null)。";

/**
 * モジュールの 8 指標の対応表。モジュールに指標が増減したら `buildMappings()` が throw する
 * (未知の指標を推測で分類しない — ルール2)。
 */
const MAPPING_TABLE: Readonly<Record<string, IndicatorMapping>> = {
  ffaj_otc_fx_turnover: {
    flowType: "売買代金",
    shape: "monthTotal",
    axis: "total",
    totalCategory: CAT_ALL_PAIRS,
    moduleUnit: "百万円",
    note:
      "1か月間の取引の合計 (フロー。期間開始・終了はその月の初日と末日)。買いと売りを足したグロス額なので" +
      "値は0以上。単位は円 (原資料の百万円を換算)。" +
      NOT_NET_INFLOW,
  },
  ffaj_otc_fx_short_position: {
    flowType: "建玉",
    shape: "monthEnd",
    axis: "total",
    totalCategory: CAT_ALL_PAIRS,
    moduleUnit: "百万円",
    note:
      "月末時点の残高 (ストック。期間開始・終了はどちらもその月の末日)。値は0以上。単位は円 (原資料の百万円を換算)。" +
      NOT_NET_INFLOW,
  },
  ffaj_otc_fx_long_position: {
    flowType: "建玉",
    shape: "monthEnd",
    axis: "total",
    totalCategory: CAT_ALL_PAIRS,
    moduleUnit: "百万円",
    note:
      "月末時点の残高 (ストック。期間開始・終了はどちらもその月の末日)。値は0以上。単位は円 (原資料の百万円を換算)。" +
      NOT_NET_INFLOW,
  },
  ffaj_otc_fx_open_position_total: {
    flowType: "建玉",
    shape: "monthEnd",
    axis: "total",
    totalCategory: CAT_ALL_PAIRS,
    moduleUnit: "百万円",
    note:
      "月末時点の残高 (ストック。期間開始・終了はどちらもその月の末日)。値は0以上。単位は円 (原資料の百万円を換算)。" +
      NOT_NET_INFLOW,
  },
  ffaj_otc_fx_net_long_position: {
    flowType: "建玉",
    shape: "monthEnd",
    axis: "currency",
    totalCategory: null,
    moduleUnit: "百万円",
    note:
      "月末時点の残高 (ストック。期間開始・終了はどちらもその月の末日)。符号: プラス=その通貨の買い持ちが多い、" +
      "マイナス=売り持ちが多い。単位は円 (原資料の百万円を換算)。建玉の差であって、その月に買い越した" +
      "金額 (フロー) ではない。" +
      NOT_NET_INFLOW,
  },
  ffaj_otc_fx_customer_deposit_net_change: {
    flowType: "損益",
    shape: "monthTotal",
    axis: "total",
    totalCategory: CAT_MEMBERS,
    moduleUnit: "円",
    note:
      "1か月間の値 (フロー。期間開始・終了はその月の初日と末日)。符号: プラス=顧客全体がその月に儲かった、" +
      "マイナス=損をした。単位は円 (原資料も円)。入金・出金の差ではなく損益なので、資金の流入・流出" +
      "として読まない。" +
      NOT_NET_INFLOW,
  },
  ffaj_otc_fx_deposit_required_balance: {
    flowType: "残高",
    shape: "monthEnd",
    axis: "total",
    totalCategory: CAT_MEMBERS,
    moduleUnit: "円",
    note:
      "月末時点の残高 (ストック。期間開始・終了はどちらもその月の末日)。単位は円 (原資料も円)。" + NOT_NET_INFLOW,
  },
  ffaj_otc_fx_deposit_trust_balance: {
    flowType: "残高",
    shape: "monthEnd",
    axis: "total",
    totalCategory: CAT_MEMBERS,
    moduleUnit: "円",
    note:
      "月末時点の残高 (ストック。期間開始・終了はどちらもその月の末日)。単位は円 (原資料も円)。" + NOT_NET_INFLOW,
  },
};

/** 観測行を並べる指標の順 (1 か月の中の順)。最後の指標が「取込完了の印」の行になる。 */
const INDICATOR_ORDER: readonly string[] = [
  "ffaj_otc_fx_turnover",
  "ffaj_otc_fx_short_position",
  "ffaj_otc_fx_long_position",
  "ffaj_otc_fx_open_position_total",
  "ffaj_otc_fx_net_long_position",
  "ffaj_otc_fx_customer_deposit_net_change",
  "ffaj_otc_fx_deposit_required_balance",
  "ffaj_otc_fx_deposit_trust_balance",
];

/** 主要 9 通貨の区分名 (open_position_with_mc.xls の通貨見出しの日本語表記 + コード)。 */
const CURRENCY_LABELS: Readonly<Record<FfajCurrencyCode, string>> = {
  JPY: "日本円 (JPY)",
  USD: "米ドル (USD)",
  EUR: "ユーロ (EUR)",
  GBP: "英ポンド (GBP)",
  AUD: "オーストラリアドル (AUD)",
  NZD: "ニュージーランドドル (NZD)",
  CHF: "スイスフラン (CHF)",
  CAD: "カナダドル (CAD)",
  ZAR: "南アフリカランド (ZAR)",
};

function currencyLabel(code: string, where: string): string {
  if (!(FFAJ_CURRENCY_CODES as readonly string[]).includes(code)) {
    throw new Error(`${where}: 未知の通貨区分 ${code} です`);
  }
  return CURRENCY_LABELS[code as FfajCurrencyCode];
}

function mappingOf(key: string): IndicatorMapping {
  const m = MAPPING_TABLE[key];
  if (!m) throw new Error(`${tag} 指標定義に無い指標キー ${key} の観測行です`);
  return m;
}

/** モジュールの flowType と対応表の「何を測るか」が矛盾していないか確かめる。 */
function assertFlowTypeConsistent(def: FfajOtcFxIndicatorDefinition, m: IndicatorMapping): void {
  const expected: Record<FfajOtcFxIndicatorDefinition["flowType"], MoneyflowFlowType | null> = {
    net_flow: "純買い越し",
    gross_turnover: "売買代金",
    holdings_stock: "残高",
    positions: "建玉",
    // 店頭FXモジュールには資金の入出金そのものの指標は無い (正味増減額は損益 = pnl)。
    fund_flow: null,
    pnl: "損益",
    estimated: "推定",
    price_only: "価格",
  };
  const want = expected[def.flowType];
  if (want === null || want !== m.flowType) {
    throw new Error(
      `${tag} 指標 ${def.key}: モジュールの分類 ${def.flowType} と対応表の「何を測るか」${m.flowType} が一致しません`
    );
  }
  if (def.unit !== m.moduleUnit) {
    throw new Error(`${tag} 指標 ${def.key}: モジュールの単位 ${def.unit} が対応表 (${m.moduleUnit}) と一致しません`);
  }
}

function singleRequirement(def: FfajOtcFxIndicatorDefinition): MoneyflowRequirement {
  if (def.requirements.length !== 1) {
    throw new Error(`${tag} 指標 ${def.key}: 要件が 1 つではありません (${def.requirements.join(",")})`);
  }
  const r = def.requirements[0] as string;
  if (!isMoneyflowRequirement(r)) throw new Error(`${tag} 指標 ${def.key}: 未知の要件 ${r}`);
  return r;
}

function frequencyOf(def: FfajOtcFxIndicatorDefinition): MoneyflowFrequency {
  if (!isMoneyflowFrequency(def.frequency) || def.frequency !== "月次") {
    throw new Error(`${tag} 指標 ${def.key}: 月次以外の頻度 ${def.frequency} はこのアダプタで扱いません`);
  }
  return def.frequency;
}

const WINDOW_LIMITATION =
  ` 観測ログには、その版の最新公表月を含む直近${FFAJ_OTC_FX_WINDOW_MONTHS}か月分だけを記録する` +
  " (原資料のxlsは取引状況・主要通貨建玉が2008年11月分から、預託額情報が2015年4月分からの全期間を持ち、" +
  "それより前の月も一次データとして保管したxlsには残る)。月次の「速報」で、公表は翌月中旬" +
  " (実測: 2026年8月分は2026年9月14日更新)。FFAJは過去の数値を修正することがあると明記しており、" +
  "同じ月のまま差し替えられた版は資料室ページの更新日で区別して取り込み直す。" +
  "xlsの列見出し・単位表示で様式を確かめて読むため、様式変更時は取込が失敗する。";

const LICENSE_NOTE =
  " 利用条件: FFAJサイトの著作権表示は一般的な文言のみで商用利用の可否が明記されていないため「要確認」" +
  "として扱い、公開経路へ出す前に協会へ確認する。";

function toIndicatorDef(def: FfajOtcFxIndicatorDefinition, m: IndicatorMapping): IndicatorDefInput {
  return {
    key: def.key,
    displayName: def.displayName,
    requirement: singleRequirement(def),
    flowType: m.flowType,
    description: `${def.plainExplanation} 定義: ${def.preciseDefinition} ${m.note}`,
    sourceUrl: def.sourceUrl,
    // モジュールの利用条件: 商用可否は未確認 (unknown)。personal-only 等に丸めない (README の規約)。
    license: "要確認",
    frequency: frequencyOf(def),
    limitations: `${def.limitations}${WINDOW_LIMITATION}${LICENSE_NOTE}`,
  };
}

function buildIndicators(): IndicatorDefInput[] {
  const seen = new Set<string>();
  const out: IndicatorDefInput[] = [];
  for (const def of FFAJ_OTC_FX_INDICATORS) {
    if (seen.has(def.key)) throw new Error(`${tag} 指標キー ${def.key} が重複しています`);
    seen.add(def.key);
    const m = mappingOf(def.key);
    assertFlowTypeConsistent(def, m);
    out.push(toIndicatorDef(def, m));
  }
  const missing = INDICATOR_ORDER.filter((k) => !seen.has(k));
  const extra = Object.keys(MAPPING_TABLE).filter((k) => !INDICATOR_ORDER.includes(k));
  if (missing.length > 0 || extra.length > 0 || INDICATOR_ORDER.length !== seen.size) {
    throw new Error(
      `${tag} モジュールの指標と対応表が一致しません (モジュールに無い: ${missing.join(",")} / 並び順に無い: ${extra.join(",")})`
    );
  }
  return out;
}

export const FFAJ_OTC_FX_SPEC_INDICATORS: readonly IndicatorDefInput[] = buildIndicators();

// ---------------------------------------------------------------------------
// キー・期間 (純関数)
// ---------------------------------------------------------------------------

const YM_RE = /^(\d{4})-(\d{2})$/;
const KEY_RE = /^ffaj-otc-fx-(\d{4}-\d{2})-updated-(\d{4}-\d{2}-\d{2})$/;

/** "YYYY-MM" を delta か月ずらす。 */
function shiftMonth(yyyyMm: string, delta: number): string {
  const m = YM_RE.exec(yyyyMm);
  if (!m) throw new Error(`${tag} shiftMonth: YYYY-MM ではありません: ${yyyyMm}`);
  const index = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

/** 冪等キーを分解する。形式が違えば throw。 */
export function parseFfajOtcFxBatchKey(key: string): { latestMonth: string; updatedOn: string } {
  const m = KEY_RE.exec(key);
  if (!m) {
    throw new Error(`${tag} 冪等キーの形式が違います (ffaj-otc-fx-YYYY-MM-updated-YYYY-MM-DD): ${key}`);
  }
  const latestMonth = m[1] as string;
  monthRange(latestMonth); // 月が 1〜12 でなければ throw
  return { latestMonth, updatedOn: m[2] as string };
}

/** 版 (キー) に対応する保管ファイル名 (モジュールの `ffajOtcFxArchiveInput()` の命名 + 資料室ページ)。 */
export function ffajOtcFxFilenames(key: string): {
  index: string;
  tradingVolAndPosition: string;
  openPositionWithMc: string;
  depositAmountInformation: string;
} {
  const { latestMonth } = parseFfajOtcFxBatchKey(key);
  return {
    index: `${key}-fx-flash-index.html`,
    tradingVolAndPosition: `ffaj-trading-vol-and-position-${latestMonth}.xls`,
    openPositionWithMc: `ffaj-open-position-with-mc-${latestMonth}.xls`,
    depositAmountInformation: `ffaj-deposit-amount-information-${latestMonth}.xls`,
  };
}

/** 実行時刻の JST の年月 ("YYYY-MM")。 */
function jstMonth(now: Date): string {
  const t = now.getTime();
  if (!Number.isFinite(t)) throw new Error(`${tag} 不正な実行時刻です: ${String(now)}`);
  return new Date(t + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

/** 最新公表月が実行時刻に対して妥当か確かめる (未来の月・更新停止の疑いは throw)。 */
export function assertFfajOtcFxFresh(latestMonth: string, now: Date): void {
  const current = jstMonth(now);
  if (latestMonth >= current) {
    throw new Error(`${tag} 最新公表月 ${latestMonth} が実行月 ${current} (JST) 以降です (日付の取り違えの疑い)`);
  }
  const oldestAllowed = shiftMonth(current, -FFAJ_OTC_FX_MAX_LAG_MONTHS);
  if (latestMonth < oldestAllowed) {
    throw new Error(
      `${tag} 最新公表月 ${latestMonth} が古すぎます (実行月 ${current} の ${FFAJ_OTC_FX_MAX_LAG_MONTHS} か月前 ` +
        `${oldestAllowed} より前)。掲載停止・資料室ページの様式変更の可能性があります`
    );
  }
}

// ---------------------------------------------------------------------------
// 観測行 (純関数)
// ---------------------------------------------------------------------------

function toYen(value: number, m: IndicatorMapping, where: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${where}: 値が整数ではありません (${value})。単位・様式の変更を疑ってください`);
  }
  const v = m.moduleUnit === "百万円" ? value * MILLION : value;
  if (!Number.isSafeInteger(v)) throw new Error(`${where}: 円換算後の値が安全な整数の範囲を超えます (${v})`);
  return v;
}

function newestMonth(months: readonly string[], what: string): string {
  if (months.length === 0) throw new Error(`${tag} ${what}: データ行がありません`);
  return months.reduce((a, b) => (b > a ? b : a));
}

/**
 * 解析済みの 3 ファイル (モジュールの `FfajOtcFxParsed`) から観測行を作る。
 * `latestMonth` を含む直近 FFAJ_OTC_FX_WINDOW_MONTHS か月 (古い順) × 指標 (INDICATOR_ORDER、
 * 通貨別は FFAJ_CURRENCY_CODES の順)。最後の行は最新月の信託額 (取込完了の印)。
 *
 * @throws 3 ファイルの最新月がキーと違う・窓の月が欠けている・モジュールの観測行が想定と違う場合
 */
export function ffajOtcFxParsedToDrafts(parsed: FfajOtcFxParsed, latestMonth: string): ObservationDraft[] {
  const series: Array<[string, readonly string[]]> = [
    ["trading_vol_and_position.xls", parsed.marketTotal.map((r) => r.month)],
    ["open_position_with_mc.xls", parsed.currencyPositions.map((r) => r.month)],
    ["deposit_amount_information.xls", parsed.deposits.map((r) => r.month)],
  ];
  for (const [what, months] of series) {
    const newest = newestMonth(months, what);
    if (newest !== latestMonth) {
      throw new Error(`${tag} ${what} の最新月 ${newest} がキーの最新公表月 ${latestMonth} と一致しません`);
    }
  }

  // 窓 (キーの最新公表月を含む直近 N か月) を古い順に決める。
  const windowList: string[] = [];
  for (let i = FFAJ_OTC_FX_WINDOW_MONTHS - 1; i >= 0; i -= 1) windowList.push(shiftMonth(latestMonth, -i));
  const windowMonths = new Set(windowList);

  // モジュールの縦長変換には窓の月の行だけを渡す。全期間を渡すと、窓の外 (系列先頭の
  // 2015-04 等) の正味増減額 "na" について「観測ログへ記録しない」という警告が毎回出て、
  // 観測ログに関係しない月の警告が運用者の目を曇らせる。窓の中の "na" は従来どおり
  // モジュールが警告する (運用者への通知経路は残す — ルール2)。
  const inWindow = <T extends { month: string }>(rows: readonly T[]): T[] =>
    rows.filter((r) => windowMonths.has(r.month));
  const windowed: FfajOtcFxParsed = {
    marketTotal: inWindow(parsed.marketTotal),
    currencyPositions: inWindow(parsed.currencyPositions),
    deposits: inWindow(parsed.deposits),
  };

  // モジュールの縦長形式を「期間|指標|区分」で引けるようにする (重複は throw)。
  const byKey = new Map<string, { value: number; unit: string; isEstimated: boolean }>();
  for (const o of toFfajOtcFxObservations(windowed)) {
    const k = `${o.period}|${o.indicatorKey}|${o.segment}`;
    if (byKey.has(k)) throw new Error(`${tag} モジュールの観測行が重複しています: ${k}`);
    byKey.set(k, { value: o.value, unit: o.unit, isEstimated: o.isEstimated });
  }
  const netChangeNa = new Set(windowed.deposits.filter((d) => d.netChangeYen === null).map((d) => d.month));

  const out: ObservationDraft[] = [];
  const used = new Set<string>();
  for (const period of windowList) {
    const { start, end } = monthRange(period);
    for (const indicatorKey of INDICATOR_ORDER) {
      const m = mappingOf(indicatorKey);
      const segments: ReadonlyArray<{ segment: string; category: string; kind: MoneyflowCategoryKind }> =
        m.axis === "currency"
          ? FFAJ_CURRENCY_CODES.map((c) => ({
              segment: c,
              category: currencyLabel(c, `${tag} ${period} ${indicatorKey}`),
              kind: "通貨" as const,
            }))
          : [{ segment: "market", category: m.totalCategory as string, kind: "全体" as const }];
      for (const s of segments) {
        const where = `${tag} ${period} ${indicatorKey} ${s.segment}`;
        const obsKey = `${period}|${indicatorKey}|${s.segment}`;
        const o = byKey.get(obsKey);
        if (!o) {
          if (indicatorKey === "ffaj_otc_fx_customer_deposit_net_change" && netChangeNa.has(period)) {
            // 原資料が "na" (前月データが無く計算不能) と明記した月。値を作らず記録しない
            // (モジュールも観測行を作らず警告を出す)。0 で埋めない — ルール2。
            continue;
          }
          throw new Error(`${where}: 記録対象の観測行がありません (xls の月の欠け・様式変更の可能性)`);
        }
        used.add(obsKey);
        if (o.unit !== m.moduleUnit) throw new Error(`${where}: 単位が ${o.unit} です (${m.moduleUnit} を想定)`);
        if (o.isEstimated) throw new Error(`${where}: 推定値 (isEstimated) はこのアダプタで扱いません`);
        out.push({
          period,
          periodStart: m.shape === "monthTotal" ? start : end,
          periodEnd: end,
          indicatorKey,
          category: s.category,
          categoryKind: s.kind,
          value: toYen(o.value, m, where),
          unit: "円",
          changeFromPrev: null,
          // いずれも資金の「流れ」そのものではない (グロスの取引金額・月末の建玉/残高・損益)
          // ため、規約どおり近似フラグを立てる。値自体は FFAJ の公表値 (実測)。
          approximate: true,
          measureKind: "実測",
        });
      }
    }
  }
  // 窓の月なのに上の固定の並び (指標 × 区分) に載らなかった観測行 (未知の指標・未知の区分) が
  // あれば throw する (黙って捨てない — ルール2)。byKey は窓の月だけから作っている。
  const unknown = [...byKey.keys()].filter((k) => !used.has(k));
  if (unknown.length > 0) {
    throw new Error(`${tag} 想定外の指標・区分の観測行があります: ${unknown.slice(0, 10).join(", ")}`);
  }
  if (out.length === 0) throw new Error(`${tag} 観測行が 0 件です`);
  return out;
}

/** key とファイル (資料室ページ HTML + xls 3 本) から観測行を作る純関数。 */
export function ffajOtcFxToObservations(input: { key: string; files: readonly SpecFile[] }): ObservationDraft[] {
  const { key, files } = input;
  const { latestMonth, updatedOn } = parseFfajOtcFxBatchKey(key);
  const names = ffajOtcFxFilenames(key);
  const pick = (name: string): Uint8Array =>
    requireSpecFile(files, (n) => n === name, `${tag} ${name}`).bytes;

  // キーは資料室ページから決めたもの。保管したページ HTML と突き合わせ、別の版の
  // ファイルを取り違えて解析しない。
  const page = parseFfajIndexPage(new TextDecoder("utf-8", { fatal: true }).decode(pick(names.index)));
  if (page.latestPublishedMonth !== latestMonth || page.updatedOn !== updatedOn) {
    throw new Error(
      `${tag} 保管した資料室ページ (最新公表月 ${page.latestPublishedMonth} / 更新日 ${page.updatedOn}) が` +
        `キー ${key} と一致しません`
    );
  }
  const parsed = parseFfajOtcFxFiles({
    tradingVolAndPosition: pick(names.tradingVolAndPosition),
    openPositionWithMc: pick(names.openPositionWithMc),
    depositAmountInformation: pick(names.depositAmountInformation),
  });
  return ffajOtcFxParsedToDrafts(parsed, latestMonth);
}

// ---------------------------------------------------------------------------
// spec
// ---------------------------------------------------------------------------

async function resolveFfajOtcFx(now: Date): Promise<ResolvedBatch> {
  // 資料室ページ 1 回で最新公表月と更新日 (= キー) を決める。xls は fetch() で取る。
  const { html, page } = await fetchFfajIndexPage();
  assertFfajOtcFxFresh(page.latestPublishedMonth, now);
  const key = ffajOtcFxArchiveKey(page);
  parseFfajOtcFxBatchKey(key);
  const indexBytes = new TextEncoder().encode(html);

  return {
    key,
    fetch: async (): Promise<FetchedBatch> => {
      // モジュールの取得関数は資料室ページを取り直してから xls 3 本を取り、ページの最新公表月と
      // xls の先頭月の一致を検証する。その間にページが差し替わっていたらキーが変わるので throw。
      const raw = await fetchLatestFfajOtcFx();
      const archive = ffajOtcFxArchiveInput(raw);
      if (archive.key !== key) {
        throw new Error(
          `${tag} 取得中に資料室ページの版が変わりました (resolve 時 ${key} / 取得時 ${archive.key})。再実行してください`
        );
      }
      const names = ffajOtcFxFilenames(key);
      const expected = [names.tradingVolAndPosition, names.openPositionWithMc, names.depositAmountInformation];
      const got = archive.files.map((f) => f.filename);
      if (got.length !== expected.length || !expected.every((n) => got.includes(n))) {
        throw new Error(`${tag} モジュールの保管ファイル名が想定と違います: ${got.join(", ")}`);
      }
      for (const f of archive.files) {
        if (f.bytes.byteLength === 0) throw new Error(`${tag} ${f.filename} が空です`);
        if (f.contentType !== XLS_CONTENT_TYPE) {
          throw new Error(`${tag} ${f.filename} の contentType が想定外です: ${f.contentType}`);
        }
      }
      return {
        key,
        source: FFAJ_INDEX_URL,
        metadata: {
          ...archive.metadata,
          indexFile: names.index,
          windowMonths: FFAJ_OTC_FX_WINDOW_MONTHS,
          windowStart: shiftMonth(page.latestPublishedMonth, -(FFAJ_OTC_FX_WINDOW_MONTHS - 1)),
          resolvedAt: now.toISOString(),
        },
        files: [
          { bytes: indexBytes, filename: names.index, contentType: INDEX_CONTENT_TYPE },
          ...archive.files.map((f) => ({ bytes: f.bytes, filename: f.filename, contentType: f.contentType })),
        ],
      };
    },
  };
}

export const ffajOtcFxSpec: MoneyflowSourceSpec = {
  name: FFAJ_OTC_FX_SPEC_NAME,
  indicators: FFAJ_OTC_FX_SPEC_INDICATORS,
  resolve: resolveFfajOtcFx,
  toObservations: ffajOtcFxToObservations,
};

export const FFAJ_OTC_FX_SPECS: readonly MoneyflowSourceSpec[] = [ffajOtcFxSpec];
