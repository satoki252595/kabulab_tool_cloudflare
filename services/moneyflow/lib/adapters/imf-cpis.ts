/**
 * moneyflow アダプタ: IMF CPIS (国別の対外・対内証券投資「残高」、DBnomics 経由)。
 *
 * 取得元モジュール `../sources/imf-cpis.ts` (取得・解析・独自の指標定義) を
 * `MoneyflowSourceSpec` (`../source-spec.ts`) に揃える。規約は `./README.md`。
 *
 * ## spec
 * `imf-cpis` の 1 本。日本の「対外 (日本の投資家→海外の証券) / 対内 (海外の投資家→
 * 日本の証券、IMF の Derived 系列)」×「合計 / 株式 / 債券」の 6 指標を、
 * モジュール既定の相手国・地域 (`IMF_CPIS_DEFAULT_COUNTERPART_AREAS`: 16 か国・地域
 * + 世界計 W00) について取る。ただし対内 (Derived) からは台湾 (TW) を除く
 * (台湾は IMF 非加盟で CPIS に報告しないため、「台湾の投資家→日本」の Derived 系列は
 * 作られない。存在しない系列を毎回問い合わせると、DBnomics の返し方次第で
 * 毎回の警告かバッチ全体の失敗になる)。対外 3 × 17 + 対内 3 × 16 = 99 系列を
 * DBnomics へ 60 系列ずつ (= 2 リクエスト) まとめて問い合わせる。
 *
 * ## 1 バッチの中身 (行数の上限)
 * 応答には各系列の全履歴 (1997年〜) が入っているが、全部を観測ログにすると
 * 99 系列 × 約 36 期 ≒ 3,600 行になり、1 バッチ約 600 行の目安を超える。
 * そのため **DBnomics 上の最新の半期とその前の 3 期 (計 4 期 = 2 年分)** だけを
 * 観測行にする (固定の規則。最大 99 × 4 = 396 行)。前の期を毎回含めるのは、
 * IMF が後から前の期を改訂したときに上書きで取り込むため。
 *
 * ## 冪等キー
 * `imf-cpis-<最新の半期 YYYY-Hn>-updated-<DBnomics の IMF/CPIS 更新日 YYYY-MM-DD>`。
 * CPIS は後から改訂され、DBnomics のミラーも系列ごとにずれて更新されうるため、
 * ミラーの更新日 (応答の `datasets["IMF/CPIS"].updated_at`) を版として含める
 * (更新日が変われば別バッチとして取り直す)。キーの要素はすべてファイルの中身から
 * 決まるので、`toObservations()` はファイルから同じキーを再計算して一致を確かめる。
 *
 * ## resolve() が本体を取る理由
 * 「最新の半期」は系列の本体を取らないと分からない (モジュールに一覧・目次 API が
 * 無く、DBnomics 側にも半期の公表カレンダーは無い)。そのため resolve() で本体
 * (2 リクエスト・計数百 KB) を取ってキーを決め、fetch() はそのバイト列をそのまま
 * 返す (二重に取りに行かない)。
 *
 * ## 生バイト列の保管 (ルール6)
 * モジュールの `fetchImfCpis()` はパース済みレコードしか返さないため、
 * `fetchImpl` に「応答のコピーを取っておく fetch」を渡して、DBnomics の応答 JSON を
 * 1 リクエスト = 1 ファイル (`imf-cpis-dbnomics-01.json`, `-02.json`, …) として保管する。
 */
import type {
  IndicatorDefInput,
  MoneyflowCategoryKind,
  MoneyflowFlowType,
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
  type SpecFile,
} from "../source-spec.js";
import {
  IMF_CPIS_API_BASE,
  IMF_CPIS_DEFAULT_COUNTERPART_AREAS,
  IMF_CPIS_INDICATORS,
  buildImfCpisSeriesCode,
  fetchImfCpis,
  latestImfCpisPeriod,
  parseImfCpisPeriod,
  parseImfCpisResponse,
  toImfCpisObservationRows,
  type ImfCpisAssetClass,
  type ImfCpisDirection,
  type ImfCpisFetchRequest,
  type ImfCpisFlowType,
  type ImfCpisIndicatorDef,
  type ImfCpisRecord,
} from "../sources/imf-cpis.js";

export const IMF_CPIS_SPEC_NAME = "imf-cpis";

