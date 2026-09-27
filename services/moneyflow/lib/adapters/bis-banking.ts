/**
 * moneyflow アダプタ: BIS 所在地ベース国際銀行統計 (Locational Banking Statistics, LBS)
 * — 日本に所在する銀行の、相手国・地域別の越境「対外与信残高」「対外負債残高」
 * (四半期末の残高)。
 *
 * 取得元モジュール `../sources/bis-banking.ts` (取得・解析・独自の指標定義) を
 * `MoneyflowSourceSpec` (`../source-spec.ts`) に揃える。規約は `./README.md`。
 *
 * ## spec
 * `bis-banking` の 1 本。BIS Data Portal の SDMX API (dataflow BIS:WS_LBS_D_PUB 1.0) から
 * 与信 (claims) と負債 (liabilities) の CSV を 1 本ずつ取り (計 2 リクエスト)、
 * 2 指標 × 相手国・地域 (+ 世界計) の観測行にする。与信と負債は BIS の同じ公表回で
 * 同時に更新されるので、1 バッチにまとめる。
 *
 * ## 1 バッチの中身 (行数)
 * モジュールは各系列の「最後の 2 観測」(`lastNObservations=2`) を取る。観測行にするのは
 * **BIS が公表済みの最新四半期とその直前の四半期の 2 期だけ** (固定の規則)。直前の期も
 * 毎回含めるのは、次の四半期の公表時に BIS が改訂した前期の値を上書きで取り込むため
 * (imf-cpis アダプタと同じ考え方)。報告が途絶えた国・地域 (旧ソ連・東ドイツ等) の
 * 古い四半期の行は、この規則で落ちる。
 * 行数は 2 期 × 2 指標 × (相手国・地域 + 世界計)。2026-09-27 取得の実データで 453 行、
 * 対応表 (`BIS_COUNTERPARTY_NAMES`) の全コード + 世界計が 2 期とも揃っても
 * 2 × 2 × 123 = 492 行で、目安の 600 行に収まる (国の絞り込みはしない)。
 *
 * ## 冪等キー
 * `bis-banking-<最新四半期 YYYY-Qn>`。最新四半期は与信 CSV の「全世界合計行
 * (L_CP_COUNTRY=5J) の最新の期」(モジュールの `latestQuarterFromRows`) で決まり、
 * `toObservations()` は両ファイルから同じ値を再計算してキーと一致を確かめる。
 * BIS の CSV には公表日・版の情報が無いため版はキーに含めない。同じ四半期の改訂は
 * 次の四半期のバッチで「直前の四半期」の行として上書きされる (それより後の改訂は
 * 反映しない — 指標定義の限界に明記)。
 *
 * ## resolve() が本体を取る理由
 * 「最新の四半期」は系列の本体を取らないと分からない (モジュールに目次・一覧 API は無く、
 * BIS は `lastNObservations` でサーバ側が最新を解決する設計)。そのため resolve() で
 * 与信 CSV (約 17KB・1 リクエスト) を取ってキーを決め、fetch() はそのバイト列を再利用し、
 * 負債 CSV だけを追加で取る。取込済みの四半期なら resolve() の 1 リクエストで終わる。
 *
 * ## 生バイト列の保管 (ルール6)
 * モジュールの `fetchBisBankingCsv()` は応答を文字列 (`res.text()`) で返すため、
 * UTF-8 に符号化し直して保管する。BIS のこの CSV は ASCII のみ (2026-09-27 実データで
 * 非 ASCII 0 文字・BOM なし) なので元のバイト列と一致する。
 *
 * ## モジュールの toMoneyflowObservations() を使わない理由
 * モジュールの縦長変換は世界計 (5J) を落とし、期間の絞り込みもしない。このアダプタは
 * 世界計を「全体」の区分として残し、期間を 2 期に絞るため、`parseBisBankingCsv()` の
 * 解析結果から直接観測行を作る。国別の除外規則 (5J・国際機関 1C・集計コード EU/XM/XW・
 * 欠測 NaN を行にしない、OBS_STATUS は A/B 以外なら throw) はモジュール (検証済み版
 * 2a71814) と同じにしてあり、
 * テストで両者の国別の行が一致することを確かめている。
 */
