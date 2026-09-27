/**
 * moneyflow 取得元アダプタ: 資産運用業協会 (IMAJ、旧・投資信託協会) の
 * 資産増減状況統計 (`../sources/imaj-fund-flows.ts`) を Phase 1 の Notion 3 DB へつなぐ。
 *
 * 独立に公表される 2 つのファイルを別々の spec にする:
 *   - `imaj-fund-flows`      … B-1「公募投資信託の資産増減状況」(I0112B_pub_m.xlsx)
 *   - `imaj-fund-flows-reit` … D-1「公募不動産投信の月末資産増減状況」(F00B21_pub.xlsx)
 * (D-1 の掲載は B-1 より約 1 か月遅い — 同じ実行で最新月が揃わないため 1 spec にまとめない)
 *
 * どちらのファイルも「固定 URL を協会が毎月上書きし、中に全期間の月次時系列が入る」
 * 方式で、最新月を知るには本体 xlsx を取るしかない (軽い一覧ページ・API が無い)。
 * そのため `resolve()` で本体を 1 回だけ取得して最新月からキーを決め、`fetch()` は
 * そのバイト列をそのまま返す (取得元へは 1 実行 1 GET)。
 *
 * 1 バッチで記録するのは「キーの最新月までの直近 12 か月」(固定規則)。全期間
 * (B-1 は 1989 年〜・約 450 か月) は行数上限 (約 600 行) を大きく超えるため取り込まない。
 * 直近 12 か月を毎回送り直すのは、原資料が過去月を訂正する (「色付セルは訂正数字」:
 * 2026-09-27 取得の D-1 では 2026 年 7 月分の公表と同時に 6 月分の純資産総額等が
 * 訂正されていた) ため — upsert で観測ログの値が訂正後の値に更新される。
 *
 * 単位: 原資料は百万円 → 円に換算 (×1,000,000)。
 * 前期比: 同じファイル内に前月の値があるので、資金増減額は「前月の資金増減額との差」、
 * 純資産総額は原資料自身の「純資産増減額」(B-1) / 「資産増減額」(D-1) 列 (いずれも
 * 前月末からの純資産の増減) をそのまま使う (再計算しない)。いずれも円に換算した差額。
 */
import {
  IMAJ_STATISTICS_INDEX_URL,
  downloadImajFundFlowsXlsx,
  downloadImajReitFlowsXlsx,
  judgeImajPublicationStatus,
  parseImajFundFlows,
  parseImajReitFlows,
  type ImajFundCategory,
  type ImajFundFlowRow,
  type ImajReitFlowRow,
} from "../sources/imaj-fund-flows.js";
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

export const IMAJ_FUND_FLOWS_SPEC_NAME = "imaj-fund-flows";
export const IMAJ_FUND_FLOWS_REIT_SPEC_NAME = "imaj-fund-flows-reit";

/** 1 バッチで記録する月数 (キーの最新月を含む直近 N か月)。固定規則。 */
export const IMAJ_WINDOW_MONTHS = 12;

/**
 * 更新停止の検知: ファイルの最新月が「実行月 (JST) − N か月」より前なら throw する。
 * 通常の掲載ラグは B-1 が 1〜2 か月 (当月分は翌月中旬〜下旬)、D-1 が 2〜3 か月
 * (B-1 よりさらに約 1 か月遅い。2026-09-27 実測: B-1=2026-08、D-1=2026-07)。
 * 1 か月の遅れは許し、それ以上は協会の改称に伴うドメイン移行 (toushin.or.jp →
 * imaj.or.jp) で旧 URL の更新が止まった等を疑って取込を失敗させる
 * (「取込済み」扱いのまま黙って古い値を見せ続けない — ルール2)。
 */
const MAX_LAG_MONTHS_FUNDS = 3;
const MAX_LAG_MONTHS_REIT = 4;

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MILLION = 1_000_000;

// ---------------------------------------------------------------------------
// 指標定義
// ---------------------------------------------------------------------------

const COMMON_LICENSE_NOTE =
  "利用条件: 協会の統計データの利用規約で商用・再配布の可否を確認できていない" +
  "(調査資料によって「不明」「禁止」と記載が分かれる)ため「要確認」。個人利用に限り、" +
  "公開面へは出さない。";

