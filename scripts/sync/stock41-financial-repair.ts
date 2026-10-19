/** Fixed 41 saved normal 5y + same-run QuoteSummary replay. Never fetches Yahoo. */
import "dotenv/config";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { getTableColumns, getTableName } from "drizzle-orm";
import { buildStockSnapshot, buildStockSnapshotStatements, createDailyDb, loadJssAnnualMap } from "../../src/cron/daily.js";
import * as core from "../../src/shared/db/core-schema.js";
import * as rsi from "../../services/rsi-screening/src/db/schema.js";
import * as swing from "../../services/swing-trading/src/db/schema.js";
import * as projection from "../../src/shared/db/projection-schema.js";
import { assertD1SingleQueryResponse, createD1HttpBatchSender, d1HttpQueryUrl, type D1BatchStatement } from "../../src/shared/db/d1-http-client.js";
import type { JssAnnualRow } from "../../src/shared/db/jss-financials.js";
import { sharedEnv } from "../../src/shared/env.js";
import { findUniqueBackupChildByTitle, queryUniqueRow } from "../../src/shared/notion-archive/archive.js";
import { recordPrimaryData, verifyArchivedAttachments } from "../../src/shared/notion-archive/index.js";
import { notionEnv } from "../../src/shared/notion-archive/env.js";
import { MAX_YAHOO_RAW_BYTES, parseSavedStockRawData, type SavedYahooRawCapture } from "../../src/shared/yahoo/client.js";
import { STOCK41_CODES, STOCK41_DATE } from "./stock41-price-repair.js";

export const STOCK41_CAPTURE_RESULT_SHA = "7748d4be06527db4b2a9fd3a44f3f2f3dc95c3f2446a913e1e725ffb3e88bcae";
const ACCEPTANCE_SHA = "7b5b105b6356b2e4aaf2562ee9b5d5cf3da5a98c868c5e6647d7b92122238108";
const ARCHIVES = [
  ["pilot3-archive.json", "c010aa25efd15f4891424cf62acaddce0b92f0ecff597a691e4a88222e72a166"],
  ["remaining38-archive.json", "a4cd31d2aea648a2709a07436fb84c1c427dde4c9961e521028c7afc1113a484"],
] as const;
const LATCH = ".stock41-financial-repair-20261016";
const RECEIPT_KEY = "stock41-normal5y-financial-repair-20261016-v1";
// Same checkout scope: changing sourceDir/out/cwd cannot bypass an unknown operation.
export const STOCK41_FINANCIAL_STATE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../tmp/stock-gap-repair");
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
type Value = string | number | null;
export type RepairRow = Record<string, Value>;
const tables = [core.stockFinancials, rsi.stockRsiPercentile, swing.stockIndicators, projection.momentumProjection, swing.entrySignals];
const columns = new Map<string, string[]>(tables.map(table => [getTableName(table), Object.values(getTableColumns(table)).map(column => column.name)]));
const identityColumns = ["id", "code", "sector", "is_active", "instrument_type"];
const ohlcvColumns = Object.values(getTableColumns(swing.dailyOhlcv)).map(column => column.name);
const annualColumns = ["fiscalPeriodEnd", "consolidated", "revenue"];
const driverDb = () => createDailyDb();
type Replay = ReturnType<typeof buildStockSnapshotStatements>;
export interface FinancialSource {
  code: string;
  raw: Awaited<ReturnType<typeof parseSavedStockRawData>>;
  chart: SavedYahooRawCapture;
  custody: Array<{ pageId: string; filename: string; gzipSha256: string }>;
}
export interface FinancialPre {
  identity: RepairRow;
  tables: Record<string, RepairRow[]>;
  ohlcv: RepairRow[];
  ohlcvMax: string | null;
  annual: JssAnnualRow[];
}
export interface FinancialIo {
  annual: () => Promise<Map<string, JssAnnualRow[]>>;
  read: (code: string) => Promise<FinancialPre>;
  compile: (snapshot: Parameters<typeof buildStockSnapshotStatements>[1], runStartedSec: number) => Replay;
  send: (statements: readonly D1BatchStatement[]) => Promise<void>;
  probeReceiptAbsent: () => Promise<void>;
  recordReceipt: (bytes: Uint8Array) => Promise<void>;
}

