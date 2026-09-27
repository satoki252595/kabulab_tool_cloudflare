/**
 * 世界の主要株価指数・為替・金利・金・原油 (Phase 5: 世界の概況)
 *
 * 取得内容: 米欧亜の代表的な株価指数、ドル円・ユーロドル、金・原油先物、
 * 米10年国債利回りの週次終値・週次騰落率。「世界のお金の流れ」そのもの
 * (資金の純流出入額) ではなく、いずれも価格水準・利回り水準というストック
 * 指標であり、この取得元単独では純流入額は測れない (指標定義の
 * `limitations` に明記する)。R4 (日本⇔海外) の「世界の概況」の近似材料として、
 * 統合担当が既存 D1 (`swing_market_context` 等) の指標と並べて表示する
 * ための入力値を提供する。Notion 書込はこのモジュールの範囲外。
 *
 * ## 取得経路 (既存 Yahoo クライアントの再利用。新しい取得先は作らない)
 * `src/shared/yahoo/client.ts` が公開する `fetchYahooChartRaw(symbol, range,
 * interval, events)` をそのまま呼ぶ。この関数は Chart API の生 Response を
 * 返すだけで、JP 株コード専用の正規化 (`normalizeSymbol`) を経由しない —
 * 指数 (`^GSPC` 等) や FX ペア (`JPY=X` 等、末尾 `=X` は JP_STOCK/INDEX/
 * FUTURES いずれのパターンにも一致せず `fetchChart` 経由だと弾かれる) を
 * そのまま渡せる唯一の既存エクスポートである。認証 (crumb/cookie)・
 * `YAHOO_PROXY_BASE` 経由のプロキシ・429 リトライは全てクライアント側の
 * 既存ロジックに委ねる (このモジュールでは再実装しない)。
 *
 * ## 実機確認 (2026-09-27, YAHOO_PROXY_BASE 経由)
 * - 対象16銘柄のうち15銘柄は `interval=1wk` で 200 が返り、週次 OHLC が
 *   取得できた (fixtures/global-indices-<key>-2026-09-27.json)。
 * - **TOPIX (`^TOPX` ほか `998405.T` 等の複数候補) は Yahoo Finance Chart
 *   API 上に存在せず、全て `404 Not Found` (`No data found, symbol may be
 *   delisted`)** であることを実機確認した
 *   (fixtures/global-indices-symbol-not-found-2026-09-27.json はその実際の
 *   404 レスポンス本体)。計画書の例示に `^TOPX` が挙がっていたが、この
 *   シンボルは存在しないため架空値で埋めず、実在する代替として最も出来高の
 *   大きい国内上場 TOPIX 連動 ETF「NEXT FUNDS TOPIX連動型上場投信」
 *   (コード1306, `1306.T`) の基準価額を **近似 (ETF price proxy)** として
 *   採用する。ETF なので信託報酬控除・追随誤差により TOPIX 指数そのものとは
 *   完全には一致しない — `GLOBAL_INDEX_CATALOG` の `isApproximate: true` /
 *   指標定義の `limitations` で明示し、生の指数値と混同されないようにする
 *   (CLAUDE.md ルール1: 実在しない値の捏造ではなく、実在する近似データを
 *   出典明記のうえ使う)。
 *
 * ## 週次バーの「まだ確定していない当該週」の扱い
 * Yahoo の `interval=1wk` チャートは、直近の (まだ終わっていない) 週についても
 * 「その週の月曜始値タイムスタンプのバー」と「取得時点の最新値スナップショット
 * (当日日時のタイムスタンプ、株価は `regularMarketPrice` と同値)」の**2本が
 * 同じ暦週に属して両方含まれる**ことを実機確認した (例: `^GSPC` で月曜
 * 2026-09-21 のバーと金曜 2026-09-25 のバーが両方あり、どちらも close が
 * 現在値 7743.41 で一致 = まだ確定していない当該週のスナップショット)。
 * 週の完了判定をタイムスタンプ間隔 (差分が604800秒かどうか) だけで行うのは
 * 脆弱なため、`resolveObservationPeriod`/`isPeriodObservable` (ISO週, 月曜
 * 始まり) で暦週ごとにバーをグループ化し、「同一週内で最後に観測された値」を
 * その週の代表値として採用したうえで、`isPeriodObservable` で「その週が
 * 終わっているか」を判定する (§3)。
 *
 * ## 設計 (取得元ごとに独立した部品)
 * 1. `fetchGlobalIndexWeeklyChart` — 取得 (URL解決は `GLOBAL_INDEX_CATALOG`
 *    の固定シンボル表を引くだけなので自明。JPX のような月次ファイル差し替えは
 *    無い)。
 * 2. `parseGlobalIndexWeeklyChart` — 生 JSON テキストから型付きレコードを
 *    返す純関数パーサ。様式が想定と違えば throw する (ルール2)。
 * 3. `resolveObservationPeriod` / `isPeriodObservable` / `resolveLatestWeeklyChange`
 *    — 期間の解決と「まだ公表されていない (=その週がまだ終わっていない)」判定。
 * 4. `GLOBAL_INDEX_INDICATORS` — この取得元の指標定義。
 * 5. `toGlobalIndexObservationRows` — 縦長の観測ログ行を組み立てる。
 * 6. `globalIndicesArchiveInput` — ルール6 (Notion 一次データアーカイブ) の
 *    入力を組む純関数。実際の `recordPrimaryData()` 呼び出しは統合担当が行う。
 */
