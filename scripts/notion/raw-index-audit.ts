/** Finite independent reread of an immutable RAW manifest. No writer/pool/state adapter. */
import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sharedEnv } from "../../src/shared/env.js";
import { r2GetBytesVersion, type R2ReadOptions } from "../vwap/lib/r2.js";
import { parseRawManifest, expectedRawIndex, validateBody, validateIndex, readRawIndexes, type RawItem, type RawIndexRow } from "./raw-index-backfill.js";

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const encoded = (value: unknown) => JSON.stringify(value);
const shaPattern = /^[a-f0-9]{64}$/;
export interface RawAuditOptions {
  planId: string; cutoff: string; expectedCount: number; manifestSha256: string;
  limit: number; maxBytes: number; maxRequests: number; maxSeconds: number;
}
type Stats = { requests: number; r2Requests: number; d1Requests: number; receivedBytes: number; rawBytes: number; unmeasuredResponses: number };
type Checkpoint = { elapsedMs: number; cursor: number; integrityHolds: number; semanticHolds: number; prefixSha256: string; stats: Stats };
type Contract = RawAuditOptions & { rawBucket: string; receiptBucket: string; sourceSha256: string };
export interface RawAuditIo {
  rawBucket: string; receiptBucket: string; sourceSha256: string; now: () => number;
  get: (key: string, bucket: string, options: R2ReadOptions) => ReturnType<typeof r2GetBytesVersion>;
  index: typeof readRawIndexes;
  emit: (record: object) => Promise<void>;
}
type ItemProof = ReturnType<typeof qualifyRawAuditItem> & {
  phase: "item"; position: number; sha256: string; observedAt: string; key: string | null;
  index: RawIndexRow | null; body: { sha256: string; sizeBytes: number; etag: string } | null;
};

/** Preserve normal history/legacy-NULL rules; integrity and independently qualified identity differ. */
export function qualifyRawAuditItem(item: RawItem, row: RawIndexRow | null, bucket: string,
  body: { sha256: string; sizeBytes: number } | null) {
  const integrityReasons: string[] = [], semanticReasons: string[] = [];
  if (row === null) integrityReasons.push("index_missing_raw_key_unproven");
  else {
    try { validateIndex(row, item, bucket); } catch { integrityReasons.push("index_metadata_mismatch"); }
    if (body === null) integrityReasons.push("raw_missing_or_not_read");
    else if (body.sha256 !== item.sha256 || body.sizeBytes !== item.sizeBytes) integrityReasons.push("raw_sha_or_size_mismatch");
    if (item.source === "EDINET" && (row.doc_id === null || item.docId === null)) semanticReasons.push("edinet_doc_id_unproven");
    const expected = expectedRawIndex(item, bucket, row.r2_key);
    if (row.first_fetched_at !== expected.first_fetched_at || row.last_fetched_at !== expected.last_fetched_at)
      semanticReasons.push("historical_fetch_clocks_preserved_not_reconstructed");
  }
  return { integrity: integrityReasons.length === 0 ? "pass" : "hold", integrityReasons,
    semanticIdentity: row === null || semanticReasons.length > 0 ? "hold" : item.source === "EDINET" ? "qualified" : "doc_id_not_applicable",
    semanticReasons };
}
function assertOptions(opts: RawAuditOptions) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(opts.planId) || !shaPattern.test(opts.manifestSha256) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(opts.cutoff) || !Number.isFinite(Date.parse(opts.cutoff)) ||
      [opts.expectedCount, opts.limit, opts.maxBytes, opts.maxRequests, opts.maxSeconds].some(n => !Number.isSafeInteger(n) || n < 1) ||
      opts.limit > opts.expectedCount || opts.maxSeconds > 2147483 || opts.maxSeconds < 66)
    throw new Error("[raw-audit] fixed manifest/finite budgets不正");
}
function initial(): Checkpoint { return { elapsedMs: 0, cursor: 0, integrityHolds: 0, semanticHolds: 0, prefixSha256: "0".repeat(64),
  stats: { requests: 0, r2Requests: 0, d1Requests: 0, receivedBytes: 0, rawBytes: 0, unmeasuredResponses: 0 } }; }
