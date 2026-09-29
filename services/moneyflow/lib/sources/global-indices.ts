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
 * そのまま渡せる唯一の既存エクスポートである。認証 (crumb/cookie、401 時の
 * crumb 再取得)・`YAHOO_PROXY_BASE` 経由のプロキシ (自宅/CI IP の 429 回避) は
 * クライアント側の既存ロジックに委ねる (このモジュールでは再実装しない)。
 * クライアントは 429 等の HTTP エラーを再試行も throw もせずそのまま返すため、
 * `fetchGlobalIndexWeeklyChart` 側で HTTP ステータスと様式を検査し、異常な
 * 応答本文を「取得成功」として返さない (一次データとして保管させない)。
 *
 * ## 実機確認 (2026-09-27, YAHOO_PROXY_BASE 経由)
 * - 対象16銘柄のうち15銘柄は `interval=1wk` で 200 が返り、週次 OHLC が
 *   取得できた (fixtures/global-indices-<key>-2026-09-27.json)。
 * - **TOPIX (`^TOPX` ほか `998405.T` 等の複数候補) は Yahoo Finance Chart
 *   API 上に存在せず、全て `404 Not Found` (`No data found, symbol may be
 *   delisted`)** であることを実機確認した
 *   (fixtures/global-indices-symbol-not-found-2026-09-27.json はその実際の
 *   404 レスポンス本体)。計画書の例示に `^TOPX` が挙がっていたが、この
 *   シンボルは存在しないため架空値で埋めず、実在する代替として代表的な
 *   国内上場 TOPIX 連動 ETF「NEXT FUNDS TOPIX連動型上場投信」
 *   (コード1306, `1306.T`) の**取引所での市場価格 (終値)** を **近似 (ETF
 *   price proxy)** として採用する (Yahoo が返すのは売買で付いた市場価格で
 *   あり、運用会社が算出する基準価額 (NAV) ではない)。ETF なので信託報酬
 *   控除・追随誤差・市場価格と基準価額の乖離により TOPIX 指数そのものとは
 *   完全には一致しない — `GLOBAL_INDEX_CATALOG` の `isApproximate: true` /
 *   指標定義の `limitations` で明示し、生の指数値と混同されないようにする
 *   (CLAUDE.md ルール1: 実在しない値の捏造ではなく、実在する近似データを
 *   出典明記のうえ使う)。
 *
 * ## 週足バーと「取得時点スナップショット」バーの扱い
 * Yahoo の `interval=1wk` チャートは、各週について「取引所現地時間の月曜0時
 * タイムスタンプの週足バー」を1本ずつ返し、さらに配列末尾に**取得時点の
 * スナップショット** (タイムスタンプ = `meta.regularMarketTime`、値 =
 * `regularMarketPrice`) を1本付け足す (2026-09-27 取得の全16フィクスチャで
 * 確認: 確定済みの週は各1本、直近週だけ「週足バー + スナップショット」の2本)。
 * 株価指数では両者の close はほぼ一致するが、**為替ではスナップショットが
 * 土曜日の気配値**であり週足バーの終値と一致しない (JPY=X: 週足 158.811 に
 * 対しスナップショット 157.185 @2026-09-26T04:21Z)。過去の週は週足バーしか
 * 無いため、直近週だけスナップショットを使うと「今週=スナップショット、
 * 前週=週足終値」という別定義の値を比べることになり、しかも同じ週の値が
 * 取得タイミング (翌週の足ができた後はスナップショットが消える) で変わる。
 * そこで**各週の代表値は常に Yahoo の週足バーの終値**とし、スナップショットは
 * 常に除外する (`groupBarsByWeek`)。週足バーの close が null (欠落) の週でも
 * スナップショットで代用しない — 代用すると上記の別定義の値 (為替なら土曜の
 * 気配値) が黙って週末値に混ざるため (ルール2)。その週は週足なしとして扱う。
 *
 * ## 対象週の決め方 (直近の「終わった」週)
 * `resolveLatestWeeklyChange(snapshot, now)` は `now` 時点で終わっている直近の
 * ISO 週 (`resolveLatestCompletedWeek`) を対象に、その週と1つ前の週足を比べる。
 * 「データ中の最新の週がまだ終わっていなければ未公表」とする旧実装は、翌週の
 * 最初の足ができた時点で確定済みの週を二度と返せず、東京・ソウル (現地月曜
 * 9:00 = UTC 月曜 0:00 に取引開始) では確定週を返せる時間帯が実質ゼロだった。
 *
 * ## 設計 (取得元ごとに独立した部品)
 * 1. `fetchGlobalIndexWeeklyChart` — 取得 (URL解決は `GLOBAL_INDEX_CATALOG`
 *    の固定シンボル表を引くだけなので自明。JPX のような月次ファイル差し替えは
 *    無い)。
 * 2. `parseGlobalIndexWeeklyChart` — 生 JSON テキストから型付きレコードを
 *    返す純関数パーサ。様式が想定と違えば throw する (ルール2)。
 * 3. `resolveObservationPeriod` / `isPeriodObservable` /
 *    `resolveLatestCompletedWeek` / `resolveWeeklyChangeForPeriod` /
 *    `resolveLatestWeeklyChange` — 期間の解決・「その週が終わったか」の判定・
 *    指定週の前週比の算出。
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
      "「NEXT FUNDS TOPIX連動型上場投信」(1306) の取引所での市場価格 (終値) で代替する " +
      "(運用会社が毎日算出する基準価額ではない)。信託報酬控除・追随誤差・市場価格と基準価額の" +
      "乖離により、TOPIX 指数の値そのものとは完全には一致しない近似値。",
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
 * 取得先は作らない)。この関数 (クライアント) は認証・`YAHOO_PROXY_BASE` 経由の
 * プロキシを内部で処理するが、HTTP エラー (404/429/5xx) でも Response をそのまま
 * 返す (再試行も throw もしない)。そこでここで
 *   - HTTP ステータスが 2xx でなければ throw する
 *   - 本文を (2) のパーサに通し、様式が想定外なら throw する
 * の2点を検査し、検査を通った本文だけを返す。呼び出し側 (取込) はこの戻り値を
 * そのまま一次データとして保管してよい — エラー応答の本文を「取得成功」として
 * 保管すると、同じ冪等キーの再実行が保管済みの壊れた本文を再解析し続けて
 * 永久に失敗するため (ルール2・ルール6)。
 *
 * @param key   `GLOBAL_INDEX_CATALOG` のキー (例: "gspc")
 * @param range Yahoo の `range` パラメータ。週次で最低2週分の確定値が要る
 *              ため既定は "3mo" (約13本、休場等の欠落があっても十分な余裕)
 * @throws HTTP エラー、または本文が想定した様式でない場合
 */
