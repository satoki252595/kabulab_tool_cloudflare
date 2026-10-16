/** Node-only saved-source repair: reviewed six-table CAS + normal overseas serializer and growth projection. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import {
  toD1BatchStatements,
  type D1BatchStatement,
} from "../../../../src/shared/db/d1-http-client.js";
import type { Database } from "../../src/db/client.js";
import * as schema from "../../src/db/schema.js";
import { rebuildYuhoGrowthProjection } from "../../src/services/projection.js";
import {
  validateOverseasSaveSet,
  type OverseasExtraction,
} from "../../src/services/overseas-parser.js";
import { serializeOverseasOmission } from "../../src/services/overseas-omission.js";
import { toOverseasSaveRows } from "../../src/services/overseas-save-rows.js";
import type { OrderExtraction } from "../../src/services/edinet/order-parser.js";
import {
  toOrderSaveRows,
  validateOrderRepairSet,
} from "../../src/services/order-save-rows.js";
import { canonicalizeForHash } from "../../../../src/shared/notion-archive/biztag-ledger.js";

export type Row = Record<string, string | number | null>;
export const tables = [
  "core_stocks",
  "yuho_documents",
  "yuho_order_facts",
  "yuho_overseas_facts",
  "yuho_text_sections",
  "p_yuho_growth",
] as const;
export type Snapshot = Record<(typeof tables)[number], Row[]>;
export const same = (actual: unknown, expected: unknown): void =>
  assert.deepEqual(canonicalizeForHash(actual), canonicalizeForHash(expected));

/** Exact all-column/count/set CAS, before every business DML in the same batch. */
export function guard(
  table: (typeof tables)[number],
  columns: string[],
  where: string,
  params: number[],
  expected: Row[],
): D1BatchStatement {
  assert(tables.includes(table));
  for (const column of columns) assert.match(column, /^[a-z_][a-z0-9_]*$/);
  for (const row of expected)
    same(Object.keys(row).sort(), [...columns].sort());
  const names = columns.map((column) => `"${column}"`).join(",");
  const json = columns
    .map((column) => `json_extract(value,'$.${column}')`)
    .join(",");
  return {
    sql: `WITH exp(${names}) AS (SELECT ${json} FROM json_each(?)),act(${names}) AS (SELECT ${names} FROM ${table} WHERE ${where}) SELECT json(CASE WHEN (SELECT COUNT(*) FROM exp)=(SELECT COUNT(*) FROM act) AND NOT EXISTS(SELECT * FROM act EXCEPT SELECT * FROM exp) AND NOT EXISTS(SELECT * FROM exp EXCEPT SELECT * FROM act) THEN 'null' ELSE '' END)`,
    params: [JSON.stringify(expected), ...params],
  };
}

export interface Target {
  stockId: number;
  documentId: number;
  docId: string;
  periodEnd: string;
  omissionSource?: {
    edinetCode: string;
    archivePageId: string;
    archiveManifest: "known" | "unknown";
    zipSha256: string;
  };
}
const targetRows = (snapshot: Snapshot, target: Target): Snapshot =>
  Object.fromEntries(
    tables.map((table) => [
      table,
      snapshot[table].filter(
        (row) =>
          row[table === "core_stocks" ? "id" : "stock_id"] === target.stockId,
      ),
    ]),
  ) as Snapshot;

export function openActualSnapshot(
  codeRoot: string,
  snapshot: Snapshot,
): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(codeRoot, "drizzle/d1");
  for (const name of readdirSync(dir)
    .filter((n) => /^\d{4}_.*\.sql$/.test(n))
    .sort()) {
    for (const statement of readFileSync(join(dir, name), "utf8").split(
      "--> statement-breakpoint",
    )) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }
  // Only actual six-table PRE values are seeded. Unrelated parent data is not invented.
  sqlite.exec("PRAGMA foreign_keys=OFF");
  for (const table of tables)
    for (const row of snapshot[table]) {
      const columns = Object.keys(row);
      for (const column of columns) assert.match(column, /^[a-z_][a-z0-9_]*$/);
      sqlite
        .prepare(
          `INSERT INTO ${table} (${columns.map((n) => `"${n}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        )
        .run(...columns.map((column) => row[column]));
    }
  return sqlite;
}

export function readSnapshot(sqlite: DatabaseSync, stockId: number): Snapshot {
  return Object.fromEntries(
    tables.map((table) => [
      table,
      sqlite
        .prepare(
          `SELECT * FROM ${table} WHERE ${table === "core_stocks" ? "id" : "stock_id"}=? ORDER BY ${table === "p_yuho_growth" ? "stock_id" : "id"}`,
        )
        .all(stockId),
    ]),
  ) as Snapshot;
}

