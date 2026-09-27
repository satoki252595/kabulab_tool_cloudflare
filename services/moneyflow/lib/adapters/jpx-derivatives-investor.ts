/**
 * moneyflow 取得元アダプタ: JPX (大阪取引所) 先物・オプションの
 * 「投資部門別取引状況 (週間)」と「指数先物 取引参加者別建玉残高」
 * (`../sources/jpx-derivatives-investor.ts`) を Phase 1 の Notion 3 DB へつなぐ。
 *
 * ## spec (独立に公表される 2 ファイルを別々の spec にする)
 *   - `jpx-derivatives-investor-weekly` … 投資部門別取引状況 (週間) CSV
 *     (`Tousi_DV_W_<from>_<to>.csv`)。毎週第4営業日 (通常木曜) 15:30 に前週分を掲載
 *   - `jpx-derivatives-investor-futures-oi` … 指数先物 取引参加者別建玉残高 xlsx
 *     (`<YYYYMMDD>_indexfut_oi_by_tp.xlsx`)。基準日 (通常金曜) の翌週に年別 JSON 索引へ追加
 * 公表の索引 (一覧 HTML / 年別 JSON) もファイルも別なので 1 spec にまとめない。
 *
 * ## 冪等キー
 * `jpx-derivatives-investor-weekly-YYYY-Www` (最新週の最終日の ISO 週) と
 * `jpx-derivatives-investor-futures-oi-YYYY-Www` (建玉の基準日の ISO 週)。
 * 対象期間・基準日はどちらもファイルの中にあるので、`toObservations()` はファイルから
 * 読んだ期間がキーの週と一致することを検証するだけ (一致しなければ throw)。
 * 同じ週のファイルが差し替え (訂正) られても同じキーになり取り直さない (指標定義の「限界」に明記)。
 *
 * ## 1 バッチの中身 (行数の上限)
 * - weekly: 原資料は約 80 商品 × 11 投資部門 × 数量/代金 (実測 1,760 行) で、2 指標 × 2 単位に
 *   すると 3,520 行になり目安 (約 600 行) を大きく超える。**固定の 11 商品**
 *   ({@link JPX_DERIV_WEEKLY_PRODUCTS}) × 11 投資部門 × 4 指標 = **484 行** だけを記録する
 *   (データの大小で入れ替わる「上位 N」にはしない)。
 * - futures-oi: 3 商品 × 限月 × 売超/買超 × 上位 (実測で最大 15 位) の全行
 *   (上限の目安: 15 位 × 2 サイド × 限月数 × 3 商品)。
 *
 * ## 単位・区分・前期比
 * - 数量は「枚」、代金は原資料が円単位のため「円」のまま (換算係数 1)。建玉は「枚」
 * - 純売買・グロスは単位 (枚/円) ごとに別の指標キーにする (1 指標に枚と円を混ぜると、
 *   指標で絞り込んで合計したときに単位の違う値を足してしまうため)。キーは取得元モジュールの
 *   キー + `_volume` / `_value`
 * - weekly の区分は `商品 / 投資部門` (区分種別「投資部門」)
 * - futures-oi の区分は `商品 / 限月 / 売超n位または買超n位 / 取引参加者名`。区分種別は
 *   「商品」(観測ログの区分種別に「取引参加者」を表す値が無いため。指標定義の「限界」に明記)
 * - 前期比は原資料に前週の値が無いので null (計算で補わない)
 * - 近似フラグは全指標 true (先物の代金は想定元本で実際に動くお金ではない・ゼロサム・
 *   グロス・残高のいずれかで、「お金の流れ」そのものではないため)。実測推定は「実測」
 *
 * ## 取得回数 (JPX は高頻度の自動取得を控えるよう求めている)
 * - weekly: `resolve()` は一覧 HTML を 1 回。未保管の週なら `fetch()` が
 *   `fetchLatestInvestorTypeCsvData()` で一覧 HTML をもう 1 回 + CSV を 1 回取る
 *   (取得元モジュールに「リンクを指定して CSV だけ取る」関数が無いため)
 * - futures-oi: 取得元モジュールに「索引 JSON だけ読んで最新基準日を返す」関数が無いため、
 *   `resolve()` で `fetchLatestIndexFuturesOiFile()` (年一覧 JSON + 週一覧 JSON + xlsx の 3 回。解析はしない) を
 *   呼び、`fetch()` はそのバイト列を返す (二重に取りに行かない)。解析は保管後の `toObservations()` で行う
 */
