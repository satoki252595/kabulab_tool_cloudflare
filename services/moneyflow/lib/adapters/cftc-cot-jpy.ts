/**
 * 取得元アダプタ: CFTC (米国先物取引委員会) Commitments of Traders (COT) レポート
 * — CME 上場の円先物 (097741) / 日経平均先物 円建て (240743) の建玉 (週次)。
 *
 * 取得・解析・指標の説明文は取得元モジュール `../sources/cftc-cot-jpy.ts` が持ち、
 * ここでは Phase 1 の Notion 3 DB (指標定義 / 観測ログ / 取込ログ) と
 * 「一次データ｜moneyflow」へつなぐ `MoneyflowSourceSpec` に揃える
 * (規約: `./README.md`)。
 *
 *   - 1 バッチ = CFTC の 1 回の公表 (基準日 = 直前火曜) の 2 契約 × 5 指標 = 10 行
 *   - 本体は Socrata API の JSON 応答 (直近 8 週 × 2 契約) で、resolve 時点で
 *     既に取得している (軽い一覧が無く、応答そのものが本体のため)。fetch() は
 *     同じバイト列を返す (取得元へ 2 回行かない)
 *   - 冪等キー `cftc-cot-jpy-<基準日の ISO 週>` (例 `cftc-cot-jpy-2026-W39`)。
 *     応答には過去 7 週分も入っているが、観測ログへはキーの週だけを書く
 *     (過去週を毎回書き直すと「一次データ」relation が毎週付け替わるため)
 */
import { isoWeekLabelOf } from "../iso-week.js";
import {
  requireSpecFile,
  type FetchedBatch,
  type MoneyflowSourceSpec,
  type ObservationDraft,
  type SpecFile,
} from "../source-spec.js";
import {
  CFTC_COT_HUMAN_REPORT_URL,
  CFTC_COT_JPY_INDICATORS,
  CFTC_TRACKED_CONTRACTS,
  parseCftcCotJpyRows,
  resolveCftcCotJpy,
  toCftcCotObservationRecords,
  type CftcCotContractKey,
  type CftcCotJpyRow,
} from "../sources/cftc-cot-jpy.js";
import type {
  IndicatorDefInput,
  MoneyflowCategoryKind,
} from "../../../../src/shared/notion-archive/index.js";

export const CFTC_COT_JPY_SPEC_NAME = "cftc-cot-jpy";

/** 一次データとして保管する Socrata API 応答のファイル名 (キーに依らず固定)。 */
export const CFTC_COT_JPY_RESPONSE_FILENAME =
  "cftc-cot-jpy-legacy-futures-only.json";

const KEY_RE = /^cftc-cot-jpy-(\d{4}-W\d{2})$/;

/**
 * 観測ログの「区分」(粗い軸 `市場` → 細かい軸 `商品`)。取得元モジュールの
 * `category` (`資産クラス｜…`) は区分種別を値に埋め込んだ独自表記で統一規約に
 * 合わないため、契約キーごとに固定の表記をここで持つ。
 */
const CATEGORY_BY_CONTRACT: Readonly<Record<CftcCotContractKey, string>> = {
  jpy: "CME / 円先物",
  nikkei225_yen: "CME / 日経平均先物(円建て)",
};
const CATEGORY_KIND: MoneyflowCategoryKind = "商品";

/** 指標キー末尾 (取得元モジュールの METRIC_SPECS のキー) ごとの単位・符号の説明。 */
const METRIC_SIGN_NOTES: Readonly<Record<string, string>> = {
  noncomm_net:
    "単位は枚(契約数)。買い建玉−売り建玉なので、プラス=買い越し、マイナス=売り越し。",
  noncomm_long: "単位は枚(契約数)。常に0以上。",
  noncomm_short: "単位は枚(契約数)。常に0以上。",
  comm_net:
    "単位は枚(契約数)。買い建玉−売り建玉なので、プラス=買い越し、マイナス=売り越し。",
  open_interest: "単位は枚(契約数)。常に0以上。",
};

/**
 * 契約ごとの「1 枚の大きさ」の説明。取得元モジュールは単位文字列
 * (`枚 (建玉数、…合算不可)`) にこの注意を持たせているが、観測ログの単位は
 * `枚` に揃えるため、同じ注意を指標定義の説明文へ移す (落とさない)。
 * 値は取得元モジュールが完全一致で検査している contract_units
 * (`(CONTRACTS OF JPY 12,500,000)` / `(NIKKEI INDEX X JPY 500)`) に対応する。
 */
