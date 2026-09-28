/**
 * moneyflow 取得元アダプタ: 日本証券業協会 (JSDA) の「公社債発行額・償還額」
 * (`../sources/jsda-bonds.ts`) を Phase 1 の Notion 3 DB へつなぐ。
 *
 * spec は 1 つ (`jsda-bonds`)。取得元モジュールが扱うもう一方の統計
 * 「公社債投資家別売買高」は 2018 年 5 月取引分で公表体系が再編され終了している
 * (`investorTurnoverStatus()` が discontinued を返す) ため、観測行を作らない。
 *
 * 取得の流れ:
 *   - `resolve()` … 一覧ページ (hakkou/index.html、約 45KB) を 1 回取得し、最新ファイルの
 *     対象月と掲載日を読む。キーは `jsda-bonds-<対象月>-published-<掲載日>`
 *     (JSDA は過去月の訂正を行う (原資料に「訂正がありました」の凡例がある)。同じ対象月の
 *     まま差し替えられ掲載日が変わった場合も、別の版として取り直せるよう掲載日を含める)
 *   - `fetch()` … 本体 xlsx (固定 URL を毎月上書きする方式、約 430KB) を取得し、
 *     一覧ページの HTML と一緒に一次データとして保管する (掲載日の根拠を残す)
 *   - `toObservations()` … xlsx のバイト列とキーだけから観測行を作る純関数
 *
 * 1 バッチで記録するのは「キーの対象月までの直近 12 か月」(固定規則) ×
 * 公社債 10 区分 (9 種類 + 公社債合計) × 2 指標 = 240 行。直近 12 か月を毎回
 * 送り直すのは、初回取込で 1 年分の推移を持つためと、原資料が過去月を訂正した
 * 場合に upsert で訂正後の値へ更新するため。
 *
 * 単位: 原資料は百万円 (取得元モジュールがシートの単位表記を毎回読み、円に換算済み)。
 * 前期比: 原資料の各行は当月の発行額・償還額だけで、前月との差の列は無いため null。
 *
 * JSDA は Retry-After なしの 429 を長時間返すことがある。取得元モジュールの
 * `fetchFromJsda()` が 30/90/240 秒のバックオフ後も失敗したら throw し、次回の
 * スケジュール実行へ持ち越す (1 実行あたり一覧ページ 1 回 + 未保管時のみ xlsx 1 回)。
 */
import {
  JSDA_BONDS_INDICATORS,
  JSDA_HAKKOU_PAGE_URL,
  JSDA_UA,
  fetchFromJsda,
  issuanceRedemptionPublicationStatus,
  parseHakkouIndexHtml,
  parseIssuanceRedemptionWorkbook,
  type JsdaBondFlowRow,
  type JsdaIssuanceRedemptionLatest,
  type MoneyflowIndicatorDef as JsdaModuleIndicatorDef,
} from "../sources/jsda-bonds.js";
import type {
  IndicatorDefInput,
  MoneyflowCategoryKind,
} from "../../../../src/shared/notion-archive/index.js";
import {
  monthRange,
  requireSpecFile,
  type FetchedBatch,
  type MoneyflowSourceSpec,
  type ObservationDraft,
  type SpecFile,
} from "../source-spec.js";

export const JSDA_BONDS_SPEC_NAME = "jsda-bonds";

/** 1 バッチで記録する月数 (キーの対象月を含む直近 N か月)。固定規則。 */
export const JSDA_BONDS_WINDOW_MONTHS = 12;

/**
 * 更新停止の検知: 一覧ページの最新月が「実行月 (JST) − N か月」より前なら throw する。
 * 通常の掲載は対象月の翌々月上旬ごろ (実測: 2026 年 7 月分 → 2026-09-10 掲載) で、
 * 翌々月の掲載日前は最新月が 3 か月前になる (例: 9 月 5 日の実行で 6 月分)。
 * それより古いまま (例: 9 月の実行で 5 月分まで) なら、掲載の停止・一覧ページの
 * 様式変更 (旧リンクが残ったまま新しいリンクが別の書式になった等) を疑って失敗させる
 * (「取込済み」扱いのまま黙って古い値を見せ続けない — ルール2)。
 */
