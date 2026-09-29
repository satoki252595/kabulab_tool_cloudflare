/**
 * JPX 信用残高 (日次) の 33 業種別集計 — `MoneyflowSourceSpec` への接続。
 *
 * 取得・解析の本体は `../sources/jpx-margin-sector.ts`。
 *   - resolve: R2 の実 latest 基準日を決め、snapshot replay + D1 join の
 *     mapping を固定 capture する。fetch はその closure を返すだけ
 *     (cftc-cot-jpy と同型。JPX 原本への二重取得なし)。
 *   - toObservations: snapshot JSON + mapping JSON の 2 ファイルから純粋に
 *     33 業種 (+ 未分類) × 14 指標の drafts を作る。
 *
 * key 契約: category は業種名のまま (既存 `期間|指標|区分` を保つ)。
 * 新 6 内訳は公表日だけ設定し、他 5 件は null (33 行の key 衝突を避ける。
 * msg_1fbfc21b7d10 の 33 業種契約どおり)。
 */
import {
  requireSpecFile,
  type FetchedBatch,
  type MoneyflowSourceSpec,
  type ObservationDraft,
  type SpecFile,
} from "../source-spec.js";
import {
  aggregateMarginSectors,
  MARGIN_SECTOR_INPUT_FORMAT,
  MARGIN_SECTOR_SPEC_NAME,
  parseMarginSectorInput,
  resolveMarginSectorBatch,
  type MarginSectorBalances,
  type MarginSectorChg,
  type MarginSectorRow,
} from "../sources/jpx-margin-sector.js";
import type { MarginDailySnapshot } from "../../../vwap-analysis/lib/margin-daily.js";
import { MARGIN_DAILY_FORMAT } from "../../../vwap-analysis/lib/margin-daily.js";
import type { IndicatorDefInput } from "../../../../src/shared/notion-archive/index.js";

const JPX_MARGIN_SOURCE_URL = "https://www.jpx.co.jp/markets/statistics-equities/margin/01.html";

/** 一次データ保管のファイル名 (基準日つき。snapshot replay + derived mapping)。 */
export function marginSectorFilenames(basisDate: string): { snapshot: string; mapping: string } {
  return {
    snapshot: `margin-daily-${basisDate}.json`,
    mapping: `margin-sector-input-${basisDate}.json`,
  };
}

function decodeJson(file: SpecFile, what: string): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new Error(`${MARGIN_SECTOR_SPEC_NAME}: ${what} (${file.filename}) が JSON として読めません: ${(e as Error).message}`, {
      cause: e,
    });
  }
}

const R1 = "R1" as const;
const DAILY = "日次" as const;
const PERSONAL_ONLY = "personal-only" as const;

/**
 * 残高の限界 (全 12 残高指標で共通)。派生比率は別文。
 */
const BALANCE_LIMITATIONS =
  "対象は当該基準日の JPX 信用残高に載る銘柄のうち、上場中の内国普通株" +
  "(active かつ equity) に属する行。ETF・REIT・上場廃止・銘柄種別不明などで紐付かない行は" +
  "除外し、件数と理由を一次データ保管の mapping JSON に残す (0 扱いで足さない)。" +
  "同一ティッカー複数行 (普通株+種類株等) は全行を合算する。" +
  "前期比 (公式前営業日差の合計) は、構成銘柄のいずれかが `-` (未公表) の業種では null" +
  "(未取得のまま。0 埋めしない)。信用残高の原本 coverage と株価データの欠損は別の話で、" +
  "分母を混ぜない。";

function balanceIndicator(
  leg: keyof MarginSectorBalances,
  unit: "株" | "円",
  displayName: string,
  description: string,
): IndicatorDefInput {
  const legName =
    leg === "sell" ? "sell" : leg === "buy" ? "buy" : leg === "negSell" ? "neg_sell" : leg === "stdSell" ? "std_sell" : leg === "negBuy" ? "neg_buy" : "std_buy";
  return {
    key: `sector_margin_${legName}_${unit === "株" ? "shares" : "amount"}`,
    displayName,
    requirement: R1,
    flowType: "残高",
    description,
    sourceUrl: JPX_MARGIN_SOURCE_URL,
    license: PERSONAL_ONLY,
    frequency: DAILY,
    limitations: BALANCE_LIMITATIONS,
  };
}