import {
  INDICATOR_DEFINITIONS,
  INDICATOR_FUTURES_OI_KEY,
  INDICATOR_GROSS_TURNOVER_KEY,
  INDICATOR_NET_BALANCE_KEY,
  JPX_DERIV_INVESTOR_NAMES,
  JPX_DERIV_PRODUCT_NAMES,
  extractInvestorTypeCsvLinks,
  fetchInvestorTypeIndexHtml,
  fetchLatestIndexFuturesOiFile,
  fetchLatestInvestorTypeCsvData,
  investorTypeCsvArchiveInput,
  parseIndexFuturesOiWorkbook,
  parseInvestorTypeCsv,
  type FuturesOiRow,
  type InvestorTypeRow,
  type MoneyflowIndicatorDefinition as JpxDerivModuleIndicatorDef,
  type MoneyflowPrimaryFile as JpxDerivModulePrimaryFile,
} from "../sources/jpx-derivatives-investor.js";
import type { IndicatorDefInput, PrimaryFile } from "../../../../src/shared/notion-archive/index.js";
import { isoWeekLabelOf, isoWeekToDateRange } from "../iso-week.js";
import {
  requireSpecFile,
  type FetchedBatch,
  type MoneyflowSourceSpec,
  type ObservationDraft,
  type SpecFile,
} from "../source-spec.js";

export const JPX_DERIV_WEEKLY_SPEC_NAME = "jpx-derivatives-investor-weekly";
export const JPX_DERIV_FUTURES_OI_SPEC_NAME = "jpx-derivatives-investor-futures-oi";

/**
 * 更新停止の検知: 最新の週 (投資部門別は対象週の最終日、建玉は基準日) が実行日 (JST) の
 * N 日より前なら throw する。通常は最終日/基準日の 6〜7 日後に公表され、次の公表直前でも
 * 約 13 日。大型連休・年末年始で数日遅れても 20 日前後なので、1 回分の公表遅れも許して 35 日。
 */
export const JPX_DERIV_MAX_AGE_DAYS = 35;

/**
 * weekly spec で記録する商品 (帳票種別コード → 取得元モジュールの商品名)。**固定規則**。
 * 日本の株価指数先物 (日経225 系 3 商品・TOPIX 系 2 商品)、日経225オプション (プット/コール)、
 * 国債先物、REIT 指数先物、金・原油の代表的な商品先物。並び順 = 出力順。
 * 商品名は区分ラベルになるため、取得元モジュールの名称と一致することを毎回検証する
 * (名称が変わると区分が黙って別系列になるため)。
 */
export const JPX_DERIV_WEEKLY_PRODUCTS: ReadonlyArray<readonly [code: string, name: string]> = [
  ["301", "日経225先物"],
  ["313", "日経225mini"],
  ["331", "日経225マイクロ先物"],
  ["314", "TOPIX先物"],
  ["316", "ミニTOPIX先物"],
  ["303", "日経225オプションプット"],
  ["304", "日経225オプションコール"],
  ["317", "長期国債先物"],
  ["329", "東証REIT指数先物"],
  ["400", "金標準先物"],
  ["419", "プラッツドバイ原油先物"],
];

/**
 * 投資部門 (投資部門コード → 取得元モジュールの投資部門名)。並び順 = 出力順。
 * 原資料の全 11 区分。ここに無いコードの行が来たら (区分の追加) 黙って捨てず throw する。
 */
export const JPX_DERIV_WEEKLY_INVESTORS: ReadonlyArray<readonly [code: string, name: string]> = [
  ["11", "自己"],
  ["21", "生保・損保"],
  ["22", "都銀・地銀等"],
  ["23", "信託銀行"],
  ["24", "その他金融機関"],
  ["31", "投資信託"],
  ["32", "事業法人"],
  ["33", "その他法人等"],
  ["41", "証券会社"],
  ["51", "個人"],
  ["60", "海外投資家"],
];

/** futures-oi spec の対象商品 (xlsx の ＜…＞ 見出しの中身)。並び順 = 出力順。3 商品すべてがある前提。 */
export const JPX_DERIV_FUTURES_OI_PRODUCTS: readonly string[] = ["日経225先物", "日経225mini", "TOPIX先物"];

export const JPX_DERIV_NET_VOLUME_KEY = `${INDICATOR_NET_BALANCE_KEY}_volume`;
export const JPX_DERIV_NET_VALUE_KEY = `${INDICATOR_NET_BALANCE_KEY}_value`;
export const JPX_DERIV_GROSS_VOLUME_KEY = `${INDICATOR_GROSS_TURNOVER_KEY}_volume`;
export const JPX_DERIV_GROSS_VALUE_KEY = `${INDICATOR_GROSS_TURNOVER_KEY}_value`;
export const JPX_DERIV_FUTURES_OI_KEY = INDICATOR_FUTURES_OI_KEY;

const CSV_CONTENT_TYPE = "text/csv";
const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DAY_MS = 86_400_000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
/** 取得元モジュールの `investorTypeCsvArchiveInput()` が付けるファイル名 (日付は対象週の最終日)。 */
const WEEKLY_CSV_FILENAME_RE = /^jpx-deriv-investor-(\d{4}-\d{2}-\d{2})\.csv$/;
/**
 * 建玉 xlsx の保管ファイル名 (日付は索引の TradeDate)。取得元モジュールの `indexFuturesOiArchiveInput()` と
 * 同じ命名にしている (このアダプタは解析前に保管するためビルダーは使わない — resolve() 参照)。
 */
