/**
 * CoinGecko 無料 API (Phase 4: 資産クラス横断 — 暗号資産)
 *
 * 取得内容: 主要暗号資産の価格・時価総額 (円建て)、暗号資産市場全体の時価総額
 * (ドル建て・世界合計)、ステーブルコイン合計時価総額、ビットコイン・ドミナンス。
 * 「暗号資産の推定純資金増減」(JVCEA 預り資産の前月差から価格変動寄与を差し引く)
 * を統合担当が計算するための入力値を提供する。実際の純資金増減の計算・Notion
 * 書込はこのモジュールの範囲外 (統合担当が別途行う)。
 *
 * ## 利用条件・API キー (2026-09-27 時点で実機確認)
 * - `https://api.coingecko.com/api/v3` はログイン・APIキーなしでも 200 を返す
 *   (無料の公開エンドポイント)。ただし匿名アクセスは共有プールでレート制限が
 *   非常に厳しく、本セッションの検証でも数回の連続呼び出しで 429 (Retry-After:
 *   60) を受けた。
 * - 無料の Demo API キー (coingecko.com のダッシュボードでメール登録のみ、
 *   審査なし) を `x-cg-demo-api-key` ヘッダで送ると、レート制限が緩和される
 *   (公式: 月10,000コール / 100コール/分)。本モジュールはキー任意 — 環境変数
 *   `COINGECKO_DEMO_API_KEY` が設定されていれば付与し、無ければ無ヘッダで
 *   呼ぶ (無ヘッダでも技術的には動くため、フォールバックではなく「認証任意の
 *   API仕様どおりの分岐」)。
 * - attribution (「Powered by CoinGecko」の表示、Arial 相当・10pt 以上、
 *   CoinGecko Brand Guidelines 準拠) は個人/商用の別を問わず API 利用時の
 *   一般的な義務として API Terms (https://www.coingecko.com/en/api_terms)
 *   に明記されている ("regardless of the usage plan that you select, you
 *   will still need to comply with the provisions of this API Terms" +
 *   「Powered by CoinGecko」表示の義務条項を 2026-09-27 に本文で確認済み。
 *   「商用利用のみ必須」ではない)。本モジュールはデータ取得層のみで画面を
 *   持たないため、実際の「Powered by CoinGecko」表示は moneyflow の画面
 *   実装時に別途対応が必要 (TODO、指標定義の usageTerms に出典 URL は
 *   必ず持たせている)。
 * - ブラウザ相当 UA を偽装する必要は無い (JPX 等と異なり、CoinGecko の 429 は
 *   UA ではなく呼び出し頻度で決まることを実機確認済み)。代わりに、リポジトリの
 *   ドメインを含む自己申告 UA を送る (biz 側での bot 判定に資するため)。
 *
 * ## 設計 (取得元ごとに独立した部品)
 * 1. `fetchCoinGecko*` — 最新データの URL 解決 + 取得 (このソースは URL が
 *    ほぼ静的なため「解決」は自明。JPX のような月次ファイル差し替えは無い)。
 * 2. `parseCoinGecko*` — 取得した生 JSON テキストから型付きレコードを返す
 *    純関数パーサ。様式が想定と違えば throw する (ルール2)。
 * 3. `resolveObservationPeriod` / `isPeriodObservable` — 期間 (週/月/四半期/
 *    年) の解決と「まだ公表されていない」判定。CoinGecko はリアルタイム API
 *    で公表ラグが無いため、判定基準は「対象期間が終わっているか」のみ。
 * 4. `COINGECKO_GLOBAL_INDICATORS` — この取得元の指標定義。
 * 5. `toCoinGeckoObservationRows` — 縦長の観測ログ行を組み立てる。
 * 6. `coinGeckoArchiveInput` — ルール6 (Notion 一次データアーカイブ) の入力を
 *    組む純関数 (`services/vwap-analysis/lib/margin.ts` の
 *    `marginArchiveInput` と同じ型)。実際の `recordPrimaryData()` 呼び出しは
 *    統合担当が行う。
 */

const COINGECKO_API_BASE = "https://api.coingecko.com/api/v3";

/** ドキュメント (指標定義の出典 URL にも使う) */
export const COINGECKO_DOCS_URL = "https://www.coingecko.com/en/api/documentation";
export const COINGECKO_API_TERMS_URL = "https://www.coingecko.com/en/api_terms";

/**
 * 「主要暗号資産」として追跡する銘柄 (CoinGecko coin id)。ステーブルコイン
 * (tether / usd-coin 等) は時価総額上位だが、別カテゴリ (ステーブルコイン
 * 合計時価総額) で扱うためここには含めない。
 */
