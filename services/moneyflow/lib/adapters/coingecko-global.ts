/**
 * moneyflow アダプタ: CoinGecko の暗号資産スナップショット (Phase 4 資産クラス横断・R3)。
 *
 * 取得元モジュール `../sources/coingecko-global.ts` (取得・解析・独自の指標定義) を
 * `MoneyflowSourceSpec` (`../source-spec.ts`) に揃える。規約は `./README.md`。
 *
 * ## spec
 * `coingecko-global` の 1 本。CoinGecko 公開 API v3 の応答 JSON 3 ファイル
 * (`/global`・`/coins/markets?vs_currency=jpy` (固定 5 銘柄)・`/coins/categories`) で 1 バッチ。
 * 指標はモジュールの 5 件 (主要 5 銘柄の円建て価格・円建て時価総額、暗号資産全体の時価総額、
 * ステーブルコイン合計時価総額、ビットコイン・ドミナンス)。1 バッチ 13 行 (5 銘柄 × 2 + 3)。
 *
 * ## 冪等キー・期間
 * `coingecko-global-<YYYY-MM-DD>` (UTC の日付)。CoinGecko は公表ラグの無いリアルタイム API
 * なので「最新の公表済みバッチ」は「今日 (UTC) のスナップショット」であり、`resolve(now)` は
 * 取得元へ通信せず、モジュールの `resolveObservationPeriod("day", now)` だけでキーを決める。
 * その日の最初の取込で保管し、同じ日の 2 回目以降は保管済みとして取得元へ行かない
 * (= 1 日 1 行、その日最初に取込んだ時点の値)。
 *
 * 取得したファイルはモジュールの `coinGeckoArchiveInput()` で組む (ファイル名・来歴メタデータは
 * モジュールの規約どおり)。同関数のキーは実際の取得時刻 (UTC) の日付から作られるので、
 * `resolve` のキーと違う (= 取得中に UTC の日付が変わった) 場合は保管せずに throw する
 * (前日のキーで今日の値を保管しない)。
 *
 * `toObservations` は応答に含まれる CoinGecko 側の更新時刻 (`/global` の updated_at・各銘柄の
 * last_updated・stablecoins カテゴリの updated_at) を確かめ、キーの日付 (UTC の 0 時〜24 時) の
 * 外にあるもの、または 3 つの応答の更新時刻が 1 時間より大きくずれているものは「その日の 1 回の
 * スナップショット」とみなせないので throw する (古い値・前日の値を今日の値として記録しない —
 * ルール1/2。取得元モジュールの `toCoinGeckoObservationRows` も同じく期間外の更新時刻を拒む)。
 *
 * この時刻の検査は `fetch()` でも保管の前に行う。取込フロー (run-spec.ts) は「保管 → 解析」の順で、
 * 保管済みのキーは保管ファイルの再解析しかしないため、UTC 0 時直後の取込で CoinGecko のキャッシュ
 * (2026-09-27 の実測で /coins/categories は約 18 分遅れ) が前日の時刻のまま返ると、保管後の解析で
 * throw し、その日のキーはその後何度実行しても同じ保管ファイルで失敗し続けてしまう。時刻が
 * その日に入っていない応答は保管せずに throw し、時間を空けた再実行で取り直せるようにする。
 * (応答が解析できない = 様式変更のときは保管してから解析で失敗させる。一次データを残すため — ルール6。)
 */
import type {
  IndicatorDefInput,
  MoneyflowCategoryKind,
  MoneyflowFlowType,
  MoneyflowLicense,
  MoneyflowUnit,
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
  COINGECKO_API_TERMS_URL,
  COINGECKO_GLOBAL_INDICATORS,
  COINGECKO_MAJOR_COIN_IDS,
  coinGeckoArchiveInput,
  fetchCoinGeckoCoinMarkets,
  fetchCoinGeckoGlobal,
  fetchCoinGeckoStablecoinCategory,
  isPeriodObservable,
  parseCoinGeckoCoinMarkets,
  parseCoinGeckoGlobal,
  parseCoinGeckoStablecoinCategory,
  resolveObservationPeriod,
  toCoinGeckoObservationRows,
  type CoinGeckoGlobalObservationInput,
  type MoneyflowIndicatorDefinition,
  type MoneyflowObservationRow,
  type ObservationPeriod,
} from "../sources/coingecko-global.js";