const CONTRACT_SIZE_NOTES: Readonly<Record<CftcCotContractKey, string>> = {
  jpy: "円先物は1枚=1,250万円分の円(対米ドル)の取引。",
  nikkei225_yen:
    "日経平均先物(円建て)は1枚=日経平均×500円分の取引(例えば日経平均が40,000円なら1枚は約2,000万円分)。",
};
const CONTRACT_SUM_CAVEAT =
  "1枚の大きさが契約ごとに違うので、円先物と日経平均先物の枚数を足したり、枚数の大小で比べたりしない。";

const ADAPTER_LIMITATIONS =
  "【対象レポート】CFTC の Legacy 形式・先物のみ(Futures Only)の集計で、同じ契約のオプション建玉は含まない" +
  "(先物とオプションを合算した Futures-and-Options Combined レポートとは値が違う)。" +
  "非商業筋の買い・売り建玉には、同じトレーダーが買いと売りを両建てしたスプレッド分を含まない。" +
  "【取込の範囲】観測ログには毎週、最新の公表回(基準日=直前火曜)の1週分だけを書く" +
  "(API応答には過去8週分が入っているが、過去週は書き直さない)。公表が米国の祝日や政府閉鎖で" +
  "遅れて、次の取込までに公表されなかった週は、取込時に「未公表」として失敗を記録する" +
  "(黙ってスキップしない)。その週が後から公表されても自動では遡らないため、必要なら再実行する。" +
  "【期間】対象期間は基準日(火曜)の ISO 週 (例 2026-09-22 → 2026-W39)。CFTC 自身の" +
  "「Report Week」番号(同じ回で 38)とは数え方が違う。残高なので期間開始=期間終了=基準日。" +
  "【公表の遅れ】基準日(火曜)から3日後の金曜 米国東部時間15:30 (日本時間の土曜早朝) に公表。" +
  "【前期比】取得元の前週差 (change_in_*) は保存しない(空欄)。週差は観測ログの前週行と比べて見る。" +
  "【近似】日本の資金フローそのものではなく、米国上場の先物の建玉(ストック)による参考指標のため" +
  "近似フラグを立てる(CFTC の集計値自体は実測)。";

function toIndicatorDef(
  def: (typeof CFTC_COT_JPY_INDICATORS)[number],
): IndicatorDefInput {
  const m = /^cftc_cot_(jpy|nikkei225_yen)_(.+)$/.exec(def.key);
  if (!m) {
    throw new Error(
      `cftc-cot-jpy: 想定外の指標キーです (取得元モジュールの変更?): ${def.key}`,
    );
  }
  const contractKey = m[1] as CftcCotContractKey;
  const metric = m[2] as string;
  const sizeNote = CONTRACT_SIZE_NOTES[contractKey];
  const signNote = METRIC_SIGN_NOTES[metric];
  if (signNote === undefined) {
    throw new Error(
      `cftc-cot-jpy: 指標 ${def.key} の単位・符号の説明が未定義です (METRIC_SIGN_NOTES に追加)`,
    );
  }
  if (!def.sourceUrl.startsWith("https://")) {
    throw new Error(
      `cftc-cot-jpy: 指標 ${def.key} の出典URLが https ではありません: ${def.sourceUrl}`,
    );
  }
  return {
    key: def.key,
    displayName: def.displayName,
    // docs/moneyflow.md の一覧で R3 (資産クラス比較) が主、R4 は再掲。
    requirement: "R3",
    flowType: "建玉",
    description:
      `${def.plainDescription} ` +
      `【定義】${def.definition} ` +
      `【種別】ある時点の建玉(ストック)であり、期間中に流れたお金(フロー)ではない。${signNote} ` +
      `${sizeNote}${CONTRACT_SUM_CAVEAT}`,
    sourceUrl: def.sourceUrl,
    // CFTC は米国連邦政府機関で、その統計は米国著作権法上パブリックドメイン。
    license: "public-domain",
    frequency: "週次",
    limitations: `${def.limitations} ${ADAPTER_LIMITATIONS}`,
  };
}

const INDICATORS: readonly IndicatorDefInput[] =
  CFTC_COT_JPY_INDICATORS.map(toIndicatorDef);

/** 基準日 (YYYY-MM-DD) → 冪等キー。 */
function keyForAsOfDate(asOfDate: string): string {
  return `${CFTC_COT_JPY_SPEC_NAME}-${isoWeekLabelOf(new Date(`${asOfDate}T00:00:00Z`))}`;
}

function weekOfKey(key: string): string {
  const m = KEY_RE.exec(key);
  if (!m)
    throw new Error(
      `cftc-cot-jpy: 冪等キーの形式が想定外です (cftc-cot-jpy-YYYY-Www): ${key}`,
    );
  return m[1] as string;
}

