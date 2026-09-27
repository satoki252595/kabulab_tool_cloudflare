/**
 * moneyflow 取得元アダプタ: JPX「投資部門別売買状況」の ETF / J-REIT 月次
 * (`../sources/jpx-investor-etf-reit.ts`) を Phase 1 の Notion 3 DB へつなぐ。
 *
 * ## spec (独立に公表される 2 ファイルを別々の spec にする)
 *   - `jpx-investor-etf-reit-etf`  … ETF   (一覧 investor-type/02.html → `etf_mYYMM.xls`)
 *   - `jpx-investor-etf-reit-reit` … J-REIT (一覧 investor-type/03.html → `reit_mYYMM.xls`)
 * 一覧ページもファイルも別で、片方だけ先に載ることもありうるため 1 spec にまとめない。
 *
 * ## 冪等キー
 * `<spec名>-YYYY-MM` (データの対象月)。対象月・集計期間 (例 8/3〜8/31) はファイル内の
 * 期間行にあるので、`toObservations()` はファイルから読んだ月がキーの月と一致することを
 * 検証するだけ (一致しなければ throw)。同じ月のファイルが訂正で差し替えられても
 * 同じキーになり取り直さない (指標定義の「限界」に明記)。
 *
 * ## 1 バッチの中身 (29 行 / spec)
 * 金額シート (Value) の 14 区分 (自己計・委託計・総計と委託・法人・金融機関の内訳) ×
 * 「買い越し額」「売買代金」の 2 指標 = 28 行 + 市場全体の総売買代金 1 行。
 * 区分は固定の 14 語 ({@link JPX_INVESTOR_ETF_REIT_CATEGORIES}) と完全一致を要求し、
 * 未知の区分・欠けた区分があれば throw する (黙って捨てない・黙って増やさない)。
 *
 * **口数シート (Volume) は取り込まない**: 観測ログの単位 (`MoneyflowUnit`) に ETF・REIT の
 * 数量単位「口」が無く、「株」と書くと別物の数量として誤読させるため。取得元モジュールの
 * `…-volume` 3 指標は指標定義にも載せない (各指標の「限界」に明記)。
 *
 * ## 単位・区分・フラグ
 * - 金額は原表の千円 → 円 (×1,000)
 * - 区分は JPX 原表の日本語名 (空白除去済み)。「総計」「市場全体」は区分種別「全体」、
 *   それ以外は「投資部門」
 * - 前期比は原表に前月の値が無いので null
 * - 近似フラグは全行 true (二次市場の投資家間の売買で ETF/REIT への新規資金流入そのもの
 *   ではない・集計対象が資本金30億円以上の取引参加者に限られる・グロスの売買代金は
 *   活発さの代理指標、のいずれか)。実測推定は「実測」
 *
 * ## 取得回数 (JPX は高頻度の自動取得を控えるよう求めている)
 * `resolve()` は一覧ページを 1 回。未保管の月なら `fetch()` が
 * `fetchLatestJpxInvestorWorkbook()` で一覧ページをもう 1 回 + ファイルを 1 回取る
 * (取得元モジュールに「解決済みリンクを指定してファイルだけ取る」関数が無いため)。
 * 月次なので未保管の月は月 1 回だけ。
 */
import {
  expectedJpxInvestorYearMonth,
  fetchJpxInvestorMonthLinks,
  fetchLatestJpxInvestorWorkbook,
  jpxInvestorIndicatorDefinitions,
  jpxInvestorListingUrl,
  latestJpxInvestorMonthLink,
  parseJpxInvestorWorkbook,
  type JpxInvestorCategoryRow,
  type JpxInvestorFlowType,
  type JpxInvestorIndicatorDefinition,
  type JpxInvestorProduct,
} from "../sources/jpx-investor-etf-reit.js";
import type {
  IndicatorDefInput,
  MoneyflowCategoryKind,
  MoneyflowFlowType,
} from "../../../../src/shared/notion-archive/index.js";
import {
  monthRange,
  requireSpecFile,
  type FetchedBatch,
  type MoneyflowSourceSpec,
  type ObservationDraft,
  type SpecFile,
} from "../source-spec.js";

export const JPX_INVESTOR_ETF_SPEC_NAME = "jpx-investor-etf-reit-etf";
export const JPX_INVESTOR_REIT_SPEC_NAME = "jpx-investor-etf-reit-reit";