import type {
  IndicatorDefInput,
  MoneyflowCategoryKind,
  MoneyflowFlowType,
  MoneyflowFrequency,
  MoneyflowRequirement,
  PrimaryFile,
} from "../../../../src/shared/notion-archive/index.js";
import {
  quarterRange,
  requireSpecFile,
  type FetchedBatch,
  type MoneyflowSourceSpec,
  type ObservationDraft,
  type SpecFile,
} from "../source-spec.js";
import {
  BIS_BANKING_INDICATORS,
  fetchBisBankingCsv,
  latestQuarterFromRows,
  parseBisBankingCsv,
  resolvePublicationStatus,
  type BisBankingPosition,
  type BisBankingRawRow,
  type MoneyflowIndicatorDefinition as BisIndicatorDefinition,
} from "../sources/bis-banking.js";

export const BIS_BANKING_SPEC_NAME = "bis-banking";

/** 各系列について取る観測数 (最新四半期 + 直前の四半期)。 */
export const BIS_BANKING_LAST_N_OBSERVATIONS = 2;

/** 保管・解析するファイル名 (固定)。 */
export const BIS_BANKING_FILENAMES: Readonly<Record<BisBankingPosition, string>> = {
  claims: "bis-lbs-claims-jp.csv",
  liabilities: "bis-lbs-liabilities-jp.csv",
};

/** 与信・負債 → モジュールの指標キー (モジュールは対応表を export していないため、ここで固定し起動時に照合する)。 */
export const BIS_BANKING_INDICATOR_KEYS: Readonly<Record<BisBankingPosition, string>> = {
  claims: "bis_lbs_cross_border_claims_jp",
  liabilities: "bis_lbs_cross_border_liabilities_jp",
};

/** 観測行の並び順 (与信 → 負債)。 */
const POSITIONS: readonly BisBankingPosition[] = ["claims", "liabilities"];

const CSV_CONTENT_TYPE = "text/csv";

/** BIS の「全世界合計」(All countries) の擬似コード。区分「世界計」(全体) にする。 */
const WORLD_TOTAL_CODE = "5J";
export const BIS_WORLD_TOTAL_CATEGORY = "世界計";

/** BIS の「国際機関」(International organisations) の擬似コード。国・地域ではないので行にしない。 */
const INTERNATIONAL_ORGANISATIONS_CODE = "1C";

/**
 * 英字 2 文字だが国・地域ではなく複数国の集計値を表す BIS のコード (コードリスト
 * CL_BIS_IF_REF_AREA: EU=European Union / XM=Euro area / XW=World)。国別の行と
 * 二重計上になるので行にしない (モジュール検証版 2a71814 の isCountryCategory と同じ規則)。
 * 対応表に「国」として足されないよう、ここで明示的に除外する。
 */
export const BIS_AGGREGATE_CODES: ReadonlySet<string> = new Set(["EU", "XM", "XW"]);

/** 1 百万米ドル = 1,000,000 米ドル。 */
const USD_PER_MILLION = 1_000_000;

/**
 * BIS の相手国・地域コード (コードリスト CL_BIS_IF_REF_AREA) → 観測ログの「区分」(日本語の通称)。
 *
 * 2026-09-27 に取得した実データ (日本所在銀行・越境、与信/負債) に現れた、いまも存在する
 * 国・地域のコードすべて。英語名は同日取得の BIS コードリスト (検証証跡
 * `results/bis_codelist.xml`) による。BIS の英語表記と日本語の通称が違うもの:
 * HK=Hong Kong SAR→香港、TW=Chinese Taipei→台湾、KR=Korea→韓国、KP=North Korea→北朝鮮、
 * TR=Türkiye→トルコ、CZ=Czechia→チェコ、SZ=Eswatini→エスワティニ、
 * CD=Democratic Republic of the Congo→コンゴ民主共和国。
 *
 * 消滅した国・地域のコード (2T 旧ソ連 / 2U 旧チェコスロバキア / C9 チェコスロバキア /
 * CS セルビア・モンテネグロ / DD 東ドイツ / SU ソ連 / YU ユーゴスラビア / AN オランダ領
 * アンティル) は、実データでは古い四半期にしか現れず、最新 2 四半期の絞り込みで落ちるため
 * 載せない。表に無いコードが最新 2 四半期に現れたら throw する (推測で名前を付けない)。
 */
