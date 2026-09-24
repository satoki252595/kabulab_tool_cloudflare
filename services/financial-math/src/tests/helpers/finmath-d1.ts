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
 * `src/shared/db/projection-schema.ts` / `services/swing-trading/src/db/schema.ts`
 * に対応する。
 *
 * 旧 `finmath_price_snapshot` / `finmath_daily_ohlcv` は**含めない**。以前は
 * 「本番にまだ実在するので、テスト DB から消すと書き込みの退行が本番でだけ
 * 起きる」という理由で番兵行を置いていたが、drizzle/d1/0012 で本番からも
 * DROP する。本番と同じく表が無ければ、どこかが読み書きした瞬間に
 * `no such table` で 500 になり、テストの status 検査で落ちる。
 * 表を残すと逆に「本番に無い表を読む退行」をテストだけが通してしまう。
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
  instrument_type text, sector33 text
);
CREATE TABLE core_stock_financials (
  stock_id integer PRIMARY KEY NOT NULL REFERENCES core_stocks(id),
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

/** シードで使う基準日。`core_stock_financials.data_date` と日足の最終日。 */
export const SEED_AS_OF = "2026-09-11";

/** 営業日っぽい連続日付 (土日は考えない。本数と順序だけが検証対象) */
export function seedDate(i: number): string {
  return new Date(Date.UTC(2026, 4, 1) + i * 86_400_000).toISOString().slice(0, 10);
}

export interface SeedStock {
  id: number;
  code: string;
  name: string;
  /** 価格断面を作るか (false = core_stock_financials に行が無い銘柄) */
  financials?: boolean;
  price?: number;
  dividendYieldPct?: number;
  /** 日足の本数。0 なら日足なし */
  bars?: number;
  /** 初日の終値 (以降 step で増える) */
  close?: number;
  step?: number;
}

/**
 * 004 の読み取り経路に必要な最小データを入れる。
 *
 * `marketBars` は `swing_market_context` の行数。β 推定は個別銘柄と市場の
 * 日付の積集合を使うので、日付は `seedDate(0..n-1)` で銘柄側と揃えてある
 * (本番では重なるのが 94 日しかない — price-cache.ts のコメント参照)。
 */
export function seedFinmathData(
  sqlite: DatabaseSync,
  stocks: SeedStock[],
  marketBars = 0
): void {
  // instrument_type は日次の処理対象 (active かつ equity) に揃える。/emh の件数と一覧は
  // src/shared/db/active-equity.ts の述語で絞るので、NULL のままだと母集団から落ちる。
  const insStock = sqlite.prepare(
    "INSERT INTO core_stocks (id, code, name, market, sector, is_active, instrument_type) VALUES (?, ?, ?, ?, ?, 1, 'equity')"
  );
  const insFin = sqlite.prepare(
    "INSERT INTO core_stock_financials (stock_id, price, dividend_yield, market_cap, data_date) VALUES (?, ?, ?, ?, ?)"
  );
  const insBar = sqlite.prepare(
    "INSERT INTO swing_daily_ohlcv (stock_id, date, open, high, low, close, volume, adj) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );

  for (const s of stocks) {
    insStock.run(s.id, s.code, s.name, "プライム", "輸送用機器");
    if (s.financials !== false) {
      insFin.run(
        s.id,
        s.price ?? 1000,
        s.dividendYieldPct ?? 2.5,
        1.0e12,
        SEED_AS_OF
      );
    }
    const bars = s.bars ?? 0;
    const base = s.close ?? 1000;
    const step = s.step ?? 3;
    for (let i = 0; i < bars; i++) {
      // 単調増加のままだとボラが 0 に近づいて σ/β が退化するのでばらす
      const close = Math.round((base + step * i + (i % 4) * 1.5) * 100) / 100;
      insBar.run(s.id, seedDate(i), close, close * 1.01, close * 0.99, close, 1000, close);
    }
  }

  if (marketBars > 0) {
    const insMkt = sqlite.prepare(
      "INSERT INTO swing_market_context (date, nikkei_close, nikkei_pct, judgment, judgment_reason) VALUES (?, ?, ?, 'GO', 'テスト')"
    );
    for (let i = 0; i < marketBars; i++) {
      const close = Math.round((40000 + i * 55 + (i % 5) * 20) * 100) / 100;
      insMkt.run(seedDate(i), close, 0.1);
    }
  }
}
