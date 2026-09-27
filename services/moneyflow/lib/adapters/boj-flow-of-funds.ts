/**
 * moneyflow アダプタ: 日本銀行「資金循環統計」速報 (sjpre.xlsx の「（１）全体表」)。
 *
 * 取得元モジュール `../sources/boj-flow-of-funds.ts` (取得・解析・独自の指標定義) を
 * `MoneyflowSourceSpec` (`../source-spec.ts`) に揃える。規約は `./README.md`。
 *
 * ## spec
 * `boj-flow-of-funds` の 1 本。日銀は四半期に 1 回、速報 Excel を **同じ URL に上書き**
 * で配布する (https://www.boj.or.jp/statistics/sj/sjpre.xlsx)。1 ファイルに
 * 「１．金融取引表」(四半期中の取引 = フロー) と「２．金融資産・負債残高表」
 * (期末残高 = ストック) の両方が入っているので、両者を 1 バッチとして扱う。
 *
 * ## 1 バッチの中身 (行数)
 * モジュールが採用した 12 金融商品 (固定: A 現金・預金 / C 貸出 / D 債務証券 /
 * Db 国債・財投債 / Df 事業債 / E 株式等・投資信託受益証券 / Ea 株式等 / Eaa 上場株式 /
 * Eb 投資信託受益証券 / F 保険・年金・定型保証 / K 対外直接投資 / L 対外証券投資)
 * × フロー/ストック × 葉の制度部門 9 × 資産/負債 のうち、表に値のあるセルだけ。
 * 上限 432 行 (2026年4〜6月期速報の実ファイルで 282 行)。集計部門
 * (非金融法人企業計・一般政府計・うち公的年金・合計) は二重計上になるため出さない。
 *
 * ## 冪等キー
 * `boj-flow-of-funds-<YYYY-Qn>-prelim-<掲載日 YYYY-MM-DD>`
 * (例 `boj-flow-of-funds-2026-Q2-prelim-2026-09-17`)。固定 URL・上書き配布なので、
 * 同じ四半期の再掲載 (訂正) を別バッチとして取り直せるよう index.htm の「掲載日」を
 * 版として含める。`resolve()` は index.htm (1 リクエスト) だけで決まる。
 * 期間と「速報」であることは `toObservations()` がファイル本体から読み直し、
 * キーと一致しなければ throw する (上書き配布の取り違え防止)。
 *
 * ## 生バイト列の保管 (ルール6)
 * 取得した sjpre.xlsx のバイト列をそのまま `boj-sjpre-<YYYY-Qn>.xlsx` として保管する。
 */
import type {
  IndicatorDefInput,
  MoneyflowFlowType,
  MoneyflowRequirement,
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
  BOJ_FLOW_OF_FUNDS_INDEX_URL,
  BOJ_FLOW_OF_FUNDS_INDICATORS,
  BOJ_SECTORS,
  fetchLatestBojFlowOfFunds,
  parseBojFlowOfFunds,
  resolveLatestBojFlowOfFundsFile,
  toObservations as toBojObservations,
  type BojFlowOfFundsDocument,
  type BojIndicatorDefinition,
  type BojQuarter,
} from "../sources/boj-flow-of-funds.js";

export const BOJ_FLOW_OF_FUNDS_SPEC_NAME = "boj-flow-of-funds";

/** 取得元の値の単位 (億円) → 観測ログの単位 (円) の倍率。 */
const OKU_YEN = 100_000_000;

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const KEY_RE = /^boj-flow-of-funds-(\d{4})-Q([1-4])-prelim-(\d{4}-\d{2}-\d{2})$/;
const XLSX_FILE_RE = /^boj-sjpre-\d{4}-Q[1-4]\.xlsx$/;
/** index.htm の「公表対象期」欄 (速報 Excel の行)。例: 「速報（2026年第2四半期）」 */
const PERIOD_HINT_RE = /^速報[（(](\d{4})年第([1-4])四半期[）)]$/;

interface BatchKey {
  year: number;
  quarter: BojQuarter;
  announcedAt: string;
}

function periodLabel(p: { year: number; quarter: number }): string {
  return `${p.year}-Q${p.quarter}`;
}

