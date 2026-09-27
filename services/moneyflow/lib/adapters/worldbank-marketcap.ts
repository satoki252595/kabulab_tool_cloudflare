/**
 * moneyflow アダプタ: World Bank 上場企業時価総額 (CM.MKT.LCAP.CD、国・地域別、年次)。
 *
 * 取得元モジュール `../sources/worldbank-marketcap.ts` (取得・解析・独自の指標定義) を
 * `MoneyflowSourceSpec` (`../source-spec.ts`) に揃える。規約は `./README.md`。
 *
 * ## spec
 * `worldbank-marketcap` の 1 本 (指標 1 件: `worldbank_marketcap`)。World Bank API の
 * 時価総額 (全国・地域 × 直近 7 年の窓) と国・地域メタデータ (個別国か集計かの判定と
 * 名称の確認に使う) の 2 ファイルで 1 バッチ。
 *
 * ## 1 バッチの中身 (行数の上限)
 * 応答は 265 の国・地域 × 年 (2026-09-27 取得時点で値のある行は 614 行) で、全部を
 * 観測ログにすると 1 バッチ約 600 行の目安を超え、地域・所得階層などの集計 (約 30 系列)
 * が個別国と混ざる。そのため **実装で固定した 20 か国・地域 + 英国 + 世界計** だけを
 * 観測行にする (`WORLDBANK_MARKETCAP_ENTITIES`。毎回の順位で入れ替えない固定の規則。
 * 最大 22 区分 × 7 年 = 154 行)。20 か国・地域は 2026-09-27 取得時点の 2025 年末の値で
 * 時価総額が大きい順に選んだもの、英国は主要市場だが値の欠落が多いことを見せるために
 * 加えたもの (値のある年だけ行が出る)。
 *
 * ## 冪等キー
 * `worldbank-marketcap-<窓の開始年>-<窓の終了年>-updated-<WDI の更新日 YYYY-MM-DD>`。
 * World Bank は World Development Indicators (WDI) の更新のたびに過去の年も改訂しうるため、
 * 時価総額応答の先頭要素 `lastupdated` (WDI の更新日) を版としてキーに含める。窓は
 * `toObservations()` が「応答の年が窓の中にあるか」を確かめるのと、ファイル名を決めるのに
 * 使う (応答の中には窓そのものは書かれていない)。
 *
 * ## resolve() が本体を取る理由
 * 版 (WDI の更新日) は時価総額応答の中にしか無く、モジュールには版だけを軽く問い合わせる
 * 関数が無い。そのため resolve() で時価総額応答 (約 400KB・1 リクエスト) を取ってキーを
 * 決め、fetch() はそのバイト列を再利用し、国・地域メタデータ (約 110KB) だけを追加で取る。
 */
import type {
  IndicatorDefInput,
  MoneyflowCategoryKind,
  MoneyflowFlowType,
  MoneyflowFrequency,
  MoneyflowLicense,
  MoneyflowMeasureKind,
  MoneyflowRequirement,
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
  WORLDBANK_MARKETCAP_INDICATOR,
  defaultFetchWindow,
  fetchCountryMeta,
  fetchMarketCapWindow,
  parseCountryMetaResponse,
  parseMarketCapResponse,
  toObservationRecords,
  toObservations as toWorldBankObservations,
  type MoneyflowIndicatorDefinition,
  type MoneyflowObservationRecord,
  type WorldBankFetchWindow,
} from "../sources/worldbank-marketcap.js";

export const WORLDBANK_MARKETCAP_SPEC_NAME = "worldbank-marketcap";

/** World Bank API の時価総額応答の `sourceid` (World Development Indicators)。版の意味はこの前提で決まる。 */
const WDI_SOURCE_ID = "2";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^worldbank-marketcap-(\d{4})-(\d{4})-updated-(\d{4}-\d{2}-\d{2})$/;

// ---------------------------------------------------------------------------
// 区分 (固定): 世界計 + 20 か国・地域 + 英国
// ---------------------------------------------------------------------------