/** 1 バッチに含める半期の数 (最新の半期 + その前の 3 期 = 2 年分)。 */
export const IMF_CPIS_PERIOD_WINDOW = 4;

/** DBnomics 応答で IMF CPIS データセットのメタデータが入るキー。 */
const DBNOMICS_DATASET_KEY = "IMF/CPIS";

const PART_FILE_RE = /^imf-cpis-dbnomics-\d{2}\.json$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** DBnomics 応答 1 本 (= 1 リクエスト) を保管するファイル名。n は 1 始まり。 */
export function imfCpisPartFilename(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 99) {
    throw new Error(`[imf-cpis] 分割ファイルの番号が不正です (1〜99): ${n}`);
  }
  return `imf-cpis-dbnomics-${String(n).padStart(2, "0")}.json`;
}

// ---------------------------------------------------------------------------
// 取得対象 (固定): 向き 2 × 資産クラス 3 × 相手国・地域 17
// ---------------------------------------------------------------------------

const SERIES_TARGETS: ReadonlyArray<{ direction: ImfCpisDirection; assetClass: ImfCpisAssetClass }> = [
  { direction: "jp_holds_abroad", assetClass: "total" },
  { direction: "jp_holds_abroad", assetClass: "equity" },
  { direction: "jp_holds_abroad", assetClass: "debt" },
  { direction: "world_holds_jp", assetClass: "total" },
  { direction: "world_holds_jp", assetClass: "equity" },
  { direction: "world_holds_jp", assetClass: "debt" },
];

/**
 * 対内 (Derived) で問い合わせない相手国・地域。台湾 (TW) は IMF 非加盟で CPIS に
 * 報告しないため、IMF が各国の資産報告を集め直して作る Derived 系列
 * (「台湾の投資家が持つ日本の証券」) は原理的に作られない。対外 (日本が報告する
 * 「日本の投資家が持つ台湾の証券」) には値があるので、そちらでは残す。
 */
const LIABILITIES_EXCLUDED_AREAS: ReadonlySet<string> = new Set(["TW"]);

/** 向きごとの問い合わせ対象 (モジュール既定の並びのまま)。 */
export function imfCpisCounterpartAreas(direction: ImfCpisDirection): readonly string[] {
  if (direction === "jp_holds_abroad") return IMF_CPIS_DEFAULT_COUNTERPART_AREAS;
  if (direction === "world_holds_jp") {
    for (const a of LIABILITIES_EXCLUDED_AREAS) {
      if (!(IMF_CPIS_DEFAULT_COUNTERPART_AREAS as readonly string[]).includes(a)) {
        throw new Error(`[imf-cpis] 対内から除く相手国 ${a} がモジュール既定の一覧にありません (アダプタの更新が必要)`);
      }
    }
    return IMF_CPIS_DEFAULT_COUNTERPART_AREAS.filter((a) => !LIABILITIES_EXCLUDED_AREAS.has(a));
  }
  throw new Error(`[imf-cpis] 未知の向きです: ${String(direction)}`);
}

const FETCH_REQUESTS: readonly ImfCpisFetchRequest[] = SERIES_TARGETS.map((t) => ({
  direction: t.direction,
  assetClass: t.assetClass,
  counterpartAreas: imfCpisCounterpartAreas(t.direction),
}));

/** 問い合わせる全系列の series_code (DBnomics の応答に含まれてよいのはこの集合だけ)。 */
export const IMF_CPIS_EXPECTED_SERIES_CODES: readonly string[] = SERIES_TARGETS.flatMap((t) =>
  imfCpisCounterpartAreas(t.direction).map((area) =>
    buildImfCpisSeriesCode({ direction: t.direction, assetClass: t.assetClass, counterpartArea: area })
  )
);

/**
 * IMF の相手国・地域コード → 観測ログの「区分」(日本語) と区分種別。
 * IMF (DBnomics) の英語表記: W00=World, US=United States, KY=Cayman Islands,
 * GB=United Kingdom, LU=Luxembourg, IE=Ireland, FR=France, DE=Germany,
 * NL=Netherlands, CH=Switzerland, AU=Australia, CA=Canada, HK=Hong Kong, China,
 * SG=Singapore, KR=Korea, Republic of, TW=Taiwan, Province of China, CN=China
 * (2026-09-27 取得の応答 `dimensions_values_labels.COUNTERPART_AREA` で確認)。
 * 世界計 (W00) は国別の軸ではなく相手国全体の合計なので区分種別を「全体」にする。
 */
