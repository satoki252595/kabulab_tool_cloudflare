/**
 * ⑤保存原本だけからR2/D1を補完する明示手動CLI。通常cronから呼ばない。
 * dotenv/configが.envを読む。GHは同名の既存secretを渡す。
 * --mode=dry|apply --plan-id=<安全ID> --limit=50 --max-bytes=67108864
 * --max-seconds=1200 --expected-count=78831 --out=<private.jsonl> [--cutoff=<UTC ISO>]
 * 同plan-idを再開する。別planへ逃げてunknown latchを消せないactive pointerを持つ。
 * 終端後の人間判断だけ: --mode=apply --limit=1 --cutoff=<固定実値>
 * --reconcile-sha256=<原本SHA> --reconcile-state-sha256=<旧state全bytes SHA>。
 * resolution intentが既存なら再送せず停止。旧active/state/cursorは一切更新しない。
 * --mode=inspect --limit=1|2 --cutoff=<固定実値>: 最大14request/64MiB/600秒の読取のみ。
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
import { notionStats, setNotionMaxRps, paceNotionNativeRequest } from "../../src/shared/notion-archive/client.js";
import { downloadArchivedFile, type ArchivedDownloadOptions } from "../../src/shared/notion-archive/archived-download.js";
import { unzip } from "../../services/yuho-quant/src/services/edinet/zip.js";
import { r2GetBytesVersion, r2PutBytes, type R2ReadOptions } from "../vwap/lib/r2.js";
import { canonicalRawKey, readD1RawIndexes, verifiedDocId } from "./raw-index-plan.js";

// Error message/body/URL は許可した定型文以外を出さない。
const SAFE_RAW_ERRORS = new Set([
  "[raw-backfill] mode/plan/count/bytes/seconds予算が不正です",
  "[raw-backfill] manifest集合/count/orderが不一致です",
  "[raw-backfill] cutoff UTC ISO/未来日時が不正です",
  "[raw-backfill] 明示cutoffと保存manifestが不一致です",
  "[raw-backfill] 原本全body SHA/サイズ不一致",
  "[raw-backfill] 取得時計を確定できません",
  "[raw-backfill] D1索引と⑤metadata/keyが不一致",
  "[raw-backfill] ⑤原本のSHA batchが欠測しています",
  "[raw-backfill] ⑤原本のSHA batchが不一致です",
  "[raw-backfill] 原本文書IDがmanifestから変化しました",
  "[raw-backfill] 原本ZIP wrapper名不一致",
  "[raw-backfill] 原本ZIP wrapperは単一実名memberではありません",
  "[raw-backfill] D1 SHA不正",
  "[raw-backfill] D1 SHA重複",
  "[raw-backfill] D1 object行契約不正",
  "[raw-backfill] 完了anti-joinに未知/重複SHA",
  "[raw-backfill] 完了anti-join metadata不一致",
  "[raw-backfill] 準備の時間予算到達。未完manifestを使わず停止",
  "[raw-backfill] receipt全文読戻し不一致。再送禁止",
  "[raw-backfill] 別planがactiveです。unknownを別planで迂回できません",
  "[raw-backfill] active manifestが欠落しています",
  "[raw-backfill] active manifest SHA不一致",
  "[raw-backfill] state/manifest/cursor不一致",
  "[raw-backfill] inflight/index key不一致",
  "[raw-backfill] inflight原本が未確認。PUTを再送せず保全停止",
  "[raw-backfill] inflight索引が未確認。INSERTを再送せず保全停止",
  "[raw-backfill] D1索引先原本が欠落。再作成せず停止",
  "[raw-backfill] hosted物理転送が予約予算を超えました",
  "[raw-backfill] PUT後の原本全文確認ができません。再送禁止",
  "[raw-backfill] R2全文確認前の索引は禁止",
  "[raw-backfill] INSERT後索引readback欠測。再送禁止",
  "[raw-backfill] 完了anti-joinに未索引があります。全件成功としない",
  "[raw-backfill] 先行完了receiptと集合が不一致",
  "[raw-backfill] 引数不正/重複",
  "[raw-backfill] 全引数明示・LOCAL_OUT禁止",
  "[raw-backfill] 明示reconcileはapply/limit1/固定cutoff/両SHAが必須です",
  "[raw-backfill] reconcile時間予算到達。再送禁止",
  "[raw-backfill] reconcile固定receiptが欠落しています",
  "[raw-backfill] reconcile対象/state全SHA/index_inflightが不一致です",
  "[raw-backfill] reconcile原本全文GETの予算不足です",
  "[raw-backfill] reconcile intentが既存です。再送せず停止",
  "[raw-backfill] reconcile索引が既存です。上書きせず停止",
  "[raw-backfill] reconcile旧active/stateが変化しました。停止",
  "[raw-backfill] reconcile索引全列readbackが不一致です。再送禁止",
  "⑤原本metadataがobjectではありません",
  "⑤原本metadataの文字列がありません",
  "⑤原本metadataの文字列が不正です",
  "⑤原本の所属/状態が不一致です",
  "⑤原本SHA/名前/サイズが不正です",
  "⑤原本の基準日が不正です",
  "⑤原本の取得日時が不正です",
  "⑤原本の取得URLが不正です",
  "⑤原本の物理添付がありません",
  "⑤原本の添付は一意なhosted fileではありません",
  "⑤原本hosted URLが不正です",
  "⑤原本名と物理添付名が対応しません",
  "⑤原本SHA照合は一意な1〜50件だけです",
  "⑤原本SHA照合が打ち切られました",
  "⑤原本SHA照合に未知/重複行があります",
  "⑤canonical原本添付を一意に確定できません",
  "⑤原本metadataがmanifestから変化しました",
  "⑤棚卸しcutoffが不正です",
  "⑤partitionに未知/重複SHAがあります",
  "⑤SHA partitionを再分割できません",
  "⑤全域棚卸しに重複SHA/pageがあります",
  "⑤canonical集合が空です",
  "⑤原本の基準日が欠測しています。キー日付を捏造せず停止",
  "⑤原本のキーmetadataが不正です"
]);
const RAW_PROPERTY_NAMES = "SHA256|ファイル名|サイズ|データ基準日|取得日時|取得URL|ファイル|ソース|データ種別|対象銘柄コード|ライセンスタグ|変換状態";
export function safeRawFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "non_error_throw";
  const errorClass = error instanceof Error && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(error.constructor.name) ? error.constructor.name : "UnknownError";
  const detail = SAFE_RAW_ERRORS.has(message) || new RegExp(`^⑤原本(${RAW_PROPERTY_NAMES})(の型/完全性が不正です|が空です|が未知です)$`).test(message)
    || /^\[raw-backfill\] D1 read HTTP [1-5][0-9]{2}$/.test(message) ? message : "contract_or_transport_error";
  const issues = error instanceof z.core.$ZodError ? error.issues.slice(0, 20).map(issue => ({ code: issue.code,
    path: issue.path.map(value => typeof value === "number" ? value : typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value) ? value : "[redacted]") })) : undefined;
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : null;
  return { detail, errorClass, messageSha256: digest(new TextEncoder().encode(message)),
    ...(cause === null ? {} : { causeSha256: digest(new TextEncoder().encode(cause)) }), ...(issues === undefined ? {} : { issues }) };
}

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
  mode: "dry" | "apply" | "inspect"; planId: string; limit: number; maxBytes: number; maxSeconds: number; expectedCount: number;
  /** dry/apply/再開で同じcreated_time集合を固定する明示UTC時刻。省略時は旧取得時計を維持。 */
  cutoff?: string;
  /** 終端後の人間判断に限る単一索引回復。通常再開のunknown停止は変えない。 */
  reconcileSha256?: string;
  reconcileStateSha256?: string;
}
export interface RawIndexRow {
  sha256: string; r2_bucket: string; r2_key: string; source: string; datatype: string; scope: string;
  doc_id: string | null; code: string | null; data_date: string | null; ext: string; size_bytes: number;
  license_tag: string; convert_status: string; first_fetched_at: number; last_fetched_at: number;
}
type Version = Awaited<ReturnType<typeof r2GetBytesVersion>>;
export interface BackfillIo {
  rawBucket: string; receiptBucket: string;
  get: (key: string, bucket: string, options?: R2ReadOptions) => Promise<Version>;
  put: (key: string, bytes: Uint8Array, previous: string | null, bucket: string, contentType: string) => Promise<void>;
  list: typeof listCanonicalRawFiles;
  download: (item: RawItem, cohort: readonly RawItem[], options?: Pick<ArchivedDownloadOptions, "signal" | "onAttempt">) => Promise<{ body: Uint8Array; wireBytes: number }>;
  index: (sha: string) => Promise<RawIndexRow | null>;
  insert: (row: RawIndexRow) => Promise<void>;
  antiJoin: (items: readonly RawItem[]) => Promise<{ checked: number; missing: number }>;
  now: () => number;
  emit: (record: object) => Promise<void>; // caller fsyncs before remote mutation.
}

