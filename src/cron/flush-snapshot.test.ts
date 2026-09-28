import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as coreSchema from "../shared/db/core-schema.js";
import * as rsiSchema from "../../services/rsi-screening/src/db/schema.js";
import * as swingSchema from "../../services/swing-trading/src/db/schema.js";
import * as projectionSchema from "../shared/db/projection-schema.js";
import {
  flushSnapshots,
  writeStockSnapshot,
  type FlushItem,
} from "./daily.js";

/**
 * L-56: flushSnapshots のチャンク分割と D1 bind 上限の実測固定。
 *
 * createD1HttpDb と同じ sqlite-proxy 経路で実 SQL を発行させ、束縛
 * パラメータ数を数える。FLUSH_ROWS_PER_STATEMENT の行数×列数の掛け算を
 * テスト側でなぞるのではなく、drizzle が実際に積む params を測る。
 */

// StockSnapshot は export されていないので、関数の引数型から借りる。
type Snapshot = Parameters<typeof writeStockSnapshot>[1];
type Db = Parameters<typeof flushSnapshots>[0];

interface RecordedCall {
  sql: string;
  params: unknown[];
}

function makeRecordingDb(poison?: RegExp): { db: Db; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const db = drizzle(
    async (sqlStr, params) => {
      if (poison?.test(sqlStr)) throw new Error(`poisoned: ${sqlStr}`);
      calls.push({ sql: sqlStr, params: [...params] });
      return { rows: [] };
    },
    {
      schema: { ...coreSchema, ...rsiSchema, ...swingSchema, ...projectionSchema },
    }
  );
  return { db: db as Db, calls };
}

function makeSnap(stockId: number): Snapshot {
  return {
    stockId,
    code: `${1000 + stockId}`,
    sector: "テスト",
    latestClose: null,
    latestOpen: null,
    latestHigh: null,
    latestLow: null,
    latestVolume: null,
    latestDate: "2026-09-11",
    previousClose: null,
    price: 1000 + stockId,
    per: 10,
    pbr: 1,
    dividendYield: 0.02,
    eps: 100,
    bps: 1000,
    roe: 0.08,
    roa: 0.04,
    marketCap: 1e11,
    operatingMarginTtm: 0.1,
    dataDate: "2026-09-11",
    annualFinancials: [{ fiscalYear: 2025, revenue: 1e12 }],
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
    ohlcv6mo: [8, 9, 10].map((d) => ({
      date: `2026-09-0${d}`,
      open: 100,
      high: 110,
      low: 90,
      close: 100 + d,
      volume: 1000,
      adj: 100 + d,
    })),
  };
}

function countInsertsInto(calls: RecordedCall[], table: string): number {
  const pattern = new RegExp(`insert into "${table}"`, "i");
  return calls.filter((c) => pattern.test(c.sql)).length;
}