const SPEC_NAME: Record<JpxInvestorProduct, string> = {
  etf: JPX_INVESTOR_ETF_SPEC_NAME,
  reit: JPX_INVESTOR_REIT_SPEC_NAME,
};

/** 原本のファイル名の接頭辞 (取得元モジュールの命名 `etf_mYYMM.xls[x]` と同じ)。 */
const FILE_PREFIX: Record<JpxInvestorProduct, string> = {
  etf: "etf_m",
  reit: "reit_m",
};

const PRODUCT_LABEL: Record<JpxInvestorProduct, string> = {
  etf: "ETF",
  reit: "J-REIT",
};

/**
 * 取引所の売買 (流通市場) の外でお金が入る経路。ETF は追加型の投資信託なので
 * 指定参加者を通じた「設定」で口数が増えるが、J-REIT は投資法人でクローズドエンド型の
 * ため「設定」は無く、口数が増えるのは公募増資などの新投資口の発行に限られる。
 * 商品ごとに書き分けないと、存在しない仕組みを初心者に教えてしまう (ルール7)。
 */
const PRIMARY_INFLOW: Record<JpxInvestorProduct, string> = {
  etf: "証券会社など指定参加者を通じた新しい口数の設定",
  reit: "公募増資などによる新しい投資口の発行。J-REITには投資信託のような設定・解約の仕組みは無い",
};

/**
 * 更新停止の検知: 一覧ページの最新月が「実行月 (JST) の前月」からさらに
 * この月数より前なら throw する。公表は毎月第8営業日 (翌月上中旬) なので、
 * 月初〜中旬は前々月分が最新なのが正常 (遅れ 1 か月まで許す)。それ以上は
 * 様式変更 (2026年10月13日掲載分からの新様式でリンク名が変わった等) を疑う。
 */
export const JPX_INVESTOR_MAX_LAG_MONTHS = 1;

const THOUSAND = 1_000;

// ---------------------------------------------------------------------------
// 区分 (固定。原表の出現順)
// ---------------------------------------------------------------------------

interface CategoryInfo {
  label: string;
  kind: MoneyflowCategoryKind;
}

/** 金額シートの投資部門区分 (原表の出現順 = 出力順)。これ以外の区分は throw。 */
export const JPX_INVESTOR_ETF_REIT_CATEGORIES: readonly CategoryInfo[] = [
  { label: "自己計", kind: "投資部門" },
  { label: "委託計", kind: "投資部門" },
  { label: "総計", kind: "全体" },
  { label: "法人", kind: "投資部門" },
  { label: "個人", kind: "投資部門" },
  { label: "海外投資家", kind: "投資部門" },
  { label: "証券会社", kind: "投資部門" },
  { label: "投資信託", kind: "投資部門" },
  { label: "事業法人", kind: "投資部門" },
  { label: "その他法人等", kind: "投資部門" },
  { label: "金融機関", kind: "投資部門" },
  { label: "生保・損保", kind: "投資部門" },
  { label: "銀行", kind: "投資部門" },
  { label: "その他金融機関", kind: "投資部門" },
];

const MARKET_CATEGORY: CategoryInfo = { label: "市場全体", kind: "全体" };

// ---------------------------------------------------------------------------
// 指標定義
// ---------------------------------------------------------------------------

/** 取得元モジュールの指標のうち、観測ログへ書くもの (金額ベース 3 指標)。 */
type EmittedModuleKind = "investor-net-flow-value" | "investor-turnover-value" | "market-turnover-value";
const EMITTED_KINDS: readonly EmittedModuleKind[] = [
  "investor-net-flow-value",
  "investor-turnover-value",
  "market-turnover-value",
];
/** 口数ベースで取り込まない 3 指標 (観測ログに「口」の単位が無いため)。 */
const SKIPPED_KINDS = ["investor-net-flow-volume", "investor-turnover-volume", "market-turnover-volume"] as const;

const FLOW_TYPE: Record<JpxInvestorFlowType, MoneyflowFlowType> = {
  net_flow: "純買い越し",
  gross_turnover: "売買代金",
};

function moduleKey(product: JpxInvestorProduct, kind: string): string {
  return `jpx-${product}-${kind}`;
}

/** 取得元モジュールのキー (kebab-case) を観測ログの指標キー (snake_case) にする。 */
export function jpxInvestorEtfReitIndicatorKey(product: JpxInvestorProduct, kind: EmittedModuleKind): string {
  return moduleKey(product, kind).replace(/-/g, "_");
}

