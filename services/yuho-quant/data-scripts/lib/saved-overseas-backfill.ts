/** Finite Node backfill from saved EDINET sources. No source API or model calls. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
  existsSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { z } from "zod";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import {
  assertD1SingleQueryResponse,
  createD1HttpBatchSender,
  d1HttpQueryUrl,
  type D1BatchStatement,
} from "../../../../src/shared/db/d1-http-client.js";
import { sharedEnv } from "../../../../src/shared/env.js";
import {
  notionEnv,
  NotionConfigError,
} from "../../../../src/shared/notion-archive/env.js";
import {
  notionRequest,
  setNotionMaxRps,
} from "../../../../src/shared/notion-archive/client.js";
import {
  recordPrimaryData,
  verifyArchivedAttachments,
} from "../../../../src/shared/notion-archive/index.js";
import {
  findStockTextRowId,
  readStockTextRow,
} from "../../../../src/shared/notion-archive/stock-text.js";
import { canonicalizeForHash } from "../../../../src/shared/notion-archive/biztag-ledger.js";
import { normalizeFilePropForCompare } from "../../../../src/shared/notion-archive/file-property.js";
import {
  readSavedHoldingsZip,
  verifySavedHoldingsMetadata,
} from "../../../../src/shared/notion-archive/shareholdings.js";
import {
  loadLatestDocs,
  type BiztagSourceDb,
} from "../../src/biztag/source.js";
import {
  parseOverseasData,
  validateOverseasSaveSet,
  type OverseasExtraction,
} from "../../src/services/overseas-parser.js";
import {
  buildAtomicWithCommonProjection,
  buildOrdersAtomicWithCommonProjection,
  assertTargetPost,
  openActualSnapshot,
  same,
  tables,
  type Snapshot,
  type Row,
  type Target,
} from "./saved-overseas-atomic.js";

import {
  parseOrderData,
  type OrderExtraction,
} from "../../src/services/edinet/order-parser.js";
import { validateOrderRepairSet } from "../../src/services/order-save-rows.js";

type SavedKind = "overseas" | "orders";
const digest = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const id = z.string().regex(/^[a-f0-9-]{32,36}$/i);
const iso = z
  .string()
  .refine(
    (value) => Number.isFinite(Date.parse(value)),
    "unknown source clock",
  );
const itemSchema = z.strictObject({
  stockCode: z.string().regex(/^[0-9][0-9A-Z]{3}$/),
  stockId: z.number().int().positive(),
  documentId: z.number().int().positive(),
  docId: z.string().regex(/^S[0-9A-Z]+$/),
  edinetCode: z.string().regex(/^E\d{5}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  zipSha256: z.string().regex(/^[a-f0-9]{64}$/),
  archivePageId: id,
  originalManifest: z.enum(["known", "unknown"]),
  sourceFetchedAt: iso,
});
const cohortFields = {
  stateDir: z
    .string()
    .refine((value) => resolve(value) === value, "stateDir must be absolute"),
  items: z.array(itemSchema).min(1).max(200),
};
const checkCohortItems = (
  { items }: { items: z.infer<typeof itemSchema>[] },
  ctx: z.RefinementCtx,
) => {
  for (const key of ["stockCode", "stockId", "documentId", "docId"] as const) {
    if (new Set(items.map((item) => item[key])).size !== items.length)
      ctx.addIssue({ code: "custom", message: `duplicate ${key}` });
  }
  if (
    items.some(
      (item, index) =>
        index > 0 && items[index - 1].stockCode >= item.stockCode,
    )
  )
    ctx.addIssue({ code: "custom", message: "cohort must be in code order" });
};
export const savedCohortSchema = z
  .strictObject({ version: z.literal(1), ...cohortFields })
  .superRefine(checkCohortItems);
export const savedOrdersCohortSchema = z
  .strictObject({
    version: z.literal(2),
    kind: z.literal("orders"),
    ...cohortFields,
  })
  .superRefine(checkCohortItems);
export type SavedOverseasItem = z.infer<typeof itemSchema>;
export type SavedOverseasCohort = z.infer<typeof savedCohortSchema>;
export type SavedOrdersCohort = z.infer<typeof savedOrdersCohortSchema>;
type SavedCohort = SavedOverseasCohort | SavedOrdersCohort;
type SourceCohort = Pick<SavedOverseasCohort, "stateDir" | "items">;
type Page = {
  id: string;
  object: "page";
  parent: { type: "database_id"; database_id: string };
  archived: boolean;
  in_trash: boolean;
  last_edited_time: string;
  properties: Record<string, unknown>;
};
type Qualified<E = OverseasExtraction | OrderExtraction> = {
  item: SavedOverseasItem;
  sourcePage: Page;
  bodyPage: Page;
  sections: Awaited<ReturnType<typeof readStockTextRow>>;
  archivePageId: string;
  extraction: E;
  zipPath: string;
  zipSha256: string;
};
interface SavedCapsule {
  version: 1 | 2;
  kind?: "orders";
  cohortSha256: string;
  schema: Record<string, string[]>;
  d1: Snapshot;
  qualified: Qualified[];
}
export interface SavedOverseasCapsule extends SavedCapsule {
  version: 1;
  kind?: never;
  qualified: Qualified<OverseasExtraction>[];
}
export interface SavedOrdersCapsule extends SavedCapsule {
  version: 2;
  kind: "orders";
  qualified: Qualified<OrderExtraction>[];
}
function parseSavedExtraction(zip: Buffer, periodEnd: string, kind: SavedKind) {
  if (kind === "orders") {
    const parsed = parseOrderData(zip, periodEnd);
    validateOrderRepairSet(parsed, periodEnd);
    return parsed;
  }
  const parsed = parseOverseasData(zip, periodEnd);
  validateOverseasSaveSet(parsed.facts, parsed.proof);
  assert(["ok_geo_rows", "ok_geo_cols"].includes(parsed.status));
  assert(
    parsed.facts.length > 0 &&
      parsed.facts.every(
        (f) => f.isConsolidated === true && f.fiscalYearEnd === periodEnd,
      ),
  );
  return parsed;
}
const nid = (value: string) => value.replaceAll("-", "").toLowerCase();
const sourceOf = (item: SavedOverseasItem) => ({
  stockCode: item.stockCode,
  docId: item.docId,
  edinetCode: item.edinetCode,
  fiscalYearEnd: item.periodEnd,
});
const targetOf = (value: Qualified): Target => ({
  stockId: value.item.stockId,
  documentId: value.item.documentId,
  docId: value.item.docId,
  periodEnd: value.item.periodEnd,
  omissionSource: {
    edinetCode: value.item.edinetCode,
    archivePageId: value.archivePageId,
    archiveManifest: value.item.originalManifest,
    zipSha256: value.zipSha256,
  },
});
/** Identity/derived clocks do not turn equal business values into a destructive rewrite. */
export function savedBusinessView(
  value: Snapshot,
  kind: SavedKind = "overseas",
): unknown {
  return {
    ...value,
    [kind === "orders" ? "yuho_order_facts" : "yuho_overseas_facts"]: value[
      kind === "orders" ? "yuho_order_facts" : "yuho_overseas_facts"
    ]
      .map(({ id: _id, ...row }) => row)
      .sort(
        (a, b) =>
          Number(a.document_id) - Number(b.document_id) ||
          (kind === "orders"
            ? String(a.fiscal_year_end).localeCompare(
                String(b.fiscal_year_end),
              ) || String(a.segment_name).localeCompare(String(b.segment_name))
            : String(a.region_kind).localeCompare(String(b.region_kind)) ||
              String(a.region_name).localeCompare(String(b.region_name))),
      ),
    p_yuho_growth: value.p_yuho_growth.map(
      ({
        computed_at: _clock,
        as_of: _asOf,
        source_max_date: _sourceMax,
        ...row
      }) => row,
    ),
  };
}
const subset = (all: Snapshot, item: SavedOverseasItem): Snapshot =>
  Object.fromEntries(
    tables.map((table) => [
      table,
      all[table].filter(
        (row) =>
          row[table === "core_stocks" ? "id" : "stock_id"] === item.stockId,
      ),
    ]),
  ) as Snapshot;