const AREA_LABELS: ReadonlyMap<string, { category: string; categoryKind: MoneyflowCategoryKind }> = new Map([
  ["W00", { category: "世界計", categoryKind: "全体" }],
  ["US", { category: "米国", categoryKind: "国地域" }],
  ["KY", { category: "ケイマン諸島", categoryKind: "国地域" }],
  ["GB", { category: "英国", categoryKind: "国地域" }],
  ["LU", { category: "ルクセンブルク", categoryKind: "国地域" }],
  ["IE", { category: "アイルランド", categoryKind: "国地域" }],
  ["FR", { category: "フランス", categoryKind: "国地域" }],
  ["DE", { category: "ドイツ", categoryKind: "国地域" }],
  ["NL", { category: "オランダ", categoryKind: "国地域" }],
  ["CH", { category: "スイス", categoryKind: "国地域" }],
  ["AU", { category: "オーストラリア", categoryKind: "国地域" }],
  ["CA", { category: "カナダ", categoryKind: "国地域" }],
  ["HK", { category: "香港", categoryKind: "国地域" }],
  ["SG", { category: "シンガポール", categoryKind: "国地域" }],
  ["KR", { category: "韓国", categoryKind: "国地域" }],
  ["TW", { category: "台湾", categoryKind: "国地域" }],
  ["CN", { category: "中国", categoryKind: "国地域" }],
]);

function requireAreaLabel(code: string): { category: string; categoryKind: MoneyflowCategoryKind } {
  const label = AREA_LABELS.get(code);
  if (!label) {
    throw new Error(`[imf-cpis] 日本語の区分名が未定義の相手国・地域コードです: ${code} (AREA_LABELS に追加が必要)`);
  }
  return label;
}

/** 限界欄に載せる相手国・地域の一覧 (世界計を除く。その向きの取得対象と同じ並び)。 */
function describeCountries(direction: ImfCpisDirection): { names: string; count: number } {
  const names = imfCpisCounterpartAreas(direction)
    .filter((c) => c !== "W00")
    .map((c) => requireAreaLabel(c).category);
  return { names: names.join("・"), count: names.length };
}

// ---------------------------------------------------------------------------
// 指標定義 (モジュールの定義 → IndicatorDefInput)
// ---------------------------------------------------------------------------

function toFlowType(ft: ImfCpisFlowType): MoneyflowFlowType {
  if (ft === "holdings_stock") return "残高";
  throw new Error(`[imf-cpis] 対応付けの無い flowType です (アダプタの更新が必要): ${ft}`);
}

function toRequirement(key: string, reqs: readonly string[]): MoneyflowRequirement {
  // docs/moneyflow.md の在庫表で IMF CPIS は R4 (日本⇔海外・世界の概況)。
  if (reqs.length === 1 && reqs[0] === "R4") return "R4";
  throw new Error(`[imf-cpis] ${key}: 要件が想定 (R4 のみ) と違います: ${reqs.join(",")}`);
}

function toUnit(unit: string): MoneyflowUnit {
  // IMF CPIS は IMF が各国の報告を米ドルに換算した値 (倍率なし = 1 米ドル単位)。
  if (unit === "USD") return "米ドル";
  throw new Error(`[imf-cpis] 対応付けの無い単位です: ${unit}`);
}

function directionOfKey(key: string): ImfCpisDirection {
  if (key.startsWith("imf_cpis_jp_assets_")) return "jp_holds_abroad";
  if (key.startsWith("imf_cpis_jp_liabilities_")) return "world_holds_jp";
  throw new Error(`[imf-cpis] 指標キーから向きを判別できません: ${key}`);
}

const COMMON_DESCRIPTION =
  " 値の単位は米ドル (IMF が各国の報告を米ドルに換算した額。1 = 1米ドルで、円には換算していない)。" +
  "値は『保有している額』で、流入 (プラス)・流出 (マイナス) のような向きを表す符号の付いた値ではない。" +
  "6月末時点の値を『YYYY-H1』、12月末時点の値を『YYYY-H2』として記録する (IMF・DBnomics の表記では YYYY-S1 / YYYY-S2)。" +
  "前の期との差にも値上がり・値下がりや為替の動きが混ざるため、差をそのまま『お金が流れ込んだ額』と読むことはできない。";

