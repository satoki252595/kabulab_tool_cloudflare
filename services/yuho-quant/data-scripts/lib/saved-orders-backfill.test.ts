import { createHash } from "node:crypto";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, it, expect } from "vitest";
import { parseOrderData } from "../../src/services/edinet/order-parser.js";
import {
  toOrderSaveRows,
  validateOrderRepairSet,
} from "../../src/services/order-save-rows.js";
import {
  buildOrdersAtomicWithCommonProjection,
  openActualSnapshot,
  readSnapshot,
  assertTargetPost,
  tables,
  type Snapshot,
} from "./saved-overseas-atomic.js";
import {
  savedOrdersCohortSchema,
  savedCohortSchema,
  runSavedOrders,
  runSavedOverseas,
  reserveSavedClaims,
  savedBusinessView,
} from "./saved-overseas-backfill.js";

const fixture = fileURLToPath(
  new URL("../../src/tests/fixtures/order-saved-3106/", import.meta.url),
);
const before = JSON.parse(
  readFileSync(join(fixture, "snapshot.json"), "utf8"),
) as Snapshot;
const provenance = JSON.parse(
  readFileSync(join(fixture, "provenance.json"), "utf8"),
);
const item = provenance.item;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const zip = readFileSync(join(fixture, "S100YIYE.zip"));
const parsed = parseOrderData(zip, item.periodEnd);
const target = {
  stockId: item.stockId,
  documentId: item.documentId,
  docId: item.docId,
  periodEnd: item.periodEnd,
};
const clock = 1792200000;