export function stableSavedPage(page: Page): unknown {
  const { request_id: _request, ...rest } = page as Page & {
    request_id?: unknown;
  };
  return {
    ...rest,
    properties: Object.fromEntries(
      Object.entries(page.properties).map(([name, value]) => {
        if (
          typeof value !== "object" ||
          value === null ||
          !("type" in value) ||
          value.type !== "files"
        )
          return [name, value];
        const files = normalizeFilePropForCompare(value);
        assert(files.ok);
        return [name, files.norm];
      }),
    ),
  };
}
function page(value: Page, expectedId: string): Page {
  assert.equal(value.object, "page");
  assert.equal(nid(value.id), nid(expectedId));
  assert.equal(value.archived, false);
  assert.equal(value.in_trash, false);
  assert.equal(value.parent.type, "database_id");
  assert(Number.isFinite(Date.parse(value.last_edited_time)));
  return value;
}
function metadata(source: Page): Record<string, unknown> {
  const prop = source.properties.Metadata as {
    type: string;
    rich_text: Array<{
      type: string;
      plain_text: string;
      text: { content: string };
    }>;
  };
  assert.equal(prop.type, "rich_text");
  const raw = prop.rich_text
    .map((part) => {
      assert.equal(part.type, "text");
      assert.equal(part.plain_text, part.text.content);
      return part.plain_text;
    })
    .join("");
  const data: unknown = JSON.parse(raw);
  assert(data !== null && typeof data === "object" && !Array.isArray(data));
  return data as Record<string, unknown>;
}
export function assertSavedCanonicalSource(
  item: SavedOverseasItem,
  source: Page,
  actualSha: string,
  actualClock: string,
): void {
  assert.equal(actualSha, item.zipSha256);
  assert.equal(Date.parse(actualClock), Date.parse(item.sourceFetchedAt));
  const rawClock = source.properties["Fetched At"] as {
    date: { start: string };
  };
  assert.equal(Date.parse(rawClock.date.start), Date.parse(actualClock));
  assert.equal(
    verifySavedHoldingsMetadata(metadata(source), sourceOf(item)).status,
    "verified",
  );
  if (nid(source.id) !== nid(item.archivePageId)) {
    const data = metadata(source);
    assert.equal(data.edinetDocType, 1);
    assert.equal(nid(String(data.sourceLegacyPageId)), nid(item.archivePageId));
    const manifest = data._fileManifest as { files: Array<{ sha256: string }> };
    assert(Array.isArray(manifest.files));
    assert.equal(manifest.files.length, 1);
    assert.equal(manifest.files[0].sha256, item.zipSha256);
  }
}

/** A prepared canonical source is admitted only through the same pinned input and verified lineage. */
export function initialSavedSourceIds(
  cohort: SourceCohort,
  qualified: readonly Pick<
    Qualified,
    "item" | "sourcePage" | "archivePageId" | "zipSha256"
  >[],
): Set<string> {
  const ids = new Set(cohort.items.map((item) => nid(item.archivePageId)));
  for (const value of qualified) {
    const item = cohort.items.find((item) => item.docId === value.item.docId);
    assert(item);
    same(value.item, item);
    assert.equal(nid(value.sourcePage.id), nid(value.archivePageId));
    assertSavedCanonicalSource(
      item,
      value.sourcePage,
      value.zipSha256,
      item.sourceFetchedAt,
    );
    ids.add(nid(value.archivePageId));
  }
  return ids;
}