export const BIS_COUNTERPARTY_NAMES: ReadonlyMap<string, string> = new Map([
  ["AE", "アラブ首長国連邦"],
  ["AL", "アルバニア"],
  ["AM", "アルメニア"],
  ["AR", "アルゼンチン"],
  ["AT", "オーストリア"],
  ["AU", "オーストラリア"],
  ["AZ", "アゼルバイジャン"],
  ["BE", "ベルギー"],
  ["BG", "ブルガリア"],
  ["BH", "バーレーン"],
  ["BM", "バミューダ"],
  ["BO", "ボリビア"],
  ["BR", "ブラジル"],
  ["BS", "バハマ"],
  ["BY", "ベラルーシ"],
  ["CA", "カナダ"],
  ["CD", "コンゴ民主共和国"],
  ["CH", "スイス"],
  ["CI", "コートジボワール"],
  ["CL", "チリ"],
  ["CN", "中国"],
  ["CO", "コロンビア"],
  ["CR", "コスタリカ"],
  ["CU", "キューバ"],
  ["CW", "キュラソー"],
  ["CZ", "チェコ"],
  ["DE", "ドイツ"],
  ["DK", "デンマーク"],
  ["DZ", "アルジェリア"],
  ["EC", "エクアドル"],
  ["EE", "エストニア"],
  ["EG", "エジプト"],
  ["ES", "スペイン"],
  ["ET", "エチオピア"],
  ["FI", "フィンランド"],
  ["FJ", "フィジー"],
  ["FR", "フランス"],
  ["GA", "ガボン"],
  ["GB", "英国"],
  ["GE", "ジョージア"],
  ["GG", "ガーンジー"],
  ["GR", "ギリシャ"],
  ["HK", "香港"],
  ["HR", "クロアチア"],
  ["HU", "ハンガリー"],
  ["ID", "インドネシア"],
  ["IE", "アイルランド"],
  ["IL", "イスラエル"],
  ["IM", "マン島"],
  ["IN", "インド"],
  ["IQ", "イラク"],
  ["IR", "イラン"],
  ["IS", "アイスランド"],
  ["IT", "イタリア"],
  ["JE", "ジャージー"],
  ["JM", "ジャマイカ"],
  ["JO", "ヨルダン"],
  ["KE", "ケニア"],
  ["KG", "キルギス"],
  ["KP", "北朝鮮"],
  ["KR", "韓国"],
  ["KW", "クウェート"],
  ["KY", "ケイマン諸島"],
  ["KZ", "カザフスタン"],
  ["LA", "ラオス"],
  ["LB", "レバノン"],
  ["LK", "スリランカ"],
  ["LR", "リベリア"],
  ["LT", "リトアニア"],
  ["LU", "ルクセンブルク"],
  ["LV", "ラトビア"],
  ["LY", "リビア"],
  ["MA", "モロッコ"],
  ["MD", "モルドバ"],
  ["MM", "ミャンマー"],
  ["MV", "モルディブ"],
  ["MX", "メキシコ"],
  ["MY", "マレーシア"],
  ["NE", "ニジェール"],
  ["NG", "ナイジェリア"],
  ["NI", "ニカラグア"],
  ["NL", "オランダ"],
  ["NO", "ノルウェー"],
  ["NP", "ネパール"],
  ["NZ", "ニュージーランド"],
  ["OM", "オマーン"],
  ["PA", "パナマ"],
  ["PE", "ペルー"],
  ["PG", "パプアニューギニア"],
  ["PH", "フィリピン"],
  ["PK", "パキスタン"],
  ["PL", "ポーランド"],
  ["PT", "ポルトガル"],
  ["QA", "カタール"],
  ["RO", "ルーマニア"],
  ["RS", "セルビア"],
  ["RU", "ロシア"],
  ["SA", "サウジアラビア"],
  ["SD", "スーダン"],
  ["SE", "スウェーデン"],
  ["SG", "シンガポール"],
  ["SI", "スロベニア"],
  ["SK", "スロバキア"],
  ["SN", "セネガル"],
  ["SY", "シリア"],
  ["SZ", "エスワティニ"],
  ["TH", "タイ"],
  ["TJ", "タジキスタン"],
  ["TM", "トルクメニスタン"],
  ["TR", "トルコ"],
  ["TT", "トリニダード・トバゴ"],
  ["TW", "台湾"],
  ["TZ", "タンザニア"],
  ["UA", "ウクライナ"],
  ["US", "米国"],
  ["UY", "ウルグアイ"],
  ["UZ", "ウズベキスタン"],
  ["VE", "ベネズエラ"],
  ["VN", "ベトナム"],
  ["YE", "イエメン"],
  ["ZA", "南アフリカ"],
  ["ZM", "ザンビア"],
]);

