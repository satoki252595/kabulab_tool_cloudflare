import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SupplementRow } from "../../../../src/shared/notion-archive/stock-supplement.js";
import { loadStockMasterIndex } from "../../../../src/shared/notion-archive/index.js";
import { SHARED_WRITER_KEY, withSharedPublishingWriter, type PublishingStore } from "../../../../scripts/mechanical-publishing/shared-writer.js";
import { mechanicalSelection, mechanicalTextInput, publishingCursor, runMechanicalPublishing } from "./mechanical-publishing.js";
import { planWork, withInputReceipt, withTextSyncReceipt } from "./plan.js";
import { TEXT_SECTIONS } from "../services/edinet/text-sections.js";
import { BiztagTextQualificationError, type LatestDoc } from "./source.js";

const io = vi.hoisted(() => ({ latest: vi.fn(), rows: vi.fn(), full: vi.fn(), source: vi.fn(), qualified: vi.fn(), replace: vi.fn(), create: vi.fn() }));
vi.mock("../../../../src/shared/db/d1-http-client.js", () => ({ createD1HttpDb: () => ({}) }));
vi.mock("./source.js", async original => ({ ...await original<typeof import("./source.js")>(), loadLatestDocs: io.latest, assertLatestDocCurrent: vi.fn(), readQualifiedBiztagDocText: io.qualified }));
vi.mock("../../../../src/shared/notion-archive/index.js", async original => ({ ...await original<typeof import("../../../../src/shared/notion-archive/index.js")>(),
  ensureSupplementDb: vi.fn(async () => ({ dbId: "protocol-db", propertyIds: {} })), loadSupplementRows: io.rows,
  loadStockMasterIndex: vi.fn(async () => ({ index: new Map([["6103", "protocol-master"]]), duplicates: new Set() })),
  readStockTextRow: io.source, replaceEvidenceBlock: io.replace, createSupplementRow: io.create,
}));
vi.mock("../../../../src/shared/notion-archive/stock-supplement.js", async original => ({ ...await original<typeof import("../../../../src/shared/notion-archive/stock-supplement.js")>(), readSupplementRowFully: io.full }));

