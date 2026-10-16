/** Actual saved 3106 facts; only the declared replay clocks are controlled. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../db/client.js";
import { parseOrderData } from "../services/edinet/order-parser.js";
import { rebuildYuhoGrowthProjection } from "../services/projection.js";
import {
  buildOrdersAtomicWithCommonProjection,
  openActualSnapshot,
  readSnapshot,
  type Snapshot,
} from "../../data-scripts/lib/saved-overseas-atomic.js";

const dir = fileURLToPath(
  new URL("./fixtures/order-saved-3106/", import.meta.url),
);
const before = JSON.parse(
  readFileSync(join(dir, "snapshot.json"), "utf8"),
) as Snapshot;
const { item } = JSON.parse(readFileSync(join(dir, "provenance.json"), "utf8"));
const parsed = parseOrderData(
  readFileSync(join(dir, "S100YIYE.zip")),
  item.periodEnd,
);
const target = {
  stockId: item.stockId,
  documentId: item.documentId,
  docId: item.docId,
  periodEnd: item.periodEnd,
};
const runStartedSec = Date.parse("2026-10-16T23:59:50Z") / 1000;
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("projection metadata uses the captured run clock", () => {
  it("replays the same actual six-table batch and financial values across UTC midnight", async () => {
    const fetch = vi.fn(() => {
      throw new Error("No HTTP in saved projection replay");
    });
    vi.stubGlobal("fetch", fetch);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T23:59:55Z"));
    const first = await buildOrdersAtomicWithCommonProjection(
      process.cwd(),
      before,
      target,
      parsed,
      runStartedSec,
    );
    vi.setSystemTime(new Date("2026-10-17T00:00:05Z"));
    const replay = await buildOrdersAtomicWithCommonProjection(
      process.cwd(),
      before,
      target,
      parsed,
      runStartedSec,
    );
    expect(replay).toEqual(first);
    expect(replay.expected.p_yuho_growth).toHaveLength(1);
    expect(replay.expected.p_yuho_growth[0].as_of).toBe("2026-10-16");
    expect(replay.expected.p_yuho_growth[0].computed_at).toBe(runStartedSec);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("captures the default start once even when actual-source SELECTs cross midnight", async () => {
    const sqlite = openActualSnapshot(process.cwd(), before);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(runStartedSec * 1000));
    let advanced = false;
    const db = drizzle(async (sql, params, method) => {
      if (!advanced) {
        vi.setSystemTime(new Date("2026-10-17T00:00:05Z"));
        advanced = true;
      }
      const statement = sqlite.prepare(sql),
        bindings = params as (string | number | null)[];
      if (method === "run") {
        statement.run(...bindings);
        return { rows: [] };
      }
      const names = statement.columns().map((column) => column.name);
      const rows = (
        statement.all(...bindings) as Record<string, unknown>[]
      ).map((row) => names.map((name) => row[name]));
      return {
        rows: method === "get" ? (rows[0] === undefined ? [] : rows[0]) : rows,
      };
    }) as unknown as Database;
    try {
      const result = await rebuildYuhoGrowthProjection(db);
      expect(result.stocks).toBe(1);
      const after = readSnapshot(sqlite, item.stockId);
      expect(after.p_yuho_growth[0].as_of).toBe("2026-10-16");
      expect(after.p_yuho_growth[0].computed_at).toBe(runStartedSec);
      for (const table of [
        "core_stocks",
        "yuho_documents",
        "yuho_order_facts",
        "yuho_overseas_facts",
        "yuho_text_sections",
      ] as const)
        expect(after[table]).toEqual(before[table]);
    } finally {
      sqlite.close();
    }
  });
});