describe("flushSnapshots (L-56)", () => {
  const N = 20;
  const items: FlushItem<{ stockId: number }>[] = Array.from(
    { length: N },
    (_, i) => ({
      target: { stockId: i + 1 },
      snap: makeSnap(i + 1),
      existingMaxDate: undefined,
    })
  );

  it("表ごとにチャンク分割して flush する", async () => {
    const { db, calls } = makeRecordingDb();
    const failed = await flushSnapshots(db, items, { runStartedSec: 1 });
    expect(failed).toEqual([]);
    // annual 20/33 → 1、financials 20/8 → 3、rsi 20/8 → 3、
    // ohlcv 60 行/12 → 5、indicators 20/2 → 10、momentum 20/16 → 2。
    // signals は latestClose null のため 0 (検出依存。bind 法は下で全表に適用)。
    expect(countInsertsInto(calls, "core_stock_annual_financials")).toBe(1);
    expect(countInsertsInto(calls, "core_stock_financials")).toBe(3);
    expect(countInsertsInto(calls, "rsi_percentile")).toBe(3);
    expect(countInsertsInto(calls, "swing_daily_ohlcv")).toBe(5);
    expect(countInsertsInto(calls, "swing_stock_indicators")).toBe(10);
    expect(countInsertsInto(calls, "p_momentum")).toBe(2);
    expect(countInsertsInto(calls, "swing_entry_signals")).toBe(0);
    expect(calls).toHaveLength(1 + 3 + 3 + 5 + 10 + 2);
  });

  it("全ての文の bind 数 (実測 params) が D1 上限 100 以下", async () => {
    const { db, calls } = makeRecordingDb();
    await flushSnapshots(db, items, { runStartedSec: 1 });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.params.length, c.sql.slice(0, 80)).toBeLessThanOrEqual(100);
    }
  });

  it("空入力は何も発行せず空を返す", async () => {
    const { db, calls } = makeRecordingDb();
    const failed = await flushSnapshots(db, [], { runStartedSec: 1 });
    expect(failed).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("落ちた表の銘柄だけ失敗にし、後続の表では飛ばす", async () => {
    // indicators (5 番目の表) を毒殺。spec 順: annual → fin → rsi →
    // ohlcv → indicators → signals → momentum。
    const { db, calls } = makeRecordingDb(/insert into "swing_stock_indicators"/i);
    const failed = await flushSnapshots(db, items, { runStartedSec: 1 });
    // 10 チャンク全滅 → 20 銘柄すべて失敗。target が回収へ引き継がれる。
    expect(failed).toHaveLength(N);
    expect(failed.map((f) => f.target)).toEqual(
      items.map((it) => it.target)
    );
    // 先行 4 表は全 flush 済み、後続 (signals/momentum) は全銘柄スキップ。
    expect(countInsertsInto(calls, "core_stock_annual_financials")).toBe(1);
    expect(countInsertsInto(calls, "core_stock_financials")).toBe(3);
    expect(countInsertsInto(calls, "rsi_percentile")).toBe(3);
    expect(countInsertsInto(calls, "swing_daily_ohlcv")).toBe(5);
    expect(countInsertsInto(calls, "swing_entry_signals")).toBe(0);
    expect(countInsertsInto(calls, "p_momentum")).toBe(0);
  });

  it("1 行 flush (writeStockSnapshot) は失敗時に throw する (旧動作)", async () => {
    const { db } = makeRecordingDb(/insert into "swing_stock_indicators"/i);
    await expect(
      writeStockSnapshot(db, makeSnap(1), undefined, { runStartedSec: 1 })
    ).rejects.toThrow();
  });
});

describe("flushSnapshots の NULL 訂正再送 (F-04)", () => {
  // makeSnap の ohlcv6mo は 9/08・9/09・9/10 (いずれも実終値あり)。
  function ohlcvDates(calls: RecordedCall[]): string[] {
    const pattern = /insert into "swing_daily_ohlcv"/i;
    return calls
      .filter((c) => pattern.test(c.sql))
      .flatMap((c) => c.params)
      .filter((p): p is string => typeof p === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p));
  }

  it("保存済み NULL 日は fresh に実終値があれば再送する", async () => {
    const { db, calls } = makeRecordingDb();
    const failed = await flushSnapshots(
      db,
      [
        {
          target: { stockId: 1 },
          snap: makeSnap(1),
          existingMaxDate: "2026-09-10",
          correctionDates: new Set(["2026-09-08"]),
        },
      ],
      { runStartedSec: 1 }
    );
    expect(failed).toEqual([]);
    // 9/08 (訂正) だけ再送。9/09・9/10 (保存済み有効値) は触らない。
    expect(ohlcvDates(calls)).toEqual(["2026-09-08"]);
  });

  it("訂正対象なしでは既存日を再送しない", async () => {
    const { db, calls } = makeRecordingDb();
    const failed = await flushSnapshots(
      db,
      [{ target: { stockId: 1 }, snap: makeSnap(1), existingMaxDate: "2026-09-10" }],
      { runStartedSec: 1 }
    );
    expect(failed).toEqual([]);
    expect(ohlcvDates(calls)).toEqual([]);
  });

  it("fresh も null の訂正日は再送しない (NULL のまま正直に残す)", async () => {
    const { db, calls } = makeRecordingDb();
    const snap = makeSnap(1);
    snap.ohlcv6mo = snap.ohlcv6mo.map((b) =>
      b.date === "2026-09-08" ? { ...b, close: null, adj: null } : b
    );
    const failed = await flushSnapshots(
      db,
      [
        {
          target: { stockId: 1 },
          snap,
          existingMaxDate: "2026-09-10",
          correctionDates: new Set(["2026-09-08"]),
        },
      ],
      { runStartedSec: 1 }
    );
    expect(failed).toEqual([]);
    expect(ohlcvDates(calls)).toEqual([]);
  });

  it("1 行 flush は options.correctionDates を引き継ぐ (回収パス)", async () => {
    const { db, calls } = makeRecordingDb();
    await writeStockSnapshot(db, makeSnap(1), "2026-09-10", {
      runStartedSec: 1,
      correctionDates: new Set(["2026-09-09"]),
    });
    expect(ohlcvDates(calls)).toEqual(["2026-09-09"]);
  });
});