import { fetchYahooChartRaw } from "../../../../src/shared/yahoo/client.js";

// ---------------------------------------------------------------------------
// (1) 対象銘柄カタログ + 取得
// ---------------------------------------------------------------------------

export type GlobalIndexCategory = "index" | "fx" | "commodity" | "rate";

export interface GlobalIndexCatalogEntry {
  /** 指標キーの接尾辞 (例: "gspc" → 指標キー "global_gspc_weekly_change_pct") */
  key: string;
  /** Yahoo Finance のシンボル (`fetchYahooChartRaw` にそのまま渡す) */
  yahooSymbol: string;
  displayName: string;
  category: GlobalIndexCategory;
  /** 観測ログの `segment` に使うラベル (国・地域名、通貨ペア名、商品名) */
  segmentLabel: string;
  /** 生の指数値そのものではない近似 (代替銘柄) かどうか */
  isApproximate: boolean;
  /** isApproximate=true の場合のみ: 何の代替かの注記 */
  proxyNote?: string;
}

/**
 * 2026-09-27 実機確認済みの固定カタログ。ドキュメント冒頭の実機確認結果の通り
 * `^TOPX` (TOPIX 指数そのもの) は Yahoo Finance Chart API に存在しないため、
 * 国内上場 TOPIX 連動 ETF (`1306.T`) を近似として採用する。
 */
export const GLOBAL_INDEX_CATALOG: readonly GlobalIndexCatalogEntry[] = [
  { key: "gspc", yahooSymbol: "^GSPC", displayName: "S&P500", category: "index", segmentLabel: "米国", isApproximate: false },
  { key: "ixic", yahooSymbol: "^IXIC", displayName: "NASDAQ総合指数", category: "index", segmentLabel: "米国", isApproximate: false },
  { key: "stoxx50e", yahooSymbol: "^STOXX50E", displayName: "ユーロ・ストックス50", category: "index", segmentLabel: "ユーロ圏", isApproximate: false },
  { key: "ftse", yahooSymbol: "^FTSE", displayName: "FTSE100", category: "index", segmentLabel: "英国", isApproximate: false },
  { key: "gdaxi", yahooSymbol: "^GDAXI", displayName: "DAX", category: "index", segmentLabel: "ドイツ", isApproximate: false },
  { key: "hsi", yahooSymbol: "^HSI", displayName: "ハンセン指数", category: "index", segmentLabel: "香港", isApproximate: false },
  { key: "sse", yahooSymbol: "000001.SS", displayName: "上海総合指数", category: "index", segmentLabel: "中国本土", isApproximate: false },
  { key: "ks11", yahooSymbol: "^KS11", displayName: "KOSPI総合指数", category: "index", segmentLabel: "韓国", isApproximate: false },
  { key: "bsesn", yahooSymbol: "^BSESN", displayName: "SENSEX", category: "index", segmentLabel: "インド", isApproximate: false },
  { key: "n225", yahooSymbol: "^N225", displayName: "日経平均株価", category: "index", segmentLabel: "日本", isApproximate: false },
  {
    key: "topix-etf",
    yahooSymbol: "1306.T",
    displayName: "TOPIX (連動ETFで代替)",
    category: "index",
    segmentLabel: "日本",
    isApproximate: true,
    proxyNote:
      "TOPIX 指数そのものは Yahoo Finance Chart API 上に存在しない (2026-09-27実機確認、" +
      "`^TOPX`/`998405.T` 等の候補は全て404 Not Found)。国内上場の代表的な TOPIX 連動 ETF" +
      "「NEXT FUNDS TOPIX連動型上場投信」(1306) の基準価額で代替する。信託報酬控除・" +
      "追随誤差により TOPIX 指数の値そのものとは完全には一致しない近似値。",
  },
  { key: "jpy", yahooSymbol: "JPY=X", displayName: "ドル円 (USD/JPY)", category: "fx", segmentLabel: "為替(ドル円)", isApproximate: false },
  { key: "eurusd", yahooSymbol: "EURUSD=X", displayName: "ユーロドル (EUR/USD)", category: "fx", segmentLabel: "為替(ユーロドル)", isApproximate: false },
  { key: "gold", yahooSymbol: "GC=F", displayName: "金先物 (COMEX)", category: "commodity", segmentLabel: "金", isApproximate: false },
  { key: "crudeoil", yahooSymbol: "CL=F", displayName: "WTI原油先物", category: "commodity", segmentLabel: "原油(WTI)", isApproximate: false },
  { key: "tnx", yahooSymbol: "^TNX", displayName: "米10年国債利回り", category: "rate", segmentLabel: "米国", isApproximate: false },
] as const;

