import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sharedEnv } from "../../src/shared/env.js";
import { canonicalRawKey } from "./raw-index-plan.js";
import { expectedRawIndex, readRawIndexes, type RawItem } from "./raw-index-backfill.js";
import { auditRawIndex, qualifyRawAuditItem, type RawAuditIo, type RawAuditOptions } from "./raw-index-audit.js";

const saved = JSON.parse(readFileSync(new URL("./fixtures/raw-audit-saved.json", import.meta.url), "utf8")) as { bodyPath: string; bodySha256: string; item: RawItem };
const body = readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..", saved.bodyPath));
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const cutoff = "2026-10-13T18:31:00.000Z";
afterEach(() => vi.restoreAllMocks());

function fixture(two = false) {
  // Actual saved source/item are unchanged. Second item is declared binary transport fault/control, no financial facts.
  const extraBody = Buffer.from(body).reverse();
  const items = two ? [saved.item, { ...saved.item, sha256: sha(extraBody), pageId: "a".repeat(32) }].sort((a, b) => a.sha256.localeCompare(b.sha256)) : [saved.item];
  const manifest = { version: 1, planId: "audit-protocol", cutoff, expectedCount: items.length, rawBucket: "raw-protocol", items };
  const manifestBytes = encode(manifest), manifestSha256 = sha(manifestBytes);
  const objects = new Map<string, Uint8Array>([["ops/raw-index/active.json", encode({ version: 1, planId: manifest.planId, manifestSha256 })],
    [`ops/raw-index/${manifest.planId}/manifest.json`, manifestBytes]]);
  const rows = items.map(item => expectedRawIndex(item, manifest.rawBucket, canonicalRawKey({ ...item, sourceUrl: null }, item.docId)));
  for (const row of rows) objects.set(row.r2_key, row.sha256 === saved.item.sha256 ? body : extraBody);
  const records: object[] = [], calls: string[] = [];
  let clock = Date.parse("2026-10-18T00:00:00.000Z");
  const io: RawAuditIo = { rawBucket: manifest.rawBucket, receiptBucket: "receipt-protocol", sourceSha256: "d".repeat(64), now: () => clock,
    emit: async record => { records.push(structuredClone(record)); clock++; },
    get: async (key, _bucket, options) => {
      expect(options.singleAttempt).toBe(true); await options.beforeAttempt!(); calls.push(`GET:${key}`);
      const value = objects.get(key); if (value === undefined) return null;
      if (value.length > options.maxBytes!) throw new Error("DECLARED_OVERSIZE");
      await options.onRead!({ status: 200, etag: `"${sha(value)}"`, contentLength: value.length, body: value, receivedBytes: value.length, complete: true });
      return { body: value, etag: `"${sha(value)}"` };
    },
    index: async (shas, options) => { await options.beforeRequest(); calls.push(`SELECT:${shas.length}`);
      const selected = rows.filter(row => shas.includes(row.sha256)); await options.onRead(encode(selected), true); return selected; },
  };
  const opts: RawAuditOptions = { planId: manifest.planId, cutoff, expectedCount: items.length, manifestSha256, limit: 1,
    maxBytes: 10 * 1024 ** 2, maxRequests: 100, maxSeconds: 600 };
  return { io, opts, rows, objects, records, calls, items, tick: (ms: number) => { clock += ms; }, receipt: () => Buffer.from(records.map(r => JSON.stringify(r)).join("\n") + "\n") };
}