const ASSETS_DESCRIPTION =
  " 例: 日本→米国の残高が半年で2.0兆ドルから2.1兆ドルに増えても、その多くが米国株・米国債の値上がりによるものなら、" +
  "新たに投資したお金はずっと少ない。" +
  "国・地域は、証券を発行した企業・政府がどこの国の居住者かで分けたもので、証券が発行・売買された市場の場所ではない" +
  " (例: 日本企業がロンドンで発行した債券は『海外の証券』に入らない)。" +
  "対象は国際収支統計でいう『証券投資』で、直接投資 (出資比率10%以上の株式など) と" +
  "外貨準備 (政府・日本銀行が持つ外貨建ての資産) は含まない。";

const LIABILITIES_DESCRIPTION =
  " 例: 円安になると、海外の投資家が日本株を1株も売っていなくても、米ドルに換算した残高は減る。" +
  "相手国が IMF に報告した『その国の投資家が持つ日本の証券』を IMF が集め直した値で、" +
  "直接投資にあたる保有と、相手国の外貨準備 (海外の中央銀行などが持つ日本国債など) は国別の値に含まれない。";

function commonLimitations(direction: ImfCpisDirection): string {
  const { names, count } = describeCountries(direction);
  return (
    ` 区分 (相手国・地域) は実装で固定した${count}か国・地域 (${names}) と世界計のみで、` +
    "IMF が定めた『主要国』ではない (日本の対外証券投資で残高が大きい国・ファンドの設立地・アジアの主要国を選んだもの)。" +
    `世界計は IMF が示す相手国全体の合計で、上の${count}か国・地域を足した値とは一致しない (ほかの国・地域の分を含むため)。` +
    `1回の取込で記録するのは DBnomics 上の最新の半期とその前の${IMF_CPIS_PERIOD_WINDOW - 1}期 ` +
    `(計${IMF_CPIS_PERIOD_WINDOW}期=2年分) だけで、それより古い履歴は取り込まない。` +
    "IMF の改訂で前の期の値が変わった場合は、DBnomics の更新後の取込で上書きされる。" +
    "守秘義務による非開示やデータの無い組み合わせは行を作らない (0 で埋めない)。" +
    "前期比は記録しない (空欄)。変化は同じ指標・区分の前の期の行と比べること。" +
    "IMF 自体の公表も基準日 (6月末・12月末) から数か月以上あとになる。" +
    "取得経路は DBnomics (db.nomics.world) の公開 API で、IMF 本体の新 API は利用登録が必要なため使っていない。" +
    "利用条件は原典である IMF の規約 (DBnomics 上の記載: http://datahelp.imf.org/tos) に従い、出典 (IMF CPIS) の表示が必要。"
  );
}

const LIABILITIES_LIMITATIONS =
  " 対内の世界計は、CPIS に報告している約80の国・地域の投資家が持つ日本の証券を IMF が足し上げた値で、" +
  "『海外の投資家全体が持つ日本の証券』の全額ではない (報告していない国・地域の投資家や、各国の外貨準備としての保有を含まないため、" +
  "日本の対外資産負債残高 (財務省・日本銀行) の証券投資負債より通常は小さい)。" +
  "台湾は IMF に加盟しておらず CPIS に報告しないため、『台湾の投資家→日本』の値は作られず、対内の区分には台湾を入れていない" +
  " (台湾の投資家の分は世界計にも含まれない)。";

function toIndicatorDef(def: ImfCpisIndicatorDef): IndicatorDefInput {
  if (def.frequency !== "semiannual") {
    throw new Error(`[imf-cpis] ${def.key}: 頻度が想定 (semiannual) と違います: ${String(def.frequency)}`);
  }
  // 単位の対応付けが無ければここで throw させる (観測行と同じ換算規則を指標定義にも通す)。
  toUnit(def.unit);
  const direction = directionOfKey(def.key);
  const isAssets = direction === "jp_holds_abroad";
  return {
    key: def.key,
    displayName: def.displayName,
    requirement: toRequirement(def.key, def.requirements),
    flowType: toFlowType(def.flowType),
    description: def.description + COMMON_DESCRIPTION + (isAssets ? ASSETS_DESCRIPTION : LIABILITIES_DESCRIPTION),
    sourceUrl: def.sourceUrl,
    // IMF CPIS 原典: 無料・出典明記が必要。DBnomics は「配信データは元の提供元と同じ
    // 利用条件に従う」と明記 (モジュールの usageTerms 参照)。
    license: "attribution-required",
    frequency: "半期",
    limitations: def.limitations + commonLimitations(direction) + (isAssets ? "" : LIABILITIES_LIMITATIONS),
  };
}