function catalogEntry(key: string): GlobalIndexCatalogEntry {
  const entry = GLOBAL_INDEX_CATALOG.find((e) => e.key === key);
  if (!entry) {
    throw new Error(`catalogEntry: 未知のカタログキーです: ${key}`);
  }
  return entry;
}

export interface GlobalIndexFetchResult {
  /** カタログキー (`GlobalIndexCatalogEntry.key`) */
  key: string;
  yahooSymbol: string;
  /** レスポンスボディの生テキスト (パース前。フィクスチャ化・アーカイブ用) */
  raw: string;
  /** 取得時刻 (ISO 8601, UTC) */
  fetchedAt: string;
}

/**
 * (1) 指定シンボルの週次チャートを取得する。
 *
 * `src/shared/yahoo/client.ts` の `fetchYahooChartRaw` をそのまま使う (新しい
 * 取得先は作らない)。この関数は認証・`YAHOO_PROXY_BASE` 経由のプロキシ・
 * 429時のリトライを内部で処理し、HTTPエラーでも Response をそのまま返す
 * (throw しない) — 様式異常 (404 等) の判定は (2) のパーサ側で行う。
 *
 * @param key   `GLOBAL_INDEX_CATALOG` のキー (例: "gspc")
 * @param range Yahoo の `range` パラメータ。週次で最低2週分の確定値が要る
 *              ため既定は "3mo" (約13本、休場等の欠落があっても十分な余裕)
 */
export async function fetchGlobalIndexWeeklyChart(
  key: string,
  range = "3mo"
): Promise<GlobalIndexFetchResult> {
  const entry = catalogEntry(key);
  const res = await fetchYahooChartRaw(entry.yahooSymbol, range, "1wk", false);
  const raw = await res.text();
  return { key, yahooSymbol: entry.yahooSymbol, raw, fetchedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// (2) パーサ (純関数。生テキスト → 型付きレコード。様式が違えば throw)
// ---------------------------------------------------------------------------

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${label}: JSON として解釈できません (${(e as Error).message})`, { cause: e });
  }
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} がオブジェクトではありません (様式変更の可能性): ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function asNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`${path} が数値ではありません (様式変更の可能性): ${JSON.stringify(value)}`);
  }
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} が文字列ではありません (様式変更の可能性): ${JSON.stringify(value)}`);
  }
  return value;
}

export interface RawWeeklyBar {
  timestampSec: number;
  close: number;
}

export interface GlobalIndexChartSnapshot {
  key: string;
  yahooSymbol: string;
  currency: string;
  instrumentType: string;
  longName: string | null;
  regularMarketPrice: number;
  /**
   * 取引所のUTCオフセット秒 (`meta.gmtoffset`。例: JST=+32400, EDT=-14400)。
   * 週の境界判定 (`groupBarsByWeek`) に使う — 詳細はそちらのコメント参照。
   */
  gmtoffsetSec: number;
  /** 昇順 (古い順)。直近の未確定週分を含む */
  bars: readonly RawWeeklyBar[];
}

/**
 * Chart API の生レスポンス (週次) から型付きスナップショットを作る。
 *
 * - `chart.error` が非 null なら (例: 404 の "symbol may be delisted") その
 *   まま throw する (フィクスチャ:
 *   `fixtures/global-indices-symbol-not-found-2026-09-27.json` が実例)。
 * - `meta.symbol` が期待するシンボルと一致しない、`dataGranularity` が
 *   "1wk" でない、`timestamp`/`close` の配列長が一致しない場合も様式変更と
 *   みなして throw する。
 * - 個々の `close` が null の週 (休場等) は履歴として無視できるため除外する
 *   (直近2週分がこれで欠落した場合は上位の `resolveLatestWeeklyChange` 側で
 *   「確定データ不足」として throw される)。
 */