export function validateRawOptions(opts: RawBackfillOptions, now = Date.now()): void {
  if (!["dry", "apply", "inspect"].includes(opts.mode) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(opts.planId) ||
      !Number.isSafeInteger(opts.limit) || opts.limit < 1 || opts.limit > 100_000 ||
      !Number.isSafeInteger(opts.maxBytes) || opts.maxBytes < 1 || opts.maxBytes > 64 * 1024 ** 3 ||
      !Number.isSafeInteger(opts.maxSeconds) || opts.maxSeconds < 1 || opts.maxSeconds > 19_800 ||
      !Number.isSafeInteger(opts.expectedCount) || opts.expectedCount < 1 || opts.expectedCount > 100_000) {
    throw new Error("[raw-backfill] mode/plan/count/bytes/seconds予算が不正です");
  }
  if (opts.mode === "inspect" && (opts.limit > 2 || opts.maxBytes > 64 * 1024 ** 2 || opts.maxSeconds > 600 || opts.cutoff === undefined))
    throw new Error("[raw-backfill] inspectは固定cutoff/最大2件/64MiB/600秒です");
  if (opts.cutoff !== undefined) {
    const epoch = Date.parse(opts.cutoff);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(opts.cutoff) || !Number.isFinite(epoch) ||
        new Date(epoch).toISOString().slice(0, 19) !== opts.cutoff.slice(0, 19) || !Number.isFinite(now) || epoch > now)
      throw new Error("[raw-backfill] cutoff UTC ISO/未来日時が不正です");
  }
  if (opts.reconcileSha256 !== undefined || opts.reconcileStateSha256 !== undefined) {
    if (opts.mode !== "apply" || opts.limit !== 1 || opts.cutoff === undefined ||
        opts.maxBytes > 64 * 1024 ** 2 || opts.maxSeconds > 600 ||
        !hashSchema.safeParse(opts.reconcileSha256).success || !hashSchema.safeParse(opts.reconcileStateSha256).success)
      throw new Error("[raw-backfill] 明示reconcileはapply/limit1/固定cutoff/両SHA/64MiB/600秒以下が必須です");
  }
}