export const JSDA_BONDS_MAX_LAG_MONTHS = 3;

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const HTML_CONTENT_TYPE = "text/html; charset=utf-8";
const XLSX_ACCEPT =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,*/*";

// ---------------------------------------------------------------------------
// 区分 (公社債の種類)
// ---------------------------------------------------------------------------

interface CategoryInfo {
  label: string;
  kind: MoneyflowCategoryKind;
}

/**
 * xlsx のシート名 (取得元モジュールの `bondType`) → 観測ログの区分。並び順 = 出力順。
 * 区分名は各シート 1 行目の見出し (例 「３．政府保証債」「７．転換社債型新株予約権付社債」
 * 「９．円建非居住者債（合計）」) の日本語表記から番号・「（合計）」を除いたもの。
 * シート名の略称 (「政保債」「非居住者債」) より意味が正確なためこちらを使う。
 */
const BOND_TYPES: ReadonlyArray<readonly [string, CategoryInfo]> = [
  ["合計（Total）", { label: "公社債合計", kind: "全体" }],
  ["国債（JGB）", { label: "国債", kind: "資産クラス" }],
  ["地方債", { label: "地方債", kind: "資産クラス" }],
  ["政保債", { label: "政府保証債", kind: "資産クラス" }],
  ["財投機関債等", { label: "財投機関債等", kind: "資産クラス" }],
  ["普通社債", { label: "普通社債", kind: "資産クラス" }],
  ["資産担保型社債", { label: "資産担保型社債", kind: "資産クラス" }],
  ["転換社債（CB）", { label: "転換社債型新株予約権付社債", kind: "資産クラス" }],
  ["金融債", { label: "金融債", kind: "資産クラス" }],
  ["非居住者債", { label: "円建非居住者債", kind: "資産クラス" }],
];
const BOND_TYPE_MAP: ReadonlyMap<string, CategoryInfo> = new Map(BOND_TYPES);
/** 9 種類の合計が入っているシート (合計の整合検証に使う)。 */
const TOTAL_SHEET = "合計（Total）";

/**
 * シート名を観測ログの区分に変換する。
 * @throws 既知の 10 シート以外 (種類の追加・改称など様式変更) の場合
 */
export function jsdaBondCategoryInfo(sheetName: string): CategoryInfo {
  const info = BOND_TYPE_MAP.get(sheetName);
  if (!info) {
    throw new Error(
      `[${JSDA_BONDS_SPEC_NAME}] 未知の公社債種類 (シート名) です: ${JSON.stringify(sheetName)} ` +
        `(既知: ${[...BOND_TYPE_MAP.keys()].join(", ")})。様式変更の可能性があるため区分表を見直してください`
    );
  }
  return info;
}

// ---------------------------------------------------------------------------
// 指標定義
// ---------------------------------------------------------------------------

const JSDA_BONDS_COMMON_LIMITATIONS =
  "【取込の範囲】1回の取込で、一覧ページの最新月までの直近12か月分だけを記録する(それより前の" +
  "履歴は取り込まない)。原資料は過去月を訂正することがあり(原資料に「訂正がありました」の凡例がある)、" +
  "直近12か月内の訂正は次の月の取込で上書きされるが、12か月より前の訂正や、同じ対象月・同じ掲載日の" +
  "まま差し替えられた訂正は反映されない。" +
  "【対象】公社債合計は、公募公共債(国債・地方債・政府保証債・財投機関債等)、公募民間債(普通社債・" +
  "資産担保型社債・転換社債型新株予約権付社債)、金融債、円建非居住者債の9種類の合計(原資料の注記)。" +
  "銀行等引受債(旧・縁故地方債)は含まず、私募社債・私募特別債は2008年5月分で集計を取り止めており" +
  "含まない。国債は借換債と日本銀行応募等(日本銀行が応募・引き受けた分)を含み、承継国債・交付国債・" +
  "出資国債は含まない。普通社債は銀行社債・投資法人債券などのほか、デュアル・カレンシー債や外貨建ての" +
  "社債を含み、外貨建ての分は払込日の為替相場で円に換算されている(原資料の注記)。" +
  "財投機関債等は地方公社の債券を含む。" +
  "【数値】原資料は百万円単位(単位未満は四捨五入)のため、円に換算した値の下6桁は常に0。" +
  "取込時に、各月の9種類の合計が公社債合計と一致するか(2019年4月〜2026年7月の全月で一致を確認済み)と、" +
  "公社債合計が0でないか(原資料は未公表の将来月の行を0で先埋めしているシートがある)を検証し、" +
  "外れたら様式変更・未公表として取込を失敗させる。" +
  "【掲載時期】対象月の翌々月上旬ごろに掲載(実測: 2026年7月分 → 2026-09-10)。一覧ページの最新月が" +
  "実行月の4か月以上前のまま(例: 9月の実行で5月分まで)なら、更新停止を疑って取込を失敗させる。" +
  "原資料は固定URL(hakkougakushoukanngaku.xlsx)を毎月上書きする方式。" +
  "【取得】JSDAのサイトは短時間に繰り返しアクセスするとRetry-Afterなしの429(アクセス制限)を" +
  "長時間返すことがある。取得に失敗した日は無理に埋めず、次回の定期実行に持ち越す。" +
  "【利用条件】閲覧・ダウンロードは無料・ログイン不要だが、商用の二次利用の可否をJSDAのサイト上で" +
  "確認できていないため「要確認」とし、公開面へは出さない。" +
  "【関連統計】同じJSDAの「公社債投資家別売買高」は2018年5月取引分で公表体系が再編され終了しており、" +
  "投資家部門別の債券の売買(誰が買ったか)はこの取得元からは分からない。";

