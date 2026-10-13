/** Structural Notion responses only; no production data or network. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildEvidenceBlock, buildSupplementProperties, replaceEvidenceBlock } from "./stock-supplement.js";
import { NotionUnknownResultError } from "./client.js";

const io = vi.hoisted(() => ({ request: vi.fn(), archive: vi.fn(), verify: vi.fn() }));
vi.mock("./client.js", async (original) => ({ ...await original<typeof import("./client.js")>(), notionRequest: io.request }));
vi.mock("./archive.js", async (original) => ({ ...await original<typeof import("./archive.js")>(), recordPrimaryData: io.archive }));
vi.mock("./readback.js", () => ({ verifyArchivedAttachments: io.verify }));

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
function setup(options: { badEvidence?: boolean; unknownAppend?: boolean; unknownPatch?: boolean; unknownRetire?: boolean; nestedEvidence?: boolean; badPost?: boolean; stalePre?: boolean; longProperty?: boolean; changedProtectedAfter?: boolean; reverseKeys?: boolean | "alternate" } = {}) {
  let patched = false;
  let pageReads = 0;
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
    if (method === "GET" && path.startsWith("/blocks/row/children")) return { results: [{ ...old, has_children: options.nestedEvidence === true }], has_more: false, next_cursor: null };
    if (method === "GET" && path.startsWith("/blocks/old/children")) return { results: [{ id: "old-quote", type: "quote", quote: { rich_text: [{ plain_text: "旧根拠全文" }] } }], has_more: false, next_cursor: null };
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

describe("supplement evidence two-phase replacement", () => {
  it("physically verifies PRE and new full evidence before properties, then verifies properties before retiring old evidence", async () => {
    setup();
    await replaceEvidenceBlock("row", block, input, expected, guard);
    expect(io.archive).toHaveBeenCalledTimes(1);
    expect(io.verify).toHaveBeenCalledWith("pre-archive", expect.any(Array), "事業タグ更新前PRE");
    expect(mutations()).toEqual(["PATCH /blocks/row/children", "PATCH /pages/row", "DELETE /blocks/old"]);
    const requests = io.request.mock.calls.map(([method, path]) => `${method} ${path}`);
    expect(requests.indexOf("GET /blocks/new")).toBeLessThan(requests.indexOf("PATCH /pages/row"));
    expect(requests.lastIndexOf("GET /pages/row")).toBeLessThan(requests.indexOf("DELETE /blocks/old"));
  });
  it.each([{ badEvidence: true }, { unknownAppend: true }])("failed/unknown new evidence keeps old properties and evidence (%j)", async (option) => {
    const state = setup(option);
    await expect(replaceEvidenceBlock("row", block, input, expected, guard)).rejects.toThrow("PRE=pre-archive");
    expect(state.wasPatched()).toBe(false);
    expect(mutations()).toEqual(["PATCH /blocks/row/children"]);
  });
  it.each([{ unknownPatch: true }, { badPost: true }])("final PATCH unknown/readback mismatch stops without resend or old evidence retirement (%j)", async (option) => {
    const state = setup(option);
    await expect(replaceEvidenceBlock("row", block, input, expected, guard)).rejects.toThrow(/PRE=pre-archive/);
    expect(state.wasPatched()).toBe(true); // may have applied; never claim unchanged
    expect(mutations()).toEqual(["PATCH /blocks/row/children", "PATCH /pages/row"]);
  });
  it("PRE readback failure or concurrent PRE change prevents all business writes", async () => {
    setup(); io.verify.mockRejectedValueOnce(new Error("PRE mismatch"));
    await expect(replaceEvidenceBlock("row", block, input, expected, guard)).rejects.toThrow("PRE mismatch");
    expect(mutations()).toEqual([]);
    vi.clearAllMocks(); io.verify.mockResolvedValue(undefined); setup({ stalePre: true });
    await expect(replaceEvidenceBlock("row", block, input, expected, guard)).rejects.toThrow("PRE保管中");
    expect(mutations()).toEqual([]);
  });
  it("an existing identical PRE latches recovery instead of replaying an unknown run", async () => {
    setup(); io.archive.mockResolvedValueOnce({ pageId: "pre-archive", outcome: "skipped_existing" });
    await expect(replaceEvidenceBlock("row", block, input, expected, guard)).rejects.toThrow("自動再送せず照合");
    expect(mutations()).toEqual([]);
  });
  it("candidate-free evidence is retired only after verified property commit", async () => {
    setup(); await replaceEvidenceBlock("row", null, input, expected, guard);
    expect(mutations()).toEqual(["PATCH /pages/row", "DELETE /blocks/old"]);
  });
  it("planの旧タグ・入力/版が変わった場合はPRE uploadより前にHOLD", async () => {
    setup(); const changed = { ...expected, ...buildSupplementProperties({ vocabVersion: "other-version" }) };
    await expect(replaceEvidenceBlock("row", block, input, changed, guard)).rejects.toThrow("旧タグ・判定根拠がplan後に変更");
    expect(io.archive).not.toHaveBeenCalled(); expect(guard).not.toHaveBeenCalled(); expect(mutations()).toEqual([]);
  });
  it.each(["latest/pointer changed", "D1 read failed"])("write直前guardの失敗は新根拠/props/旧根拠へ一切writeしない (%s)", async (reason) => {
    setup(); guard.mockRejectedValueOnce(new Error(reason));
    await expect(replaceEvidenceBlock("row", block, input, expected, guard)).rejects.toThrow(reason);
    expect(guard).toHaveBeenCalledTimes(1); expect(mutations()).toEqual([]);
    expect(io.verify).toHaveBeenCalledTimes(1);
    expect(guard.mock.invocationCallOrder[0]).toBeGreaterThan(io.verify.mock.invocationCallOrder[0]);
  });
  it("same-input text sync keeps old evidence while still verifying property commit", async () => {
    setup(); await replaceEvidenceBlock("row", undefined, input, expected, guard);
    expect(mutations()).toEqual(["PATCH /pages/row"]);
  });
  it("identical text-only properties skip PRE upload and PATCH while still checking current source", async () => {
    setup(); await replaceEvidenceBlock("row", undefined, { docId: "S100OLD" }, expected, guard);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(io.archive).not.toHaveBeenCalled(); expect(io.verify).not.toHaveBeenCalled(); expect(mutations()).toEqual([]);
    expect(io.request.mock.calls.some(([, path]) => String(path).startsWith("/blocks/"))).toBe(false);
  });
  it("a protected old model property changing after text-only PATCH stops without retiring evidence", async () => {
    setup({ changedProtectedAfter: true });
    await expect(replaceEvidenceBlock("row", undefined, input, expected, guard)).rejects.toThrow("PRE=pre-archive");
    expect(mutations()).toEqual(["PATCH /pages/row"]);
  });
  it("long rich_text uses full property pagination before comparing", async () => {
    setup({ longProperty: true }); await replaceEvidenceBlock("row", block, input, expected, guard);
    expect(io.request.mock.calls.some(([, path]) => String(path).startsWith("/pages/row/properties/p"))).toBe(true);
  });
  it("full PRE physically includes nested old proof and reads all new child evidence before commit", async () => {
    setup({ nestedEvidence: true }); await replaceEvidenceBlock("row", block, input, expected, guard);
    const file = io.archive.mock.calls[0][0].files[0];
    const pre = JSON.parse(new TextDecoder().decode(file.bytes));
    expect(pre.children[0].heading_3.children[0].quote.rich_text[0].plain_text).toBe("旧根拠全文");
    expect(io.verify.mock.calls[0][1][0].bytes).toEqual(file.bytes);
    const requests = io.request.mock.calls.map(([method, path]) => `${method} ${path}`);
    expect(requests.indexOf("GET /blocks/new/children?page_size=100")).toBeLessThan(requests.indexOf("PATCH /pages/row"));
  });
  it("unknown retirement includes PRE for reconciliation and never resends the delete", async () => {
    const state = setup({ unknownRetire: true });
    await expect(replaceEvidenceBlock("row", block, input, expected, guard)).rejects.toThrow("PRE=pre-archive");
    expect(state.wasPatched()).toBe(true);
    expect(mutations()).toEqual(["PATCH /blocks/row/children", "PATCH /pages/row", "DELETE /blocks/old"]);
  });
  it("varying Notion request_id never changes PRE equality or the unknown-execution latch", async () => {
    setup(); io.request.mockClear();
    await replaceEvidenceBlock("row", undefined, input, expected, guard);
    const first = io.archive.mock.calls[0][0];
    const pre = JSON.parse(new TextDecoder().decode(first.files[0].bytes));
    expect(pre.page).not.toHaveProperty("request_id");
    expect(pre.page.last_edited_time).toBe("2026-10-14T00:00:00Z");
    setup(); io.request.mockClear(); io.archive.mockResolvedValueOnce({ pageId: "pre-archive", outcome: "skipped_existing" });
    await expect(replaceEvidenceBlock("row", undefined, input, expected, guard)).rejects.toThrow("自動再送せず照合");
    expect(io.archive.mock.calls[1][0].key).toBe(first.key);
    expect(mutations()).toEqual([]);
  });
  it("object key reordering preserves PRE CAS and cannot bypass the existing-execution latch", async () => {
    setup({ reverseKeys: "alternate" });
    await replaceEvidenceBlock("row", undefined, input, expected, guard);
    const first = io.archive.mock.calls[0][0];
    setup({ reverseKeys: true }); io.request.mockClear();
    io.archive.mockResolvedValueOnce({ pageId: "pre-archive", outcome: "skipped_existing" });
    await expect(replaceEvidenceBlock("row", undefined, input, expected, guard)).rejects.toThrow("自動再送せず照合");
    expect(io.archive.mock.calls[1][0].key).toBe(first.key);
    expect(io.archive.mock.calls[1][0].files[0].bytes).toEqual(first.files[0].bytes);
    expect(mutations()).toEqual([]);
  });
});