// Existing process.test.ts records this actual S100YFQC business passage. No model output is invented.
const business = "３ 【事業の内容】当グループは、当社、連結子会社16社、非連結子会社15社で構成され、ＮＣ旋盤、マシニングセンタ、複合加工機、ＮＣ研削盤等の工作機械の製造・販売を主な事業内容としております。";
const latest: LatestDoc = { stockCode: "6103", companyName: "オークマ", sector33: "機械", doc: {
  docId: "S100YFQC", docTypeCode: "120", periodEnd: "2026-03-31", submittedAt: "2026-06-25T00:00:00.000Z", notionDocPageId: "protocol-source", textParseStatus: "ok",
} };
const sections = [{ sectionKey: "business", itemName: "事業の内容", text: business }];
function row(): SupplementRow {
  return { pageId: "protocol-row", stockCode: latest.stockCode, companyName: latest.companyName, sector33: latest.sector33,
    docId: latest.doc!.docId, docType: "有報", periodEnd: latest.doc!.periodEnd, submittedAt: latest.doc!.submittedAt,
    textStatus: "取得済", tagStatus: "判定済", tagDoc: "S100YFQC 2026年3月期", vocabVersion: "v1", judgedAt: null,
    candidateCount: null, attempts: null, nextRetryAt: null, error: null, judgeInput: null, upstream: ["工作機械"], downstream: [], distribution: [], themes: [],
    uncertain: null, evidenceText: "保存済み判定根拠（protocol）", masterLinked: true,
    texts: Object.fromEntries(TEXT_SECTIONS.map(s => [s.title, s.key === "business" ? business : ""])) };
}
function store(): PublishingStore {
  let serial = 0;
  const data = new Map([[SHARED_WRITER_KEY, { body: JSON.stringify({ version: 1, baselineSha256: "0".repeat(64), owner: null, pending: null }), etag: "0" }]]);
  return { async get(key) { return data.get(key) ?? null; }, async put(key, body, etag) {
    if ((data.get(key)?.etag ?? null) !== etag) throw new Error("CAS mismatch"); data.set(key, { body, etag: String(++serial) });
  } };
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); }));
  io.latest.mockResolvedValue([latest]); io.rows.mockResolvedValue([row()]); io.full.mockResolvedValue(row()); io.source.mockResolvedValue(sections);
  io.qualified.mockImplementation(async (_db, _code, doc) => io.source(doc.notionDocPageId, true));
  io.replace.mockResolvedValue(undefined); io.create.mockResolvedValue("protocol-new");
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("new qualified body preserves old semantic columns and makes monthly retag detectable", async () => {
  const old = row(); old.docId = "S100OLD"; old.tagDoc = "S100OLD 2025年3月期";
  old.judgeInput = withInputReceipt("保存済み判定入力", { docId: "S100OLD", textPageId: "old-source", businessSha256: null, sectionsSha256: "1".repeat(64), stateSha256: null, vocabVersion: "v1", model: null });
  const input = await mechanicalTextInput(latest, old, sections, null);
  expect(input).toMatchObject({ docId: "S100YFQC", textStatus: "取得済", tagInputSha256: "1".repeat(64) });
  for (const key of ["upstream", "downstream", "distribution", "themes", "tagStatus", "tagDoc", "judgeInput", "evidenceText", "vocabVersion", "judgedAt"])
    expect(input).not.toHaveProperty(key);
  const next = { ...old, ...input } as SupplementRow;
  expect(planWork([latest], [next], "2026-10-25")[0]).toMatchObject({ kind: "retag", sourceChangedLocalJudge: true });
  expect(old.judgeInput).toBe(next.judgeInput);
  const unknown = await mechanicalTextInput(latest, { ...old, judgeInput: "旧入力SHA未保存" }, sections, null);
  expect(unknown.tagInputSha256).toBeNull();
});
it("same doc changed four-section input is retag work, never current judgment reuse", async () => {
  const saved = row(); saved.judgeInput = withInputReceipt("saved", { docId: latest.doc!.docId, textPageId: latest.doc!.notionDocPageId!, businessSha256: null,
    sectionsSha256: "1".repeat(64), stateSha256: null, vocabVersion: "v1", model: null });
  const input = await mechanicalTextInput(latest, saved, sections, null);
  expect(planWork([latest], [{ ...saved, ...input } as SupplementRow], "2026-10-25")[0]).toMatchObject({ kind: "retag", checkSourceInput: true });
});
it("finite full target verification qualifies source even when unchanged, and repairs a user-cleared cell with semantic state intact", async () => {
  const saved = row(), input = await mechanicalTextInput(latest, saved, sections, "protocol-master");
  Object.assign(saved, input); saved.texts = row().texts;
  io.rows.mockResolvedValue([saved]); io.full.mockResolvedValue(saved);
  const run = () => withSharedPublishingWriter(() => runMechanicalPublishing({ codes: ["6103"], limit: 1, budgetMs: 60_000 }), store());
  const unchanged = await run();
  expect(unchanged).toMatchObject({ unchanged: 1, synced: 0, modelCalls: 0, selectedCodes: ["6103"],
    latestDocs: [{ stockCode: "6103", doc: latest.doc }], outcomes: [{ stockCode: "6103", outcome: "unchanged", holds: [] }] });
  const receipt = JSON.parse(input.textSyncReceipt!);
  expect(unchanged.outcomes[0].sourceReceipt).toEqual({ textsSha256: receipt.textsSha256, notionTextsSha256: receipt.notionTextsSha256 });
  expect(unchanged.cursorAfter).toEqual(unchanged.cursorBefore);
  expect(JSON.stringify(unchanged)).not.toContain(business);
  expect(JSON.stringify(unchanged)).not.toContain(saved.evidenceText);
  expect(unchanged.latestDocs[0]).not.toHaveProperty("companyName");
  expect(io.full).toHaveBeenCalledTimes(1); expect(io.qualified).toHaveBeenCalledTimes(1); expect(io.source).toHaveBeenCalledTimes(1);
  io.full.mockResolvedValue({ ...saved, texts: { ...saved.texts, "事業の内容": "" } });
  const repaired = await run();
  expect(repaired).toMatchObject({ synced: 1, modelCalls: 0, outcomes: [{ stockCode: "6103", outcome: "synced", holds: [] }] });
  expect(repaired.outcomes[0].sourceReceipt).toEqual(unchanged.outcomes[0].sourceReceipt);
  expect(io.source).toHaveBeenCalledWith(latest.doc!.notionDocPageId, true);
  expect(io.replace.mock.calls[0][2]).not.toHaveProperty("tagDoc");
  expect(io.replace.mock.calls[0][2]).not.toHaveProperty("judgeInput");
  expect(io.rows).toHaveBeenCalledWith("protocol-db", {}, { codes: ["6103"] });
  expect(fetch).not.toHaveBeenCalled();
});
it("reported-source HOLD and empty source cannot clear old body/tag", async () => {
  io.latest.mockResolvedValue([{ ...latest, reportedHoldReason: "reported-state qualification HOLD" }]);
  const run = () => withSharedPublishingWriter(() => runMechanicalPublishing({ codes: ["6103"], limit: 1, budgetMs: 60_000 }), store());
  expect(await run()).toMatchObject({ synced: 0, processed: 1, modelCalls: 0,
    outcomes: [{ stockCode: "6103", outcome: "held", sourceReceipt: null, holds: ["reported-state qualification HOLD"] }] });
  expect(io.source).not.toHaveBeenCalled(); expect(io.replace).not.toHaveBeenCalled();
  await expect(mechanicalTextInput(latest, row(), [], null)).rejects.toThrow("旧本文を消しません");
});
it("invalid cursor never silently resets its source window", () => {
  expect(() => publishingCursor('{"version":1,"afterCode":null,"changedAt":"invalid","changedDoc":""}', Date.now())).toThrow();
});
it("changed-document and rotation selectors use real saved rows, bounded SQL output before original access", async () => {
  const saved = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/latest-docs-saved50-20261017.json.gz", import.meta.url))).toString());
  const sqlite = new DatabaseSync(":memory:"), counts: number[] = [], sqls: string[] = [];
  try {
    sqlite.exec("CREATE TABLE core_stocks(id INTEGER,code TEXT,name TEXT,sector33 TEXT,is_active INTEGER,instrument_type TEXT); CREATE TABLE yuho_documents(doc_id TEXT,stock_id INTEGER,doc_type_code TEXT,ingested_at INTEGER);");
    for (const s of saved.core) sqlite.prepare("insert into core_stocks values(?,?,?,?,1,'equity')").run(s.id, s.code, s.name, s.sector33);
    for (const d of saved.documents) sqlite.prepare("insert into yuho_documents values(?,?,?,?)").run(d.doc_id,d.stock_id,d.doc_type_code,d.submitted_at);
    const db = drizzle(async (sql, params) => { sqls.push(sql); const rows = sqlite.prepare(sql).all(...params as (string | number | null)[]); counts.push(rows.length); return { rows: rows.map(Object.values) }; });
    const result = await mechanicalSelection(db, { version: 1, afterCode: null, changedAt: "2026-01-01T00:00:00Z", changedDoc: "" }, 3);
    expect(result.codes.length).toBeLessThanOrEqual(3); expect(counts).toEqual([3,3]);
    expect(sqls.every(sql => sql.includes("limit ?") && sql.includes('"is_active"') && sql.includes('"instrument_type"'))).toBe(true);
    expect(io.source).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  } finally { sqlite.close(); }
});

