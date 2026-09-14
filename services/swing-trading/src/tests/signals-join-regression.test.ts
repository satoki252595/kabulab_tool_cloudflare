/**
 * `GET /signals` の JOIN 順序固定 (CROSS JOIN) が結果を変えないことの検証。
 *
 * INNER JOIN だと `core_stocks` の索引が外側ループに選ばれ、
 * entry_signals 側の絞り込みが効かなくなる (L-48。/screening と同じ前例)。
 * `swing_entry_signals` を左に置く CROSS JOIN + WHERE の等値へ変えたが、
 * 返る行は INNER JOIN と同じ。固定したい契約:
 *
 *   1. シグナル強度降順で全件並ぶ (pattern=all)。
 *   2. pattern 絞り込みが効く。
 *   3. 結合述語の脱落はデカルト積になるので、件数で捕まえる。
 *   4. 母集団外 (非 equity) の銘柄のシグナルは出ない。
 *
 * 実 SQLite (node:sqlite) を D1 バインディング互換スタブに被せて
 * swingTradingApp をそのまま叩く。/signals が触る 2 表だけ手書き DDL
 * (ダッシュボードと違い 5 表要らないので、migration 流し込みはしない)。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { swingTradingApp } from "../../app.js";

const DDL = `
CREATE TABLE core_stocks (
  id integer PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  market text NOT NULL,
  sector text,
  sector33 text,
  is_active integer NOT NULL DEFAULT 1,
  instrument_type text
);
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
`;

/** drizzle-orm/d1 が触る範囲だけの D1Database シム */
function createD1(sqlite: DatabaseSync): unknown {
  const prepare = (query: string) => {
    const make = (params: unknown[]) => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      all: async () => ({ results: sqlite.prepare(query).all(...(params as any[])), success: true, meta: {} }),
      raw: async () => {
        const stmt = sqlite.prepare(query);
        const names = stmt.columns().map((col) => col.name);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows = stmt.all(...(params as any[])) as Record<string, unknown>[];
        return rows.map((row) => names.map((n) => row[n]));
      },
      bind: (...next: unknown[]) => make(next),
    });
    return make([]);
  };
  return { prepare, batch: async () => [] };
}

let sqlite: DatabaseSync;

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(DDL);
  const insStock = sqlite.prepare(
    "INSERT INTO core_stocks (id, code, name, market, sector33, is_active, instrument_type) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const insSig = sqlite.prepare(
    "INSERT INTO swing_entry_signals (stock_id, pattern, direction, entry_price, stop_loss, signal_strength) VALUES (?, ?, ?, ?, ?, ?)"
  );
  // 強度 90/70/50 の 3 本。母集団は active かつ equity。
  insStock.run(1, "7203", "銘柄7203", "プライム", "輸送用機器", 1, "equity");
  insStock.run(2, "7974", "銘柄7974", "プライム", "電機", 1, "equity");
  insStock.run(3, "9984", "銘柄9984", "プライム", "小売", 1, "equity");
  // 母集団外: シグナルがあっても出ない
  insStock.run(4, "1301", "銘柄1301", "プライム", "水産", 1, "reit_fund");
  insSig.run(1, "breakout_long", "long", 1000, 950, 70);
  insSig.run(2, "pullback_long", "long", 2000, 1900, 90);
  insSig.run(3, "breakout_long", "long", 3000, 2900, 50);
  insSig.run(4, "breakout_long", "long", 4000, 3900, 99);
});

afterEach(() => {
  sqlite.close();
});

async function signals(pattern: string): Promise<string> {
  const res = await swingTradingApp.request(
    `/signals?pattern=${pattern}`,
    {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { DB: createD1(sqlite) as any }
  );
  expect(res.status).toBe(200);
  return await res.text();
}

function codesInOrder(html: string): string[] {
  return [...html.matchAll(/\/stock\/(\w+)/g)].map((m) => m[1]);
}

describe("GET /signals の JOIN 順序固定 (L-48)", () => {
  it("pattern=all は強度降順で母集団の 3 本だけ並ぶ", async () => {
    const codes = codesInOrder(await signals("all"));

    // 強度 99 の REIT 行は出ない。WHERE の等値を外すと 3×4=12 行になる。
    expect(codes).toEqual(["7974", "7203", "9984"]);
  });

  it("pattern 絞り込みが効く", async () => {
    const codes = codesInOrder(await signals("breakout_long"));

    expect(codes).toEqual(["7203", "9984"]);
  });
});