function pinnedJson(path: string, expected: string) {
  assert.ok(statSync(path).size <= 1024 ** 2, "source metadata byte cap");
  const bytes = readFileSync(path); assert.equal(sha(bytes), expected, "saved source pin mismatch");
  return JSON.parse(bytes.toString("utf8"));
}
/** Exactly the already physically archived 82 original responses; no downloads or old Quote mixing. */
export async function loadStock41FinancialSources(sourceDir: string, proxyBase: string): Promise<FinancialSource[]> {
  const result = pinnedJson(join(sourceDir, "result.json"), STOCK41_CAPTURE_RESULT_SHA);
  const acceptance = pinnedJson(join(sourceDir, "delegate-saved-acceptance-v1.json"), ACCEPTANCE_SHA);
  assert.equal(result.status, "ALL41_NORMAL5Y_AND_SAME_RUN_QUOTE_SOURCE_QUALIFIED");
  assert.equal(acceptance.status, "INDEPENDENT_SAVED_CAPTURE_V2_ACCEPTED");
  assert.equal(result.qualifiedAll41, true); assert.deepEqual(result.rows.map((row: { code: string }) => row.code), [...STOCK41_CODES]);
  const parts = ARCHIVES.flatMap(([name, hash]) => pinnedJson(join(sourceDir, name), hash).archives);
  assert.equal(parts.length, 2); assert.equal(parts.flatMap(part => part.members).length, 82);
  for (const part of parts) {
    const path = join(sourceDir, ".yahoo-raw-custody", part.filename);
    assert.match(part.filename, /^yahoo-raw-stock41-normal5y-20261018-capture2-(?:pilot3|remaining38)-part-0\.json\.gz$/);
    assert.ok(Number.isSafeInteger(part.gzipBytes) && part.gzipBytes > 0 && part.gzipBytes <= 20 * 1024 ** 2);
    assert.equal(statSync(path).size, part.gzipBytes); const gzip = readFileSync(path); assert.equal(sha(gzip), part.gzipSha256);
    const wrapper = JSON.parse(gunzipSync(gzip, { maxOutputLength: 32 * 1024 ** 2 }).toString("utf8"));
    assert.equal(wrapper.service, "stock-sync"); assert.equal(wrapper.runId, "stock41-normal5y-20261018-capture2"); assert.equal(wrapper.expectedDate, STOCK41_DATE);
    assert.equal(wrapper.members.length, part.members.length);
    for (const [index, member] of wrapper.members.entries()) {
      const pin = part.members[index], body = Buffer.from(member.bodyBase64, "base64");
      for (const key of ["api", "symbol", "attempt", "status", "receivedAt", "byteLength", "sha256"]) assert.equal(member[key], pin[key]);
      assert.equal(body.length, pin.byteLength); assert.equal(sha(body), pin.sha256);
      const path = join(sourceDir, "captured-source", `${pin.symbol}-${pin.api}.json`); assert.ok(statSync(path).size <= 16 * 1024);
      const meta = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(meta.url, member.url); assert.deepEqual(meta.headers, member.headers);
    }
  }
  assert.ok(parts.flatMap(part => part.members).reduce((sum, member) => sum + member.byteLength, 0) <= 64 * 1024 ** 2);
  return Promise.all(STOCK41_CODES.map(async code => {
    const custody: FinancialSource["custody"] = [];
    const saved = (api: string): SavedYahooRawCapture => {
      const matches = parts.flatMap(part => part.members.filter((member: { api: string; symbol: string }) => member.api === api && member.symbol === code).map((member: object) => ({ part, member })));
      assert.equal(matches.length, 1); const { part, member } = matches[0];
      const meta = JSON.parse(readFileSync(join(sourceDir, "captured-source", `${code}-${api}.json`), "utf8"));
      assert.ok(Number.isSafeInteger(member.byteLength) && member.byteLength > 0 && member.byteLength <= MAX_YAHOO_RAW_BYTES);
      const bodyPath = join(sourceDir, "captured-source", `${code}-${api}.body`); assert.equal(statSync(bodyPath).size, member.byteLength);
      const bytes = readFileSync(bodyPath);
      assert.equal(meta.symbol, code); assert.equal(meta.status, 200); assert.equal(meta.status, member.status);
      assert.equal(meta.receivedAt, member.receivedAt); assert.equal(meta.byteLength, member.byteLength);
      assert.equal(meta.bodySHA, member.sha256); assert.equal(bytes.length, member.byteLength); assert.equal(sha(bytes), member.sha256);
      assert.ok(bytes.length > 0 && bytes.length <= MAX_YAHOO_RAW_BYTES);
      assert.ok(meta.receivedAt >= result.startedAt && meta.receivedAt <= result.at && meta.receivedAt.startsWith("2026-10-18T"));
      custody.push({ pageId: part.archivePageId, filename: part.filename, gzipSha256: part.gzipSha256 });
      return { capture: { ...meta, bytes }, expectedSha256: member.sha256, expectedByteLength: member.byteLength };
    };
    const chart = saved("chart"), summary = saved("quote-summary");
    const raw = await parseSavedStockRawData(code, { chart, summary }, { proxyBase });
    assert.equal(raw.rsiHistoryHold, undefined, "5y RSI history remains held");
    return { code, raw, chart, custody };
  }));
}

