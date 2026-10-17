/** Real saved4502 business values; generated Notion/FS protocol projections, no HTTP/data writes. */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSupplementPublicationJournal, reconcileSupplementPreArchive, type PreArchiveReconciliationProof } from "./publication-journal.js";
import { replaceEvidenceBlock } from "../../src/shared/notion-archive/stock-supplement.js";
import { NotionUnknownResultError } from "../../src/shared/notion-archive/client.js";
const io = vi.hoisted(() => ({ request: vi.fn(), archive: vi.fn(), verify: vi.fn() }));
vi.mock("../../src/shared/notion-archive/client.js", async original => ({ ...await original<typeof import("../../src/shared/notion-archive/client.js")>(), notionRequest: io.request }));
vi.mock("../../src/shared/notion-archive/archive.js", async original => ({ ...await original<typeof import("../../src/shared/notion-archive/archive.js")>(), recordPrimaryData: io.archive }));
vi.mock("../../src/shared/notion-archive/readback.js", () => ({ verifyArchivedAttachments: io.verify }));
const fixture = JSON.parse(gunzipSync(readFileSync(new URL("../../src/shared/notion-archive/fixtures/publisher-partial-actual-20261017.json.gz", import.meta.url))).toString());
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex"), scratch: string[] = [];
beforeEach(() => { vi.clearAllMocks(); io.verify.mockResolvedValue(undefined); });
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