export function parseGlobalIndexWeeklyChart(
  raw: string,
  key: string,
  expectedYahooSymbol: string
): GlobalIndexChartSnapshot {
  const label = `Yahoo Chart API [${key}=${expectedYahooSymbol}]`;
  const json = parseJson(raw, label);
  const root = asRecord(json, label);
  const chart = asRecord(root.chart, `${label}.chart`);

  if (chart.error) {
    const err = asRecord(chart.error, `${label}.chart.error`);
    const code = typeof err.code === "string" ? err.code : "unknown";
    const description = typeof err.description === "string" ? err.description : JSON.stringify(err);
    throw new Error(`${label}: Chart API エラー (${code}): ${description}`);
  }

  if (!Array.isArray(chart.result) || chart.result.length === 0) {
    throw new Error(`${label}: chart.result が空です (様式変更の可能性)`);
  }
  const result = asRecord(chart.result[0], `${label}.chart.result[0]`);
  const meta = asRecord(result.meta, `${label}.meta`);

  const symbol = asString(meta.symbol, `${label}.meta.symbol`);
  if (symbol !== expectedYahooSymbol) {
    throw new Error(
      `${label}: meta.symbol が期待値と不一致です (期待="${expectedYahooSymbol}", 実際="${symbol}")`
    );
  }
  const dataGranularity = asString(meta.dataGranularity, `${label}.meta.dataGranularity`);
  if (dataGranularity !== "1wk") {
    throw new Error(
      `${label}: meta.dataGranularity が "1wk" ではありません (実際="${dataGranularity}"、様式変更の可能性)`
    );
  }

  if (!Array.isArray(result.timestamp)) {
    throw new Error(`${label}.timestamp が配列ではありません (様式変更の可能性)`);
  }
  const indicators = asRecord(result.indicators, `${label}.indicators`);
  if (!Array.isArray(indicators.quote) || indicators.quote.length === 0) {
    throw new Error(`${label}.indicators.quote が空です (様式変更の可能性)`);
  }
  const quote = asRecord(indicators.quote[0], `${label}.indicators.quote[0]`);
  if (!Array.isArray(quote.close)) {
    throw new Error(`${label}.indicators.quote[0].close が配列ではありません (様式変更の可能性)`);
  }
  const timestamps = result.timestamp as unknown[];
  const closes = quote.close as unknown[];
  if (timestamps.length !== closes.length) {
    throw new Error(
      `${label}: timestamp (${timestamps.length}件) と close (${closes.length}件) の長さが一致しません`
    );
  }
  if (timestamps.length === 0) {
    throw new Error(`${label}: データが0件です`);
  }

  const bars: RawWeeklyBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (close === null || close === undefined) continue; // 休場等の欠落は履歴として無視
    bars.push({
      timestampSec: asNumber(timestamps[i], `${label}.timestamp[${i}]`),
      close: asNumber(close, `${label}.indicators.quote[0].close[${i}]`),
    });
  }
  if (bars.length === 0) {
    throw new Error(`${label}: close が全件 null で有効なバーがありません`);
  }

  return {
    key,
    yahooSymbol: symbol,
    currency: asString(meta.currency, `${label}.meta.currency`),
    instrumentType: asString(meta.instrumentType, `${label}.meta.instrumentType`),
    longName: typeof meta.longName === "string" ? meta.longName : null,
    regularMarketPrice: asNumber(meta.regularMarketPrice, `${label}.meta.regularMarketPrice`),
    gmtoffsetSec: asNumber(meta.gmtoffset, `${label}.meta.gmtoffset`),
    bars,
  };
}

// ---------------------------------------------------------------------------
// (3) 期間の解決と「まだ公表されていない」判定
// ---------------------------------------------------------------------------

export type ObservationGranularity = "day" | "week" | "month" | "quarter" | "year";

export interface ObservationPeriod {
  granularity: ObservationGranularity;
  /** 期間の開始日 (YYYY-MM-DD, UTC) */
  start: string;
  /** 期間の終了日 (YYYY-MM-DD, UTC, inclusive) */
  end: string;
  /** 表示用ラベル (例: "2026-W39") */
  label: string;
}

function toDateKey(d: Date): string {
  const iso = d.toISOString();
  const key = iso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    throw new Error(`toDateKey: 不正な Date から日付キーを作れません (${iso})`);
  }
  return key;
}

function isoWeekInfo(d: Date): { year: number; week: number; monday: Date; sunday: Date } {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7; // Sun=0 -> 7 (月曜始まり)
  date.setUTCDate(date.getUTCDate() + 4 - dayNum); // その週の木曜日
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - 3);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { year: date.getUTCFullYear(), week, monday, sunday };
}

/** 指定した granularity の期間を、`referenceDate` を含む期間として解決する。 */
export function resolveObservationPeriod(
  granularity: ObservationGranularity,
  referenceDate: Date
): ObservationPeriod {
  const y = referenceDate.getUTCFullYear();
  const m = referenceDate.getUTCMonth();

  switch (granularity) {
    case "day": {
      const key = toDateKey(referenceDate);
      return { granularity, start: key, end: key, label: key };
    }
    case "week": {
      const { year, week, monday, sunday } = isoWeekInfo(referenceDate);
      return {
        granularity,
        start: toDateKey(monday),
        end: toDateKey(sunday),
        label: `${year}-W${String(week).padStart(2, "0")}`,
      };
    }
    case "month": {
      const start = new Date(Date.UTC(y, m, 1));
      const end = new Date(Date.UTC(y, m + 1, 0));
      return {
        granularity,
        start: toDateKey(start),
        end: toDateKey(end),
        label: `${y}-${String(m + 1).padStart(2, "0")}`,
      };
    }
    case "quarter": {
      const q = Math.floor(m / 3);
      const start = new Date(Date.UTC(y, q * 3, 1));
      const end = new Date(Date.UTC(y, q * 3 + 3, 0));
      return { granularity, start: toDateKey(start), end: toDateKey(end), label: `${y}-Q${q + 1}` };
    }
    case "year": {
      const start = new Date(Date.UTC(y, 0, 1));
      const end = new Date(Date.UTC(y, 11, 31));
      return { granularity, start: toDateKey(start), end: toDateKey(end), label: `${y}` };
    }
    default: {
      throw new Error(`resolveObservationPeriod: 未対応の granularity です: ${String(granularity)}`);
    }
  }
}