// ---------------------------------------------------------------------------
// 期間・キー
// ---------------------------------------------------------------------------

const QUARTER_RE = /^(\d{4})-Q([1-4])$/;
const KEY_RE = /^bis-banking-(\d{4}-Q[1-4])$/;

function parseQuarter(quarter: string): { year: number; quarter: number } {
  const m = QUARTER_RE.exec(quarter);
  if (!m) throw new Error(`[bis-banking] 四半期が YYYY-Qn ではありません: ${quarter}`);
  return { year: Number(m[1]), quarter: Number(m[2]) };
}

/** 直前の四半期 ("2026-Q1" → "2025-Q4")。 */
export function previousQuarter(quarter: string): string {
  const q = parseQuarter(quarter);
  return q.quarter === 1 ? `${q.year - 1}-Q4` : `${q.year}-Q${q.quarter - 1}`;
}

/** 四半期末日 (残高の基準日。期間開始=終了にする)。 */
function quarterEndDate(quarter: string): string {
  const q = parseQuarter(quarter);
  return quarterRange(q.year, q.quarter).end;
}

/** 冪等キー `bis-banking-YYYY-Qn` を作る。 */
export function bisBankingBatchKey(latestQuarter: string): string {
  parseQuarter(latestQuarter);
  return `${BIS_BANKING_SPEC_NAME}-${latestQuarter}`;
}

function quarterOfKey(key: string): string {
  const m = KEY_RE.exec(key);
  if (!m) throw new Error(`[bis-banking] 冪等キーの形式が違います (bis-banking-YYYY-Qn): ${key}`);
  return m[1] as string;
}

// ---------------------------------------------------------------------------
// 単位
// ---------------------------------------------------------------------------

/**
 * 百万米ドル → 米ドル。BIS の公表値は小数第 3 位 (= 千ドル単位) までなので、浮動小数の
 * 誤差を持ち込まないよう千ドル単位の整数にしてから 1,000 倍する。小数第 4 位以下を持つ値
 * (様式変更) や負の値 (残高としてあり得ない) は throw する。
 */
export function usdMillionToUsd(valueUsdMillion: number, where: string): number {
  if (!Number.isFinite(valueUsdMillion) || valueUsdMillion < 0) {
    throw new Error(`[bis-banking] ${where}: 残高が 0 以上の有限数ではありません: ${valueUsdMillion}`);
  }
  const scaled = valueUsdMillion * 1000;
  const thousands = Math.round(scaled);
  // 本当に小数第 4 位を持つ値なら差は 0.1 千ドル以上になる。1e-3 千ドル (= 1 ドル) 未満は浮動小数の誤差。
  if (Math.abs(scaled - thousands) > 1e-3) {
    throw new Error(
      `[bis-banking] ${where}: 値 ${valueUsdMillion} 百万米ドルが小数第 3 位 (千ドル単位) を超える桁を持ちます。` +
        `BIS の DECIMALS が変わった可能性があります。`
    );
  }
  return thousands * (USD_PER_MILLION / 1000);
}

