/** Bounded financial③ capture only. No raw fetch, source discovery, writer or model. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "dotenv";
import { notionRequest } from "../../src/shared/notion-archive/client.js";
import { parseStockCode } from "../../src/shared/jpx/stock-code.js";
import { installReadOnlyAuditGuard } from "../../services/yuho-quant/data-scripts/audit-supplement-texts.js";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const nid = (value: string) => value.replaceAll("-", "").toLowerCase();
function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "object_required");
  return value as Record<string, unknown>;
}
export interface FinancialField { field: string; name: string; type: string; schemaStatus?: string }
export interface FinancialContract { databaseId: string; rawDatabaseId: string; fields: FinancialField[] }
export interface FinancialCaptureOptions {
  codes: string[]; codesSha256: string; offset: number; maxCodes: number;
  maxPages: number; maxHttp: number; deadline: string; out: string;
}
interface SavedPage { code: string; file: string; sha256: string; rowCount: number; hasMore: boolean; nextCursor: string | null }
interface Partition { code: string; status: "unstarted" | "reading" | "partial" | "complete" | "stopped"; pages: number; rows: number; nextCursor: string | null }

/** Mapping comes from the Python financial schema; unknown/missing types remain explicit. */
export function projectFinancialPage(value: unknown, fields: FinancialField[]) {
  const page = object(value), props = object(page.properties);
  const cells = Object.fromEntries(fields.map(field => {
    if (field.schemaStatus !== undefined && field.schemaStatus !== "known")
      return [field.field, { status: "unknown", reason: field.schemaStatus }];
    const prop = props[field.name];
    if (prop === undefined) return [field.field, { status: "unknown", reason: "missing_property" }];
    const p = object(prop), v = p[field.type];
    if (p.type !== field.type || !Object.hasOwn(p, field.type))
      return [field.field, { status: "unknown", reason: "property_type_mismatch", observed: prop }];
    if (field.type === "number") return [field.field, v === null ? { status: "null", value: null } :
      typeof v === "number" && Number.isFinite(v) ? { status: "value", value: v } : { status: "unknown", reason: "number_shape", observed: v }];
    return [field.field, { status: "observed", value: v, hasMore: p.has_more }];
  }));
  const metrics = fields.filter(field => field.type === "number");
  return { pageId: page.id, lastEditedTime: page.last_edited_time, cells,
    metricOrder: metrics.map(field => field.field),
    nullBitmap: metrics.map(field => cells[field.field].status === "null" ? "1" : cells[field.field].status === "value" ? "0" : "?").join(""),
    reasons: "not_inferred", canonicalUniqueness: "not_checked" };
}

