/**
 * スクリーニングの鮮度条件 (computed_at) の検証。
 *
 * 実 SQLite (node:sqlite) を D1 バインディング互換スタブに被せて screenStocks を
 * そのまま走らせる。純関数テストだと「境界計算は合っているが WHERE 句に入れ
 * 忘れている」状態を通してしまうため、SQL ごと確認する。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as coreSchema from "../../../../../src/shared/db/core-schema.js";
import * as rsiSchema from "../../db/schema.js";
import {
  PERCENTILE_MAX_AGE_DAYS,
  percentileFreshnessCutoff,
  screenStocks,
} from "../../services/screening-service.js";
import { screeningQuerySchema } from "../../validators/screening.js";
import { app } from "../../index.js";
import { createSqliteD1 } from "../helpers/sqlite-d1.js";

/**
 * テスト用 DDL。参照するのは screenStocks が触る 3 表だけ。
 * (drizzle のスナップショットから生成する案は、他サービス 18 表の DDL を
 *  引き込んでテストの意図が読めなくなるので採らない)
 */
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
  -- 移行 P4a が本番へ足した 12 列。全 nullable / default なし (本番 PRAGMA と同じ)。
  -- ここで使う値は無いが、drizzle の insert は列指定なしで全列を並べるので
  -- 落とすと "table core_stocks has no column named instrument_type" で落ちる。
  instrument_type text, sector33 text, sector17 text, edinet_code text,
  listing_status text, listing_date text, delisting_date text,
  license_tag text, src_source text, src_data_date text,
  src_fetched_at integer, quality text
);
CREATE TABLE core_stock_financials (
  id integer PRIMARY KEY AUTOINCREMENT,
  stock_id integer NOT NULL UNIQUE,
  price real, per real, pbr real, dividend_yield real,
  eps real, bps real, roe real, roa real, market_cap real,
  operating_margin real,
  data_date text NOT NULL,
  fetched_at integer NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE rsi_percentile (
  id integer PRIMARY KEY AUTOINCREMENT,
  stock_id integer NOT NULL UNIQUE,
  rsi_10 real, rsi_10_percentile real,
  rsi_40 real, rsi_40_percentile real,
  rsi_120 real, rsi_120_percentile real,
  rsi_min_percentile real,
  is_blue_chip integer NOT NULL DEFAULT 0,
  operating_margin_ttm real,
  revenue_trend integer,
  percentile_sample_bars integer,
  computed_at integer NOT NULL DEFAULT (unixepoch())
);
`;

/** 月曜 06:00 JST 相当 (日次 sync が回った直後の時刻) */
const NOW = new Date("2026-09-14T21:30:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

type Harness = ReturnType<typeof createSqliteD1>;
let harness: Harness;
let db: ReturnType<typeof makeDb>;

function makeDb(d1: D1Database) {
  return drizzle(d1, { schema: { ...coreSchema, ...rsiSchema } });
}

/** 銘柄 1 件 + パーセンタイル 1 行を投入する */
async function seed(input: {
  code: string;
  minPercentile: number;
  computedAt: Date;
  isActive?: boolean;
  /** 既定は `equity` (日次の処理対象)。`null` は未分類。 */
  instrumentType?: string | null;
  sampleBars?: number | null;
}): Promise<void> {
  const [stock] = await db
    .insert(coreSchema.stocks)
    .values({
      code: input.code,
      name: `テスト ${input.code}`,
      market: "プライム",
      isActive: input.isActive ?? true,
      instrumentType: input.instrumentType === undefined ? "equity" : input.instrumentType,
    })
    .returning({ id: coreSchema.stocks.id });

  await db.insert(rsiSchema.stockRsiPercentile).values({
    stockId: stock.id,
    rsi10: 30,
    rsi10Percentile: input.minPercentile,
    rsi40: 35,
    rsi40Percentile: input.minPercentile + 10,
    rsi120: 40,
    rsi120Percentile: input.minPercentile + 20,
    rsiMinPercentile: input.minPercentile,
    percentileSampleBars: input.sampleBars === undefined ? 1223 : input.sampleBars,
    computedAt: input.computedAt,
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

describe("percentileFreshnessCutoff", () => {
  it("上限日数ぶん過去へ戻した時刻を返す", () => {
    expect(percentileFreshnessCutoff(NOW).toISOString()).toBe(
      "2026-09-07T21:30:00.000Z"
    );
  });

  it("上限は平日 cron の金→月 (3 日) より長い", () => {
    // 週末を跨ぐ行を誤除外しないための最低条件。
    expect(PERCENTILE_MAX_AGE_DAYS).toBeGreaterThan(3);
  });
});

describe("screenStocks の鮮度条件", () => {
  it("古い computed_at の行は結果に出ない (パーセンタイルが最小でも)", async () => {
    // 実測で見つかった状態の再現: 4 ヶ月前の行が最も底値に見えて先頭に来る。
    await seed({
      code: "1001",
      minPercentile: 1,
      computedAt: new Date("2026-05-15T21:10:00.000Z"),
    });
    await seed({
      code: "1002",
      minPercentile: 3,
      computedAt: new Date(NOW.getTime() - DAY_MS),
    });

    const result = await screenStocks(db, query, NOW);

    expect(result.rows.map((r) => r.code)).toEqual(["1002"]);
    expect(result.staleExcluded).toBe(1);
    expect(result.maxAgeDays).toBe(PERCENTILE_MAX_AGE_DAYS);
  });

  it("金曜に算出した行は週末を跨いだ月曜でも残る", async () => {
    // 日次 cron は平日のみ (0 21 * * 1-5) なので、月曜朝に見える最新値は
    // 金曜 21:00 UTC 算出のもの = 3 日前。これを落としたら実害しかない。
    await seed({
      code: "2001",
      minPercentile: 4,
      computedAt: new Date("2026-09-11T21:10:00.000Z"),
    });

    const result = await screenStocks(db, query, NOW);

    expect(result.rows.map((r) => r.code)).toEqual(["2001"]);
    expect(result.staleExcluded).toBe(0);
  });

  it("上限ちょうど手前は残し、上限を超えた行だけ落とす", async () => {
    const cutoff = percentileFreshnessCutoff(NOW);
    await seed({
      code: "3001",
      minPercentile: 5,
      computedAt: new Date(cutoff.getTime() + 60_000),
    });
    await seed({
      code: "3002",
      minPercentile: 6,
      computedAt: new Date(cutoff.getTime() - 60_000),
    });

    const result = await screenStocks(db, query, NOW);

    expect(result.rows.map((r) => r.code)).toEqual(["3001"]);
    expect(result.staleExcluded).toBe(1);
  });

  it("鮮度以外の条件で落ちる行は除外件数に数えない", async () => {
    // 「鮮度不足で除外 N 件」は読者への説明なので、閾値外・非上場まで
    // 数えると数字が意味を失う。
    await seed({
      code: "4001",
      minPercentile: 80, // percentileMax=10 の対象外
      computedAt: new Date("2026-05-15T21:10:00.000Z"),
    });
    await seed({
      code: "4002",
      minPercentile: 2,
      computedAt: new Date("2026-05-15T21:10:00.000Z"),
      isActive: false,
    });
    await seed({
      code: "4003",
      minPercentile: 2,
      computedAt: new Date("2026-05-15T21:10:00.000Z"),
    });

    const result = await screenStocks(db, query, NOW);

    expect(result.rows).toHaveLength(0);
    expect(result.staleExcluded).toBe(1);
  });

  it("母数と算出時刻を行に載せて返す", async () => {
    await seed({
      code: "5001",
      minPercentile: 2,
      computedAt: new Date("2026-09-11T21:10:00.000Z"),
      sampleBars: 461,
    });
    await seed({
      code: "5002",
      minPercentile: 3,
      computedAt: new Date("2026-09-11T21:10:00.000Z"),
      sampleBars: null, // sync が 1 周していない行は NULL のまま
    });

    const result = await screenStocks(db, query, NOW);

    expect(result.rows.map((r) => r.percentileSampleBars)).toEqual([461, null]);
    expect(result.rows[0].computedAt.toISOString()).toBe(
      "2026-09-11T21:10:00.000Z"
    );
  });

  it("instrument_type が equity 以外の行は、結果にも鮮度除外件数にも入らない", async () => {
    // 日次取込は active かつ equity だけを更新する。REIT 等の行は凍結したまま残るので、
    // 結果に並べると古い値が今日の底値に見え、鮮度除外に数えると「条件には合うが
    // 古い」件数が母集団外の行で水増しされる。
    const fresh = new Date(NOW.getTime() - DAY_MS);
    const stale = new Date("2026-05-15T21:10:00.000Z");
    await seed({ code: "6001", minPercentile: 3, computedAt: fresh });
    await seed({ code: "1201", minPercentile: 1, computedAt: fresh, instrumentType: "reit_fund" });
    await seed({ code: "6003", minPercentile: 2, computedAt: fresh, instrumentType: null });
    await seed({ code: "6004", minPercentile: 2, computedAt: stale });
    await seed({ code: "1203", minPercentile: 2, computedAt: stale, instrumentType: "reit_fund" });

    const result = await screenStocks(db, query, NOW);

    expect(result.rows.map((r) => r.code)).toEqual(["6001"]);
    expect(result.staleExcluded).toBe(1);
  });
});

describe("GET / (ホーム) の銘柄数", () => {
  // ホームの total は screenStocks と同じ母集団 (active かつ equity) で数える。
  // src/shared/db/active-equity.test.ts の静的検査は `eq(stocks.isActive, true)` の
  // 字面しか見ないので、述語の削除や別表記での戻しはここで値として捕まえる。
  it("非普通株・instrument_type NULL・上場廃止を数えない", async () => {
    const fresh = new Date(NOW.getTime() - DAY_MS);
    await seed({ code: "1001", minPercentile: 5, computedAt: fresh });
    await seed({ code: "1002", minPercentile: 5, computedAt: fresh, instrumentType: "reit_fund" });
    await seed({ code: "1003", minPercentile: 5, computedAt: fresh, instrumentType: null });
    await seed({ code: "1004", minPercentile: 5, computedAt: fresh, isActive: false });

    const res = await app.request("/", {}, { DB: harness.db });
    expect(res.status).toBe(200);
    // 述語を外すと 4、is_active 単独に戻すと 3。
    expect(await res.text()).toMatch(/<span class="num">1<\/span>\s*<span class="lbl">Stocks<\/span>/);
  });
});
