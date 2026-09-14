/**
 * `sweepStaleEntrySignals` の検証 (L-52)。
 *
 * 銘柄ごとの無条件 DELETE (3,755 文/日) の代替として、Phase 3 末尾で
 * `computed_at < runStartedSec` を 1 文で掃除する。固定したい契約:
 *
 *   1. run 開始秒より古い行だけ消える (取得失敗銘柄の前日シグナルを含む。J3)。
 *   2. 境界 (`computed_at == runStartedSec`) は残る。
 *   3. 戻り値は削除行数。0 行なら DELETE を打たない。
 *
 * 実 SQLite (node:sqlite) で `sweepStaleEntrySignals` をそのまま走らせる。
 * 記録ドライバだと「境界の不等号の向き」を値として確かめられない。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as swingSchema from "../../services/swing-trading/src/db/schema.js";
import { sweepStaleEntrySignals } from "./daily.js";

const DDL = `
CREATE TABLE swing_entry_signals (
  id integer PRIMARY KEY AUTOINCREMENT,
  stock_id integer NOT NULL,
  pattern text NOT NULL,
  direction text NOT NULL,
  entry_price real NOT NULL,
  stop_loss real NOT NULL,
  target_1 real,
  target_2 real,
  risk_reward_ratio real,
  signal_strength real,
  note text,
  computed_at integer NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_swing_signals_computed ON swing_entry_signals(computed_at);
`;

function createD1(sqlite: DatabaseSync, executed: string[]): unknown {
  const prepare = (query: string) => {
    const make = (params: unknown[]) => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      all: async () => { executed.push(query); return { results: sqlite.prepare(query).all(...(params as any[])), success: true, meta: {} }; },
      raw: async () => {
        executed.push(query);
        const stmt = sqlite.prepare(query);
        const names = stmt.columns().map((col) => col.name);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows = stmt.all(...(params as any[])) as Record<string, unknown>[];
        return rows.map((row) => names.map((n) => row[n]));
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      run: async () => { executed.push(query); return { results: [], success: true, meta: sqlite.prepare(query).run(...(params as any[])) }; },
      bind: (...next: unknown[]) => make(next),
    });
    return make([]);
  };
  return { prepare, batch: async () => [] };
}

const RUN_STARTED_SEC = 1_700_000_000;

let sqlite: DatabaseSync;
let executed: string[];

function makeDb() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return drizzle(createD1(sqlite, executed) as any, { schema: { ...swingSchema } });
}

function seed(stockId: number, computedAt: number): void {
  sqlite.prepare(
    "INSERT INTO swing_entry_signals (stock_id, pattern, direction, entry_price, stop_loss, computed_at) VALUES (?, 'breakout_long', 'long', 1000, 950, ?)"
  ).run(stockId, computedAt);
}

function survivors(): number[] {
  return (sqlite.prepare("SELECT stock_id AS id FROM swing_entry_signals ORDER BY id").all() as Array<{ id: number }>).map((r) => r.id);
}

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(DDL);
  executed = [];
});

afterEach(() => {
  sqlite.close();
});

describe("sweepStaleEntrySignals (L-52)", () => {
  it("run 開始秒より古い行だけ消し、境界は残す", async () => {
    seed(1, RUN_STARTED_SEC - 86_400); // 前日 (取得失敗銘柄の残骸)
    seed(2, RUN_STARTED_SEC - 1); // 1 秒前
    seed(3, RUN_STARTED_SEC); // 今 run の刻み
    seed(4, RUN_STARTED_SEC + 5); // 未来 (ありえないが残す側)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const removed = await sweepStaleEntrySignals(makeDb() as any, RUN_STARTED_SEC);

    expect(removed).toBe(2);
    expect(survivors()).toEqual([3, 4]);
  });

  it("古い行が無ければ DELETE を打たない", async () => {
    seed(1, RUN_STARTED_SEC);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const removed = await sweepStaleEntrySignals(makeDb() as any, RUN_STARTED_SEC);

    expect(removed).toBe(0);
    expect(executed.filter((q) => /^\s*delete\b/i.test(q))).toEqual([]);
    expect(survivors()).toEqual([1]);
  });
});