// ---------------------------------------------------------------------------
// 指標定義 (モジュールの定義 → IndicatorDefInput)
// ---------------------------------------------------------------------------

function toFlowType(def: BisIndicatorDefinition): MoneyflowFlowType {
  if (def.flowType === "holdings_stock") return "残高";
  throw new Error(`[bis-banking] ${def.key}: 対応付けの無い flowType です (アダプタの更新が必要): ${def.flowType}`);
}

function toRequirement(def: BisIndicatorDefinition): MoneyflowRequirement {
  // docs/moneyflow.md の在庫表で BIS 統計は R4 (日本⇔海外・世界の概況)。
  if (def.requirements.length === 1 && def.requirements[0] === "R4") return "R4";
  throw new Error(`[bis-banking] ${def.key}: 要件が想定 (R4 のみ) と違います: ${def.requirements.join(",")}`);
}

function toFrequency(def: BisIndicatorDefinition): MoneyflowFrequency {
  if (def.frequency === "quarterly") return "四半期";
  throw new Error(`[bis-banking] ${def.key}: 対応付けの無い頻度です: ${def.frequency}`);
}

function assertUnit(def: BisIndicatorDefinition): void {
  // 観測行の換算 (百万米ドル → 米ドル) と同じ前提を指標定義にも通す。
  if (def.unit !== "USD_million") {
    throw new Error(`[bis-banking] ${def.key}: 単位が想定 (USD_million) と違います: ${def.unit}`);
  }
}

/** BIS Data Portal の所在地ベース国際銀行統計 (LBS) のページ。 */
const SOURCE_URL = "https://data.bis.org/topics/LBS";

const COMMON_DESCRIPTION =
  "【この表の値】単位は米ドル (BIS が百万米ドル単位で公表する値を 1,000,000 倍して換算。1 = 1米ドルで、円には換算していない)。" +
  "四半期末時点の残高の大きさで、「プラス=流入・マイナス=流出」のような向きを表す符号は持たない。" +
  "期間は「YYYY-Qn」(暦年の四半期。例: 2026-Q1 = 2026年3月末時点)。" +
  "区分は相手国・地域 (日本語名) と「世界計」(相手国・地域すべての合計。国際機関向けや、国別に公表されない・" +
  "相手国を特定できない分も含むため、国別の行を足した値とは一致しない)。" +
  "【誤解しやすい点】これは「その四半期に日本から出ていった (入ってきた) お金 = 純流入」ではなく、積み上がった残高。" +
  "前の四半期の行との差にも、為替レートの動き (ユーロ建てなどの資産を米ドルに換算した額の変化)・評価替え・" +
  "報告する銀行の入れ替えが混ざるため、差をそのまま「お金が流れた額」と読むことはできない。";

/** 負債側の具体例 (与信側はモジュールの説明文に例がある)。値は 2026-Q1 の実データ (英国 473,663.377 百万米ドル)。 */
const LIABILITIES_EXAMPLE =
  "例えば英国の行が約4,737億ドルなら、英国にいる銀行・企業などが日本にある銀行に預けたり貸したりしている" +
  "お金が、その四半期末に合計約4,737億ドル残っている状態を表す (日本にある銀行から見ると借りている側)。";

