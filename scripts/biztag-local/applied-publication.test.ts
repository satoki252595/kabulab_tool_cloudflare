/** Actual3625 source values with explicitly projected transport; no new business facts or network. */
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileAppliedSupplementPublication, createSupplementPublicationJournal, type AppliedPublicationProof } from "./publication-journal.js";
import { NotionUnknownResultError } from "../../src/shared/notion-archive/client.js";
import { canonicalizeForHash } from "../../src/shared/notion-archive/biztag-ledger.js";
const io = vi.hoisted(() => ({ request: vi.fn(), verify: vi.fn() }));
vi.mock("../../src/shared/notion-archive/client.js", async original => ({ ...await original<typeof import("../../src/shared/notion-archive/client.js")>(), notionRequest: io.request }));
vi.mock("../../src/shared/notion-archive/readback.js", () => ({ verifyArchivedAttachments: io.verify }));
const fixture = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/applied-3625-s100z468-20261017.json.gz", import.meta.url))).toString());
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex"), temporary: string[] = [];
const pre = Buffer.from(fixture.preBase64, "base64"), originalIntent = Buffer.from(fixture.intentBase64, "base64"), intent = JSON.parse(originalIntent.toString());
const journalKey = sha(JSON.stringify({ pageId: intent.pageId, nextDocId: intent.nextDocId, archiveKey: intent.archiveKey, preSha256: intent.preSha256 }));
const sourceDoc = { docId: "S100Z468", docTypeCode: "120" as const, periodEnd: "2026-06-30", submittedAt: "2026-09-28T10:52:00.000Z", notionDocPageId: fixture.sourcePage.id, textParseStatus: "ok" };
function setup(options: { changed?: "property" | "new-evidence" | "protected-child" | "source" | "clock" | "old-root" | "old-trash"; unknownDelete?: boolean; archived?: boolean } = {}) {
  const state = realpathSync(mkdtempSync(join(tmpdir(), "applied-publication-"))); temporary.push(state);
  const root = join(state, "supplement-publications"), directory = join(root, journalKey), native = join(state, "native");
  for (const p of [root, directory, native]) mkdirSync(p, { mode: 0o700 });
  const put = (path: string, value: string | Uint8Array) => writeFileSync(path, value, { mode: 0o600 });
  put(join(directory, "pre.json"), pre); put(join(directory, "intent.json"), originalIntent);
  const file = (name: string, bytes: Uint8Array) => { const path = join(native, name); put(path, bytes); return { path, sha256: sha(bytes) }; };
  const natives = fixture.records.map((r: { intent: unknown; requestBase64: string; responseBase64: string; responseMetadata: unknown; nativeStart: unknown }, i: number) => ({ index: i + 1,
    intent: file(`intent-${i + 1}.json`, Buffer.from(JSON.stringify(r.intent))), request: file(`request-${i + 1}.body`, Buffer.from(r.requestBase64, "base64")), response: file(`response-${i + 1}.body`, Buffer.from(r.responseBase64, "base64")), responseMetadata: file(`response-${i + 1}.json`, Buffer.from(JSON.stringify(r.responseMetadata))), nativeStart: file(`native-start-${i + 1}.json`, Buffer.from(JSON.stringify(r.nativeStart))) }));
  const proof: AppliedPublicationProof = { version: 1, stockCode: "3625", journalKey, intentSha256: sha(originalIntent), preSha256: sha(pre), archivePageId: fixture.current.archive.id, sourcePage: file("source.json", Buffer.from(JSON.stringify(fixture.sourcePage))), sourceDoc, natives, nativeStop: file("NATIVE-STOP-preflight.json", Buffer.from(JSON.stringify(fixture.nativeStop))) };
  let retired = options.archived === true;
  const oldId = fixture.current.oldBlock.id, newId = fixture.current.children.find((b: { id: string }) => b.id !== oldId).id;
  io.request.mockImplementation(async (method: string, path: string, body?: unknown, opts?: { singleAttempt: boolean }) => {
    if (method === "POST") { expect(path).toBe(`/databases/${fixture.current.archive.parent.database_id}/query`); return { results: [{ id: proof.archivePageId }], has_more: false, next_cursor: null }; }
    if (method === "DELETE") { expect(path).toBe(`/blocks/${oldId}`); expect(body).toBeUndefined(); expect(opts?.singleAttempt).toBe(true); retired = true; if (options.unknownDelete) throw new NotionUnknownResultError("declared transport failure after potential retirement"); return { id: oldId, archived: true }; }
    expect(method).toBe("GET");
    if (path === `/pages/${proof.archivePageId}`) return structuredClone(fixture.current.archive);
    if (path === `/pages/${sourceDoc.notionDocPageId}`) { const p = structuredClone(fixture.sourcePage); if (options.changed === "source") p.last_edited_time = fixture.current.target.last_edited_time; return p; }
    if (path === `/pages/${intent.pageId}`) { const p = structuredClone(fixture.current.target); if (options.changed === "clock") p.last_edited_time = fixture.sourcePage.last_edited_time; if (options.changed === "property") p.properties["有報書類ID"].rich_text[0].text.content = intent.oldDocId; return p; }
    if (path.startsWith(`/pages/${intent.pageId}/properties/Imxs`)) { const p = Object.values(fixture.current.target.properties).find((v: unknown) => (v as { id: string }).id === "Imxs") as { relation: unknown[] }; return { results: p.relation.map(v => ({ relation: v })), has_more: false, next_cursor: null }; }
    if (path === `/blocks/${oldId}`) { const b = { ...structuredClone(fixture.current.oldBlock), archived: retired, in_trash: retired }; if (options.changed === "old-root") b.last_edited_time = fixture.sourcePage.last_edited_time; if (options.changed === "old-trash") b.in_trash = true; return b; }
    if (path.startsWith(`/blocks/${intent.pageId}/children`)) { const children = structuredClone(fixture.current.children).filter((v: { id: string }) => !retired || v.id !== oldId); for (const b of children) delete b[b.type].children; if (options.changed === "protected-child") children.push(structuredClone(children[0])); return { results: children, has_more: false, next_cursor: null }; }
    for (const id of [oldId, newId]) if (path.startsWith(`/blocks/${id}/children`)) { const b = fixture.current.children.find((v: { id: string }) => v.id === id), children = structuredClone(b[b.type].children); if (id === newId && options.changed === "new-evidence") children.pop(); return { results: children, has_more: false, next_cursor: null }; }
    throw new Error(`unexpected protocol request ${method} ${path}`);
  });
  const beforeWrite = vi.fn(async () => {}), proofPath = join(state, "proof.json");
  const run = async () => { const bytes = JSON.stringify(proof); put(proofPath, bytes); await reconcileAppliedSupplementPublication({ proofPath, proofSha256: sha(bytes), stockCode: "3625", state, beforeWrite, notAfter: Date.now() + 600_000 }); };
  return { state, directory, native, proof, run, beforeWrite, put };
}
beforeEach(() => { io.request.mockReset(); io.verify.mockReset(); io.verify.mockResolvedValue(undefined); });
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("normal applied semantic publication recovery", () => {
  it("retire-only closure keeps original PRE/intent and normal after-property/pre-retirement hash", async () => {
    const c = setup(); await c.run(); const done = JSON.parse(readFileSync(join(c.directory, "completed.json"), "utf8"));
    expect(readFileSync(join(c.directory, "pre.json"))).toEqual(pre); expect(readFileSync(join(c.directory, "intent.json"))).toEqual(originalIntent);
    expect(done.postPageSha256).toBe(sha(JSON.stringify(canonicalizeForHash(fixture.current.target)))); expect(done.archivePageId).toBe(c.proof.archivePageId);
    expect(io.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1); expect(io.request.mock.calls.some(([method]) => method === "PATCH")).toBe(false); expect(c.beforeWrite).toHaveBeenCalledTimes(2); expect(io.verify).toHaveBeenCalledOnce(); createSupplementPublicationJournal(c.state).assertReady();
  });
  it("already archived observation performs no business mutation", async () => { const c = setup({ archived: true }); await c.run(); expect(io.request.mock.calls.some(([m]) => m === "DELETE" || m === "PATCH")).toBe(false); createSupplementPublicationJournal(c.state).assertReady(); });
  it.each(["property", "new-evidence", "protected-child", "source", "clock", "old-root", "old-trash"] as const)("changed %s holds before retirement and leaves original pending", async changed => { const c = setup({ changed }); await expect(c.run()).rejects.toThrow(); expect(readdirSync(c.directory).sort()).toEqual(["intent.json", "pre.json"]); expect(io.request.mock.calls.some(([m]) => m === "DELETE" || m === "PATCH")).toBe(false); });
  it("latest source failure and physical PRE failure both stop before retirement", async () => { const c = setup(); c.beforeWrite.mockRejectedValueOnce(new Error("latest doc changed")); await expect(c.run()).rejects.toThrow(); expect(io.request.mock.calls.some(([m]) => m === "DELETE")).toBe(false); const d = setup(); io.request.mockClear(); io.verify.mockRejectedValueOnce(new Error("physical PRE mismatch")); await expect(d.run()).rejects.toThrow(); expect(io.request.mock.calls.some(([m]) => m === "DELETE")).toBe(false); });
  it("unknown retirement is sticky across another output/proof and never retries", async () => { const c = setup({ unknownDelete: true }); await expect(c.run()).rejects.toBeInstanceOf(NotionUnknownResultError); const count = io.request.mock.calls.length; await expect(c.run()).rejects.toThrow(); expect(io.request.mock.calls).toHaveLength(count); expect(readdirSync(c.directory).sort()).toEqual(["intent.json", "pre.json"]); expect(io.request.mock.calls.filter(([m]) => m === "DELETE")).toHaveLength(1); });
  it.each(["response-hash", "hidden-intent", "missing-start", "prior-delete", "other-pending"])("rejects %s before any network", async fault => {
    const c = setup();
    if (fault === "response-hash") c.proof.natives[0].response!.sha256 = c.proof.preSha256;
    else if (fault === "hidden-intent") c.put(join(c.native, "intent-16.json"), "{}");
    else if (fault === "missing-start") rmSync(c.proof.natives[0].nativeStart.path);
    else if (fault === "other-pending") mkdirSync(join(c.state, "supplement-publications", sha(originalIntent)), { mode: 0o700 });
    else { const n = c.proof.natives[0], a = JSON.parse(readFileSync(n.intent.path, "utf8")), m = JSON.parse(readFileSync(n.responseMetadata!.path, "utf8")), start = JSON.parse(readFileSync(n.nativeStart.path, "utf8")); for (const v of [a, m, start]) v.method = "DELETE"; for (const [f, v] of [[n.intent, a], [n.responseMetadata!, m], [n.nativeStart, start]] as const) { const b = JSON.stringify(v); c.put(f.path, b); f.sha256 = sha(b); } }
    await expect(c.run()).rejects.toThrow(); expect(io.request).not.toHaveBeenCalled(); expect(readdirSync(c.directory).sort()).toEqual(["intent.json", "pre.json"]);
  });
});
