/**
 * 日次 sync の起動時スキーマ検証の検証。
 *
 * このガードは「migration が本番未適用のままコードだけ先行した」状態を、
 * 3,700 銘柄の取得を始める前に落とすために置かれている (adj のときは検知が
 * 無く、2026-06-29〜07-27 のあいだ毎回終盤まで走ってから全件が書込で失敗した)。
 * 列を 1 本足すごとにガードへ足す運用なので、足し忘れを固定する。
 */
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as coreSchema from "../shared/db/core-schema.js";
import * as rsiSchema from "../../services/rsi-screening/src/db/schema.js";
import * as swingSchema from "../../services/swing-trading/src/db/schema.js";
import * as projectionSchema from "../shared/db/projection-schema.js";
import { assertDailySchema } from "./daily.js";

/** 0011 (p_momentum) 適用後の形 */
const PROJECTION_DDL = `
CREATE TABLE p_momentum (
  stock_id integer PRIMARY KEY NOT NULL,
  as_of text NOT NULL,
  source_max_date text NOT NULL,
  bars integer NOT NULL,
  closes text NOT NULL,
  computed_at integer NOT NULL DEFAULT (unixepoch())
);
`;

/** 0008 (adj) / 0009 (percentile_sample_bars) 適用後の形 */
const OHLCV_DDL_WITH_ADJ = `
CREATE TABLE swing_daily_ohlcv (
  id integer PRIMARY KEY AUTOINCREMENT,
  stock_id integer NOT NULL,
  date text NOT NULL,
  open real, high real, low real, close real, volume real, adj real,
  UNIQUE (stock_id, date)
);
`;
const OHLCV_DDL_WITHOUT_ADJ = OHLCV_DDL_WITH_ADJ.replace(", adj real", "");

const PERCENTILE_DDL_WITH_BARS = `
CREATE TABLE rsi_percentile (
  stock_id integer PRIMARY KEY NOT NULL,
  rsi_10 real, rsi_10_percentile real,
  rsi_40 real, rsi_40_percentile real,
  rsi_120 real, rsi_120_percentile real,
  rsi_min_percentile real,
  is_blue_chip integer NOT NULL DEFAULT 0,
  revenue_trend integer,
  percentile_sample_bars integer,
  computed_at integer NOT NULL DEFAULT (unixepoch())
);
`;
const PERCENTILE_DDL_WITHOUT_BARS = PERCENTILE_DDL_WITH_BARS.replace(
  "  percentile_sample_bars integer,\n",
  ""
);

let sqlite: DatabaseSync;

/** createD1HttpDb と同じ sqlite-proxy 経路をローカル SQLite に向ける */
function makeProxyDb(target: DatabaseSync) {
  return drizzle(
    async (sqlStr, params, method) => {
      const stmt = target.prepare(sqlStr);
      const bind = params as (null | number | bigint | string | Uint8Array)[];
      if (method === "run") {
        stmt.run(...bind);
        return { rows: [] };
      }
      const objs = stmt.all(...bind) as Record<string, unknown>[];
      const rows = objs.map((o) => Object.values(o));
      return { rows: method === "get" ? (rows[0] ?? []) : rows };
    },
    { schema: { ...coreSchema, ...rsiSchema, ...swingSchema, ...projectionSchema } }
  );
}

function setup(ddl: string[]): ReturnType<typeof makeProxyDb> {
  sqlite = new DatabaseSync(":memory:");
  for (const d of ddl) sqlite.exec(d);
  return makeProxyDb(sqlite);
}

afterEach(() => {
  sqlite?.close();
});

describe("assertDailySchema", () => {
  it("0008 / 0009 / 0011 が適用済みなら通る", async () => {
    const db = setup([
      OHLCV_DDL_WITH_ADJ,
      PERCENTILE_DDL_WITH_BARS,
      PROJECTION_DDL,
    ]);
    await expect(assertDailySchema(db)).resolves.toBeUndefined();
  });

  it("0009 未適用なら列名と migration ファイル名を挙げて落ちる", async () => {
    // これが無いと、全銘柄の rsi_percentile upsert が終盤まで走ってから全滅する
    // (adj のときに実際に起きた失敗の形)。
    const db = setup([
      OHLCV_DDL_WITH_ADJ,
      PERCENTILE_DDL_WITHOUT_BARS,
      PROJECTION_DDL,
    ]);
    await expect(assertDailySchema(db)).rejects.toThrow(
      /percentile_sample_bars.*0009_natural_loners\.sql/s
    );
  });

  it("0008 未適用なら 0008 を挙げて落ちる", async () => {
    const db = setup([
      OHLCV_DDL_WITHOUT_ADJ,
      PERCENTILE_DDL_WITH_BARS,
      PROJECTION_DDL,
    ]);
    await expect(assertDailySchema(db)).rejects.toThrow(
      /swing_daily_ohlcv\.adj.*0008_young_ben_urich\.sql/s
    );
  });

  it("0011 未適用なら p_momentum を挙げて落ちる", async () => {
    // p_momentum を書くのは Phase 6 (最終フェーズ)。検証が無いと、
    // 3,700 銘柄を取り終えた後に投影の書込だけが全滅する — adj のときと
    // 同じ「15 分走ってから落ちる」形になる。
    const db = setup([OHLCV_DDL_WITH_ADJ, PERCENTILE_DDL_WITH_BARS]);
    await expect(assertDailySchema(db)).rejects.toThrow(
      /p_momentum\.closes.*0011_clean_iron_fist\.sql/s
    );
  });
});