/** 指標キー → (残高 leg, 株/円)。draftsForRow が値を取り出すための対応表。 */
const LEG_OF: Record<string, { leg: keyof MarginSectorBalances; unit: "株" | "円" }> = {
  sector_margin_sell_shares: { leg: "sell", unit: "株" },
  sector_margin_sell_amount: { leg: "sell", unit: "円" },
  sector_margin_buy_shares: { leg: "buy", unit: "株" },
  sector_margin_buy_amount: { leg: "buy", unit: "円" },
  sector_margin_neg_sell_shares: { leg: "negSell", unit: "株" },
  sector_margin_neg_sell_amount: { leg: "negSell", unit: "円" },
  sector_margin_std_sell_shares: { leg: "stdSell", unit: "株" },
  sector_margin_std_sell_amount: { leg: "stdSell", unit: "円" },
  sector_margin_neg_buy_shares: { leg: "negBuy", unit: "株" },
  sector_margin_neg_buy_amount: { leg: "negBuy", unit: "円" },
  sector_margin_std_buy_shares: { leg: "stdBuy", unit: "株" },
  sector_margin_std_buy_amount: { leg: "stdBuy", unit: "円" },
};

const BALANCE_INDICATORS = [
  balanceIndicator(
    "sell",
    "株",
    "業種別信用売残高（株数）",
    "その業種の上場普通株について「信用売り (空売り) されたまま返済されていない株数」を基準日に合計した残高 (ストック)。" +
      "値が大きいほど、その業種に売り持ち (将来買い戻す約束) が積み上がっていることを示す。" +
      "前期比は JPX 公表の前営業日差の合計。",
  ),
  balanceIndicator(
    "sell",
    "円",
    "業種別信用売残高（金額）",
    "業種別信用売残高（株数）の金額版。その業種の信用売り残高を金額 (円) で合計した残高。" +
      "株価水準の違う銘柄を比べるときは金額版を見る。前期比は JPX 公表の前営業日差の合計。",
  ),
  balanceIndicator(
    "buy",
    "株",
    "業種別信用買残高（株数）",
    "その業種の上場普通株について「信用買い (借金で買う) されたまま返済されていない株数」を基準日に合計した残高 (ストック)。" +
      "値が大きいほど、その業種に買い持ち (将来売って返す約束) が積み上がっていることを示す。" +
      "前期比は JPX 公表の前営業日差の合計。",
  ),
  balanceIndicator(
    "buy",
    "円",
    "業種別信用買残高（金額）",
    "業種別信用買残高（株数）の金額版。その業種の信用買い残高を金額 (円) で合計した残高。" +
      "株価水準の違う銘柄を比べるときは金額版を見る。前期比は JPX 公表の前営業日差の合計。",
  ),
  balanceIndicator(
    "negSell",
    "株",
    "業種別一般信用売残高（株数）",
    "信用売残高のうち「一般信用取引」分 (証券会社ごとの自由な条件の信用売り) の合計。" +
      "一般信用売残 + 制度信用売残 = 信用売残高になる (原文の内訳どおり)。前期比は JPX 公表の前営業日差の合計。",
  ),
  balanceIndicator(
    "negSell",
    "円",
    "業種別一般信用売残高（金額）",
    "業種別一般信用売残高（株数）の金額版。前期比は JPX 公表の前営業日差の合計。",
  ),
  balanceIndicator(
    "stdSell",
    "株",
    "業種別制度信用売残高（株数）",
    "信用売残高のうち「制度信用取引」分 (取引所の決まったルールの信用売り) の合計。" +
      "一般信用売残 + 制度信用売残 = 信用売残高になる (原文の内訳どおり)。前期比は JPX 公表の前営業日差の合計。",
  ),
  balanceIndicator(
    "stdSell",
    "円",
    "業種別制度信用売残高（金額）",
    "業種別制度信用売残高（株数）の金額版。前期比は JPX 公表の前営業日差の合計。",
  ),
  balanceIndicator(
    "negBuy",
    "株",
    "業種別一般信用買残高（株数）",
    "信用買残高のうち「一般信用取引」分 (証券会社ごとの自由な条件の信用買い) の合計。" +
      "一般信用買残 + 制度信用買残 = 信用買残高になる (原文の内訳どおり)。前期比は JPX 公表の前営業日差の合計。",
  ),
  balanceIndicator(
    "negBuy",
    "円",
    "業種別一般信用買残高（金額）",
    "業種別一般信用買残高（株数）の金額版。前期比は JPX 公表の前営業日差の合計。",
  ),
  balanceIndicator(
    "stdBuy",
    "株",
    "業種別制度信用買残高（株数）",
    "信用買残高のうち「制度信用取引」分 (取引所の決まったルールの信用買い) の合計。" +
      "一般信用買残 + 制度信用買残 = 信用買残高になる (原文の内訳どおり)。前期比は JPX 公表の前営業日差の合計。",
  ),
  balanceIndicator(
    "stdBuy",
    "円",
    "業種別制度信用買残高（金額）",
    "業種別制度信用買残高（株数）の金額版。前期比は JPX 公表の前営業日差の合計。",
  ),
] as const;