const FUNDS_COMMON_LIMITATIONS =
  "対象は公募の契約型投資信託のみ(私募投信、J-REIT などの投資法人、証券投資法人は含まない)。" +
  "取込は1回につき最新月までの直近12か月分だけを記録する(それより前の履歴は取り込まない。" +
  "原資料は過去月を訂正することがあり、直近12か月内の訂正は次の月の取込で上書きされるが、" +
  "12か月より前の訂正や、同じ最新月のまま差し替えられた訂正は反映されない)。" +
  "当月分は翌月中旬〜下旬に掲載される。ファイルの最新月が実行月の4か月以上前のまま" +
  "(例: 9月の実行で5月分まで)なら、更新停止を疑って取込を失敗させる。" +
  "原資料は toushin.or.jp の固定URL(I0112B_pub_m.xlsx)を毎月上書きする方式で、" +
  "協会の改称(2026年4月に資産運用業協会)に伴うドメイン移行でURLや様式が変わる可能性がある" +
  "(変わった場合は解析で失敗として検知する)。原資料で「-」(その月は発生なし)の欄は0として記録する。" +
  "ETF区分と除ETF区分は2001年7月分からしか存在しない。" +
  "「株式投信」は法令上の分類で、株式を組み入れることができる投信すべてを指す" +
  "(債券・REIT・海外資産が中心のファンドやバランス型も含む)。「株式に流れたお金」と同じではない。" +
  "「公社債投信」の大半はMRF(証券会社の口座で、株などを買う前のお金を置いておく投信)で" +
  "(2026年8月末で公社債投信の純資産の約97%)、その増減は債券への投資というより" +
  "証券口座の待機資金の出入りを表す面が大きい。" +
  COMMON_LICENSE_NOTE;

const REIT_COMMON_LIMITATIONS =
  "公募不動産投信全体の合計のみ(銘柄別の内訳、私募REITは無い)。" +
  "取込は1回につき最新月までの直近12か月分だけを記録する(それより前の履歴は取り込まない。" +
  "原資料は過去月を訂正することがあり(2026年7月分の公表時に6月分の純資産総額等が訂正された)、" +
  "直近12か月内の訂正は次の月の取込で上書きされるが、12か月より前の訂正や、" +
  "同じ最新月のまま差し替えられた訂正は反映されない)。" +
  "掲載は公募投信(B-1)より約1か月遅い(2026-09-27時点で2026年7月分まで)。" +
  "ファイルの最新月が実行月の5か月以上前のまま(例: 9月の実行で4月分まで)なら、" +
  "更新停止を疑って取込を失敗させる。原資料は toushin.or.jp の固定URL(F00B21_pub.xlsx)を" +
  "毎月上書きする方式で、協会の改称に伴うドメイン移行でURLや様式が変わる可能性がある" +
  "(変わった場合は解析で失敗として検知する)。原資料で「-」(その月は発生なし)の欄は0として記録する。" +
  COMMON_LICENSE_NOTE;

export const IMAJ_FUND_FLOWS_SPEC_INDICATORS: readonly IndicatorDefInput[] = [
  {
    key: "imaj_fund_net_flow",
    displayName: "公募投信の資金増減額 (設定−解約−償還)",
    requirement: "R2",
    flowType: "設定解約",
    description:
      "公募の投資信託に1か月間で新しく入ってきたお金(設定額)から、解約と償還(満期などによる" +
      "払い戻し)で出ていったお金を引いた額(1か月間の流れ=フロー)。原資料の「資金増減額 " +
      "(D)=(A)−((B)+(C))」をそのまま使う。プラスなら投信という器へのお金の純流入、" +
      "マイナスなら純流出。例: 設定1兆円・解約8,000億円・償還0円なら +2,000億円。" +
      "区分は商品分類で、総合計=株式投信+公社債投信、株式投信=株式投信(除ETF)+株式投信(ETF)" +
      "(原資料は区分ごとに百万円未満の端数を処理しているため、足し算が100万円ずれる月がある。" +
      "例: 2025年9月は株式投信が除ETFとETFの合計より100万円少ない)。" +
      "取引所でのETFの売買(投資家どうしの売り買い=二次市場)の買い越し/売り越しとは別物で、" +
      "ETFの設定・解約は主に証券会社(指定参加者)を通じて行われる。収益分配金の支払いは" +
      "含まない(原資料では別の項目)。単位は円(原資料の百万円を換算)。" +
      "前期比は同じファイル内の前月の資金増減額との差(円)。",
    sourceUrl: IMAJ_STATISTICS_INDEX_URL,
    license: "要確認",
    frequency: "月次",
    limitations: FUNDS_COMMON_LIMITATIONS,
  },
  {
    key: "imaj_fund_net_asset_total",
    displayName: "公募投信の純資産総額 (月末残高)",
    requirement: "R2",
    flowType: "残高",
    description:
      "公募の投資信託の月末時点の純資産総額(時価ベースの残高=ストック)。1か月間のお金の" +
      "流れ(フロー)ではない。残高は、資金増減額(設定−解約−償還)だけでなく、値上がり・" +
      "値下がりによる運用増減額や分配金の支払いでも変わる(原資料: 純資産増減額=(D)−(E)+(F))。" +
      "例: お金の流入がゼロでも、組み入れた株が値上がりすれば残高は増える。" +
      "区分は資金増減額と同じ商品分類。単位は円(原資料の百万円を換算)。" +
      "前期比は原資料の「純資産増減額」(前月末からの増減)を円に換算してそのまま使う。",
    sourceUrl: IMAJ_STATISTICS_INDEX_URL,
    license: "要確認",
    frequency: "月次",
    limitations:
      "残高(ストック)であり、その月の資金の流入額ではない(近似フラグ=true)。増減には" +
      "値動きと分配金が混ざる。" +
      FUNDS_COMMON_LIMITATIONS,
  },
];