export function bojFlowOfFundsBatchKey(k: BatchKey): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(k.announcedAt)) {
    throw new Error(`[boj-flow-of-funds] 掲載日が YYYY-MM-DD ではありません: ${k.announcedAt}`);
  }
  return `${BOJ_FLOW_OF_FUNDS_SPEC_NAME}-${periodLabel(k)}-prelim-${k.announcedAt}`;
}

export function parseBojFlowOfFundsBatchKey(key: string): BatchKey {
  const m = KEY_RE.exec(key);
  if (!m) throw new Error(`[boj-flow-of-funds] 冪等キーの形式が違います: ${key}`);
  return { year: Number(m[1]), quarter: Number(m[2]) as BojQuarter, announcedAt: m[3] as string };
}

/** 保管ファイル名。期間はキーと同じ `YYYY-Qn`。 */
export function bojSjpreFilename(p: { year: number; quarter: number }): string {
  return `boj-sjpre-${periodLabel(p)}.xlsx`;
}

// ---------------------------------------------------------------------------
// 指標定義 (モジュールの定義 → IndicatorDefInput)
// ---------------------------------------------------------------------------

function toFlowType(def: BojIndicatorDefinition): MoneyflowFlowType {
  // フロー表 = 四半期中の取引の純額 (資産側は取得-処分、負債側は発行・借入-償還・返済)。
  if (def.flowType === "net_flow") return "純買い越し";
  if (def.flowType === "holdings_stock") return "残高";
  throw new Error(`[boj-flow-of-funds] ${def.key}: 対応付けの無い flowType です: ${String(def.flowType)}`);
}

/**
 * 要件は 1 つに絞る。docs/moneyflow.md の在庫表で資金循環統計は R2 表
 * (「部門別×金融商品別の残高・フロー」) に載る。モジュールの要件リストは
 * 先頭が主要件 (A〜F は R2、対外投資 K/L は R4) なので先頭を採る。
 */
function toRequirement(def: BojIndicatorDefinition): MoneyflowRequirement {
  const first = def.requirements[0];
  if (first === undefined) throw new Error(`[boj-flow-of-funds] ${def.key}: 要件がありません`);
  return first;
}

function assertUnit(unit: string, where: string): void {
  if (unit !== "億円") {
    throw new Error(`[boj-flow-of-funds] ${where}: 単位が想定 (億円) と違います: ${unit}`);
  }
}

const UNIT_TEXT =
  " 【単位】日銀の表の単位は億円だが、観測ログには円に換算して記録する" +
  "(例: 表の 37,452 億円 → 3,745,200,000,000 円)。";

const SECTOR_TEXT =
  " 【区分】『資産 / 部門名』『負債 / 部門名』の形。部門は 金融機関(日本銀行・銀行・保険・年金基金・" +
  "証券会社・投資信託などをまとめた1部門) / 民間非金融法人企業 / 公的非金融法人企業 / 中央政府 / " +
  "地方公共団体 / 社会保障基金 / 家計 / 対家計民間非営利団体 / 海外(日本の居住者以外)。" +
  "『資産 / 海外』は海外の投資家などが持つ日本の金融商品、『負債 / 海外』は海外が日本の居住者に" +
  "負っているもの(例: 日本の投資家が持つ外国の株・債券)。" +
  "家計が投資信託を通じて間接的に持つ株式は、家計の『株式等』ではなく『投資信託受益証券』に入る。";

const FLOW_TEXT =
  " 【フローの符号】『資産 / 部門』の行は、その部門がこの金融商品を四半期中の取引で差し引きいくら" +
  "増やしたか(プラス=買い・預け入れ等で増えた、マイナス=売却・引き出し等で減った)。" +
  "『負債 / 部門』の行は、その部門がこの金融商品で差し引きいくら資金を調達したか" +
  "(プラス=発行・借入が返済・償還を上回った、マイナス=返済・償還や自社株買いなどの方が多かった)。" +
  "ただし『負債 / 海外』の行だけは読み方が違い、日本の居住者(資産側の各部門)がその金融商品" +
  "(外国の株・債券、海外への出資・貸出・預金など)を差し引きいくら増やしたかの合計と同じ額になる。" +
  "プラス=日本から海外へ差し引きお金が出た(買い越し・出資や貸出の積み増し)、マイナス=海外から日本へ" +
  "差し引き引き揚げた(売り越し・回収)。日本の投資家が外国の証券を海外の投資家に売った分もマイナスに" +
  "入るので、海外の発行体が償還・返済したとは限らない。" +
  "株価・金利・為替の値動きだけによる増減は含まない。" +
  "どの金融商品も誰かの資産であると同時に誰かの負債なので、全部門の資産側の合計と負債側の合計は原則一致する。" +
  "ある部門のプラスは他の部門の売り(マイナス)や発行(負債側のプラス)と対になっており、" +
  "市場全体に新しいお金が流れ込んだ額ではない。";

