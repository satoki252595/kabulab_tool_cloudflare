import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sharedEnv } from "../../src/shared/env.js";
import type { CanonicalRawFile } from "../../src/shared/notion-archive/raw-files.js";
import { parseShina } from "../../services/jss-api/src/shared/shina-parser.js";
import { canonicalRawKey } from "./raw-index-plan.js";
import { expectedRawIndex, type RawItem } from "./raw-index-backfill.js";
import { readLatestShinaIndexCandidates, runRequiredRawCheck, type RequiredRawIo } from "./raw-required.js";

// Declared parser transport double, not shina financial data. Actual local CSV is checked separately below.
vi.mock("../../services/jss-api/src/shared/shina-parser.js", () => ({ parseShina: vi.fn(() => [{ transportFixture: true }]) }));
const saved = JSON.parse(readFileSync(new URL("./fixtures/raw-audit-saved.json", import.meta.url), "utf8")) as { bodyPath: string; item: RawItem };
const actualZip = readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..", saved.bodyPath));
const hash = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
afterEach(() => { vi.restoreAllMocks(); vi.mocked(parseShina).mockReset().mockReturnValue([{ transportFixture: true }]); });

function fixture(body = actualZip) {
  // Existing Git bytes unchanged; shina metadata is an explicit protocol projection, not observed source facts.
  const raw: CanonicalRawFile = { ...saved.item, source: "日証金", datatype: "shina", scope: "ALL", licenseTag: "personal-only",
    filename: "DECLARED-shina-transport.csv", sha256: hash(body), sizeBytes: body.length, sourceUrl: "https://source.invalid/?secret=never-log" };
  const item = { ...raw, docId: null } as RawItem;
  let rows = [expectedRawIndex(item, "raw-protocol", canonicalRawKey(raw, null))];
  const records: object[] = [], calls: string[] = [];
  let clock = Date.parse("2026-10-18T00:00:00.000Z"), wire: Uint8Array | null = body;
  const io: RequiredRawIo = { rawBucket: "raw-protocol", now: () => clock,
    emit: async record => { records.push(structuredClone(record)); },
    latest: async options => { expect(options.singleAttempt).toBe(true); options.beforeRequest!(); calls.push("notion-latest"); return raw; },
    index: async (shas, options) => { await options.beforeRequest(); expect(shas).toEqual([raw.sha256]); calls.push("sha-select"); await options.onRead(encode(rows), true); return rows; },
    latestIndex: async options => { await options.beforeRequest(); calls.push("runtime-latest"); const latest = rows.map(row => ({ sha256: row.sha256, last_fetched_at: row.last_fetched_at })); await options.onRead(encode(latest), true); return latest; },
    get: async (key, bucket, options) => {
      expect(key).toBe(rows[0]!.r2_key); expect(bucket).toBe(io.rawBucket); expect(options!.singleAttempt).toBe(true);
      expect(options!.maxBytes).toBe(raw.sizeBytes); await options!.beforeAttempt!(); calls.push("raw-get");
      if (wire === null) return null;
      await options!.onRead!({ status: 200, etag: '"transport-etag"', contentLength: wire.length, body: wire, receivedBytes: wire.length, complete: true });
      return { body: wire, etag: '"transport-etag"' };
    } };
  return { io, raw, rows, records, calls, setRows: (value: typeof rows) => { rows = value; }, setWire: (value: Uint8Array | null) => { wire = value; }, tick: (ms: number) => { clock += ms; } };
}