export const IMAJ_FUND_FLOWS_REIT_SPEC_INDICATORS: readonly IndicatorDefInput[] = [
  {
    key: "imaj_reit_net_flow",
    displayName: "公募REITの資本金増減額 (追加出資−出資払戻)",
    requirement: "R2",
    flowType: "設定解約",
    description:
      "公募の不動産投資信託(J-REIT など)全体で、1か月間に投資口の追加発行(公募増資など)で" +
      "払い込まれたお金(追加出資金額)から、出資の払い戻しで出ていったお金(出資払戻金額)を" +
      "引いた額(1か月間の流れ=フロー)。原資料の「資本金増減額 (C)=(A)−(B)」をそのまま使う。" +
      "プラスならREITという器へのお金の純流入。東証でのREIT投資口の売買(二次市場)の" +
      "買い越し/売り越しとは別物で、取引所で誰かが買えば同じ額を誰かが売っているため、" +
      "売買だけではREITにお金は入らない。例: その月にあるREITが公募増資で500億円を集め、" +
      "ほかに増資も払い戻しも無ければ +500億円。単位は円(原資料の百万円を換算)。" +
      "前期比は同じファイル内の前月の資本金増減額との差(円)。",
    sourceUrl: IMAJ_STATISTICS_INDEX_URL,
    license: "要確認",
    frequency: "月次",
    limitations:
      "原資料の出資総額の前月比とは一致しない月がある(例: 2025年8月は資本金増減額 +22,517百万円" +
      "に対し、出資総額は前月比 −57,657百万円)ため、新規上場・上場廃止・合併・利益を超える" +
      "分配(出資の払い戻しにあたる分配)がこの値にどう計上されるかは未確認。" +
      REIT_COMMON_LIMITATIONS,
  },
  {
    key: "imaj_reit_net_asset_total",
    displayName: "公募REITの純資産総額 (月末残高・帳簿ベース)",
    requirement: "R2",
    flowType: "残高",
    description:
      "公募REIT全体の月末時点の純資産総額(残高=ストック。1か月間の流れではない)。" +
      "各投資法人の帳簿上の純資産(出資総額+剰余金)の合計で、東証での投資口価格×口数" +
      "(時価総額)ではない。例: 投資口価格が10%下がっても、それだけではこの値は減らない。" +
      "月々の変化は、資本金増減額(お金の出入り)と、その他増減額(原資料の注記: 運用等による" +
      "剰余金=当期損益+繰越利益等の内部留保額の増減)の合計(原資料: 資産増減額=(C)+(D))。" +
      "単位は円(原資料の百万円を換算)。前期比は原資料の「資産増減額」(前月末からの純資産の" +
      "増減)を円に換算してそのまま使う。",
    sourceUrl: IMAJ_STATISTICS_INDEX_URL,
    license: "要確認",
    frequency: "月次",
    limitations:
      "残高(ストック)であり、その月の資金の流入額ではない(近似フラグ=true)。帳簿ベースのため" +
      "市場での値動き(投資口価格・不動産の時価)の影響はほぼ表れない。" +
      REIT_COMMON_LIMITATIONS,
  },
];

// ---------------------------------------------------------------------------
// 区分 (商品分類)
// ---------------------------------------------------------------------------

interface CategoryInfo {
  label: string;
  kind: MoneyflowCategoryKind;
}