export const COINGECKO_MAJOR_COIN_IDS = [
  "bitcoin",
  "ethereum",
  "ripple",
  "solana",
  "dogecoin",
] as const;

const USER_AGENT = "kabulab-moneyflow/0.1 (+https://kabulab-cf.satoki252595.workers.dev/)";

/**
 * ルール3: `COINGECKO_DEMO_API_KEY` の唯一のアクセサ。任意 (未設定でも動く)。
 * `.env.example` に記載済み。
 */
export const coinGeckoEnv = {
  DEMO_API_KEY: (): string | undefined => {
    const v = process.env.COINGECKO_DEMO_API_KEY;
    return v && v.trim() !== "" ? v.trim() : undefined;
  },
};

function coinGeckoHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  };
  if (apiKey) headers["x-cg-demo-api-key"] = apiKey;
  return headers;
}

export interface CoinGeckoFetchResult {
  /** 実際に叩いた URL (来歴用) */
  url: string;
  /** レスポンスボディの生テキスト (パース前。フィクスチャ化・アーカイブ用) */
  raw: string;
  /** 取得時刻 (ISO 8601, UTC) */
  fetchedAt: string;
}

async function fetchJsonText(
  url: string,
  apiKey: string | undefined
): Promise<CoinGeckoFetchResult> {
  const res = await fetch(url, { headers: coinGeckoHeaders(apiKey) });
  if (!res.ok) {
    // 429 はレート制限、4xx/5xx は様式変更や障害の可能性。黙って空データで
    // 続行せず、必ず throw する (ルール2)。
    const head =
      `CoinGecko HTTP エラー: ${res.status} ${res.statusText} (${url})` +
      (res.status === 429
        ? " — レート制限 (Demo API キー未設定なら COINGECKO_DEMO_API_KEY の設定を検討するか、間隔を空けて再試行すること)"
        : "");
    // 本文の読取失敗を空文字に丸めて握りつぶさない (ルール2): 失敗したこと
    // 自体をエラーに残し、原因を cause で辿れるようにする。
    let body: string;
    try {
      body = await res.text();
    } catch (e) {
      throw new Error(`${head} — エラー応答の本文の読み取りにも失敗しました (${(e as Error).message})`, {
        cause: e,
      });
    }
    throw new Error(`${head} body=${body === "" ? "(空)" : body.slice(0, 300)}`);
  }
  const raw = await res.text();
  return { url, raw, fetchedAt: new Date().toISOString() };
}

/** (1) 暗号資産市場全体のスナップショットを取得する (`GET /global`)。 */
export async function fetchCoinGeckoGlobal(
  apiKey: string | undefined = coinGeckoEnv.DEMO_API_KEY()
): Promise<CoinGeckoFetchResult> {
  return fetchJsonText(`${COINGECKO_API_BASE}/global`, apiKey);
}

/** (1) 主要暗号資産の価格・時価総額 (円建て) を取得する (`GET /coins/markets`)。 */
export async function fetchCoinGeckoCoinMarkets(
  ids: readonly string[] = COINGECKO_MAJOR_COIN_IDS,
  apiKey: string | undefined = coinGeckoEnv.DEMO_API_KEY()
): Promise<CoinGeckoFetchResult> {
  if (ids.length === 0) {
    throw new Error("fetchCoinGeckoCoinMarkets: ids が空です");
  }
  const url =
    `${COINGECKO_API_BASE}/coins/markets?vs_currency=jpy&ids=${ids.join(",")}` +
    `&order=market_cap_desc&price_change_percentage=24h`;
  return fetchJsonText(url, apiKey);
}

/** (1) ステーブルコイン合計時価総額を取得する (`GET /coins/categories`)。 */
export async function fetchCoinGeckoStablecoinCategory(
  apiKey: string | undefined = coinGeckoEnv.DEMO_API_KEY()
): Promise<CoinGeckoFetchResult> {
  return fetchJsonText(`${COINGECKO_API_BASE}/coins/categories?order=market_cap_desc`, apiKey);
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

/**
 * 観測値として書き出す金額・価格・比率用。CoinGecko は「値が無い」ときに
 * null ではなく 0 を返すことがある (実例: 2026-09-27 取得の /global 応答の
 * `total_market_cap.eth` / `.sol` 等 11 通貨建てが 0.0。/coins/markets でも
 * 流通量が未確認の銘柄は `market_cap` が 0 になりうる — 本フィクスチャの
 * 5 銘柄では未発生)。0 や負値を実在の値として観測ログへ流さず throw する
 * (ルール2: 無効な値で埋めて続行しない)。
 */
function asPositiveNumber(value: unknown, path: string): number {
  const n = asNumber(value, path);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `${path} が正の数ではありません (CoinGecko は欠損を 0 で返すことがあるため実在値として扱わない): ${JSON.stringify(value)}`
    );
  }
  return n;
}