function description(product: JpxInvestorProduct, kind: EmittedModuleKind): string {
  const label = PRODUCT_LABEL[product];
  const unitNote = "単位は円 (原表の千円を×1,000で換算)。";
  switch (kind) {
    case "investor-net-flow-value":
      return (
        `投資家のタイプ (海外投資家・個人・国内の法人など) ごとに、その月に東証で${label}を` +
        `買った金額から売った金額を引いた額 (1か月間の流れ=フロー)。プラスは買い越し` +
        `(その投資家層が差し引きで買った)、マイナスは売り越し。例: 海外投資家が4兆円買って` +
        `3兆9,000億円売れば +1,000億円。取引所の売買は必ず買い手と売り手が同額なので、` +
        `全員を合わせた買い越しは0になる (この統計の「総計」が0でないのは、集計対象が` +
        `資本金30億円以上の取引参加者に限られるため)。つまり投資家どうしの売り買いの結果で、` +
        `${label}に新しくお金が入った額 (${PRIMARY_INFLOW[product]}) ではない。区分は入れ子で、` +
        `総計=自己計+委託計、委託計=法人+個人+海外投資家+証券会社、` +
        `法人=投資信託+事業法人+その他法人等+金融機関、金融機関=生保・損保+銀行+その他金融機関` +
        ` (区分をまたいで足すと二重計上になる)。` +
        unitNote
      );
    case "investor-turnover-value":
      return (
        `投資家のタイプごとに、その月に東証で${label}を売った金額と買った金額を足した額` +
        ` (グロスの売買代金。1か月間の流れ=フロー)。取引の活発さの目安で、お金が流れ込んだ額ではない。` +
        `例: 1,000億円買って1,000億円売れば 2,000億円 (買い越しは0)。符号は常にプラス。` +
        `区分の入れ子は買い越し額と同じ。` +
        unitNote
      );
    case "market-turnover-value":
      return (
        `その月に東証の${label}市場全体で行われた売りの金額と買いの金額をすべて足した値` +
        ` (自己・委託、資本金30億円未満の取引参加者も含む。1か月間の流れ=フロー)。` +
        `1回の売買を売り手側と買い手側の両方で数えるので、ニュース等でいう「売買代金」` +
        `(1回の売買を1回と数える) のおよそ2倍の大きさになる。市場の活発さの目安で、` +
        `お金が流れ込んだ量ではない。投資部門別の「総計」の売買代金とは集計対象が違うため一致しない` +
        ` (2026年8月は本指標の方が約0.5%大きい)。` +
        unitNote
      );
  }
}

function adapterLimitations(product: JpxInvestorProduct): string {
  const prefix = FILE_PREFIX[product];
  return (
    "観測ログには金額シートの値だけを記録する。口数 (口) ベースの買い越し・売買高は、" +
    "観測ログの単位に「口」が無いため取り込んでいない (原本には存在し、一次データとして保管はされる)。" +
    "公表は毎月第8営業日頃 (前月分)。一覧ページの最新月が実行月の前々月より古いままなら、" +
    "更新停止・様式変更を疑って取込を失敗させる。" +
    `同じ月のファイル (${prefix}YYMM.xls、新様式は ${prefix}YYYYMM.xlsx) が訂正で差し替えられても、同じ月は取り直さない` +
    " (訂正は反映されない)。" +
    "買い付け・売り付けそれぞれの金額と構成比(%)は原本にあるが観測ログには記録しない。"
  );
}

function findModuleDef(
  defs: readonly JpxInvestorIndicatorDefinition[],
  product: JpxInvestorProduct,
  kind: string
): JpxInvestorIndicatorDefinition {
  const key = moduleKey(product, kind);
  const hits = defs.filter((d) => d.key === key);
  if (hits.length !== 1) {
    throw new Error(
      `[${SPEC_NAME[product]}] 取得元モジュールの指標定義 ${key} が ${hits.length} 件です (1 件であるべき)。` +
        `取得元モジュールの指標キーが変わった可能性があります`
    );
  }
  return hits[0] as JpxInvestorIndicatorDefinition;
}

/**
 * 取得元モジュールの指標定義 (表示名・種別・単位・出典・利用条件・頻度・限界) を
 * 観測ログ用の `IndicatorDefInput` に変換する。説明文は観測ログの単位 (円) に合わせて
 * アダプタで書く (モジュールの説明文は原表の千円を前提にしているため)。
 *
 * @throws モジュールの指標キー・単位・頻度・利用条件が想定と違う場合
 */
