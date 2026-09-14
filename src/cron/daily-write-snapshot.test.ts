/**
 * `writeStockSnapshot` の書き込み範囲の検証。
 *
 * 移行 P5-b で ②断面 (`core_stock_financials`) の writer が stockStock 側へ移る。
 * そのとき daily.ts 側を止める手段が `options.writeCoreFinancials` しかないので、
 * **フラグが囲んでいる範囲**をテストで固定する。ここが崩れる形は 2 つある:
 *
 *   1. フラグを立てても ②断面が書かれる  → 二重 writer になり、残る値が実行順で
 *      決まる (新しい fetched_at に古い価格が乗る)。
 *   2. フラグで年次 (`core_stock_annual_financials`) まで止まる → 移行対象でない
 *      売上推移が無言で止まる。
 *
 * 実 SQLite を立てず SQL 文字列を記録する driver を使うのは、ここで見たいのが
 * 「どのテーブルに INSERT を発行したか」だけで、6 表の DDL を並べると DDL 側の
 * 写し間違いでテストが落ちる（検証したい性質と無関係な保守コストが乗る）ため。
 */
import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as coreSchema from "../shared/db/core-schema.js";
import * as rsiSchema from "../../services/rsi-screening/src/db/schema.js";
import * as swingSchema from "../../services/swing-trading/src/db/schema.js";
import * as projectionSchema from "../shared/db/projection-schema.js";
import { writeStockSnapshot } from "./daily.js";

/** createD1HttpDb と同じ sqlite-proxy 経路で、発行 SQL だけを記録する。 */
function makeRecordingDb(): {
  db: Parameters<typeof writeStockSnapshot>[0];
  statements: string[];
} {
  const statements: string[] = [];
  const db = drizzle(
    async (sqlStr) => {
      statements.push(sqlStr);
      return { rows: [] };
    },
    { schema: { ...coreSchema, ...rsiSchema, ...swingSchema, ...projectionSchema } }
  );
  return { db: db as Parameters<typeof writeStockSnapshot>[0], statements };
}

/**
 * StockSnapshot は export されていないので、関数の引数型から借りる。
 * (テストのために本体の型を export すると、内部表現が API になってしまう)
 */
type Snapshot = Parameters<typeof writeStockSnapshot>[1];

/**
 * 最小スナップショット。
 * - `annualFinancials` は 1 件入れる (年次 insert を発火させるため)
 * - `ohlcv6mo` は空 (OHLCV の chunk ループを回さない)
 * - `latestClose` は null (entry signal の再挿入分岐に入らない)
 */
const SNAP: Snapshot = {
  stockId: 1,
  code: "7203",
  sector: "輸送用機器",
  latestClose: null,
  latestOpen: null,
  latestHigh: null,
  latestLow: null,
  latestVolume: null,
  latestDate: "2026-09-11",
  previousClose: null,
  price: 1234,
  per: 10,
  pbr: 1.1,
  dividendYield: 0.03,
  eps: 120,
  bps: 1100,
  roe: 0.11,
  roa: 0.05,
  marketCap: 1e12,
  operatingMarginTtm: 0.1,
  dataDate: "2026-09-11",
  annualFinancials: [{ fiscalYear: 2025, revenue: 1e13 }],
  rsiPercentile: {
    rsi10: null,
    rsi10Percentile: null,
    rsi40: null,
    rsi40Percentile: null,
    rsi120: null,
    rsi120Percentile: null,
    rsiMinPercentile: null,
    sampleBars: 0,
  },
  blueChip: { isBlueChip: false, operatingMarginTtm: null, revenueTrend: null },
  sma5: null,
  sma20: null,
  sma25: null,
  sma60: null,
  sma75: null,
  atr14: null,
  atrPct: null,
  rsi14: null,
  macd: null,
  macdSignal: null,
  macdHist: null,
  range20dHigh: null,
  range20dLow: null,
  rangeWidth: null,
  fib382: null,
  fib500: null,
  fib618: null,
  avgTurnover20d: null,
  volume20d: null,
  volumeRatio: null,
  pctChange1d: null,
  trendLong: false,
  trendShort: false,
  perfectOrderLong: false,
  perfectOrderShort: false,
  ohlcv6mo: [],
};