/**
 * 判別可能ユニオンにして「observable=false なら reason は必ずある」ことを型で
 * 保証する (ルール2: `reason` を optional にして呼び出し側で `??` の既定値
 * 埋めを誘発しない設計)。
 */
export type PeriodObservability =
  | { observable: true }
  | { observable: false; reason: string };

/** 対象期間が「まだ終わっていない (=まだ公表されていない)」かどうかを判定する。 */
export function isPeriodObservable(period: ObservationPeriod, now: Date): PeriodObservability {
  const periodEnd = new Date(`${period.end}T23:59:59.999Z`);
  if (Number.isNaN(periodEnd.getTime())) {
    throw new Error(`isPeriodObservable: 不正な period.end です: ${period.end}`);
  }
  if (now.getTime() < periodEnd.getTime()) {
    return {
      observable: false,
      reason: `期間 ${period.label} (終了 ${period.end}) はまだ終わっていません。`,
    };
  }
  return { observable: true };
}

interface WeeklyCloseInternal {
  period: ObservationPeriod;
  close: number;
  timestampSec: number;
  /** この週内で観測された最終時刻 (ISO) */
  asOf: string;
}

/**
 * 生のバー列を暦週 (ISO週, 月曜始まり) でグループ化し、各週内で最後に観測
 * された値をその週の代表値として採用する。Yahoo の週次チャートは、まだ
 * 終わっていない週について「月曜始値バー」と「取得時点の最新値スナップ
 * ショット」の2本を同一暦週内に返すことがあるため (モジュール冒頭コメント
 * 参照)、単純にバー配列をそのまま週次系列として扱うと直近1〜2週の対応が
 * ずれる。この関数がその補正を行う。
 *
 * **タイムゾーン補正が必須**: バーのタイムスタンプは UTC 秒だが、週の境界
 * (月曜0時) は各取引所の**現地時間**で決まる。日本 (JST=UTC+9) の月曜0時は
 * UTC では前日日曜15時であり、これを補正せず `getUTCFullYear/Month/Date`
 * で ISO 週を求めると日曜日の週 (1つ前の週) に誤って分類される。実機検証で
 * `^N225` にこの誤分類が発生し、直近の未確定週の2本 (月曜バーと確定値
 * スナップショット) が別々の週として扱われ、前週比較に本来の前週ではなく
 * 同じ未確定週の値が使われる不具合を確認した (前週比が常に0になる)。
 * `gmtoffsetSec` の分だけタイムスタンプを進めてから UTC 成分を読むことで、
 * 「現地の暦日」を UTC 日付として扱う (`isPeriodObservable` の週末判定は
 * UTC 日境界のままなので、現地時刻ベースの正確な週末とは数時間ずれる近似
 * だが、週の**帰属**自体は正しくなる)。
 */
function groupBarsByWeek(
  bars: readonly RawWeeklyBar[],
  gmtoffsetSec: number
): WeeklyCloseInternal[] {
  const map = new Map<string, WeeklyCloseInternal>();
  for (const bar of bars) {
    const localDate = new Date((bar.timestampSec + gmtoffsetSec) * 1000);
    const period = resolveObservationPeriod("week", localDate);
    const existing = map.get(period.label);
    if (!existing || bar.timestampSec >= existing.timestampSec) {
      map.set(period.label, {
        period,
        close: bar.close,
        timestampSec: bar.timestampSec,
        asOf: new Date(bar.timestampSec * 1000).toISOString(),
      });
    }
  }
  return [...map.values()].sort((a, b) => a.period.start.localeCompare(b.period.start));
}

export interface WeeklyChangeObservation {
  period: ObservationPeriod;
  close: number;
  previousClose: number;
  /** close - previousClose (指数ポイント・為替レート差・利回りポイント差など単位はそのまま) */
  changeAbsolute: number;
  /** (changeAbsolute / previousClose) * 100 */
  changePercent: number;
  asOf: string;
}

export type WeeklyChangeResult =
  | { status: "observed"; observation: WeeklyChangeObservation }
  | { status: "not_yet_published"; period: ObservationPeriod; reason: string };