export const COINGECKO_GLOBAL_SPEC_NAME = "coingecko-global";
/**
 * 3 つの応答の CoinGecko 側の更新時刻どうしの差の上限 (固定)。2026-09-27 の実測では
 * /coins/categories の updated_at が取得時刻より約 18 分古かった (CoinGecko のキャッシュ) ため、
 * それを十分に含む幅にしている。各更新時刻はこれとは別に、キーの日付 (UTC) の中に入っていなければならない。
 */
export const COINGECKO_SNAPSHOT_TOLERANCE_MS = 60 * 60 * 1000;

const DAY_MS = 86_400_000;
const KEY_RE = /^coingecko-global-(\d{4}-\d{2}-\d{2})$/;
/**
 * 利用条件。CoinGecko API 規約 (利用プランを問わず「Powered by CoinGecko」の表示が義務) は
 * 確認済みだが、無料プラン (キー無し/Demo) は料金表の License 行で商用ライセンスの対象外
 * (Basic 以上が Commercial) とされ、データの保存・複製を制限する規約 6.1/6.2 条を本機能の
 * Notion への長期保存に当てはめた可否は未確認 (検証証跡 claude-moneyflow.json の訂正欄)。
 * よって attribution-required に丸めず「要確認」にする (README の規約: 推測で緩い側に丸めない)。
 */
const COINGECKO_LICENSE: MoneyflowLicense = "要確認";

const tag = `[${COINGECKO_GLOBAL_SPEC_NAME}]`;

// ---------------------------------------------------------------------------
// 区分 (銘柄の表示名)
// ---------------------------------------------------------------------------

/**
 * 追跡銘柄 (CoinGecko の coin id) → 観測ログの「区分」。モジュールの行の表示名と同じ値で、
 * 行の区分がこれと違えば throw する (表示名の無い銘柄を id から組み立てて黙って通さない)。
 * キーはモジュールの `COINGECKO_MAJOR_COIN_IDS` と過不足なく一致しなければならない。
 */
export const COINGECKO_COIN_CATEGORY: Readonly<Record<string, string>> = {
  bitcoin: "ビットコイン(BTC)",
  ethereum: "イーサリアム(ETH)",
  ripple: "リップル(XRP)",
  solana: "ソラナ(SOL)",
  dogecoin: "ドージコイン(DOGE)",
};

const GLOBAL_CATEGORY = "暗号資産全体";
const STABLECOIN_CATEGORY = "ステーブルコイン合計";
const BTC_CATEGORY = "ビットコイン(BTC)";

function coinCategory(id: string): string {
  const label = COINGECKO_COIN_CATEGORY[id];
  if (label === undefined) throw new Error(`${tag} 追跡銘柄 ${id} の区分名がアダプタにありません`);
  return label;
}

function checkCoinCatalog(): void {
  const moduleIds = [...COINGECKO_MAJOR_COIN_IDS].sort().join(",");
  const adapterIds = Object.keys(COINGECKO_COIN_CATEGORY).sort().join(",");
  if (moduleIds !== adapterIds) {
    throw new Error(
      `${tag} アダプタの銘柄表 (${adapterIds}) とモジュールの追跡銘柄 (${moduleIds}) が一致しません (両方を同時に更新すること)`
    );
  }
}

/** 追跡銘柄の区分名 (モジュールの `COINGECKO_MAJOR_COIN_IDS` の順)。 */
function coinCategories(): string[] {
  return COINGECKO_MAJOR_COIN_IDS.map((id) => coinCategory(id));
}

// ---------------------------------------------------------------------------
// 値の換算 (モジュールの値 → 観測ログの単位)
// ---------------------------------------------------------------------------