/** `core_stock_financials` への INSERT のみ数える (年次と名前が前方一致するため境界付き)。 */
function countInsertsInto(statements: string[], table: string): number {
  const pattern = new RegExp(`insert into "${table}"`, "i");
  return statements.filter((s) => pattern.test(s)).length;
}

describe("writeStockSnapshot の options.writeCoreFinancials", () => {
  it("既定では ②断面を書く (既存の呼び出し元の挙動を変えない)", async () => {
    const { db, statements } = makeRecordingDb();
    await writeStockSnapshot(db, SNAP, undefined);
    expect(countInsertsInto(statements, "core_stock_financials")).toBe(1);
  });

  it("options を渡さないのと {} を渡すのが同じ", async () => {
    const { db, statements } = makeRecordingDb();
    await writeStockSnapshot(db, SNAP, undefined, {});
    expect(countInsertsInto(statements, "core_stock_financials")).toBe(1);
  });

  it("false なら ②断面を書かない", async () => {
    const { db, statements } = makeRecordingDb();
    await writeStockSnapshot(db, SNAP, undefined, {
      writeCoreFinancials: false,
    });
    expect(countInsertsInto(statements, "core_stock_financials")).toBe(0);
  });

  it("false でも年次 (core_stock_annual_financials) は書く", async () => {
    // 年次は Yahoo の annualFinancials が唯一の出所で P5-b の移行対象外。
    // ここを一緒に囲むと、フラグを立てた瞬間に売上推移が無言で止まる。
    const { db, statements } = makeRecordingDb();
    await writeStockSnapshot(db, SNAP, undefined, {
      writeCoreFinancials: false,
    });
    expect(countInsertsInto(statements, "core_stock_annual_financials")).toBe(1);
  });

  it("false でも core 以外 (rsi / swing) の書き込みは変わらない", async () => {
    const on = makeRecordingDb();
    const off = makeRecordingDb();
    await writeStockSnapshot(on.db, SNAP, undefined);
    await writeStockSnapshot(off.db, SNAP, undefined, {
      writeCoreFinancials: false,
    });

    for (const table of [
      "rsi_percentile",
      "swing_stock_indicators",
      "swing_stock_screening",
    ]) {
      expect(countInsertsInto(off.statements, table), table).toBe(
        countInsertsInto(on.statements, table)
      );
    }
    // 差分は ②断面の 1 文だけであること (囲む範囲が広がっていないことの検査)。
    expect(on.statements.length - off.statements.length).toBe(1);
  });
});

describe("writeStockSnapshot の options.writeAnnual", () => {
  it("既定では年次を書く", async () => {
    const { db, statements } = makeRecordingDb();
    await writeStockSnapshot(db, SNAP, undefined);
    expect(countInsertsInto(statements, "core_stock_annual_financials")).toBe(1);
  });

  it("false なら年次を書かない (L-49。呼び出し側が月曜のみ真にする)", async () => {
    const on = makeRecordingDb();
    const off = makeRecordingDb();
    await writeStockSnapshot(on.db, SNAP, undefined, { writeAnnual: true });
    await writeStockSnapshot(off.db, SNAP, undefined, { writeAnnual: false });
    expect(countInsertsInto(off.statements, "core_stock_annual_financials")).toBe(0);
    // 差分は年次の 1 文だけであること。
    expect(on.statements.length - off.statements.length).toBe(1);
  });
});

describe("writeStockSnapshot の p_momentum upsert", () => {
  const BARS = [
    { date: "2026-09-09", open: null, high: null, low: null, close: 100, volume: null },
    { date: "2026-09-10", open: null, high: null, low: null, close: 110, volume: null },
    { date: "2026-09-11", open: null, high: null, low: null, close: 121, volume: null },
  ];

  it("6mo スライスから 1 文 upsert する (L-47)", async () => {
    const { db, statements } = makeRecordingDb();
    await writeStockSnapshot(
      db,
      { ...SNAP, ohlcv6mo: BARS },
      "2026-09-10"
    );
    expect(countInsertsInto(statements, "p_momentum")).toBe(1);
  });

  it("有効な終値が無ければ投影しない", async () => {
    const { db, statements } = makeRecordingDb();
    await writeStockSnapshot(db, SNAP, undefined);
    expect(countInsertsInto(statements, "p_momentum")).toBe(0);
  });
});