async function setup() {
  const state = realpathSync(mkdtempSync(join(tmpdir(), "pre-archive-reconcile-"))); scratch.push(state);
  const current = structuredClone(fixture.before), childMap = new Map<string, unknown[]>([[current.id, fixture.children]]);
  const collect = (blocks: Array<Record<string, unknown>>) => { for (const block of blocks) { const body = block[block.type as string] as { children?: Array<Record<string, unknown>> }; if (body.children) { childMap.set(block.id as string, body.children); collect(body.children); } } }; collect(fixture.children);
  const guard = vi.fn(async () => {});
  const source = { object: "page", id: fixture.before.parent.database_id, parent: fixture.before.parent, created_time: fixture.postClock, last_edited_time: fixture.postClock, archived: false, in_trash: false, properties: { 文書: { title: [{ text: { content: fixture.input.docId } }] }, 銘柄コード: { rich_text: [{ text: { content: fixture.stockCode } }] } } };
  io.request.mockImplementation(async (method: string, path: string, body?: { properties: Record<string, unknown> }) => {
    if (method === "GET" && path === `/pages/${source.id}`) return structuredClone(source);
    if (method === "GET" && path === `/pages/${current.id}`) return structuredClone(current);
    if (method === "GET" && path.startsWith(`/pages/${current.id}/properties/`)) {
      const property = Object.values(current.properties).find((p: unknown) => path.split("?")[0].endsWith(`/${encodeURIComponent((p as { id: string }).id)}`)) as Record<string, unknown>, kind = property.type as string;
      return { results: (property[kind] as unknown[]).map(v => ({ [kind]: v })), has_more: false, next_cursor: null };
    }
    const blockId = /^\/blocks\/([^/]+)\/children/.exec(path)?.[1];
    if (method === "GET" && blockId && childMap.has(blockId)) return { results: structuredClone(childMap.get(blockId)), has_more: false, next_cursor: null };
    if (archiveRequest && method === "POST" && path === `/databases/${archiveRequest.parent.database_id}/query`) return { results: [{ id: fixture.preArchivePageId }], has_more: false, next_cursor: null };
    if (archiveRequest && method === "GET" && path === `/pages/${fixture.preArchivePageId}`) return { object: "page", archived: false, in_trash: false, id: fixture.preArchivePageId, parent: archiveRequest.parent, last_edited_time: fixture.postClock, properties: structuredClone(archiveRequest.properties) };
    if (method === "PATCH" && path === `/pages/${current.id}`) { Object.assign(current.properties, body!.properties); current.last_edited_time = fixture.postClock; return {}; }
    throw new Error(`unexpected protocol ${method} ${path}`);
  });
  io.archive.mockRejectedValueOnce(new NotionUnknownResultError("saved PRE archive POST response unknown"));
  await expect(replaceEvidenceBlock(current.id, undefined, fixture.input, fixture.before.properties, guard, createSupplementPublicationJournal(state))).rejects.toBeInstanceOf(NotionUnknownResultError);
  const key = readdirSync(join(state, "supplement-publications"))[0], directory = join(state, "supplement-publications", key), pre = readFileSync(join(directory, "pre.json")), raw = readFileSync(join(directory, "intent.json")), intent = JSON.parse(raw.toString());
  const rich = (content: string) => ({ rich_text: [{ type: "text", text: { content } }] });
  const metadata = { pageId: current.id, nextDocId: fixture.input.docId, sha256: sha(pre), _fileManifest: { version: 1, inputFingerprint: sha(pre), files: [{ originalFilename: "biztag-pre.json", uploadFilename: "biztag-pre.json", originalMime: "application/json", uploadMime: "application/json", byteLength: pre.length, sha256: sha(pre), upload: "uploaded" }] } };
  const archiveRequest: { parent: { database_id: string }; properties: Record<string, Record<string, unknown>> } = { parent: fixture.before.parent, properties: { Key: { title: [{ type: "text", text: { content: intent.archiveKey } }] }, Service: { select: { name: "yuho-quant" } }, Source: rich(`Notion supplement ${current.id}`), Status: { select: { name: "recorded" } }, Metadata: rich(JSON.stringify(metadata)), "Fetched At": { date: { start: intent.at } }, Files: { files: [{ name: "biztag-pre.json", type: "file_upload", file_upload: { id: fixture.preArchivePageId } }] } } };
  const capture = realpathSync(mkdtempSync(join(tmpdir(), "pre-archive-capture-"))); scratch.push(capture);
  const put = (name: string, bytes: Uint8Array | string) => { const path = join(capture, name); writeFileSync(path, bytes, { mode: 0o600 }); return { path, sha256: sha(bytes) }; };
  const multipart = Buffer.concat([Buffer.from('--saved-boundary\r\nContent-Disposition: form-data; name="file"; filename="biztag-pre.json"\r\nContent-Type: application/json\r\n\r\n'), pre, Buffer.from('\r\n--saved-boundary--\r\n')]);
  const payloads = [null, JSON.stringify({ filter: { property: "Key", title: { equals: intent.archiveKey } }, page_size: 2 }), JSON.stringify({ mode: "single_part", filename: "biztag-pre.json", content_type: "application/json" }), multipart, JSON.stringify(archiveRequest)];
  const paths = [`/v1/pages/${current.id}`, `/v1/databases/${archiveRequest.parent.database_id}/query`, "/v1/file_uploads", `/v1/file_uploads/${fixture.preArchivePageId}/send`, "/v1/pages"];
  const responses = [fixture.before, { results: [], has_more: false, next_cursor: null }, { object: "file_upload", id: fixture.preArchivePageId, status: "pending" }, { object: "file_upload", id: fixture.preArchivePageId, status: "uploaded", filename: "biztag-pre.json", content_length: pre.length }];
  const natives = payloads.map((body, index) => {
    const at = new Date(Date.parse(intent.at) + (index === 0 ? -1 : index)).toISOString(), n = index + 1, response = index < 4 ? JSON.stringify(responses[index]) : null;
    return { index: n, intent: put(`intent-${n}.json`, JSON.stringify({ at, method: index === 0 ? "GET" : "POST", kind: "Notion", pathSha256: sha(paths[index]) })), request: body === null ? null : put(`request-${n}.body`, body), response: response === null ? null : put(`response-${n}.body`, response), responseMetadata: response === null ? null : put(`response-${n}.json`, JSON.stringify({ at, status: 200, bytes: Buffer.byteLength(response), sha256: sha(response) })) };
  });
  const proof: PreArchiveReconciliationProof = { version: 1, stockCode: fixture.stockCode, journalKey: key, intentSha256: sha(raw), preSha256: sha(pre), archivePageId: fixture.preArchivePageId, sourcePage: put("source.json", JSON.stringify(source)), natives };
  const proofFile = () => put("proof.json", JSON.stringify(proof));
  const begin = async () => { const file = proofFile(); return reconcileSupplementPreArchive({ state, stockCode: fixture.stockCode, proofPath: file.path, proofSha256: file.sha256 }); };
  io.request.mockClear(); io.archive.mockClear(); guard.mockClear();
  return { state, directory, pre, raw, current, guard, proof, begin, archiveRequest, source };
}