export async function fetchGlobalIndexWeeklyChart(
  key: string,
  range = "3mo"
): Promise<GlobalIndexFetchResult> {
  const entry = catalogEntry(key);
  const res = await fetchYahooChartRaw(entry.yahooSymbol, range, "1wk", false);
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(
      `fetchGlobalIndexWeeklyChart [${key}=${entry.yahooSymbol}]: HTTP ${res.status} ` +
        `(本文先頭: ${raw.slice(0, 300)})`
    );
  }
  // 様式検査のためだけに解析する (結果は捨てる。保管・再解析は raw から行う)。
  parseGlobalIndexWeeklyChart(raw, key, entry.yahooSymbol);
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
   * `meta.regularMarketTime` (UTC 秒)。週足配列の末尾に付く「取得時点
   * スナップショット」バー (タイムスタンプがこの値と一致する) の識別に使う。
   */
  regularMarketTimeSec: number;
  /**
   * 取引所の IANA タイムゾーン名 (`meta.exchangeTimezoneName`。例:
   * "America/New_York", "Asia/Tokyo")。週の帰属判定 (`groupBarsByWeek`) に使う。
   * `meta.gmtoffset` は**取得時点の**オフセットでしかなく、夏時間の切替を
   * またいだ過去のバーには使えない (詳細は `groupBarsByWeek` のコメント参照)。
   */
  exchangeTimezoneName: string;
  /** 昇順 (古い順)。直近週の取得時点スナップショットを含む */
  bars: readonly RawWeeklyBar[];
}

