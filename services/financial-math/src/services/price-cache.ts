/**
 * 価格キャッシュ — 004 専用スキーマへの遅延フェッチ + UPSERT
 *
 * - 呼び出し: `getPriceContext(db, code)` で最新スナップショットを取得。
 * - キャッシュヒット条件: `finmath.price_snapshot.fetched_at` が
 *   `now() - CACHE_TTL_MS` より新しい行が存在すること。
 * - キャッシュミス時は Yahoo Chart + QuoteSummary を 1 銘柄ぶん叩いて
 *   UPSERT し、その結果を返す。
 *
 * 設計の意図: core.stocks は otakara-yutai が writer なので、
 * 株主優待のない銘柄 (例: 1414 など建設業の多く) は載らない。
 * 004 はそれに縛られないユニバースが要るので、daily cron が使うのと
 * 同じ Yahoo クライアント (`fetchStockRawData`) を二次利用する。
 */

import { asc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { priceSnapshot, dailyOhlcv } from "../db/finmath-schema.js";
import { stocks as coreStocks } from "../db/core-schema.js";
import { fetchChart, fetchStockRawData } from "../../../../src/shared/yahoo/client.js";
import {
  STOCK_CODE_REGEX,
  STOCK_CODE_ERROR,
  normalizeStockCode,
} from "../../../../src/shared/jpx/stock-code.js";

/** 1 日 (ミリ秒) — Yahoo は引け値ベースなので 1 日 1 リフレッシュで十分 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 日本株銘柄コードの正準パターン。数字 4 桁 (従来) または 数字 3 桁 + 末尾英字 1 文字
 * (2024〜の新規上場形式。例: 130A ソラコム, 141A トライアル HD)。形式定義は
 * 共有ヘルパ (src/shared/jpx) を唯一の source of truth とする。
 */
const JP_STOCK_PATTERN = STOCK_CODE_REGEX;

/** Yahoo 指数 (例: ^N225, ^GSPC) */
const INDEX_PATTERN = /^\^[A-Z0-9]+$/;

/**
 * OHLCV キャッシュ取得時のデフォルト範囲。
 *
 * 用途別の必要期間:
 *   - CAPM β 推定 (OLS): 60-120 営業日 (3-6 ヶ月) で標準
 *   - BS ヒストリカル σ: 同上 (60-120 営業日)
 *   - Notion で言及される「6-12ヶ月モメンタム」: ~250 営業日 (1y)
 *
 * 当初 5y にしていたが、東証 ~3,800 銘柄 × 5y × 1250 行 = 480 万行 ≈
 * 600 MB で Neon Free tier (512 MB) を超過する事故が発生。
 * 2y に絞ると ~190 万行 ≈ 240 MB で安全圏に収まり、用途的にも十分。
 */
const DEFAULT_OHLCV_RANGE = "2y";

/** 証券コード (数字4桁 / 英数字コード) または 指数シンボル を許容 */
function assertSymbol(symbol: string): void {
  if (!JP_STOCK_PATTERN.test(symbol) && !INDEX_PATTERN.test(symbol)) {
    throw new Error(`不正なシンボル: ${symbol} (証券コード または ^XXX 指数のみ)`);
  }
}

/** financial-math 各ビュー (DCF/CAPM/...) が共通で必要とする価格コンテキスト */
export interface PriceContext {
  code: string;
  name: string | null;
  price: number | null;
  /**
   * 配当利回り — **decimal 表現** (0.0343 = 3.43%)。
   *
   * DB (core.stock_financials / finmath.price_snapshot) には Yahoo の生値が
   * **% 値 (3.43)** で保存されているが、`PriceContext` では `/100` して
   * decimal に正規化する。これで views の `fmtPct(value, 2)` (内部で `value × 100`
   * する関数) と一貫し、`estimatedDividend = price × dividendYield` も正しく動く。
   */
  dividendYield: number | null;
  /** 配当利回りから推定した来期予想配当 (price × dividendYield、decimal 前提) */
  estimatedDividend: number | null;
  /** 時価総額 (CAPM の表示などに使用) */
  marketCap: number | null;
  /** Yahoo 取得時刻 (UI の鮮度表示用) */
  fetchedAt: Date;
  /** true ならキャッシュからそのまま返した、false なら Yahoo を叩いた */
  cacheHit: boolean;
}

/**
 * 銘柄コードに対する価格コンテキストを返す。
 *
 * - キャッシュヒット (TTL 内): DB から返す
 * - キャッシュミス / TTL 切れ: Yahoo を叩いて UPSERT し、その結果を返す
 * - 銘柄コードが正準パターン (数字 3 桁 + 末尾 1 文字) に一致しない場合や Yahoo 404 などは throw
 *
 * 銘柄名は finmath には保持しないので、core.stocks に登録があれば
 * その name を返す (otakara-yutai 由来のオマケ補完)。なければ null。
 */
export async function getPriceContext(
  db: Database,
  code: string
): Promise<PriceContext> {
  // 入力を正準形 (大文字・半角) に正規化してから検証・問い合わせ・保存する。
  const c = normalizeStockCode(code);
  if (!JP_STOCK_PATTERN.test(c)) {
    throw new Error(`不正な銘柄コード: ${code} — ${STOCK_CODE_ERROR}`);
  }

  const cached = await db
    .select()
    .from(priceSnapshot)
    .where(eq(priceSnapshot.code, c))
    .limit(1);

  const now = Date.now();
  if (cached.length > 0) {
    const row = cached[0];
    const ageMs = now - new Date(row.fetchedAt).getTime();
    if (ageMs < CACHE_TTL_MS) {
      return await hydrate(db, row, true);
    }
  }

  // キャッシュミス or TTL 切れ → Yahoo を叩く
  const raw = await fetchStockRawData(c);

  const [upserted] = await db
    .insert(priceSnapshot)
    .values({
      code: c,
      name: null,
      price: raw.price,
      per: raw.per,
      pbr: raw.pbr,
      dividendYield: raw.dividendYield,
      eps: raw.eps,
      bps: raw.bps,
      roe: raw.roe,
      roa: raw.roa,
      marketCap: raw.marketCap,
      operatingMarginTtm: raw.operatingMarginTtm,
      dataDate: raw.dataDate,
      fetchedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: priceSnapshot.code,
      set: {
        price: sql`excluded.price`,
        per: sql`excluded.per`,
        pbr: sql`excluded.pbr`,
        dividendYield: sql`excluded.dividend_yield`,
        eps: sql`excluded.eps`,
        bps: sql`excluded.bps`,
        roe: sql`excluded.roe`,
        roa: sql`excluded.roa`,
        marketCap: sql`excluded.market_cap`,
        operatingMarginTtm: sql`excluded.operating_margin_ttm`,
        dataDate: sql`excluded.data_date`,
        fetchedAt: sql`excluded.fetched_at`,
      },
    })
    .returning();

  return await hydrate(db, upserted, false);
}

/** 日足 OHLCV キャッシュ — 1 行 = 1 営業日 */
export interface OhlcvBar {
  date: string;        // YYYY-MM-DD
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

/**
 * シンボル (4桁コードまたは ^N225 等の指数) の日足 OHLCV を返す。
 *
 * - キャッシュヒット条件: 同一 symbol の MAX(fetched_at) が
 *   `now() - CACHE_TTL_MS` より新しいこと。
 * - キャッシュミス時は Yahoo Chart API から取得 (デフォルト 5y) し UPSERT。
 * - 戻り値は date 昇順。
 */
export async function getOhlcvSeries(
  db: Database,
  symbol: string
): Promise<OhlcvBar[]> {
  assertSymbol(symbol);

  // 鮮度チェック (per-row TTL: 最新行の fetched_at で判定)
  const [meta] = await db
    .select({
      latestFetchedAt: sql<string | null>`MAX(${dailyOhlcv.fetchedAt})::text`,
      rowCount: sql<number>`COUNT(*)::int`,
    })
    .from(dailyOhlcv)
    .where(eq(dailyOhlcv.symbol, symbol));

  const cacheFresh =
    meta?.latestFetchedAt !== null &&
    meta?.latestFetchedAt !== undefined &&
    (meta.rowCount ?? 0) > 0 &&
    Date.now() - new Date(meta.latestFetchedAt).getTime() < CACHE_TTL_MS;

  if (cacheFresh) {
    const rows = await db
      .select({
        date: dailyOhlcv.date,
        open: dailyOhlcv.open,
        high: dailyOhlcv.high,
        low: dailyOhlcv.low,
        close: dailyOhlcv.close,
        volume: dailyOhlcv.volume,
      })
      .from(dailyOhlcv)
      .where(eq(dailyOhlcv.symbol, symbol))
      .orderBy(asc(dailyOhlcv.date));
    return rows;
  }

  // キャッシュミス / TTL 切れ → Yahoo を叩いて upsert
  const chart = await fetchChart(symbol, DEFAULT_OHLCV_RANGE);
  if (chart.ohlcv.length === 0) {
    return [];
  }

  // 5y = 約 1,250 行 × 7 列 = 8,750 個のバインドパラメータ。
  // neon-http の HTTP body / Postgres parser のサイズ制限 (パラメータ多数 + 長いクエリ文字列)
  // で「Failed query: insert into ...」と落ちるケースがあるため CHUNK 分割する。
  // 過去テストで全銘柄の 1/4 以上 (909/3760) がこの理由で失敗していた。
  const CHUNK = 300;
  const rows = chart.ohlcv.map((bar) => ({
    symbol,
    date: bar.date,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  }));
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    await db
      .insert(dailyOhlcv)
      .values(slice)
      .onConflictDoUpdate({
        target: [dailyOhlcv.symbol, dailyOhlcv.date],
        set: {
          open: sql`excluded.open`,
          high: sql`excluded.high`,
          low: sql`excluded.low`,
          close: sql`excluded.close`,
          volume: sql`excluded.volume`,
          fetchedAt: sql`excluded.fetched_at`,
        },
      });
  }

  return chart.ohlcv;
}

/** snapshot 行 + core.stocks.name (あれば) を PriceContext に整える */
async function hydrate(
  db: Database,
  row: typeof priceSnapshot.$inferSelect,
  cacheHit: boolean
): Promise<PriceContext> {
  let name: string | null = row.name;
  if (!name) {
    const [stock] = await db
      .select({ name: coreStocks.name })
      .from(coreStocks)
      .where(eq(coreStocks.code, row.code))
      .limit(1);
    name = stock?.name ?? null;
  }
  // DB は % 値 (3.43) で保存されているため decimal (0.0343) に正規化する
  // (Yahoo Finance API の生値が % 値で、kabulab 全体の DB がそれを継承している)
  const rawDy = row.dividendYield;
  const dy =
    rawDy !== null && Number.isFinite(rawDy) ? rawDy / 100 : null;
  const price = row.price;
  const estimatedDividend =
    price !== null && dy !== null && Number.isFinite(price) && Number.isFinite(dy) && dy > 0
      ? price * dy
      : null;
  return {
    code: row.code,
    name,
    price,
    dividendYield: dy,
    estimatedDividend,
    marketCap: row.marketCap,
    fetchedAt: row.fetchedAt,
    cacheHit,
  };
}