const RATIO_LIMITATIONS =
  "信用売買比率は JPX の公表値ではなく、この取込が公式残高から exact に計算した" +
  "派生値 (式は指標定義の説明を参照)。銘柄ごとの公式「上場比」は合計せず、" +
  "業種の合計残高から直接計算する (比率の合計は意味を持たないため)。" +
  "対象母集団は残高 12 指標と同じ (上場中の内国普通株に属する行)。" +
  "売残と買残がどちらも 0 の業種は比率が定義できないため書かず失敗させる (0% と捏造しない)。";

const RATIO_INDICATORS = [
  {
    key: "sector_margin_sell_position_ratio_shares",
    displayName: "業種別信用売買比率（株数）",
    requirement: R1,
    flowType: "比率",
    description:
      "その業種の信用残高のうち売りが占める割合。式: 売残合計(株) ÷ (売残合計(株) + 買残合計(株))。" +
      "0.5 より大きければ売り持ち優勢、小さければ買い持ち優勢の目安。0〜1 の値 (0.5 = 50%)。" +
      "JPX 公表の「上場比」(残高÷上場株式数) とは別物で、上場株式数は使わない。",
    sourceUrl: JPX_MARGIN_SOURCE_URL,
    license: PERSONAL_ONLY,
    frequency: DAILY,
    limitations: RATIO_LIMITATIONS,
  },
  {
    key: "sector_margin_sell_position_ratio_amount",
    displayName: "業種別信用売買比率（金額）",
    requirement: R1,
    flowType: "比率",
    description:
      "その業種の信用残高のうち売りが占める割合。式: 売残合計(円) ÷ (売残合計(円) + 買残合計(円))。" +
      "0.5 より大きければ売り持ち優勢、小さければ買い持ち優勢の目安。0〜1 の値 (0.5 = 50%)。" +
      "JPX 公表の「上場比」(残高÷上場株式数) とは別物で、上場株式数は使わない。",
    sourceUrl: JPX_MARGIN_SOURCE_URL,
    license: PERSONAL_ONLY,
    frequency: DAILY,
    limitations: RATIO_LIMITATIONS,
  },
] as const satisfies readonly IndicatorDefInput[];

export const MARGIN_SECTOR_INDICATORS: readonly IndicatorDefInput[] = [
  ...BALANCE_INDICATORS,
  ...RATIO_INDICATORS,
];

function draftsForRow(
  basisDate: string,
  publicationDate: string,
  row: MarginSectorRow,
): ObservationDraft[] {
  const common = {
    period: basisDate,
    periodStart: basisDate,
    periodEnd: basisDate,
    category: row.sector,
    categoryKind: "業種" as const,
    approximate: true,
    measureKind: "実測" as const,
    // 新 6 内訳は公表日だけ (33 行の key 衝突回避)。
    marketSegment: null,
    investorCategory: null,
    tradeType: null,
    parentCategory: null,
    categoryLevel: null,
    publicationDate,
  };
  const out: ObservationDraft[] = [];
  for (const ind of BALANCE_INDICATORS) {
    const lu = LEG_OF[ind.key];
    if (!lu) fail(`対応表に無い残高指標キーです: ${ind.key}`);
    const fig = lu.unit === "株" ? row.shares : row.amounts;
    const chg: MarginSectorChg = lu.unit === "株" ? row.sharesChg : row.amountsChg;
    out.push({
      ...common,
      indicatorKey: ind.key,
      value: fig[lu.leg],
      unit: lu.unit,
      changeFromPrev: chg[lu.leg],
    });
  }
  for (const ind of RATIO_INDICATORS) {
    const fig = ind.key.endsWith("_shares") ? row.shares : row.amounts;
    const denom = fig.sell + fig.buy;
    if (!(denom > 0)) {
      throw new Error(
        `${MARGIN_SECTOR_SPEC_NAME}: ${row.sector} の売買残合計が 0 のため比率を計算できません (0% と捏造しない)`
      );
    }
    out.push({
      ...common,
      indicatorKey: ind.key,
      value: fig.sell / denom,
      unit: "比率",
      changeFromPrev: null,
    });
  }
  return out;
}