describe("independent RAW reread (actual saved 8566 bytes, declared remote transport)", () => {
  it("full SHA/size + all 15 columns and original clocks; only read adapters", async () => {
    const f = fixture(); expect(sha(body)).toBe(saved.bodySha256); expect(body.length).toBe(saved.item.sizeBytes);
    const result = await auditRawIndex(f.opts, f.io);
    expect(result).toMatchObject({ status: "complete", integrityAccepted: true, semanticFullyQualified: true, writes: 0, writerPoolConsumed: 0 });
    expect(result.checkpoint.stats).toMatchObject({ requests: 4, r2Requests: 3, d1Requests: 1, rawBytes: body.length, unmeasuredResponses: 0 });
    expect(f.records.find(r => (r as { phase: string }).phase === "item")).toMatchObject({ index: f.rows[0], body: { sha256: saved.bodySha256, sizeBytes: body.length }, integrity: "pass" });
    expect(Object.keys(f.rows[0]!)).toHaveLength(15); expect(f.calls).toHaveLength(4);
  });
  it("legacy doc NULL and acquired historical clocks stay intact, integrity PASS != semantic qualification", async () => {
    const f = fixture(); f.rows[0]!.doc_id = null; f.rows[0]!.first_fetched_at -= 10;
    const result = await auditRawIndex(f.opts, f.io);
    expect(result).toMatchObject({ integrityAccepted: true, semanticFullyQualified: false, checkpoint: { semanticHolds: 1 } });
    expect(f.records.find(r => (r as { phase: string }).phase === "item")).toMatchObject({ index: f.rows[0], semanticReasons: ["edinet_doc_id_unproven", "historical_fetch_clocks_preserved_not_reconstructed"] });
    const nonEdinet = { ...saved.item, source: "TDnet" as const, docId: null };
    expect(qualifyRawAuditItem(nonEdinet, expectedRawIndex(nonEdinet, f.io.rawBucket, f.rows[0]!.r2_key), f.io.rawBucket, { sha256: nonEdinet.sha256, sizeBytes: body.length }).semanticIdentity).toBe("doc_id_not_applicable");
  });
  it.each(["missing_index", "missing_body", "wrong_hash", "wrong_metadata"])("%s is explicit integrity HOLD, never numeric/metadata repair", async fault => {
    const f = fixture();
    if (fault === "missing_index") f.rows.length = 0;
    else if (fault === "missing_body") f.objects.delete(f.rows[0]!.r2_key);
    else if (fault === "wrong_hash") f.objects.set(f.rows[0]!.r2_key, Buffer.from(body).reverse());
    else f.rows[0]!.scope = "DECLARED_MISMATCH";
    const result = await auditRawIndex(f.opts, f.io);
    expect(result).toMatchObject({ status: "complete", integrityAccepted: false, checkpoint: { integrityHolds: 1 } });
    if (["missing_index", "wrong_metadata"].includes(fault)) expect(f.calls.some(call => call.startsWith("GET:raw/"))).toBe(false);
  });
  it("normal partial resume pins source/manifest/whole receipt and carries read bytes, requests, elapsed time", async () => {
    const f = fixture(true), first = await auditRawIndex(f.opts, f.io), prior = f.receipt();
    expect(first.status).toBe("partial"); f.records.length = 0;
    const result = await auditRawIndex(f.opts, f.io, { bytes: prior, sha256: sha(prior) });
    expect(result).toMatchObject({ status: "complete", checkpoint: { cursor: 2 } });
    expect(result.checkpoint.stats.receivedBytes).toBeGreaterThan(first.checkpoint.stats.receivedBytes);
    expect(result.checkpoint.stats.requests).toBe(first.checkpoint.stats.requests + 4);
    expect(result.checkpoint.elapsedMs).toBeGreaterThan(first.checkpoint.elapsedMs);
  });
  it.each(["sha", "source", "partial_tail", "prefix", "budget", "stats_key", "initial"])("resume %s mismatch stops without new IO", async fault => {
    const f = fixture(true); await auditRawIndex(f.opts, f.io); let prior = f.receipt(); const before = f.calls.length;
    if (fault === "source") f.io.sourceSha256 = "e".repeat(64);
    if (fault === "partial_tail") prior = prior.subarray(0, prior.length - 1);
    if (fault === "prefix") { const lines = prior.toString().trim().split("\n").map(l => JSON.parse(l)); lines.at(-1).checkpoint.cursor++; prior = Buffer.from(lines.map(l => JSON.stringify(l)).join("\n") + "\n"); }
    if (fault === "budget") f.opts.maxRequests++;
    if (["stats_key", "initial"].includes(fault)) {
      const lines = prior.toString().trim().split("\n").map(l => JSON.parse(l));
      if (fault === "stats_key") delete lines.at(-1).checkpoint.stats.unmeasuredResponses;
      else lines[0].checkpoint.cursor = 1;
      prior = Buffer.from(lines.map(l => JSON.stringify(l)).join("\n") + "\n");
    }
    await expect(auditRawIndex(f.opts, f.io, { bytes: prior, sha256: fault === "sha" ? "0".repeat(64) : sha(prior) })).rejects.toThrow();
    // Prefix semantics need fixed manifest bytes; all other binding errors stop before any request.
    if (fault !== "prefix") expect(f.calls).toHaveLength(before);
  });
  it("post-fsync 65s guard rejects native start, partial/unknown cannot be resumed", async () => {
    const f = fixture(), emit = f.io.emit;
    f.io.emit = async record => { await emit(record); if ((record as { phase: string }).phase === "read_intent") f.tick(600000); };
    await expect(auditRawIndex(f.opts, f.io)).rejects.toThrow("headroom"); expect(f.calls).toEqual([]);
    expect(f.records.at(-1)).toMatchObject({ phase: "stopped", resumeAuthorized: false });
  });
  it("partial R2 failure accounts received prefix and never creates resumable completion", async () => {
    const f = fixture(), get = f.io.get;
    f.io.get = async (key, bucket, options) => {
      if (!key.startsWith("raw/")) return get(key, bucket, options);
      await options.beforeAttempt!();
      await options.onRead!({ status: 200, etag: "DECLARED_PARTIAL", contentLength: body.length, body: body.subarray(0, 7), receivedBytes: 7, complete: false });
      throw new Error("DECLARED_SOCKET_STOP");
    };
    await expect(auditRawIndex(f.opts, f.io)).rejects.toThrow("DECLARED_SOCKET_STOP");
    expect(f.records.at(-1)).toMatchObject({ phase: "stopped", checkpoint: { stats: { rawBytes: 7, unmeasuredResponses: 0 } }, resumeAuthorized: false });
  });
  it("resume does not reset original clock or exhausted cumulative request budget", async () => {
    const f = fixture(true); await auditRawIndex(f.opts, f.io); const receipt = f.receipt(); f.tick(600000);
    const before = f.calls.length;
    await expect(auditRawIndex(f.opts, f.io, { bytes: receipt, sha256: sha(receipt) })).rejects.toThrow("time budget");
    expect(f.calls).toHaveLength(before);
    const limited = fixture(true); limited.opts.maxRequests = 4;
    const first = await auditRawIndex(limited.opts, limited.io); expect(first.status).toBe("partial");
    const prior = limited.receipt(), calls = limited.calls.length;
    await expect(auditRawIndex(limited.opts, limited.io, { bytes: prior, sha256: sha(prior) })).rejects.toThrow("request予算");
    expect(limited.calls).toHaveLength(calls);
  });
  it("manifest mismatch and duplicate/offscope indexes never touch raw bodies", async () => {
    for (const fault of ["manifest", "duplicate", "offscope"]) {
      const f = fixture();
      if (fault === "manifest") f.opts.manifestSha256 = "0".repeat(64);
      else f.io.index = async (_shas, options) => { await options.beforeRequest(); await options.onRead(encode(f.rows), true);
        return fault === "duplicate" ? [f.rows[0]!, f.rows[0]!] : [{ ...f.rows[0]!, sha256: "0".repeat(64) }]; };
      await expect(auditRawIndex(f.opts, f.io)).rejects.toThrow(); expect(f.calls.some(c => c.startsWith("GET:raw/"))).toBe(false);
    }
  });
});