/** シェア (%) 用: 0 より大きく 100 以下でなければ throw する。 */
function asPercentShare(value: unknown, path: string): number {
  const n = asPositiveNumber(value, path);
  if (n > 100) {
    throw new Error(`${path} が 100% を超えています (様式変更・単位変更の可能性): ${JSON.stringify(value)}`);
  }
  return n;
}

function asOptionalNumber(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null;
  return asNumber(value, path);
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} が文字列ではありません (様式変更の可能性): ${JSON.stringify(value)}`);
  }
  return value;
}

export interface CoinGeckoGlobalSnapshot {
  /** CoinGecko 側の更新時刻 (ISO 8601, UTC。`data.updated_at` の unix 秒を変換) */
  asOf: string;
  totalMarketCapUsd: number;
  totalMarketCapJpy: number;
  totalVolumeUsd: number;
  /** 暗号資産全体に占めるビットコインの時価総額シェア (%) */
  btcDominancePct: number;
  /** 暗号資産全体に占めるイーサリアムの時価総額シェア (%) */
  ethDominancePct: number;
  /** 24時間の時価総額変化率 (%, ドル建て)。価格変動寄与の把握用。 */
  marketCapChangePercentage24hUsd: number;
  activeCryptocurrencies: number;
  markets: number;
}

/** `GET /global` の生レスポンスから型付きスナップショットを作る。 */
export function parseCoinGeckoGlobal(raw: string): CoinGeckoGlobalSnapshot {
  const json = parseJson(raw, "CoinGecko /global");
  const root = asRecord(json, "CoinGecko /global");
  if (!("data" in root)) {
    throw new Error("CoinGecko /global: data フィールドがありません (様式変更の可能性)");
  }
  const data = asRecord(root.data, "CoinGecko /global data");
  const totalMarketCap = asRecord(data.total_market_cap, "data.total_market_cap");
  const totalVolume = asRecord(data.total_volume, "data.total_volume");
  const marketCapPct = asRecord(data.market_cap_percentage, "data.market_cap_percentage");

  const updatedAtSec = asNumber(data.updated_at, "data.updated_at");

  return {
    asOf: new Date(updatedAtSec * 1000).toISOString(),
    totalMarketCapUsd: asPositiveNumber(totalMarketCap.usd, "data.total_market_cap.usd"),
    totalMarketCapJpy: asPositiveNumber(totalMarketCap.jpy, "data.total_market_cap.jpy"),
    totalVolumeUsd: asPositiveNumber(totalVolume.usd, "data.total_volume.usd"),
    btcDominancePct: asPercentShare(marketCapPct.btc, "data.market_cap_percentage.btc"),
    ethDominancePct: asPercentShare(marketCapPct.eth, "data.market_cap_percentage.eth"),
    marketCapChangePercentage24hUsd: asNumber(
      data.market_cap_change_percentage_24h_usd,
      "data.market_cap_change_percentage_24h_usd"
    ),
    activeCryptocurrencies: asNumber(data.active_cryptocurrencies, "data.active_cryptocurrencies"),
    markets: asNumber(data.markets, "data.markets"),
  };
}

export interface CoinGeckoCoinSnapshot {
  /** CoinGecko coin id (例: "bitcoin") */
  id: string;
  /** ティッカー (例: "btc") */
  symbol: string;
  name: string;
  priceJpy: number;
  marketCapJpy: number;
  marketCapRank: number | null;
  priceChangePercentage24h: number | null;
  /** CoinGecko 側の最終更新時刻 (ISO 8601) */
  lastUpdated: string;
}

/**
 * `GET /coins/markets` の生レスポンス (配列) から型付きレコード配列を作る。
 *
 * `expectedIds` (既定: `COINGECKO_MAJOR_COIN_IDS`、`fetchCoinGeckoCoinMarkets`
 * の既定値と揃えている) の全件が応答に含まれているかも検証する。配列自体は
 * 空でなくとも、要求した銘柄の一部だけが欠けているケース (様式は正しいまま
 * 件数だけ減る CoinGecko 側の一時的なデータ欠損等) を素通りさせない
 * (ルール2: 想定外を黙って通さない)。
 */
export function parseCoinGeckoCoinMarkets(
  raw: string,
  expectedIds: readonly string[] = COINGECKO_MAJOR_COIN_IDS
): CoinGeckoCoinSnapshot[] {
  const json = parseJson(raw, "CoinGecko /coins/markets");
  if (!Array.isArray(json)) {
    throw new Error(
      `CoinGecko /coins/markets: レスポンスが配列ではありません (様式変更の可能性): ${JSON.stringify(json).slice(0, 200)}`
    );
  }
  if (json.length === 0) {
    throw new Error("CoinGecko /coins/markets: レスポンスが空配列です (指定した coin id が存在しない可能性)");
  }
  const result = json.map((entry, i) => {
    const e = asRecord(entry, `CoinGecko /coins/markets[${i}]`);
    return {
      id: asString(e.id, `[${i}].id`),
      symbol: asString(e.symbol, `[${i}].symbol`),
      name: asString(e.name, `[${i}].name`),
      priceJpy: asPositiveNumber(e.current_price, `[${i}].current_price`),
      marketCapJpy: asPositiveNumber(e.market_cap, `[${i}].market_cap`),
      marketCapRank: asOptionalNumber(e.market_cap_rank, `[${i}].market_cap_rank`),
      priceChangePercentage24h: asOptionalNumber(
        e.price_change_percentage_24h,
        `[${i}].price_change_percentage_24h`
      ),
      lastUpdated: asString(e.last_updated, `[${i}].last_updated`),
    };
  });

  const resultIds = new Set(result.map((c) => c.id));
  const missingIds = expectedIds.filter((id) => !resultIds.has(id));
  if (missingIds.length > 0) {
    throw new Error(
      `CoinGecko /coins/markets: 要求した coin id の一部が応答に含まれていません ` +
        `(様式は正しいまま件数だけ減るデータ欠損の可能性): missing=${missingIds.join(",")}`
    );
  }
  // 逆方向も検査する: 要求していない銘柄や同じ銘柄の重複行が混ざると、観測ログの
  // 冪等キー (期間|指標|区分) が衝突して後の行が前の行を黙って上書きしたり、
  // 追跡対象外の銘柄が紛れ込んだりする (ルール2)。
  const expectedSet = new Set(expectedIds);
  const unexpectedIds = result.map((c) => c.id).filter((id) => !expectedSet.has(id));
  if (unexpectedIds.length > 0) {
    throw new Error(
      `CoinGecko /coins/markets: 要求していない coin id が応答に含まれています: unexpected=${unexpectedIds.join(",")}`
    );
  }
  const seenIds = new Set<string>();
  const duplicatedIds = new Set<string>();
  for (const c of result) {
    if (seenIds.has(c.id)) duplicatedIds.add(c.id);
    seenIds.add(c.id);
  }
  if (duplicatedIds.size > 0) {
    throw new Error(
      `CoinGecko /coins/markets: 同じ coin id の行が重複しています: duplicated=${[...duplicatedIds].join(",")}`
    );
  }

  return result;
}

export interface CoinGeckoCategorySnapshot {
  id: string;
  name: string;
  marketCapUsd: number;
  /** CoinGecko 側の最終更新時刻 (ISO 8601) */
  updatedAt: string;
}

/**
 * `GET /coins/categories` の生レスポンス (配列) から `id === "stablecoins"`
 * のカテゴリ (ステーブルコイン合計時価総額) を取り出す。
 */
export function parseCoinGeckoStablecoinCategory(raw: string): CoinGeckoCategorySnapshot {
  const json = parseJson(raw, "CoinGecko /coins/categories");
  if (!Array.isArray(json)) {
    throw new Error(
      `CoinGecko /coins/categories: レスポンスが配列ではありません (様式変更の可能性): ${JSON.stringify(json).slice(0, 200)}`
    );
  }
  const matches = json.filter(
    (c) => typeof c === "object" && c !== null && (c as Record<string, unknown>).id === "stablecoins"
  );
  if (matches.length === 0) {
    throw new Error(
      'CoinGecko /coins/categories: id="stablecoins" のカテゴリが見つかりません (様式変更の可能性)'
    );
  }
  // 複数あるときに「先頭の1件」を黙って採用しない (ルール2: 候補が複数なら
  // どれが正しいか判断できないので throw する)。
  if (matches.length > 1) {
    throw new Error(
      `CoinGecko /coins/categories: id="stablecoins" のカテゴリが ${matches.length} 件あります (様式変更の可能性)`
    );
  }
  const entry = matches[0];
  const e = asRecord(entry, "CoinGecko /coins/categories[stablecoins]");
  return {
    id: asString(e.id, "stablecoins.id"),
    name: asString(e.name, "stablecoins.name"),
    marketCapUsd: asPositiveNumber(e.market_cap, "stablecoins.market_cap"),
    updatedAt: asString(e.updated_at, "stablecoins.updated_at"),
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
  /** 表示用ラベル (例: "2026-09-27" / "2026-W39" / "2026-09" / "2026-Q3" / "2026") */
  label: string;
}

function toDateKey(d: Date): string {
  const iso = d.toISOString();
  const key = iso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    // 起こり得ないはずだが、無効な Date を黙って通さない (ルール2)。
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

/**
 * 指定した granularity (週/月/四半期/年、または日) の期間を、`referenceDate`
 * を含む期間として解決する。CoinGecko 自体は「期間」の概念を持たない
 * リアルタイム API なので、この関数は kabulab 側の観測ログ (資金フロー｜
 * 観測ログ) の期間キーを組み立てるための純粋なカレンダー計算。
 */
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
      // ObservationGranularity は上記 5 値で尽くしているが、将来の union 拡張
      // 漏れを黙って通さないための安全網 (ルール2: 想定外は throw する)。
      throw new Error(`resolveObservationPeriod: 未対応の granularity です: ${String(granularity)}`);
    }
  }
}

export interface PeriodObservability {
  observable: boolean;
  /** observable=false のときのみ設定 */
  reason?: string;
}

/**
 * 対象期間が「まだ公表されていない」かどうかを判定する。CoinGecko はリアル
 * タイム API で公表ラグが無いため、判定基準は「対象期間の終了日を過ぎて
 * いるか」のみ (JPX の月次 PDF のような『翌月第n営業日』という追加ラグは無い)。
 *
 * `granularity === "day"` は特別扱いする: week/month/quarter/year は
 * 「期間の途中で取得したスナップショットはその期間の確定値として扱えない
 * (期間が終わるまで待つ)」という意味を持つが、day 自体には「1日の途中か
 * どうか」という概念がない — 1日1回、取得した瞬間の値がそのままその日の
 * 観測値になる設計 (本モジュールの日次実行の前提)。そのため day では
 * 「対象日がまだ来ていない (未来の日付) か」だけを判定する。ここを他の
 * 粒度と同じ「期間終了を過ぎたか」で判定すると、`resolveObservationPeriod
 * ("day", now)` の結果をそのまま渡した場合に常に observable=false になって
 * しまう (period.end は常に「今日」であり、"今日の23:59:59.999" を過ぎる
 * ことは通常無いため)。
 */
export function isPeriodObservable(period: ObservationPeriod, now: Date): PeriodObservability {
  if (period.granularity === "day") {
    const todayKey = toDateKey(now);
    if (period.start > todayKey) {
      return {
        observable: false,
        reason: `期間 ${period.label} はまだ来ていない未来の日付です。`,
      };
    }
    return { observable: true };
  }

  const periodEnd = new Date(`${period.end}T23:59:59.999Z`);
  if (Number.isNaN(periodEnd.getTime())) {
    throw new Error(`isPeriodObservable: 不正な period.end です: ${period.end}`);
  }
  if (now.getTime() < periodEnd.getTime()) {
    return {
      observable: false,
      reason:
        `期間 ${period.label} (終了 ${period.end}) はまだ終わっていません。CoinGecko は` +
        `リアルタイム API で公表ラグは無いが、期間が終わる前のスナップショットは` +
        `その期間の確定値として扱えない。`,
    };
  }
  return { observable: true };
}

// ---------------------------------------------------------------------------
// (4) 指標定義
// ---------------------------------------------------------------------------

export type MoneyflowRequirement = "R1" | "R2" | "R3" | "R4";

/** 何を測るか (計画書 `notion-velvet-goose.md` の分類語彙と共通)。 */
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
  /** 平易な説明 (1〜3文、可能なら数値例) + 財務的に正確な定義 (ルール7相当の粒度) */
  description: string;
  unit: string;
  sourceUrl: string;
  usageTerms: string;
  frequency: string;
  limitations: string;
}

/**
 * 全指標共通の利用条件文言。CoinGecko API Terms
 * (https://www.coingecko.com/en/api_terms) を 2026-09-27 に本文で直接確認
 * した内容に合わせている: attribution (「Powered by CoinGecko」表示) は
 * 選択したプラン (無料/Demo/有料) を問わず一律の義務であり、「商用利用の
 * ときだけ必要」ではない。本モジュール (データ取得層) 自体は画面を持たない
 * ため、表示自体は moneyflow の画面実装側の対応が別途必要。
 */
const COINGECKO_USAGE_TERMS =
  "CoinGecko 公開 API (キー無しまたは無料 Demo キー)。個人/商用いずれの利用でも" +
  `「Powered by CoinGecko」の表示 (CoinGecko Brand Guidelines 準拠) が義務 (${COINGECKO_API_TERMS_URL})。` +
  "本モジュール(データ層)では未実装 — 画面表示側で別途対応が必要。";

export const COINGECKO_GLOBAL_INDICATORS: readonly MoneyflowIndicatorDefinition[] = [
  {
    key: "coingecko_price_jpy",
    displayName: "暗号資産の価格 (円建て)",
    requirements: ["R3"],
    flowType: "price_only",
    description:
      "主要な暗号資産1単位あたりの円建て価格。例: ビットコイン(BTC)が1,300万円なら" +
      "「1BTC=1,300万円」という意味で、時価総額 (流通量×価格) そのものではない。" +
      "価格は需給で常に変動する『今この瞬間の値』であり、資金の流出入額 (フロー) では" +
      "ない点に注意 (値上がりしただけでも数値は増える)。",
    unit: "円/単位",
    sourceUrl: COINGECKO_DOCS_URL,
    usageTerms: COINGECKO_USAGE_TERMS,
    frequency: "リアルタイム (リクエスト時点の最新値)",
    limitations:
      "日本国内の暗号資産交換業者の実勢価格ではなく、CoinGecko が集計するグローバル" +
      "取引所の加重平均。過去の特定時点の値を取得する専用エンドポイントは本モジュール" +
      "未実装 (日次実行で自前にスナップショットを蓄積し、月次・四半期の比較は蓄積した" +
      "観測ログ側で行う設計)。",
  },
  {
    key: "coingecko_market_cap_jpy",
    displayName: "暗号資産の時価総額 (円建て)",
    requirements: ["R3"],
    flowType: "holdings_stock",
    description:
      "主要な暗号資産の『流通量 (市場に出回っている量) × 価格』(円建て)。発行済みの" +
      "総量ではなく流通量で計算する (例: 2026-09-27 の XRP は総量約1,000億枚のうち" +
      "流通量約629億枚×価格約240円≒約15.1兆円で、総量×価格の約24.0兆円ではない)。" +
      "値上がりで増えたのか新規資金が入って増えたのかはこの数値だけでは区別できない" +
      "残高 (ストック) なので、前期比の増減額をそのまま『資金の純流入』と読まないこと。",
    unit: "円",
    sourceUrl: COINGECKO_DOCS_URL,
    usageTerms: COINGECKO_USAGE_TERMS,
    frequency: "リアルタイム",
    limitations:
      "流通量 (circulating supply) の推計方法は銘柄ごとに異なり、CoinGecko 独自の" +
      "判定が入る (自己申告のロック分の扱い等)。",
  },
  {
    key: "coingecko_global_market_cap_usd",
    displayName: "暗号資産市場全体の時価総額 (ドル建て・世界合計)",
    requirements: ["R3"],
    flowType: "holdings_stock",
    description:
      "CoinGecko が把握する全暗号資産 (2万銘柄超) の時価総額の世界合計。株式市場で" +
      "いう『上場銘柄の時価総額合計』に近い、市場全体の規模を表す残高。日本国内に" +
      "限定した数値ではない。",
    unit: "米ドル",
    sourceUrl: COINGECKO_DOCS_URL,
    usageTerms: COINGECKO_USAGE_TERMS,
    frequency: "リアルタイム",
    limitations:
      "国別・地域別の内訳は提供されない (グローバル合算のみ)。『流通量』の算定基準が" +
      "銘柄ごとに異なるため、他社集計 (取引所公式値等) と厳密には一致しない。",
  },
  {
    key: "coingecko_stablecoin_market_cap_usd",
    displayName: "ステーブルコイン合計時価総額 (ドル建て)",
    requirements: ["R3"],
    flowType: "holdings_stock",
    description:
      "米ドル等の法定通貨に価値を連動させる『ステーブルコイン』カテゴリ全体の時価" +
      "総額。暗号資産市場に『いつでも法定通貨に近い形で待機している資金』がどれだけ" +
      "あるかの目安。ステーブルコイン自体の価格変動はほぼ無いため、増減は概ね発行 " +
      "(=資金流入) ・償還 (=資金流出) を反映するが、完全な純流入額ではない近似値。",
    unit: "米ドル",
    sourceUrl: COINGECKO_DOCS_URL,
    usageTerms: COINGECKO_USAGE_TERMS,
    frequency: "リアルタイム",
    limitations:
      "CoinGecko の『stablecoins』カテゴリ分類に依存する (新規銘柄の分類反映に" +
      "ラグがある場合がある)。円建てステーブルコインは全体のごく一部 " +
      "(2026-09-27 実測で全体の約0.05%) であり、円資金の動きの代理指標としては弱い。",
  },
  {
    key: "coingecko_btc_dominance_pct",
    displayName: "ビットコイン・ドミナンス",
    requirements: ["R3"],
    flowType: "holdings_stock",
    description:
      "暗号資産市場全体の時価総額のうち、ビットコイン (BTC) が占める割合。例: " +
      "ドミナンス58%なら『暗号資産の時価総額の58%がビットコイン』という意味。値が" +
      "上がるとBTCへ資金や関心が集中している目安になるが、これも残高の構成比であり、" +
      "資金の流出入そのものではない。",
    unit: "%",
    sourceUrl: COINGECKO_DOCS_URL,
    usageTerms: COINGECKO_USAGE_TERMS,
    frequency: "リアルタイム",
    limitations:
      "アルトコインの急騰・急落だけでもドミナンスは動くため、『資金がBTCに逃避した』" +
      "と短絡できない。",
  },
] as const;

// ---------------------------------------------------------------------------
// (5) 観測ログの縦長行を組み立てる
// ---------------------------------------------------------------------------

export type MoneyflowSegmentType = "投資部門" | "資産クラス" | "国地域" | "商品";

export interface MoneyflowObservationRow {
  /** 対象期間のラベル (`ObservationPeriod.label`) */
  period: string;
  indicatorKey: string;
  segmentType: MoneyflowSegmentType;
  segment: string;
  value: number;
  unit: string;
  /** この値が近似 (複数取得元の突合・丸め等を経ている) かどうか */
  isApproximate: boolean;
  /** この値が推定 (実測値ではなく計算で導出) かどうか */
  isEstimated: boolean;
  sourceUrl: string;
}

export interface CoinGeckoGlobalObservationInput {
  global: CoinGeckoGlobalSnapshot;
  coins: readonly CoinGeckoCoinSnapshot[];
  stablecoins: CoinGeckoCategorySnapshot;
}

type MajorCoinId = (typeof COINGECKO_MAJOR_COIN_IDS)[number];

/** 追跡銘柄ごとの表示名。キーを `COINGECKO_MAJOR_COIN_IDS` に縛り、表示名の登録漏れを型で検出する。 */
const COIN_DISPLAY_NAME: Readonly<Record<MajorCoinId, string>> = {
  bitcoin: "ビットコイン(BTC)",
  ethereum: "イーサリアム(ETH)",
  ripple: "リップル(XRP)",
  solana: "ソラナ(SOL)",
  dogecoin: "ドージコイン(DOGE)",
};

function isMajorCoinId(id: string): id is MajorCoinId {
  return (COINGECKO_MAJOR_COIN_IDS as readonly string[]).includes(id);
}

/**
 * 観測ログの「区分」に書く銘柄の表示名。表示名が未登録の銘柄は id/symbol から
 * 名前を組み立てて黙って埋めず throw する (ルール2)。区分は冪等キーの一部なので、
 * 追跡銘柄を増やすときは `COINGECKO_MAJOR_COIN_IDS` とここの表示名を同時に足す。
 */
function coinLabel(id: string): string {
  if (!isMajorCoinId(id)) {
    throw new Error(
      `toCoinGeckoObservationRows: coin id "${id}" は追跡銘柄 (COINGECKO_MAJOR_COIN_IDS) ではなく、` +
        `表示名が未登録です (追跡銘柄を増やす場合は表示名も追加すること)`
    );
  }
  return COIN_DISPLAY_NAME[id];
}

/**
 * スナップショットの時刻 (CoinGecko 側の更新時刻) が、書き込もうとしている
 * 期間 (UTC) の中に収まっているかを検査する。CoinGecko には過去時点の値を
 * 取る経路が本モジュールに無いため、「今日のスナップショット」に過去の日付・
 * 別の月のラベルを付けて観測ログへ書くと、実在しない過去値を捏造したことに
 * なる (ルール1/2)。UTC 0 時 (日本時間 9 時) をまたいで 3 ファイルの時刻が
 * 別の日に割れた場合も、どちらの日の値とも言えないので throw する (時間を
 * 空けて取り直すこと)。
 */
function assertSnapshotsWithinPeriod(
  input: CoinGeckoGlobalObservationInput,
  period: ObservationPeriod
): void {
  const stamps: Array<[string, string]> = [
    ["global.asOf", input.global.asOf],
    ["stablecoins.updatedAt", input.stablecoins.updatedAt],
    ...input.coins.map((c): [string, string] => [`coins[${c.id}].lastUpdated`, c.lastUpdated]),
  ];
  for (const [path, iso] of stamps) {
    const t = new Date(iso);
    if (Number.isNaN(t.getTime())) {
      throw new Error(`toCoinGeckoObservationRows: ${path} が日時として解釈できません: ${iso}`);
    }
    const day = toDateKey(t);
    if (day < period.start || day > period.end) {
      throw new Error(
        `toCoinGeckoObservationRows: ${path}=${iso} (UTC ${day}) は期間 ${period.label} ` +
          `(${period.start}〜${period.end}) の外です。取得したスナップショットに別の期間の` +
          `ラベルを付けて書くことはできません (過去値の捏造になる)。`
      );
    }
  }
}

/**
 * CoinGecko から取得したスナップショット群を、観測ログ (資金フロー｜観測ログ)
 * に書く縦長の行に変換する純関数。ここでは Notion I/O は行わない (統合担当が
 * この関数の戻り値を使って書き込む)。
 */
export function toCoinGeckoObservationRows(
  input: CoinGeckoGlobalObservationInput,
  period: ObservationPeriod
): MoneyflowObservationRow[] {
  assertSnapshotsWithinPeriod(input, period);
  const sourceUrl = COINGECKO_DOCS_URL;
  const rows: MoneyflowObservationRow[] = [];

  for (const coin of input.coins) {
    const segment = coinLabel(coin.id);
    rows.push({
      period: period.label,
      indicatorKey: "coingecko_price_jpy",
      segmentType: "資産クラス",
      segment,
      value: coin.priceJpy,
      unit: "円/単位",
      isApproximate: false,
      isEstimated: false,
      sourceUrl,
    });
    rows.push({
      period: period.label,
      indicatorKey: "coingecko_market_cap_jpy",
      segmentType: "資産クラス",
      segment,
      value: coin.marketCapJpy,
      unit: "円",
      isApproximate: false,
      isEstimated: false,
      sourceUrl,
    });
  }

  rows.push({
    period: period.label,
    indicatorKey: "coingecko_global_market_cap_usd",
    segmentType: "資産クラス",
    segment: "暗号資産全体",
    value: input.global.totalMarketCapUsd,
    unit: "米ドル",
    isApproximate: false,
    isEstimated: false,
    sourceUrl,
  });

  rows.push({
    period: period.label,
    indicatorKey: "coingecko_stablecoin_market_cap_usd",
    segmentType: "資産クラス",
    segment: "ステーブルコイン合計",
    value: input.stablecoins.marketCapUsd,
    unit: "米ドル",
    isApproximate: false,
    isEstimated: false,
    sourceUrl,
  });

  rows.push({
    period: period.label,
    indicatorKey: "coingecko_btc_dominance_pct",
    segmentType: "資産クラス",
    segment: "ビットコイン(BTC)",
    value: input.global.btcDominancePct,
    unit: "%",
    isApproximate: false,
    isEstimated: false,
    sourceUrl,
  });

  return rows;
}

// ---------------------------------------------------------------------------
// ルール6: Notion 一次データアーカイブの入力を組む (実際の書込は統合担当が行う)
// ---------------------------------------------------------------------------

export interface CoinGeckoRawBundle {
  global: CoinGeckoFetchResult;
  coinMarkets: CoinGeckoFetchResult;
  stablecoinCategory: CoinGeckoFetchResult;
}

/**
 * `services/vwap-analysis/lib/margin.ts` の `marginArchiveInput` と同じ型の
 * 純関数。冪等キーは日次 (`coingecko-global-YYYY-MM-DD`)。Notion 書込その
 * ものはこのモジュールでは行わない (呼び出し側が `recordPrimaryData()` に渡す)。
 */
export function coinGeckoArchiveInput(bundle: CoinGeckoRawBundle): {
  service: string;
  key: string;
  source: string;
  metadata: Record<string, unknown>;
  files: Array<{ bytes: Uint8Array; filename: string; contentType: string }>;
} {
  const dateKey = bundle.global.fetchedAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throw new Error(`coinGeckoArchiveInput: fetchedAt から日付キーを作れません: ${bundle.global.fetchedAt}`);
  }
  const encoder = new TextEncoder();
  return {
    service: "moneyflow",
    key: `coingecko-global-${dateKey}`,
    source: bundle.global.url,
    metadata: {
      fetchedAt: bundle.global.fetchedAt,
      // 3 ファイルは別リクエストで数秒ずれて取得される。来歴を 1 つの時刻に
      // 丸めず、ファイルごとの取得時刻を残す (ルール6: メタデータとともに記録)。
      fetchedAtByFile: {
        global: bundle.global.fetchedAt,
        coinMarkets: bundle.coinMarkets.fetchedAt,
        stablecoinCategory: bundle.stablecoinCategory.fetchedAt,
      },
      urls: {
        global: bundle.global.url,
        coinMarkets: bundle.coinMarkets.url,
        stablecoinCategory: bundle.stablecoinCategory.url,
      },
    },
    files: [
      {
        bytes: encoder.encode(bundle.global.raw),
        filename: `coingecko-global-${dateKey}.json`,
        contentType: "application/json",
      },
      {
        bytes: encoder.encode(bundle.coinMarkets.raw),
        filename: `coingecko-coins-markets-${dateKey}.json`,
        contentType: "application/json",
      },
      {
        bytes: encoder.encode(bundle.stablecoinCategory.raw),
        filename: `coingecko-categories-stablecoins-${dateKey}.json`,
        contentType: "application/json",
      },
    ],
  };
}