/** IANA タイムゾーン名として解釈できなければ throw する (推測で UTC 等に倒さない)。 */
function assertTimeZone(timeZone: string, path: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch (e) {
    throw new Error(`${path} が有効な IANA タイムゾーン名ではありません: ${timeZone}`, { cause: e });
  }
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
 *   (対象週の足が欠落すれば `resolveWeeklyChangeForPeriod` が
 *   `no_bar_in_period` を返し、前週側の足が1本も無ければ throw する)。
 * - `exchangeTimezoneName` が IANA タイムゾーン名として解釈できなければ
 *   throw する (週の帰属を推測で UTC 等に倒さない)。
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

  if (chart.error !== null && chart.error !== undefined) {
    // code/description を既定値で補わず、エラー本体をそのまま載せる (ルール2)。
    throw new Error(`${label}: Chart API エラー: ${JSON.stringify(chart.error)}`);
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

  const exchangeTimezoneName = asString(meta.exchangeTimezoneName, `${label}.meta.exchangeTimezoneName`);
  assertTimeZone(exchangeTimezoneName, `${label}.meta.exchangeTimezoneName`);

  return {
    key,
    yahooSymbol: symbol,
    currency: asString(meta.currency, `${label}.meta.currency`),
    instrumentType: asString(meta.instrumentType, `${label}.meta.instrumentType`),
    // 金先物 (GC=F) 等は longName を持たない実データがある。欠損は null のまま返す。
    longName: typeof meta.longName === "string" ? meta.longName : null,
    regularMarketPrice: asNumber(meta.regularMarketPrice, `${label}.meta.regularMarketPrice`),
    regularMarketTimeSec: asNumber(meta.regularMarketTime, `${label}.meta.regularMarketTime`),
    exchangeTimezoneName,
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

/**
 * `now` 時点で終わっている直近の ISO 週 (月曜〜日曜) を返す。週の終わりは
 * `isPeriodObservable` と同じく日曜 23:59:59.999 (UTC) で判定する。
 * 例: now=2026-09-24 (W39 の木曜) → 2026-W38 / now=2026-09-28T00:00Z → 2026-W39。
 */
export function resolveLatestCompletedWeek(now: Date): ObservationPeriod {
  if (Number.isNaN(now.getTime())) {
    throw new Error("resolveLatestCompletedWeek: 不正な now です (Invalid Date)");
  }
  const current = resolveObservationPeriod("week", now);
  // now がちょうど週末最終ミリ秒 (日曜 23:59:59.999Z) なら、その週自体が終わっている。
  if (isPeriodObservable(current, now).observable) return current;
  const previousSunday = new Date(`${current.start}T00:00:00.000Z`);
  previousSunday.setUTCDate(previousSunday.getUTCDate() - 1);
  return resolveObservationPeriod("week", previousSunday);
}

interface WeeklyCloseInternal {
  period: ObservationPeriod;
  /** その週の Yahoo 週足バーの終値 */
  close: number;
  /** 代表値に使った週足バーのタイムスタンプ (ISO, UTC。取引所現地の週初0時) */
  weeklyBarTimestamp: string;
}

/**
 * 生のバー列を、取引所現地時間の暦週 (ISO週, 月曜始まり) でグループ化し、
 * 各週の代表値 (= Yahoo の週足バーの終値) を返す。
 *
 * **週の帰属は取引所の IANA タイムゾーンで判定する**: バーのタイムスタンプは
 * UTC 秒だが、週の境界 (月曜0時) は各取引所の**現地時間**で決まる。日本
 * (JST=UTC+9) の月曜0時は UTC では前日日曜15時であり、UTC 日付のまま ISO 週を
 * 求めると1つ前の週に誤って分類される (実機検証で `^N225` の前週比が 0 に
 * なる不具合として発覚)。当初の修正は `meta.gmtoffset` (取得時点の UTC
 * オフセット) を全バーに足していたが、夏時間の終了後 (米国は 2026-11-01、
 * 欧州は 2026-10-25 以降) に取得すると、夏時間中に刻まれた過去の週足
 * (例: 米国は UTC 04:00 = EDT 0時) が冬時間のオフセットで「日曜 23時」と
 * 読まれて1週前にずれ、同じ不具合 (前週比 0・週ラベルずれ) が再発する。
 * そこで `Intl.DateTimeFormat` に `exchangeTimezoneName` を渡し、各バーの
 * 時刻における現地暦日を夏時間込みで求める。
 *
 * **代表値は週足バー**: Yahoo は直近週について週足バーに加えて「取得時点の
 * スナップショット」(タイムスタンプ = `regularMarketTime`) を返す。
 * スナップショットはグループ化の前に**常に**除外する (モジュール冒頭コメント
 * 参照。為替では土曜の気配値で週足終値と一致しない)。「同じ週に週足バーが
 * あれば除外」という条件付きにすると、週足バーの close が null で落ちた週では
 * スナップショットが唯一のバーとして残り、別定義の値 (JPY=X なら 158.811 では
 * なく土曜の 157.185) が黙って週末値として使われてしまう (ルール2)。除外後に
 * 週足が無い週は存在しない週として扱い、対象週なら `no_bar_in_period` になる。
 * 除外後も1週に2本以上残る場合は様式変更とみなして throw する (どれかを勝手に
 * 選ばない: ルール2)。
 */
function groupBarsByWeek(snapshot: GlobalIndexChartSnapshot): WeeklyCloseInternal[] {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: snapshot.exchangeTimezoneName,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  const localCalendarDate = (timestampSec: number): Date => {
    const parts = formatter.formatToParts(new Date(timestampSec * 1000));
    const pick = (type: "year" | "month" | "day"): number => {
      const part = parts.find((p) => p.type === type);
      const n = part ? Number(part.value) : Number.NaN;
      if (!Number.isInteger(n)) {
        throw new Error(
          `groupBarsByWeek [${snapshot.key}]: ${snapshot.exchangeTimezoneName} の現地日付 (${type}) を ` +
            `取り出せません (timestamp=${timestampSec})`
        );
      }
      return n;
    };
    return new Date(Date.UTC(pick("year"), pick("month") - 1, pick("day")));
  };

  const weeklyBarsOnly = snapshot.bars.filter((b) => b.timestampSec !== snapshot.regularMarketTimeSec);
  const byWeek = new Map<string, { period: ObservationPeriod; bars: RawWeeklyBar[] }>();
  for (const bar of weeklyBarsOnly) {
    const period = resolveObservationPeriod("week", localCalendarDate(bar.timestampSec));
    const group = byWeek.get(period.label);
    if (group) {
      group.bars.push(bar);
    } else {
      byWeek.set(period.label, { period, bars: [bar] });
    }
  }

  const weeks: WeeklyCloseInternal[] = [];
  for (const { period, bars } of byWeek.values()) {
    if (bars.length !== 1) {
      throw new Error(
        `groupBarsByWeek [${snapshot.key}]: ${period.label} の週足バーが ${bars.length} 本です ` +
          `(スナップショット除外後に1本であるべき。様式変更の可能性): ${JSON.stringify(bars)}`
      );
    }
    const bar = bars[0]!;
    weeks.push({
      period,
      close: bar.close,
      weeklyBarTimestamp: new Date(bar.timestampSec * 1000).toISOString(),
    });
  }
  return weeks.sort((a, b) => a.period.start.localeCompare(b.period.start));
}

export interface WeeklyChangeObservation {
  period: ObservationPeriod;
  /** 比較相手の週 (通常は前週。前週が全日休場なら、それより前で週足がある直近の週) */
  previousPeriod: ObservationPeriod;
  close: number;
  previousClose: number;
  /** close - previousClose (指数ポイント・為替レート差・利回りポイント差など単位はそのまま) */
  changeAbsolute: number;
  /** (changeAbsolute / previousClose) * 100 */
  changePercent: number;
  /** 代表値に使った週足バーのタイムスタンプ (ISO, UTC) */
  weeklyBarTimestamp: string;
}

/**
 * - `observed`: 対象週の週足があり、前週比を計算できた。
 * - `no_bar_in_period`: 対象週の週足が無い (その市場が全日休場だった週、または
 *   取得データにまだ反映されていない)。値を補わず行を出さない正常系のスキップ
 *   (呼び出し側の取込ログに理由を残すこと)。
 */
export type WeeklyChangeResult =
  | { status: "observed"; observation: WeeklyChangeObservation }
  | { status: "no_bar_in_period"; period: ObservationPeriod; reason: string };

/**
 * (3) 指定した週 (`targetPeriod`, 週次) の週足終値と、その1つ前の週足終値から
 * 前週比を求める純関数 (`now` に依存しない — 保管済みの一次データを後から
 * 再解析しても同じ結果になる)。
 *
 * 前提: `snapshot` は対象週が**終わった後**に取得したものであること (週の途中で
 * 取得したデータを渡すと、その時点の途中経過値を週末値として扱ってしまう)。
 * 取込では `resolveLatestCompletedWeek(now)` で対象週を決めてから取得する。
 *
 * - 対象週の週足が無ければ `status: "no_bar_in_period"` を返す (throw しない)。
 * - 対象週より前の週足が取得範囲に無い (range が短すぎる) 場合は throw する
 *   (ルール2: 黙って前週比を諦めたり 0 で埋めたりしない)。
 */
export function resolveWeeklyChangeForPeriod(
  snapshot: GlobalIndexChartSnapshot,
  targetPeriod: ObservationPeriod
): WeeklyChangeResult {
  if (targetPeriod.granularity !== "week") {
    throw new Error(
      `resolveWeeklyChangeForPeriod [${snapshot.key}]: 週次以外の期間は扱えません: ${targetPeriod.granularity}`
    );
  }
  const expected = resolveObservationPeriod("week", new Date(`${targetPeriod.start}T00:00:00.000Z`));
  if (expected.label !== targetPeriod.label || expected.end !== targetPeriod.end) {
    throw new Error(
      `resolveWeeklyChangeForPeriod [${snapshot.key}]: 期間の開始日とラベルが食い違っています ` +
        `(${JSON.stringify(targetPeriod)}、開始日から求めた週=${JSON.stringify(expected)})`
    );
  }

  const weekly = groupBarsByWeek(snapshot);
  const first = weekly[0];
  const last = weekly[weekly.length - 1];
  if (!first || !last) {
    throw new Error(`resolveWeeklyChangeForPeriod [${snapshot.key}]: 週足が0件です`);
  }
  const index = weekly.findIndex((w) => w.period.label === targetPeriod.label);
  if (index === -1) {
    return {
      status: "no_bar_in_period",
      period: targetPeriod,
      reason:
        `${snapshot.key} (${snapshot.yahooSymbol}) の ${targetPeriod.label} の週足がありません ` +
        `(全日休場、または取得データに未反映。取得範囲: ${first.period.label}〜${last.period.label})。`,
    };
  }
  if (index === 0) {
    throw new Error(
      `resolveWeeklyChangeForPeriod [${snapshot.key}]: ${targetPeriod.label} より前の週足が取得範囲に無く、` +
        `前週比を計算できません (range を広げて再取得すること)。`
    );
  }

  const current = weekly[index]!;
  const previous = weekly[index - 1]!;
  const changeAbsolute = current.close - previous.close;
  const changePercent = (changeAbsolute / previous.close) * 100;

  return {
    status: "observed",
    observation: {
      period: current.period,
      previousPeriod: previous.period,
      close: current.close,
      previousClose: previous.close,
      changeAbsolute,
      changePercent,
      weeklyBarTimestamp: current.weeklyBarTimestamp,
    },
  };
}

/**
 * (3) `now` 時点で終わっている直近の週 (`resolveLatestCompletedWeek(now)`) の
 * 前週比を返す (`resolveWeeklyChangeForPeriod` の薄いラッパ)。
 *
 * 旧実装は「データ中の最新の暦週が終わっていなければ未公表」を返していたため、
 * 翌週の最初の足ができた後は確定済みの週を返せなかった (東京・ソウルは現地
 * 月曜 9:00 = UTC 月曜 0:00 に取引が始まるので、確定週を返せる時間帯が実質
 * ゼロ)。対象週は `now` から決め、データ側の最新週には依存しない。
 */
export function resolveLatestWeeklyChange(
  snapshot: GlobalIndexChartSnapshot,
  now: Date
): WeeklyChangeResult {
  return resolveWeeklyChangeForPeriod(snapshot, resolveLatestCompletedWeek(now));
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
  "(`src/shared/yahoo/client.ts`) を再利用し、新しい取得先は追加していない。個人利用のみ。";

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
          `${entry.displayName}の週次終値 (その週の最後の取引日の終値) の前週比騰落率。` +
          `例えば+2%なら「先週末から今週末で2%値上がりした」という意味。株価指数(または` +
          `その連動ETF)の価格の変化率であり、市場に入った資金の額(フロー)ではない — 新しい` +
          `お金が入らなくても、値上がりだけで上がる。`,
        unit: "%",
        limitations:
          `価格変動だけを表し、資金の純流出入額は測れない。休場日の違いにより各国で対象週の` +
          `最終取引日がずれる(比較は週次ラベル基準の近似)。${proxySuffix}`,
      };
    case "fx": {
      const FX_LIMITATIONS =
        "為替は土日を除きほぼ24時間取引されるため、株式市場ほど明確な『週の区切り』が" +
        "ない。Yahoo Finance の週足 (英国時間の月曜0時始まり) の終値を週末値とする近似で、" +
        "土日に配信される気配値は使わない。";
      // 通貨ペアごとに換算方向が異なる (「円安/円高」は円を含むペアにしか
      // 使えない表現) ため、円を含まないペア (EURUSD=X 等) にまで同じ説明文を
      // 使い回さない (ルール1・ルール7: 誤った定義を初心者向け説明に混在
      // させない)。未対応のペアが増えたら、ここに明示的な分岐を追加すること
      // (default で吸収しない: ルール2)。
      if (entry.key === "jpy") {
        return {
          description:
            `${entry.displayName}相場 (JPY=X, 1米ドル=何円か) の週次終値の前週比騰落率。` +
            `例えば週間で+1%なら「1ドルを買うのに必要な円が1%増えた」=ドル高・円安が` +
            `進んだという意味 (数値が上がるほど円の価値は下がる)。為替の売買代金(フロー)` +
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
 * 各銘柄の `resolveWeeklyChangeForPeriod` / `resolveLatestWeeklyChange` の結果群を、
 * 観測ログ (資金フロー｜観測ログ) に書く縦長の行に変換する純関数。
 * `status: "no_bar_in_period"` の銘柄は行を出さない (値を補わずスキップ。呼び出し
 * 側の取込ログに `reason` を別途記録することを想定)。Notion I/O はここでは行わない。
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
