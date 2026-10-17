/** Mac normal publisher only: immutable full PRE + intent/verified completion, no network. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SupplementPublicationJournal, SupplementPreArchiveRequest } from "../../src/shared/notion-archive/stock-supplement.js";
import { SUPPLEMENT_PROPS, verifySupplementPreArchive, finishAppliedSupplementPublication, type AppliedSupplementSnapshot } from "../../src/shared/notion-archive/stock-supplement.js";
import { notionRequest, NotionUnknownResultError } from "../../src/shared/notion-archive/client.js";
import { canonicalizeForHash } from "../../src/shared/notion-archive/biztag-ledger.js";
import { syncParent } from "./clef-journal.js";

const PRE_MAX = 64 * 1024 ** 2, RECORD_MAX = 1024 ** 2, STORE_MAX = 4 * 1024 ** 3;
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function privatePath(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  assert(directory ? stat.isDirectory() : stat.isFile(), "publication path type/symlink");
  assert.equal(stat.mode & 0o077, 0, "publication path permissions");
  assert.equal(stat.uid, process.getuid?.(), "publication path owner");
}
function keys(value: object, expected: string[]): void { assert.deepEqual(Object.keys(value).sort(), expected.sort()); }
function read(path: string, maximum: number): Buffer {
  privatePath(path, false); assert(lstatSync(path).size <= maximum, "publication file size"); return readFileSync(path);
}
const decode = (raw: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(raw);
function snapshotOldDocId(raw: Uint8Array, pageId: string, nextDocId: string): string | null {
  const snapshot = JSON.parse(decode(raw));
  assert.equal(snapshot.page.id, pageId);
  const doc = (properties: Record<string, { rich_text: Array<{ type: string; text: { content: string } }> }>) => {
    const text = properties[SUPPLEMENT_PROPS.docId].rich_text;
    assert(Array.isArray(text) && text.every(part => part.type === "text" && typeof part.text.content === "string"));
    const value = text.map(part => part.text.content).join(""); return value === "" ? null : value;
  };
  assert.equal(doc(snapshot.expectedProperties), nextDocId);
  return doc(snapshot.page.properties);
}

function assertCreateIdentity(raw: Uint8Array, input: { dbId: string; stockCode: string; nextDocId: string | null }): void {
  const request = JSON.parse(decode(raw));
  keys(request, request.children === undefined ? ["parent", "properties"] : ["parent", "properties", "children"]);
  keys(request.parent, ["database_id"]); assert.equal(request.parent.database_id, input.dbId);
  const rich = (name: string) => {
    const parts = request.properties[name].rich_text;
    assert(Array.isArray(parts) && parts.every(part => part.type === "text" && typeof part.text.content === "string"));
    return parts.map(part => part.text.content).join("");
  };
  assert.equal(rich(SUPPLEMENT_PROPS.code), input.stockCode);
  const doc = rich(SUPPLEMENT_PROPS.docId); assert.equal(doc === "" ? null : doc, input.nextDocId);
}

/** The existing kernel writer owns this state. A partial directory or record blocks every later run. */
export function createSupplementPublicationJournal(state = canonicalPublicationState()): SupplementPublicationJournal {
  return makeJournal(state);
}
export function canonicalPublicationState(): string { return join(dirname(realpathSync(fileURLToPath(new URL("../../.env", import.meta.url)))), "tmp/biztag-local"); }
interface PreArchiveResume {
  key: string; preSha256: string; intentSha256: string; archivePageId: string;
  stockCode: string; nextDocId: string; sourcePageId: string; sourceBound: boolean;
  createRequest: SupplementPreArchiveRequest; beforeWrite(): Promise<void>; qualified: boolean; consumed: boolean;
}
function makeJournal(state: string, resume?: PreArchiveResume, appliedSemantic = false): SupplementPublicationJournal {
  let stopped = false, pending = false, stored = 0;
  const root = join(state, "supplement-publications");
  const guard = <T>(action: () => T): T => {
    try { assert(!stopped, "publication journal sticky STOP"); return action(); }
    catch (cause) { stopped = true; throw new NotionUnknownResultError("補足publisherの未閉鎖/不正journalを保全し停止（再送しません）", { cause }); }
  };
  const put = (path: string, bytes: string | Uint8Array): void => {
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600, flush: true }); syncParent(path);
  };
  guard(() => {
    privatePath(state, true); assert.equal(realpathSync(state), state);
    if (!existsSync(root)) { mkdirSync(root, { mode: 0o700 }); syncParent(root); }
    privatePath(root, true);
    for (const name of readdirSync(root)) {
      assert.match(name, /^[a-f0-9]{64}$/);
      const directory = join(root, name); privatePath(directory, true);
      const names = readdirSync(directory).sort();
      if (resume?.key === name) {
        assert.deepEqual(names, ["intent.json", "pre.json"]);
        const pre = read(join(directory, "pre.json"), PRE_MAX), raw = read(join(directory, "intent.json"), RECORD_MAX), intent = JSON.parse(decode(raw));
        keys(intent, ["version", "pageId", "oldDocId", "nextDocId", "archiveKey", "preSha256", "bytes", "at"]);
        assert.equal(intent.version, 1); assert.equal(sha(pre), resume.preSha256); assert.equal(sha(raw), resume.intentSha256);
        assert.equal(intent.preSha256, resume.preSha256); assert.equal(intent.bytes, pre.length);
        assert.equal(snapshotOldDocId(pre, intent.pageId, intent.nextDocId), intent.oldDocId);
        assert.equal(name, sha(JSON.stringify({ pageId: intent.pageId, nextDocId: intent.nextDocId, archiveKey: intent.archiveKey, preSha256: intent.preSha256 })));
        assert.equal(Object.hasOwn(JSON.parse(decode(pre)), "expectedEvidence"), appliedSemantic, "explicit recovery must match mechanical/semantic kind");
        assert(Number.isFinite(Date.parse(intent.at))); stored += pre.length + raw.length;
        continue;
      }
      if (names.includes("request.json")) {
        assert.deepEqual(names, ["completed.json", "intent.json", "request.json"]);
        const request = read(join(directory, "request.json"), PRE_MAX), raw = read(join(directory, "intent.json"), RECORD_MAX), completedRaw = read(join(directory, "completed.json"), RECORD_MAX);
        const intent = JSON.parse(decode(raw)), completed = JSON.parse(decode(completedRaw));
        keys(intent, ["version", "operation", "dbId", "stockCode", "nextDocId", "requestSha256", "bytes", "at"]);
        keys(completed, ["version", "operation", "dbId", "stockCode", "nextDocId", "intentSha256", "requestSha256", "pageId", "postPageSha256", "at"]);
        assert.equal(intent.version, 1); assert.equal(intent.operation, "create"); assert.equal(completed.version, 1); assert.equal(completed.operation, "create");
        for (const key of ["dbId", "stockCode"]) assert(typeof intent[key] === "string" && intent[key].length > 0);
        assert(intent.nextDocId === null || typeof intent.nextDocId === "string" && intent.nextDocId.length > 0);
        assert.equal(intent.requestSha256, sha(request)); assert.equal(intent.bytes, request.length); assertCreateIdentity(request, intent);
        assert.equal(name, sha(JSON.stringify({ operation: "create", dbId: intent.dbId, stockCode: intent.stockCode, nextDocId: intent.nextDocId, requestSha256: intent.requestSha256 })));
        assert.equal(completed.intentSha256, sha(raw)); assert.equal(completed.requestSha256, intent.requestSha256);
        for (const key of ["dbId", "stockCode", "nextDocId"]) assert.equal(completed[key], intent[key]);
        assert(typeof completed.pageId === "string" && completed.pageId.length > 0); assert.match(completed.postPageSha256, /^[a-f0-9]{64}$/);
        assert(typeof intent.at === "string" && typeof completed.at === "string" && Number.isFinite(Date.parse(intent.at)) && Number.isFinite(Date.parse(completed.at)) && Date.parse(completed.at) >= Date.parse(intent.at));
        stored += request.length + raw.length + completedRaw.length; assert(stored <= STORE_MAX, "publication store budget");
        continue;
      }
      assert.deepEqual(names, ["completed.json", "intent.json", "pre.json"]);
      const pre = read(join(directory, "pre.json"), PRE_MAX), raw = read(join(directory, "intent.json"), RECORD_MAX), completedRaw = read(join(directory, "completed.json"), RECORD_MAX);
      const intent = JSON.parse(decode(raw)), completed = JSON.parse(decode(completedRaw));
      keys(intent, ["version", "pageId", "oldDocId", "nextDocId", "archiveKey", "preSha256", "bytes", "at"]);
      keys(completed, ["version", "pageId", "oldDocId", "nextDocId", "intentSha256", "preSha256", "archivePageId", "postPageSha256", "at"]);
      assert.equal(intent.version, 1); assert.equal(completed.version, 1);
      for (const key of ["pageId", "nextDocId", "archiveKey"]) assert(typeof intent[key] === "string" && intent[key].length > 0);
      assert.equal(intent.preSha256, sha(pre)); assert.equal(intent.bytes, pre.length);
      assert.equal(snapshotOldDocId(pre, intent.pageId, intent.nextDocId), intent.oldDocId);
      assert.equal(name, sha(JSON.stringify({ pageId: intent.pageId, nextDocId: intent.nextDocId, archiveKey: intent.archiveKey, preSha256: intent.preSha256 })));
      assert.equal(completed.intentSha256, sha(raw)); assert.equal(completed.preSha256, intent.preSha256);
      assert.equal(completed.pageId, intent.pageId); assert.equal(completed.oldDocId, intent.oldDocId); assert.equal(completed.nextDocId, intent.nextDocId);
      assert(typeof completed.archivePageId === "string" && completed.archivePageId.length > 0); assert.match(completed.postPageSha256, /^[a-f0-9]{64}$/);
      assert(typeof intent.at === "string" && typeof completed.at === "string" && Number.isFinite(Date.parse(intent.at)) && Number.isFinite(Date.parse(completed.at)) && Date.parse(completed.at) >= Date.parse(intent.at));
      stored += pre.length + raw.length + completedRaw.length; assert(stored <= STORE_MAX, "publication store budget");
    }
  });
  const assertReady = () => guard(() => { assert(!pending && (resume === undefined || resume.qualified), "publication pending intent"); });
  return {
    assertReady,
    ...(resume === undefined ? {} : { bindSource(input: { stockCode: string; docId: string | null; sourcePageId: string | null }) { guard(() => {
      assert.equal(input.stockCode, resume.stockCode); assert.equal(input.docId, resume.nextDocId); assert.equal(input.sourcePageId, resume.sourcePageId); resume.sourceBound = true;
    }); } }),
    reserveCreate(input) { return guard(() => {
      assert(resume === undefined, "reconciliation cannot create another target");
      assertReady(); const request = Buffer.from(input.snapshot), requestSha256 = sha(request);
      assert(request.length <= PRE_MAX && stored + request.length + 2 * RECORD_MAX <= STORE_MAX, "publication complete-tail budget");
      for (const value of [input.dbId, input.stockCode]) assert(typeof value === "string" && value.length > 0);
      assert(input.nextDocId === null || typeof input.nextDocId === "string" && input.nextDocId.length > 0); assertCreateIdentity(request, input);
      const identity = { operation: "create", dbId: input.dbId, stockCode: input.stockCode, nextDocId: input.nextDocId, requestSha256 };
      const directory = join(root, sha(JSON.stringify(identity))); assert(!existsSync(directory), "existing creation requires read-only reconciliation");
      pending = true; mkdirSync(directory, { mode: 0o700 }); syncParent(directory); put(join(directory, "request.json"), request);
      const raw = JSON.stringify({ version: 1, ...identity, bytes: request.length, at: new Date().toISOString() }) + "\n";
      assert(Buffer.byteLength(raw) <= RECORD_MAX); put(join(directory, "intent.json"), raw); stored += request.length + Buffer.byteLength(raw);
      return { complete(output) { guard(() => {
        assert(pending); assert.equal(sha(read(join(directory, "request.json"), PRE_MAX)), requestSha256); assert.equal(read(join(directory, "intent.json"), RECORD_MAX).toString("utf8"), raw);
        assert(typeof output.pageId === "string" && output.pageId.length > 0); assert.match(output.postPageSha256, /^[a-f0-9]{64}$/);
        const completed = JSON.stringify({ version: 1, ...identity, intentSha256: sha(raw), ...output, at: new Date().toISOString() }) + "\n";
        assert(Buffer.byteLength(completed) <= RECORD_MAX && stored + Buffer.byteLength(completed) <= STORE_MAX); put(join(directory, "completed.json"), completed); stored += Buffer.byteLength(completed); pending = false;
      }); } };
    }); },
    reserve(input) { return guard(() => {
      assertReady(); const pre = Buffer.from(input.snapshot), preSha256 = sha(pre);
      assert(pre.length <= PRE_MAX && stored + pre.length + 2 * RECORD_MAX <= STORE_MAX, "publication complete-tail budget");
      for (const value of [input.pageId, input.nextDocId, input.archiveKey]) assert(typeof value === "string" && value.length > 0);
      const oldDocId = snapshotOldDocId(pre, input.pageId, input.nextDocId);
      const key = sha(JSON.stringify({ pageId: input.pageId, nextDocId: input.nextDocId, archiveKey: input.archiveKey, preSha256 })), directory = join(root, key);
      let raw: string;
      if (resume !== undefined) {
        assert(resume.qualified && resume.sourceBound && !resume.consumed && key === resume.key && preSha256 === resume.preSha256, "reconciliation must consume the same original input/key once");
        assert(read(join(directory, "pre.json"), PRE_MAX).equals(pre)); raw = decode(read(join(directory, "intent.json"), RECORD_MAX));
        assert.equal(sha(raw), resume.intentSha256); resume.consumed = true; pending = true;
      } else {
        assert(!existsSync(directory), "existing publication operation requires read-only reconciliation");
        pending = true; mkdirSync(directory, { mode: 0o700 }); syncParent(directory); put(join(directory, "pre.json"), pre);
        raw = JSON.stringify({ version: 1, pageId: input.pageId, oldDocId, nextDocId: input.nextDocId, archiveKey: input.archiveKey, preSha256, bytes: pre.length, at: new Date().toISOString() }) + "\n";
        put(join(directory, "intent.json"), raw); stored += pre.length + Buffer.byteLength(raw);
      }
      return { ...(resume === undefined ? {} : { preArchive: { pageId: resume.archivePageId, createRequest: resume.createRequest, beforeWrite: resume.beforeWrite } }), complete(output) { guard(() => {
        assert(pending); assert.equal(sha(read(join(directory, "pre.json"), PRE_MAX)), preSha256); assert.equal(read(join(directory, "intent.json"), RECORD_MAX).toString("utf8"), raw);
        assert(typeof output.archivePageId === "string" && output.archivePageId.length > 0); assert.match(output.postPageSha256, /^[a-f0-9]{64}$/);
        if (resume !== undefined) assert.equal(output.archivePageId, resume.archivePageId);
        const completed = JSON.stringify({ version: 1, pageId: input.pageId, oldDocId, nextDocId: input.nextDocId, intentSha256: sha(raw), preSha256, ...output, at: new Date().toISOString() }) + "\n";
        assert(stored + Buffer.byteLength(completed) <= STORE_MAX); put(join(directory, "completed.json"), completed); stored += Buffer.byteLength(completed); pending = false;
      }); } };
    }); },
  };
}

