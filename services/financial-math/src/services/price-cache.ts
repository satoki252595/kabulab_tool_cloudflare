/**
 * 価格・日足の**読み取り専用**アクセス層 (004 financial-math。経緯は git 履歴)。
 * 日次 sync が書いた断面と日足をそのまま読む (SSR 中に Yahoo/D1 へ書かない)。
 *
 * 読む先: 価格・配当・時価総額 = `core_stock_financials`、個別日足 =
 * `swing_daily_ohlcv` (90 営業日保持)、^N225 = `swing_market_context.nikkei_close`。
 *
 * 規則: `as_of` だけでなく**使用サンプル本数**を画面へ出す (短い系列で
 * 計算したことを隠さない)。R2 の長期系列ができたらこの層はそちらを読む。
 * 旧 `finmath_*` 2 表は 0012 で DROP (退避は `~/kabulab-cf-backup-20260913/d1-finmath/`)。
 */

import { and, asc, eq, isNotNull } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { stocks as coreStocks, stockFinancials } from "../../../../src/shared/db/core-schema.js";
import { dailyOhlcv as swingDailyOhlcv, marketContext } from "../db/swing-readonly.js";
import {
  STOCK_CODE_REGEX,
  STOCK_CODE_ERROR,
  normalizeStockCode,
} from "../../../../src/shared/jpx/stock-code.js";

/**
 * 日本株銘柄コードの正準パターン。数字 4 桁 (従来) または 数字 3 桁 + 末尾英字 1 文字
 * (2024〜の新規上場形式。例: 130A ソラコム, 141A トライアル HD)。形式定義は
 * 共有ヘルパ (src/shared/jpx) を唯一の source of truth とする。
 */
const JP_STOCK_PATTERN = STOCK_CODE_REGEX;

/**
 * 市場系列として扱えるシンボル。
 *
 * 以前は `/^\^[A-Z0-9]+$/` を通して Yahoo へ投げていたので ^GSPC でも
 * ^VIX でも「取れたら返る」形だった。D1 が持っているのは
 * `swing_market_context.nikkei_close` の**日経平均だけ**なので、
 * 他の指数は**黙って空配列を返さず**に落とす (ルール2)。
 */
const MARKET_SYMBOL = "^N225";

/** シンボルが市場系列 (指数) かどうか */
function isIndexSymbol(symbol: string): boolean {
  return symbol.startsWith("^");
}

