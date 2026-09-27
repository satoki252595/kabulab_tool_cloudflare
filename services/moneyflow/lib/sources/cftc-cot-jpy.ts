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
  /**
   * contract_units が完全一致すべき値 (契約単位・乗数変更の検知用)。
   * 部分一致だと "(NIKKEI INDEX X JPY 100)" のような乗数変更 (1枚あたりの想定元本が
   * 変わり、枚数の時系列が不連続になる) を素通りさせるため、完全一致で比較する。
   */
  readonly expectedContractUnits: string;
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
    expectedContractUnits: "(CONTRACTS OF JPY 12,500,000)",
    category: "資産クラス｜為替(円、CME上場先物)",
  },
  {
    code: "240743",
    key: "nikkei225_yen",
    displayName: "日経平均先物 円建て (CME、NIKKEI STOCK AVERAGE YEN DENOM)",
    expectedContractName: "NIKKEI STOCK AVERAGE YEN DENOM",
    expectedExchangeSubstring: "CHICAGO MERCANTILE EXCHANGE",
    expectedContractUnits: "(NIKKEI INDEX X JPY 500)",
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
    if (contractUnits !== tracked.expectedContractUnits) {
      throw new Error(
        `CFTC COT パース失敗: 契約コード ${contractCode} の contract_units が想定と異なります ` +
          `(想定: "${tracked.expectedContractUnits}" / 実際: "${contractUnits}") — 契約単位・乗数変更の可能性`
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
  // hour12:false だと実装によって深夜0時台を "24" と返すことがあるため、0〜23 を明示する。
  hourCycle: "h23",
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
 * 実測日が期待日以上なら published。米国祝日等で公表が翌営業日へずれた
 * 場合は、ずれている間は実測日が期待日より古くなるので not_yet_published
 * (実際にまだ公表されていない) になり、公表後の再実行で published になる。
 * 契約ごとの基準日が1件も無い (API応答が空) のは未公表ではなく異常なので throw する。
 */
export function determineCftcCotAvailability(
  now: Date,
  latestAsOfDatesByContract: Readonly<Partial<Record<CftcCotContractKey, string>>>
): CftcCotAvailability {
  const expected = determineExpectedCftcCotPeriod(now);
  const dates = Object.values(latestAsOfDatesByContract).filter((d): d is string => typeof d === "string");
  if (dates.length === 0) {
    // 追跡対象2契約は数十年分の履歴があるため、基準日降順クエリの応答が空なのは
    // 「まだ公表されていない」ではなく異常 (契約コード変更・データセット廃止・
    // クエリ不整合など)。not_yet_published に丸めると取込が毎週黙ってスキップされ
    // 続け、運用者が気づけない (ルール2) ため失敗させる。
    throw new Error(
      `CFTC COT: 追跡対象契約 (${CFTC_TRACKED_CONTRACTS.map((c) => c.code).join(", ")}) の行が1件も` +
        `取得できませんでした (API応答が空)。未公表ではなく、契約コード変更・データセット廃止・` +
        `クエリ不整合の可能性があります (期待していた基準日: ${expected.asOfDate})`
    );
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

/** バルーンヘルプの具体例に使う、契約ごとの実測値 (2026-09-22 時点、本ファイルの fixture でも検証済み)。 */
interface CftcCotExampleSnapshot {
  asOfDate: string;
  noncommLong: number;
  noncommShort: number;
  commLong: number;
  commShort: number;
  openInterestAll: number;
  /** 非商業筋の買い越し(ネットロング)が何を意味するかの、契約種別ごとに正しい方向解釈。 */
  netLongInterpretation: string;
  /**
   * 商業筋ネットと非商業筋ネットの関係について、その契約の実データで確かめた事実。
   * 「商業筋は投機筋の反対側に立つ」は契約によって成り立たない (日経平均先物円建てでは
   * 両者とも買い越しで、売り越し側は小口の未報告区分) ため、契約共通の一般論にしない。
   */
  commNetContext: string;
}

// 通貨先物(円)と株価指数先物(日経平均)とでは「買い越し」が示す意味が全く異なる
// (前者は為替の方向、後者は指数の方向) ため、契約ごとに別々の実測値・解釈を持たせる。
// 単一のテンプレート文に数値だけ埋め込むと、片方の契約の実測値・解釈がもう片方にも
// そのまま出力されてしまう (契約間の使い回しバグ) ため、必ずこの Map 経由で参照する。
// commNetContext の「8週すべて」は fixture (2026-08-04〜2026-09-22 の8週) の実測で
// テストが確かめている。
const CFTC_COT_EXAMPLE_SNAPSHOTS: Readonly<Record<CftcCotContractKey, CftcCotExampleSnapshot>> = {
  jpy: {
    asOfDate: "2026-09-22",
    noncommLong: 192_274,
    noncommShort: 120_292,
    commLong: 143_954,
    commShort: 220_368,
    openInterestAll: 378_701,
    netLongInterpretation: "円高方向への強気(円先物を買う=将来の円高・ドル安を見込むポジション)",
    commNetContext:
      "円先物では2026-08-04〜2026-09-22の8週すべてで商業筋と非商業筋のネットが逆向きで、" +
      "投機筋の反対側に実需筋が立つ形になっていた",
  },
  nikkei225_yen: {
    asOfDate: "2026-09-22",
    noncommLong: 4_199,
    noncommShort: 2_654,
    commLong: 11_364,
    commShort: 6_758,
    openInterestAll: 21_974,
    netLongInterpretation:
      "日経平均の先高観を示す強気ポジション(株価指数先物のため、円相場の方向とは無関係)",
    commNetContext:
      "この契約では2026-08-04〜2026-09-22の8週すべてで商業筋も非商業筋と同じ買い越しで、" +
      "売り越しだったのは報告基準未満の小口(未報告区分)だけだった(「実需筋は投機筋の逆」とは限らない)",
  },
};

function cftcCotExampleFor(c: CftcCotContractInfo): CftcCotExampleSnapshot {
  return CFTC_COT_EXAMPLE_SNAPSHOTS[c.key];
}

/** 建玉数を「1,234枚」形式で表記する (万単位への丸めはしない=正確な実測値をそのまま示す)。 */
function formatContractCount(n: number): string {
  return `${n.toLocaleString("ja-JP")}枚`;
}

/** ネット建玉を「+1,234枚」/「-1,234枚」形式で表記する。 */
function formatSignedContractCount(n: number): string {
  return `${n >= 0 ? "+" : ""}${formatContractCount(n)}`;
}

function netDirectionLabel(n: number): "買い越し" | "売り越し" | "買いと売りが同数" {
  if (n > 0) return "買い越し";
  if (n < 0) return "売り越し";
  return "買いと売りが同数";
}

const METRIC_SPECS: readonly CftcCotMetricSpec[] = [
  {
    key: "noncomm_net",
    labelSuffix: "非商業筋(投機筋)ネットポジション",
    plainDescription: (c) => {
      const ex = cftcCotExampleFor(c);
      const net = ex.noncommLong - ex.noncommShort;
      return (
        `CME上場の${c.displayName}について、投機目的の大口トレーダー(非商業筋)の買い建玉から売り` +
        `建玉を差し引いたネット値。例えば${ex.asOfDate}時点では買い建玉${formatContractCount(ex.noncommLong)}・` +
        `売り建玉${formatContractCount(ex.noncommShort)}でネット${formatSignedContractCount(net)}の` +
        `「${netDirectionLabel(net)}」(${ex.netLongInterpretation})。` +
        `実際のお金の出入りではなく、その週時点の建玉(ポジション)残高の差にすぎない点に注意。`
      );
    },
    definition: (c) =>
      `CFTC(米国先物取引委員会)が毎週金曜(米国東部時間15:30)に、直前火曜終値時点の建玉を集計・公表` +
      `する Commitments of Traders (Legacy, Futures Only) レポートのうち、${c.displayName}の非商業筋` +
      `(non-commercial。報告義務のある大口トレーダーのうち、CFTC がヘッジ目的の商業筋に分類しなかった` +
      `区分で、主に投機目的の参加者)の買い建玉(noncomm_positions_long_all)から売り建玉` +
      `(noncomm_positions_short_all)を引いた値。限月間の買い・売りの両建て(スプレッド)は別集計で含まない。` +
      `フロー(資金の新規流出入額)ではなくストック(その時点の残高)であり、週次の増減にはロールオーバーや` +
      `スプレッドポジションの解消も混在するため、そのまま資金の純流入額とは解釈できない。`,
    value: (row) => row.noncommLong - row.noncommShort,
  },
  {
    key: "noncomm_long",
    labelSuffix: "非商業筋 買い建玉",
    plainDescription: (c) => {
      const ex = cftcCotExampleFor(c);
      return (
        `CME上場の${c.displayName}について、投機目的の大口トレーダー(非商業筋)が保有する買い建玉の枚数` +
        `そのもの(${ex.asOfDate}時点で${formatContractCount(ex.noncommLong)})。売り建玉と合わせて見ることで` +
        `ネット方向が分かる。`
      );
    },
    definition: (c) =>
      `${c.displayName}の Legacy Futures Only レポートにおける非商業筋区分の買い建玉` +
      `(noncomm_positions_long_all、スプレッドは含まない)。直前火曜終値時点の残高(ストック)。`,
    value: (row) => row.noncommLong,
  },
  {
    key: "noncomm_short",
    labelSuffix: "非商業筋 売り建玉",
    plainDescription: (c) => {
      const ex = cftcCotExampleFor(c);
      return (
        `CME上場の${c.displayName}について、投機目的の大口トレーダー(非商業筋)が保有する売り建玉の枚数` +
        `そのもの(${ex.asOfDate}時点で${formatContractCount(ex.noncommShort)})。買い建玉と合わせて見ることで` +
        `ネット方向が分かる。`
      );
    },
    definition: (c) =>
      `${c.displayName}の Legacy Futures Only レポートにおける非商業筋区分の売り建玉` +
      `(noncomm_positions_short_all、スプレッドは含まない)。直前火曜終値時点の残高(ストック)。`,
    value: (row) => row.noncommShort,
  },
  {
    key: "comm_net",
    labelSuffix: "商業筋(実需筋)ネットポジション",
    plainDescription: (c) => {
      const ex = cftcCotExampleFor(c);
      const net = ex.commLong - ex.commShort;
      const noncommNet = ex.noncommLong - ex.noncommShort;
      const relation = Math.sign(net) === Math.sign(noncommNet) ? "と同じ向き" : "とは逆向き";
      return (
        `CME上場の${c.displayName}について、本業の価格変動リスクをヘッジする目的の大口トレーダー(商業筋)の` +
        `買い建玉から売り建玉を差し引いたネット値(建玉残高の差であり、資金の出入り額ではない)。` +
        `例えば${ex.asOfDate}時点では買い建玉${formatContractCount(ex.commLong)}・売り建玉` +
        `${formatContractCount(ex.commShort)}でネット${formatSignedContractCount(net)}の「${netDirectionLabel(net)}」で、` +
        `同時点の非商業筋(ネット${formatSignedContractCount(noncommNet)})${relation}。${ex.commNetContext}。`
      );
    },
    definition: (c) =>
      `${c.displayName}の Legacy Futures Only レポートにおける商業筋(commercial。報告義務のある大口` +
      `トレーダーのうち、CFTC がヘッジ目的と分類した区分)の買い建玉(comm_positions_long_all)から売り建玉` +
      `(comm_positions_short_all)を引いた値。ストック(残高)。非商業筋・商業筋・未報告(報告基準未満の小口)` +
      `の3区分のネットを足すと常にゼロになる(先物の買いと売りは同数)が、どの区分が反対側に立つかは契約・` +
      `時期によって異なる。`,
    value: (row) => row.commLong - row.commShort,
  },
  {
    key: "open_interest",
    labelSuffix: "建玉残高合計",
    plainDescription: (c) => {
      const ex = cftcCotExampleFor(c);
      return (
        `CME上場の${c.displayName}で、まだ決済されずに残っている契約の総数(${ex.asOfDate}時点で` +
        `${formatContractCount(ex.openInterestAll)})。1枚の契約には必ず買い手と売り手が1人ずついるので、` +
        `買い側だけ(=売り側だけ)を数えた枚数であり、買いと売りを足した数ではない。市場全体の参加度合いの目安。`
      );
    },
    definition: (c) =>
      `${c.displayName}の Legacy Futures Only レポートにおける open_interest_all の値そのもの。` +
      `直前火曜終値時点の建玉残高合計で、全区分の買い建玉(非商業筋のスプレッドを含む)の合計=売り建玉の` +
      `合計に等しい。ストック(残高)。`,
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
  const parsedFile: unknown = JSON.parse(rawResponseText);
  if (!Array.isArray(parsedFile)) {
    throw new Error("CFTC COT アーカイブ入力: rawResponseText が JSON 配列ではありません (Socrata 応答形式の変化)");
  }
  return {
    service: "moneyflow",
    key: `cftc-cot-jpy-${asOfDate}`,
    source: requestUrl,
    metadata: {
      asOfDate,
      contracts: rows.map((r) => ({ code: r.contractCode, name: r.contractName })),
      // 保存するファイルは直近数週 × 2契約の生応答 (通常16行) で、観測に使うのは
      // asOfDate の行 (通常2行) だけ。両者を取り違えないよう別々に記録する。
      rowCountAtAsOfDate: rows.length,
      rowCountInFile: parsedFile.length,
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
