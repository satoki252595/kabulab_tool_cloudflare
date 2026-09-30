/**
 * universe-overlay CLI の同一-seam test (daily/monthly と同じ sender 経路)。
 * memDb + fake collect + transactional sender。外部 I/O なし。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { emptyUniverseBatch } from "../../src/cron/tests/overlay-batch.js";
import { makeThrowingSender, makeTxBatchSender } from "../../src/cron/tests/overlay-test-sender.js";
import { runUniverseOverlaySync } from "./universe-overlay.js";

const DDL = `
CREATE TABLE core_stocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  market TEXT NOT NULL,
  sector TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_yutai INTEGER NOT NULL DEFAULT 0,
  instrument_type TEXT,
  sector33 TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE universe_official_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  code TEXT NOT NULL,
  kind TEXT NOT NULL,
  effective_date TEXT NOT NULL,
  name TEXT,
  market_from TEXT,
  market_to TEXT,
  source_url TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  raw_sha TEXT NOT NULL,
  archive_key TEXT NOT NULL,
  last_seen_fetched_at TEXT
);
CREATE UNIQUE INDEX uq_e ON universe_official_events (code, kind, effective_date);
CREATE TABLE universe_overlay_state (
  id INTEGER PRIMARY KEY NOT NULL,
  base_as_of TEXT,
  events_fetched_at TEXT,
  events_sha TEXT,
  eligibility_as_of TEXT,
  applied_at TEXT,
  applied_delist INTEGER DEFAULT 0 NOT NULL,
  applied_listing INTEGER DEFAULT 0 NOT NULL,
  applied_transfer INTEGER DEFAULT 0 NOT NULL,
  held_listing_codes TEXT
);`;

let sqlite: DatabaseSync;

function memDb() {
  return drizzle(async (sqlStr, params, method) => {
    const stmt = sqlite.prepare(sqlStr);
    const bind = params as (null | number | bigint | string | Uint8Array)[];
    if (method === "run") {
      stmt.run(...bind);
      return { rows: [] };
    }
    const rows = (stmt.all(...bind) as Record<string, unknown>[]).map((o) =>
      Object.values(o)
    );
    return { rows: method === "get" ? (rows[0] ?? []) : rows };
  });
}

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(DDL);
});

afterEach(() => {
  sqlite?.close();
});

describe("runUniverseOverlaySync (CLI seam)", () => {
  it("空 batch を同一 sender 経路で適用する (send1回)", async () => {
    sqlite.exec("INSERT INTO universe_overlay_state (id, base_as_of) VALUES (1, '2026-08-31')");
    const count = { sends: 0 };
    const out = await runUniverseOverlaySync(memDb() as never, {
      eligibilityAsOf: "2026-09-30",
      collect: async (input) => emptyUniverseBatch(input.baseAsOf, input.eligibilityAsOf),
      sendBatch: makeTxBatchSender(sqlite, count),
    });
    expect(out.applied).toBe(true);
    expect(count.sends).toBe(1);
    expect(out.summary).toContain("適用");
    const st = sqlite.prepare("SELECT eligibility_as_of FROM universe_overlay_state WHERE id=1").get() as {
      eligibility_as_of: string;
    };
    expect(st.eligibility_as_of).toBe("2026-09-30");
  });

  it("適用済み elig は no-op (sender 未呼出)", async () => {
    sqlite.exec(
      "INSERT INTO universe_overlay_state (id, base_as_of, events_fetched_at, events_sha, eligibility_as_of, applied_at) VALUES (1, '2026-08-31', 'g', 's', '2026-09-30', 't')"
    );
    const out = await runUniverseOverlaySync(memDb() as never, {
      eligibilityAsOf: "2026-09-30",
      collect: async () => {
        throw new Error("must not collect");
      },
      sendBatch: makeThrowingSender(),
    });
    expect(out.applied).toBe(false);
    expect(out.summary).toContain("no-op");
  });
});
