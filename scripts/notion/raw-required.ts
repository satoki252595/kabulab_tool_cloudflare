/** 最新のJSF shinaだけをread-onlyで確認する。歴史manifest/state/poolへ接続しない。 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sharedEnv } from "../../src/shared/env.js";
import { assertD1SingleQueryResponse, d1HttpQueryUrl } from "../../src/shared/db/d1-http-client.js";
import { findLatestShinaRawFile, type CanonicalRawFile } from "../../src/shared/notion-archive/raw-files.js";
import { setNotionMaxRps, type NotionRequestOptions } from "../../src/shared/notion-archive/client.js";
import { r2GetBytesVersion } from "../vwap/lib/r2.js";
import { parseRawManifest, readRawIndexes, validateBody, validateIndex } from "./raw-index-backfill.js";
import { canonicalRawKey, verifiedDocId } from "./raw-index-plan.js";
import { parseShina } from "../../services/jss-api/src/shared/shina-parser.js";

type IndexReadOptions = Parameters<typeof readRawIndexes>[1];
type LatestIndex = { sha256: string; last_fetched_at: number };
export interface RequiredRawIo {
  rawBucket: string;
  latest: (options: NotionRequestOptions) => Promise<CanonicalRawFile>;
  index: typeof readRawIndexes;
  latestIndex: (options: IndexReadOptions) => Promise<LatestIndex[]>;
  get: typeof r2GetBytesVersion;
  now: () => number;
  emit: (record: object) => Promise<void>;
}

/** production consumerと同じ最新選択。SHA限定readと独立に、選ばれる原本を確認する。 */
export async function readLatestShinaIndexCandidates(options: IndexReadOptions): Promise<LatestIndex[]> {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(60_000)]);
  await options.beforeRequest(); signal.throwIfAborted();
  const response = await fetch(d1HttpQueryUrl(), { method: "POST", signal,
    headers: { Authorization: `Bearer ${sharedEnv.CLOUDFLARE_API_TOKEN()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql: "SELECT sha256,last_fetched_at FROM jss_raw_files WHERE source = ? AND datatype = ? AND scope = ? ORDER BY last_fetched_at DESC LIMIT 2", params: ["日証金", "shina", "ALL"] }) });
  if (response.body === null) throw new Error("[raw-required] D1 latest body missing");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0, complete = false;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.length; chunks.push(next.value);
      if (bytes > options.maxBytes) throw new Error("[raw-required] D1 latest byte limit");
    }
    complete = true;
  } finally {
    try { await reader.cancel(); } finally { await options.onRead(Buffer.concat(chunks, bytes), complete); }
  }
  if (!response.ok) throw new Error("[raw-required] D1 latest HTTP failure");
  const rows = assertD1SingleQueryResponse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))));
  if (rows.length > 2 || new Set(rows.map(row => row.sha256)).size !== rows.length || rows.some((row, i) =>
    typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256) ||
    typeof row.last_fetched_at !== "number" || !Number.isSafeInteger(row.last_fetched_at) || row.last_fetched_at < 0 || row.last_fetched_at > 4102444800 ||
    (i > 0 && (rows[i - 1]!.last_fetched_at as number) <= row.last_fetched_at))) throw new Error("[raw-required] D1 latest selection ambiguous");
  return rows as LatestIndex[];
}

export async function runRequiredRawCheck(io: RequiredRawIo, maxSeconds: number) {
  if (!Number.isSafeInteger(maxSeconds) || maxSeconds < 66 || maxSeconds > 600 || !io.rawBucket.trim()) throw new Error("[raw-required] explicit seconds/bucket required");
  const startedAt = io.now(), notAfter = startedAt + maxSeconds * 1000;
  const signal = AbortSignal.timeout(maxSeconds * 1000);
  const reads = { notionMetadata: 0, d1: 0, r2: 0 }, receivedBytes = { d1: 0, r2: 0 };
  const guard = () => { signal.throwIfAborted(); if (io.now() + 65_000 > notAfter) throw new Error("[raw-required] 65s headroom"); };
  const admit = async (kind: keyof typeof reads) => {
    guard();
    if (reads[kind] >= (kind === "d1" ? 2 : 1)) throw new Error("[raw-required] single-attempt read limit");
    await io.emit({ phase: "required_read_intent", kind }); guard(); reads[kind]++;
  };
  try {
    await io.emit({ phase: "required_start", scope: "runtime_latest_shina", startedAt: new Date(startedAt).toISOString(), notAfter: new Date(notAfter).toISOString(), writes: 0 });
    await admit("notionMetadata");
    const raw = await io.latest({ singleAttempt: true, beforeRequest: guard });
    if (raw.source !== "日証金" || raw.datatype !== "shina" || raw.scope !== "ALL" || raw.licenseTag !== "personal-only" ||
        path.extname(raw.filename).toLowerCase() !== ".csv" || raw.dataDate === null || raw.sizeBytes <= 0 || raw.sizeBytes > 2 * 1024 ** 2)
      throw new Error("[raw-required] outside runtime latest shina scope");
    const { sourceUrl: _sourceUrl, ...metadata } = raw;
    const item = parseRawManifest({ version: 1, planId: "runtime-latest-shina", cutoff: new Date(startedAt).toISOString(), expectedCount: 1,
      rawBucket: io.rawBucket, items: [{ ...metadata, docId: verifiedDocId(raw) }] }, { planId: "runtime-latest-shina", expectedCount: 1 }, io.rawBucket).items[0]!;
    await io.emit({ phase: "required_selected", ...metadata });
    const indexOptions: IndexReadOptions = { signal, maxBytes: 1024 * 1024, beforeRequest: () => admit("d1"), onRead: async (body, complete) => {
      receivedBytes.d1 += body.length;
      await io.emit({ phase: "required_index_response", bytes: body.length, complete, sha256: createHash("sha256").update(body).digest("hex") });
    } };
    const finish = async (reason: "verified" | "missing_index" | "missing_raw" | "runtime_latest_differs", index: unknown, bodyVerified: boolean, parsedRows: number | null = null, nativeDataDates: unknown[] | null = null) => {
      const result = { scope: "runtime_latest_shina", status: reason === "verified" ? "required_complete" : reason === "runtime_latest_differs" ? "required_hold" : "required_missing", reason,
        selected: 1, verified: bodyVerified ? 1 : 0, missingIndex: reason === "missing_index" ? 1 : 0, missingRaw: reason === "missing_raw" ? 1 : 0,
        sha256: item.sha256, dataDate: item.dataDate, fetchedAt: item.fetchedAt, reads, receivedBytes,
        observationKind: "sequential_as_observed", readCountKind: "admitted_calls_single_attempt", parsedRows, nativeDataDates, writes: 0, sourceGets: 0,
        wholeHistoryAccepted: false, historyCursorChanged: false, elapsedMs: io.now() - startedAt };
      await io.emit({ phase: "required_summary", ...result, index }); return result;
    };
    const rows = await io.index([item.sha256], indexOptions);
    if (rows.length > 1 || rows.some(row => row.sha256 !== item.sha256)) throw new Error("[raw-required] offscope/duplicate index");
    if (rows.length === 0) return finish("missing_index", null, false);
    const index = rows[0]!;
    validateIndex(index, item, io.rawBucket, canonicalRawKey({ ...item, sourceUrl: null }, item.docId));
    if (index.first_fetched_at < 0 || index.last_fetched_at > 4102444800) throw new Error("[raw-required] runtime index clock range");
    const latest = await io.latestIndex({ ...indexOptions, maxBytes: 16 * 1024 });
    if (latest.length > 2 || new Set(latest.map(row => row.sha256)).size !== latest.length || latest.some((row, i) =>
      !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.last_fetched_at) || row.last_fetched_at < 0 || row.last_fetched_at > 4102444800 ||
      (i > 0 && latest[i - 1]!.last_fetched_at <= row.last_fetched_at))) throw new Error("[raw-required] D1 latest selection ambiguous");
    if (latest[0]?.sha256 !== item.sha256 || latest[0].last_fetched_at !== index.last_fetched_at) return finish("runtime_latest_differs", index, false);
    const got = await io.get(index.r2_key, io.rawBucket, { singleAttempt: true, maxBytes: item.sizeBytes, abortSignal: signal,
      beforeAttempt: () => admit("r2"), onRead: async read => {
        receivedBytes.r2 += read.receivedBytes;
        await io.emit({ phase: "required_body_response", complete: read.complete, bytes: read.receivedBytes,
          sha256: createHash("sha256").update(read.body).digest("hex") });
      } });
    if (got === null) return finish("missing_raw", index, false);
    validateBody(got.body, item);
    const parsed = parseShina(Uint8Array.from(got.body).buffer);
    return finish("verified", index, true, parsed.length, [...new Set(parsed.map(row => row.data_date))]);
  } catch (error) {
    await io.emit({ phase: "required_stopped", scope: "runtime_latest_shina", reads, receivedBytes, writes: 0, sourceGets: 0,
      wholeHistoryAccepted: false, elapsedMs: io.now() - startedAt, messageSha256: createHash("sha256").update(error instanceof Error ? error.message : String(error)).digest("hex") });
    throw error;
  }
}

async function main() {
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const match = /^--(out|max-seconds)=(.+)$/.exec(arg);
    if (!match || args.has(match[1]!)) throw new Error("[raw-required] explicit out/max-seconds only");
    args.set(match[1]!, match[2]!);
  }
  const maxSeconds = Number(args.get("max-seconds"));
  if (!args.has("out") || !args.has("max-seconds") || !Number.isSafeInteger(maxSeconds) || maxSeconds < 66 || maxSeconds > 600 || sharedEnv.LOCAL_OUT() !== undefined)
    throw new Error("[raw-required] explicit out/max-seconds, remote only");
  setNotionMaxRps(0.25);
  const receipt = await fs.open(args.get("out")!, "wx", 0o600);
  try {
    const result = await runRequiredRawCheck({ rawBucket: sharedEnv.R2_BUCKET_RAW(), latest: findLatestShinaRawFile, index: readRawIndexes,
      latestIndex: readLatestShinaIndexCandidates, get: r2GetBytesVersion, now: Date.now,
      emit: async record => { await receipt.write(`${JSON.stringify(record)}\n`); await receipt.sync(); } }, maxSeconds);
    console.info(JSON.stringify(result));
    if (result.status !== "required_complete") process.exitCode = 1;
  } finally { await receipt.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error(JSON.stringify({ scope: "runtime_latest_shina", status: "stopped", writes: 0, sourceGets: 0 })); process.exitCode = 1; });
}