/** Every page and failed/incomplete response is preserved before the shared strict parser. */
export async function captureFinancials(options: FinancialCaptureOptions, contract: FinancialContract) {
  assert(options.codes.length > 0 && new Set(options.codes).size === options.codes.length);
  assert(options.codes.every(code => parseStockCode(code) === code));
  assert(/^[a-f0-9]{64}$/.test(options.codesSha256));
  assert(Number.isSafeInteger(options.offset) && options.offset >= 0 && options.offset < options.codes.length);
  assert([options.maxCodes, options.maxPages, options.maxHttp].every(n => Number.isSafeInteger(n) && n > 0));
  const deadline = Date.parse(options.deadline);
  assert(new Date(deadline).toISOString() === options.deadline && deadline > Date.now(), "absolute_deadline_required");
  assert(contract.fields.length === 31 && contract.fields.filter(f => f.type === "number").length === 19);
  assert(/^[a-f0-9-]{32,36}$/i.test(contract.databaseId) && /^[a-f0-9-]{32,36}$/i.test(contract.rawDatabaseId));
  await fs.mkdir(options.out, { mode: 0o700 });
  const save = async (file: string, bytes: Uint8Array | string) => {
    const fd = await fs.open(path.join(options.out, file), "wx", 0o600);
    try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
  };
  const json = (file: string, value: unknown) => save(file, JSON.stringify(value, null, 2) + "\n");
  const selected = options.codes.slice(options.offset, options.offset + options.maxCodes);
  const partitions: Partition[] = selected.map(code => ({ code, status: "unstarted", pages: 0, rows: 0, nextCursor: null }));
  const pages: SavedPage[] = [], seenPages = new Set<string>(), startedAt = new Date().toISOString();
  const guard = installReadOnlyAuditGuard(options.maxHttp, deadline), guardedFetch = globalThis.fetch;
  let allowedPath: string | null = null, method: "GET" | "POST" | null = null, sequence = 0;
  let status: string, stopReason: string, current: Partition | undefined;
  const canStart = () => guard.count() < options.maxHttp && Date.now() < deadline;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request === null ? String(input) : request.url);
    assert(url.origin === "https://api.notion.com" && url.pathname + url.search === "/v1" + allowedPath);
    assert((init?.method ?? request?.method ?? "GET").toUpperCase() === method && canStart(), "finite_read_admission");
    const label = `http-${String(++sequence).padStart(4, "0")}`, requestStartedAt = new Date().toISOString();
    await json(`${label}.intent.json`, { method, path: allowedPath, requestStartedAt });
    let response: Response;
    try { response = await guardedFetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(Math.min(60_000, deadline - Date.now())) }); }
    catch (error) {
      await json(`${label}.receipt.json`, { requestStartedAt, receivedAt: new Date().toISOString(), responseObserved: false, complete: false });
      throw error;
    }
    const chunks: Uint8Array[] = []; let complete = false, count = 0;
    try {
      const reader = response.clone().body?.getReader();
      assert(reader !== undefined, "response_body_missing");
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) { complete = true; break; }
          count += next.value.length; assert(count <= 8 * 1024 ** 2, "response_byte_limit"); chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
    } finally {
      const bytes = Buffer.concat(chunks);
      await save(`${label}.response.json`, bytes);
      await json(`${label}.receipt.json`, { requestStartedAt, receivedAt: new Date().toISOString(), status: response.status,
        bytes: bytes.length, receivedBytes: count, sha256: hash(bytes), complete });
    }
    return response;
  };
  const query = async (m: "GET" | "POST", p: string, body?: unknown) => {
    method = m; allowedPath = p;
    try { return await notionRequest<unknown>(m, p, body, { singleAttempt: true, beforeRequest: () => assert(Date.now() < deadline) }); }
    finally { method = null; allowedPath = null; }
  };
  try {
    await json("intent.json", { kind: "financial-null-capture-v1", ...options, ...contract, startedAt,
      sort: [{ timestamp: "last_edited_time", direction: "descending" }], pageSize: 100, retry: 0, writes: 0, sourceApi: 0, model: 0 });
    const schema = object(await query("GET", `/databases/${contract.databaseId}`));
    assert(schema.object === "database" && typeof schema.id === "string" && nid(schema.id) === nid(contract.databaseId));
    assert(schema.archived === false && schema.in_trash !== true);
    const props = object(schema.properties);
    const projected = contract.fields.map(field => {
      const prop = props[field.name] === undefined ? null : object(props[field.name]);
      return { ...field, propertyId: prop !== null && typeof prop.id === "string" ? prop.id : null,
        schemaStatus: prop === null ? "unknown_missing" : prop.type === field.type ? "known" : "unknown_type" };
    });
    const codeProperty = projected.find(p => p.field === "code");
    assert(codeProperty?.schemaStatus === "known" && codeProperty.propertyId !== null, "code_schema_unknown");
    await json("schema.json", { databaseId: contract.databaseId, fields: projected,
      unmappedNumericProperties: Object.entries(props).filter(([name, p]) => object(p).type === "number" &&
        !contract.fields.some(field => field.name === name)).map(([name]) => ({ name, status: "unknown_metric" })) });
    const projection = projected.filter(p => p.propertyId !== null).map(p => `filter_properties=${encodeURIComponent(p.propertyId!)}`).join("&");
    const url = `/databases/${contract.databaseId}/query?${projection}`;
    for (const partition of partitions) {
      if (!canStart()) break;
      current = partition; partition.status = "reading";
      const seenCursors = new Set<string>();
      for (let n = 0; n < options.maxPages; n++) {
        if (!canStart()) { partition.status = "partial"; break; }
        const response = object(await query("POST", url, { page_size: 100,
          filter: { property: codeProperty.propertyId, rich_text: { equals: partition.code } },
          sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
          ...(partition.nextCursor === null ? {} : { start_cursor: partition.nextCursor }) }));
        // The existing reader has already rejected explicit incomplete/unknown markers.
        assert(Array.isArray(response.results) && response.results.length <= 100);
        assert(typeof response.has_more === "boolean");
        const cursor = response.next_cursor;
        assert(response.has_more ? typeof cursor === "string" && cursor.trim().length > 0 : cursor === null);
        const projectedRows = response.results.map(value => {
          const page = object(value), parent = object(page.parent), properties = object(page.properties);
          assert(page.object === "page" && typeof page.id === "string" && !seenPages.has(nid(page.id)));
          assert(page.archived === false && page.in_trash !== true && parent.type === "database_id" && typeof parent.database_id === "string" && nid(parent.database_id) === nid(contract.databaseId));
          const code = object(properties[codeProperty.name]); assert(code.type === "rich_text" && Array.isArray(code.rich_text));
          assert(code.rich_text.map(t => object(t).plain_text).join("") === partition.code, "scope_mismatch");
          seenPages.add(nid(page.id)); return projectFinancialPage(page, projected);
        });
        if (typeof cursor === "string") { assert(!seenCursors.has(cursor), "cursor_repeated"); seenCursors.add(cursor); }
        const file = `http-${String(sequence).padStart(4, "0")}.response.json`;
        pages.push({ code: partition.code, file, sha256: hash(await fs.readFile(path.join(options.out, file))), rowCount: projectedRows.length,
          hasMore: response.has_more, nextCursor: cursor as string | null });
        await json(`${partition.code}-page-${n + 1}.projection.json`, projectedRows);
        partition.pages++; partition.rows += projectedRows.length; partition.nextCursor = cursor as string | null;
        if (!response.has_more) { partition.status = "complete"; break; }
        partition.status = "partial";
      }
    }
    status = partitions.every(p => p.status === "complete") ? "complete" : "partial";
    stopReason = status === "complete" ? "selected_code_partitions_natural_end" : "finite_budget_or_page_limit";
  } catch (error) {
    status = "stopped"; stopReason = "unknown_incomplete_or_failed_read";
    if (current !== undefined) current.status = "stopped";
    await json("stop.json", { errorClass: error instanceof Error ? error.name : "unknown", messageSha256: hash(String(error)), retry: 0 });
  } finally { globalThis.fetch = guardedFetch; guard.restore(); }
  const result = { kind: "financial-null-capture-v1", version: 1, status, stopReason, databaseId: contract.databaseId,
    rawDatabaseId: contract.rawDatabaseId, fields: contract.fields, codesSha256: options.codesSha256, cohortCodes: options.codes,
    offset: options.offset, selectedCodes: selected, partitions, pages, startedAt, finishedAt: new Date().toISOString(),
    requests: guard.count(), acceptedRows: pages.reduce((n, p) => n + p.rowCount, 0),
    unstartedSelectedCodes: partitions.filter(p => p.status === "unstarted").map(p => p.code),
    codesOutsideThisRun: [...options.codes.slice(0, options.offset), ...options.codes.slice(options.offset + selected.length)],
    allHistoryClassified: false, cohortFullyObservedThisRun: status === "complete" && selected.length === options.codes.length,
    observation: "sequential_not_atomic", nullReasons: "not_inferred", retry: 0, sourceApi: 0, writes: 0, model: 0 };
  await json("capture.json", result); return result;
}