/**
 * 取得元モジュールの指標定義を取り出す (キーが無ければ throw — 定義の無い指標を
 * 観測ログへ書かない)。限界の文はモジュールの記述をそのまま引き継ぐ。
 */
function moduleDef(key: string): JsdaModuleIndicatorDef {
  const def = JSDA_BONDS_INDICATORS.find((d) => d.key === key);
  if (!def) {
    throw new Error(`[${JSDA_BONDS_SPEC_NAME}] 取得元モジュールに指標定義 ${key} がありません`);
  }
  return def;
}

const ISSUANCE_DEF = moduleDef("jsda_bond_issuance");
const REDEMPTION_DEF = moduleDef("jsda_bond_redemption");

export const JSDA_BONDS_SPEC_INDICATORS: readonly IndicatorDefInput[] = [
  {
    key: ISSUANCE_DEF.key,
    displayName: `${ISSUANCE_DEF.label} (公社債の種類別・月間)`,
    requirement: "R2",
    flowType: "売買代金",
    description:
      "その月に新しく発行された(払込みが行われた)公社債の金額の合計(1か月間の流れ=フロー)。" +
      "国・地方公共団体・企業などが債券を発行して投資家からお金を集めた量で、債券市場に新しく" +
      "供給された債券の量を表す。発行した額そのもの(グロス)であり、同じ月の償還(返済)を差し引いた" +
      "純額でも、投資家の買い越し/売り越しでもない。例: ある月に国債が14.5兆円発行され、同じ月に" +
      "8.0兆円が償還されれば、国債の残高はおよそ6.5兆円増える(発行額だけでは残高の増え方は分からない)。" +
      "国債の発行額には満期が来た国債を借り換えるための借換債も含まれるため、「新しい借金」だけの額でもない。" +
      "区分は公社債の種類(国債・地方債・政府保証債・財投機関債等・普通社債・資産担保型社債・" +
      "転換社債型新株予約権付社債・金融債・円建非居住者債)と、その9種類の合計(公社債合計)。" +
      "値は0以上(マイナスにならない)。単位は円(原資料の百万円を換算)。前期比は記録しない(null)。" +
      "「何を測るか」は区分上「売買代金」(向きを持たないグロスの量)に入れているが、取引所などで" +
      "既に発行された債券が売り買いされた代金ではなく、発行市場で新しく発行された額である。",
    sourceUrl: JSDA_HAKKOU_PAGE_URL,
    license: "要確認",
    frequency: "月次",
    limitations: `${ISSUANCE_DEF.limitations}${JSDA_BONDS_COMMON_LIMITATIONS}`,
  },
  {
    key: REDEMPTION_DEF.key,
    displayName: `${REDEMPTION_DEF.label} (公社債の種類別・月間)`,
    requirement: "R2",
    flowType: "売買代金",
    description:
      "その月に償還(発行体による返済)などで減った公社債の金額の合計(1か月間の流れ=フロー)。" +
      "満期の償還・定時償還(国債は繰上償還)・買入消却(発行体が市場で買い戻して消すこと)の合計(原資料の" +
      "合計(b)列)。原資料の注記により、買入消却の額には定時償還・買入消却以外の方法による一部償還も含まれる。" +
      "転換社債型新株予約権付社債では、株式への転換(新株予約権の行使)で消えた額(転換額)も含む。" +
      "円建非居住者債にも転換額の列があり合計に含まれるが、2019年4月分以降の原資料では常に0円で、" +
      "何への転換かは原資料に書かれていない。" +
      "そのため、必ずしも「満期が来て現金で返された額」だけではない(実データ例: 2026年7月分の" +
      "転換社債型新株予約権付社債は満期償還・定時償還・買入消却が全て0円で、償還額6億円の全額が株式への" +
      "転換によるものだった)。政府保証債の買入消却には国に承継されて減った額も含む(原資料の注記)。" +
      "発行額と対で見ると、発行額が償還額より大きい月はその種類の債券の残高が増える方向、小さい月は" +
      "減る方向になる(例: 発行14.5兆円・償還8.0兆円なら残高はおよそ6.5兆円増える)。" +
      "これも発行体側の契約上のイベントに基づくグロスの量で、投資家の売り越し(債券を手放した額)ではない。" +
      "区分は発行額と同じ公社債の種類と公社債合計。値は0以上。単位は円(原資料の百万円を換算)。" +
      "前期比は記録しない(null)。「何を測るか」は区分上「売買代金」(向きを持たないグロスの量)に" +
      "入れているが、取引所などでの売買の代金ではない。",
    sourceUrl: JSDA_HAKKOU_PAGE_URL,
    license: "要確認",
    frequency: "月次",
    limitations: `${REDEMPTION_DEF.limitations}${JSDA_BONDS_COMMON_LIMITATIONS}`,
  },
];

