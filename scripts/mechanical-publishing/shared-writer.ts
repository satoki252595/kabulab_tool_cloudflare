/** One non-expiring R2 CAS owner for Mac/Actions. Pending/failed runs require explicit read-only reconciliation. */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { sharedEnv } from "../../src/shared/env.js";
import type { SupplementPublicationJournal } from "../../src/shared/notion-archive/stock-supplement.js";
import { r2GetBytesVersion, r2PutBytes } from "../vwap/lib/r2.js";

export const SHARED_WRITER_KEY = "mechanical-publishing/v1/writer.json";
const MAX_STATE = 16_384, MAX_SNAPSHOT = 64 * 1024 ** 2;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const encode = (value: unknown) => JSON.stringify(value) + "\n";
export interface PublishingStore {
  get(key: string, maxBytes: number): Promise<{ body: string; etag: string } | null>;
  put(key: string, body: string, etag: string | null): Promise<void>;
}
interface State {
  version: 1; baselineSha256: string; owner: { id: string; startedAt: string } | null;
  pending: { key: string; kind: "supplement-create" | "supplement-update" | "yutai-summary" | "yutai-source-import"; snapshotSha256: string; bytes: number } | null;
}
export interface PublishingWriter {
  assertReady(): Promise<void>;
  readCursor(name: "supplement-texts" | "yutai-summary"): Promise<string | null>;
  writeCursor(name: "supplement-texts" | "yutai-summary", body: string): Promise<void>;
  reserve(kind: NonNullable<State["pending"]>["kind"], identity: unknown, snapshot: string): Promise<{ complete(output: unknown): Promise<void> }>;
  supplementJournal(): SupplementPublicationJournal;
}
const current = new AsyncLocalStorage<PublishingWriter>();
export const currentPublishingWriter = () => current.getStore();
export class PublishingReadOnlyError extends Error {
  constructor(cause: unknown) { super("publishing_read_only_failed", { cause }); this.name = "PublishingReadOnlyError"; }
}
/** Only use around a verified SELECT/GET/query callback, never a schema ensure or any writer. */
export async function publishingReadOnly<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); } catch (cause) { throw new PublishingReadOnlyError(cause); }
}

