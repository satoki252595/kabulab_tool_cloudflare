/**
 * `screenStocks` の JOIN 順序固定 (CROSS JOIN) が結果を変えないことの検証。
 *
 * INNER JOIN だと SQLite が `core_stocks` の索引を外側ループに選び直し、
 * パーセンタイルの索引を使わなくなる (L-48)。`rsi_percentile` を左に置く
 * CROSS JOIN + WHERE の等値へ変えたが、返る行は INNER JOIN と同じ。
 * 固定したい契約:
 *
 *   1. 行の内容と順序 (percentile 昇順) が変わらない。
 *   2. 結合述語の脱落はデカルト積 (N×M 行) になるので、件数で捕まえる。
 *
 * 実 SQLite (node:sqlite) を D1 バインディング互換スタブに被せて
 * screenStocks をそのまま走らせる (screening-freshness.test.ts と同じ方式)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as coreSchema from "../../../../../src/shared/db/core-schema.js";
import * as rsiSchema from "../../db/schema.js";
import { screenStocks } from "../../services/screening-service.js";
import { screeningQuerySchema } from "../../validators/screening.js";
import { createSqliteD1 } from "../helpers/sqlite-d1.js";

const DDL = `
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
  stock_id integer PRIMARY KEY NOT NULL,
  price real, per real, pbr real, dividend_yield real,
  eps real, bps real, roe real, roa real, market_cap real,
  operating_margin real,
  data_date text NOT NULL,
  fetched_at integer NOT NULL DEFAULT (unixepoch())
);
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

const NOW = new Date("2026-09-14T21:30:00.000Z");
const FRESH = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);

type Harness = ReturnType<typeof createSqliteD1>;
let harness: Harness;
let db: ReturnType<typeof makeDb>;

function makeDb(d1: D1Database) {
  return drizzle(d1, { schema: { ...coreSchema, ...rsiSchema } });
}

async function seed(code: string, minPercentile: number): Promise<void> {
  const [stock] = await db
    .insert(coreSchema.stocks)
    .values({
      code,
      name: `テスト ${code}`,
      market: "プライム",
      isActive: true,
      instrumentType: "equity",
    })
    .returning({ id: coreSchema.stocks.id });
  await db.insert(rsiSchema.stockRsiPercentile).values({
    stockId: stock.id,
    rsi10: 30,
    rsi10Percentile: minPercentile,
    rsi40: 35,
    rsi40Percentile: minPercentile,
    rsi120: 40,
    rsi120Percentile: minPercentile,
    rsiMinPercentile: minPercentile,
    percentileSampleBars: 1223,
    computedAt: FRESH,
  });
}

const query = screeningQuerySchema.parse({});

beforeEach(() => {
  harness = createSqliteD1(DDL);
  db = makeDb(harness.db);
});

afterEach(() => {
  harness.close();
});

describe("screenStocks の JOIN 順序固定 (L-48)", () => {
  it("CROSS JOIN でも行の内容と順序 (percentile 昇順) は同じ", async () => {
    await seed("1001", 8);
    await seed("1002", 2);
    await seed("1003", 5);

    const result = await screenStocks(db, query, NOW);

    expect(result.rows.map((r) => r.code)).toEqual(["1002", "1003", "1001"]);
  });

  it("結合述語が落ちるとデカルト積になる — 件数で捕まえる", async () => {
    await seed("2001", 3);
    await seed("2002", 4);
    await seed("2003", 5);

    const result = await screenStocks(db, query, NOW);

    // WHERE の等値 (`stocks.id = stock_id`) を外すと 3×3=9 行になる。
    expect(result.rows).toHaveLength(3);
  });
});