const OI_XLSX_FILENAME_RE = /^jpx-futures-oi-indexfut-(\d{4}-\d{2}-\d{2})\.xlsx$/;

// ---------------------------------------------------------------------------
// 指標定義 (取得元モジュールの定義文・限界・利用条件を引き継ぎ、単位換算後の説明と取込の限界を足す)
// ---------------------------------------------------------------------------

function moduleDefinition(key: string): JpxDerivModuleIndicatorDef {
  const hits = INDICATOR_DEFINITIONS.filter((d) => d.key === key);
  if (hits.length !== 1) {
    throw new Error(`[jpx-derivatives-investor] 取得元モジュールの指標定義 ${key} が ${hits.length} 件です (1 件であるべき)`);
  }
  return hits[0] as JpxDerivModuleIndicatorDef;
}

const NET_DEF = moduleDefinition(INDICATOR_NET_BALANCE_KEY);
const GROSS_DEF = moduleDefinition(INDICATOR_GROSS_TURNOVER_KEY);
const OI_DEF = moduleDefinition(INDICATOR_FUTURES_OI_KEY);

function moduleText(def: JpxDerivModuleIndicatorDef): { definition: string; limitations: string } {
  return {
    definition: `取得元の定義: ${def.definition}`,
    limitations: `${def.limitations.join("")}利用条件: ${def.usageTerms}`,
  };
}

const WEEKLY_PRODUCT_LIST = JPX_DERIV_WEEKLY_PRODUCTS.map(([, name]) => name).join("・");

const WEEKLY_PERIOD_TEXT =
  "対象期間は1週間の取引日(原則 月曜〜金曜。実際の集計期間は期間開始・期間終了の日付を見る)。" +
  "区分は「商品 / 投資部門」。投資部門は投資家の種類で、海外投資家・個人・投資信託・事業法人・" +
  "各種金融機関と、「自己」(証券会社などの取引参加者が自分のお金で行う売買) など11区分。";

const WEEKLY_LIMITATIONS =
  `原資料には約80商品が載るが、1回に書ける行数の上限のため、記録するのは次の${JPX_DERIV_WEEKLY_PRODUCTS.length}商品に固定している: ` +
  `${WEEKLY_PRODUCT_LIST}。それ以外の商品(為替先物・電力先物・有価証券オプション・国債先物オプション等)は取り込まない。` +
  "取引が無かった投資部門は0として記録される(原資料に0と書かれているため)。" +
  "期間ラベル(YYYY-Www)は対象週の最終日が属するISO週(月曜始まり)。" +
  "公表は毎週第4営業日(通常は木曜日。祝日などがあればその分後ろ倒し)の午後3時30分に前の週の分(JPX一覧ページの記載)。" +
  "JPXは過去に訂正を掲載したことがあるが、同じ週のファイルが差し替えられても同じキーのため自動では取り直さない。" +
  "2026年4月23日掲載分から様式とファイル名(Tousi_DV_W_開始日_終了日.csv)が変わっている。" +
  "今後また様式が変わると、列数・未知のコード・差引の符号の検査で取込が失敗して止まる(黙って読み違えない)。" +
  `一覧ページの最新週の最終日が実行日(日本時間)の${JPX_DERIV_MAX_AGE_DAYS}日より前のままなら、更新停止やURL変更を疑って取込を失敗させる。`;

const ZERO_SUM_TEXT =
  "先物・オプションは買い手と売り手が必ず同じ枚数だけいる取引なので、全投資部門の純売買を足すとほぼゼロになる。" +
  "この値は市場にお金が流れ込んだ量ではなく、どの投資部門が買い側・売り側に回ったか(投資部門の間の向き)を表す。";

const VALUE_MEANING_TEXT =
  "先物の代金は「約定価格×取引単位×枚数」で計算した取引の元本の大きさ(想定元本)で、その額のお金が実際に" +
  "支払われるわけではない(先物で実際にやり取りされるのは証拠金と日々の損益)。" +
  "オプションの代金はオプション料(プレミアム)の受け払い額で、先物の代金とは意味が違うため、商品をまたいで代金を足したり比べたりしない。";

function netVolumeIndicator(): IndicatorDefInput {
  const m = moduleText(NET_DEF);
  return {
    key: JPX_DERIV_NET_VOLUME_KEY,
    displayName: "先物・オプション 投資部門別 純売買(数量・枚)",
    requirement: "R3",
    flowType: "純買い越し",
    description:
      "先物・オプションの商品ごとに、投資部門が1週間に買った枚数から売った枚数を引いた値(純売買。その週の流れ=フローで、" +
      "持ち高の残高=ストックではない)。プラスは買い越し(買いが売りより多い)、マイナスは売り越し。" +
      "単位は枚(取引の単位の数。1枚の大きさは商品ごとに違うので、商品をまたいで枚数を比べない)。" +
      "例: 「日経225先物 / 海外投資家」が +8,343 なら、その週に海外投資家が日経225先物を差し引き8,343枚買い越した。" +
      ZERO_SUM_TEXT +
      WEEKLY_PERIOD_TEXT +
      m.definition,
    sourceUrl: NET_DEF.sourceUrl,
    license: "personal-only",
    frequency: "週次",
    limitations: `${WEEKLY_LIMITATIONS}${m.limitations}`,
  };
}