/** 価格・時価総額: 正の有限数のみ (CoinGecko は欠損を 0 で返すことがあるため 0 以下は実在値として扱わない)。 */
function positiveAmount(value: number, where: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${tag} ${where}: 値が正の数ではありません (欠損を 0 で返した可能性): ${value}`);
  }
  return value;
}

/** シェア (%) → 比率 (0.58 = 58%)。0 より大きく 100 以下でなければ throw する。 */
function percentShareToRatio(value: number, where: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    throw new Error(`${tag} ${where}: シェア (%) が 0 より大きく 100 以下の範囲にありません: ${value}`);
  }
  return value / 100;
}

// ---------------------------------------------------------------------------
// 指標定義 (モジュールの定義 → IndicatorDefInput)
// ---------------------------------------------------------------------------

const TIMING_TEXT =
  " 観測ログには 1 日 1 行 (期間は協定世界時 UTC の日付で YYYY-MM-DD、期間開始=期間終了=その日) で、" +
  "その日に最初に取込んだ時点の値を記録する。";

const COMMON_LIMITATIONS =
  "取得元は CoinGecko の公開 API (v3 の /global・/coins/markets・/coins/categories)。" +
  "日本の暗号資産交換業者での実際の売買価格ではなく、CoinGecko が世界の取引所の値から集計した値。" +
  " 値はその日 (UTC) に最初に取込を実行した時点のスナップショットで、株の終値や 1 日の平均ではない" +
  " (暗号資産は 24 時間 365 日取引されるので、取込の時刻が違えば値も違う。何時の値かは取込の実行時刻で決まる)。" +
  "取込を実行しなかった日 (定時実行の無い土日など) や取込に失敗した日の行は無く、前の日の値で埋めない" +
  " (過去の特定時点の値を後から取り直す処理は無い)。" +
  " 応答に含まれる CoinGecko 側の更新時刻が取込日 (UTC の 0 時〜24 時) の外にある場合 (UTC 0 時 = 日本時間 9 時の" +
  "直後は CoinGecko 側の集計が前日の時刻のまま返ることがある) や、3 つの応答の更新時刻が 1 時間より大きく" +
  "ずれている場合は、同じ日の 1 回のスナップショットとみなせないため保管も記録もせずに取込を止める" +
  " (時間を空けて再実行すれば取り直せる)。" +
  "前期比の列は使わない (空欄)。" +
  ` 利用条件: CoinGecko API 規約 (${COINGECKO_API_TERMS_URL}) により、利用プランを問わず画面に出すときは` +
  "「Powered by CoinGecko」の表示が必要。無料プラン (キー無し/Demo) は料金表で商用ライセンスの対象外とされ、" +
  "データの保存・複製を制限する規約 6.1/6.2 条を本機能の長期保存 (Notion) に当てはめた可否は未確認のため、" +
  "利用条件は「要確認」とし、公開の画面・再配布には使わない。";

const FIXED_COINS_TEXT =
  "追跡するのは固定の 5 銘柄 (CoinGecko の銘柄 ID で bitcoin・ethereum・ripple・solana・dogecoin) だけで、" +
  "時価総額の順位が変わっても入れ替えない。ステーブルコイン (USDT・USDC 等) は時価総額が大きくても" +
  "ここには含めず、「ステーブルコイン合計時価総額」で扱う。";

type ModuleFlowType = MoneyflowIndicatorDefinition["flowType"];

interface IndicatorMapping {
  /** モジュールの指標定義の flowType (違えば throw)。 */
  moduleFlowType: ModuleFlowType;
  /** モジュールの指標定義・観測行の単位 (違えば throw)。 */
  moduleUnit: string;
  flowType: MoneyflowFlowType;
  unit: MoneyflowUnit;
  /** モジュールの値 → 観測ログの値。 */
  convert(value: number, where: string): number;
  /** true: 追跡銘柄ごとに 1 行 (区分=銘柄名)。false: `category` の 1 行だけ。 */
  perCoin: boolean;
  /** perCoin=false のときの区分 (モジュールの行の区分と一致しなければ throw)。 */
  category: string | null;
  categoryKind: MoneyflowCategoryKind;
  description: string;
  limitations: string;
}

/**
 * 指標ごとの対応付け (この表の順が観測行の順: 銘柄ごとの 2 指標 → 全体の 3 指標)。
 * モジュールの `segmentType` は全行「資産クラス」だが、規約の区分種別は最も細かい軸にする
 * (個別の暗号資産 → 商品、区分を持たない世界合計 → 全体、ステーブルコインの分類 → 資産クラス)。
 */
const MAPPINGS: ReadonlyMap<string, IndicatorMapping> = new Map<string, IndicatorMapping>([
  [
    "coingecko_price_jpy",
    {
      moduleFlowType: "price_only",
      moduleUnit: "円/単位",
      flowType: "価格",
      unit: "円",
      convert: positiveAmount,
      perCoin: true,
      category: null,
      categoryKind: "商品",
      description:
        "主要な暗号資産 5 銘柄 (ビットコイン・イーサリアム・リップル・ソラナ・ドージコイン) の、" +
        "1 単位 (1BTC・1ETH など) あたりの円建ての価格。例: 2026-09-27 の取得ではビットコインが" +
        "1BTC=約1,329万円 (観測ログの値 13289426)。値段であって、時価総額 (流通量×価格) でも、" +
        "流れ込んだお金の額 (フロー) や置かれているお金の量 (残高=ストック) でもない。" +
        "値上がりしただけでも数値は増える。観測ログの値は 1 単位あたりの円。" +
        TIMING_TEXT,
      limitations: FIXED_COINS_TEXT,
    },
  ],
  [
    "coingecko_market_cap_jpy",
    {
      moduleFlowType: "holdings_stock",
      moduleUnit: "円",
      flowType: "残高",
      unit: "円",
      convert: positiveAmount,
      perCoin: true,
      category: null,
      categoryKind: "商品",
      description:
        "主要な暗号資産 5 銘柄それぞれの時価総額 = 流通量 (市場に出回っている量) × 価格 (円建て)。" +
        "発行済みの総量ではなく流通量で計算する (例: 2026-09-27 の XRP は流通量約629億枚×価格約240円" +
        "≒約15.1兆円で、総量約1,000億枚×価格の約24.0兆円ではない)。ある時点の残高 (ストック) で、" +
        "1 日の間に動いたお金 (フロー) ではない。値上がりで増えたのか新しいお金が入って増えたのかは" +
        "この数値だけでは区別できないので、前の日との差をそのまま「お金の純流入」と読まないこと。" +
        "観測ログの値は円。" +
        TIMING_TEXT,
      limitations:
        "流通量の数え方 (ロックされた分を含めるか等) は銘柄ごとに違い、CoinGecko 独自の判断が入る。" +
        FIXED_COINS_TEXT,
    },
  ],
  [
    "coingecko_global_market_cap_usd",
    {
      moduleFlowType: "holdings_stock",
      moduleUnit: "米ドル",
      flowType: "残高",
      unit: "米ドル",
      convert: positiveAmount,
      perCoin: false,
      category: GLOBAL_CATEGORY,
      categoryKind: "全体",
      description:
        "CoinGecko が集計しているすべての暗号資産 (2026-09-27 時点で約2万1,600銘柄。ステーブルコインも含む) の" +
        "時価総額の世界合計 (米ドル建て)。株式市場でいう「上場している株の時価総額の合計」に近い、" +
        "市場全体の大きさを表す残高 (ストック)。例: 2026-09-27 は約2.91兆米ドル。日本国内だけの数字ではない。" +
        "値上がり・値下がりだけでも増減するので、前の日との差はお金の純流入額ではない。" +
        "観測ログの値は米ドル (円に換算していない)。" +
        TIMING_TEXT,
      limitations:
        "国・地域別の内訳は無い (世界合計のみ)。流通量の数え方が銘柄ごとに違うため、他社の集計とは一致しない。" +
        "CoinGecko が集計対象の銘柄を増やすと、それだけでも合計が増える。",
    },
  ],
  [
    "coingecko_stablecoin_market_cap_usd",
    {
      moduleFlowType: "holdings_stock",
      moduleUnit: "米ドル",
      flowType: "残高",
      unit: "米ドル",
      convert: positiveAmount,
      perCoin: false,
      category: STABLECOIN_CATEGORY,
      categoryKind: "資産クラス",
      description:
        "米ドルなどの法定通貨と同じ値段を保つように作られた暗号資産「ステーブルコイン」(USDT・USDC など) の" +
        "時価総額の合計 (米ドル建て・世界合計)。暗号資産の市場の中で、いつでも他の暗号資産を買える形で" +
        "待機しているお金の量の目安になる残高 (ストック)。ステーブルコインは値段がほとんど動かないので、" +
        "増減はおおむね新しい発行 (お金が入ってきた) と償還 (お金が出ていった) を表すが、純流入額そのもの" +
        "ではない近似。例: 2026-09-27 は約2,929億米ドル (暗号資産全体の約1割)。" +
        "観測ログの値は米ドル (円に換算していない)。" +
        TIMING_TEXT,
      limitations:
        "CoinGecko の「Stablecoins」カテゴリの分類に依存する (新しい銘柄の反映が遅れることがある)。" +
        "連動先の通貨の価値が崩れた (ペッグが外れた) 銘柄は値段の変化でも増減する。" +
        "円建てステーブルコインは全体のごく一部 (2026-09-27 時点で約0.05%) で、日本円のお金の動きの代わりにはならない。",
    },
  ],
  [
    "coingecko_btc_dominance_pct",
    {
      moduleFlowType: "holdings_stock",
      moduleUnit: "%",
      flowType: "シェア",
      unit: "比率",
      convert: percentShareToRatio,
      perCoin: false,
      category: BTC_CATEGORY,
      categoryKind: "商品",
      description:
        "暗号資産の市場全体の時価総額のうち、ビットコイン (BTC) の時価総額が占める割合 (シェア)。" +
        "例: 2026-09-27 は約58.3% (観測ログは比率で記録するので値は 0.5828)。値が上がるとビットコインへ" +
        "お金や関心が集まっている目安になるが、残高 (ストック) どうしの構成比であって、お金の流出入の額ではない。" +
        TIMING_TEXT,
      limitations:
        "ビットコイン以外の暗号資産 (アルトコイン) の値動きだけでもドミナンスは動くので、" +
        "「お金がビットコインに逃げた」と決めつけられない。全体の時価総額にはステーブルコインも含まれる。",
    },
  ],
]);

function requireMapping(indicatorKey: string, where: string): IndicatorMapping {
  const m = MAPPINGS.get(indicatorKey);
  if (m === undefined) throw new Error(`${tag} ${where}: 対応付けの無い指標キーです (アダプタの更新が必要): ${indicatorKey}`);
  return m;
}

function toIndicatorDef(def: MoneyflowIndicatorDefinition): IndicatorDefInput {
  const m = requireMapping(def.key, "指標定義");
  if (def.requirements.length !== 1 || def.requirements[0] !== "R3") {
    throw new Error(`${tag} ${def.key}: 要件が想定 (R3 のみ) と違います: ${def.requirements.join(",")}`);
  }
  if (def.flowType !== m.moduleFlowType) {
    throw new Error(`${tag} ${def.key}: flowType が想定 (${m.moduleFlowType}) と違います: ${def.flowType}`);
  }
  if (def.unit !== m.moduleUnit) {
    throw new Error(`${tag} ${def.key}: 単位が想定 (${m.moduleUnit}) と違います: ${def.unit}`);
  }
  if (!def.frequency.startsWith("リアルタイム")) {
    throw new Error(`${tag} ${def.key}: 頻度が想定 (リアルタイム) と違います: ${def.frequency}`);
  }
  if (!def.usageTerms.includes("Powered by CoinGecko")) {
    throw new Error(`${tag} ${def.key}: 利用条件の記述が想定 (Powered by CoinGecko の表示義務) と違います: ${def.usageTerms}`);
  }
  if (!def.sourceUrl.startsWith("https://www.coingecko.com/")) {
    throw new Error(`${tag} ${def.key}: 出典が CoinGecko の https ページではありません: ${def.sourceUrl}`);
  }
  return {
    key: def.key,
    displayName: def.displayName,
    requirement: "R3",
    flowType: m.flowType,
    description: m.description,
    sourceUrl: def.sourceUrl,
    license: COINGECKO_LICENSE,
    // 取得元はリアルタイムだが、観測ログへは 1 日 1 回のスナップショットとして記録する。
    frequency: "日次",
    limitations: `${m.limitations} ${COMMON_LIMITATIONS}`,
  };
}

function buildIndicators(): IndicatorDefInput[] {
  checkCoinCatalog();
  const moduleKeys = COINGECKO_GLOBAL_INDICATORS.map((d) => d.key).sort().join(",");
  const adapterKeys = [...MAPPINGS.keys()].sort().join(",");
  if (moduleKeys !== adapterKeys) {
    throw new Error(
      `${tag} モジュールの指標 (${moduleKeys}) とアダプタの対応付け (${adapterKeys}) が一致しません`
    );
  }
  const defs = COINGECKO_GLOBAL_INDICATORS.map(toIndicatorDef);
  if (new Set(defs.map((d) => d.key)).size !== defs.length) throw new Error(`${tag} 指標キーが重複しています`);
  return defs;
}

export const COINGECKO_GLOBAL_ADAPTER_INDICATORS: readonly IndicatorDefInput[] = buildIndicators();

// ---------------------------------------------------------------------------
// キー・ファイル名
// ---------------------------------------------------------------------------

/** 1 日分のスナップショットの期間 (UTC の日付)。実在しない日付・形式違いは throw する。 */
function dayPeriodFromLabel(date: string): ObservationPeriod {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${tag} 日付が YYYY-MM-DD ではありません: ${date}`);
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(ms)) throw new Error(`${tag} 日付として読めません: ${date}`);
  const period = resolveObservationPeriod("day", new Date(ms));
  if (period.label !== date) throw new Error(`${tag} 実在しない日付です: ${date} (計算上は ${period.label})`);
  return period;
}