function advance(checkpoint: Checkpoint, proof: ItemProof) {
  checkpoint.cursor++;
  if (proof.integrity !== "pass") checkpoint.integrityHolds++;
  if (proof.semanticIdentity === "hold") checkpoint.semanticHolds++;
  checkpoint.prefixSha256 = hash(checkpoint.prefixSha256 + encoded(proof));
}
function validateCheckpoint(value: Checkpoint, contract: Contract) {
  if (!value || !value.stats || Object.keys(value).length !== 6 || Object.keys(value.stats).length !== Object.keys(initial().stats).length ||
      Object.keys(initial().stats).some(key => !Object.hasOwn(value.stats, key)) || !shaPattern.test(value.prefixSha256) ||
      [value.elapsedMs, value.cursor, value.integrityHolds, value.semanticHolds, ...Object.values(value.stats)].some(n => !Number.isSafeInteger(n) || n < 0) ||
      value.elapsedMs > contract.maxSeconds * 1000 || value.cursor > contract.expectedCount || value.integrityHolds > value.cursor || value.semanticHolds > value.cursor ||
      value.stats.requests !== value.stats.r2Requests + value.stats.d1Requests || value.stats.requests > contract.maxRequests ||
      value.stats.receivedBytes > contract.maxBytes || value.stats.rawBytes > value.stats.receivedBytes)
    throw new Error("[raw-audit] resume累積予算/件数不正");
}
/** Only a pinned, newline-complete normal partial terminal can resume. Keep every ancestor receipt. */
function resumeCheckpoint(bytes: Uint8Array, expectedSha: string, contract: Contract, items: RawItem[]): Checkpoint {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!shaPattern.test(expectedSha) || hash(bytes) !== expectedSha || !text.endsWith("\n")) throw new Error("[raw-audit] resume file SHA/terminal不一致");
  const records = text.trimEnd().split("\n").map(line => JSON.parse(line));
  const start = records[0], end = records.at(-1);
  if (start?.phase !== "start" || encoded(start.contract) !== encoded(contract) || end?.phase !== "summary" || end.status !== "partial")
    throw new Error("[raw-audit] resume source/manifest/options/normal partial不一致");
  const result: Checkpoint = structuredClone(start.checkpoint); validateCheckpoint(result, contract);
  if (start.previousReceiptSha256 === null ? encoded(result) !== encoded(initial()) : !shaPattern.test(start.previousReceiptSha256)) throw new Error("[raw-audit] resume initial/ancestor checkpoint不正");
  for (const record of records.slice(1, -1)) {
    if (!["read_intent", "r2_read", "manifest", "index_response", "item"].includes(record.phase)) throw new Error("[raw-audit] resume unexpected phase");
    if (record.phase !== "item") continue;
    const item = items[result.cursor];
    if (!item || record.position !== result.cursor || record.sha256 !== item.sha256 ||
        encoded(qualifyRawAuditItem(item, record.index, contract.rawBucket, record.body)) !== encoded({
          integrity: record.integrity, integrityReasons: record.integrityReasons, semanticIdentity: record.semanticIdentity, semanticReasons: record.semanticReasons }))
      throw new Error("[raw-audit] resume verified prefix不一致");
    advance(result, record);
  }
  const summary: Checkpoint = end.checkpoint; validateCheckpoint(summary, contract);
  if (result.cursor !== summary.cursor || result.prefixSha256 !== summary.prefixSha256 || result.integrityHolds !== summary.integrityHolds || result.semanticHolds !== summary.semanticHolds ||
      Object.keys(result.stats).some(k => summary.stats[k as keyof Stats] < result.stats[k as keyof Stats])) throw new Error("[raw-audit] resume summary不一致");
  return structuredClone(summary);
}