/**
 * (3) スナップショットから「直近の確定済み週の騰落」を解決する。
 *
 * - 直近の暦週がまだ終わっていない (`isPeriodObservable` が false) 場合は
 *   `status: "not_yet_published"` を返す (これは正常系。呼び出し側は次回
 *   実行までスキップしてよい)。
 * - 確定済みの週が2週分未満しかない (取得期間が短すぎる/様式変更で大半の
 *   バーが欠落した等) 場合は throw する (ルール2: 黙って欠損を埋めない)。
 */
export function resolveLatestWeeklyChange(
  snapshot: GlobalIndexChartSnapshot,
  now: Date
): WeeklyChangeResult {
  const weekly = groupBarsByWeek(snapshot.bars, snapshot.gmtoffsetSec);
  if (weekly.length === 0) {
    throw new Error(`resolveLatestWeeklyChange [${snapshot.key}]: 週次データが0件です`);
  }

  const latestCalendarWeek = weekly[weekly.length - 1]!;
  const observability = isPeriodObservable(latestCalendarWeek.period, now);
  if (!observability.observable) {
    return {
      status: "not_yet_published",
      period: latestCalendarWeek.period,
      reason: observability.reason,
    };
  }

  if (weekly.length < 2) {
    throw new Error(
      `resolveLatestWeeklyChange [${snapshot.key}]: 確定済みの週が1週分しかなく、` +
        `前週比を計算できません (range を広げて再取得すること)。`
    );
  }
  const previousCalendarWeek = weekly[weekly.length - 2]!;
  const changeAbsolute = latestCalendarWeek.close - previousCalendarWeek.close;
  const changePercent = (changeAbsolute / previousCalendarWeek.close) * 100;

  return {
    status: "observed",
    observation: {
      period: latestCalendarWeek.period,
      close: latestCalendarWeek.close,
      previousClose: previousCalendarWeek.close,
      changeAbsolute,
      changePercent,
      asOf: latestCalendarWeek.asOf,
    },
  };
}

// ---------------------------------------------------------------------------
// (4) 指標定義
// ---------------------------------------------------------------------------

export type MoneyflowRequirement = "R1" | "R2" | "R3" | "R4";

export type MoneyflowFlowType =
  | "net_flow"
  | "gross_turnover"
  | "holdings_stock"
  | "positions"
  | "fund_flow"
  | "estimated"
  | "price_only";

export interface MoneyflowIndicatorDefinition {
  key: string;
  displayName: string;
  requirements: readonly MoneyflowRequirement[];
  flowType: MoneyflowFlowType;
  description: string;
  unit: string;
  sourceUrl: string;
  usageTerms: string;
  frequency: string;
  limitations: string;
}

const YAHOO_FINANCE_URL = "https://finance.yahoo.com/";
const USAGE_TERMS =
  "Yahoo Finance の公開チャートAPI (ログイン・APIキー不要)。既存の統合 Yahoo クライアント " +
  "(`src/shared/yahoo/client.ts`) を再利用し、新しい取得先は追加していない。個人利用のみ " +
  "(kabulab は Notion 個人ダッシュボードとしての利用)。";