/** B-1 の商品分類 (モジュールの識別子) → 観測ログの区分。並び順 = 出力順。 */
const FUND_CATEGORIES: ReadonlyArray<readonly [ImajFundCategory, CategoryInfo]> = [
  ["total", { label: "総合計(株式投信+公社債投信)", kind: "全体" }],
  ["equity", { label: "株式投信", kind: "資産クラス" }],
  ["equity_ex_etf", { label: "株式投信(除ETF)", kind: "資産クラス" }],
  ["equity_etf", { label: "株式投信(ETF)", kind: "資産クラス" }],
  ["bond", { label: "公社債投信", kind: "資産クラス" }],
];
const FUND_CATEGORY_MAP: ReadonlyMap<string, CategoryInfo> = new Map(FUND_CATEGORIES);

/** D-1 は公募不動産投信全体の 1 系列のみ。 */
const REIT_CATEGORY: CategoryInfo = { label: "公募不動産投信", kind: "全体" };

/**
 * B-1 の商品分類識別子を観測ログの区分に変換する。
 * @throws 既知の 5 区分以外 (取得元モジュールの区分が増えた・変わった) の場合
 */
export function imajFundCategoryInfo(category: string): CategoryInfo {
  const info = FUND_CATEGORY_MAP.get(category);
  if (!info) {
    throw new Error(
      `[${IMAJ_FUND_FLOWS_SPEC_NAME}] 未知の商品分類区分です: ${JSON.stringify(category)} ` +
        `(既知: ${[...FUND_CATEGORY_MAP.keys()].join(", ")})`
    );
  }
  return info;
}

// ---------------------------------------------------------------------------
// 期間ユーティリティ (純関数)
// ---------------------------------------------------------------------------

const YM_RE = /^(\d{4})-(\d{2})$/;