export function jpxInvestorEtfReitIndicators(product: JpxInvestorProduct): IndicatorDefInput[] {
  const defs = jpxInvestorIndicatorDefinitions(product);
  const known = new Set([...EMITTED_KINDS, ...SKIPPED_KINDS].map((k) => moduleKey(product, k)));
  const unknown = defs.filter((d) => !known.has(d.key)).map((d) => d.key);
  if (unknown.length > 0 || defs.length !== known.size) {
    throw new Error(
      `[${SPEC_NAME[product]}] 取得元モジュールの指標定義が想定と違います ` +
        `(想定外のキー: ${unknown.join(", ")} / 件数 ${defs.length}、想定 ${known.size})`
    );
  }
  const extra = adapterLimitations(product);
  return EMITTED_KINDS.map((kind) => {
    const def = findModuleDef(defs, product, kind);
    if (def.unit !== "thousand_yen") {
      throw new Error(`[${SPEC_NAME[product]}] ${def.key} の単位が千円ではありません (${def.unit})`);
    }
    if (def.frequency !== "monthly") {
      throw new Error(`[${SPEC_NAME[product]}] ${def.key} の頻度が月次ではありません (${def.frequency})`);
    }
    if (def.usageConditions !== "personal-only") {
      throw new Error(`[${SPEC_NAME[product]}] ${def.key} の利用条件が想定外です (${def.usageConditions})`);
    }
    return {
      key: jpxInvestorEtfReitIndicatorKey(product, kind),
      displayName: def.displayName,
      requirement: "R2",
      flowType: FLOW_TYPE[def.flowType],
      description: description(product, kind),
      sourceUrl: def.sourceUrl,
      license: "personal-only",
      frequency: "月次",
      limitations: `${def.limitations}${extra}${def.usageNote}`,
    };
  });
}

export const JPX_INVESTOR_ETF_INDICATORS: readonly IndicatorDefInput[] = jpxInvestorEtfReitIndicators("etf");
export const JPX_INVESTOR_REIT_INDICATORS: readonly IndicatorDefInput[] = jpxInvestorEtfReitIndicators("reit");

// ---------------------------------------------------------------------------
// キー・期間
// ---------------------------------------------------------------------------

const YM_RE = /^(\d{4})-(\d{2})$/;