// ---------------------------------------------------------------------------
// ファイル (DBnomics 応答 JSON) → 観測行 (純関数)
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface ParsedPart {
  filename: string;
  /** DBnomics 上の IMF/CPIS データセットの更新日 (YYYY-MM-DD)。 */
  updatedAt: string;
  /** 応答に含まれた系列の series_code (観測値が全部欠損の系列も含む)。 */
  seriesCodes: string[];
  records: ImfCpisRecord[];
}

function decodeJson(file: SpecFile): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch (e) {
    throw new Error(`[imf-cpis] ${file.filename}: UTF-8 として読めません: ${(e as Error).message}`, { cause: e });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new Error(`[imf-cpis] ${file.filename}: JSON として読めません: ${(e as Error).message}`, { cause: e });
  }
}

/**
 * DBnomics `/v22/series` 応答 1 本を読む。観測値の解析はモジュールの
 * `parseImfCpisResponse()` に任せ、ここではモジュールが見ない封筒部分
 * (errors・件数・データセット更新日) を確かめる。
 */
function parsePart(file: SpecFile): ParsedPart {
  const json = decodeJson(file);
  // エラー応答は series を持たないことがあるので、モジュールのパーサより先に見る
  // (「series が無い」より DBnomics 自身のエラー内容の方が原因の特定に役立つ)。
  if (isObject(json) && json.errors !== null && json.errors !== undefined) {
    throw new Error(`[imf-cpis] ${file.filename}: DBnomics がエラーを返しています: ${JSON.stringify(json.errors)}`);
  }
  const records = parseImfCpisResponse(json);
  if (!isObject(json) || !isObject(json.series) || !Array.isArray(json.series.docs)) {
    // parseImfCpisResponse が先に throw するはずだが、型を絞るために確かめる。
    throw new Error(`[imf-cpis] ${file.filename}: series.docs がありません`);
  }
  const docs: unknown[] = json.series.docs;
  const numFound = json.series.num_found;
  if (json.series.offset !== 0 || numFound !== docs.length) {
    throw new Error(
      `[imf-cpis] ${file.filename}: 応答が途中で切れています (offset=${String(json.series.offset)}, ` +
        `num_found=${String(numFound)}, docs=${docs.length})`
    );
  }
  const seriesCodes = docs.map((d) => {
    if (!isObject(d) || typeof d.series_code !== "string") {
      throw new Error(`[imf-cpis] ${file.filename}: series_code の無い系列があります`);
    }
    return d.series_code;
  });
  const datasets = json.datasets;
  const meta = isObject(datasets) ? datasets[DBNOMICS_DATASET_KEY] : undefined;
  const updatedAt = isObject(meta) ? meta.updated_at : undefined;
  if (typeof updatedAt !== "string" || !ISO_DATE_RE.test(updatedAt)) {
    throw new Error(
      `[imf-cpis] ${file.filename}: datasets["${DBNOMICS_DATASET_KEY}"].updated_at (YYYY-MM-DD) がありません: ${String(updatedAt)}`
    );
  }
  return { filename: file.filename, updatedAt, seriesCodes, records };
}

/** "YYYY-S1"/"YYYY-S2" → 規約の半期ラベル "YYYY-H1"/"YYYY-H2" と基準日 (6/30・12/31)。 */
function toHalfYear(period: string): { label: string; date: string } {
  const { year, half } = parseImfCpisPeriod(period);
  return { label: `${year}-H${half}`, date: half === 1 ? `${year}-06-30` : `${year}-12-31` };
}

function previousHalf(period: string): string {
  const { year, half } = parseImfCpisPeriod(period);
  return half === 2 ? `${year}-S1` : `${year - 1}-S2`;
}

/** 最新の半期から遡って IMF_CPIS_PERIOD_WINDOW 期分 (古い順)。 */
function periodWindow(latest: string): string[] {
  const out = [latest];
  while (out.length < IMF_CPIS_PERIOD_WINDOW) out.unshift(previousHalf(out[0] as string));
  return out;
}