export async function auditRawIndex(opts: RawAuditOptions, io: RawAuditIo, resume?: { bytes: Uint8Array; sha256: string }) {
  assertOptions(opts);
  if (!shaPattern.test(io.sourceSha256) || !io.rawBucket || !io.receiptBucket) throw new Error("[raw-audit] source/bucket binding不正");
  const contract: Contract = { ...opts, rawBucket: io.rawBucket, receiptBucket: io.receiptBucket, sourceSha256: io.sourceSha256 };
  const start = io.now();
  let deadline = start + opts.maxSeconds * 1000, signal = AbortSignal.timeout(opts.maxSeconds * 1000);
  let checkpoint = initial(), observedBytes = 0, observedRequests = 0;
  const time = () => { signal.throwIfAborted(); if (io.now() + 65_000 > deadline) throw new Error("[raw-audit] 65s headroom不足"); };
  const remaining = () => opts.maxBytes - checkpoint.stats.receivedBytes;
  const request = async (kind: "r2" | "d1", details: object) => {
    time(); if (checkpoint.stats.requests >= opts.maxRequests) throw new Error("[raw-audit] request予算到達");
    await io.emit({ phase: "read_intent", kind, ...details }); time();
    checkpoint.stats.requests++; observedRequests++;
    if (kind === "r2") checkpoint.stats.r2Requests++; else checkpoint.stats.d1Requests++;
  };
  const get = async (key: string, bucket: string, maxBytes: number, raw: boolean) => {
    if (maxBytes < 1 || maxBytes > remaining()) throw new Error("[raw-audit] bytes予算不足");
    let measured = false, attempted = false;
    try {
      return await io.get(key, bucket, { singleAttempt: true, maxBytes, abortSignal: signal,
        beforeAttempt: async () => { await request("r2", { key, bucket, maxBytes }); attempted = true; }, onRead: async read => {
          measured = true; checkpoint.stats.receivedBytes += read.receivedBytes; observedBytes += read.receivedBytes;
          if (raw) checkpoint.stats.rawBytes += read.receivedBytes;
          await io.emit({ phase: "r2_read", key, bucket, complete: read.complete, sha256: hash(read.body),
            receivedBytes: read.receivedBytes, retainedBytes: read.body.length, etag: read.etag });
        } });
    } finally { if (attempted && !measured) checkpoint.stats.unmeasuredResponses++; }
  };
  // Resume cumulative costs must be known BEFORE new controls are fetched; source/contract are pinned first.
  if (resume) {
    if (resume.bytes.length > 256 * 1024 ** 2) throw new Error("[raw-audit] resume bytes上限超過");
    const lines = new TextDecoder("utf-8", { fatal: true }).decode(resume.bytes).trimEnd().split("\n");
    if (!shaPattern.test(resume.sha256) || !new TextDecoder().decode(resume.bytes).endsWith("\n") || hash(resume.bytes) !== resume.sha256) throw new Error("[raw-audit] resume SHA不一致");
    const head = JSON.parse(lines[0]!), tail = JSON.parse(lines.at(-1)!);
    if (encoded(head.contract) !== encoded(contract) || tail.phase !== "summary" || tail.status !== "partial") throw new Error("[raw-audit] resume contract不一致");
    validateCheckpoint(head.checkpoint, contract);
    if (head.previousReceiptSha256 === null ? encoded(head.checkpoint) !== encoded(initial()) : !shaPattern.test(head.previousReceiptSha256)) throw new Error("[raw-audit] resume initial/ancestor checkpoint不正");
    checkpoint = structuredClone(tail.checkpoint); validateCheckpoint(checkpoint, contract);
    const previousStart = Date.parse(head.startedAt), previousDeadline = Date.parse(head.notAfter);
    if (!Number.isFinite(previousStart) || !Number.isFinite(previousDeadline) || previousStart > start ||
        previousDeadline < previousStart || previousDeadline > previousStart + opts.maxSeconds * 1000) throw new Error("[raw-audit] resume original clock不正");
    deadline = Math.min(deadline, previousDeadline);
  }
  const prior = structuredClone(checkpoint);
  deadline = Math.min(deadline, start + opts.maxSeconds * 1000 - checkpoint.elapsedMs);
  if (deadline <= start) throw new Error("[raw-audit] cumulative time budget到達");
  signal = AbortSignal.timeout(deadline - start);
  await io.emit({ phase: "start", contract, checkpoint: prior, previousReceiptSha256: resume ? resume.sha256 : null,
    startedAt: new Date(start).toISOString(), notAfter: new Date(deadline).toISOString() });
  try {
    const active = await get("ops/raw-index/active.json", io.receiptBucket, Math.min(256 * 1024, remaining()), false);
    if (active === null) throw new Error("[raw-audit] active欠測");
    const activeValue = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(active.body));
    if (activeValue.version !== 1 || activeValue.planId !== opts.planId || activeValue.manifestSha256 !== opts.manifestSha256 || Object.keys(activeValue).length !== 3)
      throw new Error("[raw-audit] active fixed manifest不一致");
    const manifestKey = `ops/raw-index/${opts.planId}/manifest.json`;
    const rawManifest = await get(manifestKey, io.receiptBucket, Math.min(64 * 1024 ** 2, remaining()), false);
    if (rawManifest === null || hash(rawManifest.body) !== opts.manifestSha256) throw new Error("[raw-audit] manifest fullSHA不一致");
    const manifest = parseRawManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawManifest.body)), opts, io.rawBucket);
    if (resume) {
      const costs = checkpoint.stats;
      checkpoint = resumeCheckpoint(resume.bytes, resume.sha256, contract, manifest.items);
      checkpoint.stats = costs;
    }
    const totalRawBytes = manifest.items.reduce((sum, item) => sum + item.sizeBytes, 0);
    if (!Number.isSafeInteger(totalRawBytes)) throw new Error("[raw-audit] total raw bytes overflow");
    await io.emit({ phase: "manifest", sha256: opts.manifestSha256, bytes: rawManifest.body.length, etag: rawManifest.etag,
      totalRawBytes, minimumFullRawGets: manifest.items.length, minimumFullIndexReads: Math.ceil(manifest.items.length / 100) });
    const first = checkpoint.cursor;
    let stopReason = "manifest_end";
    while (checkpoint.cursor < manifest.items.length) {
      if (checkpoint.cursor - first >= opts.limit) { stopReason = "item_limit"; break; }
      if (io.now() + 65_000 > deadline) { stopReason = "time_budget"; break; }
      if (checkpoint.stats.requests + 2 > opts.maxRequests || remaining() < 1) { stopReason = "read_budget"; break; }
      const batch = manifest.items.slice(checkpoint.cursor, Math.min(checkpoint.cursor + 100, first + opts.limit));
      let d1Measured = false, d1Attempted = false;
      let rows: RawIndexRow[];
      try {
        rows = await io.index(batch.map(item => item.sha256), { signal, maxBytes: Math.min(1024 * 1024, remaining()),
          beforeRequest: async () => { await request("d1", { shas: batch.map(item => item.sha256) }); d1Attempted = true; }, onRead: async (body, complete) => {
            d1Measured = true; checkpoint.stats.receivedBytes += body.length; observedBytes += body.length;
            await io.emit({ phase: "index_response", complete, bytes: body.length, sha256: hash(body) });
          } });
      } finally { if (d1Attempted && !d1Measured) checkpoint.stats.unmeasuredResponses++; }
      if (new Set(rows.map(row => row.sha256)).size !== rows.length || rows.some(row => !batch.some(item => item.sha256 === row.sha256))) throw new Error("[raw-audit] index scope/duplicate不一致");
      for (const item of batch) {
        const row = rows.find(row => row.sha256 === item.sha256);
        const index = row === undefined ? null : row;
        let body: ItemProof["body"] = null;
        if (index !== null) {
          let valid = true; try { validateIndex(index, item, io.rawBucket); } catch { valid = false; }
          if (valid) {
            if (checkpoint.stats.requests >= opts.maxRequests || item.sizeBytes > remaining() || io.now() + 65_000 > deadline) { stopReason = "read_budget_or_time"; break; }
            const got = await get(index.r2_key, io.rawBucket, Math.max(1, item.sizeBytes), true);
            if (got !== null) {
              body = { sha256: hash(got.body), sizeBytes: got.body.length, etag: got.etag };
              try { validateBody(got.body, item); } catch { /* Record mismatch explicitly below; do not substitute bytes. */ }
            }
          }
        }
        const proof: ItemProof = { phase: "item", position: checkpoint.cursor, sha256: item.sha256, observedAt: new Date(io.now()).toISOString(),
          key: index === null ? null : index.r2_key, index, body, ...qualifyRawAuditItem(item, index, io.rawBucket, body) };
        await io.emit(proof); advance(checkpoint, proof);
      }
      if (stopReason !== "manifest_end") break;
    }
    checkpoint.elapsedMs = prior.elapsedMs + io.now() - start;
    const status = checkpoint.cursor === manifest.items.length ? "complete" : "partial";
    const result = { phase: "summary", status, stopReason, checkpoint, integrityAccepted: status === "complete" && checkpoint.integrityHolds === 0,
      semanticFullyQualified: status === "complete" && checkpoint.integrityHolds === 0 && checkpoint.semanticHolds === 0,
      observedBytesThisRun: observedBytes, requestsThisRun: observedRequests, elapsedMs: io.now() - start,
      observationKind: "sequential_as_observed_not_atomic_current_snapshot", semanticQualificationScope: "manifest_doc_id_and_fetch_clock_only", writerPoolConsumed: 0, writes: 0, notion: 0, sourceGets: 0 };
    await io.emit(result); return result;
  } catch (error) {
    checkpoint.elapsedMs = prior.elapsedMs + io.now() - start;
    await io.emit({ phase: "stopped", checkpoint, elapsedMs: io.now() - start, errorClass: error instanceof Error ? error.name : "unknown",
      messageSha256: hash(error instanceof Error ? error.message : String(error)), resumeAuthorized: false, writes: 0 });
    throw error;
  }
}