describe("SHA-scoped full15 single native reader", () => {
  const credentials = () => {
    vi.spyOn(sharedEnv, "CLOUDFLARE_ACCOUNT_ID").mockReturnValue("DECLARED_ACCOUNT");
    vi.spyOn(sharedEnv, "D1_DATABASE_ID").mockReturnValue("DECLARED_DATABASE");
    vi.spyOn(sharedEnv, "CLOUDFLARE_API_TOKEN").mockReturnValue("DECLARED_TOKEN");
  };
  it("exact IN params first, <=100; malformed/duplicate/error responses never retry", async () => {
    credentials(); const f = fixture(), row = f.rows[0]!;
    for (const response of [new Response(JSON.stringify({ success: true, result: [{ success: true, results: [row] }] })),
      new Response(JSON.stringify({ success: true, result: [{ success: true, results: [row, row] }] })), new Response("DECLARED_503", { status: 503 })]) {
      const native = vi.spyOn(globalThis, "fetch").mockResolvedValue(response), beforeRequest = vi.fn(async () => {}), onRead = vi.fn(async () => {});
      const promise = readRawIndexes([row.sha256], { signal: AbortSignal.timeout(1000), maxBytes: 4096, beforeRequest, onRead });
      if (response.status === 200 && (await response.clone().json()).result[0].results.length === 1) expect(await promise).toEqual([row]);
      else await expect(promise).rejects.toThrow();
      expect(native).toHaveBeenCalledOnce(); expect(beforeRequest).toHaveBeenCalledOnce();
      const query = JSON.parse(native.mock.calls[0]![1]!.body as string);
      expect(query.sql).toMatch(/FROM jss_raw_files WHERE sha256 IN \(\?\)$/); expect(query.sql.split(" FROM")[0].split(",")).toHaveLength(15); expect(query.params).toEqual([row.sha256]); native.mockRestore();
    }
    const native = vi.spyOn(globalThis, "fetch");
    await expect(readRawIndexes(Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(64, "0")), { signal: AbortSignal.timeout(1000), maxBytes: 4096, beforeRequest: async () => {}, onRead: async () => {} })).rejects.toThrow();
    expect(native).not.toHaveBeenCalled();
  });
  it("oversized partial response is measured and stops, with no whole-table query", async () => {
    credentials(); const onRead = vi.fn(async () => {}), native = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("DECLARED_OVERSIZED_BODY"));
    await expect(readRawIndexes([saved.item.sha256], { signal: AbortSignal.timeout(1000), maxBytes: 1, beforeRequest: async () => {}, onRead })).rejects.toThrow("bytes");
    expect(native).toHaveBeenCalledOnce(); expect(onRead).toHaveBeenCalledWith(expect.any(Uint8Array), false);
  });
});