function netValueIndicator(): IndicatorDefInput {
  const m = moduleText(NET_DEF);
  return {
    key: JPX_DERIV_NET_VALUE_KEY,
    displayName: "先物・オプション 投資部門別 純売買(代金・円)",
    requirement: "R3",
    flowType: "純買い越し",
    description:
      "先物・オプションの商品ごとに、投資部門が1週間に買った代金から売った代金を引いた値(純売買。その週の流れ=フロー)。" +
      "プラスは買い越し、マイナスは売り越し。単位は円(原資料が円単位のため換算なし)。" +
      "例: 「日経225先物 / 個人」が +48,281,984,900 なら、その週に個人が日経225先物を代金で差し引き約483億円分買い越した。" +
      VALUE_MEANING_TEXT +
      ZERO_SUM_TEXT +
      WEEKLY_PERIOD_TEXT +
      m.definition,
    sourceUrl: NET_DEF.sourceUrl,
    license: "personal-only",
    frequency: "週次",
    limitations: `${WEEKLY_LIMITATIONS}${m.limitations}`,
  };
}

function grossVolumeIndicator(): IndicatorDefInput {
  const m = moduleText(GROSS_DEF);
  return {
    key: JPX_DERIV_GROSS_VOLUME_KEY,
    displayName: "先物・オプション 投資部門別 売買高(グロス・枚)",
    requirement: "R3",
    flowType: "売買代金",
    description:
      "先物・オプションの商品ごとに、投資部門が1週間に売った枚数と買った枚数を足した値(グロスの売買高。その週の流れ=フロー)。" +
      "どの投資部門がどれだけ活発に取引したかの目安で、買い越し・売り越しの向きは表さない(向きは純売買の指標を見る)。" +
      "単位は枚(1枚の大きさは商品ごとに違うので、商品をまたいで枚数を比べない)。" +
      "例: 「日経225先物 / 海外投資家」が 710,811 なら、その週に海外投資家が日経225先物を売り買い合わせて710,811枚取引した。" +
      "売り側と買い側の両方で数えるため、全投資部門を足すと市場全体の取引高のおよそ2倍になる。" +
      WEEKLY_PERIOD_TEXT +
      m.definition,
    sourceUrl: GROSS_DEF.sourceUrl,
    license: "personal-only",
    frequency: "週次",
    limitations: `${WEEKLY_LIMITATIONS}${m.limitations}`,
  };
}

function grossValueIndicator(): IndicatorDefInput {
  const m = moduleText(GROSS_DEF);
  return {
    key: JPX_DERIV_GROSS_VALUE_KEY,
    displayName: "先物・オプション 投資部門別 売買代金(グロス・円)",
    requirement: "R3",
    flowType: "売買代金",
    description:
      "先物・オプションの商品ごとに、投資部門が1週間に売った代金と買った代金を足した値(グロスの売買代金。その週の流れ=フロー)。" +
      "取引の規模の目安で、買い越し・売り越しの向きは表さない(向きは純売買の指標を見る)。単位は円(原資料が円単位のため換算なし)。" +
      VALUE_MEANING_TEXT +
      "売り側と買い側の両方で数えるため、全投資部門を足すと市場全体の売買代金のおよそ2倍になる。" +
      WEEKLY_PERIOD_TEXT +
      m.definition,
    sourceUrl: GROSS_DEF.sourceUrl,
    license: "personal-only",
    frequency: "週次",
    limitations: `${WEEKLY_LIMITATIONS}${m.limitations}`,
  };
}