async function main() {
  const required = ["plan-id", "cutoff", "expected-count", "manifest-sha256", "limit", "max-bytes", "max-requests", "max-seconds", "out"];
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const m = /^--([a-z0-9-]+)=(.+)$/.exec(arg);
    if (!m || ![...required, "resume", "resume-sha256"].includes(m[1]!) || args.has(m[1]!)) throw new Error("[raw-audit] 引数不正/重複");
    args.set(m[1]!, m[2]!);
  }
  if (required.some(key => !args.has(key)) || args.has("resume") !== args.has("resume-sha256") || sharedEnv.LOCAL_OUT() !== undefined) throw new Error("[raw-audit] 全引数明示/LOCAL_OUT禁止");
  const opts: RawAuditOptions = { planId: args.get("plan-id")!, cutoff: args.get("cutoff")!, expectedCount: Number(args.get("expected-count")), manifestSha256: args.get("manifest-sha256")!,
    limit: Number(args.get("limit")), maxBytes: Number(args.get("max-bytes")), maxRequests: Number(args.get("max-requests")), maxSeconds: Number(args.get("max-seconds")) };
  assertOptions(opts);
  const sources = [import.meta.url, "./raw-index-backfill.ts", "./raw-index-plan.ts", "../vwap/lib/r2.ts", "../../src/shared/env.ts", "../../src/shared/db/d1-http-client.ts", "../../src/shared/zod-mini.ts",
    "../../package.json", "../../pnpm-lock.yaml", "../../flake.nix", "../../flake.lock"];
  const sourceSha256 = hash(encoded(await Promise.all(sources.map(async file => hash(await fs.readFile(fileURLToPath(file === import.meta.url ? file : new URL(file, import.meta.url))))))));
  let resume: { bytes: Uint8Array; sha256: string } | undefined;
  if (args.has("resume")) {
    const handle = await fs.open(args.get("resume")!, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 256 * 1024 ** 2) throw new Error("[raw-audit] resume file有限上限超過");
      const bytes = Buffer.alloc(stat.size);
      let read = 0;
      while (read < bytes.length) { const next = await handle.read(bytes, read, bytes.length - read, read); if (next.bytesRead === 0) break; read += next.bytesRead; }
      if (read !== stat.size || (await handle.stat()).size !== stat.size) throw new Error("[raw-audit] resume file読取中に変化");
      resume = { bytes, sha256: args.get("resume-sha256")! };
    } finally { await handle.close(); }
  }
  const out = await fs.open(args.get("out")!, "wx", 0o600);
  try {
    const result = await auditRawIndex(opts, { rawBucket: sharedEnv.R2_BUCKET_RAW(), receiptBucket: sharedEnv.R2_BUCKET(), sourceSha256,
      get: r2GetBytesVersion, index: readRawIndexes, now: Date.now,
      emit: async record => { await out.write(encoded(record) + "\n"); await out.sync(); } }, resume);
    console.info(encoded({ status: result.status, cursor: result.checkpoint.cursor, integrityHolds: result.checkpoint.integrityHolds,
      semanticHolds: result.checkpoint.semanticHolds, stats: result.checkpoint.stats, writes: 0 }));
    if (!result.integrityAccepted || !result.semanticFullyQualified) process.exitCode = 1;
  } finally { await out.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(() => { console.error("[raw-audit] 停止。private receiptを確認してください（生原文/認証値は出力しません）"); process.exitCode = 1; });