const STOCK_TEXT =
  " 【ストックの読み方】流れ(フロー)ではなく期末時点の残高。『資産 / 部門』はその部門が期末に持っている額" +
  "(時価)、『負債 / 部門』はその部門が発行・借入していて期末に負っている額(株式なら発行した株式の時価)。" +
  "前の期末との差には取引だけでなく株価・金利・為替の値動きによる増減が混ざるため、差をそのまま" +
  "『お金が流れ込んだ額』と読むことはできない(取引だけの増減は同じ金融商品の『フロー』指標を見る)。";

const COMMON_LIMITATIONS =
  " 日銀の速報値で、後の公表(翌四半期以降の速報・年1回の確報)で改定されうる。" +
  "取込は毎回その時点の最新四半期の速報ファイル(sjpre.xlsx)だけを読むため、改定後の値で過去の期を取り直さない" +
  "(観測ログの過去の行は速報のまま残る)。" +
  "取り込む金融商品は実装で固定した12項目(現金・預金/貸出/債務証券/国債・財投債/事業債/株式等・投資信託受益証券/" +
  "株式等/上場株式/投資信託受益証券/保険・年金・定型保証/対外直接投資/対外証券投資)だけで、表のそれ以外の行は" +
  "取り込まない。項目どうしは包含関係がある(株式等・投資信託受益証券 ⊃ 株式等 ⊃ 上場株式、" +
  "債務証券 ⊃ 国債・財投債・事業債)ので、指標をまたいで足し合わせてはいけない。" +
  "集計の部門(非金融法人企業計・一般政府計・うち公的年金・合計)は二重計上になるため取り込まない。" +
  "表で空欄のセル(日銀がその部門のその資産・負債に計数を載せていないもの)は行を作らない(0 で埋めない。表が 0 と書いているものは 0 を記録)。" +
  "前期比は記録しない(空欄)。" +
  "公表は四半期末から約2〜3か月後(2026年4〜6月期は 2026-09-17 公表)で、日銀は公表日を確約していない。" +
  "資金循環統計そのものが各種の統計を組み合わせて日銀が作る加工統計(日銀による推計を含む)だが、" +
  "ここでは日銀の公表値をそのまま記録する(実測扱い)。" +
  "取得は日銀サイトの速報 Excel のみで、時系列統計データ検索サイトの API は規約で高頻度アクセスが禁止されているため使わない。" +
  "表の見出し・部門の列・行コードが変わると取込は失敗する(様式変更を黙って読み違えない)。" +
  "利用条件: 転載・複製時は出所(日本銀行「資金循環統計」)の明記が必要、商用目的の転載・複製は日本銀行への事前相談が必要。";

const STOCK_LIMITATIONS =
  " 残高(ストック)は流れそのものではないため近似フラグを立てている。時価ベースの残高なので、" +
  "取引が無くても値動きで増減する(取引による増減と値動きの内訳は日銀の「３．調整表」にあるが本取込の対象外)。";

function toIndicatorDef(def: BojIndicatorDefinition): IndicatorDefInput {
  if (def.frequency !== "四半期") {
    throw new Error(`[boj-flow-of-funds] ${def.key}: 頻度が想定 (四半期) と違います: ${def.frequency}`);
  }
  assertUnit(def.unit, def.key);
  const isFlow = def.table === "flow";
  // モジュールの定義文末尾の「単位は億円。」は日銀の表の単位。観測ログは円に換算するため
  // 取り違えないよう外し、UNIT_TEXT で「表は億円・記録は円」と書き直す。
  const definition = def.definition.replace(/ ?単位は億円。$/, "");
  return {
    key: def.key,
    displayName: `資金循環 ${def.label}`,
    requirement: toRequirement(def),
    flowType: toFlowType(def),
    description: `${def.measures} ${definition}${UNIT_TEXT}${isFlow ? FLOW_TEXT : STOCK_TEXT}${SECTOR_TEXT}`,
    sourceUrl: def.sourceUrl,
    license: "attribution-required",
    frequency: "四半期",
    limitations: `${def.limitations.join(" ")}${isFlow ? "" : STOCK_LIMITATIONS}${COMMON_LIMITATIONS}`,
  };
}