function indicatorDescription(entry: GlobalIndexCatalogEntry): {
  description: string;
  unit: string;
  limitations: string;
} {
  const proxySuffix = entry.proxyNote ? ` ${entry.proxyNote}` : "";
  switch (entry.category) {
    case "index":
      return {
        description:
          `${entry.displayName}の週次終値の前週比騰落率。例えば+2%なら「先週末から今週末で` +
          `2%値上がりした」という意味。株価指数(またはその連動ETF)の価格水準そのものであり、` +
          `市場に入った資金の額(フロー)ではない — 値上がりだけでも増える、株式市場でいう時価総額に` +
          `近い「残高(ストック)」の変化率と理解すること。`,
        unit: "%",
        limitations:
          `価格変動だけを表し、資金の純流出入額は測れない。休場日の違いにより各国で対象週の` +
          `最終取引日がずれる(比較は週次ラベル基準の近似)。${proxySuffix}`,
      };
    case "fx": {
      const FX_LIMITATIONS =
        "為替は土日を除きほぼ24時間取引されるため、株式市場ほど明確な『週の区切り』が" +
        "ない近似 (ISO週=月曜〜日曜UTCで区切って集計)。";
      // 通貨ペアごとに換算方向が異なる (「円安/円高」は円を含むペアにしか
      // 使えない表現) ため、円を含まないペア (EURUSD=X 等) にまで同じ説明文を
      // 使い回さない (ルール1・ルール7: 誤った定義を初心者向け説明に混在
      // させない)。未対応のペアが増えたら、ここに明示的な分岐を追加すること
      // (default で吸収しない: ルール2)。
      if (entry.key === "jpy") {
        return {
          description:
            `${entry.displayName}相場 (JPY=X, 1米ドル=何円か) の週次終値の前週比騰落率。` +
            `例えば週間で+1%なら「対ドルで円安が1%進んだ」という意味 (数値が上がる=` +
            `1ドルを買うのに必要な円が増える=円の価値が下がる)。為替の売買代金(フロー)` +
            `ではなく、レート水準の変化率。`,
          unit: "%",
          limitations: FX_LIMITATIONS,
        };
      }
      if (entry.key === "eurusd") {
        return {
          description:
            `${entry.displayName}相場 (EURUSD=X, 1ユーロ=何米ドルか) の週次終値の前週比` +
            `騰落率。例えば週間で+1%なら「ユーロがドルに対して1%値上がりした(ドル安・` +
            `ユーロ高が進んだ)」という意味 — このペアに日本円は含まれない。為替の売買` +
            `代金(フロー)ではなく、レート水準の変化率。`,
          unit: "%",
          limitations: FX_LIMITATIONS,
        };
      }
      throw new Error(
        `indicatorDescription: 未対応の fx カタログキーです (説明文の分岐が未実装): ${entry.key}`
      );
    }
    case "commodity":
      return {
        description:
          `${entry.displayName}価格の週次終値の前週比騰落率。先物価格の変化率であり、` +
          `現物在庫や投資資金の増減(フロー)そのものではない。`,
        unit: "%",
        limitations:
          "限月(直近限月)の価格を使うため、限月交代(ロールオーバー)のタイミングで価格が" +
          "非連続に変化することがある。",
      };
    case "rate":
      return {
        description:
          `${entry.displayName}(年率)の週次終値の前週比変化率。例えば利回りが4.00%から` +
          `4.20%に上がった場合、変化率としては+5%だが、市場実務で言う「0.20ポイント` +
          `(20bp)上昇」とは意味が異なる点に注意 — ポイント差は別途` +
          `「global_tnx_weekly_change_pt」指標を参照すること。利回り自体は債券価格の裏返し` +
          `の指標であり、資金の純流出入額ではない。`,
        unit: "%",
        limitations:
          "相対変化率(%)は利回りの絶対水準が低いほど小さな変化でも大きく見える性質がある" +
          "(例: 1.0%→1.1%は+10%だが、実務上のインパクトは0.1ポイントに過ぎない)。実務での" +
          "議論には併記される「global_tnx_weekly_change_pt」(ポイント差)を使うこと。",
      };
    default: {
      const exhaustive: never = entry.category;
      throw new Error(`indicatorDescription: 未対応の category です: ${String(exhaustive)}`);
    }
  }
}

function buildIndicatorDefinition(entry: GlobalIndexCatalogEntry): MoneyflowIndicatorDefinition {
  const { description, unit, limitations } = indicatorDescription(entry);
  return {
    key: `global_${entry.key}_weekly_change_pct`,
    displayName: `${entry.displayName} 週次騰落率`,
    requirements: ["R4"],
    flowType: "price_only",
    description,
    unit,
    sourceUrl: YAHOO_FINANCE_URL,
    usageTerms: USAGE_TERMS,
    frequency: "週次 (取引週の終値ベース。取得自体はリアルタイムAPIで公表ラグは無い)",
    limitations,
  };
}

/** ^TNX (米10年国債利回り) のみ追加するポイント差指標 (実務標準の "bp" 表現)。 */
const TNX_ENTRY = catalogEntry("tnx");
const TNX_POINT_INDICATOR: MoneyflowIndicatorDefinition = {
  key: "global_tnx_weekly_change_pt",
  displayName: `${TNX_ENTRY.displayName} 週次変化 (ポイント差)`,
  requirements: ["R4"],
  flowType: "price_only",
  description:
    "米10年国債利回り(年率%)の、前週末終値からのポイント差 (絶対差)。例えば4.00%から" +
    "4.20%になった週は+0.20ポイント(市場実務でいう+20bp)。相対変化率(%)ではなく、" +
    "利回りの実際の変化幅そのもの。資金の純流出入額ではなく金利水準の変化を表す。",
  unit: "ポイント(%pt)",
  sourceUrl: YAHOO_FINANCE_URL,
  usageTerms: USAGE_TERMS,
  frequency: "週次 (取引週の終値ベース)",
  limitations: "利回りの変化幅のみを表し、その要因(金融政策・インフレ期待等)は分からない。",
};

/** この取得元の指標定義一覧。カタログの各銘柄 + ^TNX 用のポイント差指標。 */
export const GLOBAL_INDEX_INDICATORS: readonly MoneyflowIndicatorDefinition[] = [
  ...GLOBAL_INDEX_CATALOG.map(buildIndicatorDefinition),
  TNX_POINT_INDICATOR,
];

// ---------------------------------------------------------------------------
// (5) 観測ログの縦長行を組み立てる
// ---------------------------------------------------------------------------