const ADAPTER_LIMITATIONS =
  "【kabulab での取り込み方】1回の取込で行にするのは、BIS が公表済みの最新四半期とその直前の四半期の2期だけ (固定の規則)。" +
  "直前の四半期の行は、次の四半期が公表されたときに BIS の改訂後の値で上書きされるが、それより古い四半期の遡及改訂や、" +
  "次の四半期の公表より前に行われた改訂は反映されない。" +
  "最新2四半期に値の無い相手国・地域 (旧ソ連・東ドイツのように報告が途絶えた国・地域など) は行を作らない。" +
  "国際機関 (BIS コード 1C) 向けは国・地域ではないので行を作らない (世界計には含まれる)。" +
  "欧州連合 (EU)・ユーロ圏 (XM)・世界 (XW) のような複数国の集計コードも、国別の行と二重に数えることになるので行を作らない。" +
  "相手国・地域の名前は、BIS の国・地域コード (コードリスト CL_BIS_IF_REF_AREA) を kabulab が日本語の通称に置き換えたもの" +
  " (例: TW「Chinese Taipei」→台湾、HK「Hong Kong SAR」→香港)。対応表に無いコードが現れたら取込を止める。" +
  "BIS が「系列の断層」(OBS_STATUS=B: 報告範囲や定義がその四半期から変わった) の印を付けた値もそのまま記録するが、" +
  "観測ログの行には断層の印が残らないため、前の四半期の行と単純に比べられない場合がある。" +
  "BIS が推計値・暫定値など正常値 (A)・断層 (B) 以外の印を付けた値が出たら取込を止める。" +
  "前期比は記録しない (空欄)。為替換算はしないので、円建ての他の指標と金額を直接比べることはできない。" +
  "公表は四半期末から約1四半期 (3〜4か月) 後で、新しい四半期が出るまでの取込は最新四半期の確認だけで行は増えない。";

function toIndicatorDef(def: BisIndicatorDefinition, position: BisBankingPosition): IndicatorDefInput {
  assertUnit(def);
  return {
    key: def.key,
    displayName: def.displayName,
    requirement: toRequirement(def),
    flowType: toFlowType(def),
    description:
      `${def.whatItMeasures}${def.plainExplanation}` +
      `${position === "liabilities" ? LIABILITIES_EXAMPLE : ""}` +
      `【正確な定義】${def.preciseDefinition}${COMMON_DESCRIPTION}`,
    sourceUrl: SOURCE_URL,
    // BIS「Terms of permitted use of BIS statistics」: 出典 (BIS) を明記すれば商用を含め再利用可
    // (条件付き。モジュールの termsOfUse を限界欄にそのまま載せる)。
    license: "attribution-required",
    frequency: toFrequency(def),
    limitations: `${def.limitations}${ADAPTER_LIMITATIONS}【利用条件】${def.termsOfUse}`,
  };
}

function buildIndicators(): IndicatorDefInput[] {
  const moduleKeys = BIS_BANKING_INDICATORS.map((d) => d.key).sort();
  const expectedKeys = POSITIONS.map((p) => BIS_BANKING_INDICATOR_KEYS[p]).sort();
  if (moduleKeys.join(",") !== expectedKeys.join(",")) {
    throw new Error(
      `[bis-banking] モジュールの指標キー (${moduleKeys.join(", ")}) が` +
        `アダプタの想定 (${expectedKeys.join(", ")}) と違います`
    );
  }
  return POSITIONS.map((position) => {
    const def = BIS_BANKING_INDICATORS.find((d) => d.key === BIS_BANKING_INDICATOR_KEYS[position]);
    if (!def) throw new Error(`[bis-banking] ${position} の指標定義がモジュールにありません`);
    return toIndicatorDef(def, position);
  });
}

export const BIS_BANKING_INDICATOR_DEFS: readonly IndicatorDefInput[] = buildIndicators();

// ---------------------------------------------------------------------------
// ファイル (CSV) → 観測行 (純関数)
// ---------------------------------------------------------------------------

function decodeCsv(file: SpecFile): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch (e) {
    throw new Error(`[bis-banking] ${file.filename} が UTF-8 として読めません: ${(e as Error).message}`, { cause: e });
  }
}

function assertOnlyKnownFiles(files: readonly SpecFile[]): void {
  const known = new Set(Object.values(BIS_BANKING_FILENAMES));
  const unknown = files.filter((f) => !known.has(f.filename)).map((f) => f.filename);
  if (unknown.length > 0) {
    throw new Error(
      `[bis-banking] 想定外のファイルがあります: ${unknown.join(", ")} (想定: ${[...known].join(", ")})`
    );
  }
}

