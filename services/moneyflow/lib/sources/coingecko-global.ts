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
 * - 商用利用・再配布には attribution (出典表示) が必要
 *   (https://www.coingecko.com/en/api_terms)。kabulab は個人利用の Notion
 *   ダッシュボードだが、指標定義に出典 URL を必ず持たせている。
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
    const bodySnippet = await res.text().catch(() => "");
    throw new Error(
      `CoinGecko HTTP エラー: ${res.status} ${res.statusText} (${url})` +
        (res.status === 429
          ? " — レート制限 (Demo API キー未設定なら COINGECKO_DEMO_API_KEY の設定を検討するか、間隔を空けて再試行すること)"
          : "") +
        (bodySnippet ? ` body=${bodySnippet.slice(0, 300)}` : "")
    );
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
    totalMarketCapUsd: asNumber(totalMarketCap.usd, "data.total_market_cap.usd"),
    totalMarketCapJpy: asNumber(totalMarketCap.jpy, "data.total_market_cap.jpy"),
    totalVolumeUsd: asNumber(totalVolume.usd, "data.total_volume.usd"),
    btcDominancePct: asNumber(marketCapPct.btc, "data.market_cap_percentage.btc"),
    ethDominancePct: asNumber(marketCapPct.eth, "data.market_cap_percentage.eth"),
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

/** `GET /coins/markets` の生レスポンス (配列) から型付きレコード配列を作る。 */
export function parseCoinGeckoCoinMarkets(raw: string): CoinGeckoCoinSnapshot[] {
  const json = parseJson(raw, "CoinGecko /coins/markets");
  if (!Array.isArray(json)) {
    throw new Error(
      `CoinGecko /coins/markets: レスポンスが配列ではありません (様式変更の可能性): ${JSON.stringify(json).slice(0, 200)}`
    );
  }
  if (json.length === 0) {
    throw new Error("CoinGecko /coins/markets: レスポンスが空配列です (指定した coin id が存在しない可能性)");
  }
  return json.map((entry, i) => {
    const e = asRecord(entry, `CoinGecko /coins/markets[${i}]`);
    return {
      id: asString(e.id, `[${i}].id`),
      symbol: asString(e.symbol, `[${i}].symbol`),
      name: asString(e.name, `[${i}].name`),
      priceJpy: asNumber(e.current_price, `[${i}].current_price`),
      marketCapJpy: asNumber(e.market_cap, `[${i}].market_cap`),
      marketCapRank: asOptionalNumber(e.market_cap_rank, `[${i}].market_cap_rank`),
      priceChangePercentage24h: asOptionalNumber(
        e.price_change_percentage_24h,
        `[${i}].price_change_percentage_24h`
      ),
      lastUpdated: asString(e.last_updated, `[${i}].last_updated`),
    };
  });
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
  const entry = json.find(
    (c) => typeof c === "object" && c !== null && (c as Record<string, unknown>).id === "stablecoins"
  );
  if (!entry) {
    throw new Error(
      'CoinGecko /coins/categories: id="stablecoins" のカテゴリが見つかりません (様式変更の可能性)'
    );
  }
  const e = asRecord(entry, "CoinGecko /coins/categories[stablecoins]");
  return {
    id: asString(e.id, "stablecoins.id"),
    name: asString(e.name, "stablecoins.name"),
    marketCapUsd: asNumber(e.market_cap, "stablecoins.market_cap"),
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
 */
export function isPeriodObservable(period: ObservationPeriod, now: Date): PeriodObservability {
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

export const COINGECKO_GLOBAL_INDICATORS: readonly MoneyflowIndicatorDefinition[] = [
  {
    key: "coingecko_price_jpy",
    displayName: "暗号資産の価格 (円建て)",
    requirements: ["R3"],
    flowType: "price_only",
    description:
      "主要な暗号資産1単位あたりの円建て価格。例: ビットコイン(BTC)が1,300万円なら" +
      "「1BTC=1,300万円」という意味で、時価総額 (発行量×価格) そのものではない。" +
      "価格は需給で常に変動する『今この瞬間の値』であり、資金の流出入額 (フロー) では" +
      "ない点に注意 (値上がりしただけでも数値は増える)。",
    unit: "円/単位",
    sourceUrl: COINGECKO_DOCS_URL,
    usageTerms:
      "CoinGecko 公開 API (キー無しまたは無料 Demo キー)。個人利用は無料。再配布・" +
      `ホワイトラベル提供には attribution (出典表示) が必要 (${COINGECKO_API_TERMS_URL})。`,
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
      "主要な暗号資産の発行量×価格 (円建て)。『値上がりで時価総額が増えた』のか" +
      "『新規資金が入って増えた』のかはこの数値だけでは区別できない残高 (ストック)。" +
      "前期比の増減額をそのまま『資金の純流入』と読まないこと。",
    unit: "円",
    sourceUrl: COINGECKO_DOCS_URL,
    usageTerms:
      "CoinGecko 公開 API (キー無しまたは無料 Demo キー)。個人利用は無料。再配布・" +
      `ホワイトラベル提供には attribution が必要 (${COINGECKO_API_TERMS_URL})。`,
    frequency: "リアルタイム",
    limitations:
      "供給量 (circulating supply) の推計方法は銘柄ごとに異なり、CoinGecko 独自の" +
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
    usageTerms:
      "CoinGecko 公開 API (キー無しまたは無料 Demo キー)。個人利用は無料。再配布・" +
      `ホワイトラベル提供には attribution が必要 (${COINGECKO_API_TERMS_URL})。`,
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
    usageTerms:
      "CoinGecko 公開 API (キー無しまたは無料 Demo キー)。個人利用は無料。再配布・" +
      `ホワイトラベル提供には attribution が必要 (${COINGECKO_API_TERMS_URL})。`,
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
    usageTerms:
      "CoinGecko 公開 API (キー無しまたは無料 Demo キー)。個人利用は無料。再配布・" +
      `ホワイトラベル提供には attribution が必要 (${COINGECKO_API_TERMS_URL})。`,
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

const COIN_DISPLAY_NAME: Readonly<Record<string, string>> = {
  bitcoin: "ビットコイン(BTC)",
  ethereum: "イーサリアム(ETH)",
  ripple: "リップル(XRP)",
  solana: "ソラナ(SOL)",
  dogecoin: "ドージコイン(DOGE)",
};

function coinLabel(id: string, symbol: string): string {
  return COIN_DISPLAY_NAME[id] ?? `${id}(${symbol.toUpperCase()})`;
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
  const sourceUrl = COINGECKO_DOCS_URL;
  const rows: MoneyflowObservationRow[] = [];

  for (const coin of input.coins) {
    const segment = coinLabel(coin.id, coin.symbol);
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