async function main() {
  const required = ["codes", "codes-sha256", "offset", "max-codes", "max-pages", "max-http", "deadline", "out", "env-file", "python"];
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    assert(match && required.includes(match[1]!) && !args.has(match[1]!), "explicit_arguments_required"); args.set(match[1]!, match[2]!);
  }
  assert(required.every(key => args.has(key)));
  const envFile = await fs.realpath(args.get("env-file")!), stat = await fs.stat(envFile);
  assert((stat.mode & 0o077) === 0 && stat.uid === process.getuid!(), "private_canonical_env_required");
  assert(config({ path: envFile, override: true, quiet: true }).error === undefined);
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const contract = JSON.parse(execFileSync(path.resolve(args.get("python")!), ["-c", `
import json
from jp_stock_pipeline.config import load_settings
from jp_stock_pipeline.notion import schema as S
from jp_stock_pipeline.notion.upsert import _FIN_FIELD_TO_PROP
s=load_settings()
fields=[dict(field=k,name=v,type='number') for k,v in _FIN_FIELD_TO_PROP.items()]
extra=[('code',S.FIN_PROP_CODE,'rich_text'),('fiscal_period_end',S.FIN_PROP_PERIOD_END,'date'),('disclosure_type',S.FIN_PROP_DISCLOSURE_TYPE,'select'),('consolidated',S.FIN_PROP_CONSOLIDATED,'select'),('source',S.PROP_SOURCE,'select'),('raw_relation',S.PROP_RAW_RELATION,'relation'),('accounting_standard',S.FIN_PROP_STANDARD,'select'),('disclosed_at',S.FIN_PROP_DISCLOSED_AT,'date'),('license_tag',S.PROP_LICENSE_TAG,'select'),('data_date',S.PROP_DATA_DATE,'date'),('fetched_at',S.PROP_FETCHED_AT,'date'),('quality',S.PROP_QUALITY,'select')]
fields += [dict(field=k,name=v,type=t) for k,v,t in extra]
print(json.dumps(dict(databaseId=s.db_id('financials'),rawDatabaseId=s.db_id('raw_files'),fields=fields)))
`], { env: { ...process.env, PYTHONPATH: path.join(root, "pipeline/src"), PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as FinancialContract;
  const codeFile = args.get("codes")!, codeStat = await fs.stat(codeFile);
  assert(codeStat.isFile() && codeStat.size <= 2 * 1024 ** 2, "codes_file_byte_limit");
  const bytes = await fs.readFile(codeFile); assert(bytes.length === codeStat.size && hash(bytes) === args.get("codes-sha256"), "codes_full_sha_required");
  const codes: unknown = JSON.parse(bytes.toString("utf8")); assert(Array.isArray(codes) && codes.every(code => typeof code === "string"));
  const result = await captureFinancials({ codes: codes as string[], codesSha256: hash(bytes), offset: Number(args.get("offset")), maxCodes: Number(args.get("max-codes")),
    maxPages: Number(args.get("max-pages")), maxHttp: Number(args.get("max-http")), deadline: args.get("deadline")!, out: path.resolve(args.get("out")!) }, contract);
  console.info(JSON.stringify({ status: result.status, rows: result.acceptedRows, requests: result.requests, completePartitions: result.partitions.filter(p => p.status === "complete").length,
    unstartedSelected: result.unstartedSelectedCodes.length, codesOutsideThisRun: result.codesOutsideThisRun.length, writes: 0, sourceApi: 0, model: 0 }));
  if (result.status !== "complete") process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(() => { console.error("[financial-null] STOP; inspect private receipts, no retry"); process.exitCode = 1; });