export interface WorldBankMarketCapEntity {
  /** World Bank の国/地域コード (indicator 応答の `country.id` = メタデータの `iso2Code`)。 */
  entityId: string;
  /** World Bank の英語表記 (メタデータの `name`)。変わったらコードの再割当てを疑って throw する。 */
  worldBankName: string;
  /** 観測ログの「区分」(日本語)。 */
  category: string;
  categoryKind: MoneyflowCategoryKind;
  /** World Bank の地域・所得階層などの集計なら true (メタデータの region.value === "Aggregates")。 */
  isAggregate: boolean;
}

/**
 * 観測行にする国・地域 (並び順 = 同じ年の中での行の順)。
 * 世界計 → 2025 年末の値 (2026-09-27 取得時点) で時価総額が大きい順の 20 か国・地域 → 英国。
 * 日本語名は IMF CPIS アダプタ (`./imf-cpis.ts`) と同じ表記に揃える (取得元をまたいで
 * 同じ国を同じ区分名で絞り込めるように)。
 */
export const WORLDBANK_MARKETCAP_ENTITIES: readonly WorldBankMarketCapEntity[] = [
  { entityId: "1W", worldBankName: "World", category: "世界計", categoryKind: "全体", isAggregate: true },
  { entityId: "US", worldBankName: "United States", category: "米国", categoryKind: "国地域", isAggregate: false },
  { entityId: "CN", worldBankName: "China", category: "中国", categoryKind: "国地域", isAggregate: false },
  { entityId: "IN", worldBankName: "India", category: "インド", categoryKind: "国地域", isAggregate: false },
  { entityId: "JP", worldBankName: "Japan", category: "日本", categoryKind: "国地域", isAggregate: false },
  { entityId: "HK", worldBankName: "Hong Kong SAR, China", category: "香港", categoryKind: "国地域", isAggregate: false },
  { entityId: "CA", worldBankName: "Canada", category: "カナダ", categoryKind: "国地域", isAggregate: false },
  { entityId: "DE", worldBankName: "Germany", category: "ドイツ", categoryKind: "国地域", isAggregate: false },
  { entityId: "KR", worldBankName: "Korea, Rep.", category: "韓国", categoryKind: "国地域", isAggregate: false },
  { entityId: "CH", worldBankName: "Switzerland", category: "スイス", categoryKind: "国地域", isAggregate: false },
  { entityId: "SA", worldBankName: "Saudi Arabia", category: "サウジアラビア", categoryKind: "国地域", isAggregate: false },
  { entityId: "AU", worldBankName: "Australia", category: "オーストラリア", categoryKind: "国地域", isAggregate: false },
  { entityId: "ZA", worldBankName: "South Africa", category: "南アフリカ", categoryKind: "国地域", isAggregate: false },
  { entityId: "ES", worldBankName: "Spain", category: "スペイン", categoryKind: "国地域", isAggregate: false },
  {
    entityId: "AE",
    worldBankName: "United Arab Emirates",
    category: "アラブ首長国連邦",
    categoryKind: "国地域",
    isAggregate: false,
  },
  { entityId: "ID", worldBankName: "Indonesia", category: "インドネシア", categoryKind: "国地域", isAggregate: false },
  { entityId: "BR", worldBankName: "Brazil", category: "ブラジル", categoryKind: "国地域", isAggregate: false },
  { entityId: "SG", worldBankName: "Singapore", category: "シンガポール", categoryKind: "国地域", isAggregate: false },
  { entityId: "MX", worldBankName: "Mexico", category: "メキシコ", categoryKind: "国地域", isAggregate: false },
  { entityId: "TH", worldBankName: "Thailand", category: "タイ", categoryKind: "国地域", isAggregate: false },
  { entityId: "MY", worldBankName: "Malaysia", category: "マレーシア", categoryKind: "国地域", isAggregate: false },
  { entityId: "GB", worldBankName: "United Kingdom", category: "英国", categoryKind: "国地域", isAggregate: false },
];

const ENTITY_BY_ID: ReadonlyMap<string, WorldBankMarketCapEntity> = new Map(
  WORLDBANK_MARKETCAP_ENTITIES.map((e) => [e.entityId, e])
);
const ENTITY_ORDER: ReadonlyMap<string, number> = new Map(WORLDBANK_MARKETCAP_ENTITIES.map((e, i) => [e.entityId, i]));