function toObservations(input: { key: string; files: readonly SpecFile[] }): ObservationDraft[] {
  const m = new RegExp(`^${MARGIN_SECTOR_SPEC_NAME}-(\\d{4}-\\d{2}-\\d{2})$`).exec(input.key);
  if (!m) fail(`冪等キーの形式が想定外です (${MARGIN_SECTOR_SPEC_NAME}-YYYY-MM-DD): ${input.key}`);
  const basisDate = (m as RegExpExecArray)[1] as string;
  const names = marginSectorFilenames(basisDate);
  const snapshotFile = requireSpecFile(
    input.files,
    (name) => name === names.snapshot,
    `${MARGIN_SECTOR_SPEC_NAME} 日次スナップショット`,
  );
  const mappingFile = requireSpecFile(
    input.files,
    (name) => name === names.mapping,
    `${MARGIN_SECTOR_SPEC_NAME} mapping/coverage capture`,
  );
  const snapshot = decodeJson(snapshotFile, "日次スナップショット") as MarginDailySnapshot;
  if (snapshot.format !== MARGIN_DAILY_FORMAT) {
    fail(`snapshot の形式タグが未知です: ${String(snapshot.format)}`);
  }
  const mapping = parseMarginSectorInput(decodeJson(mappingFile, "mapping/coverage capture"));
  const { sectors, coverage } = aggregateMarginSectors(snapshot, mapping);
  const drafts = sectors.flatMap((row) => draftsForRow(basisDate, snapshot.publicationDate, row));
  // 行数の確定検査: 33 業種 × 14 指標 (+ 未分類がある場合のみ 14 行)。
  const perSector = MARGIN_SECTOR_INDICATORS.length;
  const want = (coverage.unclassifiedRows > 0 ? 34 : 33) * perSector;
  if (drafts.length !== want) {
    fail(`draft 行数が想定外です: ${drafts.length} != ${want} (33 業種 × ${perSector} 指標)`);
  }
  return drafts;
}

function fail(msg: string): never {
  throw new Error(msg);
}

async function resolve(_now: Date): Promise<{ key: string; fetch: () => Promise<FetchedBatch> }> {
  // 基準日は R2 の実 latest から決める (price 最新日/as-of は使わない)。
  const { key, basisDate, snapshotJson, snapshot, mapping } = await resolveMarginSectorBatch();
  const names = marginSectorFilenames(basisDate);
  const mappingJson = JSON.stringify(mapping);
  const batch: FetchedBatch = {
    key,
    source: snapshot.sourceUrl,
    metadata: {
      basisDate,
      publicationDate: snapshot.publicationDate,
      // 由来 PDF identity (typed provenance)。保管 replay の照合に使う。
      pdfSha256: snapshot.rawSha256,
      pdfSourceUrl: snapshot.sourceUrl,
      vwapPrimaryPageId: snapshot.rawPageId,
      snapshotKey: `margin/daily/${basisDate}.json`,
      mappingFormat: MARGIN_SECTOR_INPUT_FORMAT,
      derivedNote:
        "mapping JSON は当取得元が snapshot + D1 join から作った derived capture (JPX 原本ではない)",
      universe: mapping.coverage.universe,
      matched: mapping.coverage.matched,
      excludedNoTicker: mapping.coverage.excludedNoTicker.length,
      excludedNotInMaster: mapping.coverage.excludedNotInMaster.length,
      excludedOutsideActiveEquity: mapping.coverage.excludedOutsideActiveEquity.length,
    },
    files: [
      {
        filename: names.snapshot,
        bytes: new TextEncoder().encode(snapshotJson),
        contentType: "application/json",
      },
      {
        filename: names.mapping,
        bytes: new TextEncoder().encode(mappingJson),
        contentType: "application/json",
      },
    ],
  };
  return { key, fetch: async () => batch };
}

export const marginSectorSpec: MoneyflowSourceSpec = {
  name: MARGIN_SECTOR_SPEC_NAME,
  indicators: MARGIN_SECTOR_INDICATORS,
  resolve,
  toObservations,
};
