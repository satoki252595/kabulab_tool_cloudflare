// 取得元: CFTC (米国先物取引委員会) Commitments of Traders (COT) レポート
//   - 対象契約: 円先物 (JAPANESE YEN, コード 097741) / 日経平均先物 円建て
//     (NIKKEI STOCK AVERAGE YEN DENOM, コード 240743)。いずれも CME
//     (シカゴ・マーカンタイル取引所) 上場、米ドル/円建てではなく「米国上場市場」
//     という意味で日本国内の資金フローそのものではない参考指標 (計画書 R3/R4 補助)。
//   - レポート種別: Legacy (Futures Only) — Non-Commercial (投機筋) /
//     Commercial (実需筋) / Nonreportable の伝統的な3区分。
//   - 取得経路: Socrata Open Data API (Public Reporting Environment)。
//     dataset id 6dca-aqww。ログイン・APIキー不要、bot対策なし (2026-09-27
//     時点で確認: 無認証の素の GET で JSON が即時に返る)。
//   - 公表: 毎週金曜 米国東部時間(ET) 15:30、データ基準日は直前火曜終値時点。
//   - 日経平均先物は CME に米ドル建て(コード240741)と円建て(コード240743、
//     Yen Denom)の2種類が上場しているが、米ドル建ては出来高が薄く、最低
//     トレーダー数などの報告基準を満たさない週は公表対象から除外される
//     (2026-09-27 時点の確認では、米ドル建ての最終公表は 2026-03-03 で
//     以降 半年近く欠落している)。そのため本モジュールは毎週安定して
//     公表される円建て(240743)のみを追跡対象とする。米ドル建て版を
//     追加するかは統合担当の判断に委ねる (欠測が多く定期観測に不向き)。
//
// このファイルは Notion への書き込みを一切行わない (統合担当が
// `cftcCotJpyArchiveInput()` の出力を `recordPrimaryData()` に渡す)。

/** CFTC Public Reporting Environment (Socrata) の Legacy Futures Only データセット */
export const CFTC_COT_LEGACY_FUTURES_ONLY_API_URL =
  "https://publicreporting.cftc.gov/resource/6dca-aqww.json";

/** 人間向けの一次レポートページ (Socrata API と同じ値を独立に目視確認できる) */
export const CFTC_COT_HUMAN_REPORT_URL = "https://www.cftc.gov/dea/futures/deacmesf.htm";

/** Socrata データセットのポータルページ (出典明記用) */
export const CFTC_COT_PORTAL_URL =
  "https://publicreporting.cftc.gov/stories/s/Commitments-of-Traders/r4w3-av2u/";

const RELEASE_HOUR_ET = 15;
const RELEASE_MINUTE_ET = 30;
const MS_PER_DAY = 86_400_000;

/** 建玉(ポジション)数の単位。契約1枚あたりの想定元本は銘柄ごとに異なるため合算しない。 */
const CONTRACT_UNIT_LABEL = "枚 (建玉数、契約単位。銘柄ごとに1枚あたりの想定元本が異なるため合算不可)";

const CFTC_USAGE_TERMS =
  "米国連邦政府機関(CFTC)が作成した統計でパブリックドメイン。商用利用可、" +
  "ログイン・APIキー不要 (出典明記が望ましいが必須ではない)。Socrata App " +
  "Token は任意 (無くても取得可能、大量バックフィル時のみレート制限緩和の " +
  "ため取得を推奨)。";

const CFTC_FREQUENCY = "週次 (毎週金曜 米国東部時間15:30公表、データ基準日は直前火曜終値時点)";

const CFTC_LIMITATIONS =
  "(1) 米国 CME 上場市場でのポジションであり、日本国内の資金フローそのもの" +
  "ではない参考指標。(2) 建玉(ストック)の週次スナップショットであり、週差分は" +
  "ロールオーバーやスプレッド解消も混在するため、そのまま資金の純流入額とは" +
  "解釈できない。(3) 米国の祝日等で公表日がずれることがある。(4) 日経平均" +
  "先物は米ドル建て(コード240741)も CME に上場しているが、最低トレーダー数" +
  "などの報告基準を満たさない週は公表対象から除外され欠測が多いため、" +
  "本モジュールでは追跡対象に含めていない(円建てコード240743のみ追跡)。";