// ---------------------------------------------------------------------------
// 指標定義 (モジュールの定義 → IndicatorDefInput)
// ---------------------------------------------------------------------------

function toFlowType(ft: MoneyflowIndicatorDefinition["flowType"]): MoneyflowFlowType {
  if (ft === "holdings_stock") return "残高";
  throw new Error(`[${WORLDBANK_MARKETCAP_SPEC_NAME}] 対応付けの無い flowType です (アダプタの更新が必要): ${ft}`);
}

function toRequirement(reqs: readonly string[]): MoneyflowRequirement {
  // docs/moneyflow.md の在庫表で World Bank (上場時価総額・国別) は R4 (日本⇔海外・世界の概況)。
  if (reqs.length === 1 && reqs[0] === "R4") return "R4";
  throw new Error(`[${WORLDBANK_MARKETCAP_SPEC_NAME}] 要件が想定 (R4 のみ) と違います: ${reqs.join(",")}`);
}

function toFrequency(freq: string): MoneyflowFrequency {
  if (freq === "annual") return "年次";
  throw new Error(`[${WORLDBANK_MARKETCAP_SPEC_NAME}] 対応付けの無い頻度です: ${freq}`);
}

function toUnit(unit: string): MoneyflowUnit {
  // World Bank の CM.MKT.LCAP.CD は "current US$" (倍率なし = 1 米ドル単位)。為替換算はしない (規約)。
  if (unit === "USD") return "米ドル";
  throw new Error(`[${WORLDBANK_MARKETCAP_SPEC_NAME}] 対応付けの無い単位です: ${unit}`);
}

function toLicense(license: string): MoneyflowLicense {
  // CC BY 4.0 = 出典表示を条件に商用利用・再配布とも可。緩い側 (public-domain) には丸めない。
  if (license.startsWith("CC BY-4.0")) return "attribution-required";
  throw new Error(`[${WORLDBANK_MARKETCAP_SPEC_NAME}] 対応付けの無い利用条件です: ${license}`);
}

function toMeasureKind(measurement: string): MoneyflowMeasureKind {
  // World Bank の公表値をそのまま使う (モデル推計ではない)。
  if (measurement === "actual") return "実測";
  throw new Error(`[${WORLDBANK_MARKETCAP_SPEC_NAME}] 対応付けの無い実測/推定の区分です: ${measurement}`);
}

/** 限界欄に載せる「上位の国・地域」(世界計と、上位とは別枠で加えた英国を除く。固定リストの並び)。 */
function rankedCountries(): { names: string; count: number } {
  const names = WORLDBANK_MARKETCAP_ENTITIES.filter((e) => !e.isAggregate && e.entityId !== "GB").map((e) => e.category);
  return { names: names.join("・"), count: names.length };
}

const PLAIN_DESCRIPTION =
  "その国・地域の証券取引所に上場している国内企業 (その国の会社) の「株価×株数」を、" +
  "年末時点ですべて足し合わせた合計額 (時価総額)。" +
  "例えば日本の時価総額が1年で1.2倍になっても、それは(1)株価が上がった分と(2)新しく上場した会社が" +
  "増えた分などが混ざったもので、「その年に新しくいくら投資されたか」を表すお金の流れ (フロー) ではない。" +
  "ある一時点で積み上がっている株式の残高 (ストック) と考える。";

const UNIT_AND_SIGN_DESCRIPTION =
  " 値の単位は米ドル (各年末の為替レートで米ドルに換算した額。1 = 1米ドルで、円には換算していない)。" +
  "値は『その時点の大きさ』で、流入 (プラス)・流出 (マイナス) のような向きを表す符号の付いた値ではない。" +
  "期間は暦年『YYYY』で、年末時点の値として開始日・終了日とも YYYY-12-31 で記録する。" +
  "米ドル換算のため為替の動きも混ざる。例: 円安が進むと、日本株の株価 (円建て) が変わらなくても、" +
  "米ドルに換算した日本の時価総額は小さくなる。";