interface CapturedFile { path: string; sha256: string }
interface CapturedNative {
  index: number; intent: CapturedFile; request: CapturedFile | null;
  response: CapturedFile | null; responseMetadata: CapturedFile | null;
}
export interface PreArchiveReconciliationProof {
  version: 1; stockCode: string; journalKey: string; intentSha256: string; preSha256: string;
  archivePageId: string; sourcePage: CapturedFile; natives: CapturedNative[];
}

/** Operator pins the complete captured native baseline; this does not reconstruct missing historical sends. */
export async function reconcileSupplementPreArchive(input: { proofPath: string; proofSha256: string; stockCode: string; state?: string }): Promise<{
  journal: SupplementPublicationJournal; assertComplete(): void;
}> {
  const state = input.state === undefined ? canonicalPublicationState() : input.state;
  assert.match(input.proofSha256, /^[a-f0-9]{64}$/);
  const proofRaw = read(realpathSync(input.proofPath), RECORD_MAX); assert.equal(sha(proofRaw), input.proofSha256);
  const proof: PreArchiveReconciliationProof = JSON.parse(decode(proofRaw));
  keys(proof, ["version", "stockCode", "journalKey", "intentSha256", "preSha256", "archivePageId", "sourcePage", "natives"]);
  assert.equal(proof.version, 1); assert.equal(proof.stockCode, input.stockCode); assert.match(proof.stockCode, /^[0-9][0-9A-Z]{3}$/);
  for (const hash of [proof.journalKey, proof.intentSha256, proof.preSha256]) assert.match(hash, /^[a-f0-9]{64}$/);
  assert.match(proof.archivePageId, /^[a-f0-9-]{32,36}$/);
  const directory = join(state, "supplement-publications", proof.journalKey), pre = read(join(directory, "pre.json"), PRE_MAX), raw = read(join(directory, "intent.json"), RECORD_MAX);
  assert.equal(sha(raw), proof.intentSha256); assert.equal(sha(pre), proof.preSha256);
  const intent = JSON.parse(decode(raw)), snapshot = JSON.parse(decode(pre));
  assert(!Object.hasOwn(snapshot, "expectedEvidence"), "semantic/retirement unknown cannot be reconciled");
  const plain = (p: { rich_text?: Array<{ text: { content: string } }>; title?: Array<{ text: { content: string } }> }) => {
    const parts = p.rich_text === undefined ? p.title : p.rich_text;
    assert(Array.isArray(parts) && parts.length < 25 && parts.every(v => typeof v.text?.content === "string")); return parts.map(v => v.text.content).join("");
  };
  assert.equal(plain(snapshot.page.properties[SUPPLEMENT_PROPS.code]), proof.stockCode);
  assert(Array.isArray(proof.natives) && proof.natives.length > 4 && proof.natives.length <= 1024);
  let bytes = pre.length, previous = -Infinity;
  const get = (file: CapturedFile, maximum: number) => {
    keys(file, ["path", "sha256"]); assert.match(file.sha256, /^[a-f0-9]{64}$/);
    const value = read(realpathSync(file.path), maximum); bytes += value.length; assert(bytes <= 256 * 1024 ** 2, "captured baseline byte budget"); assert.equal(sha(value), file.sha256); return value;
  };
  const records = proof.natives.map((native, index) => {
    keys(native, ["index", "intent", "request", "response", "responseMetadata"]); assert.equal(native.index, index + 1);
    assert(native.intent.path.endsWith(`/intent-${index + 1}.json`));
    const captured = JSON.parse(decode(get(native.intent, RECORD_MAX))), at = Date.parse(captured.at);
    assert(Number.isFinite(at) && at >= previous); previous = at;
    assert(["GET", "POST", "PATCH", "DELETE"].includes(captured.method)); assert.match(captured.pathSha256, /^[a-f0-9]{64}$/);
    assert.equal(native.request === null, !existsSync(join(dirname(native.intent.path), `request-${index + 1}.body`)));
    const request = native.request === null ? null : get(native.request, PRE_MAX);
    if (native.request !== null) assert.equal(native.request.path, join(dirname(native.intent.path), `request-${index + 1}.body`));
    if (index === proof.natives.length - 1) {
      assert.equal(native.response, null); assert.equal(native.responseMetadata, null);
      assert(!existsSync(join(dirname(native.intent.path), `response-${index + 1}.body`)) && !existsSync(join(dirname(native.intent.path), `response-${index + 1}.json`)));
      return { captured, at, request, response: null };
    }
    assert(native.response !== null && native.responseMetadata !== null);
    assert.equal(native.response.path, join(dirname(native.intent.path), `response-${index + 1}.body`));
    assert.equal(native.responseMetadata.path, join(dirname(native.intent.path), `response-${index + 1}.json`));
    const response = get(native.response, 16 * 1024 ** 2), metadata = JSON.parse(decode(get(native.responseMetadata, RECORD_MAX)));
    assert.equal(metadata.status, 200); assert.equal(metadata.sha256, sha(response)); assert.equal(metadata.bytes, response.length);
    assert(Number.isFinite(Date.parse(metadata.at)) && Date.parse(metadata.at) >= at);
    return { captured, at, request, response };
  });
  // Complete counter inventory prevents dropping a captured business attempt from the supplied baseline.
  const captureDirectory = dirname(proof.natives[0].intent.path);
  assert(proof.natives.every(v => dirname(v.intent.path) === captureDirectory));
  assert.deepEqual(readdirSync(captureDirectory).filter(v => /^intent-\d+\.json$/.test(v)).sort(), proof.natives.map(v => `intent-${v.index}.json`).sort());
  const after = records.filter(v => v.at >= Date.parse(intent.at));
  assert.equal(after.length, 4, "only current normal single-part PRE query/upload/send/archive POST is supported");
  assert(after.every(v => v.captured.kind === "Notion" && v.captured.method === "POST" && v.request !== null));
  const [query, create, send, last] = after, createRequest = JSON.parse(decode(last.request!)) as SupplementPreArchiveRequest;
  assert.equal(last.captured.pathSha256, sha("/v1/pages"));
  assert.equal(query.captured.pathSha256, sha(`/v1/databases/${createRequest.parent.database_id}/query`));
  assert.deepEqual(JSON.parse(decode(query.request!)), { filter: { property: "Key", title: { equals: intent.archiveKey } }, page_size: 2 });
  const queryResponse = JSON.parse(decode(query.response!)); assert.deepEqual(queryResponse.results, []); assert.equal(queryResponse.has_more, false); assert.equal(queryResponse.next_cursor, null);
  assert.equal(create.captured.pathSha256, sha("/v1/file_uploads"));
  assert.deepEqual(JSON.parse(decode(create.request!)), { mode: "single_part", filename: "biztag-pre.json", content_type: "application/json" });
  const upload = JSON.parse(decode(create.response!)), uploaded = JSON.parse(decode(send.response!));
  assert.equal(upload.object, "file_upload"); assert.equal(upload.status, "pending");
  assert.equal(send.captured.pathSha256, sha(`/v1/file_uploads/${upload.id}/send`));
  assert.equal(uploaded.id, upload.id); assert.equal(uploaded.object, "file_upload"); assert.equal(uploaded.status, "uploaded");
  assert.equal(uploaded.filename, "biztag-pre.json"); assert.equal(uploaded.content_length, pre.length);
  const lineEnd = send.request!.indexOf("\r\n"); assert(lineEnd > 2 && lineEnd <= 202);
  const firstLine = send.request!.subarray(0, lineEnd), boundary = /^--([A-Za-z0-9'()+_,./:=?-]+)$/.exec(firstLine.toString("ascii"))?.[1];
  assert(boundary && Buffer.from(`--${boundary}`, "ascii").equals(firstLine));
  const multipart = await new Response(Uint8Array.from(send.request!), { headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` } }).formData();
  const fields: string[] = []; multipart.forEach((_value, name) => fields.push(name));
  assert.deepEqual(fields, ["file"]); const file = multipart.get("file"); assert(file instanceof File && file.name === "biztag-pre.json" && file.type === "application/json");
  assert(Buffer.from(await file.arrayBuffer()).equals(pre));
  assert.equal(plain(createRequest.properties.Key), intent.archiveKey); assert.equal(plain(createRequest.properties.Source), `Notion supplement ${intent.pageId}`);
  assert.deepEqual(createRequest.properties.Files, { files: [{ name: "biztag-pre.json", type: "file_upload", file_upload: { id: upload.id } }] });
  const metadata = JSON.parse(plain(createRequest.properties.Metadata)); assert.equal(metadata.pageId, intent.pageId); assert.equal(metadata.nextDocId, intent.nextDocId); assert.equal(metadata.sha256, proof.preSha256);
  const source = JSON.parse(decode(get(proof.sourcePage, RECORD_MAX)));
  assert.equal(source.object, "page"); assert.match(source.id, /^[a-f0-9-]{32,36}$/); assert.equal(source.archived, false); assert.equal(source.in_trash, false);
  assert.equal(plain(source.properties["文書"]), intent.nextDocId); assert.equal(plain(source.properties["銘柄コード"]), proof.stockCode);
  const sourceKeys = ["object", "id", "parent", "created_time", "last_edited_time", "archived", "in_trash", "properties"];
  for (const key of sourceKeys) assert(Object.hasOwn(source, key));
  assert(Number.isFinite(Date.parse(source.created_time)) && Number.isFinite(Date.parse(source.last_edited_time)));
  const beforeWrite = async () => {
    const fresh = await notionRequest<Record<string, unknown>>("GET", `/pages/${source.id}`, undefined, { singleAttempt: true });
    for (const key of sourceKeys) assert.equal(JSON.stringify(canonicalizeForHash(fresh[key])), JSON.stringify(canonicalizeForHash(source[key])), "source metadata changed after explicit PRE reconciliation");
  };
  const resume: PreArchiveResume = { key: proof.journalKey, preSha256: proof.preSha256, intentSha256: proof.intentSha256, archivePageId: proof.archivePageId,
    stockCode: proof.stockCode, nextDocId: intent.nextDocId, sourcePageId: source.id, sourceBound: false, createRequest, beforeWrite, qualified: false, consumed: false };
  const journal = makeJournal(state, resume); // Every other pending/malformed operation still stops before HTTP.
  const sidecarRoot = join(state, "supplement-pre-archive-reconciliations");
  if (!existsSync(sidecarRoot)) { mkdirSync(sidecarRoot, { mode: 0o700 }); syncParent(sidecarRoot); } privatePath(sidecarRoot, true);
  const sidecar = join(sidecarRoot, proof.journalKey); assert(!existsSync(sidecar), "explicit reconciliation was already attempted; no resend");
  mkdirSync(sidecar, { mode: 0o700 }); syncParent(sidecar);
  const put = (name: string, value: unknown) => { const path = join(sidecar, name); writeFileSync(path, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600, flush: true }); syncParent(path); };
  const binding = { version: 1, journalKey: proof.journalKey, stockCode: proof.stockCode, intentSha256: proof.intentSha256, preSha256: proof.preSha256, proofSha256: input.proofSha256, archivePageId: proof.archivePageId };
  put("attempt.json", { ...binding, at: new Date().toISOString() });
  await verifySupplementPreArchive(proof.archivePageId, intent.archiveKey, decode(pre), createRequest);
  await beforeWrite();
  put("pre_archive_reconciled.json", { ...binding, at: new Date().toISOString(), phase: "pre_archive_reconciled", businessWrites: 0 }); resume.qualified = true;
  return { journal, assertComplete() {
    assert(resume.consumed, "original publication was not consumed"); createSupplementPublicationJournal(state).assertReady();
    const completed = JSON.parse(decode(read(join(directory, "completed.json"), RECORD_MAX)));
    assert.equal(completed.intentSha256, proof.intentSha256); assert.equal(completed.preSha256, proof.preSha256); assert.equal(completed.archivePageId, proof.archivePageId);
  } };
}

export interface AppliedPublicationProof {
  version: 1; stockCode: string; journalKey: string; intentSha256: string; preSha256: string;
  archivePageId: string; sourcePage: CapturedFile;
  sourceDoc: { docId: string; docTypeCode: "120" | "130"; periodEnd: string; submittedAt: string; notionDocPageId: string; textParseStatus: string };
  natives: Array<CapturedNative & { nativeStart: CapturedFile }>; nativeStop: CapturedFile;
}

/** Explicit once-only closure of an ACKed semantic publication. Original PRE/intent never change. */
export async function reconcileAppliedSupplementPublication(input: {
  proofPath: string; proofSha256: string; stockCode: string; state?: string;
  beforeWrite(doc: AppliedPublicationProof["sourceDoc"]): Promise<void>; notAfter: number;
}): Promise<void> {
  const state = input.state === undefined ? canonicalPublicationState() : input.state;
  assert.match(input.proofSha256, /^[a-f0-9]{64}$/); assert.equal(typeof input.beforeWrite, "function");
  const active = () => assert(Number.isFinite(input.notAfter) && Date.now() < input.notAfter, "applied recovery finite deadline"); active();
  const proofRaw = read(realpathSync(input.proofPath), RECORD_MAX); assert.equal(sha(proofRaw), input.proofSha256);
  const proof: AppliedPublicationProof = JSON.parse(decode(proofRaw));
  keys(proof, ["version", "stockCode", "journalKey", "intentSha256", "preSha256", "archivePageId", "sourcePage", "sourceDoc", "natives", "nativeStop"]);
  assert.equal(proof.version, 1); assert.equal(proof.stockCode, input.stockCode); assert.match(proof.stockCode, /^[0-9]{3}[0-9A-Z]$/);
  for (const hash of [proof.journalKey, proof.intentSha256, proof.preSha256]) assert.match(hash, /^[a-f0-9]{64}$/);
  const directory = join(state, "supplement-publications", proof.journalKey), pre = read(join(directory, "pre.json"), PRE_MAX), intentRaw = read(join(directory, "intent.json"), RECORD_MAX);
  assert.equal(sha(pre), proof.preSha256); assert.equal(sha(intentRaw), proof.intentSha256);
  const snapshot: AppliedSupplementSnapshot = JSON.parse(decode(pre)), intent = JSON.parse(decode(intentRaw));
  assert(Object.hasOwn(snapshot, "expectedEvidence") && snapshot.expectedEvidence !== null);
  const plain = (p: unknown) => { assert(p && typeof p === "object"); const value = p as { rich_text?: unknown; title?: unknown }; const parts = value.rich_text === undefined ? value.title : value.rich_text; assert(Array.isArray(parts)); return parts.map(v => { assert.equal(typeof v.text?.content, "string"); return v.text.content as string; }).join(""); };
  assert.equal(plain(snapshot.page.properties[SUPPLEMENT_PROPS.code]), proof.stockCode);
  assert.equal(proof.sourceDoc.docId, intent.nextDocId); assert.match(proof.sourceDoc.docId, /^S[0-9A-Z]{7}$/);
  keys(proof.sourceDoc, ["docId", "docTypeCode", "periodEnd", "submittedAt", "notionDocPageId", "textParseStatus"]);
  let bytes = pre.length, previousAt = -Infinity;
  const get = (file: CapturedFile, maximum: number) => { keys(file, ["path", "sha256"]); assert.match(file.sha256, /^[a-f0-9]{64}$/); const value = read(realpathSync(file.path), maximum); bytes += value.length; assert(bytes <= 256 * 1024 ** 2); assert.equal(sha(value), file.sha256); return value; };
  assert(Array.isArray(proof.natives) && proof.natives.length >= 15 && proof.natives.length <= 1024);
  const nativeDirectory = dirname(proof.natives[0].intent.path);
  const records = proof.natives.map((n, i) => {
    keys(n, ["index", "intent", "request", "response", "responseMetadata", "nativeStart"]); assert.equal(n.index, i + 1); assert.equal(n.intent.path, join(nativeDirectory, `intent-${i + 1}.json`));
    assert(n.request !== null && n.response !== null && n.responseMetadata !== null);
    for (const [file, name] of [[n.request, "request"], [n.response, "response"], [n.responseMetadata, "responseMetadata"]] as const) assert.equal(file.path, join(nativeDirectory, name === "responseMetadata" ? `response-${i + 1}.json` : `${name}-${i + 1}.body`));
    const a = JSON.parse(decode(get(n.intent, RECORD_MAX))), request = get(n.request, PRE_MAX), response = get(n.response, PRE_MAX), m = JSON.parse(decode(get(n.responseMetadata, RECORD_MAX)));
    assert.equal(a.sequence, i + 1); assert(["GET", "POST", "PATCH"].includes(a.method), "unsupported/unknown native mutation"); assert(Number.isFinite(Date.parse(a.at)) && Date.parse(a.at) >= previousAt); previousAt = Date.parse(a.at);
    assert.equal(n.nativeStart.path, join(nativeDirectory, `native-start-${i + 1}.json`)); const started = JSON.parse(decode(get(n.nativeStart, RECORD_MAX))); assert.equal(started.sequence, i + 1); assert.equal(started.method, a.method); assert.equal(started.urlSha256, a.urlSha256); assert(Number.isFinite(started.monotonicMs) && Number.isFinite(Date.parse(started.startedAt)));
    assert.equal(a.bodySha256, sha(request)); assert.equal(a.bodyBytes, request.length); assert.equal(a.resend, 0);
    for (const k of Object.keys(a)) assert.deepEqual(m[k], a[k]); assert.equal(m.status, 200); assert.equal(m.sha256, sha(response)); assert.equal(m.bytes, response.length);
    assert(["notion_read", "notion_mutation", "discovered_hosted_read", "d1_read"].includes(a.kind)); assert.notEqual(a.method, "DELETE", "any native retirement attempt remains unknown; never retry");
    return { a, request, response };
  });
  assert.deepEqual(readdirSync(nativeDirectory).filter(v => /^intent-\d+\.json$/.test(v)).sort(), proof.natives.map(n => `intent-${n.index}.json`).sort());
  for (const stem of ["request", "response", "native-start"]) { const suffix = stem === "native-start" ? "json" : "body"; assert.deepEqual(readdirSync(nativeDirectory).filter(v => new RegExp(`^${stem}-\\d+\\.${suffix}$`).test(v)).sort(), records.map((_, i) => `${stem}-${i + 1}.${suffix}`).sort()); }
  assert.deepEqual(readdirSync(nativeDirectory).filter(v => /^response-\d+\.json$/.test(v)).sort(), records.map((_, i) => `response-${i + 1}.json`).sort());
  assert.deepEqual(readdirSync(nativeDirectory).filter(v => v.startsWith("NATIVE-STOP-")), ["NATIVE-STOP-preflight.json"]); assert(!readdirSync(nativeDirectory).some(v => /-partial\.(body|json)$/.test(v)));
  assert.equal(proof.nativeStop.path, join(nativeDirectory, "NATIVE-STOP-preflight.json")); const stopped = JSON.parse(decode(get(proof.nativeStop, RECORD_MAX))); assert.equal(stopped.nativeAttempts, records.length); assert.equal(stopped.errorName, "SyntaxError"); assert.equal(stopped.resend, 0);
  const tail = records.filter(v => Date.parse(v.a.at) >= Date.parse(intent.at)); assert.equal(tail.length, 15, "only exact applied-before-retirement publisher tail is supported");
  const [query, upload, send, archive, archiveGet, hosted, cas, casProperty, latest, append, newGet, newChildren, patch, after, afterProperty] = tail;
  assert(records.every(r => r.a.method !== "PATCH" || r === append || r === patch), "unbound business mutation in native inventory");
  const expectRequest = (r: typeof tail[number], method: string, path: string) => { assert.equal(r.a.method, method); assert.equal(r.a.path, path); };
  const archiveRequest = JSON.parse(decode(archive.request)) as SupplementPreArchiveRequest;
  expectRequest(query, "POST", `/v1/databases/${archiveRequest.parent.database_id}/query`); assert.deepEqual(JSON.parse(decode(query.request)), { filter: { property: "Key", title: { equals: intent.archiveKey } }, page_size: 2 });
  const qr = JSON.parse(decode(query.response)); assert.deepEqual(qr.results, []); assert.equal(qr.has_more, false); assert.equal(qr.next_cursor, null);
  expectRequest(upload, "POST", "/v1/file_uploads"); const up = JSON.parse(decode(upload.response)); expectRequest(send, "POST", `/v1/file_uploads/${up.id}/send`);
  const boundary = /^--([^\r\n]+)\r\n/.exec(decode(send.request))?.[1]; assert(boundary);
  const form = await new Response(Uint8Array.from(send.request), { headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` } }).formData(), file = form.get("file");
  const fields: string[] = []; form.forEach((_v, name) => fields.push(name)); assert.deepEqual(fields, ["file"]); assert(file instanceof File && file.name === "biztag-pre.json" && file.type === "application/json"); assert(Buffer.from(await file.arrayBuffer()).equals(pre));
  assert.equal(JSON.parse(decode(send.response)).status, "uploaded"); expectRequest(archive, "POST", "/v1/pages"); assert.equal(JSON.parse(decode(archive.response)).id, proof.archivePageId);
  assert.equal(JSON.parse(plain(archiveRequest.properties.Metadata)).sha256, proof.preSha256); expectRequest(archiveGet, "GET", `/v1/pages/${proof.archivePageId}`); assert.equal(hosted.a.kind, "discovered_hosted_read"); assert(hosted.response.equals(pre));
  expectRequest(cas, "GET", `/v1/pages/${intent.pageId}`);
  const last = JSON.parse(decode(latest.response)); assert.equal(latest.a.kind, "d1_read"); assert.equal(last.success, true); assert.equal(last.result.length, 1); assert.equal(last.result[0].success, true);
  assert.deepEqual(last.result[0].results, [{ doc_id: proof.sourceDoc.docId, doc_type_code: proof.sourceDoc.docTypeCode, period_end: proof.sourceDoc.periodEnd, submitted_at: Date.parse(proof.sourceDoc.submittedAt) / 1000, notion_doc_page_id: proof.sourceDoc.notionDocPageId, text_parse_status: proof.sourceDoc.textParseStatus }]);
  expectRequest(append, "PATCH", `/v1/blocks/${intent.pageId}/children`); assert.deepEqual(JSON.parse(decode(append.request)), { children: [snapshot.expectedEvidence] });
  const added = JSON.parse(decode(append.response)); assert.equal(added.results.length, 1); const newEvidenceId = added.results[0].id; expectRequest(newGet, "GET", `/v1/blocks/${newEvidenceId}`); expectRequest(newChildren, "GET", `/v1/blocks/${newEvidenceId}/children`);
  const recordedNewEvidence = JSON.parse(decode(newGet.response)), newList = JSON.parse(decode(newChildren.response)); assert.equal(recordedNewEvidence.id, newEvidenceId); assert.equal(recordedNewEvidence.archived, false); assert.equal(recordedNewEvidence.in_trash, false); assert.equal(newList.has_more, false); assert.equal(newList.next_cursor, null); recordedNewEvidence[recordedNewEvidence.type].children = newList.results;
  expectRequest(patch, "PATCH", `/v1/pages/${intent.pageId}`); assert.deepEqual(JSON.parse(decode(patch.request)), { properties: snapshot.expectedProperties });
  // Replay exactly one terminal property read, using the same relation/title/rich_text shape as evidencePage.
  const capturedPage = (pageRecord: typeof after, propertyRecord: typeof afterProperty) => {
    expectRequest(pageRecord, "GET", `/v1/pages/${intent.pageId}`); const page = JSON.parse(decode(pageRecord.response)); delete page.request_id;
    const prefix = `/v1/pages/${intent.pageId}/properties/`; assert.equal(propertyRecord.a.method, "GET"); assert(propertyRecord.a.path.startsWith(prefix));
    const propertyId = decodeURIComponent(propertyRecord.a.path.slice(prefix.length)), property = Object.values(page.properties).find((p: unknown) => (p as { id: string }).id === propertyId) as Record<string, unknown>; assert(property);
    const kind = "relation" in property ? "relation" : "rich_text" in property ? "rich_text" : "title" in property ? "title" : null; assert(kind);
    const expanded = JSON.parse(decode(propertyRecord.response)); assert.equal(expanded.has_more, false); assert.equal(expanded.next_cursor, null);
    assert(Array.isArray(expanded.results) && expanded.results.every((p: Record<string, unknown>) => kind in p)); property[kind] = expanded.results.map((p: Record<string, unknown>) => p[kind]); return page;
  };
  assert.deepEqual(canonicalizeForHash(capturedPage(cas, casProperty)), canonicalizeForHash(snapshot.page));
  const appliedPage = capturedPage(after, afterProperty);
  const source = JSON.parse(decode(get(proof.sourcePage, RECORD_MAX))); assert.equal(source.id, proof.sourceDoc.notionDocPageId); assert.equal(source.archived, false); assert.equal(source.in_trash, false); assert.equal(plain(source.properties["文書"]), intent.nextDocId); assert.equal(plain(source.properties["銘柄コード"]), proof.stockCode);
  const sourceKeys = ["object", "id", "parent", "created_time", "last_edited_time", "archived", "in_trash", "properties"];
  const beforeWrite = async () => { active(); await input.beforeWrite(proof.sourceDoc); active(); const fresh = await notionRequest<Record<string, unknown>>("GET", `/pages/${source.id}`, undefined, { singleAttempt: true }); for (const k of sourceKeys) assert.deepEqual(canonicalizeForHash(fresh[k]), canonicalizeForHash(source[k]), "applied publication source changed"); active(); };
  const resume: PreArchiveResume = { key: proof.journalKey, preSha256: proof.preSha256, intentSha256: proof.intentSha256, archivePageId: proof.archivePageId, stockCode: proof.stockCode, nextDocId: intent.nextDocId, sourcePageId: source.id, sourceBound: false, createRequest: archiveRequest, beforeWrite, qualified: true, consumed: false };
  const journal = makeJournal(state, resume, true); journal.bindSource!({ stockCode: proof.stockCode, docId: intent.nextDocId, sourcePageId: source.id });
  const sidecarRoot = join(state, "supplement-applied-reconciliations"); if (!existsSync(sidecarRoot)) { mkdirSync(sidecarRoot, { mode: 0o700 }); syncParent(sidecarRoot); } privatePath(sidecarRoot, true);
  const sidecar = join(sidecarRoot, proof.journalKey); assert(!existsSync(sidecar), "applied recovery already attempted; no resend or alternate output"); mkdirSync(sidecar, { mode: 0o700 }); syncParent(sidecar);
  const put = (name: string, data: unknown) => { const path = join(sidecar, name); writeFileSync(path, JSON.stringify(data) + "\n", { flag: "wx", mode: 0o600, flush: true }); syncParent(path); };
  put("attempt.json", { version: 1, journalKey: proof.journalKey, proofSha256: input.proofSha256, intentSha256: proof.intentSha256, preSha256: proof.preSha256, at: new Date().toISOString() });
  const reservation = journal.reserve({ pageId: intent.pageId, nextDocId: intent.nextDocId, archiveKey: intent.archiveKey, snapshot: decode(pre) });
  await finishAppliedSupplementPublication({ snapshot, snapshotRaw: decode(pre), appliedPage, newEvidenceId, recordedNewEvidence, archivePageId: proof.archivePageId, archiveKey: intent.archiveKey, archiveRequest, beforeWrite, complete(output) {
    put("verified.json", { at: new Date().toISOString(), phase: "verified_before_normal_completion", proofSha256: input.proofSha256, ...output, appendWrites: 0, propertyWrites: 0 });
    reservation.complete(output); // The original normal completion is the final durable write, never a private marker.
  } });
  createSupplementPublicationJournal(state).assertReady();
}
