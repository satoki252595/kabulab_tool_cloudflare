/** Real3776 ZIPs/business/body and native entries; transport/page responses and atomic ACKs are explicit offline controls. */
import { readFileSync, mkdtempSync, rmSync, existsSync, realpathSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openActualSnapshot, readSnapshot, type Snapshot } from "./lib/saved-overseas-atomic.js";
import type { Database } from "../src/db/client.js";
import type { D1BatchStatement } from "../../../src/shared/db/d1-http-client.js";
import { recordReportedChanges } from "../src/services/edinet/reported-changes.js";
import { readInformationEditState, verifyInformationEditData } from "../src/services/edinet/information-edit.js";
import { parseEdinetCsvZip } from "../src/services/edinet/csv.js";
import { runBasisReaccept, type parseBasisArguments } from "./reaccept-information-edit-basis.js";
const io = vi.hoisted(() => ({ db: vi.fn(), sender: vi.fn(), list: vi.fn(), typed: vi.fn(), body: vi.fn(), record: vi.fn(), verify: vi.fn(),
  page: vi.fn(), files: vi.fn(), download: vi.fn(), store: vi.fn() }));
vi.mock("../../../src/shared/db/d1-http-client.js", async original => ({ ...await original<typeof import("../../../src/shared/db/d1-http-client.js")>(), createD1HttpDb: io.db, createD1HttpBatchSender: () => io.sender }));
vi.mock("../src/services/edinet/list-snapshot.js", async original => ({ ...await original<typeof import("../src/services/edinet/list-snapshot.js")>(), readListSnapshot: io.list }));
vi.mock("../src/services/edinet/archive.js", async original => ({ ...await original<typeof import("../src/services/edinet/archive.js")>(), readSavedEdinetZip: io.typed }));
vi.mock("../src/services/text-backup.js", async original => ({ ...await original<typeof import("../src/services/text-backup.js")>(), readVerifiedDocText: io.body }));
vi.mock("../../../src/shared/notion-archive/index.js", async original => ({ ...await original<typeof import("../../../src/shared/notion-archive/index.js")>(), recordPrimaryData: io.record, verifyArchivedAttachments: io.verify }));
vi.mock("../../../src/shared/notion-archive/archive.js", async original => ({ ...await original<typeof import("../../../src/shared/notion-archive/archive.js")>(), findUniqueBackupChildByTitle: async () => "3e1d74ff84cd812ebc79f7aff3f2d7ca" }));
vi.mock("../../../src/shared/notion-archive/client.js", async original => ({ ...await original<typeof import("../../../src/shared/notion-archive/client.js")>(), notionRequest: io.page }));
vi.mock("../../../src/shared/notion-archive/page-file.js", () => ({ listPageFiles: io.files }));
vi.mock("../../../src/shared/notion-archive/archived-download.js", async original => ({ ...await original<typeof import("../../../src/shared/notion-archive/archived-download.js")>(), downloadArchivedFile: io.download }));
vi.mock("../../../scripts/mechanical-publishing/shared-writer.js", async original => ({ ...await original<typeof import("../../../scripts/mechanical-publishing/shared-writer.js")>(), publishingStore: io.store }));
const fixture = new URL("../src/tests/fixtures/information-edit-basis-3776/", import.meta.url);
const json = (name: string) => JSON.parse(readFileSync(new URL(name, fixture), "utf8"));
const before = json("current-state-before.json"), entry = json("native-entry.json"), metadata = json("current-zip-metadata.json"), oldMetadata = json("old-source-metadata.json");
const csv = readFileSync(new URL("current-type5.zip", fixture)), current = readFileSync(new URL("current-type1.zip", fixture)), old = readFileSync(new URL("old-explicit-type1.zip", fixture));
const body = JSON.parse(gunzipSync(readFileSync(new URL("current-body.json.gz", fixture))).toString());
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const omission = JSON.parse(before.document[0].overseasOmissionJson), rich = (text: string) => [{ type: "text", plain_text: text, text: { content: text } }];
const originalDoc = json("original-entry.json"), original = json("original-snapshot.json");
const options: ReturnType<typeof parseBasisArguments> = { docId: "S100WZGB", event: entry.source, original, budgetMs: 60_000, execute: false, expectedPreSha256: undefined };
let sqlite: ReturnType<typeof openActualSnapshot>, db: Database, canonical: string, owner: string | null;
function snake(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/[A-Z]/g, c => "_" + c.toLowerCase()),
    ["submittedAt", "ingestedAt"].includes(key) ? Date.parse(String(value)) / 1000 : value]));
}
function page() {
  return { object: "page", id: omission.archivePageId, archived: false, in_trash: false,
    parent: { type: "database_id", database_id: "3e1d74ff84cd812ebc79f7aff3f2d7ca" },
    properties: { Key: { type: "title", title: rich(entry.doc.docID) }, Metadata: { type: "rich_text", rich_text: rich(JSON.stringify(oldMetadata)) } } };
}
function apply(statements: readonly D1BatchStatement[]) {
  sqlite.exec("BEGIN");
  try { for (const s of statements) sqlite.prepare(s.sql).run(...s.params as never[]); sqlite.exec("COMMIT"); }
  catch (error) { sqlite.exec("ROLLBACK"); throw error; }
}
beforeEach(async () => {
  vi.clearAllMocks(); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); }));
  vi.stubEnv("NOTION_ARCHIVE_PAGE_ID", "3e1d74ff84cd812ebc79f7aff3f2d7ca"); vi.stubEnv("NOTION_YUHO_TEXT_DB_ID", "3f9d74ff84cd8129948cef7952f9cac9");
  canonical = realpathSync(mkdtempSync(join(tmpdir(), "edinet-basis-3776-")));
  const snapshot = { core_stocks: [json("core-stock.json")], yuho_documents: before.document.map(snake), yuho_order_facts: before.orders.map(snake),
    yuho_overseas_facts: before.overseas.map(snake), yuho_text_sections: before.text.map(snake), p_yuho_growth: [] } as Snapshot;
  sqlite = openActualSnapshot(fileURLToPath(new URL("../../..", import.meta.url)), snapshot);
  sqlite.exec("CREATE TABLE jss_notion_pages(code text,db text,page_id text,PRIMARY KEY(code,db))");
  sqlite.prepare("INSERT INTO jss_notion_pages VALUES (?,'stock_master_by_edinet',?)").run("E05494", "3776");
  db = drizzle(async (query, params, method) => {
    const statement = sqlite.prepare(query), names = statement.columns().map(c => c.name);
    const rows = (statement.all(...params as never[]) as Record<string, unknown>[]).map(row => names.map(name => row[name]));
    return { rows: method === "get" ? rows[0] : rows };
  }) as unknown as Database;
  io.db.mockReturnValue(db);
  await recordReportedChanges(db, { metadata: { status: "200", message: "OK", resultset: { count: 1 } }, results: [entry.doc] }, entry.source, () => false);
  sqlite.prepare("INSERT INTO yuho_edinet_catchup_progress(scope,date,snapshot,completed_ids,pending_ids,finished,sealed,in_flight_doc_id,revision,updated_at) VALUES ('main',?,?,?, ?,0,0,NULL,10,0)")
    .run(entry.source.date, JSON.stringify(entry.source), "[]", JSON.stringify([{ docId: entry.doc.docID, reason: "reported_document_state" }]));
  io.list.mockImplementation(async source => ({ metadata: { status: "200", message: "OK", resultset: { count: 1 } }, results: [source.date === original.date ? originalDoc : entry.doc] }));
  io.typed.mockImplementation(async (_id, type) => { const bytes = type === 5 ? csv : current, custody = metadata.custody.find((c: { type: number }) => c.type === type);
    return { pageId: custody.pageId, bytes, sha256: sha(bytes), metadata: type === 5 ? metadata.type5 : metadata.type1, originalManifest: "known" }; });
  io.body.mockResolvedValue(body); io.page.mockResolvedValue(page());
  io.files.mockResolvedValue([{ name: "S100WZGB_xbrl.zip", kind: "file", url: "offline explicit transport projection" }]); io.download.mockResolvedValue(old);
  io.record.mockResolvedValue({ pageId: entry.source.pageId, outcome: "recorded", fileTooLarge: false, manifestMatch: "written" }); io.verify.mockResolvedValue(undefined);
  io.sender.mockImplementation(async statements => { apply(statements); });
  let state = JSON.stringify({ version: 1, baselineSha256: "1".repeat(64), owner: null, pending: null }) + "\n", etag = 1; owner = null;
  io.store.mockReturnValue({ get: async () => ({ body: state, etag: String(etag) }), put: async (_key: string, next: string, expected: string) => {
    expect(expected).toBe(String(etag)); state = next; etag++; owner = JSON.parse(state).owner?.id ?? null;
  } });
});
afterEach(() => { sqlite.close(); rmSync(canonical, { recursive: true }); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
async function execute() {
  const plan = await runBasisReaccept(options, canonical);
  return runBasisReaccept({ ...options, execute: true, expectedPreSha256: plan.preSha256 }, canonical);
}
it("real3776 changes exactly four derived columns; strict/v1 stays unchanged, every fact/body/clock and observation stays intact", async () => {
  const pre = readSnapshot(sqlite, 2574), observed = sqlite.prepare("SELECT * FROM yuho_edinet_reported_changes").all();
  const oldState = await readInformationEditState(db, "S100WZGB", 2574, () => {});
  const saved = await io.typed("S100WZGB", 1);
  expect(() => verifyInformationEditData(oldState, parseEdinetCsvZip(csv), saved, body)).toThrow("既存status/抽出元");
  const plan = await runBasisReaccept(options, canonical);
  io.files.mockResolvedValue([{ name: "S100WZGB_xbrl.zip", kind: "file", url: "different offline expiring URL control" }]);
  expect((await runBasisReaccept(options, canonical)).preSha256).toBe(plan.preSha256);
  expect(await execute()).toMatchObject({ status: "basis_reaccepted_resolution_pending", financialWrites: 0, textWrites: 0, resolutionWrites: 0 });
  const post = readSnapshot(sqlite, 2574);
  const changed = Object.keys(pre.yuho_documents[0]).filter(key => pre.yuho_documents[0][key] !== post.yuho_documents[0][key]);
  expect(changed.sort()).toEqual(["honbun_file", "overseas_parse_status", "overseas_honbun_file", "overseas_omission_json"].sort());
  expect({ ...post, yuho_documents: pre.yuho_documents }).toEqual(pre);
  expect(sqlite.prepare("SELECT * FROM yuho_edinet_reported_changes").all()).toEqual(observed);
  expect(sqlite.prepare("SELECT * FROM yuho_edinet_reported_resolutions").all()).toEqual([]);
  const state = await readInformationEditState(db, "S100WZGB", 2574, () => {});
  expect(() => verifyInformationEditData(state, parseEdinetCsvZip(csv), saved, body)).not.toThrow();
  expect(JSON.parse(pre.yuho_documents[0].overseas_omission_json as string).archiveManifest).toBe("unknown");
  expect(io.sender).toHaveBeenCalledTimes(1); expect(io.verify).toHaveBeenCalledTimes(2); expect(owner).toBeNull(); expect(fetch).not.toHaveBeenCalled();
}, 15_000);
it.each(["original-flag", "fact", "body", "old-sha", "old-native", "old-parent", "old-state", "old-metadata-sha", "old-metadata-bytes", "typed-manifest", "omission"])("%s discrepancy is rejected before PRE or D1 send", async fault => {
  if (fault === "original-flag") io.list.mockImplementation(async source => ({ results: [source.date === original.date ? { ...originalDoc, docInfoEditStatus: "0" } : entry.doc] }));
  if (fault === "fact") sqlite.prepare("INSERT INTO yuho_order_facts(document_id,stock_id,fiscal_year_end,segment_name,segment_kind,unit_label,pattern) VALUES(621,2574,'2025-12-31','declared negative control','total','円','pattern_a')").run();
  if (fault === "body") io.body.mockResolvedValue(body.slice(1));
  if (fault === "old-sha") io.download.mockResolvedValue(current);
  if (fault === "old-native") { const p = page(); p.properties.Metadata.rich_text = rich(JSON.stringify({ ...oldMetadata, secCode: "69630" })); io.page.mockResolvedValue(p); }
  if (fault === "old-parent") { const p = page(); p.parent.database_id = entry.source.pageId; io.page.mockResolvedValue(p); }
  if (fault === "old-state") { const p = page(); p.archived = true; io.page.mockResolvedValue(p); }
  if (fault === "old-metadata-sha" || fault === "old-metadata-bytes") { const p = page(); p.properties.Metadata.rich_text = rich(JSON.stringify({ ...oldMetadata, [fault === "old-metadata-sha" ? "sourceZIPSHA" : "sourceZIPBytes"]: fault === "old-metadata-sha" ? sha(current) : old.length + 1 })); io.page.mockResolvedValue(p); }
  if (fault === "typed-manifest") io.typed.mockImplementation(async (_id, type) => ({ pageId: entry.source.pageId, bytes: type === 5 ? csv : current, sha256: sha(type === 5 ? csv : current), metadata: type === 5 ? metadata.type5 : metadata.type1, originalManifest: "unknown" }));
  if (fault === "omission") { const value = structuredClone(omission); value.omission.evidence[0].rawBlockSha256 = "0".repeat(64); sqlite.prepare("UPDATE yuho_documents SET overseas_omission_json=? WHERE id=621").run(JSON.stringify(value)); }
  const pre = readSnapshot(sqlite, 2574); await expect(execute()).rejects.toThrow();
  expect(io.sender).not.toHaveBeenCalled(); expect(io.record).not.toHaveBeenCalled(); expect(readSnapshot(sqlite, 2574)).toEqual(pre);
});
it.each(["issuer", "observation", "resolution"])("a concurrent %s change at send rolls back the four-column UPDATE", async fault => {
  io.sender.mockImplementationOnce(async statements => {
    if (fault === "issuer") sqlite.prepare("UPDATE jss_notion_pages SET page_id='6963' WHERE code='E05494'").run();
    if (fault === "observation") sqlite.prepare("UPDATE yuho_edinet_reported_changes SET reported_state='reported_withdrawal' WHERE doc_id='S100WZGB'").run();
    if (fault === "resolution") sqlite.prepare("INSERT INTO yuho_edinet_reported_resolutions(source_page_id,seq_number,source_raw_sha256,observation_json,doc_id,metadata_sha256,proof_json,resolved_at) VALUES(?,?,?,?,?,?,?,0)")
      .run(entry.source.pageId, 79, entry.source.rawSha256, "{}", "S100WZGB", "0".repeat(64), "{}");
    apply(statements);
  });
  const pre = readSnapshot(sqlite, 2574); await expect(execute()).rejects.toThrow(); expect(readSnapshot(sqlite, 2574)).toEqual(pre);
  expect(owner).not.toBeNull(); expect(existsSync(join(canonical, "tmp/edinet-information-edit-basis/S100WZGB/pending.json"))).toBe(true);
});
it("lost D1 ACK preserves owner and canonical latch; another output/cwd cannot resend", async () => {
  io.sender.mockImplementationOnce(async statements => { apply(statements); throw new Error("declared offline lost ACK"); });
  const plan = await runBasisReaccept(options, canonical), executeOptions = { ...options, execute: true, expectedPreSha256: plan.preSha256 };
  await expect(runBasisReaccept(executeOptions, canonical)).rejects.toThrow("lost ACK");
  expect(owner).not.toBeNull(); expect(io.sender).toHaveBeenCalledTimes(1);
  const reads = io.list.mock.calls.length; await expect(runBasisReaccept(executeOptions, canonical)).rejects.toThrow("no_reentry");
  expect(io.sender).toHaveBeenCalledTimes(1); expect(io.list).toHaveBeenCalledTimes(reads);
});