export function coinGeckoGlobalBatchKey(period: ObservationPeriod): string {
  if (period.granularity !== "day") {
    throw new Error(`${tag} 日次ではない期間からはキーを作れません: ${JSON.stringify(period)}`);
  }
  const day = dayPeriodFromLabel(period.label);
  if (day.start !== period.start || day.end !== period.end) {
    throw new Error(`${tag} 1 日ではない期間です: ${JSON.stringify(period)}`);
  }
  return `${COINGECKO_GLOBAL_SPEC_NAME}-${period.label}`;
}

function parseBatchKey(key: string): ObservationPeriod {
  const m = KEY_RE.exec(key);
  if (!m) throw new Error(`${tag} キーの形式が違います (coingecko-global-YYYY-MM-DD): ${key}`);
  return dayPeriodFromLabel(m[1] as string);
}

/**
 * 保管ファイル名 (モジュールの `coinGeckoArchiveInput()` の命名と同じ。キーの日付だけから決まる)。
 * `fetch()` はモジュールが組んだファイル名がこれと一致することを確かめる。
 */
export function coinGeckoGlobalFilenames(date: string): {
  global: string;
  coinMarkets: string;
  stablecoinCategory: string;
} {
  return {
    global: `coingecko-global-${date}.json`,
    coinMarkets: `coingecko-coins-markets-${date}.json`,
    stablecoinCategory: `coingecko-categories-stablecoins-${date}.json`,
  };
}