/** 観測行にしてよい OBS_STATUS (A=正常値 / B=系列の断層)。それ以外は throw。 */
function assertEmittableStatus(row: BisBankingRawRow): void {
  if (row.obsStatus === "A" || row.obsStatus === "B") return;
  throw new Error(
    `[bis-banking] ${row.position} ${row.counterpartyCountry} ${row.quarter} の値 (${row.valueUsdMillion} 百万米ドル) に` +
      ` OBS_STATUS="${row.obsStatus}" が付いています。扱えるのは A (正常値) と B (系列の断層) のみです。` +
      `BIS コードリスト CL_OBS_STATUS で意味を確かめ、実測/推定の扱いを決めてから取り込んでください。`
  );
}

function categoryOf(code: string): { category: string; categoryKind: MoneyflowCategoryKind } {
  if (code === WORLD_TOTAL_CODE) return { category: BIS_WORLD_TOTAL_CATEGORY, categoryKind: "全体" };
  const name = BIS_COUNTERPARTY_NAMES.get(code);
  if (name === undefined) {
    throw new Error(
      `[bis-banking] 日本語の区分名が未定義の相手国・地域コードです: ${code}` +
        ` (BIS コードリスト CL_BIS_IF_REF_AREA で確かめて BIS_COUNTERPARTY_NAMES に追加が必要)`
    );
  }
  return { category: name, categoryKind: "国地域" };
}

/** 並び順: 世界計を先頭に、あとは BIS コードの昇順 (ロケールに依存しない)。 */
function compareCodes(a: string, b: string): number {
  if (a === b) return 0;
  if (a === WORLD_TOTAL_CODE) return -1;
  if (b === WORLD_TOTAL_CODE) return 1;
  return a < b ? -1 : 1;
}

/**
 * key とファイルのバイト列から観測行を作る (純関数)。
 *
 * 並び順は「直前の四半期 → 最新四半期」×「与信 → 負債」×「世界計 → BIS コード昇順」。
 * 最後の行は常に最新四半期の負債の行になる (取込完了の印。直前の四半期の行は前回の
 * バッチでも書かれているので、印にしてはいけない)。
 */
export function bisBankingToObservations(input: { key: string; files: readonly SpecFile[] }): ObservationDraft[] {
  const latest = quarterOfKey(input.key);
  const prev = previousQuarter(latest);
  assertOnlyKnownFiles(input.files);

  const parsed = POSITIONS.map((position) => {
    const filename = BIS_BANKING_FILENAMES[position];
    const file = requireSpecFile(input.files, (n) => n === filename, `[bis-banking] ${position} の CSV`);
    const rows = parseBisBankingCsv(decodeCsv(file), position);
    for (const r of rows) {
      if (r.reportingCountry !== "JP" || r.counterpartySector !== "A") {
        throw new Error(
          `[bis-banking] ${filename}: 報告国/相手部門が想定 (JP/A) と違う行があります ` +
            `(${r.reportingCountry}/${r.counterpartySector} ${r.counterpartyCountry} ${r.quarter})`
        );
      }
    }
    const fileLatest = latestQuarterFromRows(rows);
    if (fileLatest !== latest) {
      throw new Error(
        `[bis-banking] ${filename} の最新四半期 (${fileLatest}) がキー ${input.key} の四半期 (${latest}) と一致しません`
      );
    }
    return { position, rows };
  });

  // キーの四半期より新しい期の値は、このバッチでも次のバッチ (キーは世界計の最新期で決まる)
  // でも行にならず黙って捨てられるため、様式・公表の異常として止める。
  for (const { position, rows } of parsed) {
    const newer = rows.filter((r) => r.quarter > latest && r.valueUsdMillion !== null);
    if (newer.length > 0) {
      throw new Error(
        `[bis-banking] ${BIS_BANKING_FILENAMES[position]} に世界計の最新四半期 (${latest}) より新しい期の値があります ` +
          `(${newer.map((r) => `${r.counterpartyCountry} ${r.quarter}`).join(", ")})。` +
          `世界計より先に国別だけが更新された等の異常なので、取り込み方を決めてから再実行してください。`
      );
    }
  }

  const drafts: ObservationDraft[] = [];
  for (const period of [prev, latest]) {
    const end = quarterEndDate(period);
    for (const { position, rows } of parsed) {
      const selected = rows
        .filter(
          (r) =>
            r.quarter === period &&
            r.counterpartyCountry !== INTERNATIONAL_ORGANISATIONS_CODE &&
            !BIS_AGGREGATE_CODES.has(r.counterpartyCountry)
        )
        .sort((a, b) => compareCodes(a.counterpartyCountry, b.counterpartyCountry));
      for (const r of selected) {
        // 欠測 (BIS の NaN) は行にしない (0 で埋めない — ルール2)。
        if (r.valueUsdMillion === null) continue;
        assertEmittableStatus(r);
        const { category, categoryKind } = categoryOf(r.counterpartyCountry);
        drafts.push({
          period,
          periodStart: end,
          periodEnd: end,
          indicatorKey: BIS_BANKING_INDICATOR_KEYS[position],
          category,
          categoryKind,
          value: usdMillionToUsd(r.valueUsdMillion, `${position} ${r.counterpartyCountry} ${period}`),
          unit: "米ドル",
          changeFromPrev: null,
          // 残高 (ストック) であって流れそのものではない (代理指標)。
          approximate: true,
          // BIS の公表値そのもの (推計値の印 E 等は assertEmittableStatus で弾く)。
          measureKind: "実測",
        });
      }
    }
  }
  const last = drafts[drafts.length - 1];
  if (!last || last.period !== latest) {
    throw new Error(`[bis-banking] ${input.key}: 最新四半期 ${latest} の観測行がありません`);
  }
  return drafts;
}

