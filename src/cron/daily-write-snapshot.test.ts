/**
 * `writeStockSnapshot` の書き込み範囲の検証。**フラグが囲んでいる範囲**を固定する:
 * フラグを立てても ②断面が書かれる (二重 writer) と、年次まで止まる (無言停止) の
 * 2 つの崩れを防ぐ。SQL 文字列を記録する driver で「どの表に INSERT したか」だけ見る。
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

interface RecordedCall {
  sql: string;
  params: unknown[];
}

/** makeRecordingDb の束縛パラメータ付き版。値の検査が必要なテスト用。 */
function makeRecordingDbWithParams(): {
  db: Parameters<typeof writeStockSnapshot>[0];
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const db = drizzle(
    async (sqlStr, params) => {
      calls.push({ sql: sqlStr, params: [...params] });
      return { rows: [] };
    },
    { schema: { ...coreSchema, ...rsiSchema, ...swingSchema, ...projectionSchema } }
  );
  return { db: db as Parameters<typeof writeStockSnapshot>[0], calls };
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

describe("writeStockSnapshot の screening 畳み (L-52)", () => {
  it("swing_stock_screening には書かない", async () => {
    const { db, statements } = makeRecordingDb();
    await writeStockSnapshot(db, SNAP, undefined);
    expect(
      statements.filter((s) => s.includes("swing_stock_screening")),
      "screening 表への書き込みが残っている"
    ).toEqual([]);
  });

  it("indicators の upsert に 6 列が載る", async () => {
    const { db, statements } = makeRecordingDb();
    await writeStockSnapshot(db, SNAP, undefined);
    const upsert = statements.find((s) =>
      new RegExp(`insert into "swing_stock_indicators"`, "i").test(s)
    );
    expect(upsert).toBeDefined();
    for (const col of [
      "liquidity_ok",
      "volatility_ok",
      "trend_ok_long",
      "trend_ok_short",
      "all_passed_long",
      "all_passed_short",
    ]) {
      expect(upsert, col).toContain(col);
    }
  });
});

describe("writeStockSnapshot の entry_signals INSERT-only (L-52)", () => {
  /** breakout_long を発火させる最小上書き (detectBreakoutLong の条件)。 */
  const BREAKOUT_SNAP: Snapshot = {
    ...SNAP,
    latestClose: 100,
    latestOpen: 95,
    latestHigh: 101,
    latestLow: 94,
    previousClose: 95,
    range20dHigh: 90,
    range20dLow: 80,
    rangeWidth: 10,
    volumeRatio: 2,
  };

  it("銘柄ごとの DELETE を発行しない", async () => {
    const { db, statements } = makeRecordingDb();
    // 旧コードは latestClose が null でも DELETE を打っていた。
    await writeStockSnapshot(db, SNAP, undefined);
    await writeStockSnapshot(db, BREAKOUT_SNAP, undefined);
    expect(
      statements.filter((s) => /^\s*delete\b/i.test(s)),
      "銘柄ごとの DELETE が残っている (sweep への置換漏れ)"
    ).toEqual([]);
  });

  it("シグナル INSERT に run 開始秒を刻む", async () => {
    const { db, calls } = makeRecordingDbWithParams();
    const runStartedSec = 1_700_000_000;
    await writeStockSnapshot(db, BREAKOUT_SNAP, undefined, { runStartedSec });
    const insert = calls.find((c) =>
      new RegExp(`insert into "swing_entry_signals"`, "i").test(c.sql)
    );
    expect(insert, "シグナルが発火していない (スナップの条件を見直すこと)").toBeDefined();
    expect(insert!.sql).toContain("computed_at");
    // drizzle の timestamp モードは unix 秒で束縛する (unixepoch() と同じ単位)。
    // ミリ秒で刻むと sweep の境界比較がずれて今回の行まで消す。
    expect(insert!.params).toContain(runStartedSec);
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