// ---------------------------------------------------------------------------
// ファイル (API 応答 JSON) → 観測行 (純関数)
// ---------------------------------------------------------------------------

function decodeUtf8(file: SpecFile): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch (e) {
    throw new Error(`${tag} ${file.filename}: UTF-8 として読めません: ${(e as Error).message}`, { cause: e });
  }
}

function parseInstant(iso: string, what: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`${tag} ${what} が日時として読めません: ${iso}`);
  return ms;
}

/**
 * 3 つの応答が「キーの日付 (UTC) の 1 回のスナップショット」であることを確かめる。
 * 各更新時刻がその日 (UTC の 0 時以上・翌日 0 時未満) に入り、互いの差が
 * `COINGECKO_SNAPSHOT_TOLERANCE_MS` 以内であること。前日の時刻の値を今日の行にしない。
 */
function checkSnapshotTimes(period: ObservationPeriod, input: CoinGeckoGlobalObservationInput): void {
  const lower = Date.parse(`${period.start}T00:00:00.000Z`);
  const upper = lower + DAY_MS;
  const stamps: Array<{ what: string; iso: string }> = [
    { what: "/global の updated_at", iso: input.global.asOf },
    ...input.coins.map((c) => ({ what: `/coins/markets の ${c.id} の last_updated`, iso: c.lastUpdated })),
    { what: "/coins/categories の stablecoins の updated_at", iso: input.stablecoins.updatedAt },
  ];
  const times = stamps.map((s) => {
    const ms = parseInstant(s.iso, s.what);
    if (ms < lower || ms >= upper) {
      throw new Error(
        `${tag} ${s.what} (${s.iso}) が ${period.label} (UTC の 0 時〜24 時) の外です ` +
          `(その日のスナップショットとみなせない。UTC 0 時直後で CoinGecko 側が前日の集計のまま、` +
          `または更新停止・取り違えの可能性。時間を空けて再実行すること)`
      );
    }
    return ms;
  });
  const spread = Math.max(...times) - Math.min(...times);
  if (spread > COINGECKO_SNAPSHOT_TOLERANCE_MS) {
    throw new Error(
      `${tag} 3 つの応答の更新時刻が ${Math.round(spread / 60_000)} 分ずれています (上限 ${COINGECKO_SNAPSHOT_TOLERANCE_MS / 60_000} 分)。` +
        `1 回のスナップショットとみなせません: ${stamps.map((s) => `${s.what}=${s.iso}`).join(", ")}`
    );
  }
}