export function imfCpisBatchKey(latestPeriod: string, updatedAt: string): string {
  if (!ISO_DATE_RE.test(updatedAt)) throw new Error(`[imf-cpis] 更新日が YYYY-MM-DD ではありません: ${updatedAt}`);
  return `${IMF_CPIS_SPEC_NAME}-${toHalfYear(latestPeriod).label}-updated-${updatedAt}`;
}

interface Analysis {
  key: string;
  latestPeriod: string;
  updatedAt: string;
  windowPeriods: string[];
  presentSeries: ReadonlySet<string>;
  drafts: ObservationDraft[];
}

const INDICATOR_ORDER: ReadonlyMap<string, number> = new Map(IMF_CPIS_INDICATORS.map((d, i) => [d.key, i]));
const AREA_ORDER: ReadonlyMap<string, number> = new Map(IMF_CPIS_DEFAULT_COUNTERPART_AREAS.map((a, i) => [a, i]));

function requireOrder(map: ReadonlyMap<string, number>, key: string, what: string): number {
  const v = map.get(key);
  if (v === undefined) throw new Error(`[imf-cpis] 想定外の${what}です: ${key}`);
  return v;
}

function analyzeFiles(files: readonly SpecFile[]): Analysis {
  if (files.length === 0) throw new Error("[imf-cpis] ファイルがありません");
  const unexpected = files.filter((f) => !PART_FILE_RE.test(f.filename)).map((f) => f.filename);
  if (unexpected.length > 0) {
    throw new Error(`[imf-cpis] 想定外のファイル名があります: ${unexpected.join(", ")}`);
  }
  const parts: ParsedPart[] = [];
  for (let n = 1; n <= files.length; n++) {
    const name = imfCpisPartFilename(n);
    parts.push(parsePart(requireSpecFile(files, (f) => f === name, `[imf-cpis] ${name}`)));
  }

  const updatedAts = [...new Set(parts.map((p) => p.updatedAt))];
  if (updatedAts.length !== 1) {
    throw new Error(
      `[imf-cpis] ファイル間で DBnomics の更新日が一致しません (取得中に更新された可能性): ${updatedAts.join(", ")}`
    );
  }
  const updatedAt = updatedAts[0] as string;

  const expected = new Set(IMF_CPIS_EXPECTED_SERIES_CODES);
  const seenIn = new Map<string, string>();
  for (const p of parts) {
    for (const code of p.seriesCodes) {
      if (!expected.has(code)) {
        throw new Error(`[imf-cpis] ${p.filename}: 問い合わせていない系列が含まれています: ${code}`);
      }
      const prev = seenIn.get(code);
      if (prev !== undefined) {
        throw new Error(`[imf-cpis] 同じ系列が 2 回現れました: ${code} (${prev}, ${p.filename})`);
      }
      seenIn.set(code, p.filename);
    }
  }

  const records = parts.flatMap((p) => p.records);
  for (const r of records) {
    const code = buildImfCpisSeriesCode({
      direction: r.direction,
      assetClass: r.assetClass,
      counterpartArea: r.counterpartArea,
    });
    if (code !== r.seriesCode) {
      throw new Error(`[imf-cpis] series_code と次元の値が食い違っています: ${r.seriesCode} (次元からは ${code})`);
    }
  }

  const latestPeriod = latestImfCpisPeriod(records.map((r) => r.period));
  if (latestPeriod === undefined) {
    throw new Error("[imf-cpis] 観測値が 1 件もありません (全系列が欠損または応答が空)");
  }
  const windowPeriods = periodWindow(latestPeriod);
  const windowIndex = new Map(windowPeriods.map((p, i) => [p, i]));

  const inWindow = records.filter((r) => windowIndex.has(r.period));
  const rows = toImfCpisObservationRows(inWindow);
  if (rows.length !== inWindow.length) {
    throw new Error(`[imf-cpis] 縦持ち変換で行数が変わりました (${inWindow.length} → ${rows.length})`);
  }

  const keyed = rows.map((row, i) => {
    const rec = inWindow[i] as ImfCpisRecord;
    const area = requireAreaLabel(row.category);
    const half = toHalfYear(row.period);
    const measureKind: MoneyflowMeasureKind = row.isEstimated ? "推定" : "実測";
    const draft: ObservationDraft = {
      period: half.label,
      periodStart: half.date,
      periodEnd: half.date,
      indicatorKey: row.indicatorKey,
      category: area.category,
      categoryKind: area.categoryKind,
      value: row.value,
      unit: toUnit(row.unit),
      changeFromPrev: null,
      approximate: row.isApproximate,
      measureKind,
    };
    const order: [number, number, number] = [
      windowIndex.get(rec.period) as number,
      requireOrder(INDICATOR_ORDER, row.indicatorKey, "指標キー"),
      requireOrder(AREA_ORDER, rec.counterpartArea, "相手国・地域コード"),
    ];
    return { order, draft };
  });
  keyed.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2] - b.order[2]);

  return {
    key: imfCpisBatchKey(latestPeriod, updatedAt),
    latestPeriod,
    updatedAt,
    windowPeriods,
    presentSeries: new Set(seenIn.keys()),
    drafts: keyed.map((k) => k.draft),
  };
}