export async function buildAtomicWithCommonProjection(
  codeRoot: string,
  pre: Snapshot,
  target: Target,
  parsed: OverseasExtraction,
  runStartedSec: number,
) {
  return buildAtomic(
    codeRoot,
    pre,
    target,
    { kind: "overseas", parsed },
    runStartedSec,
  );
}
export async function buildOrdersAtomicWithCommonProjection(
  codeRoot: string,
  pre: Snapshot,
  target: Target,
  parsed: OrderExtraction,
  runStartedSec: number,
) {
  return buildAtomic(
    codeRoot,
    pre,
    target,
    { kind: "orders", parsed },
    runStartedSec,
  );
}
async function buildAtomic(
  codeRoot: string,
  pre: Snapshot,
  target: Target,
  input:
    | { kind: "overseas"; parsed: OverseasExtraction }
    | { kind: "orders"; parsed: OrderExtraction },
  runStartedSec: number,
): Promise<{
  statements: D1BatchStatement[];
  expected: Snapshot;
  factStatements: number;
  projectionStatements: number;
}> {
  assert(Number.isSafeInteger(runStartedSec) && runStartedSec > 0);
  let overseasOmissionJson: string | null = null;
  if (input.kind === "overseas" && input.parsed.omission !== undefined) {
    assert(
      target.omissionSource,
      "omission requires qualified saved source provenance",
    );
    overseasOmissionJson = serializeOverseasOmission({
      docId: target.docId,
      periodEnd: target.periodEnd,
      ...target.omissionSource,
      omission: input.parsed.omission,
    });
  }
  const before = targetRows(pre, target),
    doc = before.yuho_documents.filter((row) => row.doc_id === target.docId);
  assert.equal(doc.length, 1);
  assert.equal(doc[0].id, target.documentId);
  assert.equal(doc[0].period_end, target.periodEnd);
  if (input.kind === "orders")
    validateOrderRepairSet(input.parsed, target.periodEnd);
  else {
    const parsed = input.parsed;
    assert(["ok_geo_rows", "ok_geo_cols"].includes(parsed.status));
    assert.notEqual(parsed.honbunFile, null);
    validateOverseasSaveSet(parsed.facts, parsed.proof);
    assert(
      parsed.facts.length > 0 &&
        parsed.facts.every(
          (f) =>
            f.fiscalYearEnd === target.periodEnd && f.isConsolidated === true,
        ),
    );
  }
  for (const row of before.p_yuho_growth)
    assert(
      typeof row.computed_at === "number" && row.computed_at <= runStartedSec,
    );
  const sqlite = openActualSnapshot(codeRoot, before),
    projection: D1BatchStatement[] = [];
  try {
    const columns = Object.fromEntries(
      tables.map((table) => [
        table,
        (
          sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{
            name: string;
          }>
        ).map((row) => row.name),
      ]),
    );
    for (const table of tables)
      for (const row of before[table])
        same(Object.keys(row).sort(), [...columns[table]].sort());
    const assertions = tables.map((table) =>
      guard(
        table,
        columns[table],
        `${table === "core_stocks" ? "id" : "stock_id"}=?`,
        [target.stockId],
        before[table],
      ),
    );
    const buildDb = drizzle(async () => {
      throw new Error("toSQL-only builder must not execute");
    }) as unknown as Database;
    let builders: Parameters<typeof toD1BatchStatements>[0];
    if (input.kind === "orders") {
      const parsed = input.parsed;
      const rows = toOrderSaveRows(parsed.facts, parsed.status).map((row) => ({
        documentId: target.documentId,
        stockId: target.stockId,
        ...row,
      }));
      builders = [
        buildDb
          .update(schema.yuhoDocuments)
          .set({ parseStatus: parsed.status, honbunFile: parsed.honbunFile })
          .where(eq(schema.yuhoDocuments.id, target.documentId)),
        buildDb
          .delete(schema.orderFacts)
          .where(eq(schema.orderFacts.documentId, target.documentId)),
      ];
      for (let i = 0; i < rows.length; i += 8)
        builders.push(
          buildDb.insert(schema.orderFacts).values(rows.slice(i, i + 8)),
        );
    } else {
      const parsed = input.parsed;
      const rows = toOverseasSaveRows(parsed.facts, parsed.status).map(
        (row) => ({
          documentId: target.documentId,
          stockId: target.stockId,
          ...row,
        }),
      );
      builders = [
        buildDb
          .update(schema.yuhoDocuments)
          .set({
            overseasParseStatus: parsed.status,
            overseasHonbunFile: parsed.honbunFile,
            overseasOmissionJson,
          })
          .where(eq(schema.yuhoDocuments.id, target.documentId)),
        buildDb
          .delete(schema.overseasSalesFacts)
          .where(eq(schema.overseasSalesFacts.documentId, target.documentId)),
      ];
      for (let i = 0; i < rows.length; i += 8)
        builders.push(
          buildDb
            .insert(schema.overseasSalesFacts)
            .values(rows.slice(i, i + 8)),
        );
    }
    const facts = toD1BatchStatements(builders);
    for (const statement of facts)
      sqlite
        .prepare(statement.sql)
        .run(...(statement.params as Array<string | number | null>));
    const localDb = drizzle(async (sql, params, method) => {
      const statement = sqlite.prepare(sql);
      if (method === "run") {
        assert.match(sql, /^(insert into|delete from) "p_yuho_growth"/i);
        const binds = params.map((value) => {
          assert(
            value === null ||
              typeof value === "string" ||
              typeof value === "number",
          );
          return value;
        });
        projection.push({ sql, params: binds });
        statement.run(...binds);
        return { rows: [] };
      }
      assert.match(sql, /^select /i);
      const names = statement.columns().map((column) => column.name);
      const result = (
        statement.all(...(params as Array<string | number | null>)) as Row[]
      ).map((row) => names.map((name) => row[name]));
      return {
        rows:
          method === "get"
            ? result[0] === undefined
              ? []
              : result[0]
            : result,
      };
    }) as unknown as Database;
    const rebuilt = await rebuildYuhoGrowthProjection(localDb, {
      stockIds: [target.stockId],
      runStartedSec,
    });
    assert.equal(rebuilt.stocks, 1);
    assert(projection.length > 0);
    const expected = readSnapshot(sqlite, target.stockId);
    same(expected.core_stocks, before.core_stocks);
    same(expected.yuho_text_sections, before.yuho_text_sections);
    if (input.kind === "orders") {
      same(expected.yuho_overseas_facts, before.yuho_overseas_facts);
      same(
        expected.yuho_documents,
        before.yuho_documents.map((row) =>
          row.id === target.documentId
            ? {
                ...row,
                parse_status: input.parsed.status,
                honbun_file: input.parsed.honbunFile,
              }
            : row,
        ),
      );
      same(
        expected.yuho_order_facts.filter(
          (row) => row.document_id !== target.documentId,
        ),
        before.yuho_order_facts.filter(
          (row) => row.document_id !== target.documentId,
        ),
      );
    } else {
      same(expected.yuho_order_facts, before.yuho_order_facts);
      same(
        expected.yuho_documents,
        before.yuho_documents.map((row) =>
          row.id === target.documentId
            ? {
                ...row,
                overseas_parse_status: input.parsed.status,
                overseas_honbun_file: input.parsed.honbunFile,
                overseas_omission_json: overseasOmissionJson,
              }
            : row,
        ),
      );
      same(
        expected.yuho_overseas_facts.filter(
          (row) => row.document_id !== target.documentId,
        ),
        before.yuho_overseas_facts.filter(
          (row) => row.document_id !== target.documentId,
        ),
      );
    }
    return {
      statements: [...assertions, ...facts, ...projection],
      expected,
      factStatements: facts.length,
      projectionStatements: projection.length,
    };
  } finally {
    sqlite.close();
  }
}

export function assertTargetPost(
  actual: Snapshot,
  expected: Snapshot,
  target: Target,
  kind: "overseas" | "orders" = "overseas",
): void {
  const factTable =
    kind === "orders" ? "yuho_order_facts" : "yuho_overseas_facts";
  for (const table of tables) {
    if (table !== factTable) {
      same(actual[table], expected[table]);
      continue;
    }
    same(
      actual[table].filter((row) => row.document_id !== target.documentId),
      expected[table].filter((row) => row.document_id !== target.documentId),
    );
    const noId = (rows: Row[]) =>
      rows
        .map(({ id: _id, ...row }) => row)
        .sort((a, b) =>
          kind === "orders"
            ? String(a.fiscal_year_end).localeCompare(
                String(b.fiscal_year_end),
              ) || String(a.segment_name).localeCompare(String(b.segment_name))
            : String(a.region_kind).localeCompare(String(b.region_kind)) ||
              String(a.region_name).localeCompare(String(b.region_name)),
        );
    same(
      noId(
        actual[table].filter((row) => row.document_id === target.documentId),
      ),
      noId(
        expected[table].filter((row) => row.document_id === target.documentId),
      ),
    );
  }
}
