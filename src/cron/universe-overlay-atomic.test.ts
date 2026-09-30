/**
 * overlay 原子適用の suite (tracked excerpts。full 3810/226 proof は private)。
 * fixtures は実行の抜粋 (provenance.json に full SHA + 物理 pins)。
 * guard は full-sets 比較 (count 縮小なし)。送信は transactional test sender
 * (BEGIN/COMMIT/ROLLBACK) で D1 REST batch の採用前提を再現する。
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import {
  DEFS_COUNTRY_GUIDE,
  DEFS_ORDINARY_CODE,
  type BasicProfileEvidence,
} from "../shared/jpx/basic-profile.js";
import {
  applyUniverseOverlay,
  buildOverlayPreflightStatement,
  ensureUniverseOverlay,
  OVERLAY_MAX_BINDS_PER_STATEMENT,
  planOverlayBatch,
  readOverlaySnapshot,
  type OverlayBatchInput,
  type OverlaySnapshot,
} from "./universe-overlay.js";
import { OverlayHoldError } from "./universe-overlay.js";
import {
  makeRecordingSender,
  makeThrowingSender,
  makeTxBatchSender,
} from "./tests/overlay-test-sender.js";
import type { D1BatchStatement } from "../shared/db/d1-http-client.js";

const FX = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__/overlay-atomic");
const fx = (name: string): unknown => JSON.parse(readFileSync(join(FX, name), "utf-8"));

// drizzle/d1/0025_useful_nightcrawler.sql の鏡像 (test 内 DDL)。
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

type Q7Row = {
  id: number; code: string; name: string; market: string; sector: string | null;
  is_active: number; is_yutai: number; created_at: number; updated_at: number;
  instrument_type: string | null; sector33: string | null;
};

function seedCore(rows: Q7Row[]): void {
  const ins = sqlite.prepare(
    "INSERT INTO core_stocks (id, code, name, market, sector, is_active, is_yutai, created_at, updated_at, instrument_type, sector33) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  for (const r of rows) {
    ins.run(r.id, r.code, r.name, r.market, r.sector, r.is_active, r.is_yutai, r.created_at, r.updated_at, r.instrument_type, r.sector33);
  }
}

function seedBaseOnly(): void {
  sqlite.exec("INSERT INTO universe_overlay_state (id, base_as_of) VALUES (1, '2026-08-31')");
}

function loadBatch(eligibilityAsOf = "2026-09-30"): OverlayBatchInput {
  // eligibilityAsOf は ensure 入力から collector が stamp する (本番同形)。
  // fixture は captured 9/29 の原文を保持する。
  const batch = fx("batch-excerpt.json") as Record<string, unknown>;
  const basicsFx = (fx("basics-excerpt.json") as { codes: Record<string, Record<string, unknown>> }).codes;
  const basics = new Map<string, BasicProfileEvidence>(
    Object.entries(basicsFx).map(([code, v]) => [
      code,
      {
        ...v,
        defsPins: {
          countryGuide: DEFS_COUNTRY_GUIDE.sha256,
          ordinaryCode: DEFS_ORDINARY_CODE.sha256,
        },
      } as BasicProfileEvidence,
    ])
  );
  return { ...(batch as object), eligibilityAsOf, basics } as unknown as OverlayBatchInput;
}

function fullDump(): string {
  const core = sqlite.prepare("SELECT * FROM core_stocks ORDER BY id").all();
  const state = sqlite.prepare("SELECT * FROM universe_overlay_state ORDER BY id").all();
  const events = sqlite.prepare("SELECT * FROM universe_official_events ORDER BY id").all();
  return JSON.stringify({ core, state, events });
}

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(DDL);
});

afterEach(() => {
  sqlite?.close();
});

describe("overlay atomic batch (excerpts)", () => {
  it("payload: guard + 7 書込の 8 文・bind<=100・SQL/bind byte 分離測定", async () => {
    const { rows } = fx("core-excerpt.json") as { rows: Q7Row[] };
    expect(rows.length).toBe(25);
    seedCore(rows);
    const snapshot = await readOverlaySnapshot(memDb() as never);
    const { plan, statements } = planOverlayBatch(memDb() as never, loadBatch(), snapshot);
    expect(plan.deactivations.length).toBe(14);
    expect(plan.marketUpdates.length).toBe(5);
    expect(plan.listingInserts.length).toBe(2);
    expect(plan.eventUpserts.length).toBe(24);
    // guard + events3 + deact1 + market1 + listing1 + state1。
    expect(statements.length).toBe(8);
    const binds = statements.map((s) => s.params.length);
    expect(Math.max(...binds)).toBeLessThanOrEqual(OVERLAY_MAX_BINDS_PER_STATEMENT);
    expect(binds[0]).toBe(1);
    // SQL text と bound JSON を分離測定する (合算長で上限を主張しない)。
    const guardSqlBytes = Buffer.byteLength(statements[0]?.sql as string, "utf-8");
    expect(guardSqlBytes).toBeLessThan(100 * 1024);
    const guardJsonBytes = Buffer.byteLength(statements[0]?.params[0] as string, "utf-8");
    expect(guardJsonBytes).toBeGreaterThan(0);
    // guard SQL は固定文 (snapshot によらず同一テンプレ)。
    const again = buildOverlayPreflightStatement(snapshot);
    expect(again.sql).toBe(statements[0]?.sql);
    expect(again.params.length).toBe(1);
  });

  it("positive: 14/5/2/24 + tuple + protected + send1回", async () => {
    const { rows } = fx("core-excerpt.json") as { rows: Q7Row[] };
    seedCore(rows);
    seedBaseOnly();
    const count = { sends: 0 };
    const out = await ensureUniverseOverlay(memDb() as never, {
      eligibilityAsOf: "2026-09-30",
      collect: async () => loadBatch(),
      sendBatch: makeTxBatchSender(sqlite, count),
    });
    expect(out.applied).toBe(true);
    expect(count.sends).toBe(1);
    expect(out.result?.deactivated).toBe(14);
    expect(out.result?.marketUpdated).toBe(5);
    expect(out.result?.listed).toBe(2);
    expect(out.result?.eventsUpserted).toBe(24);
    expect(out.result?.heldListingCodes).toEqual([]);
    const st = sqlite.prepare("SELECT * FROM universe_overlay_state WHERE id=1").get() as Record<string, unknown>;
    expect(st.base_as_of).toBe("2026-08-31");
    expect(st.eligibility_as_of).toBe("2026-09-30");
    expect(st.applied_delist).toBe(14);
    expect(st.applied_listing).toBe(2);
    expect(st.applied_transfer).toBe(5);
    expect(st.held_listing_codes).toBeNull();
    expect(typeof st.events_fetched_at).toBe("string");
    expect(typeof st.events_sha).toBe("string");
    expect(typeof st.applied_at).toBe("string");
    // 挿入 2 行は sector NULL + equity。
    for (const code of ["618A", "646A"]) {
      const row = sqlite.prepare("SELECT market, sector, instrument_type, is_active FROM core_stocks WHERE code=?").get(code) as {
        market: string; sector: null; instrument_type: string; is_active: number;
      };
      expect(row.sector).toBeNull();
      expect(row.instrument_type).toBe("equity");
      expect(row.is_active).toBe(1);
      expect(row.market.endsWith("（内国株式）")).toBe(true);
    }
    // controls 6 行は完全無変化 (値・型・NULL)。
    const ctrls = rows.slice(19).map((r) => r.code);
    expect(ctrls.length).toBe(6);
    for (const r of rows.slice(19)) {
      const cur = sqlite.prepare("SELECT * FROM core_stocks WHERE code=?").get(r.code) as Record<string, unknown>;
      expect(cur.name).toBe(r.name);
      expect(cur.market).toBe(r.market);
      expect(cur.sector).toBe(r.sector);
      expect(cur.is_active).toBe(r.is_active);
      expect(cur.is_yutai).toBe(r.is_yutai);
      expect(cur.created_at).toBe(r.created_at);
      expect(cur.updated_at).toBe(r.updated_at);
      expect(cur.instrument_type).toBe(r.instrument_type);
      expect(cur.sector33).toBe(r.sector33);
    }
    // 対象 19 行の protected 7 列は不変。
    for (const r of rows.slice(0, 19)) {
      const cur = sqlite.prepare("SELECT * FROM core_stocks WHERE code=?").get(r.code) as Record<string, unknown>;
      expect(cur.sector).toBe(r.sector);
      expect(cur.sector33).toBe(r.sector33);
      expect(cur.is_yutai).toBe(r.is_yutai);
      expect(cur.instrument_type).toBe(r.instrument_type);
      expect(cur.created_at).toBe(r.created_at);
      expect(cur.code).toBe(r.code);
      expect(cur.name).toBe(r.name);
    }
  });

  it.each([
    ["untouched 値 drift", "UPDATE core_stocks SET name = name || '_x' WHERE id = ?", 20],
    ["untouched active flip", "UPDATE core_stocks SET is_active = 1 - is_active WHERE id = ?", 20],
    // INTEGER affinity は '1' を 1 に正規化するため真の型 drift にはならない。
    // 小数部つき REAL は affinity でも REAL のまま残る。
    ["untouched 型 drift", "UPDATE core_stocks SET is_active = 1.5 WHERE id = ?", 20],
    // rows[23] は inactive control (instrument_type NULL)。
    ["untouched NULL drift", "UPDATE core_stocks SET instrument_type = 'x' WHERE id = ?", 23],
  ])("guard abort + rollback 0 writes (%s)", async (_n, driftSql, victimIdx) => {
    const { rows } = fx("core-excerpt.json") as { rows: Q7Row[] };
    seedCore(rows);
    const snapshot = await readOverlaySnapshot(memDb() as never);
    const victim = rows[victimIdx as number]?.id as number;
    sqlite.prepare(driftSql).run(victim);
    const before = fullDump();
    const count = { sends: 0 };
    const err = await applyUniverseOverlay(memDb() as never, loadBatch(), snapshot, makeTxBatchSender(sqlite, count)).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect(count.sends).toBe(1);
    expect(fullDump()).toBe(before);
  });

  it("guard abort: 行の追加・削除", async () => {
    const { rows } = fx("core-excerpt.json") as { rows: Q7Row[] };
    seedCore(rows);
    const snapshot = await readOverlaySnapshot(memDb() as never);
    sqlite.prepare("INSERT INTO core_stocks (code, name, market, is_active) VALUES ('9999', 'x', 'y', 1)").run();
    const before = fullDump();
    const count = { sends: 0 };
    await expect(
      applyUniverseOverlay(memDb() as never, loadBatch(), snapshot, makeTxBatchSender(sqlite, count))
    ).rejects.toThrow();
    expect(fullDump()).toBe(before);
    // 削除 drift も同様。
    sqlite.prepare("DELETE FROM core_stocks WHERE code='9999'").run();
    const victim = rows[21]?.code as string;
    sqlite.prepare("DELETE FROM core_stocks WHERE code=?").run(victim);
    const before2 = fullDump();
    await expect(
      applyUniverseOverlay(memDb() as never, loadBatch(), snapshot, makeTxBatchSender(sqlite, count))
    ).rejects.toThrow();
    expect(fullDump()).toBe(before2);
  });

  it("guard abort: state/events drift", async () => {
    const { rows } = fx("core-excerpt.json") as { rows: Q7Row[] };
    seedCore(rows);
    const snapshot = await readOverlaySnapshot(memDb() as never);
    sqlite.exec("INSERT INTO universe_overlay_state (id, base_as_of, eligibility_as_of) VALUES (1, '2026-08-31', '2026-09-01')");
    const before = fullDump();
    const count = { sends: 0 };
    await expect(
      applyUniverseOverlay(memDb() as never, loadBatch(), snapshot, makeTxBatchSender(sqlite, count))
    ).rejects.toThrow();
    expect(fullDump()).toBe(before);
    sqlite.exec("DELETE FROM universe_overlay_state");
    sqlite.prepare(
      "INSERT INTO universe_official_events (code, kind, effective_date, source_url, fetched_at, raw_sha, archive_key) VALUES ('1', 'delist', '2026-09-01', 'u', 'f', 'r', 'a')"
    ).run();
    const before2 = fullDump();
    await expect(
      applyUniverseOverlay(memDb() as never, loadBatch(), snapshot, makeTxBatchSender(sqlite, count))
    ).rejects.toThrow();
    expect(fullDump()).toBe(before2);
  });

  it("IPO conflict は SQL エラーで全 rollback (middle failure の 0 writes 証明)", async () => {
    const { rows } = fx("core-excerpt.json") as { rows: Q7Row[] };
    seedCore(rows);
    const snapshot = await readOverlaySnapshot(memDb() as never);
    // 同一 code の適格 2 行 → 挿入 2 文目は UNIQUE 違反 (guard は通る)。
    const batch = loadBatch();
    const dup = { ...(batch.sources.newListings.rows[0] as Record<string, string>) };
    batch.sources.newListings.rows.push(dup as never);
    const before = fullDump();
    const count = { sends: 0 };
    await expect(
      applyUniverseOverlay(memDb() as never, batch, snapshot, makeTxBatchSender(sqlite, count))
    ).rejects.toThrow(/UNIQUE/i);
    expect(count.sends).toBe(1);
    // 先行 28 文相当 (events/deact/market) も巻き戻る。
    expect(fullDump()).toBe(before);
    const n = sqlite.prepare("SELECT COUNT(*) AS n FROM universe_official_events").get() as { n: number };
    expect(n.n).toBe(0);
  });

  it("unknown listing ANY は送信前に HOLD (sender 未呼出・0 writes)", async () => {
    const { rows } = fx("core-excerpt.json") as { rows: Q7Row[] };
    seedCore(rows);
    seedBaseOnly();
    const snapshot = await readOverlaySnapshot(memDb() as never);
    const batch = loadBatch();
    batch.basics = new Map([...(batch.basics?.entries() ?? [])].filter(([k]) => k !== "646A"));
    const before = fullDump();
    const err = await applyUniverseOverlay(memDb() as never, batch, snapshot, makeThrowingSender()).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(OverlayHoldError);
    expect((err as OverlayHoldError).codes).toEqual(["646A"]);
    expect((err as Error).message).toContain("未送信");
    expect(fullDump()).toBe(before);
  });

  it("abort 後の clean retry は成功する (部分状態なし)", async () => {
    const { rows } = fx("core-excerpt.json") as { rows: Q7Row[] };
    seedCore(rows);
    const snapshot = await readOverlaySnapshot(memDb() as never);
    const victim = rows[22]?.id as number;
    sqlite.prepare("UPDATE core_stocks SET market='zzz' WHERE id=?").run(victim);
    const count = { sends: 0 };
    await expect(
      applyUniverseOverlay(memDb() as never, loadBatch(), snapshot, makeTxBatchSender(sqlite, count))
    ).rejects.toThrow();
    // drift 解消 → fresh snapshot で再適用。
    const orig = rows.find((r) => r.id === victim) as Q7Row;
    sqlite.prepare("UPDATE core_stocks SET market=? WHERE id=?").run(orig.market, victim);
    seedBaseOnly();
    const out = await ensureUniverseOverlay(memDb() as never, {
      eligibilityAsOf: "2026-09-30",
      collect: async () => loadBatch(),
      sendBatch: makeTxBatchSender(sqlite, count),
    });
    expect(out.applied).toBe(true);
    expect(out.result?.listed).toBe(2);
    expect(count.sends).toBe(2);
  });

  it("reentry: 同日 ensure は no-op (collect/sender 未呼出)", async () => {
    const { rows } = fx("core-excerpt.json") as { rows: Q7Row[] };
    seedCore(rows);
    seedBaseOnly();
    const count = { sends: 0 };
    const sender = makeTxBatchSender(sqlite, count);
    const out = await ensureUniverseOverlay(memDb() as never, {
      eligibilityAsOf: "2026-09-30",
      collect: async () => loadBatch(),
      sendBatch: sender,
    });
    expect(out.applied).toBe(true);
    const before = fullDump();
    const out2 = await ensureUniverseOverlay(memDb() as never, {
      eligibilityAsOf: "2026-09-30",
      collect: async () => {
        throw new Error("reuse must not collect");
      },
      sendBatch: makeThrowingSender(),
    });
    expect(out2).toEqual({ applied: false, result: null });
    expect(count.sends).toBe(1);
    expect(fullDump()).toBe(before);
  });

  it("snapshot 形状検証: 重複と非 singleton を STOP", async () => {
    const { rows } = fx("core-excerpt.json") as { rows: Q7Row[] };
    seedCore(rows);
    const base = await readOverlaySnapshot(memDb() as never);
    const dupCode = { ...base, core: [...base.core, { ...base.core[0] }] } as OverlaySnapshot;
    expect(() => planOverlayBatch(memDb() as never, loadBatch(), dupCode)).toThrow(/STOP.*core/);
    const dupId = {
      ...base,
      core: base.core.map((r, i) => (i === 1 ? { ...r, id: base.core[0]?.id } : r)),
    } as OverlaySnapshot;
    expect(() => planOverlayBatch(memDb() as never, loadBatch(), dupId)).toThrow(/STOP.*core id/);
    const badState = { ...base, state: { ...(base.state as object), id: 2 } } as unknown as OverlaySnapshot;
    expect(() => planOverlayBatch(memDb() as never, loadBatch(), badState)).toThrow(/STOP.*state/);
  });

  it("不正 snapshot (NaN/undefined/型違い) は JSON 化前に STOP (sender 未呼出)", async () => {
    const { rows } = fx("core-excerpt.json") as { rows: Q7Row[] };
    seedCore(rows);
    const base = await readOverlaySnapshot(memDb() as never);
    const cases: Array<[string, (s: OverlaySnapshot) => void]> = [
      ["core NaN", (s) => { (s.core[0] as unknown as Record<string, unknown>).updatedAt = Number.NaN; }],
      ["core undefined", (s) => { delete (s.core[1] as unknown as Record<string, unknown>).market; }],
      ["core flag 範囲外", (s) => { (s.core[2] as unknown as Record<string, unknown>).isActive = 2; }],
      ["core 型違い", (s) => { (s.core[3] as unknown as Record<string, unknown>).code = 1301; }],
      ["state NaN", (s) => { ((s.state as unknown as Record<string, unknown>)).appliedDelist = Number.NaN; }],
      ["state 型違い", (s) => { ((s.state as unknown as Record<string, unknown>)).baseAsOf = 20260831; }],
    ];
    // state あり snapshot (base 行) を用意する。
    seedBaseOnly();
    const withState = await readOverlaySnapshot(memDb() as never);
    expect(withState.state?.baseAsOf).toBe("2026-08-31");
    for (const [name, mutate] of cases) {
      const cand = JSON.parse(JSON.stringify(name.startsWith("state") ? withState : base)) as OverlaySnapshot;
      mutate(cand);
      // JSON 化で NaN→null/undefined 落ちする前の検証で止める。
      expect(() => planOverlayBatch(memDb() as never, loadBatch(), cand), name).toThrow(/STOP/);
      const err = await applyUniverseOverlay(memDb() as never, loadBatch(), cand, makeThrowingSender()).then(
        () => null,
        (e: unknown) => e
      );
      expect((err as Error)?.message ?? "", name).toMatch(/STOP/);
    }
  });

  it("state 複数行は read で STOP (collect 前)", async () => {
    const { rows } = fx("core-excerpt.json") as { rows: Q7Row[] };
    seedCore(rows);
    sqlite.exec("INSERT INTO universe_overlay_state (id, base_as_of) VALUES (1, '2026-08-31'), (2, 'x')");
    await expect(readOverlaySnapshot(memDb() as never)).rejects.toThrow(/singleton/);
    await expect(
      ensureUniverseOverlay(memDb() as never, {
        eligibilityAsOf: "2026-09-30",
        collect: async () => {
          throw new Error("must not collect");
        },
        sendBatch: makeThrowingSender(),
      })
    ).rejects.toThrow(/singleton/);
  });

  it("held JSON 破損は STOP (HOLD 扱いしない)", async () => {
    const { rows } = fx("core-excerpt.json") as { rows: Q7Row[] };
    seedCore(rows);
    sqlite.exec(
      "INSERT INTO universe_overlay_state (id, base_as_of, events_fetched_at, events_sha, eligibility_as_of, applied_at, held_listing_codes) VALUES (1, '2026-08-31', 'g', 's', '2026-09-30', 't', '{\"a\":1}')"
    );
    await expect(
      ensureUniverseOverlay(memDb() as never, {
        eligibilityAsOf: "2026-09-30",
        collect: async () => {
          throw new Error("must not collect");
        },
        sendBatch: makeThrowingSender(),
      })
    ).rejects.toThrow(/文字列配列/);
  });

  it("empty batch は guard + state commit の 2 文で世代を進める", async () => {
    const { rows } = fx("core-excerpt.json") as { rows: Q7Row[] };
    seedCore(rows);
    seedBaseOnly();
    const { emptyUniverseBatch } = await import("./tests/overlay-batch.js");
    const snapshot = await readOverlaySnapshot(memDb() as never);
    const { statements } = planOverlayBatch(memDb() as never, emptyUniverseBatch("2026-08-31", "2026-09-30"), snapshot);
    expect(statements.length).toBe(2);
    const count = { sends: 0 };
    const res = await applyUniverseOverlay(
      memDb() as never,
      emptyUniverseBatch("2026-08-31", "2026-09-30"),
      snapshot,
      makeTxBatchSender(sqlite, count)
    );
    expect(res.stateCommitted).toBe(true);
    expect(res.eventsUpserted).toBe(0);
    const st = sqlite.prepare("SELECT eligibility_as_of FROM universe_overlay_state WHERE id=1").get() as {
      eligibility_as_of: string;
    };
    expect(st.eligibility_as_of).toBe("2026-09-30");
  });

  it("recording sender は batch 全体を受け取る (fake DB 検査用)", async () => {
    const { rows } = fx("core-excerpt.json") as { rows: Q7Row[] };
    seedCore(rows);
    seedBaseOnly();
    const record: { batches: D1BatchStatement[][] } = { batches: [] };
    const out = await ensureUniverseOverlay(memDb() as never, {
      eligibilityAsOf: "2026-09-30",
      collect: async () => loadBatch(),
      sendBatch: makeRecordingSender(record),
    });
    expect(out.applied).toBe(true);
    expect(record.batches.length).toBe(1);
    expect(record.batches[0]?.length).toBe(8);
  });
});