/** 結果不明のreceiptと原本を読むだけ。通常再開・reconcile・cursor更新へ接続しない。 */
export async function inspectRawBackfill(opts: RawBackfillOptions,
  io: Pick<BackfillIo, "rawBucket" | "receiptBucket" | "get" | "index" | "now" | "emit">) {
  validateRawOptions(opts, io.now());
  if (opts.mode !== "inspect") throw new Error("[raw-backfill] inspect modeが必須です");
  const start = io.now(), deadline = start + opts.maxSeconds * 1000, signal = AbortSignal.timeout(opts.maxSeconds * 1000);
  const prefix = `ops/raw-index/${opts.planId}`, activeKey = "ops/raw-index/active.json", stateKey = `${prefix}/state.json`;
  // receipt最大8 + 原本最大4 + 一意索引最大2。manifestは1回だけ全文取得する。
  const stats = { requests: 0, receiptGets: 0, rawGets: 0, d1Reads: 0, r2ReadBytes: 0 };
  const receipts: Array<{ name: string; present: boolean; sha256?: string; bytes?: number; etagSha256?: string }> = [];
  const checkTime = () => { signal.throwIfAborted(); if (io.now() + 65_000 > deadline) throw new Error("[raw-backfill] inspectの65秒headroom不足"); };
  const reserveRequest = () => { checkTime(); if (stats.requests >= 14) throw new Error("[raw-backfill] inspectの14request予算到達"); stats.requests++; };
  const get = async (name: string, key: string, bucket: string, maxBytes: number, receipt: boolean) => {
    if (maxBytes < 1 || stats.r2ReadBytes + maxBytes > opts.maxBytes) throw new Error("[raw-backfill] inspect全文読取のbytes予算不足");
    reserveRequest();
    if (receipt) stats.receiptGets++; else stats.rawGets++;
    await io.emit({ phase: "inspect_get_inflight", name, key, bucket, reservedBytes: maxBytes });
    const got = await io.get(key, bucket, { singleAttempt: true, maxBytes, abortSignal: signal, beforeAttempt: checkTime,
      onRead: async read => { if (!read.complete) {
        stats.r2ReadBytes += read.receivedBytes;
        await io.emit({ phase: "inspect_partial_body", name, key, status: read.status,
          etag: read.etag, contentLength: read.contentLength, receivedBytes: read.receivedBytes, complete: false, ...stats,
          prefixBase64: Buffer.from(read.body.subarray(0, 16 * 1024)).toString("base64") });
      } } });
    if (got !== null) {
      stats.r2ReadBytes += got.body.length;
      await io.emit({ phase: "inspect_object", name, key, bucket, etag: got.etag, metadata: got.metadata,
        sha256: digest(got.body), bytes: got.body.length, bodyBase64: Buffer.from(got.body).toString("base64") });
      if (got.body.length > maxBytes || stats.r2ReadBytes > opts.maxBytes) throw new Error("[raw-backfill] inspect全文読取のbytes予算超過");
    } else await io.emit({ phase: "inspect_missing", name, key, bucket });
    if (receipt) receipts.push({ name, present: got !== null, ...(got === null ? {} : {
      sha256: digest(got.body), bytes: got.body.length, etagSha256: digest(new TextEncoder().encode(got.etag)) }) });
    return got;
  };
  const control = (name: string, key: string, maxBytes = 256 * 1024) => get(name, key, io.receiptBucket, maxBytes, true);
  const required = (got: Version) => { if (got === null) throw new Error("[raw-backfill] inspect固定receipt欠測"); return got; };
  const parse = (got: NonNullable<Version>) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(got.body));
  const activeVersion = required(await control("active", activeKey)), active = Active.parse(parse(activeVersion));
  if (active.planId !== opts.planId) throw new Error("[raw-backfill] 別planがactiveです。unknownを別planで迂回できません");
  const manifestVersion = required(await control("manifest", `${prefix}/manifest.json`, opts.maxBytes - stats.r2ReadBytes));
  const manifest = parseRawManifest(parse(manifestVersion), opts, io.rawBucket);
  if (digest(manifestVersion.body) !== active.manifestSha256 || digest(encode(manifest)) !== active.manifestSha256)
    throw new Error("[raw-backfill] active manifest SHA不一致");
  const stateVersion = required(await control("state", stateKey)), state = State.parse(parse(stateVersion));
  if (state.manifestSha256 !== active.manifestSha256 || state.cursor > manifest.items.length ||
      state.inflight !== null && (state.inflight.sha256 !== manifest.items[state.cursor]?.sha256 || !state.inflight.key.startsWith("raw/")))
    throw new Error("[raw-backfill] state/manifest/cursor不一致");
  const completeVersion = await control("complete", `${prefix}/complete.json`);
  if (completeVersion !== null) {
    const complete = Complete.parse(parse(completeVersion));
    if (complete.manifestSha256 !== active.manifestSha256 || complete.canonicalCount !== manifest.items.length ||
        complete.r2FullShaVerifiedCount !== manifest.items.length || complete.indexAntiJoinChecked !== manifest.items.length ||
        state.cursor !== manifest.items.length || state.inflight !== null) throw new Error("[raw-backfill] 先行完了receiptと集合が不一致");
  }
  if (state.inflight !== null) {
    for (const phase of ["intent", "complete"] as const) {
      const resolution = await control(`resolution_${phase}`, `${prefix}/resolutions/${state.inflight.sha256}/${phase}.json`);
      if (resolution !== null) {
        const value: unknown = parse(resolution);
        if (value === null || typeof value !== "object" || Array.isArray(value) ||
            (value as Record<string, unknown>).planId !== opts.planId || (value as Record<string, unknown>).sha256 !== state.inflight.sha256 ||
            (value as Record<string, unknown>).manifestSha256 !== active.manifestSha256)
          throw new Error("[raw-backfill] inspect resolution receipt不一致");
      }
    }
  }
  const positions = [state.cursor, state.cursor - 1].filter(position => position >= 0 && position < manifest.items.length).slice(0, opts.limit);
  const subjects = [];
  for (const position of positions) {
    const item = manifest.items[position]!;
    // canonical欠測時だけ実旧キーを読む可能性も、開始前に全bytes予約する。
    if (stats.r2ReadBytes + item.sizeBytes * 2 > opts.maxBytes) throw new Error("[raw-backfill] inspect原本全文のbytes予算不足");
    reserveRequest(); stats.d1Reads++;
    const index = await io.index(item.sha256);
    await io.emit({ phase: "inspect_index", position, sha256: item.sha256, index });
    if (index !== null) validateIndex(index, item, io.rawBucket);
    let key = position === state.cursor && state.inflight !== null ? state.inflight.key : index !== null ? index.r2_key : canonicalRawKey({ ...item, sourceUrl: null }, item.docId);
    if (position === state.cursor && state.inflight !== null && index !== null && key !== index.r2_key)
      throw new Error("[raw-backfill] inflight/index key不一致");
    let raw = await get(`raw_${position}`, key, io.rawBucket, Math.max(1, item.sizeBytes), false);
    if (raw === null && index === null && !(position === state.cursor && state.inflight !== null) && item.docId !== null) {
      key = canonicalRawKey({ ...item, sourceUrl: null }, null);
      raw = await get(`legacy_raw_${position}`, key, io.rawBucket, Math.max(1, item.sizeBytes), false);
    }
    if (raw !== null) validateBody(raw.body, item);
    if (index !== null && raw === null) throw new Error("[raw-backfill] D1索引先原本が欠落。再作成せず停止");
    if (position < state.cursor && (index === null || raw === null)) throw new Error("[raw-backfill] inspect旧cursor完了項目が未検証");
    const publishKey = /^raw\/[A-Za-z0-9._/-]{1,1020}$/.test(key);
    subjects.push({ position, sha256: item.sha256, bytes: item.sizeBytes, notionPageId: item.pageId,
      source: item.source, datatype: item.datatype, scope: item.scope, docId: item.docId,
      rawKey: publishKey ? key : null,
      rawKeyDisclosure: publishKey ? "safe_path_structure" : "private_only_not_safe_to_publish",
      rawKeySha256: digest(new TextEncoder().encode(key)), indexPresent: index !== null, rawPresent: raw !== null,
      indexMetadataVerified: index !== null, indexFullRowSha256: index === null ? null : digest(encode(index)),
      indexDocId: index === null ? null : index.doc_id !== null && /^[A-Z0-9]{1,32}$/.test(index.doc_id) ? index.doc_id : null,
      indexDocIdStatus: index === null ? "index_missing" : index.doc_id === null ? "legacy_null_retained" : item.docId === null ? "retained_existing_unverified" : "verified_archived_id",
      rawFullShaVerified: raw !== null, rawETagSha256: raw === null ? null : digest(new TextEncoder().encode(raw.etag)) });
  }
  for (const [name, key, previous] of [["state_final", stateKey, stateVersion], ["active_final", activeKey, activeVersion]] as const) {
    const fresh = required(await control(name, key));
    if (fresh.etag !== previous.etag || !Buffer.from(fresh.body).equals(Buffer.from(previous.body)))
      throw new Error("[raw-backfill] inspect中にactive/stateが変化しました");
  }
  const result = { status: "read_only_inspection_complete", mode: "inspect", planId: opts.planId, manifestSha256: active.manifestSha256,
    cursor: state.cursor, remaining: manifest.items.length - state.cursor, inflightPhase: state.inflight === null ? null : state.inflight.phase,
    inflightSha256: state.inflight === null ? null : state.inflight.sha256, unknownCleared: false, oldStateUnchanged: true,
    currentReceiptState: state.inflight === null ? "no_persistent_inflight_observed" : "persistent_inflight_retained",
    originalFailedReceiptAcknowledgement: "unavailable_original_payload_not_reconstructed",
    receipts, subjects, ...stats, elapsedMs: io.now() - start, requestLimit: 14, upstreamGets: 0, notionRequests: 0,
    rawPuts: 0, receiptPuts: 0, d1Inserts: 0, stateResets: 0, continuationAllowed: false };
  await io.emit({ phase: "inspect_summary", ...result });
  return result;
}
export function parseRawManifest(value: unknown, opts: RawBackfillOptions, bucket: string): RawManifest {
  const manifest = Manifest.parse(value);
  if (opts.cutoff !== undefined && manifest.cutoff !== opts.cutoff) throw new Error("[raw-backfill] 明示cutoffと保存manifestが不一致です");
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
  return async (item, cohort, options) => {
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
    if (file.name !== item.filename && file.name !== `${item.filename}.zip`) throw new Error("[raw-backfill] 原本ZIP wrapper名不一致");
    // 元実サイズ＋既存wrapper余裕。最大2GETのpartialも実受信量へ加算する。
    const maxBytes = file.name === item.filename ? item.sizeBytes : item.sizeBytes + Math.ceil(item.sizeBytes * 0.001) + 4096;
    let wireBytes = 0;
    const wire = await download(file, "⑤raw-index", { maxBytes, signal: options?.signal, onAttempt: async event => {
      if (event.phase === "start") await paceNotionNativeRequest(options?.signal);
      else wireBytes += event.receivedBytes;
      await options?.onAttempt?.(event);
      if (wireBytes > maxBytes * 2) throw new Error("[raw-backfill] hosted物理転送が予約予算を超えました");
    } });
    let body = wire;
    if (file.name !== item.filename) {
      const members = unzip(Buffer.from(wire), { maxEntries: 1, maxExpandedBytes: item.sizeBytes });
      if (members.size !== 1 || !members.has(item.filename)) throw new Error("[raw-backfill] 原本ZIP wrapperは単一実名memberではありません");
      body = members.get(item.filename)!;
    }
    validateBody(body, item);
    return { body, wireBytes };
  };
}