function buildLimitations(def: MoneyflowIndicatorDefinition): string {
  const ranked = rankedCountries();
  return (
    "残高 (ストック) であり、真の資金フロー (純流入・純流出) ではない。前年からの増減には、" +
    "株価の値上がり・値下がり、新規上場・上場廃止、増資・自社株買い、米ドル換算の為替の動きが混ざる。" +
    ` 区分は実装で固定した${ranked.count}か国・地域 (2026-09-27 取得時点の2025年末の値で時価総額が大きい順: ${ranked.names}) ` +
    "と英国、世界計 (World Bank の World 集計) だけで、毎回の順位で入れ替えはしない。" +
    "地域別・所得階層別などほかの集計は含めない。" +
    " 原データは World Federation of Exchanges (WFE) 加盟取引所の統計で、非加盟の取引所・店頭市場は" +
    "含まれない可能性がある。2026-09-27 取得時点では、英国は2021・2022年だけ値があり、" +
    "フランス・オランダ・イタリアなど欧州の主要国には値が無い (そのため区分に入れていない)。" +
    "台湾は World Bank の国・地域一覧に無く対象外。" +
    " 世界計は World Bank の集計値で、2026-09-27 取得時点の値では、値のある個別国の合計より約2%大きいだけだった。" +
    "値の無い英国・フランスなどの分を十分に含んでいない可能性があり、実際の世界全体の上場時価総額より" +
    "小さいことがある (各国の割合を計算するときは注意)。" +
    " 国ごとに取引所の報告や World Bank への反映の時期が違うため、同じ取込でも国によって最新で入っている" +
    "年が揃わない (例: 2026-09-27 取得時点で2025年の値がある個別国は68、2024年は70)。" +
    "値の無い年は行を作らない (0 で埋めない)。" +
    " 公表ラグ: 年末の値は翌年以降に World Development Indicators (WDI) の更新で入る " +
    "(2026-09-27 取得時点=WDI 更新日 2026-07-13 の時点で2025年末の値が入っていた)。" +
    " 1回の取込では直近7年 (実行年の6年前〜実行年) を取り、値のある年だけを記録する。" +
    "WDI が更新される (更新日が変わる) と窓の中の過去の年も取り直して上書きするため、World Bank の改訂が" +
    "反映される。ただし上書きできるのは新しい版でも値がある行だけで、観測ログの行は消さないため、" +
    "新しい版で値が取り消された (空欄になった) 年や、窓から外れた古い年には古い版の値が残る " +
    "(観測行の一次データの紐付けで、どの版の値かを確かめられる)。" +
    " 前期比は記録しない (空欄)。前年と比べるときは同じ区分の前年の行を見る。" +
    ` 利用条件は CC BY 4.0 (出典表示が必要)。表示・再配布の際の出典表示: ${def.attribution}`
  );
}

function toIndicatorDef(def: MoneyflowIndicatorDefinition): IndicatorDefInput {
  // 単位の対応付けが無ければここで throw させる (観測行と同じ換算規則を指標定義にも通す)。
  toUnit(def.unit);
  return {
    key: def.key,
    displayName: def.label,
    requirement: toRequirement(def.requirements),
    flowType: toFlowType(def.flowType),
    description: `${PLAIN_DESCRIPTION} 正確な定義: ${def.measures}${UNIT_AND_SIGN_DESCRIPTION}`,
    sourceUrl: def.sourceUrl,
    license: toLicense(def.license),
    frequency: toFrequency(def.frequency),
    limitations: buildLimitations(def),
  };
}

export const WORLDBANK_MARKETCAP_ADAPTER_INDICATORS: readonly IndicatorDefInput[] = [
  toIndicatorDef(WORLDBANK_MARKETCAP_INDICATOR),
];

// ---------------------------------------------------------------------------
// キー・ファイル名
// ---------------------------------------------------------------------------

