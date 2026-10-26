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
import { parseOrderData, type OrderExtraction } from "../../src/services/edinet/order-parser.js";
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
  assertSavedLatest,
  assertSavedSourcePageMetadata,
  type SavedOverseasItem,
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
const historicalProof = join(process.cwd(), "tmp/orders-historical-proof-v1/CASE.private.json");

// Actual financial rows only; mutations below are declared negative/projection tests.
describe("normal finite orders repair", () => {
  it("requires explicit historical scope and selects the exact saved document, retaining latest admission by default", async () => {
    const doc = before.yuho_documents.find(row => row.doc_id === "S100W3NJ")!;
    const historical = { ...item, documentId: doc.id, docId: doc.doc_id, periodEnd: doc.period_end };
    await expect(assertSavedLatest(process.cwd(), before, [historical])).rejects.toThrow();
    expect((await assertSavedLatest(process.cwd(), before, [historical], "historical")).get(historical.docId)).toBe(doc.notion_doc_page_id);
    expect((await assertSavedLatest(process.cwd(), before, [item])).get(item.docId)).toBe(before.yuho_documents.find(row => row.id === item.documentId)!.notion_doc_page_id);
    await expect(assertSavedLatest(process.cwd(), before, [item], "historical")).rejects.toThrow();
    for (const fault of [
      { ...historical, stockId: historical.stockId + 1 },
      { ...historical, documentId: item.documentId },
      { ...historical, edinetCode: "E02083" },
      { ...historical, periodEnd: item.periodEnd },
    ]) await expect(assertSavedLatest(process.cwd(), before, [fault], "historical")).rejects.toThrow();
    for (const change of [{ text_parse_status: null }, { notion_doc_page_id: "" }, { doc_type_code: "140" }]) {
      const snapshot = structuredClone(before);
      Object.assign(snapshot.yuho_documents.find(row => row.id === doc.id)!, change);
      await expect(assertSavedLatest(process.cwd(), snapshot, [historical], "historical")).rejects.toThrow();
    }
  });
  it.skipIf(!existsSync(historicalProof))("replays four qualified 6721 originals through historical identity and normal six-table repair before current projection", async () => {
    const bytes = readFileSync(historicalProof);
    expect(sha(bytes)).toBe("cc887bef3a6e4c28ee9864bbfdd9c5d3bca207b88d3cc41969cd335993053cb3");
    const actual = JSON.parse(bytes.toString()) as {
      before: Snapshot;
      history: { item: SavedOverseasItem; parsed: OrderExtraction; sourcePage: Parameters<typeof assertSavedSourcePageMetadata>[1] }[];
      current: OrderExtraction;
    };
    let snapshot = actual.before;
    const runClock = Number(snapshot.p_yuho_growth[0].computed_at) + 1;
    let failureSha: string | undefined;
    // Primary paragraphs stay private; failed bulk comparisons only report a fixed label.
    try {
      for (const entry of actual.history) {
        const doc = snapshot.yuho_documents.find(row => row.id === entry.item.documentId)!;
        await assertSavedLatest(process.cwd(), snapshot, [entry.item], "historical");
        assertSavedSourcePageMetadata(entry.item, entry.sourcePage, doc);
        const raw = entry.sourcePage.properties.Metadata as { rich_text: { plain_text: string }[] };
        const native = JSON.parse(raw.rich_text.map(part => part.plain_text).join(""));
        for (const field of ["docID", "edinetCode", "secCode", "filerName", "docTypeCode", "periodStart", "periodEnd", "submitDateTime"]) {
          const fault = structuredClone(entry.sourcePage);
          const text = JSON.stringify({ ...native, [field]: "declared-negative-identity" });
          fault.properties.Metadata = { type: "rich_text", rich_text: [{ type: "text", plain_text: text, text: { content: text } }] };
          expect(() => assertSavedSourcePageMetadata(entry.item, fault, doc)).toThrow();
        }
        const built = await buildOrdersAtomicWithCommonProjection(process.cwd(), snapshot, entry.item, entry.parsed, runClock);
        const db = openActualSnapshot(process.cwd(), snapshot);
        try {
          db.exec("BEGIN");
          for (const statement of built.statements) db.prepare(statement.sql).all(...(statement.params as (number | string | null)[]));
          db.exec("COMMIT");
          const post = readSnapshot(db, entry.item.stockId);
          assertTargetPost(post, built.expected, entry.item, "orders");
          const oldFacts = snapshot.yuho_order_facts.filter(row => row.document_id === entry.item.documentId);
          const newFacts = post.yuho_order_facts.filter(row => row.document_id === entry.item.documentId);
          expect(oldFacts.every(row => row.orders_received_raw === null)).toBe(true);
          expect(newFacts.every(row => row.orders_received_raw === oldFacts[0].order_backlog_raw && row.order_backlog_raw !== oldFacts[0].order_backlog_raw)).toBe(true);
          snapshot = post;
        } finally { db.close(); }
      }
      const doc = snapshot.yuho_documents.find(row => row.doc_id === "S100XW0L")!;
      const built = await buildOrdersAtomicWithCommonProjection(process.cwd(), snapshot,
        { stockId: 3979, documentId: Number(doc.id), docId: String(doc.doc_id), periodEnd: String(doc.period_end) }, actual.current, runClock);
      const result = built.expected.p_yuho_growth[0];
      expect(result.ord_years).toBe(5);
      expect(result.ord_orders_yoy).toBeCloseTo(0.729206446192622, 12);
      expect(result.ord_backlog_yoy).toBeCloseTo(-0.11918665332141543, 12);
      expect(result.ord_orders_cagr).toBeCloseTo(-0.013108323083954043, 12);
      expect(result.ord_backlog_cagr).toBeCloseTo(-0.08111171069828393, 12);
      // Amount-derived YoY is deliberately not replaced with the printed -7.8%.
      expect(result.ord_orders_yoy).not.toBeCloseTo(-0.078, 2);
    } catch (error) {
      const path = join(process.cwd(), "tmp/orders-historical-proof-v1/FAILURE.private.txt");
      writeFileSync(path, String(error), { mode: 0o600 });
      failureSha = sha(readFileSync(path));
    }
    expect(failureSha, "private replay failure: diagnostic is saved privately; only SHA is reported").toBeUndefined();
  });
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
    expect(built.expected.p_yuho_growth).toHaveLength(1);
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
  it("saves actual subtotal-only 1768 orders without inventing a total or growth row, preserving six-table CAS and repeat", async () => {
    const dir = fileURLToPath(
      new URL("../../src/tests/fixtures/order-saved-1768/", import.meta.url),
    );
    const proof = JSON.parse(
      readFileSync(join(dir, "provenance.json"), "utf8"),
    );
    const raw = readFileSync(join(dir, "S100YEJU.zip"));
    const original = JSON.parse(
      readFileSync(join(dir, "snapshot.json"), "utf8"),
    ) as Snapshot;
    expect(sha(raw)).toBe(proof.zipSha256);
    expect(sha(readFileSync(join(dir, "snapshot.json")))).toBe(
      proof.snapshotSha256,
    );
    const facts = parseOrderData(raw, proof.item.periodEnd);
    expect(facts.status).toBe("ok_pattern_b");
    expect(facts.facts).toHaveLength(6);
    expect(new Set(facts.facts.map((f) => f.fiscalYearEnd))).toEqual(
      new Set(["2025-03-31", "2026-03-31"]),
    );
    expect(new Set(facts.facts.map((f) => f.segmentKind))).toEqual(
      new Set(["segment", "subtotal"]),
    );
    expect(new Set(facts.facts.map((f) => f.isConsolidated))).toEqual(
      new Set([true]),
    );
    validateOrderRepairSet(facts, proof.item.periodEnd);
    const target = {
      stockId: proof.item.stockId,
      documentId: proof.item.documentId,
      docId: proof.item.docId,
      periodEnd: proof.item.periodEnd,
    };
    const built = await buildOrdersAtomicWithCommonProjection(
      process.cwd(),
      original,
      target,
      facts,
      clock,
    );
    expect(built.expected.p_yuho_growth).toEqual([]);
    expect(built.projectionStatements).toBe(1); // The unchanged normal scoped sweep remains in the batch.
    const db = openActualSnapshot(process.cwd(), original);
    try {
      db.exec("BEGIN");
      for (const statement of built.statements)
        db.prepare(statement.sql).all(
          ...(statement.params as (string | number | null)[]),
        );
      db.exec("COMMIT");
      const actual = readSnapshot(db, target.stockId);
      assertTargetPost(actual, built.expected, target, "orders");
      expect(
        actual.yuho_order_facts
          .filter((row) => row.document_id === target.documentId)
          .map((row) => row.segment_kind),
      ).toEqual(facts.facts.map((row) => row.segmentKind));
      expect(actual.yuho_overseas_facts).toEqual(original.yuho_overseas_facts);
      expect(actual.yuho_text_sections).toEqual(original.yuho_text_sections);
      expect(actual.core_stocks).toEqual(original.core_stocks);
      const repeated = await buildOrdersAtomicWithCommonProjection(
        process.cwd(),
        actual,
        target,
        facts,
        clock + 1,
      );
      expect(savedBusinessView(repeated.expected, "orders")).toEqual(
        savedBusinessView(actual, "orders"),
      );
    } finally {
      db.close();
    }
    for (let index = 0; index < tables.length; index++) {
      // Deliberately wrong expected PRE, never seeded as financial source or persisted business data.
      const statements = built.statements.map((statement) => ({
        ...statement,
        params: [...statement.params],
      }));
      const expected = JSON.parse(String(statements[index].params[0]));
      statements[index].params[0] = JSON.stringify(
        expected.length > 0 ? expected.slice(1) : [{}],
      );
      const raced = openActualSnapshot(process.cwd(), original);
      try {
        raced.exec("BEGIN");
        expect(() => {
          for (const statement of statements)
            raced
              .prepare(statement.sql)
              .all(...(statement.params as (string | number | null)[]));
        }).toThrow();
        raced.exec("ROLLBACK");
        expect(readSnapshot(raced, target.stockId)).toEqual(original);
      } finally {
        raced.close();
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
        {
          version: 2,
          kind: "orders",
          ordersDocumentScope: "historical",
          cohortSha256,
          qualified: [{ item }],
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
        for (const ordersDocumentScope of [undefined, "historical"] as const) {
          // Old/latest PRE and historical PRE cannot be mixed in either direction.
          const scoped = { ...options, ordersDocumentScope };
          if (capsule.version === 2 && capsule.ordersDocumentScope !== ordersDocumentScope)
            await expect(runSavedOrders(scoped, process.cwd())).rejects.toThrow("saved document scope differs from PRE");
          else await expect(runSavedOrders(scoped, process.cwd())).rejects.toThrow();
          expect(existsSync(scoped.outDir)).toBe(false);
          if (ordersDocumentScope === "historical")
            await expect(runSavedOverseas(scoped, process.cwd())).rejects.toThrow("historical document scope is orders-only");
          else await expect(runSavedOverseas(scoped, process.cwd())).rejects.toThrow();
        }
      }
      expect(sends).toBe(0);
      expect(readFileSync(claim).equals(old)).toBe(true);
    } finally {
      globalThis.fetch = native;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