/** 追跡対象契約のキー */
export type CftcCotContractKey = "jpy" | "nikkei225_yen";

export interface CftcCotContractInfo {
  /** CFTC 契約コード (cftc_contract_market_code) */
  readonly code: string;
  readonly key: CftcCotContractKey;
  /** 表示名 (日本語) */
  readonly displayName: string;
  /** 応答の contract_market_name が一致すべき値 (様式変更検知用) */
  readonly expectedContractName: string;
  /** market_and_exchange_names に含まれるべき取引所名 */
  readonly expectedExchangeSubstring: string;
  /** contract_units に含まれるべき部分文字列 (契約単位変更の検知用) */
  readonly expectedContractUnitsSubstring: string;
  /** 観測ログの「区分」列に書く値 (資産クラス軸) */
  readonly category: string;
}

export const CFTC_TRACKED_CONTRACTS: readonly CftcCotContractInfo[] = [
  {
    code: "097741",
    key: "jpy",
    displayName: "円先物 (CME、JAPANESE YEN)",
    expectedContractName: "JAPANESE YEN",
    expectedExchangeSubstring: "CHICAGO MERCANTILE EXCHANGE",
    expectedContractUnitsSubstring: "JPY 12,500,000",
    category: "資産クラス｜為替(円、CME上場先物)",
  },
  {
    code: "240743",
    key: "nikkei225_yen",
    displayName: "日経平均先物 円建て (CME、NIKKEI STOCK AVERAGE YEN DENOM)",
    expectedContractName: "NIKKEI STOCK AVERAGE YEN DENOM",
    expectedExchangeSubstring: "CHICAGO MERCANTILE EXCHANGE",
    expectedContractUnitsSubstring: "NIKKEI INDEX X JPY",
    category: "資産クラス｜株価指数先物(日経平均、CME円建て上場)",
  },
] as const;

/** 1回の取得で遡る行数の既定値 (2契約 × 直近6週分 = 12 に安全マージンを載せた値) */
const DEFAULT_FETCH_LIMIT = 16;

/**
 * 最新データの Socrata SoQL クエリ URL を組み立てる (純関数)。
 * 追跡対象2契約のみに絞り、基準日降順で最大 `limit` 行を要求する。
 */
export function buildCftcCotJpyRequestUrl(limit: number = DEFAULT_FETCH_LIMIT): string {
  const codeList = CFTC_TRACKED_CONTRACTS.map((c) => `'${c.code}'`).join(",");
  const params = new URLSearchParams({
    $where: `cftc_contract_market_code in (${codeList})`,
    $order: "report_date_as_yyyy_mm_dd DESC",
    $limit: String(limit),
  });
  return `${CFTC_COT_LEGACY_FUTURES_ONLY_API_URL}?${params.toString()}`;
}

/** Socrata API から生の JSON テキストを取得する (ネットワークI/O)。 */
export async function fetchCftcCotJpyRawText(
  limit: number = DEFAULT_FETCH_LIMIT,
  fetchImpl: typeof fetch = fetch
): Promise<{ url: string; text: string }> {
  const url = buildCftcCotJpyRequestUrl(limit);
  const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`CFTC COT Socrata API HTTP エラー: ${res.status} ${res.statusText} (${url})`);
  }
  const text = await res.text();
  return { url, text };
}

/** パース済み1行 (1契約 × 1週) */
export interface CftcCotJpyRow {
  /** データ基準日 (直前火曜、YYYY-MM-DD) */
  asOfDate: string;
  /** CFTC の "YYYY Report Week WW" 表記 (来歴確認用にそのまま保持) */
  reportWeekLabel: string;
  contractCode: string;
  contractName: string;
  exchangeAndMarketName: string;
  contractUnits: string;
  openInterestAll: number;
  noncommLong: number;
  noncommShort: number;
  commLong: number;
  commShort: number;
  nonreptLong: number;
  nonreptShort: number;
}

const REQUIRED_STRING_FIELDS = [
  "report_date_as_yyyy_mm_dd",
  "yyyy_report_week_ww",
  "contract_market_name",
  "cftc_contract_market_code",
  "market_and_exchange_names",
  "contract_units",
] as const;