// ---------------------------------------------------------------------------
// 取得
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function csvFile(position: BisBankingPosition, csvText: string): PrimaryFile {
  return { filename: BIS_BANKING_FILENAMES[position], bytes: encoder.encode(csvText), contentType: CSV_CONTENT_TYPE };
}

export const bisBankingSpec: MoneyflowSourceSpec = {
  name: BIS_BANKING_SPEC_NAME,
  indicators: BIS_BANKING_INDICATOR_DEFS,
  async resolve(now: Date) {
    const claims = await fetchBisBankingCsv("claims", BIS_BANKING_LAST_N_OBSERVATIONS);
    const status = resolvePublicationStatus(parseBisBankingCsv(claims.csvText, "claims"), now);
    const quarter = status.latestAvailableQuarter;
    const key = bisBankingBatchKey(quarter);
    return {
      key,
      async fetch(): Promise<FetchedBatch> {
        const liabilities = await fetchBisBankingCsv("liabilities", BIS_BANKING_LAST_N_OBSERVATIONS);
        const liabilitiesLatest = latestQuarterFromRows(parseBisBankingCsv(liabilities.csvText, "liabilities"));
        if (liabilitiesLatest !== quarter) {
          throw new Error(
            `[bis-banking] 負債 CSV の最新四半期 (${liabilitiesLatest}) が与信 CSV (${quarter}) と一致しません` +
              ` (取得の合間に BIS が更新した可能性。次回の実行で取り直す)`
          );
        }
        return {
          key,
          source:
            `BIS Data Portal SDMX API (dataflow BIS:WS_LBS_D_PUB 1.0, 日本所在銀行・越境・相手国別): ` +
            `${claims.url} , ${liabilities.url}`,
          metadata: {
            dataflow: "BIS:WS_LBS_D_PUB(1.0)",
            latestAvailableQuarter: quarter,
            mostRecentEndedQuarter: status.mostRecentEndedQuarter,
            // 情報として残すだけ (BIS の公表ラグは四半期より長く、ほぼ常に false。取込の判定には使わない)。
            isCaughtUp: status.isCaughtUp,
            lastNObservations: BIS_BANKING_LAST_N_OBSERVATIONS,
            urls: { claims: claims.url, liabilities: liabilities.url },
            resolvedAt: now.toISOString(),
          },
          files: [csvFile("claims", claims.csvText), csvFile("liabilities", liabilities.csvText)],
        };
      },
    };
  },
  toObservations: bisBankingToObservations,
};

/** 取込 CLI (`scripts/moneyflow/sources.ts`) に登録する spec。 */
export const BIS_BANKING_SPECS: readonly MoneyflowSourceSpec[] = [bisBankingSpec];