function futuresOiIndicator(): IndicatorDefInput {
  const m = moduleText(OI_DEF);
  return {
    key: JPX_DERIV_FUTURES_OI_KEY,
    displayName: "指数先物 取引参加者別 建玉の売超・買超(上位ランキング・枚)",
    requirement: "R3",
    flowType: "建玉",
    description:
      "日経225先物・日経225mini・TOPIX先物の限月(決済の月)ごとに、証券会社などの取引参加者の建玉(まだ決済していない" +
      "先物の持ち高)を売りと買いで差し引き、売り越し(売超)・買い越し(買超)が大きい順に並べた上位ランキングの枚数。" +
      "基準日(通常は金曜日)時点の残高(ストック)で、その週に動いた量(フロー)ではない。" +
      "売超は売建玉が買建玉を上回る枚数、買超は買建玉が売建玉を上回る枚数で、どちらも正の数で記録する" +
      "(売超だからマイナスになるわけではない。売り・買いそれぞれの建玉の総数でもない)。" +
      "区分は「商品 / 限月 / 売超n位または買超n位 / 取引参加者名」。" +
      "例: 「日経225先物 / 2026-12限月 / 買超1位 / 野村証券」が 33,866 なら、基準日時点で野村証券" +
      "(自己の売買と顧客の注文の合算)の買建玉が売建玉を33,866枚上回り、その差が参加者の中で最も大きかった。単位は枚。" +
      m.definition,
    sourceUrl: OI_DEF.sourceUrl,
    license: "personal-only",
    frequency: "週次",
    limitations:
      "区分種別は「商品」にしている(観測ログの区分種別に取引参加者を表す値が無いため。区分の最後の要素が取引参加者名)。" +
      "順位は週ごとに入れ替わるので、同じ参加者の推移を見るときは区分の参加者名で絞り込む。" +
      "期間ラベル(YYYY-Www)は基準日が属するISO週で、残高のため期間開始・期間終了はどちらも基準日。" +
      "公表は基準日の翌週(実測: 2026年9月18日現在の分が2026年9月24日15時31分に索引へ追加)。" +
      "同じ基準日のファイルが差し替えられても同じキーのため自動では取り直さない。" +
      `索引の最新の基準日が実行日(日本時間)の${JPX_DERIV_MAX_AGE_DAYS}日より前のままなら、更新停止やURL変更を疑って取込を失敗させる。` +
      `xlsxに${JPX_DERIV_FUTURES_OI_PRODUCTS.join("・")}以外の商品見出しが現れた、またはこの3商品のどれかが無い場合は、様式変更を疑って取込を失敗させる。` +
      m.limitations,
  };
}

export const JPX_DERIV_WEEKLY_INDICATORS: readonly IndicatorDefInput[] = [
  netVolumeIndicator(),
  netValueIndicator(),
  grossVolumeIndicator(),
  grossValueIndicator(),
];
export const JPX_DERIV_FUTURES_OI_INDICATORS: readonly IndicatorDefInput[] = [futuresOiIndicator()];

// ---------------------------------------------------------------------------
// 日付・キーのユーティリティ (純関数)
// ---------------------------------------------------------------------------