/** 冪等キー。窓 (開始年-終了年) と WDI の更新日 (版) から決まる。 */
export function worldbankMarketcapBatchKey(window: WorldBankFetchWindow, wdiLastUpdated: string): string {
  if (!Number.isInteger(window.fromYear) || !Number.isInteger(window.toYear) || window.fromYear > window.toYear) {
    throw new Error(`[${WORLDBANK_MARKETCAP_SPEC_NAME}] 不正な年の窓です: ${JSON.stringify(window)}`);
  }
  if (!ISO_DATE_RE.test(wdiLastUpdated)) {
    throw new Error(`[${WORLDBANK_MARKETCAP_SPEC_NAME}] WDI の更新日が YYYY-MM-DD ではありません: ${wdiLastUpdated}`);
  }
  return `${WORLDBANK_MARKETCAP_SPEC_NAME}-${window.fromYear}-${window.toYear}-updated-${wdiLastUpdated}`;
}

function parseBatchKey(key: string): { window: WorldBankFetchWindow; wdiLastUpdated: string } {
  const m = KEY_RE.exec(key);
  if (!m) {
    throw new Error(
      `[${WORLDBANK_MARKETCAP_SPEC_NAME}] キーの形式が違います (worldbank-marketcap-<開始年>-<終了年>-updated-<YYYY-MM-DD>): ${key}`
    );
  }
  const window = { fromYear: Number(m[1]), toYear: Number(m[2]) };
  const wdiLastUpdated = m[3] as string;
  // 年の大小関係・日付形式の検証をキーの組み立てと共通にする (組み直して一致を確かめる)。
  if (worldbankMarketcapBatchKey(window, wdiLastUpdated) !== key) {
    throw new Error(`[${WORLDBANK_MARKETCAP_SPEC_NAME}] キーを組み立て直すと一致しません: ${key}`);
  }
  return { window, wdiLastUpdated };
}

/** 保管ファイル名 (モジュールの一次データ入力 `worldBank*ArchiveInput` と同じ付け方)。 */
export function worldbankMarketcapFilenames(window: WorldBankFetchWindow): { marketCap: string; countryMeta: string } {
  return {
    marketCap: `worldbank-marketcap-${window.fromYear}-${window.toYear}.json`,
    countryMeta: `worldbank-country-meta-${window.toYear}.json`,
  };
}

