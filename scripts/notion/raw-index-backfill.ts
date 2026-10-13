/**
 * ⑤保存原本だけからR2/D1を補完する明示手動CLI。通常cronから呼ばない。
 * dotenv/configが.envを読む。GHは同名の既存secretを渡す。
 * --mode=dry|apply --plan-id=<安全ID> --limit=50 --max-bytes=67108864
 * --max-seconds=1200 --expected-count=78831 --out=<private.jsonl>
 * 同plan-idを再開する。別planへ逃げてunknown latchを消せないactive pointerを持つ。
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "../../src/shared/zod-mini.js";
import { sharedEnv } from "../../src/shared/env.js";
import { assertD1SingleQueryResponse, createD1HttpBatchSender, d1HttpQueryUrl } from "../../src/shared/db/d1-http-client.js";
import { assertCanonicalRawMetadata, findCanonicalRawFileAttachments, listCanonicalRawFiles, type CanonicalRawAttachment } from "../../src/shared/notion-archive/raw-files.js";
import { notionStats } from "../../src/shared/notion-archive/client.js";
import { downloadArchivedFile } from "../moneyflow/lib/archived-files.js";
import { unzip } from "../../services/yuho-quant/src/services/edinet/zip.js";
import { r2GetBytesVersion, r2PutBytes } from "../vwap/lib/r2.js";
import { canonicalRawKey, readD1RawIndexes, verifiedDocId } from "./raw-index-plan.js";

const digest = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const hashSchema = z.string().check(z.regex(/^[a-f0-9]{64}$/));
const integer = z.number().check(z.int(), z.minimum(0));
const Raw = z.strictObject({
  pageId: z.string().check(z.regex(/^[a-fA-F0-9-]{32,36}$/)), sha256: hashSchema,
  filename: z.string().check(z.regex(/^[^/\\]+$/)), sizeBytes: integer,
  source: z.enum(["EDINET", "TDnet", "yfinance", "stooq", "JPX", "日証金", "計算"]),
  datatype: z.string().check(z.minLength(1)), scope: z.string().check(z.minLength(1)),
  dataDate: z.nullable(z.iso.date()), fetchedAt: z.string().check(z.minLength(1)),
  licenseTag: z.enum(["commercial-ok", "factual-cite", "personal-only"]),
  convertStatus: z.enum(["完了", "失敗", "対象外"]), hostedAttachments: integer,
  docId: z.nullable(z.string().check(z.regex(/^S[0-9A-Z]+$/))),
});
export type RawItem = z.infer<typeof Raw>;
const Manifest = z.strictObject({ version: z.literal(1), planId: z.string(), cutoff: z.iso.datetime(), expectedCount: integer,
  rawBucket: z.string(), items: z.array(Raw) });
export type RawManifest = z.infer<typeof Manifest>;
const Inflight = z.strictObject({ sha256: hashSchema, key: z.string(), phase: z.enum(["raw_inflight", "index_inflight"]) });
const State = z.strictObject({ version: z.literal(1), manifestSha256: hashSchema, cursor: integer, inflight: z.nullable(Inflight) });
export type RawState = z.infer<typeof State>;
const Active = z.strictObject({ version: z.literal(1), planId: z.string(), manifestSha256: hashSchema });
const Complete = z.strictObject({ version: z.literal(1), manifestSha256: hashSchema, completedAt: z.iso.datetime(),
  canonicalCount: integer, r2FullShaVerifiedCount: integer, indexAntiJoinChecked: integer, indexAntiJoinMissing: z.literal(0) });
export interface RawBackfillOptions {
  mode: "dry" | "apply"; planId: string; limit: number; maxBytes: number; maxSeconds: number; expectedCount: number;
}
export interface RawIndexRow {
  sha256: string; r2_bucket: string; r2_key: string; source: string; datatype: string; scope: string;
  doc_id: string | null; code: string | null; data_date: string | null; ext: string; size_bytes: number;
  license_tag: string; convert_status: string; first_fetched_at: number; last_fetched_at: number;
}
type Version = { body: Uint8Array; etag: string } | null;
export interface BackfillIo {
  rawBucket: string; receiptBucket: string;
  get: (key: string, bucket: string) => Promise<Version>;
  put: (key: string, bytes: Uint8Array, previous: string | null, bucket: string, contentType: string) => Promise<void>;
  list: typeof listCanonicalRawFiles;
  download: (item: RawItem, cohort: readonly RawItem[]) => Promise<{ body: Uint8Array; wireBytes: number }>;
  index: (sha: string) => Promise<RawIndexRow | null>;
  insert: (row: RawIndexRow) => Promise<void>;
  antiJoin: (items: readonly RawItem[]) => Promise<{ checked: number; missing: number }>;
  now: () => number;
  emit: (record: object) => Promise<void>; // caller fsyncs before remote mutation.
}

export function validateRawOptions(opts: RawBackfillOptions): void {
  if (!["dry", "apply"].includes(opts.mode) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(opts.planId) ||
      !Number.isSafeInteger(opts.limit) || opts.limit < 1 || opts.limit > 100_000 ||
      !Number.isSafeInteger(opts.maxBytes) || opts.maxBytes < 1 || opts.maxBytes > 64 * 1024 ** 3 ||
      !Number.isSafeInteger(opts.maxSeconds) || opts.maxSeconds < 1 || opts.maxSeconds > 19_800 ||
      !Number.isSafeInteger(opts.expectedCount) || opts.expectedCount < 1 || opts.expectedCount > 100_000) {
    throw new Error("[raw-backfill] mode/plan/count/bytes/seconds予算が不正です");
  }
}
export function parseRawManifest(value: unknown, opts: RawBackfillOptions, bucket: string): RawManifest {
  const manifest = Manifest.parse(value);
  if (manifest.planId !== opts.planId || manifest.rawBucket !== bucket || manifest.expectedCount !== opts.expectedCount ||
      manifest.items.length !== opts.expectedCount || new Set(manifest.items.map((r) => r.sha256)).size !== manifest.items.length ||
      new Set(manifest.items.map((r) => r.pageId)).size !== manifest.items.length ||
      manifest.items.some((r, i) => !Number.isFinite(Date.parse(r.fetchedAt)) || r.hostedAttachments < 1 ||
        (i > 0 && manifest.items[i - 1]!.sha256 >= r.sha256))) throw new Error("[raw-backfill] manifest集合/count/orderが不一致です");
  // 原本日付・キー・拡張子の欠測を推定補完しない。署名URLはschema自体が拒否。
  for (const item of manifest.items) canonicalRawKey({ ...item, sourceUrl: null }, item.docId);
  return manifest;
}
function validateBody(body: Uint8Array, item: RawItem): void {
  if (body.length !== item.sizeBytes || digest(body) !== item.sha256) throw new Error("[raw-backfill] 原本全body SHA/サイズ不一致");
}
export function expectedRawIndex(item: RawItem, bucket: string, key: string): RawIndexRow {
  const epoch = Math.floor(Date.parse(item.fetchedAt) / 1000);
  if (!Number.isSafeInteger(epoch)) throw new Error("[raw-backfill] 取得時計を確定できません");
  return { sha256: item.sha256, r2_bucket: bucket, r2_key: key, source: item.source, datatype: item.datatype, scope: item.scope,
    doc_id: item.docId, code: item.scope === "ALL" ? null : item.scope, data_date: item.dataDate,
    ext: path.extname(item.filename).slice(1).toLowerCase(), size_bytes: item.sizeBytes, license_tag: item.licenseTag,
    convert_status: item.convertStatus, first_fetched_at: epoch, last_fetched_at: epoch };
}
function validateIndex(row: RawIndexRow, item: RawItem, bucket: string, expectedKey?: string): void {
  const expected = expectedRawIndex(item, bucket, row.r2_key);
  if (!row.r2_key.startsWith("raw/") || (expectedKey !== undefined && row.r2_key !== expectedKey) ||
      (Object.keys(expected) as Array<keyof RawIndexRow>).some((key) => {
        // 既存writerの取得履歴・旧doc_id欠測を上書きしない。nullは理由付きのまま保持。
        if (key === "first_fetched_at" || key === "last_fetched_at") return !Number.isSafeInteger(row[key]);
        if (key === "doc_id" && (row.doc_id === null || item.docId === null)) return false;
        return row[key] !== expected[key];
      }) || row.first_fetched_at > row.last_fetched_at) throw new Error("[raw-backfill] D1索引と⑤metadata/keyが不一致");
}

/** hosted原本を全文取得。Notionが非対応拡張子をZIPで包んだ時だけ、単一実名memberを解く。 */
export function createRawDownloader(find = findCanonicalRawFileAttachments, download = downloadArchivedFile): BackfillIo["download"] {
  let cache = new Map<string, CanonicalRawAttachment>();
  return async (item, cohort) => {
    if (!cache.has(item.sha256)) {
      cache = await find(cohort.map((row) => row.sha256));
      if (cache.size !== cohort.length) throw new Error("[raw-backfill] ⑤原本のSHA batchが欠測しています");
      for (const row of cohort) {
        const current = cache.get(row.sha256);
        if (!current) throw new Error("[raw-backfill] ⑤原本のSHA batchが不一致です");
        const { docId, ...metadata } = row;
        assertCanonicalRawMetadata(metadata, current.raw);
        if (verifiedDocId(current.raw) !== docId) throw new Error("[raw-backfill] 原本文書IDがmanifestから変化しました");
      }
    }
    const { file } = cache.get(item.sha256)!;
    const wire = await download(file, "⑤raw-index");
    let body = wire;
    if (file.name !== item.filename) {
      if (file.name !== `${item.filename}.zip`) throw new Error("[raw-backfill] 原本ZIP wrapper名不一致");
      const members = unzip(Buffer.from(wire), { maxEntries: 1, maxExpandedBytes: item.sizeBytes });
      if (members.size !== 1 || !members.has(item.filename)) throw new Error("[raw-backfill] 原本ZIP wrapperは単一実名memberではありません");
      body = members.get(item.filename)!;
    }
    validateBody(body, item);
    return { body, wireBytes: wire.length };
  };
}