// Actual financial rows only; mutations below are declared negative/projection tests.
describe("normal finite orders repair", () => {
  it("keeps orders and overseas cohorts incompatible and binds the original saved source", () => {
    expect(sha(zip)).toBe(provenance.zipSha256);
    expect(sha(readFileSync(join(fixture, "snapshot.json")))).toBe(
      provenance.snapshotSha256,
    );
    const order = {
      version: 2,
      kind: "orders",
      stateDir: "/private/order-state",
      items: [item],
    };
    expect(savedOrdersCohortSchema.parse(order).items).toEqual([item]);
    expect(() => savedCohortSchema.parse(order)).toThrow();
    expect(() =>
      savedOrdersCohortSchema.parse({ ...order, version: 1 }),
    ).toThrow();
    expect(() =>
      savedOrdersCohortSchema.parse({ ...order, items: [item, item] }),
    ).toThrow();
    expect(() =>
      savedOrdersCohortSchema.parse({ ...order, kind: "overseas" }),
    ).toThrow();
  });
  it("preserves actual B-table prior/current rows and issuer-only false; refuses ambiguous/unsupported repairs", () => {
    const b = parseOrderData(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../src/tests/fixtures/order-construction-S100YHJP.zip",
            import.meta.url,
          ),
        ),
      ),
      "2026-03-31",
    );
    expect(b.status).toBe("ok_pattern_b");
    expect(new Set(b.facts.map((f) => f.fiscalYearEnd))).toEqual(
      new Set(["2025-03-31", "2026-03-31"]),
    );
    expect(new Set(b.facts.map((f) => f.isConsolidated))).toEqual(
      new Set([false]),
    );
    expect(() => validateOrderRepairSet(b, "2026-03-31")).not.toThrow();
    expect(
      toOrderSaveRows(b.facts, b.status).map((r) => [
        r.fiscalYearEnd,
        r.isConsolidated,
        r.pattern,
      ]),
    ).toEqual(b.facts.map((f) => [f.fiscalYearEnd, false, "pattern_b"]));
    for (const bad of [
      { ...b, status: "table_unrecognized" as const },
      { ...b, facts: [] },
      { ...b, facts: [...b.facts, b.facts[0]] },
      { ...b, facts: b.facts.filter((f) => f.fiscalYearEnd !== "2026-03-31") },
      { ...b, facts: b.facts.map((f) => ({ ...f, isConsolidated: null })) },
      { ...b, holdReason: "unqualified" },
    ])
      expect(() => validateOrderRepairSet(bad, "2026-03-31")).toThrow();
  });
  it("uses the common six-table CAS/projection, preserves all other columns/tables and repeats as a business no-op", async () => {
    const built = await buildOrdersAtomicWithCommonProjection(
      process.cwd(),
      before,
      target,
      parsed,
      clock,
    );
    const db = openActualSnapshot(process.cwd(), before);
    try {
      db.exec("BEGIN");
      for (const s of built.statements)
        db.prepare(s.sql).all(...(s.params as (number | string | null)[]));
      db.exec("COMMIT");
      const after = readSnapshot(db, item.stockId);
      expect(() =>
        assertTargetPost(after, built.expected, target, "orders"),
      ).not.toThrow();
      expect(after.yuho_overseas_facts).toEqual(before.yuho_overseas_facts);
      expect(after.yuho_text_sections).toEqual(before.yuho_text_sections);
      expect(after.core_stocks).toEqual(before.core_stocks);
      const repeated = await buildOrdersAtomicWithCommonProjection(
        process.cwd(),
        after,
        target,
        parsed,
        clock + 1,
      );
      expect(savedBusinessView(repeated.expected, "orders")).toEqual(
        savedBusinessView(after, "orders"),
      );
    } finally {
      db.close();
    }
    for (const table of tables) {
      const raced = structuredClone(before);
      const row = raced[table][0];
      // Empty tables are raced with the actual row obtained by the proposed projection.
      if (row === undefined) raced[table] = built.expected[table];
      else {
        const key = Object.keys(row).find(
          (key) =>
            !["id", "stock_id", "document_id"].includes(key) &&
            row[key] !== null,
        )!;
        row[key] =
          typeof row[key] === "number"
            ? Number(row[key]) + 1
            : String(row[key]) + "negative-race";
      }
      if (JSON.stringify(raced[table]) === JSON.stringify(before[table]))
        continue;
      const db = openActualSnapshot(process.cwd(), raced);
      try {
        db.exec("BEGIN");
        expect(() => {
          for (const s of built.statements)
            db.prepare(s.sql).all(...(s.params as (number | string | null)[]));
        }).toThrow();
        db.exec("ROLLBACK");
        expect(readSnapshot(db, item.stockId)).toEqual(raced);
      } finally {
        db.close();
      }
    }
  });
  it("rejects copied/new PREs and mixed kind/version before HTTP or output creation, preserving sticky claims", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "orders-single-use-"))),
      stateDir = join(dir, "state");
    mkdirSync(stateDir, { mode: 0o700 });
    const cohort = {
      version: 2 as const,
      kind: "orders" as const,
      stateDir,
      items: [item],
    };
    const cohortPath = join(dir, "cohort.json");
    writeFileSync(cohortPath, JSON.stringify(cohort));
    const cohortSha256 = sha(readFileSync(cohortPath));
    reserveSavedClaims(cohort, {
      cohortSha256,
      preSha256: sha(zip),
      outDir: join(dir, "unknown-old"),
    });
    const claim = join(
        stateDir,
        `${item.docId}-${item.zipSha256}.apply-claim.json`,
      ),
      old = readFileSync(claim),
      native = globalThis.fetch;
    let sends = 0;
    globalThis.fetch = async () => {
      sends++;
      throw Error("HTTP forbidden");
    };
    try {
      for (const [n, capsule] of [
        {
          version: 2,
          kind: "orders",
          cohortSha256,
          qualified: [{ item }],
          freshReadAt: "original",
        },
        {
          version: 2,
          kind: "orders",
          cohortSha256,
          qualified: [{ item }],
          freshReadAt: "new-PRE",
        },
        { version: 1, cohortSha256, qualified: [{ item }] },
      ].entries()) {
        const path = join(dir, `PRE-${n}.gz`),
          bytes = gzipSync(JSON.stringify(capsule));
        writeFileSync(path, bytes);
        const options = {
          mode: "apply" as const,
          cohortPath,
          cohortSha256,
          outDir: join(dir, `new-out-${n}`),
          capsulePath: path,
          capsuleSha256: sha(bytes),
          afterCode: null,
          maxTargets: 1,
          maxSeconds: 900,
          maxNotionRps: 0.4,
          maxHttp: 300,
          maxNotion: 200,
          maxD1: 50,
          maxResponseBytes: 1024 ** 2,
          maxRequestBytes: 1024 ** 2,
          notAfter: new Date(Date.now() + 3600000).toISOString(),
        };
        await expect(runSavedOrders(options, process.cwd())).rejects.toThrow();
        expect(existsSync(options.outDir)).toBe(false);
        await expect(
          runSavedOverseas(options, process.cwd()),
        ).rejects.toThrow();
      }
      expect(sends).toBe(0);
      expect(readFileSync(claim).equals(old)).toBe(true);
    } finally {
      globalThis.fetch = native;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