function toDraft(row: MoneyflowObservationRow, period: ObservationPeriod, allowedCoins: readonly string[]): ObservationDraft {
  const m = requireMapping(row.indicatorKey, "観測行");
  const where = `${row.indicatorKey} / ${row.segment}`;
  if (row.period !== period.label) {
    throw new Error(`${tag} ${where}: 行の期間 ${row.period} がキーの日付 ${period.label} と違います`);
  }
  if (row.unit !== m.moduleUnit) {
    throw new Error(`${tag} ${where}: 行の単位が想定 (${m.moduleUnit}) と違います: ${row.unit}`);
  }
  if (row.segmentType !== "資産クラス") {
    throw new Error(`${tag} ${where}: 行の区分種別が想定 (資産クラス) と違います: ${row.segmentType}`);
  }
  if (row.isEstimated) {
    throw new Error(`${tag} ${where}: モジュールが推定値の行を返しました (想定外)`);
  }
  if (m.perCoin ? !allowedCoins.includes(row.segment) : row.segment !== m.category) {
    throw new Error(
      `${tag} ${where}: 想定外の区分です (${m.perCoin ? `追跡銘柄: ${allowedCoins.join("・")}` : `想定: ${m.category}`})`
    );
  }
  return {
    period: period.label,
    periodStart: period.start,
    periodEnd: period.end,
    indicatorKey: row.indicatorKey,
    category: row.segment,
    categoryKind: m.categoryKind,
    value: m.convert(row.value, where),
    unit: m.unit,
    changeFromPrev: null,
    // 価格・残高・シェアはどれもお金の流れそのものではない (規約: 流れそのものでなければ true)。
    approximate: true,
    // CoinGecko の公表値そのもの (他統計からの推計ではない)。
    measureKind: "実測",
  };
}