/** 一意SHAだけをread。原本metadataを書き換えるUPDATE/UPSERTは使わない。 */
export async function readRawIndex(sha: string): Promise<RawIndexRow | null> {
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error("[raw-backfill] D1 SHA不正");
  const response = await fetch(d1HttpQueryUrl(), { method: "POST", headers: {
    Authorization: `Bearer ${sharedEnv.CLOUDFLARE_API_TOKEN()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql: "SELECT sha256,r2_bucket,r2_key,source,datatype,scope,doc_id,code,data_date,ext,size_bytes,license_tag,convert_status,first_fetched_at,last_fetched_at FROM jss_raw_files WHERE sha256=?", params: [sha] }) });
  if (!response.ok) throw new Error(`[raw-backfill] D1 read HTTP ${response.status}`);
  const rows = assertD1SingleQueryResponse(await response.json());
  if (rows.length > 1) throw new Error("[raw-backfill] D1 SHA重複");
  if (rows.length === 0) return null;
  const row = rows[0]!;
  if (row.sha256 !== sha || ["r2_bucket", "r2_key", "source", "datatype", "scope", "ext", "license_tag", "convert_status"].some((k) => typeof row[k] !== "string" || row[k] === "") ||
      ["doc_id", "code", "data_date"].some((k) => row[k] !== null && typeof row[k] !== "string") ||
      ["size_bytes", "first_fetched_at", "last_fetched_at"].some((k) => typeof row[k] !== "number" || !Number.isSafeInteger(row[k]))) throw new Error("[raw-backfill] D1 object行契約不正");
  return row as unknown as RawIndexRow;
}
export async function insertRawIndex(row: RawIndexRow): Promise<void> {
  const columns = Object.keys(row) as Array<keyof RawIndexRow>;
  // 競合の後勝ちを禁止。単一INSERTはnative atomic、共有senderは単発・strict ACK。
  await createD1HttpBatchSender()([{ sql: `INSERT INTO jss_raw_files (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`, params: columns.map((key) => row[key]) }]);
}

/** 完了時に固定canonical集合をD1へ再突合する。78k全表を繰り返し走査せずPK IN<=100。 */
export async function auditRawIndexMembership(items: readonly RawItem[], bucket: string): Promise<{ checked: number; missing: number }> {
  let missing = 0;
  for (let offset = 0; offset < items.length; offset += 100) {
    const batch = items.slice(offset, offset + 100), rows = await readD1RawIndexes(batch.map((item) => item.sha256));
    if (new Set(rows.map((row) => row.sha256)).size !== rows.length || rows.some((row) => !batch.some((item) => item.sha256 === row.sha256))) throw new Error("[raw-backfill] 完了anti-joinに未知/重複SHA");
    for (const row of rows) {
      const item = batch.find((item) => item.sha256 === row.sha256)!;
      if (row.r2_bucket !== bucket || !row.r2_key.startsWith("raw/") || row.size_bytes !== item.sizeBytes || row.source !== item.source ||
          row.datatype !== item.datatype || row.scope !== item.scope || row.data_date !== item.dataDate || row.license_tag !== item.licenseTag) throw new Error("[raw-backfill] 完了anti-join metadata不一致");
    }
    missing += batch.filter((item) => !rows.some((row) => row.sha256 === item.sha256)).length;
  }
  return { checked: items.length, missing };
}

export async function runRawBackfill(opts: RawBackfillOptions, io: BackfillIo) {
  validateRawOptions(opts);
  const start = io.now(), deadline = start + opts.maxSeconds * 1000;
  // 一度開始した原本1件はinflightを解決するまで完結。次の原本は期限後に開始しない。
  // hard timeout/runner消失では永続inflightが次runの無条件再送を止める。
  let processingItem = false;
  const checkClock = () => { if (!processingItem && io.now() >= deadline) throw new Error("[raw-backfill] 準備の時間予算到達。未完manifestを使わず停止"); };
  const stats = { inventoryRows: 0, processed: 0, verified: 0, alreadyComplete: 0, wouldPut: 0, wouldIndex: 0,
    rawGets: 0, rawPuts: 0, rawGetBytes: 0, rawPutBytes: 0, notionDownloads: 0, notionDownloadBytes: 0,
    d1Reads: 0, d1Inserts: 0, receiptGets: 0, receiptPuts: 0, receiptBytes: 0, upstreamGets: 0 };
  const prefix = `ops/raw-index/${opts.planId}`, activeKey = "ops/raw-index/active.json";
  const controlGet = async (key: string) => { checkClock(); stats.receiptGets++; const got = await io.get(key, io.receiptBucket); if (got) stats.receiptBytes += got.body.length; return got; };
  const persist = async (key: string, value: unknown, previous: Version): Promise<NonNullable<Version>> => {
    const body = encode(value);
    await io.emit({ phase: "receipt_inflight", key, sha256: digest(body), bytes: body.length });
    checkClock(); stats.receiptPuts++; stats.receiptBytes += body.length;
    await io.put(key, body, previous === null ? null : previous.etag, io.receiptBucket, "application/json");
    const read = await controlGet(key);
    if (read === null || !Buffer.from(read.body).equals(Buffer.from(body))) throw new Error("[raw-backfill] receipt全文読戻し不一致。再送禁止");
    return read;
  };
  const parseJson = (version: NonNullable<Version>): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(version.body));
  const active = await controlGet(activeKey);
  let activePin: z.infer<typeof Active> | null = null;
  if (active) {
    activePin = Active.parse(parseJson(active));
    if (activePin.planId !== opts.planId) throw new Error("[raw-backfill] 別planがactiveです。unknownを別planで迂回できません");
  }
  const manifestVersion = await controlGet(`${prefix}/manifest.json`);
  let manifest: RawManifest;
  if (manifestVersion === null) {
    if (activePin) throw new Error("[raw-backfill] active manifestが欠落しています");
    const cutoff = new Date(io.now()).toISOString(), rows = await io.list(cutoff, checkClock);
    const items = rows.map((row) => { const { sourceUrl: _url, ...safe } = row; return { ...safe, docId: verifiedDocId(row) }; });
    manifest = parseRawManifest({ version: 1, planId: opts.planId, cutoff, expectedCount: opts.expectedCount, rawBucket: io.rawBucket, items }, opts, io.rawBucket);
    if (opts.mode === "apply") await persist(`${prefix}/manifest.json`, manifest, null);
  } else manifest = parseRawManifest(parseJson(manifestVersion), opts, io.rawBucket);
  const manifestSha = digest(encode(manifest));
  if (activePin && activePin.manifestSha256 !== manifestSha) throw new Error("[raw-backfill] active manifest SHA不一致");
  if (!activePin && opts.mode === "apply") await persist(activeKey, { version: 1, planId: opts.planId, manifestSha256: manifestSha }, null);
  stats.inventoryRows = manifest.items.length;
  await io.emit({ phase: "manifest", planId: opts.planId, cutoff: manifest.cutoff, count: manifest.items.length, manifestSha256: manifestSha, mode: opts.mode });
  let stateVersion = await controlGet(`${prefix}/state.json`);
  let state: RawState = stateVersion === null ? { version: 1, manifestSha256: manifestSha, cursor: 0, inflight: null } : State.parse(parseJson(stateVersion));
  if (state.manifestSha256 !== manifestSha || state.cursor > manifest.items.length ||
      (state.inflight !== null && state.inflight.sha256 !== manifest.items[state.cursor]?.sha256)) throw new Error("[raw-backfill] state/manifest/cursor不一致");
  const saveState = async (next: RawState) => {
    stateVersion = await persist(`${prefix}/state.json`, next, stateVersion); state = next;
  };
  if (stateVersion === null && opts.mode === "apply") await saveState(state);
  const readIndex = async (item: RawItem) => { checkClock(); stats.d1Reads++; return io.index(item.sha256); };
  const readBody = async (key: string, item: RawItem) => {
    checkClock(); stats.rawGets++;
    const got = await io.get(key, io.rawBucket);
    if (got) { stats.rawGetBytes += got.body.length; validateBody(got.body, item); }
    return got;
  };
  let budgetReserved = 0, stoppedByBudget = false, budgetStopReason: "seconds" | "bytes" | null = null;
  while (state.cursor < manifest.items.length && stats.processed < opts.limit) {
    if (io.now() >= deadline) { stoppedByBudget = true; budgetStopReason = "seconds"; break; }
    const item = manifest.items[state.cursor]!;
    // 先にworst-case raw転送を予約。原本を切り詰めず、次runへ丸ごと残す。
    const wrapperOverhead = Math.ceil(item.sizeBytes * 0.001) + 4096;
    const reserve = item.sizeBytes * 4 + wrapperOverhead;
    if (budgetReserved + reserve > opts.maxBytes) { stoppedByBudget = true; budgetStopReason = "bytes"; break; }
    budgetReserved += reserve;
    processingItem = true;
    let index = await readIndex(item);
    if (index) validateIndex(index, item, io.rawBucket);
    let key = state.inflight !== null ? state.inflight.key : index ? index.r2_key : canonicalRawKey({ ...item, sourceUrl: null }, item.docId);
    if (state.inflight && index && key !== index.r2_key) throw new Error("[raw-backfill] inflight/index key不一致");
    let body = await readBody(key, item);
    if (state.inflight !== null) {
      if (body === null) throw new Error("[raw-backfill] inflight原本が未確認。PUTを再送せず保全停止");
      if (state.inflight.phase === "index_inflight" && index === null) throw new Error("[raw-backfill] inflight索引が未確認。INSERTを再送せず保全停止");
    } else if (body === null && index === null && item.docId !== null) {
      const legacyKey = canonicalRawKey({ ...item, sourceUrl: null }, null);
      body = await readBody(legacyKey, item);
      if (body) key = legacyKey; // 実在する旧キーだけを採用。代替値の生成ではない。
    }
    if (index !== null && body === null) throw new Error("[raw-backfill] D1索引先原本が欠落。再作成せず停止");
    if (index !== null && body !== null) { stats.alreadyComplete++; stats.verified++; }
    else {
      if (body === null) {
        checkClock(); stats.notionDownloads++;
        const saved = await io.download(item, manifest.items.slice(state.cursor, state.cursor + 50));
        stats.notionDownloadBytes += saved.wireBytes;
        validateBody(saved.body, item);
        if (saved.wireBytes > item.sizeBytes + wrapperOverhead) throw new Error("[raw-backfill] hosted物理転送が予約予算を超えました");
        stats.wouldPut++;
        if (opts.mode === "apply") {
          await saveState({ ...state, inflight: { sha256: item.sha256, key, phase: "raw_inflight" } });
          await io.emit({ phase: "raw_inflight", sha256: item.sha256, key, bytes: item.sizeBytes });
          checkClock(); stats.rawPuts++; stats.rawPutBytes += saved.body.length;
          await io.put(key, saved.body, null, io.rawBucket, "application/octet-stream");
          body = await readBody(key, item);
          if (body === null) throw new Error("[raw-backfill] PUT後の原本全文確認ができません。再送禁止");
        }
      }
      stats.wouldIndex++;
      if (opts.mode === "apply") {
        if (body === null) throw new Error("[raw-backfill] R2全文確認前の索引は禁止");
        // 直前の別writerをreadで照合。同値ならINSERTしない、不一致は止める。
        index = await readIndex(item);
        if (index !== null) validateIndex(index, item, io.rawBucket, key);
        else {
          await saveState({ ...state, inflight: { sha256: item.sha256, key, phase: "index_inflight" } });
          await io.emit({ phase: "index_inflight", sha256: item.sha256, key });
          checkClock(); stats.d1Inserts++;
          await io.insert(expectedRawIndex(item, io.rawBucket, key));
          index = await readIndex(item);
          if (index === null) throw new Error("[raw-backfill] INSERT後索引readback欠測。再送禁止");
          validateIndex(index, item, io.rawBucket, key);
        }
        stats.verified++;
      }
    }
    await io.emit({ phase: opts.mode === "dry" ? "planned" : "verified", sha256: item.sha256, bytes: item.sizeBytes,
      key, notionPageId: item.pageId, r2FullShaVerified: body !== null, d1IndexVerified: index !== null,
      legacyDocIdMissing: index !== null && index.doc_id === null && item.docId !== null,
      docIdStatus: item.docId !== null ? index !== null && index.doc_id === null ? "archived_id_verified_index_legacy_null" : "verified_edinet_source_url"
        : index !== null && index.doc_id !== null ? "retained_existing_unverified" : "not_proven_from_archived_metadata" });
    stats.processed++;
    const next: RawState = { ...state, cursor: state.cursor + 1, inflight: null };
    if (opts.mode === "apply") await saveState(next); else state = next;
    processingItem = false;
  }
  let antiJoin: { checked: number; missing: number } | null = null;
  if (opts.mode === "apply" && state.cursor === manifest.items.length && io.now() >= deadline) {
    stoppedByBudget = true; budgetStopReason = "seconds"; // 次runは完了検証だけを再開する。
  } else if (opts.mode === "apply" && state.cursor === manifest.items.length) {
    processingItem = true; // 開始済み最終anti-join/receiptを完結する。rawの新規取得は0。
    antiJoin = await io.antiJoin(manifest.items);
    if (antiJoin.checked !== manifest.items.length || antiJoin.missing !== 0) throw new Error("[raw-backfill] 完了anti-joinに未索引があります。全件成功としない");
    // 最終membership検証も永続化。cursorだけではanti-join完了と認定しない。
    const proofKey = `${prefix}/complete.json`, previousProof = await controlGet(proofKey);
    if (previousProof === null) await persist(proofKey, { version: 1, manifestSha256: manifestSha, completedAt: new Date(io.now()).toISOString(),
      canonicalCount: manifest.items.length, r2FullShaVerifiedCount: state.cursor, indexAntiJoinChecked: antiJoin.checked, indexAntiJoinMissing: 0 }, null);
    else {
      const proof = Complete.parse(parseJson(previousProof));
      if (proof.manifestSha256 !== manifestSha || proof.canonicalCount !== manifest.items.length || proof.r2FullShaVerifiedCount !== state.cursor ||
          proof.indexAntiJoinChecked !== manifest.items.length) throw new Error("[raw-backfill] 先行完了receiptと集合が不一致");
    }
    processingItem = false;
  }
  const result = { ...stats, mode: opts.mode, manifestSha256: manifestSha, cursor: state.cursor, remaining: manifest.items.length - state.cursor,
    status: antiJoin !== null && opts.mode === "apply" ? "snapshot_complete" : "partial",
    stoppedByBudget, budgetStopReason, limitReached: stats.processed === opts.limit && state.cursor < manifest.items.length,
    indexAntiJoin: antiJoin, indexAntiJoinRequests: antiJoin === null ? 0 : Math.ceil(antiJoin.checked / 100),
    elapsedMs: io.now() - start, rawTransferBytes: stats.rawGetBytes + stats.rawPutBytes + stats.notionDownloadBytes };
  await io.emit({ phase: "summary", ...result });
  return result;
}

async function main() {
  const allowed = ["mode", "plan-id", "limit", "max-bytes", "max-seconds", "expected-count", "out"];
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const m = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!m || !allowed.includes(m[1]!) || args.has(m[1]!)) throw new Error("[raw-backfill] 引数不正/重複");
    args.set(m[1]!, m[2]!);
  }
  if (allowed.some((key) => !args.has(key)) || sharedEnv.LOCAL_OUT() !== undefined) throw new Error("[raw-backfill] 全引数明示・LOCAL_OUT禁止");
  const opts: RawBackfillOptions = { mode: args.get("mode") as "dry" | "apply", planId: args.get("plan-id")!, limit: Number(args.get("limit")),
    maxBytes: Number(args.get("max-bytes")), maxSeconds: Number(args.get("max-seconds")), expectedCount: Number(args.get("expected-count")) };
  validateRawOptions(opts);
  const receipt = await fs.open(args.get("out")!, "wx", 0o600), before = notionStats();
  const emit = async (record: object) => { await receipt.write(`${JSON.stringify(record)}\n`); await receipt.sync(); };
  try {
    const result = await runRawBackfill(opts, { rawBucket: sharedEnv.R2_BUCKET_RAW(), receiptBucket: sharedEnv.R2_BUCKET(),
      get: (key, bucket) => r2GetBytesVersion(key, bucket, { singleAttempt: true }), put: r2PutBytes,
      list: listCanonicalRawFiles, download: createRawDownloader(), index: readRawIndex, insert: insertRawIndex,
      antiJoin: (items) => auditRawIndexMembership(items, sharedEnv.R2_BUCKET_RAW()), now: Date.now, emit });
    const after = notionStats();
    console.info(JSON.stringify({ ...result, notionRequests: after.requests - before.requests }));
  } catch (error) {
    // 生URL/body/causeをログへ出さない。remote stateに結果不明phaseが残る。
    const detail = error instanceof Error && error.message.startsWith("[raw-backfill]") ? error.message : "contract_or_transport_error";
    await emit({ phase: "stopped", detail, upstreamGets: 0, resend: 0 });
    console.error(JSON.stringify({ status: "stopped", detail, resend: 0 }));
    process.exitCode = 1;
  } finally { await receipt.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error("[raw-backfill] 起動失敗。秘密・原文を出さず停止"); process.exitCode = 1; });
}