// ---------------------------------------------------------------------------
// 取得 (resolve / fetch)
// ---------------------------------------------------------------------------

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

async function resolveImfCpis(now: Date): Promise<{ key: string; fetch(): Promise<FetchedBatch> }> {
  const captured: Array<{ url: string; bytes: Uint8Array }> = [];
  // 応答のコピーを取っておく fetch。本体はモジュール側 (res.ok 判定・JSON 解析) にそのまま渡す。
  const capturingFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    captured.push({ url: requestUrl(input), bytes: new Uint8Array(await res.clone().arrayBuffer()) });
    return res;
  };
  const result = await fetchImfCpis(FETCH_REQUESTS, { fetchImpl: capturingFetch });
  if (captured.length !== result.urls.length || captured.some((c, i) => c.url !== result.urls[i])) {
    throw new Error(
      `[imf-cpis] 保管用に控えた応答 (${captured.length} 件) と取得 URL (${result.urls.length} 件) が対応しません`
    );
  }
  const files: PrimaryFile[] = captured.map((c, i) => ({
    filename: imfCpisPartFilename(i + 1),
    bytes: c.bytes,
    contentType: "application/json",
  }));

  const analysis = analyzeFiles(files);
  const latest = toHalfYear(analysis.latestPeriod);
  const today = now.toISOString().slice(0, 10);
  if (latest.date > today) {
    throw new Error(
      `[imf-cpis] 最新の半期 ${latest.label} の基準日 ${latest.date} が実行日 ${today} より後です (応答が不正)`
    );
  }
  const missing = IMF_CPIS_EXPECTED_SERIES_CODES.filter((c) => !analysis.presentSeries.has(c));
  if (missing.length > 0) {
    console.warn(
      `[imf-cpis] DBnomics の応答に無かった系列が ${missing.length}/${IMF_CPIS_EXPECTED_SERIES_CODES.length} 件あります ` +
        `(行は作らない): ${missing.join(", ")}`
    );
  }

  const batch: FetchedBatch = {
    key: analysis.key,
    source: `IMF CPIS (DBnomics 経由の半期データ) ${IMF_CPIS_API_BASE}`,
    metadata: {
      dataset: "IMF/CPIS (DBnomics ミラー)",
      dbnomicsDatasetUpdatedAt: analysis.updatedAt,
      latestPeriod: latest.label,
      latestPeriodDbnomics: analysis.latestPeriod,
      periodsInBatch: analysis.windowPeriods.map((p) => toHalfYear(p).label),
      observationRows: analysis.drafts.length,
      seriesRequested: IMF_CPIS_EXPECTED_SERIES_CODES.length,
      seriesReturned: analysis.presentSeries.size,
      seriesMissing: missing,
      requestUrls: result.urls,
    },
    files,
  };
  return { key: analysis.key, fetch: async () => batch };
}

export const IMF_CPIS_ADAPTER_INDICATORS: readonly IndicatorDefInput[] = IMF_CPIS_INDICATORS.map(toIndicatorDef);

/** IMF CPIS (日本の対外・対内証券投資残高、国・地域別、半期)。 */
export const imfCpisSpec: MoneyflowSourceSpec = {
  name: IMF_CPIS_SPEC_NAME,
  indicators: IMF_CPIS_ADAPTER_INDICATORS,
  resolve: resolveImfCpis,
  toObservations({ key, files }) {
    const analysis = analyzeFiles(files);
    if (analysis.key !== key) {
      throw new Error(`[imf-cpis] キー ${key} がファイルの中身から決まるキー ${analysis.key} と一致しません`);
    }
    return analysis.drafts;
  },
};
