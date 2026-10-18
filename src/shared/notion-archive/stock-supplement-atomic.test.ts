/** Saved source values with structural Notion responses; no network or production writes. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createSupplementPublicationJournal } from "../../../scripts/biztag-local/publication-journal.js";
import { buildEvidenceBlock, buildSupplementProperties, createSupplementRow, readSupplementRowFully, replaceEvidenceBlock, SupplementWriteHeldError } from "./stock-supplement.js";
import { NotionUnknownResultError } from "./client.js";
import changedDocumentNative from "./fixtures/publisher-doc-change-actual-20261017.json";
import zeroWidthNative from "./fixtures/9273-s100z2z6-notion-zero-width.json";

const io = vi.hoisted(() => ({ request: vi.fn(), archive: vi.fn(), verify: vi.fn() }));
vi.mock("./client.js", async (original) => ({ ...await original<typeof import("./client.js")>(), notionRequest: io.request }));
vi.mock("./archive.js", async (original) => ({ ...await original<typeof import("./archive.js")>(), recordPrimaryData: io.archive }));
vi.mock("./readback.js", () => ({ verifyArchivedAttachments: io.verify }));

const journal = { assertReady() {}, reserve() { return { complete() {} }; } }; // Isolated protocol dependency; real durable state is exercised below.
const input = { docId: "S100YFQC", tagStatus: "判定済" as const, tagDoc: "S100YFQC 2026年3月期", upstream: ["工作機械"], texts: { "事業の内容": "保存原文" } };
const block = buildEvidenceBlock({ vocabVersion: "v1", docId: "S100YFQC", periodLabel: "2026年3月期", items: [
  { labelJa: "工作機械", band: "yes", probability: 0.95, sentences: [{ text: "保存原文", sectionTitle: "事業の内容" }] },
] });
const expected = buildSupplementProperties({ docId: "S100OLD", tagStatus: "判定済", tagDoc: "S100OLD 2025年3月期",
  vocabVersion: "v0", judgedAt: "2025-06-25", upstream: ["旧タグ"], judgeInput: "旧判定入力", evidenceText: "旧根拠" });
const guard = vi.fn(async () => {});
let requestNonce = 0;
const old = { id: "old", type: "heading_3", has_children: false,
  heading_3: { rich_text: [{ plain_text: "事業タグの根拠（旧書類）" }], is_toggleable: true } };
function setup(options: { badEvidence?: boolean; unknownAppend?: boolean; unknownPatch?: boolean; unknownRetire?: boolean; nestedEvidence?: boolean; sameEvidence?: boolean; evidenceDriftRead?: number; multipleEvidence?: boolean; unknownEvidenceRead?: boolean; badPost?: boolean; stalePre?: boolean; longProperty?: boolean; changedProtectedAfter?: boolean; reverseKeys?: boolean | "alternate" } = {}) {
  let patched = false;
  let pageReads = 0;
  let evidenceReads = 0;
  const before = { id: "row", last_edited_time: "2026-10-14T00:00:00Z", properties: expected };
  const after = { ...before, properties: { ...before.properties, ...buildSupplementProperties(input) } };
  if (options.changedProtectedAfter) Object.assign(after.properties, buildSupplementProperties({ vocabVersion: "変更された旧model版" }));
  if (options.longProperty) after.properties["事業の内容"] = { id: "p", rich_text: Array.from({ length: 25 }, () => ({ plain_text: "分割" })) };
  io.request.mockImplementation(async (method: string, path: string, body?: { properties?: Record<string, unknown> }, opts?: { singleAttempt?: boolean }) => {
    if (method === "GET" && path === "/pages/row") {
      pageReads++;
      if (patched && options.badPost) return before;
      if (options.stalePre && pageReads === 2) return { ...before, last_edited_time: "2026-10-14T01:00:00Z" };
      const response = { ...structuredClone(patched ? after : before), request_id: `notion-read-${++requestNonce}` };
      return options.reverseKeys === true || options.reverseKeys === "alternate" && pageReads % 2 === 0 ? reverseKeys(response) : response;
    }
    if (method === "GET" && path.startsWith("/pages/row/properties/")) return { results: [{ rich_text: { plain_text: "保存原文" } }], has_more: false, next_cursor: null };
    if (method === "GET" && path.startsWith("/blocks/row/children")) {
      evidenceReads++;
      if (options.unknownEvidenceRead) throw new Error("existing full evidence unknown");
      const existing = options.sameEvidence ? { id: "old", type: "heading_3", has_children: true,
        heading_3: { rich_text: structuredClone((block as typeof old).heading_3.rich_text), is_toggleable: true } }
        : { ...old, has_children: options.nestedEvidence === true };
      return { results: options.multipleEvidence ? [existing, { ...existing, id: "another" }] : [existing], has_more: false, next_cursor: null };
    }
    if (method === "GET" && (path.startsWith("/blocks/old/children") || path.startsWith("/blocks/another/children"))) {
      const quotes = options.sameEvidence ? structuredClone((block as { heading_3: { children: Array<{ quote: { rich_text: unknown[] } }> } }).heading_3.children)
        : [{ type: "quote", quote: { rich_text: [{ plain_text: "旧根拠全文" }] } }];
      if (options.evidenceDriftRead === evidenceReads) quotes[0].quote.rich_text = [{ plain_text: "並行編集された根拠" }];
      return { results: quotes.map((q, i) => ({ id: `old-quote-${i}`, ...q })), has_more: false, next_cursor: null };
    }
    if (method === "GET" && path.startsWith("/blocks/new/children")) return { results: (block as { heading_3: { children: unknown[] } }).heading_3.children, has_more: false, next_cursor: null };
    if (method === "PATCH" && path === "/blocks/row/children") {
      expect(opts?.singleAttempt).toBe(true);
      if (options.unknownAppend) throw new NotionUnknownResultError("append unknown");
      return { results: [{ id: "new" }] };
    }
    if (method === "GET" && path === "/blocks/new") {
      if (options.badEvidence) return old;
      if (options.nestedEvidence) {
        const response = { id: "new", has_children: true, ...structuredClone(block as { heading_3: { children?: unknown[] } }) };
        delete response.heading_3.children;
        return response;
      }
      return { id: "new", ...structuredClone(block as object) };
    }
    if (method === "PATCH" && path === "/pages/row") {
      expect(opts?.singleAttempt).toBe(true);
      expect(body?.properties).toEqual(buildSupplementProperties(input));
      patched = true;
      if (options.unknownPatch) throw new NotionUnknownResultError("PATCH may have applied");
      return {};
    }
    if (method === "DELETE" && path === "/blocks/old" && options.unknownRetire) throw new NotionUnknownResultError("retirement may have applied");
    if ((method === "DELETE" || method === "GET") && path === "/blocks/old") return { id: "old", archived: true };
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { before, after, wasPatched: () => patched };
}
beforeEach(() => {
  vi.clearAllMocks();
  requestNonce = 0;
  guard.mockResolvedValue(undefined);
  io.archive.mockResolvedValue({ pageId: "pre-archive", outcome: "recorded" });
  io.verify.mockResolvedValue(undefined);
});
const mutations = () => io.request.mock.calls.filter(([method]) => method !== "GET").map(([method, path]) => `${method} ${path}`);
const reverseKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(reverseKeys) : value !== null && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseKeys(entry)])) : value;
const privateStates: string[] = [];
afterEach(() => { for (const state of privateStates.splice(0)) rmSync(state, { recursive: true, force: true }); });

describe("supplement evidence two-phase replacement", () => {
  it("null原本文書の基本メタも物理PRE/CAS/POSTを通し、本文/タグ/状態を新造しない", async () => {
    const properties = buildSupplementProperties({ docId: null, textStatus: "本文なし", tagStatus: "本文なし", judgeInput: null, texts: { [zeroWidthNative.provenance.property]: zeroWidthNative.notionReadbackText } });
    const page = { id: "row", last_edited_time: "2026-10-18T00:00:00Z", properties }, next = { docId: null, sector33: "機械" }, after = { ...page, properties: { ...properties, ...buildSupplementProperties(next) } };
    let patched = false;
    io.request.mockImplementation(async (method: string, path: string, body?: { properties: object }) => {
      if (method === "GET" && path === "/pages/row") return structuredClone(patched ? after : page);
      if (method === "GET" && path.startsWith("/blocks/row/children")) return { results: [], has_more: false, next_cursor: null };
      if (method === "PATCH" && path === "/pages/row") { expect(body?.properties).toEqual(buildSupplementProperties(next)); patched = true; return {}; }
      throw Error("unexpected null-source protocol call");
    });
    const state = realpathSync(mkdtempSync(join(tmpdir(), "basic-metadata-publication-"))); privateStates.push(state);
    await replaceEvidenceBlock("row", undefined, next, properties, guard, createSupplementPublicationJournal(state));
    expect(guard).toHaveBeenCalledOnce(); expect(io.archive).toHaveBeenCalledOnce(); expect(io.verify).toHaveBeenCalledOnce();
    expect(mutations()).toEqual(["PATCH /pages/row"]); expect(after.properties["有報書類ID"]).toEqual(properties["有報書類ID"]);
    const dir = join(state, "supplement-publications", readdirSync(join(state, "supplement-publications"))[0]);
    expect(JSON.parse(readFileSync(join(dir, "completed.json"), "utf8"))).toMatchObject({ oldDocId: null, nextDocId: null });
    createSupplementPublicationJournal(state).assertReady();
  });
  it("現在39検査は実保存pageの長文を全paginationで読み、次GETの期限前停止を守る", async () => {
    const saved = JSON.parse(gunzipSync(readFileSync(new URL("../../../services/yuho-quant/src/biztag/competitors/fixtures/prepare-actual-20261017.json.gz", import.meta.url))).toString());
    const page = structuredClone(saved.pages[0]), dbId = page.parent.database_id;
    // Committed native projection omits the transport clock; declared protocol-only metadata.
    page.last_edited_time = "2026-10-17T00:00:00.000Z";
    const text = page.properties["事業の内容"].rich_text.map((v: { plain_text: string }) => v.plain_text).join("");
    const width = Math.ceil(text.length / 26), parts = Array.from({ length: Math.ceil(text.length / width) }, (_, i) => ({ plain_text: text.slice(i * width, (i + 1) * width) }));
    expect(parts.length).toBeGreaterThanOrEqual(25);
    page.properties["事業の内容"] = { ...page.properties["事業の内容"], rich_text: parts.slice(0, 25), has_more: true };
    const admitted = vi.fn();
    io.request.mockImplementation(async (method: string, path: string, _body: unknown, opts: { beforeRequest?: () => void }) => {
      opts.beforeRequest?.(); expect(method).toBe("GET");
      if (path === `/pages/${page.id}`) return structuredClone(page);
      expect(path).toContain(`/pages/${page.id}/properties/`);
      const last = path.includes("start_cursor=");
      return { results: (last ? parts.slice(25) : parts.slice(0, 25)).map(rich_text => ({ rich_text })), has_more: !last, next_cursor: last ? null : "saved-next" };
    });
    expect((await readSupplementRowFully(page.id, dbId, ["事業の内容"], admitted)).texts["事業の内容"]).toBe(text);
    expect(admitted).toHaveBeenCalledTimes(3); expect(io.archive).not.toHaveBeenCalled();
    let count = 0;
    await expect(readSupplementRowFully(page.id, dbId, ["事業の内容"], () => { if (++count === 2) throw Error("declared original deadline"); })).rejects.toThrow("original deadline");
    expect(count).toBe(2);
  });
  it.each(["single-complete", "multi-complete", "null-doc-complete", "evidence-complete", "evidence-read-unknown", "unknown-POST", "unknown-PATCH", "readback-mismatch", "db-drift"])("実4502値のcreate意図をpageID取得前から閉鎖まで保持 (%s)", async fault => {
    const fixture = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/publisher-partial-actual-20261017.json.gz", import.meta.url))).toString());
    const state = realpathSync(mkdtempSync(join(tmpdir(), "supplement-create-"))); privateStates.push(state);
    const durable = createSupplementPublicationJournal(state), dbId = fixture.before.parent.database_id;
    const next = fault === "single-complete" ? { stockCode: fixture.stockCode, docId: fixture.docId } : { ...fixture.input, stockCode: fixture.stockCode };
    if (fault === "null-doc-complete") next.docId = null;
    const evidence = fault.startsWith("evidence-") ? fixture.children[0] : undefined;
    const current = { id: fixture.before.id, parent: { database_id: dbId }, last_edited_time: fixture.postClock, properties: {} as Record<string, { id: string; rich_text?: unknown[] }> };
    let posts = 0, patches = 0;
    const apply = (properties: Record<string, unknown>) => { for (const [name, value] of Object.entries(properties)) current.properties[name] = { ...value as object, id: fixture.before.properties[name].id }; };
    io.request.mockImplementation(async (method: string, path: string, body?: { properties?: Record<string, unknown> }, opts?: { singleAttempt?: boolean }) => {
      if (method === "POST" && path === "/pages") { posts++; expect(opts?.singleAttempt).toBe(true); apply(body!.properties!); if (fault === "unknown-POST") throw new NotionUnknownResultError("actual first creation may be applied"); return { id: current.id }; }
      if (method === "PATCH" && path === `/pages/${current.id}`) { patches++; expect(opts?.singleAttempt).toBe(true); apply(body!.properties!); if (fault === "unknown-PATCH") throw new NotionUnknownResultError("actual remaining chunk may be applied"); return {}; }
      if (method === "GET" && path === `/pages/${current.id}`) { const page = structuredClone(current); if (fault === "readback-mismatch") Object.assign(page.properties, buildSupplementProperties({ docId: changedDocumentNative.oldDocId })); if (fault === "db-drift") page.parent.database_id = fixture.preArchivePageId; return page; }
      if (method === "GET" && path.startsWith(`/pages/${current.id}/properties/`)) { const property = Object.values(current.properties).find(value => path.split("?")[0].endsWith(`/${encodeURIComponent(value.id)}`))!; return { results: property.rich_text!.map(value => ({ rich_text: value })), has_more: false, next_cursor: null }; }
      if (method === "GET" && path.startsWith(`/blocks/${current.id}/children`)) { if (fault === "evidence-read-unknown") throw new Error("saved evidence read incomplete"); return { results: evidence === undefined ? [] : [structuredClone(evidence)], has_more: false, next_cursor: null }; }
      if (method === "GET" && evidence !== undefined && path.startsWith(`/blocks/${evidence.id}/children`)) return { results: evidence[evidence.type].children, has_more: false, next_cursor: null };
      throw new Error(`unexpected creation protocol ${method} ${path}`);
    });
    const run = createSupplementRow(dbId, next, evidence, durable), complete = fault.endsWith("complete");
    if (complete) await expect(run).resolves.toBe(current.id); else await expect(run).rejects.toBeInstanceOf(NotionUnknownResultError);
    expect(posts).toBe(1); if (fault === "single-complete" || fault === "unknown-POST") expect(patches).toBe(0); else expect(patches).toBeGreaterThan(0);
    const root = join(state, "supplement-publications"), path = join(root, readdirSync(root)[0]), raw = readFileSync(join(path, "intent.json")), request = readFileSync(join(path, "request.json"));
    expect(JSON.parse(raw.toString())).toMatchObject({ operation: "create", stockCode: fixture.stockCode, nextDocId: next.docId });
    if (complete) { createSupplementPublicationJournal(state).assertReady(); expect(JSON.parse(readFileSync(join(path, "completed.json"), "utf8"))).toMatchObject({ operation: "create", pageId: current.id }); }
    else { io.request.mockClear(); expect(() => createSupplementPublicationJournal(state)).toThrow(); expect(io.request).not.toHaveBeenCalled(); }
    expect(readFileSync(join(path, "intent.json")).equals(raw)).toBe(true); expect(readFileSync(join(path, "request.json")).equals(request)).toBe(true); expect(io.archive).not.toHaveBeenCalled();
  });

  it.each(["complete", "unknown"])("実1716旧文書→現文書を別identityとして保持 (%s)", async fault => {
    const saved = changedDocumentNative, state = realpathSync(mkdtempSync(join(tmpdir(), "publication-doc-change-"))); privateStates.push(state);
    const current = { id: saved.pageId, last_edited_time: saved.lastEditedTime, properties: buildSupplementProperties({ docId: saved.oldDocId }) };
    const oldProperties = structuredClone(current.properties), durable = createSupplementPublicationJournal(state);
    io.request.mockImplementation(async (method: string, path: string, body?: { properties: Record<string, unknown> }) => {
      if (method === "GET" && path === `/pages/${current.id}`) return structuredClone(current);
      if (method === "GET" && path.startsWith(`/blocks/${current.id}/children`)) return { results: [], has_more: false, next_cursor: null };
      if (method === "PATCH" && path === `/pages/${current.id}`) {
        Object.assign(current.properties, body!.properties);
        if (fault === "unknown") throw new NotionUnknownResultError("actual next document PATCH may be applied");
        return {};
      }
      throw new Error(`unexpected document protocol ${method} ${path}`);
    });
    const run = replaceEvidenceBlock(current.id, undefined, { docId: saved.nextDocId }, oldProperties, guard, durable);
    if (fault === "complete") await run; else await expect(run).rejects.toBeInstanceOf(NotionUnknownResultError);
    const root = join(state, "supplement-publications"), operation = join(root, readdirSync(root)[0]), raw = readFileSync(join(operation, "intent.json"));
    expect(JSON.parse(raw.toString())).toMatchObject({ oldDocId: saved.oldDocId, nextDocId: saved.nextDocId });
    if (fault === "complete") { createSupplementPublicationJournal(state).assertReady(); expect(JSON.parse(readFileSync(join(operation, "completed.json"), "utf8"))).toMatchObject({ oldDocId: saved.oldDocId, nextDocId: saved.nextDocId }); }
    else {
      io.request.mockClear(); io.archive.mockClear();
      expect(() => createSupplementPublicationJournal(state)).toThrow();
      expect(io.request).not.toHaveBeenCalled(); expect(io.archive).not.toHaveBeenCalled(); expect(readFileSync(join(operation, "intent.json"))).toEqual(raw);
    }
  });
  it.each(["partial-PATCH", "physical-PRE", "normal-complete"])("4502実multi-PATCH原本の跨run journal境界 (%s)", async fault => {
    const fixture = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/publisher-partial-actual-20261017.json.gz", import.meta.url))).toString());
    const state = realpathSync(mkdtempSync(join(tmpdir(), "supplement-publication-"))); privateStates.push(state);
    const durable = createSupplementPublicationJournal(state), current = structuredClone(fixture.before);
    let patches = 0;
    io.archive.mockResolvedValue({ pageId: fixture.preArchivePageId, outcome: "recorded" });
    if (fault === "physical-PRE") io.archive.mockRejectedValueOnce(new NotionUnknownResultError("physical PRE upload unknown"));
    const children = new Map<string, unknown[]>([[current.id, fixture.children]]);
    const collect = (blocks: Array<Record<string, unknown>>) => { for (const block of blocks) {
      const body = block[block.type as string] as { children?: Array<Record<string, unknown>> };
      if (body.children) { children.set(block.id as string, body.children); collect(body.children); }
    } }; collect(fixture.children);
    io.request.mockImplementation(async (method: string, path: string, body?: { properties?: Record<string, unknown> }) => {
      if (method === "GET" && path === `/pages/${current.id}`) return structuredClone(current);
      if (method === "GET" && path.startsWith(`/pages/${current.id}/properties/`)) {
        const property = Object.values(current.properties).find((value: unknown) => path.split("?")[0].endsWith(`/${encodeURIComponent((value as { id: string }).id)}`)) as Record<string, unknown>;
        const kind = property.type as string;
        return { results: (property[kind] as unknown[]).map(value => ({ [kind]: value })), has_more: false, next_cursor: null };
      }
      const blockId = /^\/blocks\/([^/]+)\/children/.exec(path)?.[1];
      if (method === "GET" && blockId && children.has(blockId)) return { results: structuredClone(children.get(blockId)), has_more: false, next_cursor: null };
      if (method === "PATCH" && path === `/pages/${current.id}`) {
        patches++; if (fault === "partial-PATCH" && patches === 2) throw new NotionUnknownResultError("second actual chunk unknown; first is applied");
        Object.assign(current.properties, body!.properties); current.last_edited_time = fixture.postClock; return {};
      }
      throw new Error(`unexpected saved protocol ${method} ${path}`);
    });
    const first = replaceEvidenceBlock(current.id, undefined, fixture.input, fixture.before.properties, guard, durable);
    if (fault === "normal-complete") await first;
    else await expect(first).rejects.toBeInstanceOf(NotionUnknownResultError);
    const journalRoot = join(state, "supplement-publications"), operation = join(journalRoot, readdirSync(journalRoot)[0]), pre = readFileSync(join(operation, "pre.json")), intent = readFileSync(join(operation, "intent.json"));
    // Native byte comparison avoids millions of assertion-library element comparisons for the full 1.3 MB PRE.
    expect(pre.equals(Buffer.from(io.archive.mock.calls[0][0].files[0].bytes))).toBe(true);
    if (fault === "normal-complete") {
      expect(patches).toBe(2); createSupplementPublicationJournal(state).assertReady();
      const completed = JSON.parse(readFileSync(join(operation, "completed.json"), "utf8"));
      expect(completed.intentSha256).toBe(createHash("sha256").update(intent).digest("hex"));
      expect(completed.preSha256).toBe(createHash("sha256").update(pre).digest("hex"));
    } else {
      if (fault === "partial-PATCH") { expect(patches).toBe(2); expect(current.properties).not.toEqual(fixture.before.properties); }
      else expect(patches).toBe(0);
      io.request.mockClear(); io.archive.mockClear();
      // The current PRE would differ after chunk1; global durable intent rejects before any native reader/archiver.
      await expect((async () => { const resumed = createSupplementPublicationJournal(state); await replaceEvidenceBlock(current.id, undefined, fixture.input, current.properties, guard, resumed); })()).rejects.toBeInstanceOf(NotionUnknownResultError);
      expect(io.request).not.toHaveBeenCalled(); expect(io.archive).not.toHaveBeenCalled();
      expect(readFileSync(join(operation, "pre.json")).equals(pre)).toBe(true); expect(readFileSync(join(operation, "intent.json")).equals(intent)).toBe(true);
    }
  });
  it.each(["same", "visible-diff", "unknown"])("9273実送信表現を事前guardし、receiptだけ再資格化する (%s)", async fault => {
    const { provenance, rawText, notionReadbackText, oldJudgeInput, writtenJudgeInput } = zeroWidthNative;
    const metadata = buildSupplementProperties({ docId: provenance.docId, judgeInput: oldJudgeInput, tagStatus: "判定済", tagDoc: provenance.docId });
    const current = { ...metadata, ...buildSupplementProperties({ texts: { [provenance.property]: notionReadbackText + (fault === "visible-diff" ? "X" : "") } }) };
    const expected = { ...metadata, ...buildSupplementProperties({ texts: { [provenance.property]: rawText } }) };
    const next = { docId: provenance.docId, judgeInput: writtenJudgeInput };
    io.request.mockImplementation(async (method: string, path: string, body?: { properties?: Record<string, unknown> }) => {
      if (method === "GET" && path === "/pages/row") return { id: "row", last_edited_time: "2026-10-16T17:43:00Z", properties: structuredClone(current) };
      if (method === "GET" && path.startsWith("/blocks/row/children")) return { results: [old], has_more: false, next_cursor: null };
      if (method === "PATCH" && path === "/pages/row") {
        expect(body?.properties).toEqual(buildSupplementProperties(next));
        expect(body?.properties).not.toHaveProperty(provenance.property);
        Object.assign(current, buildSupplementProperties(next));
        if (fault === "unknown") throw new NotionUnknownResultError("single receipt PATCH unknown");
        return {};
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    const run = replaceEvidenceBlock("row", undefined, next, expected, guard, journal);
    if (fault === "visible-diff") {
      await expect(run).rejects.toBeInstanceOf(SupplementWriteHeldError);
      expect(io.archive).not.toHaveBeenCalled(); expect(mutations()).toEqual([]);
    } else if (fault === "unknown") {
      await expect(run).rejects.toBeInstanceOf(NotionUnknownResultError); expect(mutations()).toEqual(["PATCH /pages/row"]);
    } else {
      await expect(run).resolves.toBeUndefined();
      await replaceEvidenceBlock("row", undefined, next, { ...expected, ...buildSupplementProperties(next) }, guard, journal);
      expect(io.archive).toHaveBeenCalledOnce(); expect(mutations()).toEqual(["PATCH /pages/row"]);
    }
  });
  it.each([false, true])("9273実native表現を照合し、可視1文字の差はunknown STOPのまま (visibleDiff=%s)", async (visibleDiff) => {
    const { provenance, rawText, notionReadbackText, oldJudgeInput, writtenJudgeInput } = zeroWidthNative;
    const oldProps = buildSupplementProperties({ docId: provenance.docId, judgeInput: oldJudgeInput, tagStatus: "判定済", tagDoc: provenance.docId });
    const next = { docId: provenance.docId, texts: { [provenance.property]: rawText }, judgeInput: writtenJudgeInput };
    const nativeProps = buildSupplementProperties({ texts: { [provenance.property]: notionReadbackText + (visibleDiff ? "X" : "") }, judgeInput: writtenJudgeInput });
    let patched = false;
    io.request.mockImplementation(async (method: string, path: string, body?: { properties?: Record<string, unknown> }) => {
      if (method === "GET" && path === "/pages/row") return { id: "row", last_edited_time: "2026-10-16T17:43:00Z", properties: structuredClone(patched ? { ...oldProps, ...nativeProps } : oldProps) };
      if (method === "GET" && path.startsWith("/blocks/row/children")) return { results: [old], has_more: false, next_cursor: null };
      if (method === "PATCH" && path === "/pages/row") { expect(body?.properties).toEqual(buildSupplementProperties(next)); patched = true; return {}; }
      throw new Error(`unexpected ${method} ${path}`);
    });
    const run = replaceEvidenceBlock("row", undefined, next, oldProps, guard, journal);
    if (visibleDiff) await expect(run).rejects.toBeInstanceOf(NotionUnknownResultError);
    else await expect(run).resolves.toBeUndefined();
    expect(mutations()).toEqual(["PATCH /pages/row"]);
    expect(io.archive).toHaveBeenCalledTimes(1); expect(io.verify).toHaveBeenCalledTimes(1);
  });
  it("physically verifies PRE and new full evidence before properties, then verifies properties before retiring old evidence", async () => {
    setup();
    await replaceEvidenceBlock("row", block, input, expected, guard, journal);
    expect(io.archive).toHaveBeenCalledTimes(1);
    expect(io.verify).toHaveBeenCalledWith("pre-archive", expect.any(Array), "事業タグ更新前PRE");
    expect(mutations()).toEqual(["PATCH /blocks/row/children", "PATCH /pages/row", "DELETE /blocks/old"]);
    const requests = io.request.mock.calls.map(([method, path]) => `${method} ${path}`);
    expect(requests.indexOf("GET /blocks/new")).toBeLessThan(requests.indexOf("PATCH /pages/row"));
    expect(requests.lastIndexOf("GET /pages/row")).toBeLessThan(requests.indexOf("DELETE /blocks/old"));
  });
  it("同じ単一根拠を全文再検証して再利用し、PRE/CAS/fullPOST後にだけ完了する", async () => {
    setup({ sameEvidence: true });
    const complete = vi.fn(), reserve = vi.fn(() => ({ complete }));
    await replaceEvidenceBlock("row", block, input, expected, guard, { assertReady() {}, reserve });
    expect(mutations()).toEqual(["PATCH /pages/row"]);
    expect(io.archive).toHaveBeenCalledTimes(1); expect(io.verify).toHaveBeenCalledTimes(1);
    expect(guard).toHaveBeenCalledTimes(1); expect(reserve).toHaveBeenCalledTimes(1); expect(complete).toHaveBeenCalledTimes(1);
    const snapshot = JSON.parse(new TextDecoder().decode(io.archive.mock.calls[0][0].files[0].bytes));
    expect(snapshot.children[0].id).toBe("old");
    expect(snapshot.children[0].heading_3.children).toHaveLength((block as { heading_3: { children: unknown[] } }).heading_3.children.length);
    expect(io.request.mock.calls.filter(([method, path]) => method === "GET" && String(path).startsWith("/blocks/old/children"))).toHaveLength(3);
    expect(complete.mock.invocationCallOrder[0]).toBeGreaterThan(io.request.mock.invocationCallOrder.at(-1)!);
  });
  it.each([2, 3])("同値根拠のPRE中/POST後の全文driftを止め、根拠と未完intentを保持する (%s)", async evidenceDriftRead => {
    setup({ sameEvidence: true, evidenceDriftRead }); const complete = vi.fn();
    const run = replaceEvidenceBlock("row", block, input, expected, guard, { assertReady() {}, reserve() { return { complete }; } });
    await expect(run).rejects.toBeInstanceOf(evidenceDriftRead === 2 ? SupplementWriteHeldError : NotionUnknownResultError);
    expect(mutations()).toEqual(evidenceDriftRead === 2 ? [] : ["PATCH /pages/row"]); expect(complete).not.toHaveBeenCalled();
  });
  it.each([{ multipleEvidence: true }, { unknownEvidenceRead: true }])("同値候補でも複数/未知根拠をPRE前に拒否する (%j)", async option => {
    setup({ sameEvidence: true, ...option }); await expect(replaceEvidenceBlock("row", block, input, expected, guard, journal)).rejects.toThrow();
    expect(io.archive).not.toHaveBeenCalled(); expect(mutations()).toEqual([]);
  });
  it("同値根拠でも既存PRE/不明PATCHを再送・完了扱いしない", async () => {
    setup({ sameEvidence: true }); io.archive.mockResolvedValueOnce({ pageId: "pre-archive", outcome: "skipped_existing" });
    await expect(replaceEvidenceBlock("row", block, input, expected, guard, journal)).rejects.toBeInstanceOf(NotionUnknownResultError);
    expect(mutations()).toEqual([]);
    io.request.mockClear(); setup({ sameEvidence: true, unknownPatch: true }); const complete = vi.fn();
    await expect(replaceEvidenceBlock("row", block, input, expected, guard, { assertReady() {}, reserve() { return { complete }; } })).rejects.toBeInstanceOf(NotionUnknownResultError);
    expect(mutations()).toEqual(["PATCH /pages/row"]); expect(complete).not.toHaveBeenCalled();
  });
  const privateRead = join(process.cwd(), "tmp/feature-audit-20261018/biztag-saved59-current-read-v2/actual-once-v1/SUCCESS.json");
  const privatePrepared = join(process.cwd(), "tmp/feature-audit-20261018/biztag-saved59-current-read-v2/prepared59-saved-only.json");
  it.skipIf(!existsSync(privateRead) || !existsSync(privatePrepared)).each(["6038", "9344"])("実保存%sの単一同値根拠をnormal publisherで保持し、3file completionを閉じる（宣言IO）", async code => {
    const bytes = readFileSync(privateRead), preparedBytes = readFileSync(privatePrepared);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("96eb4edd99764739429f9dd2a012f5041a58c76a582fd07e33be5bb6e9036156");
    expect(createHash("sha256").update(preparedBytes).digest("hex")).toBe("903b8b27812f7fcbb0243b5b8d002e374376fe128ff5c61b5961804d00d25caa");
    const observed = JSON.parse(bytes.toString()).held.find((r: { code: string }) => r.code === code);
    const prepared = JSON.parse(preparedBytes.toString()).records.find((r: { stockCode: string }) => r.stockCode === code);
    expect(prepared.diagnostic.sameExistingEvidence).toBe(true);
    let fullCompetitors: unknown[] | undefined;
    if (code === "9344") {
      const fullBytes = readFileSync(join(process.cwd(), "tmp/feature-audit-20261018/biztag-saved59-current-read-v2/property9344-once-v1/SUCCESS.json"));
      expect(createHash("sha256").update(fullBytes).digest("hex")).toBe("61538e9a5c35637c6867d6126d02a332a088699e0785e719a89c607e0b170b6f");
      const full = JSON.parse(fullBytes.toString()); expect(full.after.properties).toEqual(observed.target.properties);
      expect(full.values).toHaveLength(32); fullCompetitors = full.values;
    }
    const current = structuredClone(observed.target), byParent = new Map<string, unknown[]>();
    const children = (parent: string, blocks: Array<Record<string, unknown>>) => {
      byParent.set(parent, blocks);
      for (const b of blocks) if (b.has_children) children(b.id as string, (b[b.type as string] as { children: Array<Record<string, unknown>> }).children);
    };
    children(current.id, observed.children);
    io.request.mockImplementation(async (method: string, path: string, body?: { properties: Record<string, Record<string, unknown>> }) => {
      if (method === "GET" && path === `/pages/${current.id}`) return structuredClone(current);
      if (method === "GET" && path.startsWith(`/pages/${current.id}/properties/`)) {
        const propertyId = decodeURIComponent(path.split("/")[4].split("?")[0]);
        const property = Object.values(current.properties).find((p) => (p as { id: string }).id === propertyId) as { type: string; rich_text?: unknown[]; title?: unknown[]; relation?: unknown[] };
        const values = property.type === "relation" ? fullCompetitors : property[property.type as "rich_text" | "title"];
        expect(Array.isArray(values)).toBe(true);
        return { results: values!.map(value => ({ [property.type]: value })), has_more: false, next_cursor: null };
      }
      const match = /^\/blocks\/([^/]+)\/children\?/.exec(path);
      if (method === "GET" && match && byParent.has(match[1])) return { results: structuredClone(byParent.get(match[1])), has_more: false, next_cursor: null };
      if (method === "PATCH" && path === `/pages/${current.id}`) {
        for (const [name, value] of Object.entries(body!.properties)) current.properties[name] = { ...current.properties[name], ...value };
        return {};
      }
      throw new Error(`declared actual saved fixture rejects ${method} ${path}`);
    });
    const state = realpathSync(mkdtempSync(join(tmpdir(), "supplement-same-evidence-"))); privateStates.push(state);
    const durable = createSupplementPublicationJournal(state);
    durable.bindSource?.({ stockCode: code, docId: prepared.docId, sourcePageId: prepared.sourcePageId });
    await replaceEvidenceBlock(current.id, prepared.expectedEvidence, prepared.newInput, prepared.existingRowGuard, guard, durable);
    expect(mutations().every(value => value === `PATCH /pages/${current.id}`)).toBe(true);
    expect(mutations().length).toBeGreaterThan(0); expect(io.archive).toHaveBeenCalledTimes(1); expect(io.verify).toHaveBeenCalledTimes(1);
    if (code === "9344") {
      const snapshot = JSON.parse(new TextDecoder().decode(io.archive.mock.calls[0][0].files[0].bytes));
      expect(snapshot.page.properties["競合他社"].relation).toHaveLength(32);
    }
    const keys = readdirSync(join(state, "supplement-publications")); expect(keys).toHaveLength(1);
    expect(readdirSync(join(state, "supplement-publications", keys[0])).sort()).toEqual(["completed.json", "intent.json", "pre.json"]);
    durable.assertReady();
  });
  it.each([{ badEvidence: true }, { unknownAppend: true }])("failed/unknown new evidence keeps old properties and evidence (%j)", async (option) => {
    const state = setup(option);
    await expect(replaceEvidenceBlock("row", block, input, expected, guard, journal)).rejects.toThrow("PRE=pre-archive");
    expect(state.wasPatched()).toBe(false);
    expect(mutations()).toEqual(["PATCH /blocks/row/children"]);
  });
  it.each([{ unknownPatch: true }, { badPost: true }])("final PATCH unknown/readback mismatch stops without resend or old evidence retirement (%j)", async (option) => {
    const state = setup(option);
    await expect(replaceEvidenceBlock("row", block, input, expected, guard, journal)).rejects.toThrow(/PRE=pre-archive/);
    expect(state.wasPatched()).toBe(true); // may have applied; never claim unchanged
    expect(mutations()).toEqual(["PATCH /blocks/row/children", "PATCH /pages/row"]);
  });
  it("PRE readback failure or concurrent PRE change prevents all business writes", async () => {
    setup(); io.verify.mockRejectedValueOnce(new Error("PRE mismatch"));
    await expect(replaceEvidenceBlock("row", block, input, expected, guard, journal)).rejects.toThrow("PRE mismatch");
    expect(mutations()).toEqual([]);
    vi.clearAllMocks(); io.verify.mockResolvedValue(undefined); setup({ stalePre: true });
    await expect(replaceEvidenceBlock("row", block, input, expected, guard, journal)).rejects.toThrow("PRE保管中");
    expect(mutations()).toEqual([]);
  });
  it("an existing identical PRE latches recovery instead of replaying an unknown run", async () => {
    setup(); io.archive.mockResolvedValueOnce({ pageId: "pre-archive", outcome: "skipped_existing" });
    await expect(replaceEvidenceBlock("row", block, input, expected, guard, journal)).rejects.toThrow("自動再送せず照合");
    expect(mutations()).toEqual([]);
  });
  it("candidate-free evidence is retired only after verified property commit", async () => {
    setup(); await replaceEvidenceBlock("row", null, input, expected, guard, journal);
    expect(mutations()).toEqual(["PATCH /pages/row", "DELETE /blocks/old"]);
  });
  it("planの旧タグ・入力/版が変わった場合はPRE uploadより前にHOLD", async () => {
    setup(); const changed = { ...expected, ...buildSupplementProperties({ vocabVersion: "other-version" }) };
    await expect(replaceEvidenceBlock("row", block, input, changed, guard, journal)).rejects.toThrow("旧タグ・判定根拠がplan後に変更");
    expect(io.archive).not.toHaveBeenCalled(); expect(guard).not.toHaveBeenCalled(); expect(mutations()).toEqual([]);
  });
  it.each(["latest/pointer changed", "D1 read failed"])("write直前guardの失敗は新根拠/props/旧根拠へ一切writeしない (%s)", async (reason) => {
    setup(); guard.mockRejectedValueOnce(new Error(reason));
    await expect(replaceEvidenceBlock("row", block, input, expected, guard, journal)).rejects.toThrow(reason);
    expect(guard).toHaveBeenCalledTimes(1); expect(mutations()).toEqual([]);
    expect(io.verify).toHaveBeenCalledTimes(1);
    expect(guard.mock.invocationCallOrder[0]).toBeGreaterThan(io.verify.mock.invocationCallOrder[0]);
  });
  it("same-input text sync keeps old evidence while still verifying property commit", async () => {
    setup(); await replaceEvidenceBlock("row", undefined, input, expected, guard, journal);
    expect(mutations()).toEqual(["PATCH /pages/row"]);
  });
  it("identical text-only properties skip PRE upload and PATCH while still checking current source", async () => {
    setup(); await replaceEvidenceBlock("row", undefined, { docId: "S100OLD" }, expected, guard, journal);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(io.archive).not.toHaveBeenCalled(); expect(io.verify).not.toHaveBeenCalled(); expect(mutations()).toEqual([]);
    expect(io.request.mock.calls.some(([, path]) => String(path).startsWith("/blocks/"))).toBe(false);
  });
  it("a protected old model property changing after text-only PATCH stops without retiring evidence", async () => {
    setup({ changedProtectedAfter: true });
    await expect(replaceEvidenceBlock("row", undefined, input, expected, guard, journal)).rejects.toThrow("PRE=pre-archive");
    expect(mutations()).toEqual(["PATCH /pages/row"]);
  });
  it("long rich_text uses full property pagination before comparing", async () => {
    setup({ longProperty: true }); await replaceEvidenceBlock("row", block, input, expected, guard, journal);
    expect(io.request.mock.calls.some(([, path]) => String(path).startsWith("/pages/row/properties/p"))).toBe(true);
  });
  it("full PRE physically includes nested old proof and reads all new child evidence before commit", async () => {
    setup({ nestedEvidence: true }); await replaceEvidenceBlock("row", block, input, expected, guard, journal);
    const file = io.archive.mock.calls[0][0].files[0];
    const pre = JSON.parse(new TextDecoder().decode(file.bytes));
    expect(pre.children[0].heading_3.children[0].quote.rich_text[0].plain_text).toBe("旧根拠全文");
    expect(io.verify.mock.calls[0][1][0].bytes).toEqual(file.bytes);
    const requests = io.request.mock.calls.map(([method, path]) => `${method} ${path}`);
    expect(requests.indexOf("GET /blocks/new/children?page_size=100")).toBeLessThan(requests.indexOf("PATCH /pages/row"));
  });
  it("unknown retirement includes PRE for reconciliation and never resends the delete", async () => {
    const state = setup({ unknownRetire: true });
    await expect(replaceEvidenceBlock("row", block, input, expected, guard, journal)).rejects.toThrow("PRE=pre-archive");
    expect(state.wasPatched()).toBe(true);
    expect(mutations()).toEqual(["PATCH /blocks/row/children", "PATCH /pages/row", "DELETE /blocks/old"]);
  });
  it("varying Notion request_id never changes PRE equality or the unknown-execution latch", async () => {
    setup(); io.request.mockClear();
    await replaceEvidenceBlock("row", undefined, input, expected, guard, journal);
    const first = io.archive.mock.calls[0][0];
    const pre = JSON.parse(new TextDecoder().decode(first.files[0].bytes));
    expect(pre.page).not.toHaveProperty("request_id");
    expect(pre.page.last_edited_time).toBe("2026-10-14T00:00:00Z");
    setup(); io.request.mockClear(); io.archive.mockResolvedValueOnce({ pageId: "pre-archive", outcome: "skipped_existing" });
    await expect(replaceEvidenceBlock("row", undefined, input, expected, guard, journal)).rejects.toThrow("自動再送せず照合");
    expect(io.archive.mock.calls[1][0].key).toBe(first.key);
    expect(mutations()).toEqual([]);
  });
  it("object key reordering preserves PRE CAS and cannot bypass the existing-execution latch", async () => {
    setup({ reverseKeys: "alternate" });
    await replaceEvidenceBlock("row", undefined, input, expected, guard, journal);
    const first = io.archive.mock.calls[0][0];
    setup({ reverseKeys: true }); io.request.mockClear();
    io.archive.mockResolvedValueOnce({ pageId: "pre-archive", outcome: "skipped_existing" });
    await expect(replaceEvidenceBlock("row", undefined, input, expected, guard, journal)).rejects.toThrow("自動再送せず照合");
    expect(io.archive.mock.calls[1][0].key).toBe(first.key);
    expect(io.archive.mock.calls[1][0].files[0].bytes).toEqual(first.files[0].bytes);
    expect(mutations()).toEqual([]);
  });
});