// ---------------------------------------------------------------------------
// ファイル (World Bank API 応答 JSON) → 観測行 (純関数)
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function decodeJson(file: SpecFile): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch (e) {
    throw new Error(`[${WORLDBANK_MARKETCAP_SPEC_NAME}] ${file.filename}: UTF-8 として読めません: ${(e as Error).message}`, {
      cause: e,
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new Error(`[${WORLDBANK_MARKETCAP_SPEC_NAME}] ${file.filename}: JSON として読めません: ${(e as Error).message}`, {
      cause: e,
    });
  }
}

/**
 * World Bank API 応答 `[meta, rows]` の meta から、件数 (total) と行数の一致を確かめる。
 * モジュールのパーサ (`assertCompleteSinglePage`) も同じ一致を要求するが、どの
 * ファイルが欠けていたかを示せるよう、パーサより先にアダプタ側で (ファイル名付きで)
 * 確かめる。
 */
function assertComplete(json: unknown, what: string): void {
  if (!Array.isArray(json) || json.length !== 2 || !isObject(json[0]) || !Array.isArray(json[1])) {
    throw new Error(`[${WORLDBANK_MARKETCAP_SPEC_NAME}] ${what}: 応答の形が [meta, rows] ではありません`);
  }
  const total = Number(json[0].total);
  if (!Number.isInteger(total) || total !== json[1].length) {
    throw new Error(
      `[${WORLDBANK_MARKETCAP_SPEC_NAME}] ${what}: 応答の件数 total=${String(json[0].total)} と行数 ${json[1].length} が一致しません`
    );
  }
}

/**
 * 時価総額応答の meta から WDI の更新日 (版) を読む。モジュールのパーサは meta の
 * `lastupdated` を返さないため、アダプタで読む (moduleIssues 参照)。
 */
export function readWdiLastUpdated(json: unknown, what: string): string {
  if (!Array.isArray(json) || !isObject(json[0])) {
    throw new Error(`[${WORLDBANK_MARKETCAP_SPEC_NAME}] ${what}: 応答の先頭が meta オブジェクトではありません`);
  }
  const meta = json[0];
  if (meta.sourceid !== WDI_SOURCE_ID) {
    throw new Error(
      `[${WORLDBANK_MARKETCAP_SPEC_NAME}] ${what}: sourceid が WDI (${WDI_SOURCE_ID}) ではありません: ${JSON.stringify(meta.sourceid)}`
    );
  }
  const lastUpdated = meta.lastupdated;
  if (typeof lastUpdated !== "string" || !ISO_DATE_RE.test(lastUpdated)) {
    throw new Error(
      `[${WORLDBANK_MARKETCAP_SPEC_NAME}] ${what}: lastupdated (YYYY-MM-DD) がありません: ${JSON.stringify(lastUpdated)}`
    );
  }
  return lastUpdated;
}

function toDraft(record: MoneyflowObservationRecord, entity: WorldBankMarketCapEntity): ObservationDraft {
  if (record.periodType !== "annual" || !/^\d{4}$/.test(record.period)) {
    throw new Error(
      `[${WORLDBANK_MARKETCAP_SPEC_NAME}] 期間が年次 (YYYY) ではありません: ${record.periodType} ${record.period}`
    );
  }
  if (record.value === undefined) {
    throw new Error(`[${WORLDBANK_MARKETCAP_SPEC_NAME}] 値の無い行を観測行にしようとしました: ${record.categoryCode} ${record.period}`);
  }
  const yearEnd = `${record.period}-12-31`;
  return {
    period: record.period,
    periodStart: yearEnd,
    periodEnd: yearEnd,
    indicatorKey: record.indicatorKey,
    category: entity.category,
    categoryKind: entity.categoryKind,
    value: record.value,
    unit: toUnit(record.unit),
    // 前年比はモジュールが同じ応答内の前年値から計算できるが記録しない: 窓の最初の年は
    // 前年値が応答に無く null になり、窓が1年ずれた次のバッチでは同じ行の前年比が
    // 値→null へ上書きされてしまうため (指標定義の「限界」に明記)。
    changeFromPrev: null,
    approximate: record.isApprox,
    measureKind: toMeasureKind(record.measurement),
  };
}

function buildDrafts(key: string, files: readonly SpecFile[]): ObservationDraft[] {
  const { window, wdiLastUpdated } = parseBatchKey(key);
  const names = worldbankMarketcapFilenames(window);
  const mcFile = requireSpecFile(files, (f) => f === names.marketCap, `[${WORLDBANK_MARKETCAP_SPEC_NAME}] 時価総額`);
  const metaFile = requireSpecFile(
    files,
    (f) => f === names.countryMeta,
    `[${WORLDBANK_MARKETCAP_SPEC_NAME}] 国・地域メタデータ`
  );

  const mcJson = decodeJson(mcFile);
  const fileLastUpdated = readWdiLastUpdated(mcJson, mcFile.filename);
  if (fileLastUpdated !== wdiLastUpdated) {
    throw new Error(
      `[${WORLDBANK_MARKETCAP_SPEC_NAME}] キーの WDI 更新日 ${wdiLastUpdated} とファイルの lastupdated ${fileLastUpdated} が一致しません`
    );
  }
  assertComplete(mcJson, mcFile.filename);
  const rows = parseMarketCapResponse(mcJson);
  const outOfWindow = rows.filter((r) => r.year < window.fromYear || r.year > window.toYear);
  if (outOfWindow.length > 0) {
    throw new Error(
      `[${WORLDBANK_MARKETCAP_SPEC_NAME}] 窓 ${window.fromYear}〜${window.toYear} の外の年が応答にあります: ` +
        [...new Set(outOfWindow.map((r) => r.year))].join(", ")
    );
  }

  const metaJson = decodeJson(metaFile);
  assertComplete(metaJson, metaFile.filename);
  const meta = parseCountryMetaResponse(metaJson);

  const records = toObservationRecords(toWorldBankObservations(rows, meta));

  // 固定リストの国・地域が応答にあり、名前・集計区分が想定どおりかを確かめる
  // (コードの再割当てや名称変更を黙って別の国として取り込まない)。
  for (const entity of WORLDBANK_MARKETCAP_ENTITIES) {
    const hits = records.filter((r) => r.categoryCode === entity.entityId);
    if (hits.length === 0) {
      throw new Error(
        `[${WORLDBANK_MARKETCAP_SPEC_NAME}] 固定リストの ${entity.entityId} (${entity.worldBankName}) が応答にありません (様式またはコードの変更)`
      );
    }
    for (const r of hits) {
      if (r.categoryValue !== entity.worldBankName || r.isAggregate !== entity.isAggregate) {
        throw new Error(
          `[${WORLDBANK_MARKETCAP_SPEC_NAME}] ${entity.entityId} の名称/集計区分が想定と違います: ` +
            `"${r.categoryValue}" (集計=${r.isAggregate})、想定 "${entity.worldBankName}" (集計=${entity.isAggregate})。` +
            "WORLDBANK_MARKETCAP_ENTITIES の見直しが必要です"
        );
      }
    }
  }

  const keyed = records
    .filter((r) => ENTITY_BY_ID.has(r.categoryCode) && r.value !== undefined)
    .map((r) => {
      const entity = ENTITY_BY_ID.get(r.categoryCode) as WorldBankMarketCapEntity;
      return { year: Number(r.period), order: ENTITY_ORDER.get(r.categoryCode) as number, draft: toDraft(r, entity) };
    });
  // 行の順序を決める (年の古い順 → 固定リストの順)。最後の行が「取込完了」の印になる。
  keyed.sort((a, b) => a.year - b.year || a.order - b.order);
  if (keyed.length === 0) {
    throw new Error(`[${WORLDBANK_MARKETCAP_SPEC_NAME}] 固定リストの国・地域に値のある行が 1 件もありません`);
  }
  return keyed.map((k) => k.draft);
}

// ---------------------------------------------------------------------------
// 取得 (resolve / fetch)
// ---------------------------------------------------------------------------

async function resolveWorldBankMarketCap(now: Date): Promise<ResolvedBatch> {
  const window = defaultFetchWindow(now);
  const marketCap = await fetchMarketCapWindow(window);
  const wdiLastUpdated = readWdiLastUpdated(marketCap.json, marketCap.url);
  const key = worldbankMarketcapBatchKey(window, wdiLastUpdated);
  const names = worldbankMarketcapFilenames(window);

  return {
    key,
    async fetch(): Promise<FetchedBatch> {
      const countryMeta = await fetchCountryMeta();
      const files: PrimaryFile[] = [
        { filename: names.marketCap, bytes: marketCap.bytes, contentType: "application/json" },
        { filename: names.countryMeta, bytes: countryMeta.bytes, contentType: "application/json" },
      ];
      return {
        key,
        source: `World Bank API v2 (World Development Indicators, CM.MKT.LCAP.CD): ${marketCap.url} / ${countryMeta.url}`,
        metadata: {
          indicator: "CM.MKT.LCAP.CD",
          dataset: "World Development Indicators (World Bank API sourceid=2)",
          wdiLastUpdated,
          fromYear: window.fromYear,
          toYear: window.toYear,
          marketCapUrl: marketCap.url,
          countryMetaUrl: countryMeta.url,
          marketCapBytes: marketCap.bytes.byteLength,
          countryMetaBytes: countryMeta.bytes.byteLength,
          license: "CC BY 4.0 (https://datacatalog.worldbank.org/int/public-licenses#cc-by)",
          attribution: WORLDBANK_MARKETCAP_INDICATOR.attribution,
        },
        files,
      };
    },
  };
}

/** World Bank 上場企業時価総額 (国・地域別、年次、固定の 22 区分)。 */
export const worldbankMarketcapSpec: MoneyflowSourceSpec = {
  name: WORLDBANK_MARKETCAP_SPEC_NAME,
  indicators: WORLDBANK_MARKETCAP_ADAPTER_INDICATORS,
  resolve: resolveWorldBankMarketCap,
  toObservations({ key, files }) {
    return buildDrafts(key, files);
  },
};