describe("required runtime raw only (unchanged Git bytes; declared remote transport)", () => {
  it("checks one selected SHA, the actual runtime choice, full body and production parser; never whole history", async () => {
    const f = fixture(), result = await runRequiredRawCheck(f.io, 600);
    expect(result).toMatchObject({ scope: "runtime_latest_shina", status: "required_complete", selected: 1, verified: 1, parsedRows: 1,
      reads: { notionMetadata: 1, d1: 2, r2: 1 }, writes: 0, sourceGets: 0, wholeHistoryAccepted: false, historyCursorChanged: false });
    expect(f.calls).toEqual(["notion-latest", "sha-select", "runtime-latest", "raw-get"]);
    expect(new Uint8Array(vi.mocked(parseShina).mock.calls[0]![0])).toEqual(new Uint8Array(actualZip));
    expect(JSON.stringify(f.records)).not.toContain("never-log"); expect(JSON.stringify(result)).not.toContain("sourceUrl");
  });
  it("absent selected index is explicit missing and causes no R2 or second D1 read", async () => {
    const f = fixture(); f.setRows([]);
    expect(await runRequiredRawCheck(f.io, 600)).toMatchObject({ status: "required_missing", reason: "missing_index", missingIndex: 1, verified: 0, reads: { d1: 1, r2: 0 } });
    expect(f.calls).toEqual(["notion-latest", "sha-select"]); expect(parseShina).not.toHaveBeenCalled();
  });
  it("absent raw is missing, never recreated or parsed", async () => {
    const f = fixture(); f.setWire(null);
    expect(await runRequiredRawCheck(f.io, 600)).toMatchObject({ status: "required_missing", reason: "missing_raw", missingRaw: 1, verified: 0 });
    expect(parseShina).not.toHaveBeenCalled();
  });
  it.each(["metadata", "duplicate", "offscope"])("%s index stops before reading the body", async fault => {
    const f = fixture();
    if (fault === "metadata") f.rows[0]!.scope = "DECLARED_MISMATCH";
    if (fault === "duplicate") f.setRows([f.rows[0]!, f.rows[0]!]);
    if (fault === "offscope") f.rows[0]!.sha256 = "0".repeat(64);
    await expect(runRequiredRawCheck(f.io, 600)).rejects.toThrow(); expect(f.calls).not.toContain("raw-get"); expect(parseShina).not.toHaveBeenCalled();
  });
  it("a different production latest is HOLD without copying or advancing anything", async () => {
    const f = fixture(); f.io.latestIndex = async options => { await options.beforeRequest(); return [{ sha256: "0".repeat(64), last_fetched_at: f.rows[0]!.last_fetched_at + 1 }]; };
    expect(await runRequiredRawCheck(f.io, 600)).toMatchObject({ status: "required_hold", reason: "runtime_latest_differs", missingIndex: 0, missingRaw: 0, verified: 0, writes: 0 });
    expect(f.calls).not.toContain("raw-get");
  });
  it("equal latest clocks are ambiguous and stop before R2", async () => {
    const f = fixture(); f.io.latestIndex = async options => { await options.beforeRequest(); return [f.rows[0]!, { sha256: "0".repeat(64), last_fetched_at: f.rows[0]!.last_fetched_at }]; };
    await expect(runRequiredRawCheck(f.io, 600)).rejects.toThrow("ambiguous"); expect(f.calls).not.toContain("raw-get");
  });
  it.each(["hash", "size"])("wrong body %s is stopped before parsing", async fault => {
    const f = fixture(); f.setWire(fault === "size" ? actualZip.subarray(1) : Buffer.from(actualZip).reverse());
    await expect(runRequiredRawCheck(f.io, 600)).rejects.toThrow("SHA/サイズ"); expect(parseShina).not.toHaveBeenCalled();
  });
  it("parser failure is not accepted as source-qualified bytes alone", async () => {
    const f = fixture(); vi.mocked(parseShina).mockImplementationOnce(() => { throw new Error("DECLARED_SCHEMA_FAILURE"); });
    await expect(runRequiredRawCheck(f.io, 600)).rejects.toThrow("DECLARED_SCHEMA_FAILURE");
    expect(f.records.at(-1)).toMatchObject({ phase: "required_stopped", writes: 0, wholeHistoryAccepted: false });
  });
  it("yfinance history, excessive bytes and post-fsync expired budgets cannot reach D1/R2", async () => {
    for (const fault of ["yfinance", "oversize", "clock"]) {
      const f = fixture();
      if (fault === "yfinance") { f.raw.source = "yfinance"; f.raw.datatype = "daily_prices_batch"; }
      if (fault === "oversize") f.raw.sizeBytes = 2 * 1024 ** 2 + 1;
      if (fault === "clock") { const emit = f.io.emit; f.io.emit = async record => { await emit(record); if ((record as { kind?: string }).kind === "notionMetadata") f.tick(600000); }; }
      await expect(runRequiredRawCheck(f.io, 600)).rejects.toThrow(); expect(f.calls).not.toContain("sha-select"); expect(f.calls).not.toContain("raw-get");
    }
  });
});

describe("runtime latest D1 lookup is bounded and single-attempt", () => {
  it("uses the consumer's exact filtered ORDER/LIMIT and rejects ties or HTTP errors without retry", async () => {
    vi.spyOn(sharedEnv, "CLOUDFLARE_ACCOUNT_ID").mockReturnValue("DECLARED_ACCOUNT");
    vi.spyOn(sharedEnv, "D1_DATABASE_ID").mockReturnValue("DECLARED_DATABASE");
    vi.spyOn(sharedEnv, "CLOUDFLARE_API_TOKEN").mockReturnValue("DECLARED_TOKEN");
    const row = { sha256: hash(actualZip), last_fetched_at: 1791888309 };
    for (const fault of ["none", "tie", "http"]) {
      const native = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(fault === "http" ? "DECLARED_503" : JSON.stringify({ success: true, result: [{ success: true, results: fault === "tie" ? [row, { ...row, sha256: "0".repeat(64) }] : [row] }] }), { status: fault === "http" ? 503 : 200 }));
      const options = { signal: AbortSignal.timeout(1000), maxBytes: 16384, beforeRequest: vi.fn(async () => {}), onRead: vi.fn(async () => {}) };
      if (fault === "none") expect(await readLatestShinaIndexCandidates(options)).toEqual([row]);
      else await expect(readLatestShinaIndexCandidates(options)).rejects.toThrow();
      expect(native).toHaveBeenCalledOnce(); expect(options.beforeRequest).toHaveBeenCalledOnce();
      const query = JSON.parse(native.mock.calls[0]![1]!.body as string);
      expect(query.sql).toBe("SELECT sha256,last_fetched_at FROM jss_raw_files WHERE source = ? AND datatype = ? AND scope = ? ORDER BY last_fetched_at DESC LIMIT 2");
      expect(query.params).toEqual(["日証金", "shina", "ALL"]); native.mockRestore();
    }
  });
});

const actualShina = new URL("../../tmp/feature-audit-20261013/jss-shina-native/shina.csv", import.meta.url);
describe.skipIf(!existsSync(actualShina))("local saved actual shina; personal-only bytes remain outside Git", () => {
  it("passes the unchanged production parser and original full SHA", async () => {
    const body = readFileSync(actualShina);
    expect(hash(body)).toBe("f51cdaea8a03b059b9cb892ce6f79e89d4e78b42724f10f5f7b2f03e0277b512");
    const actual = await vi.importActual<{ parseShina: typeof parseShina }>("../../services/jss-api/src/shared/shina-parser.js");
    vi.mocked(parseShina).mockImplementationOnce(actual.parseShina);
    const f = fixture(body);
    expect(await runRequiredRawCheck(f.io, 600)).toMatchObject({ status: "required_complete", parsedRows: 943, verified: 1 });
  });
});