/** "YYYY-MM" を delta か月ずらす。 */
function shiftMonth(yyyyMm: string, delta: number): string {
  const m = YM_RE.exec(yyyyMm);
  if (!m) throw new Error(`shiftMonth: YYYY-MM ではありません: ${yyyyMm}`);
  const index = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

/** 実行時刻の JST の年月 ("YYYY-MM")。 */
function jstYearMonth(now: Date): string {
  const t = now.getTime();
  if (!Number.isFinite(t)) throw new Error(`jstYearMonth: 不正な日時です: ${String(now)}`);
  const jst = new Date(t + 9 * 60 * 60 * 1000);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** キーの最新月を含む直近 IMAJ_WINDOW_MONTHS か月 (古い順)。 */
function windowPeriods(latest: string): string[] {
  const out: string[] = [];
  for (let i = IMAJ_WINDOW_MONTHS - 1; i >= 0; i -= 1) out.push(shiftMonth(latest, -i));
  return out;
}

function latestPeriodOf(rows: ReadonlyArray<{ period: string }>, context: string): string {
  const first = rows[0];
  if (!first) throw new Error(`${context}: データ行が 0 件です`);
  let latest = first.period;
  for (const r of rows) if (r.period > latest) latest = r.period;
  return latest;
}

/** 百万円 → 円。 */
function millionYenToYen(v: number, context: string): number {
  const yen = v * MILLION;
  if (!Number.isFinite(yen)) throw new Error(`${context}: 円換算の結果が有限数ではありません (${v} 百万円)`);
  return yen;
}

function periodFromKey(key: string, specName: string): string {
  const m = new RegExp(`^${specName}-(\\d{4}-\\d{2})$`).exec(key);
  if (!m || !m[1]) {
    throw new Error(`[${specName}] 冪等キーの形式が不正です (${specName}-YYYY-MM であるべき): ${key}`);
  }
  // 月の範囲 (01〜12) も検証する
  monthRange(m[1]);
  return m[1];
}

function batchFilename(key: string): string {
  return `${key}.xlsx`;
}

// ---------------------------------------------------------------------------
// resolve / fetch 共通
// ---------------------------------------------------------------------------

/**
 * 最新月の鮮度を検証する。
 * @throws 最新月が実行月より後 (ファイルか時計の異常)、または実行月 − maxLagMonths より前 (更新停止の疑い)
 */
function assertFresh(
  rows: ReadonlyArray<{ period: string }>,
  latest: string,
  now: Date,
  maxLagMonths: number,
  context: string
): void {
  const current = jstYearMonth(now);
  if (latest > current) {
    throw new Error(`${context}: ファイルの最新月 ${latest} が実行月 ${current} (JST) より後です (ファイルか時計の異常)`);
  }
  const required = shiftMonth(current, -maxLagMonths);
  const status = judgeImajPublicationStatus(required, rows);
  if (status.status === "not_yet_published") {
    throw new Error(
      `${context}: ファイルの最新月が ${status.latestAvailablePeriod} のままです ` +
        `(実行月 ${current} の ${maxLagMonths} か月前 ${required} 分まで無い)。` +
        `協会の更新停止・URL 移転 (toushin.or.jp → imaj.or.jp) を確認してください`
    );
  }
}

function buildBatch(args: {
  key: string;
  url: string;
  bytes: Uint8Array;
  latest: string;
  rowCount: number;
  now: Date;
}): FetchedBatch {
  return {
    key: args.key,
    source: args.url,
    metadata: {
      url: args.url,
      indexUrl: IMAJ_STATISTICS_INDEX_URL,
      latestPeriod: args.latest,
      windowMonths: IMAJ_WINDOW_MONTHS,
      windowStart: shiftMonth(args.latest, -(IMAJ_WINDOW_MONTHS - 1)),
      parsedRowCount: args.rowCount,
      bytes: args.bytes.byteLength,
      resolvedAt: args.now.toISOString(),
    },
    files: [{ bytes: args.bytes, filename: batchFilename(args.key), contentType: XLSX_CONTENT_TYPE }],
  };
}

/** period+区分 の索引を作る (重複は様式異常として throw)。 */
function indexRows<R extends { period: string }>(
  rows: readonly R[],
  categoryOf: (r: R) => string,
  context: string
): (category: string, period: string) => R {
  const map = new Map<string, R>();
  for (const r of rows) {
    const k = `${categoryOf(r)}|${r.period}`;
    if (map.has(k)) throw new Error(`${context}: 同じ区分・月の行が重複しています (${k})`);
    map.set(k, r);
  }
  return (category, period) => {
    const r = map.get(`${category}|${period}`);
    if (!r) throw new Error(`${context}: ${category} の ${period} 分の行がありません (直近${IMAJ_WINDOW_MONTHS}か月+前月が必要)`);
    return r;
  };
}

// ---------------------------------------------------------------------------
// B-1 公募投資信託
// ---------------------------------------------------------------------------

function fundObservations(key: string, files: readonly SpecFile[]): ObservationDraft[] {
  const spec = IMAJ_FUND_FLOWS_SPEC_NAME;
  const latest = periodFromKey(key, spec);
  const file = requireSpecFile(files, (n) => n === batchFilename(key), `[${spec}] B-1 資産増減状況 xlsx`);
  const rows: ImajFundFlowRow[] = parseImajFundFlows(file.bytes);
  // 区分が既知の 5 つだけであることを先に確かめる (未知の区分は黙って捨てない)
  for (const r of rows) imajFundCategoryInfo(r.category);
  const fileLatest = latestPeriodOf(rows, `[${spec}]`);
  if (fileLatest !== latest) {
    throw new Error(`[${spec}] キー ${key} の月 ${latest} とファイルの最新月 ${fileLatest} が一致しません`);
  }
  const row = indexRows(rows, (r) => r.category, `[${spec}]`);

  const out: ObservationDraft[] = [];
  for (const period of windowPeriods(latest)) {
    const { start, end } = monthRange(period);
    const prevPeriod = shiftMonth(period, -1);
    for (const [category, info] of FUND_CATEGORIES) {
      const cur = row(category, period);
      const prev = row(category, prevPeriod);
      const ctx = `[${spec}] ${info.label} ${period}`;
      out.push({
        period,
        periodStart: start,
        periodEnd: end,
        indicatorKey: "imaj_fund_net_flow",
        category: info.label,
        categoryKind: info.kind,
        value: millionYenToYen(cur.netFlow, `${ctx} 資金増減額`),
        unit: "円",
        changeFromPrev: millionYenToYen(cur.netFlow - prev.netFlow, `${ctx} 資金増減額の前月差`),
        approximate: false,
        measureKind: "実測",
      });
      out.push({
        period,
        periodStart: end,
        periodEnd: end,
        indicatorKey: "imaj_fund_net_asset_total",
        category: info.label,
        categoryKind: info.kind,
        value: millionYenToYen(cur.totalNetAssets, `${ctx} 純資産総額`),
        unit: "円",
        changeFromPrev: millionYenToYen(cur.netAssetChange, `${ctx} 純資産増減額`),
        approximate: true,
        measureKind: "実測",
      });
    }
  }
  return out;
}

export const imajFundFlowsSpec: MoneyflowSourceSpec = {
  name: IMAJ_FUND_FLOWS_SPEC_NAME,
  indicators: IMAJ_FUND_FLOWS_SPEC_INDICATORS,
  async resolve(now) {
    const context = `[${IMAJ_FUND_FLOWS_SPEC_NAME}]`;
    const dl = await downloadImajFundFlowsXlsx();
    const rows = parseImajFundFlows(dl.bytes);
    const latest = latestPeriodOf(rows, context);
    assertFresh(rows, latest, now, MAX_LAG_MONTHS_FUNDS, context);
    const key = `${IMAJ_FUND_FLOWS_SPEC_NAME}-${latest}`;
    const batch = buildBatch({ key, url: dl.url, bytes: dl.bytes, latest, rowCount: rows.length, now });
    return { key, fetch: async () => batch };
  },
  toObservations: ({ key, files }) => fundObservations(key, files),
};

// ---------------------------------------------------------------------------
// D-1 公募不動産投信
// ---------------------------------------------------------------------------

function reitObservations(key: string, files: readonly SpecFile[]): ObservationDraft[] {
  const spec = IMAJ_FUND_FLOWS_REIT_SPEC_NAME;
  const latest = periodFromKey(key, spec);
  const file = requireSpecFile(files, (n) => n === batchFilename(key), `[${spec}] D-1 公募REIT月末資産増減状況 xlsx`);
  const rows: ImajReitFlowRow[] = parseImajReitFlows(file.bytes);
  const fileLatest = latestPeriodOf(rows, `[${spec}]`);
  if (fileLatest !== latest) {
    throw new Error(`[${spec}] キー ${key} の月 ${latest} とファイルの最新月 ${fileLatest} が一致しません`);
  }
  const row = indexRows(rows, () => REIT_CATEGORY.label, `[${spec}]`);

  const out: ObservationDraft[] = [];
  for (const period of windowPeriods(latest)) {
    const { start, end } = monthRange(period);
    const cur = row(REIT_CATEGORY.label, period);
    const prev = row(REIT_CATEGORY.label, shiftMonth(period, -1));
    const ctx = `[${spec}] ${period}`;
    out.push({
      period,
      periodStart: start,
      periodEnd: end,
      indicatorKey: "imaj_reit_net_flow",
      category: REIT_CATEGORY.label,
      categoryKind: REIT_CATEGORY.kind,
      value: millionYenToYen(cur.capitalChange, `${ctx} 資本金増減額`),
      unit: "円",
      changeFromPrev: millionYenToYen(cur.capitalChange - prev.capitalChange, `${ctx} 資本金増減額の前月差`),
      approximate: false,
      measureKind: "実測",
    });
    out.push({
      period,
      periodStart: end,
      periodEnd: end,
      indicatorKey: "imaj_reit_net_asset_total",
      category: REIT_CATEGORY.label,
      categoryKind: REIT_CATEGORY.kind,
      value: millionYenToYen(cur.totalNetAssets, `${ctx} 純資産総額`),
      unit: "円",
      changeFromPrev: millionYenToYen(cur.assetChange, `${ctx} 資産増減額`),
      approximate: true,
      measureKind: "実測",
    });
  }
  return out;
}

export const imajFundFlowsReitSpec: MoneyflowSourceSpec = {
  name: IMAJ_FUND_FLOWS_REIT_SPEC_NAME,
  indicators: IMAJ_FUND_FLOWS_REIT_SPEC_INDICATORS,
  async resolve(now) {
    const context = `[${IMAJ_FUND_FLOWS_REIT_SPEC_NAME}]`;
    const dl = await downloadImajReitFlowsXlsx();
    const rows = parseImajReitFlows(dl.bytes);
    const latest = latestPeriodOf(rows, context);
    assertFresh(rows, latest, now, MAX_LAG_MONTHS_REIT, context);
    const key = `${IMAJ_FUND_FLOWS_REIT_SPEC_NAME}-${latest}`;
    const batch = buildBatch({ key, url: dl.url, bytes: dl.bytes, latest, rowCount: rows.length, now });
    return { key, fetch: async () => batch };
  },
  toObservations: ({ key, files }) => reitObservations(key, files),
};

/** この取得元の全 spec (取込 CLI の登録用)。 */
export const IMAJ_FUND_FLOWS_SPECS: readonly MoneyflowSourceSpec[] = [imajFundFlowsSpec, imajFundFlowsReitSpec];