export type MoneyflowSegmentType = "投資部門" | "資産クラス" | "国地域" | "商品";

export interface MoneyflowObservationRow {
  period: string;
  indicatorKey: string;
  segmentType: MoneyflowSegmentType;
  segment: string;
  value: number;
  unit: string;
  /** この値が近似 (代替銘柄・複数取得元の突合等を経ている) かどうか */
  isApproximate: boolean;
  /** この値が推定 (実測値ではなく計算で導出) かどうか */
  isEstimated: boolean;
  sourceUrl: string;
}

/** カテゴリごとに観測ログの区分 (segmentType) を決める。 */
function segmentTypeFor(category: GlobalIndexCategory): MoneyflowSegmentType {
  switch (category) {
    case "index":
    case "rate":
      // 国・地域固有の指標として扱う (株価指数は当該国市場、米金利は米国市場の代理指標)。
      return "国地域";
    case "fx":
    case "commodity":
      // 為替・商品はどの国にも属さない資産クラスとして扱う。
      return "資産クラス";
    default: {
      const exhaustive: never = category;
      throw new Error(`segmentTypeFor: 未対応の category です: ${String(exhaustive)}`);
    }
  }
}

export interface GlobalIndexObservationInput {
  key: string;
  result: WeeklyChangeResult;
}

/**
 * 各銘柄の `resolveLatestWeeklyChange` の結果群を、観測ログ (資金フロー｜
 * 観測ログ) に書く縦長の行に変換する純関数。`status: "not_yet_published"`
 * の銘柄は行を出さない (スキップ。呼び出し側の取込ログに「未公表」として
 * 別途記録することを想定)。Notion I/O はここでは行わない。
 */
export function toGlobalIndexObservationRows(
  inputs: readonly GlobalIndexObservationInput[]
): MoneyflowObservationRow[] {
  const rows: MoneyflowObservationRow[] = [];

  for (const { key, result } of inputs) {
    if (result.status !== "observed") continue;
    const entry = catalogEntry(key);
    const segmentType = segmentTypeFor(entry.category);
    const { observation } = result;

    rows.push({
      period: observation.period.label,
      indicatorKey: `global_${entry.key}_weekly_change_pct`,
      segmentType,
      segment: entry.segmentLabel,
      value: observation.changePercent,
      unit: "%",
      isApproximate: entry.isApproximate,
      isEstimated: false,
      sourceUrl: YAHOO_FINANCE_URL,
    });

    if (entry.key === "tnx") {
      rows.push({
        period: observation.period.label,
        indicatorKey: "global_tnx_weekly_change_pt",
        segmentType,
        segment: entry.segmentLabel,
        value: observation.changeAbsolute,
        unit: "ポイント(%pt)",
        isApproximate: entry.isApproximate,
        isEstimated: false,
        sourceUrl: YAHOO_FINANCE_URL,
      });
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// ルール6: Notion 一次データアーカイブの入力を組む (実際の書込は統合担当が行う)
// ---------------------------------------------------------------------------

export interface GlobalIndexRawBundle {
  /** `fetchGlobalIndexWeeklyChart` の結果一覧 (カタログの全銘柄分を想定) */
  results: readonly GlobalIndexFetchResult[];
}

/**
 * `services/vwap-analysis/lib/margin.ts` の `marginArchiveInput` と同じ型の
 * 純関数。冪等キーは取得日単位 (`global-indices-YYYY-MM-DD`)。1銘柄1レコード
 * にはせず「取得バッチ単位の確定ファイル」1件にまとめる (CLAUDE.md ルール6
 * 「高頻度・大量取得の境界」— 日次実行 × 16銘柄を個別レコード化すると
 * Notion の現実的上限に早く近づくため)。
 */
export function globalIndicesArchiveInput(bundle: GlobalIndexRawBundle): {
  service: string;
  key: string;
  source: string;
  metadata: Record<string, unknown>;
  files: Array<{ bytes: Uint8Array; filename: string; contentType: string }>;
} {
  if (bundle.results.length === 0) {
    throw new Error("globalIndicesArchiveInput: results が空です");
  }
  const dateKey = bundle.results[0]!.fetchedAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throw new Error(
      `globalIndicesArchiveInput: fetchedAt から日付キーを作れません: ${bundle.results[0]!.fetchedAt}`
    );
  }
  const encoder = new TextEncoder();
  return {
    service: "moneyflow",
    key: `global-indices-${dateKey}`,
    source: YAHOO_FINANCE_URL,
    metadata: {
      fetchedAt: bundle.results[0]!.fetchedAt,
      symbols: bundle.results.map((r) => ({ key: r.key, yahooSymbol: r.yahooSymbol })),
    },
    files: bundle.results.map((r) => ({
      bytes: encoder.encode(r.raw),
      filename: `global-indices-${r.key}-${dateKey}.json`,
      contentType: "application/json",
    })),
  };
}