function durable(
  dir: string,
  name: string,
  bytes: string | Uint8Array,
): string {
  const path = join(dir, name),
    fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const parent = openSync(dir, "r");
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
  return path;
}
const snapshotSql = (table: (typeof tables)[number], ids: number[]) => ({
  sql: `SELECT * FROM ${table} WHERE ${table === "core_stocks" ? "id" : "stock_id"} IN (${ids.map(() => "?").join(",")}) ORDER BY ${table === "p_yuho_growth" ? "stock_id" : "id"}`,
  params: ids,
});
export function savedReadQueries(
  cohort: SourceCohort,
): Array<{ sql: string; params: number[] }> {
  const ids = cohort.items.map((item) => item.stockId),
    groups = [ids.slice(0, 10), ids.slice(10)].filter(
      (group) => group.length > 0,
    );
  return tables.flatMap((table) => [
    { sql: `PRAGMA table_info(${table})`, params: [] },
    ...[...groups, ...ids.map((value) => [value])].map((group) =>
      snapshotSql(table, group),
    ),
  ]);
}
async function query(sql: string, params: number[]): Promise<Row[]> {
  const response = await fetch(d1HttpQueryUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sharedEnv.CLOUDFLARE_API_TOKEN()}`,
    },
    body: JSON.stringify({ sql, params }),
  });
  assert.equal(response.status, 200);
  const rows = assertD1SingleQueryResponse(await response.json());
  for (const row of rows)
    for (const value of Object.values(row))
      assert(
        value === null ||
          typeof value === "string" ||
          (typeof value === "number" && Number.isFinite(value)),
      );
  return rows as Row[];
}
async function snapshot(items: SavedOverseasItem[]): Promise<Snapshot> {
  assert(items.length > 0 && items.length <= 20);
  const all = Object.fromEntries(
    tables.map((table) => [table, []]),
  ) as unknown as Snapshot;
  for (let offset = 0; offset < items.length; offset += 10)
    for (const table of tables) {
      const q = snapshotSql(
        table,
        items.slice(offset, offset + 10).map((item) => item.stockId),
      );
      all[table].push(...(await query(q.sql, q.params)));
    }
  return all;
}
async function columns(): Promise<Record<string, string[]>> {
  const output: Record<string, string[]> = {};
  for (const table of tables) {
    const rows = await query(`PRAGMA table_info(${table})`, []);
    assert(rows.length > 0);
    output[table] = rows.map((row) => {
      assert.equal(typeof row.name, "string");
      return row.name as string;
    });
  }
  return output;
}
export async function assertSavedLatest(
  codeRoot: string,
  current: Snapshot,
  items: SavedOverseasItem[],
): Promise<Map<string, string>> {
  const local = openActualSnapshot(codeRoot, current);
  try {
    const db = drizzle(async (sql, params, method) => {
      assert.match(sql, /^select /i);
      const statement = local.prepare(sql),
        names = statement.columns().map((column) => column.name),
        rows = (
          statement.all(...(params as Array<string | number | null>)) as Row[]
        ).map((row) => names.map((name) => row[name]));
      return {
        rows: method === "get" ? (rows[0] === undefined ? [] : rows[0]) : rows,
      };
    }) as unknown as BiztagSourceDb;
    const latest = await loadLatestDocs(db);
    assert.equal(latest.length, items.length);
    const pointers = new Map<string, string>();
    for (const item of items) {
      const found = latest.filter((row) => row.stockCode === item.stockCode);
      assert.equal(found.length, 1);
      const doc = found[0].doc;
      assert(doc);
      assert.equal(doc.docId, item.docId);
      assert.equal(doc.periodEnd, item.periodEnd);
      assert(doc.notionDocPageId);
      const native = current.yuho_documents.filter(
        (row) => row.id === item.documentId,
      );
      assert.equal(native.length, 1);
      assert.equal(native[0].edinet_code, item.edinetCode);
      pointers.set(item.docId, doc.notionDocPageId);
    }
    return pointers;
  } finally {
    local.close();
  }
}
async function body(item: SavedOverseasItem, pointer: string) {
  assert.equal(
    await findStockTextRowId(notionEnv.NOTION_YUHO_TEXT_DB_ID(), item.docId),
    pointer,
  );
  const before = page(
      await notionRequest<Page>("GET", `/pages/${pointer}`),
      pointer,
    ),
    sections = await readStockTextRow(pointer, true),
    after = page(
      await notionRequest<Page>("GET", `/pages/${pointer}`),
      pointer,
    );
  same(stableSavedPage(before), stableSavedPage(after));
  assert(sections.length > 0);
  return { bodyPage: after, sections };
}
async function capture(
  codeRoot: string,
  cohort: SourceCohort,
  cohortSha256: string,
  dir: string,
  kind: SavedKind,
): Promise<SavedCapsule> {
  const schema = await columns(),
    d1 = await snapshot(cohort.items),
    pointers = await assertSavedLatest(codeRoot, d1, cohort.items),
    qualified: Qualified[] = [];
  for (const item of cohort.items) {
    const saved = await readSavedHoldingsZip(sourceOf(item), {
      remainingBytes: 20 * 1024 ** 2,
    });
    assert.equal(saved.status, "ready");
    assert(saved.status === "ready");
    const sourcePage = page(
      await notionRequest<Page>("GET", `/pages/${saved.archivePageId}`),
      saved.archivePageId,
    );
    assertSavedCanonicalSource(item, sourcePage, saved.sha256, saved.fetchedAt);
    const extraction = parseSavedExtraction(saved.bytes, item.periodEnd, kind);
    const zipPath = durable(
        dir,
        `${item.stockCode}-${item.docId}.zip`,
        saved.bytes,
      ),
      pointer = pointers.get(item.docId);
    assert(pointer);
    qualified.push({
      item,
      archivePageId: saved.archivePageId,
      sourcePage,
      ...(await body(item, pointer)),
      extraction,
      zipPath,
      zipSha256: saved.sha256,
    });
  }
  same(await snapshot(cohort.items), d1);
  return {
    ...(kind === "orders"
      ? { version: 2 as const, kind: "orders" as const }
      : { version: 1 as const }),
    cohortSha256,
    schema,
    d1,
    qualified,
  };
}
async function assertSources(
  current: Snapshot,
  capsule: SavedCapsule,
  codeRoot: string,
): Promise<void> {
  const pointers = await assertSavedLatest(
    codeRoot,
    current,
    capsule.qualified.map((value) => value.item),
  );
  for (const value of capsule.qualified) {
    const zip = readFileSync(value.zipPath);
    assert.equal(digest(zip), value.zipSha256);
    same(
      parseSavedExtraction(
        zip,
        value.item.periodEnd,
        capsule.version === 2 ? "orders" : "overseas",
      ),
      value.extraction,
    );
    const source = page(
      await notionRequest<Page>("GET", `/pages/${value.archivePageId}`),
      value.archivePageId,
    );
    same(stableSavedPage(source), stableSavedPage(value.sourcePage));
    const pointer = pointers.get(value.item.docId);
    assert(pointer);
    const actual = await body(value.item, pointer);
    same(stableSavedPage(actual.bodyPage), stableSavedPage(value.bodyPage));
    same(actual.sections, value.sections);
  }
}

export interface SavedRunOptions {
  mode: "prepare" | "apply" | "inspect";
  cohortPath: string;
  cohortSha256: string;
  outDir: string;
  afterCode: string | null;
  maxTargets: number;
  capsulePath?: string;
  capsuleSha256?: string;
  maxSeconds: number;
  maxNotionRps: number;
  maxHttp: number;
  maxNotion: number;
  maxD1: number;
  maxResponseBytes: number;
  maxRequestBytes: number;
  notAfter: string;
}

/** Native guard is local to this finite command; normal shared clients still own all IO. */
function installGuard(
  options: SavedRunOptions,
  cohort: SourceCohort,
  dir: string,
  ancestor: SavedCapsule | null,
  kind: SavedKind,
) {
  const native = globalThis.fetch,
    start = performance.now(),
    deadline = Math.min(
      Date.now() + options.maxSeconds * 1000,
      Date.parse(options.notAfter),
    );
  const allowed = new Set(
      savedReadQueries(cohort).map((q) => JSON.stringify(q)),
    ),
    pages = initialSavedSourceIds(
      cohort,
      ancestor === null ? [] : ancestor.qualified,
    ),
    bodyPages = new Set<string>(),
    hosted = new Set<string>(),
    primary = new Set<string>(),
    uploads = new Map<string, { filename: string; sent: boolean }>(),
    attached = new Set<string>();
  const bodyDb = nid(notionEnv.NOTION_YUHO_TEXT_DB_ID());
  let stopped = false,
    armedBatch: string | null = null,
    proof: { key: string; filename: string; sha256: string } | null = null;
  const counts = {
    requests: 0,
    notion: 0,
    d1Reads: 0,
    d1Batches: 0,
    hosted: 0,
    requestBytes: 0,
    responseRetainedBytes: 0,
    responseObservedBytes: 0,
    d1RowsRead: 0,
  };
  const check = () =>
    assert(
      !stopped &&
        deadline - Date.now() > 65000 &&
        counts.requests < options.maxHttp,
      "finite command stopped/deadline/budget; do not retry",
    );
  function discover(value: unknown): void {
    if (value === null || typeof value !== "object") return;
    const v = value as { type?: unknown; file?: { url?: unknown } };
    if (v.type === "file" && typeof v.file?.url === "string")
      hosted.add(v.file.url);
    for (const child of Object.values(value)) discover(child);
  }
  async function bounded(
    stream: ReadableStream<Uint8Array> | null,
    max: number,
    stem: string,
    response: boolean,
  ): Promise<Buffer> {
    assert(stream);
    const reader = stream.getReader(),
      chunks: Uint8Array[] = [];
    let retained = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        if (response) counts.responseObservedBytes += part.value.length;
        const room = Math.min(
          max - retained,
          response
            ? options.maxResponseBytes - counts.responseRetainedBytes
            : max - retained,
        );
        if (part.value.length > room) {
          chunks.push(part.value.subarray(0, Math.max(0, room)));
          retained += Math.max(0, room);
          if (response) counts.responseRetainedBytes += Math.max(0, room);
          await reader.cancel();
          throw new Error("finite retained native body cap");
        }
        chunks.push(part.value);
        retained += part.value.length;
        if (response) counts.responseRetainedBytes += part.value.length;
        assert(Date.now() < deadline);
      }
      return Buffer.concat(chunks);
    } catch (error) {
      durable(dir, `${stem}-partial.body`, Buffer.concat(chunks));
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
  globalThis.fetch = async (input, init) => {
    try {
      check();
      const req = new Request(input, init),
        url = new URL(req.url),
        sequence = counts.requests + 1;
      const bytes =
        req.body === null
          ? Buffer.alloc(0)
          : await bounded(
              req.clone().body,
              20 * 1024 ** 2,
              `native-${sequence}-request`,
              false,
            );
      counts.requestBytes += bytes.length;
      assert(counts.requestBytes <= options.maxRequestBytes);
      const payload: unknown =
        req.headers.get("content-type")?.includes("application/json") &&
        bytes.length > 0
          ? JSON.parse(bytes.toString())
          : null;
      const obj = payload as Record<string, unknown> | null;
      let kind: string,
        archiveKey: string | null = null,
        createdUpload = false,
        createdPage = false;
      if (req.url === d1HttpQueryUrl()) {
        assert.equal(req.method, "POST");
        assert(bytes.length <= 4 * 1024 ** 2);
        assert(obj);
        if (Array.isArray(obj.batch)) {
          assert.equal(options.mode, "apply");
          assert(armedBatch);
          assert.equal(JSON.stringify(obj.batch), armedBatch);
          assert(++counts.d1Batches <= cohort.items.length);
          kind = "d1_batch";
        } else {
          assert(allowed.has(JSON.stringify(obj)));
          assert(++counts.d1Reads <= options.maxD1);
          kind = "d1_read";
        }
      } else if (url.origin === "https://api.notion.com") {
        assert(++counts.notion <= options.maxNotion);
        const matchPage = url.pathname.match(/^\/v1\/pages\/([a-f0-9-]+)$/i),
          props = url.pathname.match(
            /^\/v1\/pages\/([a-f0-9-]+)\/properties\/[^/]+$/i,
          ),
          blocks = url.pathname.match(
            /^\/v1\/blocks\/([a-f0-9-]+)\/children$/i,
          ),
          db = url.pathname.match(/^\/v1\/databases\/([a-f0-9-]+)$/i),
          queryDb = url.pathname.match(
            /^\/v1\/databases\/([a-f0-9-]+)\/query$/i,
          ),
          upload = url.pathname.match(
            /^\/v1\/file_uploads\/([a-f0-9-]+)(\/send)?$/i,
          );
        if (req.method === "GET") {
          assert(
            (matchPage &&
              (pages.has(nid(matchPage[1])) ||
                bodyPages.has(nid(matchPage[1])))) ||
              (props && pages.has(nid(props[1]))) ||
              (blocks && bodyPages.has(nid(blocks[1]))) ||
              (db && primary.has(nid(db[1]))) ||
              (upload && !upload[2] && uploads.has(nid(upload[1]))) ||
              (url.pathname === "/v1/users/me" && proof !== null),
          );
          kind = "notion_read";
        } else if (req.method === "POST" && url.pathname === "/v1/search") {
          assert(obj);
          assert.equal(obj.query, "一次データ｜yuho-quant");
          same(obj.filter, { property: "object", value: "database" });
          assert.equal(obj.page_size, 100);
          kind = "notion_read";
        } else if (req.method === "POST" && queryDb) {
          assert(obj);
          const filter = obj.filter as {
            property?: unknown;
            title?: { equals?: unknown };
          };
          assert.equal(typeof filter.title?.equals, "string");
          assert(filter.title);
          archiveKey = filter.title.equals as string;
          if (nid(queryDb[1]) === bodyDb) {
            assert.equal(filter.property, "文書");
            assert(cohort.items.some((item) => item.docId === archiveKey));
          } else {
            assert(primary.has(nid(queryDb[1])));
            assert.equal(filter.property, "Key");
            assert(
              cohort.items.some(
                (item) =>
                  archiveKey === item.docId ||
                  archiveKey === `${item.docId}:type1`,
              ) || proof?.key === archiveKey,
            );
          }
          assert.equal(obj.page_size, 2);
          same(Object.keys(obj).sort(), ["filter", "page_size"]);
          kind = "notion_read";
        } else {
          assert.equal(options.mode, "apply");
          assert(proof);
          assert.equal(url.search, "");
          assert.equal(req.method, "POST");
          kind = "notion_mutation";
          if (url.pathname === "/v1/file_uploads") {
            assert(obj);
            same(obj, {
              mode: "single_part",
              filename: proof.filename,
              content_type: "application/gzip",
            });
            createdUpload = true;
          } else if (upload?.[2] === "/send") {
            const token = uploads.get(nid(upload[1]));
            assert(token && !token.sent);
            const form = await req.clone().formData();
            const keys: string[] = [];
            form.forEach((_value, key) => keys.push(key));
            same(keys, ["file"]);
            const file = form.get("file");
            assert(file instanceof File);
            assert.equal(file.name, proof.filename);
            assert.equal(
              digest(new Uint8Array(await file.arrayBuffer())),
              proof.sha256,
            );
            token.sent = true;
          } else {
            assert.equal(url.pathname, "/v1/pages");
            assert(obj);
            const value = obj as {
              parent: { database_id: string };
              properties: {
                Key: { title: Array<{ text: { content: string } }> };
                Files: {
                  files: Array<{
                    type: string;
                    file_upload: { id: string };
                    name: string;
                  }>;
                };
              };
            };
            assert(primary.has(nid(value.parent.database_id)));
            assert.equal(
              value.properties.Key.title
                .map((part) => part.text.content)
                .join(""),
              proof.key,
            );
            assert.equal(value.properties.Files.files.length, 1);
            const attachment = value.properties.Files.files[0],
              token = uploads.get(nid(attachment.file_upload.id));
            assert(token?.sent);
            assert.equal(token.filename, attachment.name);
            assert(!attached.has(nid(attachment.file_upload.id)));
            attached.add(nid(attachment.file_upload.id));
            assert.equal(attachment.type, "file_upload");
            assert.equal(attachment.name, proof.filename);
            createdPage = true;
          }
        }
      } else {
        assert.equal(req.method, "GET");
        assert(hosted.has(req.url));
        assert.equal(url.protocol, "https:");
        assert(
          url.hostname.endsWith(".notion.so") ||
            url.hostname.endsWith(".notionso.com") ||
            [
              "prod-files-secure.s3.us-west-2.amazonaws.com",
              "s3.us-west-2.amazonaws.com",
            ].includes(url.hostname),
        );
        counts.hosted++;
        kind = "hosted_read";
      }
      counts.requests = sequence;
      durable(dir, `native-${sequence}-request.body`, bytes);
      durable(
        dir,
        `native-${sequence}-intent.json`,
        JSON.stringify({
          at: new Date().toISOString(),
          method: req.method,
          url: req.url,
          kind,
          bodySha256: digest(bytes),
          bytes: bytes.length,
          resend: 0,
        }),
      );
      check();
      const response = await native(req, {
          redirect: "error",
          signal: AbortSignal.any([req.signal, AbortSignal.timeout(60000)]),
        }),
        body = await bounded(
          response.body,
          32 * 1024 ** 2,
          `native-${sequence}-response`,
          true,
        );
      durable(dir, `native-${sequence}-response.body`, body);
      durable(
        dir,
        `native-${sequence}-response.json`,
        JSON.stringify({
          at: new Date().toISOString(),
          status: response.status,
          kind,
          sha256: digest(body),
          bytes: body.length,
        }),
      );
      assert.equal(response.status, 200);
      if (kind === "d1_read" || kind === "d1_batch") {
        const data = JSON.parse(body.toString()) as {
          success: boolean;
          result: Array<{
            success: boolean;
            meta: {
              rows_written: number;
              rows_read: number;
              changed_db: boolean;
            };
          }>;
        };
        assert.equal(data.success, true);
        for (const part of data.result) {
          assert.equal(part.success, true);
          assert(
            Number.isSafeInteger(part.meta.rows_read) &&
              part.meta.rows_read >= 0,
          );
          counts.d1RowsRead += part.meta.rows_read;
          if (kind === "d1_read") {
            assert.equal(part.meta.rows_written, 0);
            assert.equal(part.meta.changed_db, false);
          }
        }
        assert(counts.d1RowsRead <= 500000);
      }
      if (kind.startsWith("notion_")) {
        const data = JSON.parse(body.toString()) as {
          id: string;
          results?: Array<
            Omit<Page, "object"> & {
              object: string;
              title?: Array<{ plain_text: string }>;
            }
          >;
          object: string;
        };
        discover(data);
        if (url.pathname === "/v1/search")
          for (const row of data.results ?? []) {
            if (
              row.object === "database" &&
              row.title?.map((part) => part.plain_text).join("") ===
                "一次データ｜yuho-quant"
            )
              primary.add(nid(row.id));
          }
        if (archiveKey !== null && data.results !== undefined) {
          assert(data.results.length <= 1);
          for (const found of data.results) {
            assert.equal(found.object, "page");
            page(found as Page, found.id);
            if (nid(found.parent.database_id) === bodyDb)
              bodyPages.add(nid(found.id));
            else {
              assert(primary.has(nid(found.parent.database_id)));
              const item: SavedOverseasItem | undefined = cohort.items.find(
                (candidate) =>
                  archiveKey === candidate.docId ||
                  archiveKey === `${candidate.docId}:type1`,
              );
              assert(
                item,
                "new physical capsule key must be absent before creation",
              );
              const data = metadata(found as Page);
              assert.equal(data.docID, item.docId);
              assert.equal(data.edinetCode, item.edinetCode);
              if (nid(found.id) !== nid(item.archivePageId)) {
                assert.equal(data.edinetDocType, 1);
                assert.equal(
                  nid(String(data.sourceLegacyPageId)),
                  nid(item.archivePageId),
                );
              }
              pages.add(nid(found.id));
            }
          }
        }
        if (createdUpload) {
          assert.equal(data.object, "file_upload");
          assert(proof);
          assert(!uploads.has(nid(data.id)));
          assert(uploads.size < 2);
          uploads.set(nid(data.id), { filename: proof.filename, sent: false });
        }
        if (createdPage) {
          assert.equal(data.object, "page");
          pages.add(nid(data.id));
        }
      }
      return new Response(new Uint8Array(body), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      stopped = true;
      throw new NotionConfigError(
        `saved ${kind} finite STOP (${error instanceof Error ? error.name : typeof error}); no retry`,
      );
    }
  };
  return {
    counts,
    check,
    elapsed: () => (performance.now() - start) / 1000,
    restore: () => {
      globalThis.fetch = native;
    },
    batch: async (statements: D1BatchStatement[]) => {
      assert.equal(armedBatch, null);
      armedBatch = JSON.stringify(statements);
      try {
        await createD1HttpBatchSender()(statements);
      } finally {
        armedBatch = null;
      }
    },
    verifyArchives: async (capsulePath: string) => {
      assert.equal(options.mode, "inspect");
      assert.equal(
        capsulePath,
        join(dirname(capsulePath), "POST-capsule.json.gz"),
      );
      for (const phase of ["PRE", "POST"] as const) {
        const dir = dirname(capsulePath),
          bytes = readFileSync(join(dir, `${phase}-capsule.json.gz`)),
          receipt = JSON.parse(
            readFileSync(join(dir, `${phase}-archive-verified.json`), "utf8"),
          ) as { pageId: string; fileTooLarge: boolean; manifestMatch: string };
        assert.equal(receipt.fileTooLarge, false);
        assert(["written", "same"].includes(receipt.manifestMatch));
        id.parse(receipt.pageId);
        pages.add(nid(receipt.pageId));
        await verifyArchivedAttachments(
          receipt.pageId,
          [
            {
              bytes,
              filename: `${kind}-saved-${phase}.json.gz`,
            },
          ],
          `${kind}-saved-independent-${phase}`,
        );
      }
    },
    archive: async (phase: "PRE" | "POST", bytes: Buffer) => {
      assert.equal(proof, null);
      assert(bytes.length <= 20 * 1024 ** 2);
      const key = `${kind}-saved-cohort/${digest(readFileSync(options.cohortPath))}/${phase}/${digest(bytes)}`,
        filename = `${kind}-saved-${phase}.json.gz`;
      proof = { key, filename, sha256: digest(bytes) };
      durable(
        dir,
        `${phase}-archive-inflight.json`,
        JSON.stringify({
          key,
          sha256: digest(bytes),
          bytes: bytes.length,
          resend: 0,
        }),
      );
      try {
        const files = [{ bytes, filename, contentType: "application/gzip" }],
          receipt = await recordPrimaryData({
            service: "yuho-quant",
            key,
            source: `normal saved EDINET ${kind} backfill`,
            fetchedAt: new Date().toISOString(),
            metadata: {
              phase,
              cohortSha256: digest(readFileSync(options.cohortPath)),
              sha256: digest(bytes),
            },
            files,
            requireExistingDatabase: true,
          });
        assert.equal(receipt.fileTooLarge, false);
        assert.notEqual(receipt.manifestMatch, "unknown");
        await verifyArchivedAttachments(receipt.pageId, files, key);
        durable(dir, `${phase}-archive-verified.json`, JSON.stringify(receipt));
      } finally {
        proof = null;
      }
    },
  };
}

/** Existing local cohort state is mandatory; an empty replacement directory is never created here. */
function assertSavedStateDirectory(stateDir: string): void {
  assert.equal(realpathSync(stateDir), stateDir);
  const state = statSync(stateDir);
  assert(state.isDirectory());
  assert.equal(state.mode & 0o777, 0o700);
  assert.equal(state.uid, process.getuid!());
}
export function assertSavedClaimsAvailable(cohort: SourceCohort): string[] {
  assertSavedStateDirectory(cohort.stateDir);
  const paths = cohort.items.map((item) =>
    join(cohort.stateDir, `${item.docId}-${item.zipSha256}.apply-claim.json`),
  );
  for (const path of paths)
    assert(
      !existsSync(path),
      "existing saved overseas source claim: read-only reconcile; no new out/PRE bypass",
    );
  return paths;
}
export function reserveSavedClaims(
  cohort: SourceCohort,
  binding: { cohortSha256: string; preSha256: string; outDir: string },
): void {
  const paths = assertSavedClaimsAvailable(cohort);
  for (const [index, path] of paths.entries())
    durable(
      cohort.stateDir,
      path.slice(cohort.stateDir.length + 1),
      JSON.stringify({
        at: new Date().toISOString(),
        source: cohort.items[index],
        ...binding,
        resend: 0,
        singleUse: true,
      }),
    );
}

/** Unknown inflight records never authorize reentry. A new cohort requires its own finite command. */
export async function runSavedOverseas(
  options: SavedRunOptions,
  codeRoot: string,
): Promise<void> {
  return runSaved(options, codeRoot, "overseas");
}
export async function runSavedOrders(
  options: SavedRunOptions,
  codeRoot: string,
): Promise<void> {
  return runSaved(options, codeRoot, "orders");
}
async function runSaved(
  options: SavedRunOptions,
  codeRoot: string,
  kind: SavedKind,
): Promise<void> {
  assert(["prepare", "apply", "inspect"].includes(options.mode));
  assert.equal(resolve(options.outDir), options.outDir);
  assert.equal(existsSync(options.outDir), false);
  for (const value of [
    options.maxSeconds,
    options.maxHttp,
    options.maxNotion,
    options.maxD1,
    options.maxResponseBytes,
    options.maxRequestBytes,
  ])
    assert(Number.isSafeInteger(value) && value > 0);
  assert(
    options.maxSeconds <= 1800 &&
      options.maxSeconds > 65 &&
      options.maxHttp <= 1000 &&
      options.maxD1 <= 400 &&
      options.maxNotion <= 400,
  );
  assert(options.maxNotionRps > 0 && options.maxNotionRps <= 1.6);
  assert(
    options.maxResponseBytes <= 256 * 1024 ** 2 &&
      options.maxRequestBytes <= 64 * 1024 ** 2,
  );
  assert(
    Number.isFinite(Date.parse(options.notAfter)) &&
      Date.parse(options.notAfter) - Date.now() > 65000,
  );
  const bytes = readFileSync(options.cohortPath);
  assert.equal(digest(bytes), options.cohortSha256);
  const manifest =
    kind === "orders"
      ? savedOrdersCohortSchema.parse(JSON.parse(bytes.toString()))
      : savedCohortSchema.parse(JSON.parse(bytes.toString()));
  assert(
    Number.isSafeInteger(options.maxTargets) &&
      options.maxTargets > 0 &&
      options.maxTargets <= 20,
  );
  assert(
    options.afterCode === null || /^[0-9][0-9A-Z]{3}$/.test(options.afterCode),
  );
  const cohort: SavedCohort = {
    ...manifest,
    items: manifest.items
      .filter(
        (item) =>
          options.afterCode === null || item.stockCode > options.afterCode,
      )
      .slice(0, options.maxTargets),
  };
  assert(
    cohort.items.length > 0,
    "no target in the requested fixed-cohort window",
  );
  let ancestor: SavedCapsule | null = null;
  if (options.mode !== "prepare") {
    assert(options.capsulePath && options.capsuleSha256);
    const bytes = readFileSync(options.capsulePath);
    assert.equal(digest(bytes), options.capsuleSha256);
    ancestor = JSON.parse(gunzipSync(bytes).toString()) as SavedCapsule;
    assert.equal(ancestor.version, kind === "orders" ? 2 : 1);
    assert.equal(ancestor.kind, kind === "orders" ? "orders" : undefined);
    assert.equal(ancestor.cohortSha256, options.cohortSha256);
    same(
      ancestor.qualified.map((value) => value.item),
      cohort.items,
    );
  }
  assertSavedStateDirectory(cohort.stateDir);
  if (options.mode === "apply") assertSavedClaimsAvailable(cohort);
  mkdirSync(options.outDir, { mode: 0o700 });
  durable(
    options.outDir,
    "attempt-once.json",
    JSON.stringify({
      at: new Date().toISOString(),
      options,
      resend: 0,
      sourceAPI: 0,
      models: 0,
    }),
  );
  setNotionMaxRps(options.maxNotionRps);
  const io = installGuard(options, cohort, options.outDir, ancestor, kind);
  let phase = "fresh PRE";
  try {
    if (options.mode === "apply") {
      assert(options.capsuleSha256);
      reserveSavedClaims(cohort, {
        cohortSha256: options.cohortSha256,
        preSha256: options.capsuleSha256,
        outDir: options.outDir,
      });
    }
    if (options.mode === "prepare") {
      const capsule = await capture(
          codeRoot,
          cohort,
          options.cohortSha256,
          options.outDir,
          kind,
        ),
        bytes = gzipSync(JSON.stringify(capsule));
      durable(options.outDir, "PRE-capsule.json.gz", bytes);
      durable(
        options.outDir,
        "completed.json",
        JSON.stringify({
          status: `SAVED_${kind.toUpperCase()}_FRESH_PRE_QUALIFIED_NOT_APPLY_RELEASED`,
          capsuleSha256: digest(bytes),
          items: cohort.items.length,
          io: io.counts,
          seconds: io.elapsed(),
          sourceAPI: 0,
          models: 0,
          businessWrites: 0,
        }),
      );
      return;
    }
    assert(ancestor);
    same(await columns(), ancestor.schema);
    const current = await snapshot(cohort.items);
    same(current, ancestor.d1);
    await assertSources(current, ancestor, codeRoot);
    if (options.mode === "inspect") {
      assert(options.capsulePath);
      await io.verifyArchives(options.capsulePath);
      durable(
        options.outDir,
        "independent-POST-capsule.json.gz",
        gzipSync(
          JSON.stringify({
            ...ancestor,
            d1: current,
            verifiedAt: new Date().toISOString(),
          }),
        ),
      );
      durable(
        options.outDir,
        "completed.json",
        JSON.stringify({
          status: `SAVED_${kind.toUpperCase()}_INDEPENDENT_FULL_SIX_TABLE_SOURCE_BODY_POST_MATCH`,
          capsuleSha256: options.capsuleSha256,
          items: cohort.items.length,
          verifiedNextAfterCode: cohort.items.at(-1)!.stockCode,
          io: io.counts,
          seconds: io.elapsed(),
          sourceAPI: 0,
          models: 0,
          businessWrites: 0,
        }),
      );
      return;
    }
    const runStartedSec = Math.floor(Date.now() / 1000),
      prepared = [];
    for (const value of ancestor.qualified) {
      const built =
        kind === "orders"
          ? await buildOrdersAtomicWithCommonProjection(
              codeRoot,
              current,
              targetOf(value),
              value.extraction as OrderExtraction,
              runStartedSec,
            )
          : await buildAtomicWithCommonProjection(
              codeRoot,
              current,
              targetOf(value),
              value.extraction as OverseasExtraction,
              runStartedSec,
            );
      prepared.push({
        value,
        built,
        noop:
          JSON.stringify(
            canonicalizeForHash(
              savedBusinessView(subset(current, value.item), kind),
            ),
          ) ===
          JSON.stringify(
            canonicalizeForHash(savedBusinessView(built.expected, kind)),
          ),
      });
    }
    const pre = gzipSync(
      JSON.stringify({ ...ancestor, d1: current, runStartedSec }),
    );
    durable(options.outDir, "PRE-capsule.json.gz", pre);
    phase = "physical PRE";
    await io.archive("PRE", pre);
    for (const { value, built, noop } of prepared) {
      phase = `apply ${value.item.stockCode}`;
      io.check();
      const before = await snapshot([value.item]);
      same(before, subset(current, value.item));
      await assertSources(
        before,
        { ...ancestor, d1: before, qualified: [value] },
        codeRoot,
      );
      if (!noop) {
        durable(
          options.outDir,
          `${value.item.stockCode}-inflight.json`,
          JSON.stringify({
            at: new Date().toISOString(),
            target: value.item,
            sourceSha256: value.zipSha256,
            preSha256: digest(pre),
            statements: built.statements,
            resend: 0,
          }),
        );
        await io.batch(built.statements);
      }
      const after = await snapshot([value.item]);
      assertTargetPost(
        after,
        noop ? before : built.expected,
        targetOf(value),
        kind,
      );
      durable(
        options.outDir,
        `${value.item.stockCode}-verified.json`,
        JSON.stringify({
          at: new Date().toISOString(),
          target: value.item,
          d1: after,
          noop,
          resend: 0,
        }),
      );
    }
    phase = "full POST";
    const final = await snapshot(cohort.items);
    for (const { value, built, noop } of prepared)
      assertTargetPost(
        subset(final, value.item),
        noop ? subset(current, value.item) : built.expected,
        targetOf(value),
        kind,
      );
    await assertSources(final, ancestor, codeRoot);
    const post = gzipSync(
      JSON.stringify({
        ...ancestor,
        d1: final,
        physicalPreSha256: digest(pre),
        verifiedAt: new Date().toISOString(),
      }),
    );
    durable(options.outDir, "POST-capsule.json.gz", post);
    phase = "physical POST";
    await io.archive("POST", post);
    durable(
      options.outDir,
      "completed.json",
      JSON.stringify({
        status: `SAVED_${kind.toUpperCase()}_NORMAL_ATOMIC_SIX_TABLE_AND_PHYSICAL_FULL_POST_VERIFIED`,
        items: cohort.items.length,
        advanceRequiresIndependentInspect: true,
        proposedNextAfterCode: cohort.items.at(-1)!.stockCode,
        preSha256: digest(pre),
        postSha256: digest(post),
        io: io.counts,
        seconds: io.elapsed(),
        sourceAPI: 0,
        models: 0,
        rawSourceUploads: 0,
        supplementWrites: 0,
        resend: 0,
      }),
    );
  } catch (error) {
    durable(
      options.outDir,
      "STOP.json",
      JSON.stringify({
        at: new Date().toISOString(),
        phase,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessageSha256: digest(
          error instanceof Error ? error.message : String(error),
        ),
        io: io.counts,
        seconds: io.elapsed(),
        resend: 0,
        outcomeUnknownMustReconcileReadonly: true,
      }),
    );
    throw error;
  } finally {
    io.restore();
  }
}

export function parseSavedOverseasOptions(
  args: readonly string[],
): SavedRunOptions | null {
  if (
    !args.some(
      (arg) => arg.startsWith("--saved-") || arg.startsWith("--cohort-sha256"),
    )
  )
    return null;
  const values = new Map<string, string>();
  for (const arg of args) {
    const match = arg.match(/^--([a-z0-9-]+)=(.+)$/);
    assert(match, "saved cohort only accepts explicit named arguments");
    assert(!values.has(match[1]));
    values.set(match[1], match[2]);
  }
  const required = (name: string) => {
      const value = values.get(name);
      assert(value !== undefined, `missing --${name}`);
      values.delete(name);
      return value;
    },
    numeric = (name: string) => {
      const raw = required(name);
      assert(/^\d+(?:\.\d+)?$/.test(raw));
      return Number(raw);
    };
  const mode = required("saved-mode");
  assert(mode === "prepare" || mode === "apply" || mode === "inspect");
  const after = required("after-code");
  const afterCode = after === "START" ? null : after;
  const maxTargets = numeric("max-targets");
  const options: SavedRunOptions = {
    mode,
    afterCode,
    maxTargets,
    cohortPath: resolve(required("saved-cohort")),
    cohortSha256: required("cohort-sha256"),
    outDir: resolve(required("out")),
    maxSeconds: numeric("max-seconds"),
    maxNotionRps: numeric("max-notion-rps"),
    maxHttp: numeric("max-http"),
    maxNotion: numeric("max-notion"),
    maxD1: numeric("max-d1"),
    maxResponseBytes: numeric("max-response-bytes"),
    maxRequestBytes: numeric("max-request-bytes"),
    notAfter: required("not-after"),
  };
  if (mode !== "prepare") {
    options.capsulePath = resolve(required("capsule"));
    options.capsuleSha256 = required("capsule-sha256");
  }
  assert.equal(
    values.size,
    0,
    "unknown/ordinary --force/--limit flags are not accepted in saved mode",
  );
  return options;
}