// ---------------------------------------------------------------------------
// 期間・キー (純関数)
// ---------------------------------------------------------------------------

const YM_RE = /^(\d{4})-(\d{2})$/;
const KEY_RE = /^jsda-bonds-(\d{4}-\d{2})-published-(\d{4}-\d{2}-\d{2})$/;

/** "YYYY-MM" を delta か月ずらす。 */
function shiftMonth(yyyyMm: string, delta: number): string {
  const m = YM_RE.exec(yyyyMm);
  if (!m) throw new Error(`shiftMonth: YYYY-MM ではありません: ${yyyyMm}`);
  const index = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

/** 実行時刻の JST の日付 ("YYYY-MM-DD")。 */
function jstDate(now: Date): string {
  const t = now.getTime();
  if (!Number.isFinite(t)) throw new Error(`jstDate: 不正な日時です: ${String(now)}`);
  return new Date(t + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** キーの対象月を含む直近 JSDA_BONDS_WINDOW_MONTHS か月 (古い順)。 */
function windowMonths(latest: string): string[] {
  const out: string[] = [];
  for (let i = JSDA_BONDS_WINDOW_MONTHS - 1; i >= 0; i -= 1) out.push(shiftMonth(latest, -i));
  return out;
}

/** 冪等キーを組み立てる (対象月 "YYYY-MM"・掲載日 "YYYY-MM-DD" を検証する)。 */
export function jsdaBondsBatchKey(latest: Pick<JsdaIssuanceRedemptionLatest, "periodMonth" | "publishedOn">): string {
  const key = `${JSDA_BONDS_SPEC_NAME}-${latest.periodMonth}-published-${latest.publishedOn}`;
  parseBatchKey(key);
  return key;
}

function parseBatchKey(key: string): { periodMonth: string; publishedOn: string } {
  const m = KEY_RE.exec(key);
  if (!m || !m[1] || !m[2]) {
    throw new Error(
      `[${JSDA_BONDS_SPEC_NAME}] 冪等キーの形式が不正です ` +
        `(jsda-bonds-YYYY-MM-published-YYYY-MM-DD であるべき): ${key}`
    );
  }
  const periodMonth = m[1];
  const publishedOn = m[2];
  const { end } = monthRange(periodMonth); // 月が 01〜12 であることも検証する
  const d = new Date(`${publishedOn}T00:00:00Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== publishedOn) {
    throw new Error(`[${JSDA_BONDS_SPEC_NAME}] 冪等キーの掲載日が実在しない日付です: ${key}`);
  }
  if (publishedOn <= end) {
    throw new Error(
      `[${JSDA_BONDS_SPEC_NAME}] 掲載日 ${publishedOn} が対象月 ${periodMonth} の末日以前です ` +
        `(月間の集計が月の途中に掲載されることはない。一覧ページの読み取り異常): ${key}`
    );
  }
  return { periodMonth, publishedOn };
}

/** 本体 xlsx の保管ファイル名 (キーから一意に決まる)。 */
export function jsdaBondsXlsxFilename(key: string): string {
  return `${key}.xlsx`;
}

/** 一覧ページ HTML の保管ファイル名 (掲載日の根拠。解析には使わない)。 */
export function jsdaBondsIndexFilename(key: string): string {
  return `${key}-index.html`;
}

// ---------------------------------------------------------------------------
// toObservations
// ---------------------------------------------------------------------------

/**
 * 1 か月分の行 (取得元モジュールの解析結果) を検証し、区分の出力順に並べ替える。
 * @throws 未知/欠落/重複のシート、負の値、9 種類の合計と公社債合計の不一致、
 *   公社債合計が 0 (未公表の将来月を 0 で先埋めした行の疑い) の場合
 */
function checkedMonthRows(rows: readonly JsdaBondFlowRow[], month: string): JsdaBondFlowRow[] {
  const ctx = `[${JSDA_BONDS_SPEC_NAME}] ${month}`;
  const bySheet = new Map<string, JsdaBondFlowRow>();
  for (const r of rows) {
    jsdaBondCategoryInfo(r.bondType); // 未知のシートは黙って捨てず throw
    if (bySheet.has(r.bondType)) throw new Error(`${ctx}: シート「${r.bondType}」の行が重複しています`);
    if (!Number.isFinite(r.issuance) || !Number.isFinite(r.redemption)) {
      throw new Error(`${ctx}: シート「${r.bondType}」の値が有限数ではありません (${r.issuance} / ${r.redemption})`);
    }
    if (r.issuance < 0 || r.redemption < 0) {
      throw new Error(
        `${ctx}: シート「${r.bondType}」の発行額/償還額が負です (${r.issuance} / ${r.redemption})。` +
          `グロスの金額は負にならないため、列の取り違え (増減(a−b)列など) を疑ってください`
      );
    }
    bySheet.set(r.bondType, r);
  }
  const ordered = BOND_TYPES.map(([sheet]) => {
    const r = bySheet.get(sheet);
    if (!r) throw new Error(`${ctx}: シート「${sheet}」がありません (様式変更の可能性)`);
    return r;
  });

  const total = bySheet.get(TOTAL_SHEET) as JsdaBondFlowRow;
  if (total.issuance === 0 || total.redemption === 0) {
    throw new Error(
      `${ctx}: 公社債合計の発行額/償還額が 0 です (${total.issuance} / ${total.redemption})。` +
        `原資料は未公表の将来月の行を 0 で先埋めしているため、未公表月を読んだ疑いがあります`
    );
  }
  const components = ordered.filter((r) => r.bondType !== TOTAL_SHEET);
  const sumIssuance = components.reduce((a, r) => a + r.issuance, 0);
  const sumRedemption = components.reduce((a, r) => a + r.redemption, 0);
  if (sumIssuance !== total.issuance || sumRedemption !== total.redemption) {
    throw new Error(
      `${ctx}: 9 種類の合計 (発行 ${sumIssuance} / 償還 ${sumRedemption}) が公社債合計 ` +
        `(発行 ${total.issuance} / 償還 ${total.redemption}) と一致しません。列の取り違え・様式変更を疑ってください`
    );
  }
  return ordered;
}

function toObservations(key: string, files: readonly SpecFile[]): ObservationDraft[] {
  const { periodMonth } = parseBatchKey(key);
  const file = requireSpecFile(
    files,
    (n) => n === jsdaBondsXlsxFilename(key),
    `[${JSDA_BONDS_SPEC_NAME}] 公社債発行額・償還額 xlsx`
  );

  const out: ObservationDraft[] = [];
  for (const month of windowMonths(periodMonth)) {
    const { start, end } = monthRange(month);
    // 取得元モジュールは「公表済みと確認した月」だけを受け取る前提。窓の月はすべて
    // 一覧ページの最新月 (= キーの対象月) 以前なので公表済み。
    const { rows } = parseIssuanceRedemptionWorkbook(file.bytes, month);
    for (const r of checkedMonthRows(rows, month)) {
      const info = jsdaBondCategoryInfo(r.bondType);
      const base = {
        period: month,
        periodStart: start,
        periodEnd: end,
        category: info.label,
        categoryKind: info.kind,
        unit: "円",
        changeFromPrev: null,
        approximate: false,
        measureKind: "実測",
      } as const;
      out.push({ ...base, indicatorKey: ISSUANCE_DEF.key, value: r.issuance });
      out.push({ ...base, indicatorKey: REDEMPTION_DEF.key, value: r.redemption });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// resolve / fetch
// ---------------------------------------------------------------------------

/**
 * 一覧ページで読んだ最新月の鮮度を検証する。
 * @throws 最新月が実行月 (JST) より後・掲載日が実行日 (JST) より後 (ページか時計の異常)、
 *   または最新月が実行月 − JSDA_BONDS_MAX_LAG_MONTHS より前 (更新停止の疑い)
 */
function assertFresh(latest: JsdaIssuanceRedemptionLatest, now: Date): void {
  const today = jstDate(now);
  const current = today.slice(0, 7);
  const ctx = `[${JSDA_BONDS_SPEC_NAME}]`;
  if (latest.periodMonth > current) {
    throw new Error(`${ctx} 一覧ページの最新月 ${latest.periodMonth} が実行月 ${current} (JST) より後です (ページか時計の異常)`);
  }
  if (latest.publishedOn > today) {
    throw new Error(`${ctx} 一覧ページの掲載日 ${latest.publishedOn} が実行日 ${today} (JST) より後です (ページか時計の異常)`);
  }
  const required = shiftMonth(current, -JSDA_BONDS_MAX_LAG_MONTHS);
  const status = issuanceRedemptionPublicationStatus(latest, required);
  if (status.kind === "not_yet_published") {
    throw new Error(
      `${ctx} 一覧ページの最新月が ${latest.periodMonth} (掲載日 ${latest.publishedOn}) のままです ` +
        `(実行月 ${current} の ${JSDA_BONDS_MAX_LAG_MONTHS} か月前 ${required} 分まで無い)。` +
        `JSDA の掲載停止・一覧ページの様式変更を確認してください`
    );
  }
}

/** xlsx (= zip) の先頭シグネチャ "PK\x03\x04"。 */
function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export const jsdaBondsSpec: MoneyflowSourceSpec = {
  name: JSDA_BONDS_SPEC_NAME,
  indicators: JSDA_BONDS_SPEC_INDICATORS,
  async resolve(now) {
    const indexRes = await fetchFromJsda(
      JSDA_HAKKOU_PAGE_URL,
      { headers: { "User-Agent": JSDA_UA } },
      "公社債発行額・償還額 一覧ページ"
    );
    const indexBytes = new Uint8Array(await indexRes.arrayBuffer());
    // 一覧ページは UTF-8 (<meta charset="utf-8">)。不正なバイト列は置換せず throw する
    const html = new TextDecoder("utf-8", { fatal: true }).decode(indexBytes);
    const latest = parseHakkouIndexHtml(html, JSDA_HAKKOU_PAGE_URL);
    assertFresh(latest, now);
    const key = jsdaBondsBatchKey(latest);

    return {
      key,
      async fetch(): Promise<FetchedBatch> {
        const res = await fetchFromJsda(
          latest.fileUrl,
          { headers: { "User-Agent": JSDA_UA, Accept: XLSX_ACCEPT } },
          "公社債発行額・償還額 xlsx"
        );
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (!isZip(bytes)) {
          // HTML のエラーページ等を .xlsx として保管すると、以後そのキーは再解析が
          // 失敗し続ける。保管前に止める。
          throw new Error(
            `[${JSDA_BONDS_SPEC_NAME}] ${latest.fileUrl} の応答が xlsx (zip) ではありません ` +
              `(${bytes.length} バイト、Content-Type: ${JSON.stringify(res.headers.get("content-type"))})`
          );
        }
        return {
          key,
          source: latest.fileUrl,
          metadata: {
            indexUrl: JSDA_HAKKOU_PAGE_URL,
            fileUrl: latest.fileUrl,
            linkedFilename: latest.filename,
            periodMonth: latest.periodMonth,
            publishedOn: latest.publishedOn,
            windowMonths: JSDA_BONDS_WINDOW_MONTHS,
            windowStart: shiftMonth(latest.periodMonth, -(JSDA_BONDS_WINDOW_MONTHS - 1)),
            xlsxBytes: bytes.byteLength,
            indexBytes: indexBytes.byteLength,
            resolvedAt: now.toISOString(),
          },
          files: [
            { bytes, filename: jsdaBondsXlsxFilename(key), contentType: XLSX_CONTENT_TYPE },
            { bytes: indexBytes, filename: jsdaBondsIndexFilename(key), contentType: HTML_CONTENT_TYPE },
          ],
        };
      },
    };
  },
  toObservations: ({ key, files }) => toObservations(key, files),
};

/** この取得元の全 spec (取込 CLI の登録用)。 */
export const JSDA_BONDS_SPECS: readonly MoneyflowSourceSpec[] = [jsdaBondsSpec];