it("one admitted body can close after soft; the next body never starts and both keep the exact hard bound", async () => {
  vi.useFakeTimers(); const start = Date.parse("2026-10-25T19:17:00.000Z"); vi.setSystemTime(start);
  const soft = start + 60_000, hard = soft + 5 * 60_000;
  io.latest.mockResolvedValue([latest, { ...latest, stockCode: "6104" }]);
  io.source.mockImplementation(async () => { vi.setSystemTime(soft + 1); return sections; });
  const result = await withSharedPublishingWriter(() => runMechanicalPublishing({ codes: ["6103", "6104"], limit: 2,
    budgetMs: 600_000, sourceDeadlineMs: soft, deadlineMs: hard }), store());
  expect(result).toMatchObject({ synced: 1, processed: 1, unstarted: 1, selectedCodes: ["6103", "6104"],
    latestDocs: [{ stockCode: "6103", doc: latest.doc }, { stockCode: "6104", doc: latest.doc }],
    outcomes: [{ stockCode: "6103", outcome: "synced", holds: [] }, { stockCode: "6104", outcome: "unstarted", sourceReceipt: null, holds: [] }] });
  expect(io.source).toHaveBeenCalledTimes(1); expect(io.replace).toHaveBeenCalledTimes(1);
  vi.setSystemTime(hard);
  await expect(withSharedPublishingWriter(() => runMechanicalPublishing({ codes: ["6103"], limit: 1, budgetMs: 600_000,
    sourceDeadlineMs: soft, deadlineMs: hard }), store())).rejects.toThrow();
  expect(io.source).toHaveBeenCalledTimes(1);
});