export const BOJ_FLOW_OF_FUNDS_SPEC_INDICATORS: readonly IndicatorDefInput[] =
  BOJ_FLOW_OF_FUNDS_INDICATORS.map(toIndicatorDef);

// ---------------------------------------------------------------------------
// ファイル → 観測行 (純関数)
// ---------------------------------------------------------------------------

type Position = "資産" | "負債";

/** モジュールの区分文字列 (例 "家計(資産)") → 規約の区分 (例 "資産 / 家計") と並び順。 */
const CATEGORY_MAP: ReadonlyMap<string, { category: string; position: Position; sectorOrder: number }> = new Map(
  BOJ_SECTORS.flatMap((s, i) =>
    (["資産", "負債"] as const).map(
      (pos) => [`${s.label}(${pos})`, { category: `${pos} / ${s.label}`, position: pos, sectorOrder: i }] as const
    )
  )
);

const INDICATOR_BY_KEY: ReadonlyMap<string, { def: BojIndicatorDefinition; order: number }> = new Map(
  BOJ_FLOW_OF_FUNDS_INDICATORS.map((def, order) => [def.key, { def, order }])
);

function assertDocumentMatchesKey(doc: BojFlowOfFundsDocument, key: BatchKey, rawKey: string): void {
  for (const table of ["flow", "stock"] as const) {
    const p = doc[table].period;
    if (p.year !== key.year || p.quarter !== key.quarter) {
      throw new Error(
        `[boj-flow-of-funds] ファイルの${table === "flow" ? "フロー表" : "ストック表"}の期間 ` +
          `${periodLabel(p)} (${p.rawLabel}) がキー ${rawKey} と一致しません (上書き配布の取り違えの可能性)`
      );
    }
    if (p.vintage !== "preliminary") {
      throw new Error(
        `[boj-flow-of-funds] ファイルの${table === "flow" ? "フロー表" : "ストック表"}が速報ではありません ` +
          `(${p.rawLabel})。sjpre.xlsx は速報のはず — 配布形式が変わった可能性`
      );
    }
    assertUnit(doc[table].unit, `${table} 表`);
  }
}

export function bojFlowOfFundsToObservations(input: { key: string; files: readonly SpecFile[] }): ObservationDraft[] {
  const key = parseBojFlowOfFundsBatchKey(input.key);
  const unexpected = input.files.filter((f) => !XLSX_FILE_RE.test(f.filename)).map((f) => f.filename);
  if (unexpected.length > 0) {
    throw new Error(`[boj-flow-of-funds] 想定外のファイルがあります: ${unexpected.join(", ")}`);
  }
  const expectedName = bojSjpreFilename(key);
  const file = requireSpecFile(input.files, (f) => f === expectedName, `[boj-flow-of-funds] ${expectedName}`);
  const doc = parseBojFlowOfFunds(file.bytes);
  assertDocumentMatchesKey(doc, key, input.key);

  const flowRange = quarterRange(key.year, key.quarter);
  const label = periodLabel(key);
  const rows = toBojObservations(doc).map((o) => {
    const ind = INDICATOR_BY_KEY.get(o.indicatorKey);
    if (!ind) throw new Error(`[boj-flow-of-funds] 指標定義に無い指標キーです: ${o.indicatorKey}`);
    const cat = CATEGORY_MAP.get(o.category);
    if (!cat) throw new Error(`[boj-flow-of-funds] 想定外の区分です: ${o.category}`);
    assertUnit(o.unit, `${o.indicatorKey} ${o.category}`);
    const isFlow = ind.def.table === "flow";
    // 表は億円単位の整数。小数が来たら様式変更とみなす (円換算の丸め誤差も避ける)。
    if (!Number.isInteger(o.value)) {
      throw new Error(`[boj-flow-of-funds] 億円単位の整数でない値です: ${o.indicatorKey} ${o.category} ${o.value}`);
    }
    const value = o.value * OKU_YEN;
    if (!Number.isSafeInteger(value)) {
      throw new Error(`[boj-flow-of-funds] 円換算で精度を失います: ${o.indicatorKey} ${o.category} ${o.value} 億円`);
    }
    const draft: ObservationDraft = {
      period: label,
      periodStart: isFlow ? flowRange.start : flowRange.end,
      periodEnd: flowRange.end,
      indicatorKey: o.indicatorKey,
      category: cat.category,
      categoryKind: "投資部門",
      value,
      unit: "円",
      changeFromPrev: null,
      approximate: !isFlow,
      measureKind: "実測",
    };
    return { draft, sort: [ind.order, cat.position === "資産" ? 0 : 1, cat.sectorOrder] as const };
  });
  rows.sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1] || a.sort[2] - b.sort[2]);
  return rows.map((r) => r.draft);
}