function utcDateOf(iso: string, context: string): Date {
  const d = new Date(`${iso}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== iso) {
    throw new Error(`${context}: 日付が YYYY-MM-DD ではありません: ${JSON.stringify(iso)}`);
  }
  return d;
}

/** 日付 (YYYY-MM-DD) が属する ISO 週 (`YYYY-Www`)。 */
export function jpxDerivWeekLabel(iso: string): string {
  return isoWeekLabelOf(utcDateOf(iso, "[jpx-derivatives-investor]"));
}

/** spec 名 + 週ラベルの冪等キー。 */
export function jpxDerivBatchKey(specName: string, periodEndIso: string): string {
  return `${specName}-${jpxDerivWeekLabel(periodEndIso)}`;
}

/**
 * キーから週ラベルを取り出す。
 * @throws spec 名で始まらない・週ラベルが `YYYY-Www` でない・実在しない週の場合
 */
function weekOfKey(specName: string, key: string): string {
  const prefix = `${specName}-`;
  const week = key.startsWith(prefix) ? key.slice(prefix.length) : "";
  if (!/^\d{4}-W\d{2}$/.test(week)) {
    throw new Error(`[${specName}] 冪等キーの形式が不正です (期待 ${prefix}YYYY-Www): ${JSON.stringify(key)}`);
  }
  isoWeekToDateRange(week); // 実在しない週 (例: 53 週の無い年の W53) なら throw
  return week;
}

/**
 * 最新の週 (対象週の最終日・建玉の基準日) の鮮度を検証する。
 * @throws 実行日 (JST) より後 (索引か時計の異常)、または実行日の {@link JPX_DERIV_MAX_AGE_DAYS} 日より前の場合
 */
export function assertJpxDerivFresh(specName: string, latestIso: string, now: Date): void {
  const t = now.getTime();
  if (!Number.isFinite(t)) throw new Error(`[${specName}] 不正な実行日時です: ${String(now)}`);
  const today = new Date(t + JST_OFFSET_MS).toISOString().slice(0, 10);
  const latest = utcDateOf(latestIso, `[${specName}]`);
  const ageDays = Math.round((utcDateOf(today, `[${specName}]`).getTime() - latest.getTime()) / DAY_MS);
  if (ageDays < 0) {
    throw new Error(`[${specName}] 最新の週 ${latestIso} が実行日 ${today} (JST) より後です (索引か時計の異常)`);
  }
  if (ageDays > JPX_DERIV_MAX_AGE_DAYS) {
    throw new Error(
      `[${specName}] 最新の週 ${latestIso} が実行日 ${today} (JST) の ${ageDays} 日前のままです ` +
        `(上限 ${JPX_DERIV_MAX_AGE_DAYS} 日)。更新停止・URL/様式変更の可能性があります`
    );
  }
}

function toPrimaryFiles(files: readonly JpxDerivModulePrimaryFile[]): PrimaryFile[] {
  return files.map((f) => ({ filename: f.filename, bytes: f.bytes, contentType: f.contentType }));
}

// ---------------------------------------------------------------------------
// weekly: 投資部門別取引状況 (週間) CSV
// ---------------------------------------------------------------------------

/** 取得元モジュールの商品名・投資部門名が固定リストの区分ラベルと一致するか検証する。 */
function assertWeeklyLabelsMatchModule(): void {
  for (const [code, name] of JPX_DERIV_WEEKLY_PRODUCTS) {
    if (JPX_DERIV_PRODUCT_NAMES[code] !== name) {
      throw new Error(
        `[${JPX_DERIV_WEEKLY_SPEC_NAME}] 帳票種別 ${code} の名称が取得元モジュールでは ` +
          `${JSON.stringify(JPX_DERIV_PRODUCT_NAMES[code])} です (区分ラベル ${name} と不一致)`
      );
    }
  }
  const moduleInvestorCodes = Object.keys(JPX_DERIV_INVESTOR_NAMES).sort();
  const listedInvestorCodes = JPX_DERIV_WEEKLY_INVESTORS.map(([code]) => code).sort();
  if (moduleInvestorCodes.join(",") !== listedInvestorCodes.join(",")) {
    throw new Error(
      `[${JPX_DERIV_WEEKLY_SPEC_NAME}] 投資部門コードの一覧が取得元モジュールと違います ` +
        `(モジュール ${moduleInvestorCodes.join(",")} / アダプタ ${listedInvestorCodes.join(",")})`
    );
  }
  for (const [code, name] of JPX_DERIV_WEEKLY_INVESTORS) {
    if (JPX_DERIV_INVESTOR_NAMES[code] !== name) {
      throw new Error(
        `[${JPX_DERIV_WEEKLY_SPEC_NAME}] 投資部門 ${code} の名称が取得元モジュールでは ` +
          `${JSON.stringify(JPX_DERIV_INVESTOR_NAMES[code])} です (区分ラベル ${name} と不一致)`
      );
    }
  }
}

function decodeUtf8(bytes: Uint8Array, context: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (e) {
    throw new Error(`${context}: UTF-8 として解釈できません (文字コードの変更の可能性): ${String(e)}`, { cause: e });
  }
}

/**
 * 投資部門別取引状況 CSV (バイト列) とキーから観測行を作る (純関数)。
 * 出力順: 固定商品リストの順 → 投資部門の順 → [純売買(枚), 純売買(円), グロス(枚), グロス(円)]。
 *
 * @throws ファイルが 1 件でない、UTF-8 でない、様式が想定と違う (取得元モジュールが検知)、
 *   複数の週が混在・ファイル名の日付/キーの週と CSV 内の対象週が不一致、未知の投資部門、
 *   固定リストの商品×投資部門×数量/代金に欠落・重複がある場合
 */
export function jpxDerivWeeklyToObservations(input: { key: string; files: readonly SpecFile[] }): ObservationDraft[] {
  const ctx = `[${JPX_DERIV_WEEKLY_SPEC_NAME}]`;
  assertWeeklyLabelsMatchModule();
  const week = weekOfKey(JPX_DERIV_WEEKLY_SPEC_NAME, input.key);
  const file = requireSpecFile(input.files, (n) => WEEKLY_CSV_FILENAME_RE.test(n), `${ctx} 投資部門別取引状況 CSV`);
  const fileDate = (WEEKLY_CSV_FILENAME_RE.exec(file.filename) as RegExpExecArray)[1] as string;
  const rows = parseInvestorTypeCsv(decodeUtf8(file.bytes, `${ctx} ${file.filename}`));

  const first = rows[0];
  if (!first) throw new Error(`${ctx} CSV にデータ行がありません`);
  const other = rows.find((r) => r.periodFrom !== first.periodFrom || r.periodTo !== first.periodTo);
  if (other) {
    throw new Error(
      `${ctx} 1 ファイルに複数の対象週が混在しています (${first.periodFrom}〜${first.periodTo} と ${other.periodFrom}〜${other.periodTo})`
    );
  }
  if (first.periodTo !== fileDate) {
    throw new Error(`${ctx} ファイル名の日付 ${fileDate} と CSV 内の対象週の最終日 ${first.periodTo} が一致しません`);
  }
  const rowWeek = jpxDerivWeekLabel(first.periodTo);
  if (rowWeek !== week) {
    throw new Error(`${ctx} キーの週 ${week} と CSV 内の対象週 (${first.periodFrom}〜${first.periodTo} = ${rowWeek}) が一致しません`);
  }

  const investorCodes = new Set(JPX_DERIV_WEEKLY_INVESTORS.map(([code]) => code));
  const byKey = new Map<string, InvestorTypeRow>();
  for (const r of rows) {
    if (!investorCodes.has(r.investorCode)) {
      throw new Error(`${ctx} 未知の投資部門コード ${r.investorCode} (${r.investorName}) の行があります — 区分の追加の可能性`);
    }
    const k = `${r.productCode}|${r.investorCode}|${r.metric}`;
    if (byKey.has(k)) {
      throw new Error(`${ctx} 同じ商品・投資部門・数量金額区分の行が重複しています (${r.productName} / ${r.investorName} / ${r.metric})`);
    }
    byKey.set(k, r);
  }
  const need = (productCode: string, investorCode: string, metric: InvestorTypeRow["metric"]): InvestorTypeRow => {
    const r = byKey.get(`${productCode}|${investorCode}|${metric}`);
    if (!r) {
      throw new Error(
        `${ctx} 帳票種別 ${productCode} × 投資部門 ${investorCode} の${metric === "volume" ? "数量" : "代金"}の行がありません (欠落)`
      );
    }
    return r;
  };

  const base = { period: week, periodStart: first.periodFrom, periodEnd: first.periodTo, changeFromPrev: null } as const;
  const out: ObservationDraft[] = [];
  for (const [productCode, productName] of JPX_DERIV_WEEKLY_PRODUCTS) {
    for (const [investorCode, investorName] of JPX_DERIV_WEEKLY_INVESTORS) {
      const volume = need(productCode, investorCode, "volume");
      const value = need(productCode, investorCode, "value");
      const category = `${productName} / ${investorName}`;
      const common = { ...base, category, categoryKind: "投資部門", approximate: true, measureKind: "実測" } as const;
      out.push(
        { ...common, indicatorKey: JPX_DERIV_NET_VOLUME_KEY, value: volume.netBalance, unit: "枚" },
        { ...common, indicatorKey: JPX_DERIV_NET_VALUE_KEY, value: value.netBalance, unit: "円" },
        { ...common, indicatorKey: JPX_DERIV_GROSS_VOLUME_KEY, value: volume.total, unit: "枚" },
        { ...common, indicatorKey: JPX_DERIV_GROSS_VALUE_KEY, value: value.total, unit: "円" }
      );
    }
  }
  return out;
}

export const jpxDerivativesInvestorWeeklySpec: MoneyflowSourceSpec = {
  name: JPX_DERIV_WEEKLY_SPEC_NAME,
  indicators: JPX_DERIV_WEEKLY_INDICATORS,
  async resolve(now) {
    const links = extractInvestorTypeCsvLinks(await fetchInvestorTypeIndexHtml());
    const link = links[0];
    if (!link) throw new Error(`[${JPX_DERIV_WEEKLY_SPEC_NAME}] 一覧ページに CSV リンクがありません`);
    assertJpxDerivFresh(JPX_DERIV_WEEKLY_SPEC_NAME, link.periodTo, now);
    const key = jpxDerivBatchKey(JPX_DERIV_WEEKLY_SPEC_NAME, link.periodTo);
    return {
      key,
      async fetch(): Promise<FetchedBatch> {
        // 取得元モジュールに「リンクを指定して CSV だけ取る」関数が無いため、一覧をもう一度読んで
        // 最新週の CSV を取る。resolve 後に一覧が変わっていたら (新しい週の掲載等) 別のバッチなので止める。
        const data = await fetchLatestInvestorTypeCsvData();
        if (data.link.url !== link.url) {
          throw new Error(
            `[${JPX_DERIV_WEEKLY_SPEC_NAME}] resolve 後に一覧ページの最新 CSV が変わりました (${link.url} → ${data.link.url})。再実行してください`
          );
        }
        const archive = investorTypeCsvArchiveInput(data);
        for (const f of archive.files) {
          if (f.contentType !== CSV_CONTENT_TYPE || !WEEKLY_CSV_FILENAME_RE.test(f.filename)) {
            throw new Error(
              `[${JPX_DERIV_WEEKLY_SPEC_NAME}] 取得元モジュールが想定外のファイルを返しました: ${f.filename} (${f.contentType})`
            );
          }
        }
        return {
          key,
          source: archive.source,
          metadata: { ...archive.metadata, csvUrl: data.link.url, moduleArchiveKey: archive.key },
          files: toPrimaryFiles(archive.files),
        };
      },
    };
  },
  toObservations: jpxDerivWeeklyToObservations,
};

// ---------------------------------------------------------------------------
// futures-oi: 指数先物 取引参加者別建玉残高 xlsx
// ---------------------------------------------------------------------------

const OI_SIDE_LABEL: Readonly<Record<FuturesOiRow["side"], string>> = { net_short: "売超", net_long: "買超" };
const OI_SIDE_ORDER: Readonly<Record<FuturesOiRow["side"], number>> = { net_short: 0, net_long: 1 };

/**
 * 指数先物建玉残高 xlsx (バイト列) とキーから観測行を作る (純関数)。
 * 出力順: 商品 (固定順) → 限月の古い順 → 売超・買超 → 順位 → 参加者コード。
 *
 * @throws ファイルが 1 件でない、様式が想定と違う (取得元モジュールが検知)、ファイル名の日付/キーの週と
 *   シート内の基準日が不一致、想定外の商品見出しがある・3 商品のどれかが無い場合
 */
export function jpxDerivFuturesOiToObservations(input: { key: string; files: readonly SpecFile[] }): ObservationDraft[] {
  const ctx = `[${JPX_DERIV_FUTURES_OI_SPEC_NAME}]`;
  const week = weekOfKey(JPX_DERIV_FUTURES_OI_SPEC_NAME, input.key);
  const file = requireSpecFile(input.files, (n) => OI_XLSX_FILENAME_RE.test(n), `${ctx} 指数先物建玉残高 xlsx`);
  const fileDate = (OI_XLSX_FILENAME_RE.exec(file.filename) as RegExpExecArray)[1] as string;
  const data = parseIndexFuturesOiWorkbook(file.bytes);
  if (data.asOfDate !== fileDate) {
    throw new Error(`${ctx} ファイル名の日付 ${fileDate} とシート内の基準日 ${data.asOfDate} が一致しません`);
  }
  const asOfWeek = jpxDerivWeekLabel(data.asOfDate);
  if (asOfWeek !== week) {
    throw new Error(`${ctx} キーの週 ${week} とシート内の基準日 ${data.asOfDate} (= ${asOfWeek}) が一致しません`);
  }

  const productOrder = new Map(JPX_DERIV_FUTURES_OI_PRODUCTS.map((p, i) => [p, i] as const));
  const seenProducts = new Set<string>();
  for (const r of data.rows) {
    if (!productOrder.has(r.product)) {
      throw new Error(`${ctx} 想定外の商品見出し ＜${r.product}＞ があります — 様式変更・対象商品の追加の可能性`);
    }
    seenProducts.add(r.product);
  }
  const missing = JPX_DERIV_FUTURES_OI_PRODUCTS.filter((p) => !seenProducts.has(p));
  if (missing.length > 0) {
    throw new Error(`${ctx} 商品 ${missing.join("・")} の行がありません — 様式変更の可能性`);
  }

  const sorted = [...data.rows].sort(
    (a, b) =>
      (productOrder.get(a.product) as number) - (productOrder.get(b.product) as number) ||
      a.contractMonth.localeCompare(b.contractMonth) ||
      OI_SIDE_ORDER[a.side] - OI_SIDE_ORDER[b.side] ||
      a.rank - b.rank ||
      a.participantCode.localeCompare(b.participantCode)
  );
  return sorted.map((r) => ({
    period: week,
    periodStart: data.asOfDate,
    periodEnd: data.asOfDate,
    indicatorKey: JPX_DERIV_FUTURES_OI_KEY,
    category: `${r.product} / ${r.contractMonth}限月 / ${OI_SIDE_LABEL[r.side]}${r.rank}位 / ${r.participantName}`,
    categoryKind: "商品",
    value: r.openInterest,
    unit: "枚",
    changeFromPrev: null,
    approximate: true,
    measureKind: "実測",
  }));
}

export const jpxDerivativesInvestorFuturesOiSpec: MoneyflowSourceSpec = {
  name: JPX_DERIV_FUTURES_OI_SPEC_NAME,
  indicators: JPX_DERIV_FUTURES_OI_INDICATORS,
  async resolve(now) {
    // 取得元モジュールに索引 JSON だけを読む関数が無いため、xlsx 本体まで取得してキーを決める。
    // ここでは xlsx を **解析しない** (`fetchLatestIndexFuturesOiFile()` は取得だけ)。解析は
    // run-spec が一次データを実体保管した後の `toObservations()` で行う — 様式が変わった週でも
    // 原本を先に Notion へ残し (ルール6)、解析の失敗はその後に throw させるため
    // (`fetchLatestIndexFuturesOiData()` を使うと、様式変更の週は resolve で止まり原本が残らない)。
    // 索引の TradeDate とシート内の基準日の一致は、ファイル名の日付を介して toObservations が検証する。
    const latest = await fetchLatestIndexFuturesOiFile();
    assertJpxDerivFresh(JPX_DERIV_FUTURES_OI_SPEC_NAME, latest.tradeDate, now);
    const key = jpxDerivBatchKey(JPX_DERIV_FUTURES_OI_SPEC_NAME, latest.tradeDate);
    const filename = `jpx-futures-oi-indexfut-${latest.tradeDate}.xlsx`;
    if (!OI_XLSX_FILENAME_RE.test(filename)) {
      throw new Error(`[${JPX_DERIV_FUTURES_OI_SPEC_NAME}] 索引の TradeDate からファイル名を作れません: ${filename}`);
    }
    const batch: FetchedBatch = {
      key,
      source: latest.url,
      metadata: { tradeDate: latest.tradeDate, xlsxUrl: latest.url, bytes: latest.bytes.byteLength },
      files: [{ filename, bytes: latest.bytes, contentType: XLSX_CONTENT_TYPE }],
    };
    return { key, fetch: async () => batch };
  },
  toObservations: jpxDerivFuturesOiToObservations,
};

/** この取得元の spec 一覧 (`scripts/moneyflow/sources.ts` の SPEC_SOURCES へ登録する)。 */
export const JPX_DERIVATIVES_INVESTOR_SPECS: readonly MoneyflowSourceSpec[] = [
  jpxDerivativesInvestorWeeklySpec,
  jpxDerivativesInvestorFuturesOiSpec,
];