/** 観測行の並び (固定): 銘柄 (モジュールの追跡銘柄の順) ごとに価格 → 時価総額、続いて全体の 3 指標。 */
function expectedRowOrder(coins: readonly string[]): Array<{ indicatorKey: string; category: string }> {
  const perCoin = [...MAPPINGS.entries()].filter(([, m]) => m.perCoin).map(([key]) => key);
  const single = [...MAPPINGS.entries()].filter(([, m]) => !m.perCoin);
  return [
    ...coins.flatMap((category) => perCoin.map((indicatorKey) => ({ indicatorKey, category }))),
    ...single.map(([indicatorKey, m]) => {
      if (m.category === null) throw new Error(`${tag} ${indicatorKey}: 区分が未定義です`);
      return { indicatorKey, category: m.category };
    }),
  ];
}

/** 3 ファイルを取り出して解析する (ファイル名の過不足・想定外のファイルは throw)。 */
function parseInput(period: ObservationPeriod, files: readonly SpecFile[]): CoinGeckoGlobalObservationInput {
  const names = coinGeckoGlobalFilenames(period.label);
  const expected: string[] = [names.global, names.coinMarkets, names.stablecoinCategory];
  const unexpected = files.filter((f) => !expected.includes(f.filename)).map((f) => f.filename);
  if (unexpected.length > 0) {
    throw new Error(`${tag} 想定外のファイルがあります (取り違えの疑い): ${unexpected.join(", ")}`);
  }
  const globalFile = requireSpecFile(files, (f) => f === names.global, `${tag} /global 応答`);
  const coinsFile = requireSpecFile(files, (f) => f === names.coinMarkets, `${tag} /coins/markets 応答`);
  const categoriesFile = requireSpecFile(files, (f) => f === names.stablecoinCategory, `${tag} /coins/categories 応答`);

  return {
    global: parseCoinGeckoGlobal(decodeUtf8(globalFile)),
    coins: parseCoinGeckoCoinMarkets(decodeUtf8(coinsFile)),
    stablecoins: parseCoinGeckoStablecoinCategory(decodeUtf8(categoriesFile)),
  };
}

function buildDrafts(key: string, files: readonly SpecFile[]): ObservationDraft[] {
  const period = parseBatchKey(key);
  const input = parseInput(period, files);
  checkSnapshotTimes(period, input);

  const coins = coinCategories();
  const byId = new Map<string, ObservationDraft>();
  for (const row of toCoinGeckoObservationRows(input, period)) {
    const draft = toDraft(row, period, coins);
    const id = `${draft.indicatorKey}|${draft.category}`;
    if (byId.has(id)) throw new Error(`${tag} 同じ指標・区分の行が重複しています (銘柄の重複の疑い): ${id}`);
    byId.set(id, draft);
  }
  const order = expectedRowOrder(coins);
  const drafts = order.map(({ indicatorKey, category }) => {
    const d = byId.get(`${indicatorKey}|${category}`);
    if (d === undefined) throw new Error(`${tag} ${key}: ${indicatorKey} / ${category} の行がありません`);
    return d;
  });
  if (byId.size !== order.length) {
    throw new Error(`${tag} ${key}: 観測行が ${byId.size} 件あり、想定 (${order.length} 件) より多いです`);
  }
  return drafts;
}

