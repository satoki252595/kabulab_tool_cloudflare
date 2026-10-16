/** Mac normal publisher only: immutable full PRE + intent/verified completion, no network. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SupplementPublicationJournal } from "../../src/shared/notion-archive/stock-supplement.js";
import { SUPPLEMENT_PROPS } from "../../src/shared/notion-archive/stock-supplement.js";
import { NotionUnknownResultError } from "../../src/shared/notion-archive/client.js";
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
export function createSupplementPublicationJournal(state = join(dirname(realpathSync(fileURLToPath(new URL("../../.env", import.meta.url)))), "tmp/biztag-local")): SupplementPublicationJournal {
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
  const assertReady = () => guard(() => { assert(!pending, "publication pending intent"); });
  return {
    assertReady,
    reserveCreate(input) { return guard(() => {
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
      assert(!existsSync(directory), "existing publication operation requires read-only reconciliation");
      pending = true; mkdirSync(directory, { mode: 0o700 }); syncParent(directory);
      put(join(directory, "pre.json"), pre);
      const intent = { version: 1, pageId: input.pageId, oldDocId, nextDocId: input.nextDocId, archiveKey: input.archiveKey, preSha256, bytes: pre.length, at: new Date().toISOString() }, raw = JSON.stringify(intent) + "\n";
      put(join(directory, "intent.json"), raw); stored += pre.length + Buffer.byteLength(raw);
      return { complete(output) { guard(() => {
        assert(pending); assert.equal(sha(read(join(directory, "pre.json"), PRE_MAX)), preSha256); assert.equal(read(join(directory, "intent.json"), RECORD_MAX).toString("utf8"), raw);
        assert(typeof output.archivePageId === "string" && output.archivePageId.length > 0); assert.match(output.postPageSha256, /^[a-f0-9]{64}$/);
        const completed = JSON.stringify({ version: 1, pageId: input.pageId, oldDocId, nextDocId: input.nextDocId, intentSha256: sha(raw), preSha256, ...output, at: new Date().toISOString() }) + "\n";
        assert(stored + Buffer.byteLength(completed) <= STORE_MAX); put(join(directory, "completed.json"), completed); stored += Buffer.byteLength(completed); pending = false;
      }); } };
    }); },
  };
}