function decodeJson(file: SpecFile): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new Error(
      `cftc-cot-jpy: ${file.filename} が JSON として読めません: ${(e as Error).message}`,
      {
        cause: e,
      },
    );
  }
}

/** キーの週の行を、追跡対象契約の定義順に 1 契約 1 行ずつ取り出す (欠けていれば throw)。 */
function rowsForWeek(
  rows: readonly CftcCotJpyRow[],
  week: string,
): CftcCotJpyRow[] {
  const inWeek = rows.filter(
    (r) => isoWeekLabelOf(new Date(`${r.asOfDate}T00:00:00Z`)) === week,
  );
  const dates = [...new Set(inWeek.map((r) => r.asOfDate))];
  if (dates.length !== 1) {
    throw new Error(
      `cftc-cot-jpy: ${week} の基準日が ${dates.length} 種類あります (1 種類であるべき): ${dates.join(", ")}`,
    );
  }
  return CFTC_TRACKED_CONTRACTS.map((c) => {
    const hits = inWeek.filter((r) => r.contractCode === c.code);
    if (hits.length !== 1) {
      throw new Error(
        `cftc-cot-jpy: ${week} (基準日 ${dates[0]}) の契約 ${c.code} (${c.displayName}) の行が ${hits.length} 件です ` +
          `(1 件であるべき)。報告基準未満で公表対象から外れた可能性があります`,
      );
    }
    return hits[0] as CftcCotJpyRow;
  });
}

function contractKeyOfCategory(category: string): CftcCotContractKey {
  const c = CFTC_TRACKED_CONTRACTS.find((t) => t.category === category);
  if (!c)
    throw new Error(
      `cftc-cot-jpy: 取得元モジュールの区分が想定外です: ${category}`,
    );
  return c.key;
}

function toObservations(input: {
  key: string;
  files: readonly SpecFile[];
}): ObservationDraft[] {
  const week = weekOfKey(input.key);
  const file = requireSpecFile(
    input.files,
    (name) => name === CFTC_COT_JPY_RESPONSE_FILENAME,
    "cftc-cot-jpy Socrata API 応答",
  );
  const rows = rowsForWeek(parseCftcCotJpyRows(decodeJson(file)), week);
  const indicatorKeys = new Set(INDICATORS.map((i) => i.key));
  return toCftcCotObservationRecords(rows).map((rec) => {
    if (!indicatorKeys.has(rec.indicatorKey)) {
      throw new Error(
        `cftc-cot-jpy: 指標定義に無い指標キーの観測が作られました: ${rec.indicatorKey}`,
      );
    }
    if (!Number.isInteger(rec.value)) {
      throw new Error(
        `cftc-cot-jpy: ${rec.indicatorKey} の値が整数(枚数)ではありません: ${rec.value}`,
      );
    }
    return {
      period: week,
      periodStart: rec.period.asOfDate,
      periodEnd: rec.period.asOfDate,
      indicatorKey: rec.indicatorKey,
      category: CATEGORY_BY_CONTRACT[contractKeyOfCategory(rec.category)],
      categoryKind: CATEGORY_KIND,
      value: rec.value,
      unit: "枚",
      changeFromPrev: null,
      approximate: rec.isApproximate,
      measureKind: rec.isEstimated ? "推定" : "実測",
    };
  });
}

async function resolve(now: Date) {
  const result = await resolveCftcCotJpy({ now });
  if (result.status !== "ok") {
    throw new Error(
      `cftc-cot-jpy: 最新回がまだ公表されていません (基準日 ${result.expectedAsOfDate}、` +
        `公表予定 ${result.expectedReleaseDate} 米国東部時間15:30): ${result.reason}`,
    );
  }
  const key = keyForAsOfDate(result.asOfDate);
  const batch: FetchedBatch = {
    key,
    source: result.requestUrl,
    metadata: {
      asOfDate: result.asOfDate,
      requestUrl: result.requestUrl,
      humanReportUrl: CFTC_COT_HUMAN_REPORT_URL,
      contracts: result.rows.map((r) => ({
        code: r.contractCode,
        name: r.contractName,
        week: r.reportWeekLabel,
      })),
      missingContracts: result.missingContracts,
    },
    files: [
      {
        filename: CFTC_COT_JPY_RESPONSE_FILENAME,
        bytes: new TextEncoder().encode(result.rawResponseText),
        contentType: "application/json",
      },
    ],
  };
  return { key, fetch: async () => batch };
}

export const cftcCotJpySpec: MoneyflowSourceSpec = {
  name: CFTC_COT_JPY_SPEC_NAME,
  indicators: INDICATORS,
  resolve,
  toObservations,
};