export function publishingStore(deadlineMs?: number): PublishingStore {
  if (sharedEnv.LOCAL_OUT() !== undefined) throw new Error("共有publisherはLOCAL_OUTを使用できません");
  const bucket = sharedEnv.R2_BUCKET_RAW();
  const active = () => { if (deadlineMs !== undefined) assert(Number.isSafeInteger(deadlineMs) && Date.now() < deadlineMs, "共有publisherの新規IO期限です"); };
  active();
  const signal = deadlineMs === undefined ? undefined : AbortSignal.timeout(deadlineMs - Date.now());
  return {
    async get(key, maxBytes) {
      active();
      const found = await r2GetBytesVersion(key, bucket, { singleAttempt: true, maxBytes, beforeAttempt: active,
        abortSignal: signal === undefined ? AbortSignal.timeout(60_000) : AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
      return found === null ? null : { body: new TextDecoder("utf-8", { fatal: true }).decode(found.body), etag: found.etag };
    },
    put: (key, body, etag) => r2PutBytes(key, new TextEncoder().encode(body), etag, bucket, "application/json", undefined,
      { beforeAttempt: active, abortSignal: signal }),
  };
}
function stateOf(body: string): State {
  const state: State = JSON.parse(body);
  assert(state && typeof state === "object");
  assert.deepEqual(Object.keys(state).sort(), ["baselineSha256", "owner", "pending", "version"]);
  assert.equal(state.version, 1); assert.match(state.baselineSha256, /^[a-f0-9]{64}$/);
  if (state.owner !== null) {
    assert.deepEqual(Object.keys(state.owner).sort(), ["id", "startedAt"]);
    assert.match(state.owner.id, /^[a-f0-9-]{36}$/); assert(Number.isFinite(Date.parse(state.owner.startedAt)));
  }
  if (state.pending !== null) {
    assert(state.owner !== null); assert.deepEqual(Object.keys(state.pending).sort(), ["bytes", "key", "kind", "snapshotSha256"]);
    assert.match(state.pending.key, /^mechanical-publishing\/v1\/operations\/[a-f0-9]{64}$/);
    assert(["supplement-create", "supplement-update", "yutai-summary", "yutai-source-import"].includes(state.pending.kind));
    assert.match(state.pending.snapshotSha256, /^[a-f0-9]{64}$/);
    assert(Number.isSafeInteger(state.pending.bytes) && state.pending.bytes > 0 && state.pending.bytes <= MAX_SNAPSHOT);
  }
  return state;
}
async function putVerified(store: PublishingStore, key: string, body: string, etag: string | null, maximum: number) {
  assert(Buffer.byteLength(body) <= maximum);
  await store.put(key, body, etag); // Unknown PUT stops here: never read/retry it automatically.
  const found = await store.get(key, maximum);
  assert(found && typeof found.etag === "string" && found.etag.length > 0 && found.body === body, "共有publisherの全文読戻し不一致");
  return found;
}

/** Called only after the accepted Mac's canonical journals have been validated under its kernel lock. */
export async function initializeSharedPublishingWriter(baseline: unknown, store = publishingStore(), initialCursors: Partial<Record<"supplement-texts" | "yutai-summary", string>> = {}): Promise<void> {
  assert(process.platform === "darwin" && process.arch === "arm64", "共有publisherの初期化は受入済みMacからだけ行います");
  assert.equal(await store.get(SHARED_WRITER_KEY, MAX_STATE), null, "既存共有状態を再初期化しません");
  const snapshot = encode(baseline), baselineSha256 = sha(snapshot);
  await putVerified(store, `mechanical-publishing/v1/baselines/${baselineSha256}.json`, snapshot, null, MAX_SNAPSHOT);
  for (const [name, body] of Object.entries(initialCursors)) {
    assert(["supplement-texts", "yutai-summary"].includes(name)); JSON.parse(body);
    await putVerified(store, `mechanical-publishing/v1/cursors/${name}.json`, body, null, MAX_STATE);
  }
  await putVerified(store, SHARED_WRITER_KEY, encode({ version: 1, baselineSha256, owner: null, pending: null }), null, MAX_STATE);
}

export async function withSharedPublishingWriter<T>(execute: () => Promise<T>, store = publishingStore()): Promise<T> {
  assert.equal(current.getStore(), undefined, "共有publisherの二重取得を拒否します");
  const before = await store.get(SHARED_WRITER_KEY, MAX_STATE);
  assert(before, "共有publisher未初期化。旧Macの未閉鎖journalを検証してから明示移行してください");
  let state = stateOf(before.body), etag = before.etag, stopped = false;
  let reserveStarted = false, cursorWriteStarted = false;
  assert(state.owner === null && state.pending === null, "共有publisherに未閉鎖owner/intentがあります。期限では解除しません");
  const owner = { id: randomUUID(), startedAt: new Date().toISOString() };
  const baselineSha256 = state.baselineSha256;
  const cursors = new Map<string, string | null>();
  const guard = async <R>(run: () => Promise<R>): Promise<R> => {
    assert(!stopped, "共有publisher sticky STOP");
    try { return await run(); } catch (error) { stopped = true; throw error; }
  };
  const readOwned = async () => {
    const found = await store.get(SHARED_WRITER_KEY, MAX_STATE); assert(found);
    const actual = stateOf(found.body);
    assert.equal(actual.baselineSha256, baselineSha256); assert.deepEqual(actual.owner, owner, "共有publisherの所有権が変わりました");
    assert.deepEqual(actual, state, "共有publisher状態が並行変更されました"); etag = found.etag;
  };
  const write = async (next: State) => {
    const saved = await putVerified(store, SHARED_WRITER_KEY, encode(next), etag, MAX_STATE);
    state = next; etag = saved.etag;
  };
  await guard(() => write({ ...state, owner }));
  const writer: PublishingWriter = {
    assertReady: () => guard(async () => { await readOwned(); assert.equal(state.pending, null, "共有publicationが未閉鎖です"); }),
    readCursor: name => guard(async () => {
      await writer.assertReady();
      const found = await store.get(`mechanical-publishing/v1/cursors/${name}.json`, MAX_STATE);
      cursors.set(name, found === null ? null : found.etag); return found === null ? null : found.body;
    }),
    writeCursor: async (name, body) => { cursorWriteStarted = true; return guard(async () => {
      await writer.assertReady(); assert(cursors.has(name), "cursorを読まず上書きしません"); JSON.parse(body);
      const saved = await putVerified(store, `mechanical-publishing/v1/cursors/${name}.json`, body, cursors.get(name)!, MAX_STATE);
      cursors.set(name, saved.etag);
    }); },
    reserve: async (kind, identity, snapshot) => { reserveStarted = true; return guard(async () => {
      await writer.assertReady();
      const snapshotSha256 = sha(snapshot), bytes = Buffer.byteLength(snapshot);
      assert(bytes > 0 && bytes <= MAX_SNAPSHOT);
      const key = `mechanical-publishing/v1/operations/${sha(JSON.stringify({ kind, identity, snapshotSha256 }))}`;
      await write({ ...state, pending: { key, kind, snapshotSha256, bytes } });
      await putVerified(store, `${key}/request.json`, snapshot, null, MAX_SNAPSHOT);
      let completed = false;
      return { complete: output => guard(async () => {
        assert(!completed); await readOwned(); assert.equal(state.pending?.key, key);
        await putVerified(store, `${key}/completed.json`, encode({ version: 1, kind, snapshotSha256, output, at: new Date().toISOString() }), null, MAX_STATE);
        await write({ ...state, pending: null }); completed = true;
      }) };
    }); },
    supplementJournal: () => ({
      assertReady: writer.assertReady,
      async reserveCreate(input) {
        const publication = await writer.reserve("supplement-create", { dbId: input.dbId, stockCode: input.stockCode, nextDocId: input.nextDocId }, input.snapshot);
        return { complete: publication.complete };
      },
      async reserve(input) {
        const publication = await writer.reserve("supplement-update", { pageId: input.pageId, nextDocId: input.nextDocId, archiveKey: input.archiveKey }, input.snapshot);
        return { complete: publication.complete };
      },
    }),
  };
  // A thrown error leaves the shared owner/intent intact. No finally-unlock or TTL takeover.
  return current.run(writer, async () => {
    try {
      const result = await execute(); await writer.assertReady(); await guard(() => write({ ...state, owner: null })); return result;
    } catch (error) {
      if (error instanceof PublishingReadOnlyError && !reserveStarted && !cursorWriteStarted && !stopped) {
        await guard(async () => { await readOwned(); assert.equal(state.pending, null); await write({ ...state, owner: null }); });
      }
      throw error;
    }
  });
}