function shiftMonth(yyyyMm: string, delta: number): string {
  const m = YM_RE.exec(yyyyMm);
  if (!m) throw new Error(`shiftMonth: YYYY-MM ではありません: ${yyyyMm}`);
  const index = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** 冪等キー `<spec名>-YYYY-MM`。 */
export function jpxInvestorEtfReitBatchKey(product: JpxInvestorProduct, yearMonth: string): string {
  monthRange(yearMonth); // 形式・月の範囲を検証
  return `${SPEC_NAME[product]}-${yearMonth}`;
}

function periodOfKey(product: JpxInvestorProduct, key: string): string {
  const spec = SPEC_NAME[product];
  const m = new RegExp(`^${spec}-(\\d{4}-\\d{2})$`).exec(key);
  if (!m || !m[1]) {
    throw new Error(`[${spec}] 冪等キーの形式が不正です (${spec}-YYYY-MM であるべき): ${key}`);
  }
  monthRange(m[1]);
  return m[1];
}

/**
 * 対象月 "YYYY-MM" の原本として受け付けるファイル名 (一覧ページのリンク先の実ファイル名)。
 * - 現行 (〜2026年8月分): 2 桁年+月 `etf_m2608.xls`
 * - 新様式 (2026年10月13日掲載分〜): JPX の先行サンプルが 4 桁年+月 `etf_mYYYYMM.xlsx`
 *   (取得元モジュールはリンク先の実ファイル名をそのまま返す)
 * 拡張子は .xls / .xlsx の両方を許す。これ以外 (別商品・別月) は受け付けない。
 */
export function jpxInvestorEtfReitFilenames(product: JpxInvestorProduct, yearMonth: string): readonly string[] {
  monthRange(yearMonth);
  const prefix = FILE_PREFIX[product];
  const yyyymm = yearMonth.replace("-", "");
  const stems = [`${prefix}${yyyymm.slice(2)}`, `${prefix}${yyyymm}`];
  return stems.flatMap((stem) => [`${stem}.xls`, `${stem}.xlsx`]);
}

/**
 * 一覧ページの最新月が新しすぎ/古すぎないかを確かめる。
 * @throws 最新月が実行月 (JST) の前月より後 (一覧・時計の異常)、または前月から
 *   {@link JPX_INVESTOR_MAX_LAG_MONTHS} か月より前 (更新停止・様式変更の疑い)
 */
export function assertJpxInvestorFresh(product: JpxInvestorProduct, latestYearMonth: string, now: Date): void {
  const spec = SPEC_NAME[product];
  const expected = expectedJpxInvestorYearMonth(now);
  if (latestYearMonth > expected) {
    throw new Error(
      `[${spec}] 一覧ページの最新月 ${latestYearMonth} が実行月 (JST) の前月 ${expected} より後です (一覧か時計の異常)`
    );
  }
  const oldest = shiftMonth(expected, -JPX_INVESTOR_MAX_LAG_MONTHS);
  if (latestYearMonth < oldest) {
    throw new Error(
      `[${spec}] 一覧ページの最新月が ${latestYearMonth} のままです (${oldest} 分以降が無い)。` +
        `JPX の更新停止か、様式変更 (2026年10月13日掲載分から新様式) でリンク名が変わった可能性があります ` +
        `(${jpxInvestorListingUrl(product)})`
    );
  }
}

// ---------------------------------------------------------------------------
// toObservations (純関数)
// ---------------------------------------------------------------------------

function thousandYenToYen(v: number, context: string): number {
  const yen = v * THOUSAND;
  if (!Number.isSafeInteger(yen)) {
    throw new Error(`${context}: 円換算の結果が安全な整数ではありません (${v} 千円)`);
  }
  return yen;
}

function toObservations(product: JpxInvestorProduct, key: string, files: readonly SpecFile[]): ObservationDraft[] {
  const spec = SPEC_NAME[product];
  const period = periodOfKey(product, key);
  const accepted = jpxInvestorEtfReitFilenames(product, period);
  const file = requireSpecFile(
    files,
    (n) => accepted.includes(n),
    `[${spec}] 投資部門別売買状況 (${accepted.join(" / ")})`
  );
  // parseJpxInvestorWorkbook の sourceUrl は戻り値に載せるだけで解析には使わない。
  // 純関数にするため、ファイルの取得 URL ではなく一覧ページの URL を渡す。
  const report = parseJpxInvestorWorkbook(file.bytes, product, jpxInvestorListingUrl(product));
  if (report.product !== product) {
    throw new Error(`[${spec}] 解析結果の商品 ${report.product} が ${product} ではありません`);
  }
  const sheet = report.value;
  if (report.yearMonth !== period || sheet.yearMonth !== period) {
    throw new Error(`[${spec}] キー ${key} の月 ${period} とファイルの対象月 ${sheet.yearMonth} が一致しません`);
  }
  if (sheet.unit !== "thousand_yen") {
    throw new Error(`[${spec}] 金額シートの単位が千円ではありません (${sheet.unit})`);
  }
  const month = monthRange(period);
  if (
    sheet.rangeStart < month.start ||
    sheet.rangeEnd > month.end ||
    sheet.rangeStart > sheet.rangeEnd
  ) {
    throw new Error(
      `[${spec}] 集計期間 ${sheet.rangeStart}〜${sheet.rangeEnd} が対象月 ${period} の範囲に収まっていません`
    );
  }

  const byLabel = new Map<string, JpxInvestorCategoryRow>();
  for (const c of sheet.categories) {
    if (byLabel.has(c.category)) throw new Error(`[${spec}] 区分「${c.category}」が重複しています`);
    byLabel.set(c.category, c);
  }
  const knownLabels = new Set(JPX_INVESTOR_ETF_REIT_CATEGORIES.map((c) => c.label));
  const unknown = [...byLabel.keys()].filter((l) => !knownLabels.has(l));
  if (unknown.length > 0) {
    throw new Error(
      `[${spec}] 未知の投資部門区分があります: ${unknown.join(", ")} ` +
        `(既知: ${[...knownLabels].join(", ")})。様式変更の可能性があります`
    );
  }
  const missing = [...knownLabels].filter((l) => !byLabel.has(l));
  if (missing.length > 0) {
    throw new Error(`[${spec}] 投資部門区分が欠けています: ${missing.join(", ")}。様式変更の可能性があります`);
  }

  const base = {
    period,
    periodStart: sheet.rangeStart,
    periodEnd: sheet.rangeEnd,
    changeFromPrev: null,
    approximate: true,
    measureKind: "実測",
    unit: "円",
  } as const;
  const netKey = jpxInvestorEtfReitIndicatorKey(product, "investor-net-flow-value");
  const turnoverKey = jpxInvestorEtfReitIndicatorKey(product, "investor-turnover-value");
  const marketKey = jpxInvestorEtfReitIndicatorKey(product, "market-turnover-value");

  const out: ObservationDraft[] = [];
  for (const [indicatorKey, pick] of [
    [netKey, (c: JpxInvestorCategoryRow) => c.balance],
    [turnoverKey, (c: JpxInvestorCategoryRow) => c.total],
  ] as const) {
    for (const info of JPX_INVESTOR_ETF_REIT_CATEGORIES) {
      const row = byLabel.get(info.label) as JpxInvestorCategoryRow;
      out.push({
        ...base,
        indicatorKey,
        category: info.label,
        categoryKind: info.kind,
        value: thousandYenToYen(pick(row), `[${spec}] ${indicatorKey} ${info.label}`),
      });
    }
  }
  // 最後の行 (取込完了の印) は市場全体の総売買代金。
  out.push({
    ...base,
    indicatorKey: marketKey,
    category: MARKET_CATEGORY.label,
    categoryKind: MARKET_CATEGORY.kind,
    value: thousandYenToYen(sheet.marketTotal, `[${spec}] ${marketKey}`),
  });
  return out;
}

// ---------------------------------------------------------------------------
// spec
// ---------------------------------------------------------------------------

function makeSpec(product: JpxInvestorProduct, indicators: readonly IndicatorDefInput[]): MoneyflowSourceSpec {
  const spec = SPEC_NAME[product];
  return {
    name: spec,
    indicators,
    async resolve(now) {
      const links = await fetchJpxInvestorMonthLinks(product);
      const latest = latestJpxInvestorMonthLink(links);
      assertJpxInvestorFresh(product, latest.yearMonth, now);
      const key = jpxInvestorEtfReitBatchKey(product, latest.yearMonth);
      return {
        key,
        async fetch(): Promise<FetchedBatch> {
          const wb = await fetchLatestJpxInvestorWorkbook(product);
          if (wb.product !== product) {
            throw new Error(`[${spec}] 取得元モジュールが別商品 (${wb.product}) のファイルを返しました`);
          }
          if (wb.yearMonth !== latest.yearMonth || wb.sourceUrl !== latest.href) {
            throw new Error(
              `[${spec}] resolve 後に一覧ページの最新ファイルが変わりました ` +
                `(${latest.yearMonth} ${latest.href} → ${wb.yearMonth} ${wb.sourceUrl})。再実行してください`
            );
          }
          // 新様式 (YYYYMM 命名) のファイル名もここで弾くと、recordPrimaryData() の前に
          // 失敗して原本が保管されない (様式変更時こそ原本を残したい — ルール6)。
          if (!jpxInvestorEtfReitFilenames(product, wb.yearMonth).includes(wb.filename)) {
            throw new Error(`[${spec}] 取得元モジュールが想定外のファイル名を返しました: ${wb.filename}`);
          }
          return {
            key,
            source: wb.sourceUrl,
            metadata: {
              listingUrl: jpxInvestorListingUrl(product),
              fileUrl: wb.sourceUrl,
              product,
              yearMonth: wb.yearMonth,
              filename: wb.filename,
              bytes: wb.bytes.byteLength,
              resolvedAt: now.toISOString(),
            },
            files: [{ bytes: wb.bytes, filename: wb.filename, contentType: wb.contentType }],
          };
        },
      };
    },
    toObservations({ key, files }) {
      return toObservations(product, key, files);
    },
  };
}

export const jpxInvestorEtfSpec: MoneyflowSourceSpec = makeSpec("etf", JPX_INVESTOR_ETF_INDICATORS);
export const jpxInvestorReitSpec: MoneyflowSourceSpec = makeSpec("reit", JPX_INVESTOR_REIT_INDICATORS);

/** `scripts/moneyflow/sources.ts` へ登録する spec 一覧。 */
export const JPX_INVESTOR_ETF_REIT_SPECS: readonly MoneyflowSourceSpec[] = [jpxInvestorEtfSpec, jpxInvestorReitSpec];