describe("explicit normal PRE-only reconciliation", () => {
  it("real multi-PATCH PRE is physically reused; original three-file completion stays compatible", async () => {
    const s = await setup(), recovery = await s.begin();
    recovery.journal.bindSource!({ stockCode: fixture.stockCode, docId: fixture.input.docId, sourcePageId: s.source.id });
    await replaceEvidenceBlock(s.current.id, undefined, fixture.input, fixture.before.properties, s.guard, recovery.journal); recovery.assertComplete();
    expect(io.archive).not.toHaveBeenCalled(); expect(io.request.mock.calls.filter(([method]) => method === "PATCH")).toHaveLength(2);
    expect(io.request.mock.calls.some(([method, path]) => method === "POST" && path === "/pages")).toBe(false);
    expect(readdirSync(s.directory).sort()).toEqual(["completed.json", "intent.json", "pre.json"]);
    expect(readFileSync(join(s.directory, "intent.json")).equals(s.raw)).toBe(true); expect(readFileSync(join(s.directory, "pre.json")).equals(s.pre)).toBe(true);
    expect(readdirSync(join(s.state, "supplement-pre-archive-reconciliations", s.proof.journalKey)).sort()).toEqual(["attempt.json", "pre_archive_reconciled.json"]);
    createSupplementPublicationJournal(s.state).assertReady(); await expect(s.begin()).rejects.toThrow();
  });
  it.each(["partial-PATCH", "changed-PRE", "source-drift", "source-metadata-drift", "semantic-block"])("%s preserves unknown and never authorizes another input/run", async fault => {
    const s = await setup(), recovery = await s.begin(), native = io.request.getMockImplementation()!;
    recovery.journal.bindSource!({ stockCode: fixture.stockCode, docId: fixture.input.docId, sourcePageId: s.source.id });
    if (fault === "partial-PATCH") { let patches = 0; io.request.mockImplementation(async (...args) => { if (args[0] === "PATCH" && ++patches === 2) throw new NotionUnknownResultError("second PATCH unknown"); return native(...args); }); }
    if (fault === "changed-PRE") s.current.last_edited_time = fixture.postClock;
    if (fault === "source-metadata-drift") s.source.properties.文書.title[0].text.content = fixture.before.id;
    if (fault === "source-drift") s.guard.mockRejectedValueOnce(new Error("current source changed"));
    await expect(replaceEvidenceBlock(s.current.id, fault === "semantic-block" ? null : undefined, fixture.input, fixture.before.properties, s.guard, recovery.journal)).rejects.toThrow();
    expect(io.archive).not.toHaveBeenCalled(); expect(() => recovery.assertComplete()).toThrow();
    io.request.mockClear(); expect(() => createSupplementPublicationJournal(s.state)).toThrow(); await expect(s.begin()).rejects.toThrow(); expect(io.request).not.toHaveBeenCalled();
    expect(readFileSync(join(s.directory, "intent.json")).equals(s.raw)).toBe(true); expect(readFileSync(join(s.directory, "pre.json")).equals(s.pre)).toBe(true);
  });
  it("another current source pointer stops before target mutation", async () => {
    const s = await setup(), recovery = await s.begin(); io.request.mockClear();
    expect(() => recovery.journal.bindSource!({ stockCode: fixture.stockCode, docId: fixture.input.docId, sourcePageId: fixture.preArchivePageId })).toThrow();
    expect(io.request).not.toHaveBeenCalled(); expect(() => recovery.assertComplete()).toThrow();
  });
  it.each(["business-send", "missing-counter", "wrong-upload", "changed-proof", "archive-absent", "archive-duplicate", "physical-diff"])("%s cannot qualify the original pending", async fault => {
    const s = await setup();
    if (fault === "business-send") { const file = s.proof.natives[3].intent, value = JSON.parse(readFileSync(file.path, "utf8")); value.method = "PATCH"; const raw = JSON.stringify(value); writeFileSync(file.path, raw); file.sha256 = sha(raw); }
    if (fault === "missing-counter") s.proof.natives.splice(1, 1);
    if (fault === "wrong-upload") { const file = s.proof.natives[3].request!; const raw = Buffer.from("different raw bytes"); writeFileSync(file.path, raw); file.sha256 = sha(raw); }
    if (fault === "changed-proof") s.proof.preSha256 = s.proof.intentSha256;
    if (fault === "archive-absent" || fault === "archive-duplicate") io.request.mockResolvedValueOnce({ results: fault === "archive-absent" ? [] : [{ id: s.proof.archivePageId }, { id: s.proof.archivePageId }], has_more: false, next_cursor: null });
    if (fault === "physical-diff") io.verify.mockRejectedValueOnce(new Error("full PRE bytes differ"));
    await expect(s.begin()).rejects.toThrow(); expect(io.archive).not.toHaveBeenCalled(); expect(io.request.mock.calls.some(([method]) => method === "PATCH" || method === "DELETE")).toBe(false);
    expect(() => createSupplementPublicationJournal(s.state)).toThrow(); expect(readFileSync(join(s.directory, "intent.json")).equals(s.raw)).toBe(true);
  });
});