/** 一意SHAだけをread。原本metadataを書き換えるUPDATE/UPSERTは使わない。 */
export async function readRawIndex(sha: string): Promise<RawIndexRow | null> {
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error("[raw-backfill] D1 SHA不正");
  const response = await fetch(d1HttpQueryUrl(), { method: "POST", headers: {
    Authorization: `Bearer ${sharedEnv.CLOUDFLARE_API_TOKEN()}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(60_000),
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

/** 人間が旧送信有無unknownを承知した、一意INSERTだけの明示回復。旧latchは変更しない。 */
export async function reconcileRawIndex(opts: RawBackfillOptions, io: BackfillIo) {
  const started = io.now();
  validateRawOptions(opts, started);
  if (opts.reconcileSha256 === undefined || opts.reconcileStateSha256 === undefined)
    throw new Error("[raw-backfill] 明示reconcileはapply/limit1/固定cutoff/両SHAが必須です");
  const prefix = `ops/raw-index/${opts.planId}`, activeKey = "ops/raw-index/active.json", stateKey = `${prefix}/state.json`;
  const resolution = `${prefix}/resolutions/${opts.reconcileSha256}`;
  const deadline = started + opts.maxSeconds * 1000, signal = AbortSignal.timeout(opts.maxSeconds * 1000);
  let receiptGets = 0, receiptPuts = 0, r2Gets = 0, r2ReadBytes = 0, r2PutBytes = 0;
  const checkClock = () => { signal.throwIfAborted(); if (io.now() + 65_000 > deadline) throw new Error("[raw-backfill] reconcileの65秒headroom不足。再送禁止"); };
  const remainingBytes = () => opts.maxBytes - r2ReadBytes - r2PutBytes;
  // 固定フローはreceipt13GET + raw1GET。manifestは1回だけ、D1の2SELECT/1INSERTは別計数。
  const get = async (key: string, bucket = io.receiptBucket, maxBytes = Math.min(256 * 1024, remainingBytes())) => {
    checkClock();
    if (r2Gets >= 14 || maxBytes < 1 || maxBytes > remainingBytes()) throw new Error("[raw-backfill] reconcile GET/bytes予算不足。再送禁止");
    r2Gets++; if (bucket === io.receiptBucket) receiptGets++;
    await io.emit({ phase: "reconcile_get_inflight", key, bucket, reservedBytes: maxBytes, r2Gets });
    const got = await io.get(key, bucket, { singleAttempt: true, maxBytes, abortSignal: signal, beforeAttempt: checkClock,
      onRead: async read => { if (!read.complete) {
        r2ReadBytes += read.receivedBytes;
        await io.emit({ phase: "reconcile_partial_body", key, status: read.status, etag: read.etag,
          contentLength: read.contentLength, receivedBytes: read.receivedBytes, complete: false, r2Gets, r2ReadBytes,
          prefixBase64: Buffer.from(read.body.subarray(0, 16 * 1024)).toString("base64") });
      } } });
    if (got !== null) {
      r2ReadBytes += got.body.length;
      if (got.body.length > maxBytes || remainingBytes() < 0) throw new Error("[raw-backfill] reconcile全文読取のbytes予算超過。再送禁止");
    }
    return got;
  };
  const required = async (key: string, maxBytes?: number) => {
    const got = await get(key, io.receiptBucket, maxBytes);
    if (got === null) throw new Error("[raw-backfill] reconcile固定receiptが欠落しています");
    return got;
  };
  const parse = (version: NonNullable<Version>) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(version.body));
  const activeVersion = await required(activeKey), active = Active.parse(parse(activeVersion));
  if (active.planId !== opts.planId) throw new Error("[raw-backfill] 別planがactiveです。unknownを別planで迂回できません");
  const manifestVersion = await required(`${prefix}/manifest.json`, remainingBytes()), manifest = parseRawManifest(parse(manifestVersion), opts, io.rawBucket);
  if (digest(manifestVersion.body) !== active.manifestSha256 || digest(encode(manifest)) !== active.manifestSha256)
    throw new Error("[raw-backfill] active manifest SHA不一致");
  const stateVersion = await required(stateKey), state = State.parse(parse(stateVersion)), inflight = state.inflight;
  if (digest(stateVersion.body) !== opts.reconcileStateSha256 || state.manifestSha256 !== active.manifestSha256 ||
      state.cursor >= manifest.items.length || inflight === null || inflight.phase !== "index_inflight" ||
      inflight.sha256 !== opts.reconcileSha256 || manifest.items[state.cursor]!.sha256 !== opts.reconcileSha256 || !inflight.key.startsWith("raw/"))
    throw new Error("[raw-backfill] reconcile対象/state全SHA/index_inflightが不一致です");
  const item = manifest.items[state.cursor]!;
  if (item.sizeBytes > opts.maxBytes) throw new Error("[raw-backfill] reconcile原本全文GETの予算不足です");
  // 成功後もunknown後も同じ明示操作を再送できない。通常runのread-only回収とは別。
  if (await get(`${resolution}/intent.json`) !== null || await get(`${resolution}/complete.json`) !== null)
    throw new Error("[raw-backfill] reconcile intentが既存です。再送せず停止");
  checkClock();
  const raw = await get(inflight.key, io.rawBucket, item.sizeBytes);
  if (raw === null) throw new Error("[raw-backfill] D1索引先原本が欠落。再作成せず停止");
  validateBody(raw.body, item);
  await io.emit({ phase: "raw_verified", sha256: item.sha256, bytes: raw.body.length });
  checkClock();
  if (await io.index(item.sha256) !== null) throw new Error("[raw-backfill] reconcile索引が既存です。上書きせず停止");
  const unchanged = async () => {
    for (const [key, previous] of [[activeKey, activeVersion], [stateKey, stateVersion]] as const) {
      const fresh = await required(key);
      if (fresh.etag !== previous.etag || !Buffer.from(fresh.body).equals(Buffer.from(previous.body)))
        throw new Error("[raw-backfill] reconcile旧active/stateが変化しました。停止");
    }
  };
  const persist = async (key: string, value: unknown) => {
    const bytes = encode(value);
    if (bytes.length > 256 * 1024 || bytes.length * 2 > remainingBytes()) throw new Error("[raw-backfill] reconcile receipt PUT/全文読戻しのbytes予算不足。再送禁止");
    await io.emit({ phase: "resolution_receipt_inflight", key, sha256: digest(bytes), bytes: bytes.length });
    checkClock(); receiptPuts++; r2PutBytes += bytes.length;
    await io.put(key, bytes, null, io.receiptBucket, "application/json");
    const read = await required(key);
    if (!Buffer.from(read.body).equals(Buffer.from(bytes))) throw new Error("[raw-backfill] receipt全文読戻し不一致。再送禁止");
  };
  await unchanged();
  const expected = expectedRawIndex(item, io.rawBucket, inflight.key);
  const intent = { version: 1, kind: "manual-index-reconciliation", planId: opts.planId, cutoff: manifest.cutoff,
    expectedCount: manifest.expectedCount, manifestSha256: active.manifestSha256, stateSha256: opts.reconcileStateSha256,
    cursor: state.cursor, sha256: item.sha256, rawBucket: io.rawBucket, rawKey: inflight.key, rawBytes: raw.body.length,
    expectedIndex: expected, originalSendUnknown: true, maximumInsertAttempts: 1, createdAt: new Date(io.now()).toISOString() };
  await persist(`${resolution}/intent.json`, intent);
  await unchanged();
  await io.emit({ phase: "index_reconciliation_insert_inflight", sha256: item.sha256, originalSendUnknown: true, reconciliationInsertAttempts: 1 });
  checkClock();
  await io.insert(expected); // plain unique INSERTだけ。競合・unknownの再送なし。
  checkClock();
  const post = await io.index(item.sha256);
  if (post === null || Object.keys(post).sort().join("|") !== Object.keys(expected).sort().join("|") ||
      (Object.keys(expected) as Array<keyof RawIndexRow>).some(key => post[key] !== expected[key]))
    throw new Error("[raw-backfill] reconcile索引全列readbackが不一致です。再送禁止");
  await unchanged();
  const complete = { ...intent, status: "manual_index_reconciliation_complete", completedAt: new Date(io.now()).toISOString(),
    reconciliationInsertAttempts: 1, fullMetadataReadback: true, oldLatchUnchanged: true, rawPuts: 0, stateResets: 0, upstreamGets: 0 };
  await persist(`${resolution}/complete.json`, complete);
  const result = { status: complete.status, sha256: item.sha256, originalSendUnknown: true, reconciliationInsertAttempts: 1,
    fullMetadataReadback: true, oldLatchUnchanged: true, cursor: state.cursor, rawGets: 1, rawGetBytes: raw.body.length,
    rawPuts: 0, d1Reads: 2, d1Inserts: 1, receiptGets, receiptPuts, r2Gets, r2ReadBytes, r2PutBytes,
    r2TransferBytes: r2ReadBytes + r2PutBytes, requests: r2Gets + receiptPuts + 3, requestLimit: 19,
    d1ResponseBytesMeasured: false, sdkErrorResponseBytesMeasured: false,
    elapsedMs: io.now() - started, notionDownloads: 0, upstreamGets: 0, stateResets: 0 };
  await io.emit({ phase: "resolution_complete", ...result });
  return result;
}

export async function runRawBackfill(opts: RawBackfillOptions, io: BackfillIo) {
  const start = io.now();
  validateRawOptions(opts, start);
  if (opts.mode === "inspect") return inspectRawBackfill(opts, io);
  if (opts.reconcileSha256 !== undefined) return reconcileRawIndex(opts, io);
  const deadline = start + opts.maxSeconds * 1000;
  // 一度開始した原本1件はinflightを解決するまで完結。次の原本は期限後に開始しない。
  // hard timeout/runner消失では永続inflightが次runの無条件再送を止める。
  let processingItem = false;
  const checkClock = () => { if (!processingItem && io.now() >= deadline) throw new Error("[raw-backfill] 準備の時間予算到達。未完manifestを使わず停止"); };
  const stats = { inventoryRows: 0, processed: 0, verified: 0, alreadyComplete: 0, wouldPut: 0, wouldIndex: 0,
    rawGets: 0, rawPuts: 0, rawGetBytes: 0, rawPutBytes: 0, notionDownloads: 0, notionDownloadAttempts: 0, notionDownloadBytes: 0,
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
    await io.emit({ phase: "receipt_verified", key, sha256: digest(body), bytes: body.length });
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
    const cutoff = opts.cutoff === undefined ? new Date(io.now()).toISOString() : opts.cutoff, rows = await io.list(cutoff, checkClock);
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
    if (got) {
      stats.rawGetBytes += got.body.length; validateBody(got.body, item);
      await io.emit({ phase: "raw_verified", sha256: item.sha256, bytes: got.body.length });
    }
    return got;
  };
  let budgetReserved = 0, stoppedByBudget = false, budgetStopReason: "seconds" | "bytes" | null = null;
  while (state.cursor < manifest.items.length && stats.processed < opts.limit) {
    if (io.now() >= deadline) { stoppedByBudget = true; budgetStopReason = "seconds"; break; }
    const item = manifest.items[state.cursor]!;
    // 先にworst-case raw転送を予約。原本を切り詰めず、次runへ丸ごと残す。
    const wrapperOverhead = Math.ceil(item.sizeBytes * 0.001) + 4096;
    const reserve = item.sizeBytes * 5 + wrapperOverhead * 2; // 従来予約＋2回目hosted GET最大(size+wrapper)。
    if (budgetReserved + reserve > opts.maxBytes) { stoppedByBudget = true; budgetStopReason = "bytes"; break; }
    budgetReserved += reserve;
    processingItem = true;
    let index = await readIndex(item);
    if (index) validateIndex(index, item, io.rawBucket);
    let key = state.inflight !== null ? state.inflight.key : index ? index.r2_key : canonicalRawKey({ ...item, sourceUrl: null }, item.docId);
    if (state.inflight && index && key !== index.r2_key) throw new Error("[raw-backfill] inflight/index key不一致");
    let body = await readBody(key, item);
    let checkedIndex: RawIndexRow | null | undefined;
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
        const remainingMs = deadline - io.now();
        if (remainingMs <= 0) throw new Error("[raw-backfill] 準備の時間予算到達。未完manifestを使わず停止");
        const beforeBytes = stats.notionDownloadBytes, beforeAttempts = stats.notionDownloadAttempts;
        const saved = await io.download(item, manifest.items.slice(state.cursor, state.cursor + 50), {
          signal: AbortSignal.timeout(remainingMs), onAttempt: async event => {
            if (event.phase === "start") stats.notionDownloadAttempts++;
            else stats.notionDownloadBytes += event.receivedBytes;
            await io.emit({ phase: "hosted_read_attempt", sha256: item.sha256, attempt: event.attempt,
              attemptPhase: event.phase, receivedBytes: event.receivedBytes, status: event.status,
              notionDownloadAttempts: stats.notionDownloadAttempts, notionDownloadBytes: stats.notionDownloadBytes });
          },
        });
        if (stats.notionDownloadAttempts - beforeAttempts < 1 || stats.notionDownloadAttempts - beforeAttempts > 2 ||
            saved.wireBytes !== stats.notionDownloadBytes - beforeBytes) throw new Error("[raw-backfill] hosted物理転送が予約予算を超えました");
        validateBody(saved.body, item);
        if (saved.wireBytes > 2 * (item.sizeBytes + wrapperOverhead)) throw new Error("[raw-backfill] hosted物理転送が予約予算を超えました");
        stats.wouldPut++;
        if (opts.mode === "apply") {
          await saveState({ ...state, inflight: { sha256: item.sha256, key, phase: "raw_inflight" } });
          await io.emit({ phase: "raw_inflight", sha256: item.sha256, key, bytes: item.sizeBytes });
          checkClock(); stats.rawPuts++; stats.rawPutBytes += saved.body.length;
          await io.put(key, saved.body, null, io.rawBucket, "application/octet-stream");
          // 両方ともreadだけ。全結果を回収し、どちらかの失敗時はindex latch/INSERTへ進めない。
          const checked = await Promise.allSettled([readBody(key, item), readIndex(item)]);
          if (checked[0].status === "rejected") throw checked[0].reason;
          body = checked[0].value;
          if (body === null) throw new Error("[raw-backfill] PUT後の原本全文確認ができません。再送禁止");
          if (checked[1].status === "rejected") throw checked[1].reason;
          checkedIndex = checked[1].value;
        }
      }
      stats.wouldIndex++;
      if (opts.mode === "apply") {
        if (body === null) throw new Error("[raw-backfill] R2全文確認前の索引は禁止");
        // PUT後の独立read済みの場合も、全body成功後だけ同値判定へ進む。
        index = checkedIndex === undefined ? await readIndex(item) : checkedIndex;
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
    elapsedMs: io.now() - start, rawTransferBytes: stats.rawGetBytes + stats.rawPutBytes + stats.notionDownloadBytes,
    hostedBytesKind: "decoded_body_all_observed_attempts", httpHeadersAndErrorBodyBytesMeasured: false, r2PartialReadBytesMeasured: false };
  await io.emit({ phase: "summary", ...result });
  return result;
}

async function main() {
  const required = ["mode", "plan-id", "limit", "max-bytes", "max-seconds", "expected-count", "out"];
  const allowed = [...required, "notion-max-rps", "cutoff", "reconcile-sha256", "reconcile-state-sha256"];
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const m = /^--([a-z0-9-]+)=(.+)$/.exec(arg);
    if (!m || !allowed.includes(m[1]!) || args.has(m[1]!)) throw new Error("[raw-backfill] 引数不正/重複");
    args.set(m[1]!, m[2]!);
  }
  if (required.some((key) => !args.has(key)) || sharedEnv.LOCAL_OUT() !== undefined) throw new Error("[raw-backfill] 全引数明示・LOCAL_OUT禁止");
  const opts: RawBackfillOptions = { mode: args.get("mode") as RawBackfillOptions["mode"], planId: args.get("plan-id")!, limit: Number(args.get("limit")),
    maxBytes: Number(args.get("max-bytes")), maxSeconds: Number(args.get("max-seconds")), expectedCount: Number(args.get("expected-count")), ...(args.has("cutoff") ? { cutoff: args.get("cutoff")! } : {}),
    ...(args.has("reconcile-sha256") ? { reconcileSha256: args.get("reconcile-sha256")! } : {}),
    ...(args.has("reconcile-state-sha256") ? { reconcileStateSha256: args.get("reconcile-state-sha256")! } : {}) };
  validateRawOptions(opts);
  if (args.has("notion-max-rps")) setNotionMaxRps(Number(args.get("notion-max-rps")));
  const receipt = await fs.open(args.get("out")!, "wx", 0o600), before = notionStats();
  const startedAt = Date.now();
  let lastPhase = "starting";
  let lastRawVerified: { sha256: string; bytes: number } | null = null;
  let reconciliationInsertAttempts = 0;
  let hosted = { notionDownloadAttempts: 0, notionDownloadBytes: 0 };
  let lastProgressAt = 0;
  let inventory = { prefix: "", queries: 0, currentPartitionRows: 0, acceptedRows: 0, responseRows: 0 };
  const emit = async (record: object) => { const phase = (record as { phase?: unknown }).phase; if (typeof phase === "string") lastPhase = phase;
    if (phase === "raw_verified") {
      const { sha256, bytes } = record as { sha256: string; bytes: number };
      lastRawVerified = { sha256, bytes };
    }
    if (phase === "index_reconciliation_insert_inflight") reconciliationInsertAttempts = 1;
    if (phase === "hosted_read_attempt") {
      const observed = record as { notionDownloadAttempts: number; notionDownloadBytes: number };
      hosted = { notionDownloadAttempts: observed.notionDownloadAttempts, notionDownloadBytes: observed.notionDownloadBytes };
    }
    await receipt.write(`${JSON.stringify(record)}\n`); await receipt.sync();
    // 公開runner logには原本key/URL/bodyを出さず、停止前の送信境界だけ残す。
    if (["manifest", "receipt_inflight", "receipt_verified", "raw_verified", "raw_inflight", "index_inflight", "verified"].includes(lastPhase) &&
        (lastPhase === "manifest" || Date.now() - lastProgressAt >= 10_000)) {
      lastProgressAt = Date.now();
      console.info(JSON.stringify({ phase: lastPhase, at: new Date().toISOString() }));
    }
  };
  const observeInventory = async (record: import("../../src/shared/notion-archive/raw-files.js").RawInventoryProgress) => {
    inventory = { prefix: record.prefix, queries: record.queries, currentPartitionRows: record.partitionRows, acceptedRows: record.acceptedRows, responseRows: record.responseRows };
    await emit(record);
    if (record.phase === "inventory_partition_complete" || record.phase === "inventory_query" && record.queries % 25 === 0) console.info(JSON.stringify(record));
  };
  try {
    const result = await runRawBackfill(opts, { rawBucket: sharedEnv.R2_BUCKET_RAW(), receiptBucket: sharedEnv.R2_BUCKET(),
      get: (key, bucket, options) => r2GetBytesVersion(key, bucket, { ...options, singleAttempt: true }), put: r2PutBytes,
      list: (cutoff, guard) => listCanonicalRawFiles(cutoff, guard, observeInventory), download: createRawDownloader(), index: readRawIndex, insert: insertRawIndex,
      antiJoin: (items) => auditRawIndexMembership(items, sharedEnv.R2_BUCKET_RAW()), now: Date.now, emit });
    const after = notionStats();
    console.info(JSON.stringify({ ...result, notionRequests: after.requests - before.requests }));
  } catch (error) {
    // 生URL/body/causeをログへ出さない。remote stateに結果不明phaseが残る。
    const failurePhase = lastPhase;
    if ((opts.mode === "inspect" || opts.reconcileSha256 !== undefined) && error instanceof Error) {
      const native = error as Error & { $metadata?: { httpStatusCode?: unknown; requestId?: unknown } };
      const details = encode({ name: native.name, message: native.message, stack: native.stack,
        status: native.$metadata?.httpStatusCode, requestId: native.$metadata?.requestId, $metadata: native.$metadata });
      await emit({ phase: opts.mode === "inspect" ? "inspect_error_private" : "reconcile_error_private",
        diagnosticKind: "exception_json_not_http_body", bytes: details.length,
        complete: details.length <= 16 * 1024, prefixBase64: Buffer.from(details.subarray(0, 16 * 1024)).toString("base64") });
    }
    const after = notionStats();
    const failure = { status: "stopped", ...safeRawFailure(error), lastPhase: failurePhase, lastRawVerified, inventory, elapsedMs: Date.now() - startedAt,
      notionRequests: after.requests - before.requests, notionRateLimited: after.rateLimited - before.rateLimited,
      notionTransientRetries: after.transientRetries - before.transientRetries, upstreamGets: 0, ...hosted,
      hostedBytesKind: "decoded_body_all_observed_attempts", httpHeadersAndErrorBodyBytesMeasured: false,
      ...(opts.reconcileSha256 === undefined ? { resend: 0 } : { originalSendUnknown: true, reconciliationInsertAttempts }) };
    await emit({ ...failure, phase: "stopped" });
    console.error(JSON.stringify(failure));
    process.exitCode = 1;
  } finally { await receipt.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error("[raw-backfill] 起動失敗。秘密・原文を出さず停止"); process.exitCode = 1; });
}