// ---------------------------------------------------------------------------
// resolve / fetch
// ---------------------------------------------------------------------------

async function resolveBatchKey(): Promise<{ key: string; parts: BatchKey; url: string; periodHint: string }> {
  const resolved = await resolveLatestBojFlowOfFundsFile();
  if (resolved.announcedAt === null) {
    throw new Error(
      `[boj-flow-of-funds] index.htm から速報 Excel の掲載日を読めません (様式変更の可能性): ${BOJ_FLOW_OF_FUNDS_INDEX_URL}`
    );
  }
  if (resolved.periodLabelHint === null) {
    throw new Error(
      `[boj-flow-of-funds] index.htm から速報 Excel の公表対象期を読めません (様式変更の可能性): ${BOJ_FLOW_OF_FUNDS_INDEX_URL}`
    );
  }
  const m = PERIOD_HINT_RE.exec(resolved.periodLabelHint);
  if (!m) {
    throw new Error(
      `[boj-flow-of-funds] index.htm の公表対象期が想定の形 (速報（YYYY年第n四半期）) ではありません: ${resolved.periodLabelHint}`
    );
  }
  const parts: BatchKey = { year: Number(m[1]), quarter: Number(m[2]) as BojQuarter, announcedAt: resolved.announcedAt };
  return { key: bojFlowOfFundsBatchKey(parts), parts, url: resolved.url, periodHint: resolved.periodLabelHint };
}

async function fetchBatch(key: string, parts: BatchKey, expectedUrl: string, periodHint: string): Promise<FetchedBatch> {
  // モジュールの取得関数は index.htm を引き直してから Excel を取る (計 2 リクエスト)。
  const fetched = await fetchLatestBojFlowOfFunds();
  if (fetched.url !== expectedUrl) {
    throw new Error(`[boj-flow-of-funds] 速報 Excel の URL が resolve 時と違います: ${expectedUrl} → ${fetched.url}`);
  }
  if (fetched.announcedAt !== parts.announcedAt) {
    throw new Error(
      `[boj-flow-of-funds] resolve 後に index.htm の掲載日が変わりました (${parts.announcedAt} → ` +
        `${String(fetched.announcedAt)})。再実行してください`
    );
  }
  const files = [{ filename: bojSjpreFilename(parts), bytes: fetched.bytes, contentType: XLSX_CONTENT_TYPE }];
  // 本体の期間がキーと一致することをここで確かめる (一致しなければ保管前に throw)。
  const doc = parseBojFlowOfFunds(fetched.bytes);
  assertDocumentMatchesKey(doc, parts, key);
  return {
    key,
    source: fetched.url,
    metadata: {
      indexUrl: BOJ_FLOW_OF_FUNDS_INDEX_URL,
      url: fetched.url,
      announcedAt: fetched.announcedAt,
      periodLabelHint: periodHint,
      flowPeriodLabel: doc.flow.period.rawLabel,
      stockPeriodLabel: doc.stock.period.rawLabel,
      fetchedAt: fetched.fetchedAt,
      bytes: fetched.bytes.byteLength,
    },
    files,
  };
}

export const bojFlowOfFundsSpec: MoneyflowSourceSpec = {
  name: BOJ_FLOW_OF_FUNDS_SPEC_NAME,
  indicators: BOJ_FLOW_OF_FUNDS_SPEC_INDICATORS,
  async resolve() {
    const { key, parts, url, periodHint } = await resolveBatchKey();
    return { key, fetch: () => fetchBatch(key, parts, url, periodHint) };
  },
  toObservations: bojFlowOfFundsToObservations,
};
