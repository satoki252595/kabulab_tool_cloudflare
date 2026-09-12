/**
 * OHLCV 保持期間の一括 prune の検証。
 *
 * 以前の prune は writeStockSnapshot の中にあり、Yahoo 取得が失敗し続けている
 * 銘柄では一度も走らなかった (実測で 120→90 短縮前の 120 行を保持したままの
 * 銘柄が残っていた)。「同期に現れない銘柄でも本数が収束する」ことがこの
 * 変更の要件なので、実 SQLite に対して SQL ごと確認する。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as coreSchema from "../shared/db/core-schema.js";
import * as rsiSchema from "../../services/rsi-screening/src/db/schema.js";
import * as swingSchema from "../../services/swing-trading/src/db/schema.js";
import { pruneOhlcvRetention, selectOverRetentionStocks } from "./daily.js";

const DDL = `
CREATE TABLE swing_daily_ohlcv (
  id integer PRIMARY KEY AUTOINCREMENT,
  stock_id integer NOT NULL,
  date text NOT NULL,
  open real, high real, low real, close real, volume real, adj real,
  UNIQUE (stock_id, date)
);
`;

let sqlite: DatabaseSync;
let db: ReturnType<typeof makeProxyDb>;
let executed: string[];

/**
 * createD1HttpDb と同じ sqlite-proxy 経路をローカル SQLite に向ける。
 * (D1 REST を叩く本物は API トークンを要求するのでテストからは使えない)
 */
function makeProxyDb(target: DatabaseSync, log: string[]) {
  return drizzle(
    async (sqlStr, params, method) => {
      log.push(sqlStr);
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
    { schema: { ...coreSchema, ...rsiSchema, ...swingSchema } }
  );
}

/** stockId に bars 本の連続営業日バーを入れる */
function seedBars(stockId: number, bars: number): void {
  const insert = sqlite.prepare(
    "INSERT INTO swing_daily_ohlcv (stock_id, date, close) VALUES (?, ?, ?)"
  );
  const start = new Date("2026-01-05T00:00:00.000Z").getTime();
  for (let i = 0; i < bars; i++) {
    const date = new Date(start + i * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    insert.run(stockId, date, 100 + i);
  }
}

function barsOf(stockId: number): { count: number; maxDate: string } {
  const row = sqlite
    .prepare(
      "SELECT COUNT(*) AS c, MAX(date) AS m FROM swing_daily_ohlcv WHERE stock_id = ?"
    )
    .get(stockId) as { c: number; m: string };
  return { count: row.c, maxDate: row.m };
}

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(DDL);
  executed = [];
  db = makeProxyDb(sqlite, executed);
});

afterEach(() => {
  sqlite.close();
});

describe("selectOverRetentionStocks", () => {
  it("保持本数を超えた銘柄と超過本数だけを返す", () => {
    expect(
      selectOverRetentionStocks(
        [
          { stockId: 1, bars: 120 },
          { stockId: 2, bars: 90 },
          { stockId: 3, bars: 91 },
          { stockId: 4, bars: 3 },
        ],
        90
      )
    ).toEqual([
      { stockId: 1, excessBars: 30 },
      { stockId: 3, excessBars: 1 },
    ]);
  });
});

describe("pruneOhlcvRetention", () => {
  it("同期に現れない銘柄でも新しい方から保持本数ぶんだけ残す", async () => {
    // 実測の残骸を模す: 120→90 短縮前の 120 行を保持したまま同期が止まった銘柄。
    seedBars(640, 120);
    const before = barsOf(640);

    const result = await pruneOhlcvRetention(db, 90);

    const after = barsOf(640);
    expect(after.count).toBe(90);
    // 消すのは古い方。最新日は保たれる。
    expect(after.maxDate).toBe(before.maxDate);
    expect(result).toEqual({ prunedStocks: 1, deletedRows: 30 });
  });

  it("保持本数以下の銘柄には触らない", async () => {
    seedBars(1, 90);
    seedBars(2, 12);

    const result = await pruneOhlcvRetention(db, 90);

    expect(barsOf(1).count).toBe(90);
    expect(barsOf(2).count).toBe(12);
    expect(result).toEqual({ prunedStocks: 0, deletedRows: 0 });
    // 対象 0 件なら DELETE を投げない (無駄な書込を出さない)。
    expect(executed.some((s) => s.includes("DELETE FROM"))).toBe(false);
  });

  it("bind 上限を超える銘柄数は複数文に分割する", async () => {
    // D1 は 1 文 100 bind まで。51 銘柄を 1 文に詰めると落ちる。
    for (let stockId = 1; stockId <= 55; stockId++) seedBars(stockId, 92);

    const result = await pruneOhlcvRetention(db, 90);

    expect(result).toEqual({ prunedStocks: 55, deletedRows: 110 });
    for (const stockId of [1, 50, 51, 55]) {
      expect(barsOf(stockId).count).toBe(90);
    }
    const deletes = executed.filter((s) => s.includes("DELETE FROM"));
    expect(deletes).toHaveLength(2);
  });
});