it("relation HOLD coexists with a body sync, and explicit codes leave the saved cursor unchanged", async () => {
  const saved = { ...row(), masterLinked: false };
  io.rows.mockResolvedValue([saved]); io.full.mockResolvedValue(saved);
  vi.mocked(loadStockMasterIndex).mockResolvedValueOnce({ index: new Map(), duplicates: new Map() });
  const memory = store(), key = "mechanical-publishing/v1/cursors/supplement-texts.json";
  const cursor = { version: 1, afterCode: "2152", changedAt: "2026-10-24T21:15:26.000Z", changedDoc: "" };
  await memory.put(key, JSON.stringify(cursor) + "\n", null);
  const put = vi.spyOn(memory, "put");
  const result = await withSharedPublishingWriter(() => runMechanicalPublishing({ codes: ["6103"], limit: 1, budgetMs: 60_000 }), memory);
  expect(result).toMatchObject({ synced: 1, held: [{ stockCode: "6103" }], cursorBefore: cursor, cursorAfter: cursor,
    outcomes: [{ stockCode: "6103", outcome: "synced", holds: ["一意な銘柄マスタrelation先が未保管。本文同期とは区別して保持"] }] });
  expect(result.outcomes[0].sourceReceipt?.textsSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(put.mock.calls.some(([actual]) => actual === key)).toBe(false);
  expect(io.latest).toHaveBeenCalledTimes(1); expect(io.full).toHaveBeenCalledTimes(1); expect(io.source).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
});

it("basic-only metadata keeps the missing-source HOLD and has no qualified body receipt", async () => {
  io.latest.mockResolvedValue([{ ...latest, doc: null }]); io.rows.mockResolvedValue([]);
  const result = await withSharedPublishingWriter(() => runMechanicalPublishing({ codes: ["6103"], limit: 1, budgetMs: 60_000 }), store());
  expect(result).toMatchObject({ processed: 1, basicOnly: 1, synced: 0, latestDocs: [{ stockCode: "6103", doc: null }],
    outcomes: [{ stockCode: "6103", outcome: "basic-only", sourceReceipt: null,
      holds: ["最新有報の適格本文が未保管。基本メタ欠落だけを補い旧本文/タグを保持"] }] });
  expect(io.create).toHaveBeenCalledTimes(1); expect(io.full).not.toHaveBeenCalled(); expect(io.source).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("mechanical source metadata HOLD creates no publication or business write", async () => {
  io.qualified.mockRejectedValueOnce(new BiztagTextQualificationError(new Error("7メタ不一致")));
  const memory = store(), put = vi.spyOn(memory, "put");
  await expect(withSharedPublishingWriter(() => runMechanicalPublishing({ codes: ["6103"], limit: 1, budgetMs: 60_000 }), memory))
    .rejects.toThrow("publishing_read_only_failed");
  expect(io.qualified).toHaveBeenCalledWith(expect.anything(), "6103", latest.doc);
  expect(io.replace).not.toHaveBeenCalled(); expect(io.create).not.toHaveBeenCalled();
  expect(put.mock.calls.some(([key]) => key.includes("/operations/"))).toBe(false);
});

it("same-length source edit cannot reuse prior receipt or call an old target unchanged", async () => {
  const saved = row(), before = await mechanicalTextInput(latest, saved, sections, "protocol-master");
  Object.assign(saved, before); saved.texts = row().texts;
  const changed = business.replace("製造", "製作"); expect(changed).not.toBe(business); expect(changed.length).toBe(business.length);
  io.rows.mockResolvedValue([saved]); io.full.mockResolvedValue(saved);
  io.source.mockResolvedValue([{ ...sections[0], text: changed }]);
  const result = await withSharedPublishingWriter(() => runMechanicalPublishing({ codes: ["6103"], limit: 1, budgetMs: 60_000 }), store());
  expect(result).toMatchObject({ unchanged: 0, synced: 1, modelCalls: 0 });
  expect(io.qualified).toHaveBeenCalledTimes(1); expect(io.source).toHaveBeenCalledTimes(1);
  expect(io.replace.mock.calls[0][2].texts["事業の内容"]).toBe(changed);
  expect(io.replace.mock.calls[0][2]).not.toHaveProperty("tagDoc");
});

it.each(["legacy_all_null", "receipt_null", "text_sha_null", "tag_sha_null"] as const)("%s provenance is synchronized even when body is unchanged", async missing => {
  const saved = row();
  if (missing !== "legacy_all_null") saved.judgeInput = withInputReceipt("保存済み判定入力", {
    docId: latest.doc!.docId, textPageId: latest.doc!.notionDocPageId!, businessSha256: null,
    sectionsSha256: "1".repeat(64), stateSha256: null, vocabVersion: "v1", model: null });
  const expected = await mechanicalTextInput(latest, saved, sections, "protocol-master");
  Object.assign(saved, expected); saved.texts = row().texts;
  saved.judgeInput = withTextSyncReceipt(saved.judgeInput!, JSON.parse(expected.textSyncReceipt!));
  if (missing === "legacy_all_null" || missing === "receipt_null") saved.textSyncReceipt = null;
  if (missing === "legacy_all_null" || missing === "text_sha_null") saved.textInputSha256 = null;
  if (missing === "legacy_all_null" || missing === "tag_sha_null") saved.tagInputSha256 = null;
  const historical = saved.judgeInput;
  io.rows.mockResolvedValue([saved]); io.full.mockResolvedValue(saved);
  const result = await withSharedPublishingWriter(() => runMechanicalPublishing({ codes: ["6103"], limit: 1, budgetMs: 60_000 }), store());
  expect(result).toMatchObject({ unchanged: 0, synced: 1, modelCalls: 0 });
  expect(io.qualified).toHaveBeenCalledTimes(1); expect(io.source).toHaveBeenCalledTimes(1);
  const input = io.replace.mock.calls[0][2];
  expect(input).toMatchObject({ textSyncReceipt: expected.textSyncReceipt, textInputSha256: expected.textInputSha256,
    tagInputSha256: missing === "legacy_all_null" ? null : "1".repeat(64) });
  expect(input).not.toHaveProperty("judgeInput"); expect(input).not.toHaveProperty("tagDoc");
  expect(saved.judgeInput).toBe(historical);
});