/** 証券コード または 市場系列シンボル を許容 */
function assertSymbol(symbol: string): void {
  if (isIndexSymbol(symbol)) {
    if (symbol !== MARKET_SYMBOL) {
      throw new Error(
        `市場系列は ${MARKET_SYMBOL} のみ対応: ${symbol}` +
          ` (D1 が持つ指数系列は swing_market_context.nikkei_close だけ)`
      );
    }
    return;
  }
  if (!JP_STOCK_PATTERN.test(symbol)) {
    throw new Error(`不正なシンボル: ${symbol} (証券コード または ${MARKET_SYMBOL})`);
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
   * DB (`core_stock_financials.dividend_yield`) には Yahoo の生値が
   * **% 値 (3.43)** で保存されているが、`PriceContext` では `/100` して
   * decimal に正規化する。これで views の `fmtPct(value, 2)` (内部で `value × 100`
   * する関数) と一貫し、`estimatedDividend = price × dividendYield` も正しく動く。
   */
  dividendYield: number | null;
  /** 配当利回りから推定した来期予想配当 (price × dividendYield、decimal 前提) */
  estimatedDividend: number | null;
  /** 時価総額 (CAPM の表示などに使用) */
  marketCap: number | null;
  /** 断面の基準日 'YYYY-MM-DD' (`core_stock_financials.data_date`) */
  asOf: string;
  /** 日次 sync がこの断面を書いた時刻 (UI の鮮度表示用) */
  fetchedAt: Date;
}

/**
 * 価格・配当利回り・時価総額の数値正規化（純関数）。
 *
 * ここを純関数として export しているのは、テストが**本物の関数**を呼べるように
 * するため。以前の `price-cache.test.ts` は price-cache から何も import せず
 * `normalize()` をテストファイル内にコピー実装しており、実装を書き換えても
 * 無条件に緑になる**偽の安全信号**だった (100倍バグの再発防止を名乗りながら、
 * 実装側の 100 で割る行を消しても通る)。
 */
export function normalizeQuote(row: {
  price: number | null;
  dividendYield: number | null;
}): { dividendYield: number | null; estimatedDividend: number | null } {
  // DB は % 値 (3.43) で保存されているため decimal (0.0343) に正規化する
  // (Yahoo Finance API の生値が % 値で、kabulab 全体の DB がそれを継承している)
  const rawDy = row.dividendYield;
  const dy = rawDy !== null && Number.isFinite(rawDy) ? rawDy / 100 : null;
  const price = row.price;
  const estimatedDividend =
    price !== null && dy !== null && Number.isFinite(price) && Number.isFinite(dy) && dy > 0
      ? price * dy
      : null;
  return { dividendYield: dy, estimatedDividend };
}

/**
 * 銘柄コードに対する価格コンテキストを返す。**D1 を読むだけで書かない。**
 *
 * - 銘柄コードが正準パターンに一致しない場合は throw
 * - `core_stocks` に無い / `core_stock_financials` に断面が無い場合も throw
 *   (呼び出し側が「取得に失敗」として UI に出す。0 や null で埋めない)
 */
export async function getPriceContext(
  db: Database,
  code: string
): Promise<PriceContext> {
  // 入力を正準形 (大文字・半角) に正規化してから検証・問い合わせする。
  const c = normalizeStockCode(code);
  if (!JP_STOCK_PATTERN.test(c)) {
    throw new Error(`不正な銘柄コード: ${code} — ${STOCK_CODE_ERROR}`);
  }

  const [row] = await db
    .select({
      code: coreStocks.code,
      name: coreStocks.name,
      price: stockFinancials.price,
      dividendYield: stockFinancials.dividendYield,
      marketCap: stockFinancials.marketCap,
      dataDate: stockFinancials.dataDate,
      fetchedAt: stockFinancials.fetchedAt,
    })
    .from(coreStocks)
    .innerJoin(stockFinancials, eq(stockFinancials.stockId, coreStocks.id))
    .where(eq(coreStocks.code, c))
    .limit(1);

  if (!row) {
    throw new Error(
      `銘柄 ${c} の価格断面が D1 にありません` +
        " (core_stock_financials 未登録。日次 sync の対象外か新規上場直後の可能性)"
    );
  }

  const { dividendYield, estimatedDividend } = normalizeQuote(row);
  return {
    code: row.code,
    name: row.name,
    price: row.price,
    dividendYield,
    estimatedDividend,
    marketCap: row.marketCap,
    asOf: row.dataDate,
    fetchedAt: row.fetchedAt,
  };
}

/** 日足 OHLCV — 1 行 = 1 営業日 */
export interface OhlcvBar {
  date: string;        // YYYY-MM-DD
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  /** 分割調整済み終値 (Yahoo adjclose)。市場系列 (^N225) では常に null */
  adj?: number | null;
}

/**
 * シンボル (証券コード または ^N225) の日足系列を返す。**D1 を読むだけで書かない。**
 *
 * - 証券コード: `swing_daily_ohlcv` (日次 sync が書く。保持 90 営業日)
 * - `^N225`: `swing_market_context.nikkei_close`
 *   (`swing_daily_ohlcv` の FK は `core_stocks` なので指数は置けない)
 * - 戻り値は date 昇順。データが無ければ空配列 (呼び出し側が本数不足として扱う)
 *
 * 市場系列の 1 行は「日次 sync の run 1 回」に対応する。cron は平日 21:00 UTC の
 * 1 本なので実質は営業日の系列だが、**取引所の休場日にも 1 行できる**
 * (その日の `nikkei_close` は前営業日の値のまま)。β の日付整合は
 * 個別銘柄側の日付との積集合を取るので、休場日は個別銘柄にバーが無く自然に
 * 落ちる。それでも「市場系列の 1 行 = 1 営業日」ではないことは覚えておくこと。
 */
export async function getOhlcvSeries(
  db: Database,
  symbol: string
): Promise<OhlcvBar[]> {
  assertSymbol(symbol);

  if (isIndexSymbol(symbol)) {
    const rows = await db
      .select({
        date: marketContext.date,
        close: marketContext.nikkeiClose,
      })
      .from(marketContext)
      .where(isNotNull(marketContext.nikkeiClose))
      .orderBy(asc(marketContext.date));
    // 日経平均は終値しか持っていない。OHLC を close で埋めると「始値も
    // 終値と同じ」という嘘になるので null のままにする (ルール1)。
    return rows.map((r) => ({
      date: r.date,
      open: null,
      high: null,
      low: null,
      close: r.close,
      volume: null,
      adj: null,
    }));
  }

  const c = normalizeStockCode(symbol);
  return await db
    .select({
      date: swingDailyOhlcv.date,
      open: swingDailyOhlcv.open,
      high: swingDailyOhlcv.high,
      low: swingDailyOhlcv.low,
      close: swingDailyOhlcv.close,
      volume: swingDailyOhlcv.volume,
      adj: swingDailyOhlcv.adj,
    })
    .from(swingDailyOhlcv)
    .innerJoin(coreStocks, eq(swingDailyOhlcv.stockId, coreStocks.id))
    .where(and(eq(coreStocks.code, c), isNotNull(swingDailyOhlcv.close)))
    .orderBy(asc(swingDailyOhlcv.date));
}
