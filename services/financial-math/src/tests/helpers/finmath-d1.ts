/**
 * 004 financial-math の統合テスト用 D1 スタブ。
 *
 * `routes.test.ts` は long code なしの GET パスしか叩いておらず、**code 付きの
 * GET/POST の統合テストが 1 件も無かった**。ちょうどそこが読み取り面の
 * Yahoo 呼び出し → D1 書き込みが起きていた経路で、テストが緑でも
 * 「SSR の GET 中に本番 D1 の行が書き換わる」ことは誰も見ていなかった。
 *
 * miniflare (@cloudflare/vitest-pool-workers) は使わない: node_modules が
 * 元リポジトリへの symlink で依存を足せず、検証したいのも Workers ランタイムでは
 * なく「どの表を読み、どこにも書かないか」である。drizzle-orm/d1 が触るのは
 * `prepare().bind().{all,raw,run,first}` と `batch` だけなので、その範囲を
 * `node:sqlite` に被せれば本物の SQL がそのまま走る
 * (services/rsi-screening/src/tests/helpers/sqlite-d1.ts と同じ方式)。
 */
import { DatabaseSync } from "node:sqlite";

/**
 * 004 が読む表の DDL。`src/shared/db/core-schema.ts` /
 * `src/shared/db/projection-schema.ts` / `services/swing-trading/src/db/schema.ts` /
 * `services/financial-math/src/db/finmath-schema.ts` に対応する。
 *
 * `finmath_price_snapshot` / `finmath_daily_ohlcv` を**あえて含めている**。
 * 004 はもう読まないが、本番にはまだ実在する。テスト DB から消してしまうと
 * 「実は書いていた」という退行が `no such table` で落ちるのでなく
 * **本番でだけ起きる**ようになる。ここに置いておけば、書きに行った瞬間に
 * 行数の検査が落ちる。
 */
export const FINMATH_DDL = `
CREATE TABLE core_stocks (
  id integer PRIMARY KEY AUTOINCREMENT,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  market text NOT NULL,
  sector text,
  is_active integer NOT NULL DEFAULT 1,
  is_yutai integer NOT NULL DEFAULT 0,
  created_at integer NOT NULL DEFAULT (unixepoch()),
  updated_at integer NOT NULL DEFAULT (unixepoch()),
  instrument_type text, sector33 text, sector17 text, edinet_code text,
  listing_status text, listing_date text, delisting_date text,
  license_tag text, src_source text, src_data_date text,
  src_fetched_at integer, quality text
);
CREATE TABLE core_stock_financials (
  id integer PRIMARY KEY AUTOINCREMENT,
  stock_id integer NOT NULL UNIQUE REFERENCES core_stocks(id),
  price real, per real, pbr real, dividend_yield real, eps real, bps real,
  roe real, roa real, market_cap real, operating_margin real,
  data_date text NOT NULL,
  fetched_at integer NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE swing_daily_ohlcv (
  id integer PRIMARY KEY AUTOINCREMENT,
  stock_id integer NOT NULL,
  date text NOT NULL,
  open real, high real, low real, close real, volume real, adj real,
  UNIQUE (stock_id, date)
);
CREATE TABLE swing_stock_indicators (
  stock_id integer PRIMARY KEY,
  avg_turnover_20d real, volume_20d real, volume_ratio real,
  atr_14 real, atr_pct real,
  sma_5 real, sma_20 real, sma_25 real, sma_60 real, sma_75 real,
  trend_long integer NOT NULL DEFAULT 0,
  trend_short integer NOT NULL DEFAULT 0,
  perfect_order_long integer NOT NULL DEFAULT 0,
  perfect_order_short integer NOT NULL DEFAULT 0,
  rsi_14 real, macd real, macd_signal real, macd_hist real,
  range_20d_high real, range_20d_low real, range_width real,
  fib_high real, fib_low real, fib_382 real, fib_500 real, fib_618 real,
  latest_close real, latest_volume real, latest_date text, pct_change_1d real,
  computed_at integer NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE swing_market_context (
  date text PRIMARY KEY,
  nikkei_close real, nikkei_pct real, nikkei_vi real,
  topix_turnover_ratio real, futures_gap real, vix real, sp500_pct real,
  judgment text NOT NULL,
  judgment_reason text NOT NULL,
  computed_at integer NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE p_momentum (
  stock_id integer PRIMARY KEY NOT NULL,
  as_of text NOT NULL,
  source_max_date text NOT NULL,
  bars integer NOT NULL,
  closes text NOT NULL,
  computed_at integer NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE finmath_price_snapshot (
  id integer PRIMARY KEY AUTOINCREMENT,
  code text NOT NULL UNIQUE,
  name text, price real, per real, pbr real, dividend_yield real,
  eps real, bps real, roe real, roa real, market_cap real,
  operating_margin_ttm real,
  data_date text NOT NULL,
  fetched_at integer NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE finmath_daily_ohlcv (
  id integer PRIMARY KEY AUTOINCREMENT,
  symbol text NOT NULL,
  date text NOT NULL,
  open real, high real, low real, close real, volume real, adj real,
  fetched_at integer NOT NULL DEFAULT (unixepoch()),
  UNIQUE (symbol, date)
);
`;

export interface FinmathD1 {
  /** Hono の env へ渡す D1 バインディング相当 */
  binding: unknown;
  /** 直接 SQL を打つ用 (シード / 検査) */
  sqlite: DatabaseSync;
  /** 実行された SQL 文 (書き込みが起きていないことの検査に使う) */
  executed: string[];
  close: () => void;
}

/**
 * DDL 適用済みの SQLite を D1 バインディング互換オブジェクトとして返す。
 *
 * `executed` に実行された SQL をそのまま積む。「GET で INSERT/UPDATE が
 * 1 文も出ないこと」を**行数ではなく SQL の形**で見られるようにするため
 * (行数だけだと upsert が同値を書いたケースを取り逃がす)。
 */
export function createFinmathD1(ddl: string = FINMATH_DDL): FinmathD1 {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(ddl);
  const executed: string[] = [];

  const prepare = (query: string) => {
    const make = (params: unknown[]) => ({
      all: async () => {
        executed.push(query);
        return {
          results: sqlite.prepare(query).all(...(params as never[])),
          success: true,
          meta: {},
        };
      },
      raw: async () => {
        executed.push(query);
        const stmt = sqlite.prepare(query);
        const names = stmt.columns().map((col) => col.name);
        const rows = stmt.all(...(params as never[])) as Record<string, unknown>[];
        // drizzle は列の**位置**で値を戻すので columns() の順序で並べ直す
        // (同名列があると Object.values では順序が崩れる)。
        return rows.map((row) => names.map((n) => row[n]));
      },
      run: async () => {
        executed.push(query);
        return {
          results: [],
          success: true,
          meta: sqlite.prepare(query).run(...(params as never[])),
        };
      },
      first: async () => {
        executed.push(query);
        return sqlite.prepare(query).get(...(params as never[])) ?? null;
      },
      bind: (...next: unknown[]) => make(next),
    });
    return make([]);
  };

  return {
    binding: {
      prepare,
      batch: async (list: { all: () => Promise<unknown> }[]) =>
        Promise.all(list.map((s) => s.all())),
    },
    sqlite,
    executed,
    close: () => sqlite.close(),
  };
}

/** `executed` のうち書き込み文 (INSERT / UPDATE / DELETE / REPLACE) */
export function writeStatements(executed: string[]): string[] {
  return executed.filter((q) => /^\s*(insert|update|delete|replace)\b/i.test(q));
}