function ident(name: string): string { assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/); return `"${name}"`; }
function exactRows(actual: string, names: readonly string[], expected: readonly object[], params: D1BatchStatement["params"]): D1BatchStatement {
  const exp = names.map(name => `json_extract(value, '$.${name}') AS ${ident(name)}`).join(",");
  return { sql: `WITH expected AS (SELECT ${exp} FROM json_each(?)), actual AS (${actual}) SELECT json(CASE WHEN (SELECT COUNT(*) FROM expected)=(SELECT COUNT(*) FROM actual) AND NOT EXISTS(SELECT * FROM expected EXCEPT SELECT * FROM actual) AND NOT EXISTS(SELECT * FROM actual EXCEPT SELECT * FROM expected) THEN 'null' ELSE '' END)`, params: [JSON.stringify(expected), ...params] };
}
/** Fixed-schema full row-set CAS, including absent rows, clocks and every old signal. */
export function stock41FinancialPreflight(pre: FinancialPre): D1BatchStatement[] {
  const id = pre.identity.id; assert.equal(typeof id, "number");
  const guards = [exactRows(`SELECT ${identityColumns.map(ident)} FROM core_stocks WHERE id=?`, identityColumns, [pre.identity], [id])];
  for (const [table, names] of columns) guards.push(exactRows(`SELECT ${names.map(ident)} FROM ${ident(table)} WHERE stock_id=?`, names, pre.tables[table], [id]));
  guards.push(exactRows(`SELECT ${ohlcvColumns.map(ident)} FROM swing_daily_ohlcv WHERE stock_id=? AND date=?`, ohlcvColumns, pre.ohlcv, [id, STOCK41_DATE]));
  guards.push({ sql: "SELECT json(CASE WHEN MAX(date) IS ? THEN 'null' ELSE '' END) FROM swing_daily_ohlcv WHERE stock_id=?", params: [pre.ohlcvMax, id] });
  guards.push(exactRows("SELECT fiscal_period_end AS fiscalPeriodEnd,consolidated,net_sales AS revenue FROM jss_financials WHERE code=? AND disclosure_type='本決算' AND license_tag='commercial-ok' AND fiscal_period_end<=?", annualColumns, pre.annual, [pre.identity.code, STOCK41_DATE]));
  return guards;
}
function sortedRows(rows: readonly object[]) { return rows.map(row => JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))).sort(); }
function sameRows(actual: readonly object[], expected: readonly object[]) { assert.deepEqual(sortedRows(actual), sortedRows(expected), "full row-set mismatch"); }
function checkOhlcv(pre: FinancialPre, source: FinancialSource): boolean {
  assert.ok(pre.ohlcvMax === null || typeof pre.ohlcvMax === "string" && /^\d{4}-\d{2}-\d{2}$/.test(pre.ohlcvMax), "malformed OHLCV max date");
  assert.ok(Array.isArray(pre.ohlcv) && pre.ohlcv.length <= 1, "malformed OHLCV cardinality");
  for (const row of pre.ohlcv) {
    assert.ok(Number.isSafeInteger(row.id) && Number(row.id) > 0 && row.stock_id === pre.identity.id, "malformed OHLCV identity");
    assert.ok(typeof row.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.date), "malformed OHLCV date");
    for (const key of ["open", "high", "low", "close", "volume", "adj"]) assert.ok(row[key] === null || typeof row[key] === "number" && Number.isFinite(row[key]), "malformed OHLCV numeric value");
  }
  const bar = source.raw.ohlcv.at(-1); assert.ok(bar); assert.equal(bar.date, STOCK41_DATE);
  return pre.identity.is_active === 1 && pre.identity.instrument_type === "equity" && pre.ohlcvMax === STOCK41_DATE && pre.ohlcv.length === 1 &&
    (["date", "open", "high", "low", "close", "volume", "adj"] as const).every(key => pre.ohlcv[0][key] === bar[key]);
}
function assertReplay(replay: Replay, stockId: number): void {
  assert.ok(replay.statements.length >= 4);
  for (const statement of replay.statements) {
    assert.ok(statement.params.length <= 100);
    assert.match(statement.sql, /^insert into "(?:core_stock_financials|rsi_percentile|swing_stock_indicators|p_momentum|swing_entry_signals)" /i);
  }
  const expectedTables = [...columns.keys()].filter(name => name !== "swing_entry_signals");
  if (replay.expectedRows.some(value => value.table === "swing_entry_signals")) expectedTables.push("swing_entry_signals");
  assert.deepEqual(replay.expectedRows.map(value => value.table).sort(), expectedTables.sort());
  for (const { table, rows } of replay.expectedRows) {
    const names = columns.get(table); assert.ok(names);
    if (table !== "swing_entry_signals") assert.equal(rows.length, 1, "snapshot must be exactly one row before writing");
    const server = table === "core_stock_financials" ? "fetched_at" : table === "rsi_percentile" || table === "swing_stock_indicators" ? "computed_at" : table === "swing_entry_signals" ? "id" : undefined;
    for (const row of rows) { assert.equal(row.stock_id, stockId, "replay foreign stock_id"); assert.deepEqual(Object.keys(row).sort(), names.filter(name => name !== server).sort(), "new row defaults must be explicitly qualified before writing"); }
  }
}
function checkPost(pre: FinancialPre, post: FinancialPre, replay: Replay, began: number, ended: number): void {
  assert.deepEqual(post.identity, pre.identity); sameRows(post.ohlcv, pre.ohlcv); assert.equal(post.ohlcvMax, pre.ohlcvMax); sameRows(post.annual, pre.annual);
  for (const [table, names] of columns) {
    const expected = replay.expectedRows.find(value => value.table === table)?.rows;
    const rows = post.tables[table];
    if (table === "swing_entry_signals") {
      assert.ok(rows.every(row => Number.isSafeInteger(row.id) && Number(row.id) > 0)); assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
      sameRows(rows.map(({ id: _id, ...row }) => row), expected === undefined ? [] : expected); continue;
    }
    assert.ok(expected && expected.length === 1); assert.equal(rows.length, 1);
    const desired = { ...pre.tables[table][0], ...expected[0] };
    const serverClock = table === "core_stock_financials" ? "fetched_at" : table === "p_momentum" ? undefined : "computed_at";
    for (const name of names) {
      if (name === serverClock) { assert.ok(Number.isSafeInteger(rows[0][name]) && Number(rows[0][name]) >= began - 2 && Number(rows[0][name]) <= ended + 2, "server write clock outside actual repair window"); }
      else assert.equal(rows[0][name], desired[name], `${table}.${name} POST mismatch`);
    }
  }
  assert.ok(Number(post.tables.rsi_percentile[0].computed_at) >= Number(post.tables.core_stock_financials[0].fetched_at), "RSI financial snapshot clock mismatch");
}
function saveNew(path: string, value: unknown): void {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(dirname(path), constants.O_RDONLY); try { fsyncSync(parent); } finally { closeSync(parent); }
}
/** Existing durable intent / fixed latch / atomic batch / full POST pattern, one stock at a time. */
export async function runStock41FinancialRepair(sources: readonly FinancialSource[], stateDir: string, out: string, io: FinancialIo) {
  assert.deepEqual(sources.map(source => source.code), [...STOCK41_CODES]);
  const pending = join(stateDir, `${LATCH}.pending.json`), completed = join(stateDir, `${LATCH}.completed.json`), journal = `${out}.events.jsonl`;
  assert.ok(![pending, completed, out, journal, `${out}.receipt.json`].some(existsSync), "existing fixed-scope evidence; no automatic reentry");
  assert.ok(existsSync(dirname(resolve(out))) && statSync(dirname(resolve(out))).isDirectory(), "output parent must exist before pending");
  const startedAt = new Date().toISOString(), runStartedSec = Math.floor(Date.now() / 1000);
  saveNew(pending, { scope: "stock41_normal5y_snapshot", sourceResultSha256: STOCK41_CAPTURE_RESULT_SHA, startedAt, out: resolve(out), noReplay: true });
  saveNew(journal, { phase: "start", startedAt });
  const append = (event: object) => { const fd = openSync(journal, constants.O_APPEND | constants.O_WRONLY); try { writeFileSync(fd, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n"); fsyncSync(fd); } finally { closeSync(fd); } };
  const applied: string[] = [], held: string[] = [];
  try {
    await io.probeReceiptAbsent(); const annual = await io.annual();
    for (const source of sources) {
      const pre = await io.read(source.code);
      assert.ok(Number.isSafeInteger(pre.identity.id) && Number(pre.identity.id) > 0);
      assert.equal(pre.identity.code, source.code); assert.ok(pre.identity.is_active === 0 || pre.identity.is_active === 1); assert.ok(pre.identity.instrument_type === null || typeof pre.identity.instrument_type === "string");
      for (const [table, dateColumn] of [["core_stock_financials", "data_date"], ["swing_stock_indicators", "latest_date"], ["p_momentum", "as_of"]]) {
        assert.ok(pre.tables[table].length <= 1);
        for (const row of pre.tables[table]) assert.ok(row[dateColumn] === null || typeof row[dateColumn] === "string" && row[dateColumn] <= STOCK41_DATE, "newer market snapshot must not be rewound");
      }
      if (!checkOhlcv(pre, source)) { held.push(source.code); append({ phase: "held_existing_ohlcv", code: source.code, pre }); continue; }
      const rows = annual.get(source.code); const eligible = rows === undefined ? [] : rows.filter(row => row.fiscalPeriodEnd <= STOCK41_DATE);
      sameRows(pre.annual, eligible);
      const snapshot = buildStockSnapshot(Number(pre.identity.id), source.code, pre.identity.sector as string | null, STOCK41_DATE, source.raw, rows === undefined ? [] : rows, source.chart.capture);
      assert.equal(snapshot.rsiHistoryHold, undefined); assert.equal(snapshot.dataDate, STOCK41_DATE);
      assert.ok(pre.tables.swing_entry_signals.every(row => Number(row.computed_at) < runStartedSec), "newer signals must not be deleted");
      const replay = io.compile(snapshot, runStartedSec); assertReplay(replay, Number(pre.identity.id));
      const statements = [...stock41FinancialPreflight(pre), { sql: "DELETE FROM swing_entry_signals WHERE stock_id=? AND computed_at<?", params: [Number(pre.identity.id), runStartedSec] }, ...replay.statements];
      assert.ok(statements.every(statement => statement.params.length <= 100 && Buffer.byteLength(statement.sql) <= 100_000));
      const began = Math.floor(Date.now() / 1000);
      append({ phase: "d1_send_intent", code: source.code, pre, expected: replay.expectedRows, statements, sourceSha256: source.chart.expectedSha256 });
      await io.send(statements); append({ phase: "d1_ack", code: source.code });
      const post = await io.read(source.code); checkPost(pre, post, replay, began, Math.floor(Date.now() / 1000));
      append({ phase: "d1_full_post", code: source.code, post }); applied.push(source.code);
    }
    const report = { status: held.length === 0 ? "stock41_snapshot_complete" : "stock41_snapshot_held", marketDate: STOCK41_DATE, sourceResultSha256: STOCK41_CAPTURE_RESULT_SHA, startedAt, finishedAt: new Date().toISOString(), selected: 41, applied, held, annualWrites: 0, ohlcvWrites: 0, otherStockWrites: 0, sourceFetches: 0, models: 0, wholeMarketComplete: false, noReplay: true };
    saveNew(`${out}.receipt.json`, { ...report, custody: sources.map(source => ({ code: source.code, sourceSha256: source.chart.expectedSha256, capturedAt: source.chart.capture.receivedAt, archives: source.custody })), journalSha256: sha(readFileSync(journal)) });
    const bytes = readFileSync(`${out}.receipt.json`); append({ phase: "receipt_intent", sha256: sha(bytes) }); await io.recordReceipt(bytes); append({ phase: "receipt_physical_verified", sha256: sha(bytes) });
    saveNew(out, report);
    saveNew(completed, { scope: "stock41_normal5y_snapshot", sourceResultSha256: STOCK41_CAPTURE_RESULT_SHA, out: resolve(out), outSha256: sha(readFileSync(out)), journalSha256: sha(readFileSync(journal)), receiptSha256: sha(bytes), noReplay: true });
    unlinkSync(pending);
    const parent = openSync(stateDir, constants.O_RDONLY); try { fsyncSync(parent); } finally { closeSync(parent); }
    return report;
  } catch (error) { append({ phase: "STOP", errorName: error instanceof Error ? error.name : "unknown", errorSha256: sha(String(error)), applied, held, noReplay: true }); throw new Error("stock41 snapshot STOP; preserve pending/intent and do not resend", { cause: error }); }
}

// SQLite json_object emits REAL with only 15 digits. Preserve the binary value before JSON transport.
function losslessValue(sql: string) { return `CASE WHEN typeof(${sql})='real' THEN json_object('$real',printf('%!.26g',${sql})) ELSE ${sql} END`; }
function jsonProjection(names: readonly string[], prefix: string) {
  // D1/workerd: max32 function args. json_object15pairs=30; json_set15pairs+document=31.
  let json = `json_object(${names.slice(0, 15).flatMap(name => [`'${name}'`, losslessValue(`${prefix}.${ident(name)}`)]).join(",")})`;
  for (let i = 15; i < names.length; i += 15) json = `json_set(${json},${names.slice(i, i + 15).flatMap(name => [`'$.${name}'`, losslessValue(`${prefix}.${ident(name)}`)]).join(",")})`;
  return json;
}
/** One fixed-code read of the full five target tables + target OHLCV + annual calculation inputs. */
export function stock41FinancialReadStatement(code: string): D1BatchStatement {
  assert.ok((STOCK41_CODES as readonly string[]).includes(code));
  const queries = [`SELECT 'identity' AS part,${jsonProjection(identityColumns, "s")} AS data FROM target s`];
  for (const [table, names] of columns) queries.push(`SELECT '${table}',${jsonProjection(names, "t")} FROM ${ident(table)} t JOIN target s ON s.id=t.stock_id`);
  queries.push(`SELECT 'ohlcv',${jsonProjection(ohlcvColumns, "t")} FROM swing_daily_ohlcv t JOIN target s ON s.id=t.stock_id WHERE t.date='${STOCK41_DATE}'`);
  queries.push("SELECT 'ohlcvMax',json_object('date',MAX(t.date)) FROM swing_daily_ohlcv t JOIN target s ON s.id=t.stock_id");
  queries.push(`SELECT 'annual',json_object('fiscalPeriodEnd',t.fiscal_period_end,'consolidated',t.consolidated,'revenue',${losslessValue("t.net_sales")}) FROM jss_financials t JOIN target s ON s.code=t.code WHERE t.disclosure_type='本決算' AND t.license_tag='commercial-ok' AND t.fiscal_period_end<='${STOCK41_DATE}'`);
  // D1/workerd caps each compound SELECT at5 terms, including read-only requests.
  return { sql: `WITH target AS (SELECT id,code,sector,is_active,instrument_type FROM core_stocks WHERE code=?), group_a AS (${queries.slice(0, 5).join(" UNION ALL ")}), group_b AS (${queries.slice(5).join(" UNION ALL ")}) SELECT * FROM group_a UNION ALL SELECT * FROM group_b`, params: [code] };
}
export function parseStock41FinancialPre(rows: Record<string, unknown>[]): FinancialPre {
  const found = (part: string, names: readonly string[]) => rows.filter(row => row.part === part).map(row => {
    assert.equal(typeof row.data, "string"); const decoded = JSON.parse(row.data as string) as Record<string, unknown>;
    const value = Object.fromEntries(Object.entries(decoded).map(([key, item]) => {
      if (item !== null && typeof item === "object") {
        assert.deepEqual(Object.keys(item), ["$real"]); const text = (item as { $real: unknown }).$real;
        assert.ok(typeof text === "string" && /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text)); const number = Number(text); assert.ok(Number.isFinite(number)); return [key, number];
      }
      return [key, item];
    })) as RepairRow;
    assert.deepEqual(Object.keys(value).sort(), [...names].sort());
    assert.ok(Object.values(value).every(v => v === null || typeof v === "string" || typeof v === "number" && Number.isFinite(v)));
    return value;
  });
  const identity = found("identity", identityColumns); assert.equal(identity.length, 1);
  assert.ok(Number.isSafeInteger(identity[0].id) && Number(identity[0].id) > 0);
  const max = found("ohlcvMax", ["date"]); assert.equal(max.length, 1); assert.ok(max[0].date === null || typeof max[0].date === "string");
  assert.ok(rows.every(row => row.part === "identity" || row.part === "ohlcv" || row.part === "ohlcvMax" || row.part === "annual" || columns.has(String(row.part))));
  const full = Object.fromEntries([...columns].map(([table, names]) => {
    const values = found(table, names); if (table !== "swing_entry_signals") assert.ok(values.length <= 1, "snapshot cardinality");
    assert.ok(values.every(value => value.stock_id === identity[0].id), "stock primary key mismatch"); return [table, values];
  }));
  return { identity: identity[0], tables: full, ohlcv: found("ohlcv", ohlcvColumns), ohlcvMax: max[0].date as string | null, annual: found("annual", annualColumns) as unknown as JssAnnualRow[] };
}
async function readCurrent(code: string): Promise<FinancialPre> {
  const statement = stock41FinancialReadStatement(code);
  const response = await fetch(d1HttpQueryUrl(), { method: "POST", signal: AbortSignal.timeout(60_000), headers: { Authorization: `Bearer ${sharedEnv.CLOUDFLARE_API_TOKEN()}`, "Content-Type": "application/json" }, body: JSON.stringify(statement) });
  assert.equal(response.status, 200); assert.ok(response.body);
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; assert.ok(length <= 1024 ** 2); chunks.push(part.value); } } finally { await reader.cancel(); }
  return parseStock41FinancialPre(assertD1SingleQueryResponse(JSON.parse(Buffer.concat(chunks, length).toString("utf8"))));
}
async function main(): Promise<void> {
  const args = process.argv.slice(2); assert.equal(args.length, 3); assert.equal(args.filter(arg => arg === "--execute").length, 1);
  const flag = (name: string) => { const values = args.filter(arg => arg.startsWith(`${name}=`)); assert.equal(values.length, 1); const value = values[0].slice(name.length + 1); assert.ok(value); return value; };
  const sourceDir = flag("--source-dir"), out = flag("--out");
  assert.ok(![`${LATCH}.pending.json`, `${LATCH}.completed.json`].some(name => existsSync(join(STOCK41_FINANCIAL_STATE_DIR, name))), "existing fixed-scope evidence; no automatic reentry");
  sharedEnv.CLOUDFLARE_API_TOKEN(); sharedEnv.CLOUDFLARE_ACCOUNT_ID(); sharedEnv.D1_DATABASE_ID(); notionEnv.NOTION_TOKEN(); notionEnv.NOTION_ARCHIVE_PAGE_ID();
  assert.equal(sharedEnv.LOCAL_OUT(), undefined); const proxyBase = sharedEnv.YAHOO_PROXY_BASE(); assert.ok(proxyBase);
  const sources = await loadStock41FinancialSources(sourceDir, proxyBase), db = driverDb();
  mkdirSync(STOCK41_FINANCIAL_STATE_DIR, { recursive: true, mode: 0o700 });
  assert.equal(realpathSync(STOCK41_FINANCIAL_STATE_DIR), STOCK41_FINANCIAL_STATE_DIR); assert.ok(lstatSync(STOCK41_FINANCIAL_STATE_DIR).isDirectory()); assert.equal(lstatSync(STOCK41_FINANCIAL_STATE_DIR).mode & 0o777, 0o700);
  const report = await runStock41FinancialRepair(sources, STOCK41_FINANCIAL_STATE_DIR, out, {
    annual: () => loadJssAnnualMap(db, STOCK41_CODES), read: readCurrent, send: createD1HttpBatchSender(),
    compile: (snapshot, runStartedSec) => buildStockSnapshotStatements(db, snapshot, STOCK41_DATE, { writeAnnual: false, runStartedSec }),
    probeReceiptAbsent: async () => { const backup = await findUniqueBackupChildByTitle({ parentPageId: notionEnv.NOTION_ARCHIVE_PAGE_ID(), title: "一次データ｜stock-sync", kind: "database" }); assert.ok(backup); assert.equal(await queryUniqueRow(backup, { property: "Key", title: { equals: RECEIPT_KEY } }, "financial repair receipt"), null); },
    recordReceipt: async bytes => { const filename = `${RECEIPT_KEY}.json`; const result = await recordPrimaryData({ service: "stock-sync", key: RECEIPT_KEY, source: "Physically custodied same-run Yahoo 5y + QuoteSummary → fixed41 normal snapshot replay", fetchedAt: new Date().toISOString(), metadata: { marketDate: STOCK41_DATE, sourceResultSha256: STOCK41_CAPTURE_RESULT_SHA, selected: 41, annualWrites: 0, ohlcvWrites: 0 }, files: [{ filename, bytes, contentType: "application/json" }], force: false }); assert.equal(result.outcome, "recorded"); assert.equal(result.fileTooLarge, false); await verifyArchivedAttachments(result.pageId, [{ filename, bytes }], "stock41 snapshot receipt"); },
  });
  console.info(JSON.stringify({ status: report.status, selected: 41, applied: report.applied.length, held: report.held.length, sourceFetches: 0, models: 0, wholeMarketComplete: false })); if (report.held.length > 0) process.exitCode = 1;
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => { console.error("[stock41-financial-repair] STOP; preserve fixed pending/intent; no automatic replay"); process.exitCode = 1; });