function parseIntegerField(record: Record<string, unknown>, field: string, context: string): number {
  const raw = record[field];
  if (typeof raw !== "string" || !/^-?\d+$/.test(raw.trim())) {
    throw new Error(
      `CFTC COT パース失敗: ${context} の ${field} が整数文字列ではありません (様式変更の可能性): ${JSON.stringify(raw)}`
    );
  }
  return Number.parseInt(raw.trim(), 10);
}

function parseAsOfDate(raw: unknown, context: string): string {
  if (typeof raw !== "string") {
    throw new Error(`CFTC COT パース失敗: ${context} の report_date_as_yyyy_mm_dd が文字列ではありません`);
  }
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})T00:00:00\.000$/);
  if (!m) {
    throw new Error(
      `CFTC COT パース失敗: ${context} の report_date_as_yyyy_mm_dd の形式が想定外です (様式変更の可能性): ${raw}`
    );
  }
  return m[1];
}

/**
 * Socrata API の JSON 応答を型付きレコードへ変換する純関数。
 * 様式 (フィールド名・契約名・取引所名・契約単位) が想定と異なれば throw する
 * (ルール2: 欠損/不整合を黙って別の値で埋めない)。
 */
export function parseCftcCotJpyRows(raw: unknown): CftcCotJpyRow[] {
  if (!Array.isArray(raw)) {
    throw new Error("CFTC COT パース失敗: レスポンスが配列ではありません (Socrata API の応答形式が変わった可能性)");
  }
  const rows: CftcCotJpyRow[] = [];
  for (const [i, item] of raw.entries()) {
    const context = `${i}番目の行`;
    if (typeof item !== "object" || item === null) {
      throw new Error(`CFTC COT パース失敗: ${context} がオブジェクトではありません`);
    }
    const record = item as Record<string, unknown>;
    for (const field of REQUIRED_STRING_FIELDS) {
      if (typeof record[field] !== "string") {
        throw new Error(`CFTC COT パース失敗: ${context} に必須フィールド ${field} がありません (様式変更の可能性)`);
      }
    }
    const contractCode = (record.cftc_contract_market_code as string).trim();
    const tracked = CFTC_TRACKED_CONTRACTS.find((c) => c.code === contractCode);
    if (!tracked) {
      // クエリで追跡対象2契約のみに絞っているので通常は来ないが、
      // 来た場合に黙って捨てず失敗させる (ルール2)。
      throw new Error(`CFTC COT パース失敗: 追跡対象外の契約コードが応答に含まれています: ${contractCode}`);
    }
    const contractName = (record.contract_market_name as string).trim();
    if (contractName !== tracked.expectedContractName) {
      throw new Error(
        `CFTC COT パース失敗: 契約コード ${contractCode} の contract_market_name が想定と異なります ` +
          `(想定: "${tracked.expectedContractName}" / 実際: "${contractName}") — CFTC 側で銘柄名/コード割当が変わった可能性`
      );
    }
    const exchangeAndMarketName = (record.market_and_exchange_names as string).trim();
    if (!exchangeAndMarketName.includes(tracked.expectedExchangeSubstring)) {
      throw new Error(
        `CFTC COT パース失敗: 契約コード ${contractCode} の取引所名に "${tracked.expectedExchangeSubstring}" が含まれません: ${exchangeAndMarketName}`
      );
    }
    const contractUnits = (record.contract_units as string).trim();
    if (!contractUnits.includes(tracked.expectedContractUnitsSubstring)) {
      throw new Error(
        `CFTC COT パース失敗: 契約コード ${contractCode} の contract_units が想定と異なります ` +
          `(想定に "${tracked.expectedContractUnitsSubstring}" を含む / 実際: "${contractUnits}") — 契約単位変更の可能性`
      );
    }
    rows.push({
      asOfDate: parseAsOfDate(record.report_date_as_yyyy_mm_dd, context),
      reportWeekLabel: (record.yyyy_report_week_ww as string).trim(),
      contractCode,
      contractName,
      exchangeAndMarketName,
      contractUnits,
      openInterestAll: parseIntegerField(record, "open_interest_all", context),
      noncommLong: parseIntegerField(record, "noncomm_positions_long_all", context),
      noncommShort: parseIntegerField(record, "noncomm_positions_short_all", context),
      commLong: parseIntegerField(record, "comm_positions_long_all", context),
      commShort: parseIntegerField(record, "comm_positions_short_all", context),
      nonreptLong: parseIntegerField(record, "nonrept_positions_long_all", context),
      nonreptShort: parseIntegerField(record, "nonrept_positions_short_all", context),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 期間判定 (週次) と「まだ公表されていない」の判定
// ---------------------------------------------------------------------------

const ET_PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

interface EtWallClock {
  /** ET の暦日を UTC 正午に固定した Date (暦日演算専用。時刻としての意味は持たない) */
  civilDate: Date;
  hour: number;
  minute: number;
}

function getEtWallClock(now: Date): EtWallClock {
  const parts = Object.fromEntries(
    ET_PARTS_FORMATTER.formatToParts(now)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value])
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  if ([year, month, day, hour, minute].some((v) => Number.isNaN(v))) {
    throw new Error(`CFTC COT: America/New_York の時刻分解に失敗しました (Intl 応答異常): ${now.toISOString()}`);
  }
  return { civilDate: new Date(Date.UTC(year, month - 1, day, 12)), hour, minute };
}

function civilDateToISO(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface CftcCotExpectedPeriod {
  /** 直近で公表されているはずのデータ基準日 (火曜, YYYY-MM-DD) */
  asOfDate: string;
  /** その基準日を公表する回の公表日 (金曜, YYYY-MM-DD、ET) */
  releaseDate: string;
}

/**
 * 「今」の時点で最新公表済みのはずのデータ基準日 (直前火曜) を判定する純関数。
 * CFTC は毎週金曜 ET 15:30 に、直前火曜終値時点のデータを公表する。
 * 米国の祝日等による実際のずれは考慮しない (呼び出し側が実測の最新日と
 * 突き合わせて判定する。祝日でずれても「実測 < 期待」にしかならないため
 * 安全側に倒れる — determineCftcCotAvailability を参照)。
 */
export function determineExpectedCftcCotPeriod(now: Date): CftcCotExpectedPeriod {
  const { civilDate, hour, minute } = getEtWallClock(now);
  const weekday = civilDate.getUTCDay(); // 0=日曜 .. 2=火曜 .. 5=金曜
  const daysSinceTuesday = (weekday - 2 + 7) % 7;
  const recentTuesday = new Date(civilDate.getTime() - daysSinceTuesday * MS_PER_DAY);
  const releaseDateThisCycle = new Date(recentTuesday.getTime() + 3 * MS_PER_DAY); // 火曜+3日=金曜

  const isPastReleaseDay = civilDate.getTime() > releaseDateThisCycle.getTime();
  const isReleaseDayAndPastTime =
    civilDate.getTime() === releaseDateThisCycle.getTime() &&
    (hour > RELEASE_HOUR_ET || (hour === RELEASE_HOUR_ET && minute >= RELEASE_MINUTE_ET));
  const releasedAlready = isPastReleaseDay || isReleaseDayAndPastTime;

  const asOfDate = releasedAlready ? recentTuesday : new Date(recentTuesday.getTime() - 7 * MS_PER_DAY);
  const releaseDate = releasedAlready
    ? releaseDateThisCycle
    : new Date(releaseDateThisCycle.getTime() - 7 * MS_PER_DAY);

  return { asOfDate: civilDateToISO(asOfDate), releaseDate: civilDateToISO(releaseDate) };
}

export type CftcCotAvailability =
  | { status: "published"; asOfDate: string }
  | { status: "not_yet_published"; expectedAsOfDate: string; expectedReleaseDate: string; reason: string };

/**
 * 実測できた「契約キーごとの最新基準日」と期待値を突き合わせ、
 * まだ公表されていないのかを判定する純関数。
 * 実測日が期待日以上なら published (米国祝日等で期待より遅れて公表された
 * 場合も、実測日は期待日より新しくなるので published 側に落ちる=安全側)。
 */
export function determineCftcCotAvailability(
  now: Date,
  latestAsOfDatesByContract: Readonly<Partial<Record<CftcCotContractKey, string>>>
): CftcCotAvailability {
  const expected = determineExpectedCftcCotPeriod(now);
  const dates = Object.values(latestAsOfDatesByContract).filter((d): d is string => typeof d === "string");
  if (dates.length === 0) {
    return {
      status: "not_yet_published",
      expectedAsOfDate: expected.asOfDate,
      expectedReleaseDate: expected.releaseDate,
      reason: "取得できたデータが0件でした (API応答が空)",
    };
  }
  const maxDate = dates.reduce((a, b) => (a > b ? a : b));
  if (maxDate < expected.asOfDate) {
    return {
      status: "not_yet_published",
      expectedAsOfDate: expected.asOfDate,
      expectedReleaseDate: expected.releaseDate,
      reason:
        `直近の公表想定日 ${expected.asOfDate} (公表日 ${expected.releaseDate} ET 15:30) 時点のデータが` +
        `まだ反映されていません (取得できた最新の基準日: ${maxDate})`,
    };
  }
  return { status: "published", asOfDate: maxDate };
}

// ---------------------------------------------------------------------------
// 指標定義
// ---------------------------------------------------------------------------

/** 縦長の観測ログに書く際の「何を測るか」の統制語彙 (計画書の分類に合わせる) */
export type MoneyflowMeasureType =
  | "net_flow"
  | "gross_turnover"
  | "holdings_stock"
  | "positions"
  | "fund_flow"
  | "estimated"
  | "price_only";

export interface CftcCotIndicatorDefinition {
  key: string;
  displayName: string;
  /** この機能のどの要件 (R1〜R4) に対応するか */
  requirements: readonly string[];
  measures: MoneyflowMeasureType;
  /** 投資初心者向けの平易な説明 (1〜3文、可能なら実測の数値例つき) */
  plainDescription: string;
  /** 財務的に正確な定義 */
  definition: string;
  unit: string;
  sourceUrl: string;
  usageTerms: string;
  frequency: string;
  limitations: string;
}

type CftcCotMetricKey = "noncomm_net" | "noncomm_long" | "noncomm_short" | "comm_net" | "open_interest";

interface CftcCotMetricSpec {
  key: CftcCotMetricKey;
  labelSuffix: string;
  plainDescription: (c: CftcCotContractInfo) => string;
  definition: (c: CftcCotContractInfo) => string;
  value: (row: CftcCotJpyRow) => number;
}

// 2026-09-22 時点の実測値 (本ファイルの fixture でも検証済み) を具体例として使う。
const METRIC_SPECS: readonly CftcCotMetricSpec[] = [
  {
    key: "noncomm_net",
    labelSuffix: "非商業筋(投機筋)ネットポジション",
    plainDescription: (c) =>
      `CME上場の${c.displayName}について、投機目的の大口トレーダー(非商業筋)の買い建玉から売り` +
      `建玉を差し引いたネット値。例えば2026-09-22時点の円先物では買い建玉19.2万枚・売り建玉12.0万枚で` +
      `ネット+7.2万枚の「買い越し」(円高方向への強気)。実際のお金の出入りではなく、その週時点の建玉` +
      `(ポジション)残高の差にすぎない点に注意。`,
    definition: (c) =>
      `CFTC(米国先物取引委員会)が毎週金曜(米国東部時間15:30)に、直前火曜終値時点の建玉を集計・公表` +
      `する Commitments of Traders (Legacy, Futures Only) レポートのうち、${c.displayName}の非商業筋` +
      `(non-commercial、投機目的の大口トレーダーとして届出された区分)の買い建玉(noncomm_positions_` +
      `long_all)から売り建玉(noncomm_positions_short_all)を引いた値。フロー(資金の新規流出入額)では` +
      `なくストック(その時点の残高)であり、週次の増減にはロールオーバーやスプレッドポジションの解消` +
      `も混在するため、そのまま資金の純流入額とは解釈できない。`,
    value: (row) => row.noncommLong - row.noncommShort,
  },
  {
    key: "noncomm_long",
    labelSuffix: "非商業筋 買い建玉",
    plainDescription: (c) =>
      `CME上場の${c.displayName}について、投機目的の大口トレーダー(非商業筋)が保有する買い建玉の枚数` +
      `そのもの(2026-09-22時点の円先物で約19.2万枚)。売り建玉と合わせて見ることでネット方向が分かる。`,
    definition: (c) =>
      `${c.displayName}の Legacy Futures Only レポートにおける非商業筋区分の買い建玉` +
      `(noncomm_positions_long_all)。直前火曜終値時点の残高(ストック)。`,
    value: (row) => row.noncommLong,
  },
  {
    key: "noncomm_short",
    labelSuffix: "非商業筋 売り建玉",
    plainDescription: (c) =>
      `CME上場の${c.displayName}について、投機目的の大口トレーダー(非商業筋)が保有する売り建玉の枚数` +
      `そのもの(2026-09-22時点の円先物で約12.0万枚)。買い建玉と合わせて見ることでネット方向が分かる。`,
    definition: (c) =>
      `${c.displayName}の Legacy Futures Only レポートにおける非商業筋区分の売り建玉` +
      `(noncomm_positions_short_all)。直前火曜終値時点の残高(ストック)。`,
    value: (row) => row.noncommShort,
  },
  {
    key: "comm_net",
    labelSuffix: "商業筋(実需筋)ネットポジション",
    plainDescription: (c) =>
      `CME上場の${c.displayName}について、実需のヘッジ目的で取引すると届け出た商業筋の買い建玉から` +
      `売り建玉を差し引いたネット値。非商業筋と符号が逆になりやすい(投機筋が買い越すと、反対側の実需` +
      `筋は売り越しになりやすい)。これも建玉残高の差であり資金の出入り額そのものではない。`,
    definition: (c) =>
      `${c.displayName}の Legacy Futures Only レポートにおける商業筋(commercial)区分の買い建玉` +
      `(comm_positions_long_all)から売り建玉(comm_positions_short_all)を引いた値。ストック(残高)。`,
    value: (row) => row.commLong - row.commShort,
  },
  {
    key: "open_interest",
    labelSuffix: "建玉残高合計",
    plainDescription: (c) =>
      `CME上場の${c.displayName}の、全トレーダー区分(非商業筋+商業筋+未報告)を合計した建玉残高` +
      `そのもの(2026-09-22時点の円先物で約37.9万枚)。市場全体の参加度合いの目安。`,
    definition: (c) =>
      `${c.displayName}の Legacy Futures Only レポートにおける open_interest_all の値そのもの。` +
      `直前火曜終値時点の建玉残高合計。`,
    value: (row) => row.openInterestAll,
  },
] as const;

function buildIndicatorDefinitions(): CftcCotIndicatorDefinition[] {
  const defs: CftcCotIndicatorDefinition[] = [];
  for (const contract of CFTC_TRACKED_CONTRACTS) {
    for (const metric of METRIC_SPECS) {
      defs.push({
        key: `cftc_cot_${contract.key}_${metric.key}`,
        displayName: `CFTC COT ${contract.displayName} ${metric.labelSuffix}`,
        requirements: ["R3", "R4"],
        measures: "positions",
        plainDescription: metric.plainDescription(contract),
        definition: metric.definition(contract),
        unit: CONTRACT_UNIT_LABEL,
        sourceUrl: CFTC_COT_HUMAN_REPORT_URL,
        usageTerms: CFTC_USAGE_TERMS,
        frequency: CFTC_FREQUENCY,
        limitations: CFTC_LIMITATIONS,
      });
    }
  }
  return defs;
}

/** この取得元が提供する指標の定義一覧 (10件 = 2契約 × 5指標) */
export const CFTC_COT_JPY_INDICATORS: readonly CftcCotIndicatorDefinition[] = buildIndicatorDefinitions();

// ---------------------------------------------------------------------------
// 観測ログ用の縦長レコード
// ---------------------------------------------------------------------------

export interface MoneyflowObservationRecord {
  period: { type: "week"; asOfDate: string };
  indicatorKey: string;
  /** 区分 (投資部門/資産クラス/国地域/商品など) */
  category: string;
  value: number;
  unit: string;
  /** 「資金フロー」という目的に対する近似指標かどうか (値自体の精度ではない) */
  isApproximate: boolean;
  /** 統計的推定値かどうか (CFTC COT はそのまま集計された実測値なので常に false) */
  isEstimated: boolean;
}

/**
 * パース済み行を、観測ログに書き込む縦長レコードへ変換する純関数。
 * 1行(1契約×1週)につき METRIC_SPECS の数だけレコードを展開する。
 */
export function toCftcCotObservationRecords(rows: readonly CftcCotJpyRow[]): MoneyflowObservationRecord[] {
  const records: MoneyflowObservationRecord[] = [];
  for (const row of rows) {
    const contract = CFTC_TRACKED_CONTRACTS.find((c) => c.code === row.contractCode);
    if (!contract) {
      throw new Error(`CFTC COT: 追跡対象外の契約コードの行が渡されました: ${row.contractCode}`);
    }
    const period = { type: "week" as const, asOfDate: row.asOfDate };
    for (const metric of METRIC_SPECS) {
      records.push({
        period,
        indicatorKey: `cftc_cot_${contract.key}_${metric.key}`,
        category: contract.category,
        value: metric.value(row),
        unit: CONTRACT_UNIT_LABEL,
        isApproximate: true,
        isEstimated: false,
      });
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// 取得の統合関数
// ---------------------------------------------------------------------------

export interface CftcCotJpyResolveOk {
  status: "ok";
  asOfDate: string;
  rows: CftcCotJpyRow[];
  /** この基準日に行が無かった追跡対象契約 (通常は空。欠測を黙って埋めない) */
  missingContracts: CftcCotContractKey[];
  records: MoneyflowObservationRecord[];
  /** ルール6のアーカイブ入力を組むために保持する、取得時点の生レスポンス */
  rawResponseText: string;
  requestUrl: string;
}

export type CftcCotJpyResolveResult =
  | CftcCotJpyResolveOk
  | Extract<CftcCotAvailability, { status: "not_yet_published" }>;

/**
 * 最新データを取得し、パース・期間判定まで行う統合関数。
 * 「まだ公表されていない」場合は throw せず、そのことを表す値を返す
 * (ルール2: 明示的に未取得を型で表現する)。
 */
export async function resolveCftcCotJpy(
  options: { now?: Date; fetchImpl?: typeof fetch; limit?: number } = {}
): Promise<CftcCotJpyResolveResult> {
  const now = options.now ?? new Date();
  const { url, text } = await fetchCftcCotJpyRawText(options.limit ?? DEFAULT_FETCH_LIMIT, options.fetchImpl ?? fetch);
  const raw = JSON.parse(text) as unknown;
  const rows = parseCftcCotJpyRows(raw);

  const latestByContract: Partial<Record<CftcCotContractKey, string>> = {};
  for (const contract of CFTC_TRACKED_CONTRACTS) {
    const contractDates = rows.filter((r) => r.contractCode === contract.code).map((r) => r.asOfDate);
    if (contractDates.length > 0) {
      latestByContract[contract.key] = contractDates.reduce((a, b) => (a > b ? a : b));
    }
  }

  const availability = determineCftcCotAvailability(now, latestByContract);
  if (availability.status === "not_yet_published") {
    return availability;
  }

  const { asOfDate } = availability;
  const rowsAtAsOf = rows.filter((r) => r.asOfDate === asOfDate);
  const missingContracts = CFTC_TRACKED_CONTRACTS.filter(
    (c) => !rowsAtAsOf.some((r) => r.contractCode === c.code)
  ).map((c) => c.key);

  return {
    status: "ok",
    asOfDate,
    rows: rowsAtAsOf,
    missingContracts,
    records: toCftcCotObservationRecords(rowsAtAsOf),
    rawResponseText: text,
    requestUrl: url,
  };
}

// ---------------------------------------------------------------------------
// ルール6: Notion 一次データ記録の入力 (実際の recordPrimaryData 呼び出しは
// 統合担当の ingest スクリプト側が行う。ここでは入力を組む純関数のみ提供する)
// ---------------------------------------------------------------------------

export interface CftcCotJpyArchiveInput {
  service: string;
  key: string;
  source: string;
  metadata: Record<string, unknown>;
  files: Array<{ bytes: Uint8Array; filename: string; contentType: string }>;
}

export function cftcCotJpyArchiveInput(params: {
  asOfDate: string;
  rows: readonly CftcCotJpyRow[];
  rawResponseText: string;
  requestUrl: string;
}): CftcCotJpyArchiveInput {
  const { asOfDate, rows, rawResponseText, requestUrl } = params;
  const bytes = new TextEncoder().encode(rawResponseText);
  return {
    service: "moneyflow",
    key: `cftc-cot-jpy-${asOfDate}`,
    source: requestUrl,
    metadata: {
      asOfDate,
      contracts: rows.map((r) => ({ code: r.contractCode, name: r.contractName })),
      rowCount: rows.length,
      bytes: bytes.byteLength,
    },
    files: [
      {
        bytes,
        filename: `cftc-cot-jpy-${asOfDate}.json`,
        contentType: "application/json",
      },
    ],
  };
}