// ---------------------------------------------------------------------------
// 取得 (resolve / fetch)
// ---------------------------------------------------------------------------

/**
 * 保管の前に更新時刻だけを確かめる (理由はファイル先頭のコメント)。
 * - 解析でき、更新時刻がその日に入っていない → throw (保管しない。時間を空けて再実行すれば取り直せる)
 * - 解析でき、時刻も問題ない → true
 * - 解析できない (様式変更・壊れた応答) → false を返して保管へ進める。値を補うのではなく、
 *   一次データを残したうえで `toObservations` が同じ解析エラーで throw する (ルール6 と run-spec.ts の方針)。
 *   false は取得時メタデータ `snapshotTimesCheckedBeforeArchive` に残し、警告も出す。
 */
function snapshotTimesBeforeArchive(period: ObservationPeriod, files: readonly SpecFile[]): boolean {
  let input: CoinGeckoGlobalObservationInput;
  try {
    input = parseInput(period, files);
  } catch (e) {
    console.warn(
      `${tag} 保管前の更新時刻の確認で応答を解析できませんでした。一次データとして保管し、解析で失敗させます: ${(e as Error).message}`
    );
    return false;
  }
  checkSnapshotTimes(period, input);
  return true;
}

async function fetchBatch(key: string, period: ObservationPeriod): Promise<FetchedBatch> {
  // 3 つを順番に取る (匿名アクセスはレート制限が厳しいため同時に投げない)。モジュールの取得関数は
  // 2xx 以外の応答を throw するので、エラー応答の本文がこのキーで一次データとして保管されることは無い。
  const global = await fetchCoinGeckoGlobal();
  const coinMarkets = await fetchCoinGeckoCoinMarkets();
  const stablecoinCategory = await fetchCoinGeckoStablecoinCategory();
  const archive = coinGeckoArchiveInput({ global, coinMarkets, stablecoinCategory });
  if (archive.key !== key) {
    throw new Error(
      `${tag} 取得時刻から作ったキー ${archive.key} が対象のキー ${key} と違います ` +
        `(取込中に UTC の日付が変わった可能性。前日のキーで保管しないため中止)`
    );
  }
  const names = coinGeckoGlobalFilenames(period.label);
  const expected = [names.global, names.coinMarkets, names.stablecoinCategory];
  const actual = archive.files.map((f) => f.filename);
  if (actual.join(",") !== expected.join(",")) {
    throw new Error(
      `${tag} モジュールが組んだファイル名 (${actual.join(", ")}) がアダプタの想定 (${expected.join(", ")}) と違います`
    );
  }
  const checkedBeforeArchive = snapshotTimesBeforeArchive(period, archive.files);
  return {
    key,
    source: `CoinGecko API v3: ${global.url} / ${coinMarkets.url} / ${stablecoinCategory.url}`,
    metadata: {
      ...archive.metadata,
      snapshotDateUtc: period.label,
      snapshotTimesCheckedBeforeArchive: checkedBeforeArchive,
      coinIds: [...COINGECKO_MAJOR_COIN_IDS],
      terms: `${COINGECKO_API_TERMS_URL} (画面に出すときは「Powered by CoinGecko」の表示が必要)`,
    },
    files: archive.files,
  };
}

async function resolveCoinGeckoGlobal(now: Date): Promise<ResolvedBatch> {
  const period = resolveObservationPeriod("day", now);
  const observable = isPeriodObservable(period, now);
  if (!observable.observable) {
    throw new Error(`${tag} ${period.label} はまだ取得できません: ${observable.reason}`);
  }
  const key = coinGeckoGlobalBatchKey(period);
  return {
    key,
    fetch: () => fetchBatch(key, period),
  };
}

/** CoinGecko の暗号資産スナップショット (主要 5 銘柄の価格・時価総額、全体・ステーブルコイン時価総額、BTC ドミナンス)。 */
export const coingeckoGlobalSpec: MoneyflowSourceSpec = {
  name: COINGECKO_GLOBAL_SPEC_NAME,
  indicators: COINGECKO_GLOBAL_ADAPTER_INDICATORS,
  resolve: resolveCoinGeckoGlobal,
  toObservations({ key, files }) {
    return buildDrafts(key, files);
  },
};
