/** Real 6963 CSV/D1/body. Master-page envelopes are explicit offline protocol controls. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SupplementRow } from "../../../../src/shared/notion-archive/stock-supplement.js";
import { TEXT_SECTIONS } from "../services/edinet/text-sections.js";
import { readQualifiedCompanyNameRefresh, qualifyBiztagArchiveSource, BiztagTextQualificationError, type LatestDoc } from "./source.js";
import { mechanicalTextInput } from "./mechanical-publishing.js";
import * as csv from "../services/edinet/csv.js";
import * as textSections from "../services/edinet/text-sections.js";

const io = vi.hoisted(() => ({ archive: vi.fn(), body: vi.fn(), master: vi.fn() }));
vi.mock("../services/edinet/archive.js", () => ({ readSavedEdinetZip: io.archive }));
vi.mock("../services/text-backup.js", () => ({ readVerifiedDocText: io.body }));
vi.mock("../../../../src/shared/notion-archive/client.js", async original => ({
  ...await original<typeof import("../../../../src/shared/notion-archive/client.js")>(), notionRequest: io.master,
}));
const fixture = new URL("../tests/fixtures/ingest-csv-reingest-6963/", import.meta.url);
const saved = JSON.parse(readFileSync(new URL("saved-business.json", fixture), "utf8"));
const raw = saved.d1.yuho_documents[0];
const document = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
  ["submitted_at", "ingested_at"].includes(key) ? new Date(Number(value) * 1000) : value]));
const bytes = readFileSync(new URL("S100YF41-csv.zip", fixture));
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
// Manifest, relation and current-page liveness are controls; original bytes/native metadata are the saved fixture.
const source = { pageId: saved.item.archivePageId, bytes, sha256: sha(bytes), metadata: { ...saved.sourceMetadata, edinetDocType: 5 }, originalManifest: "known" as const };
const latest: LatestDoc = { stockCode: saved.item.stockCode, companyName: saved.sourceMetadata.filerName, sector33: null,
  doc: { docId: String(document.docId), docTypeCode: "120", periodEnd: String(document.periodEnd), submittedAt: (document.submittedAt as Date).toISOString(),
    notionDocPageId: String(document.notionDocPageId), textParseStatus: "ok" } };
const parsed = qualifyBiztagArchiveSource(latest, document as Parameters<typeof qualifyBiztagArchiveSource>[1], source);
const body = JSON.parse(gunzipSync(readFileSync(new URL("sections.json.gz", fixture))).toString());
const masterId = "00000000-0000-4000-8000-000000000001", masterDb = "00000000-0000-4000-8000-000000000002";
const texts = Object.fromEntries(TEXT_SECTIONS.map(section => [section.title, parsed.sections.find(value => value.sectionKey === section.key)?.text ?? null]));
const receipt = { docId: document.docId, textPageId: document.notionDocPageId,
  textsSha256: sha(JSON.stringify(TEXT_SECTIONS.map(section => [section.title, texts[section.title]]))) };
const row = (): SupplementRow => ({ pageId: saved.item.archivePageId, stockCode: latest.stockCode, companyName: latest.companyName,
  sector33: null, docId: latest.doc!.docId, docType: "有報", periodEnd: latest.doc!.periodEnd, submittedAt: latest.doc!.submittedAt,
  textStatus: "取得済", tagStatus: null, tagDoc: null, vocabVersion: null, judgedAt: null, candidateCount: null, judgeInput: null,
  textSyncReceipt: JSON.stringify(receipt), attempts: null, nextRetryAt: null, error: null, upstream: [], downstream: [], distribution: [], themes: [],
  uncertain: null, evidenceText: null, masterLinked: true, masterPageIds: [masterId], texts: Object.fromEntries(Object.entries(texts).map(([key, value]) => [key, value ?? ""])) });
let sqlite: DatabaseSync, sqls: string[];
function db() {
  return drizzle(async (sql, params) => { sqls.push(sql); return { rows: sqlite.prepare(sql).all(...params as (string | number | null)[]).map(Object.values) }; });
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); }));
  vi.stubEnv("NOTION_DB_STOCK_MASTER", masterDb); vi.stubEnv("NOTION_YUHO_TEXT_DB_ID", masterDb);
  sqlite = new DatabaseSync(":memory:"); sqls = [];
  sqlite.exec(readFileSync(new URL("../../../../drizzle/d1/0032_edinet_reported_changes.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../../../drizzle/d1/0034_edinet_reported_resolutions.sql", import.meta.url), "utf8"));
  sqlite.exec("CREATE TABLE core_stocks(id INTEGER,code TEXT,name TEXT,sector33 TEXT,is_active INTEGER,instrument_type TEXT); CREATE TABLE yuho_documents(id INTEGER,stock_id INTEGER,doc_id TEXT,doc_type_code TEXT,edinet_code TEXT,filer_name TEXT,period_start TEXT,period_end TEXT,submitted_at INTEGER,notion_doc_page_id TEXT,text_parse_status TEXT);");
  sqlite.prepare("INSERT INTO core_stocks VALUES(?,?,?,NULL,1,'equity')").run(raw.stock_id, latest.stockCode, latest.companyName);
  sqlite.prepare("INSERT INTO yuho_documents VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(...["id","stock_id","doc_id","doc_type_code","edinet_code","filer_name","period_start","period_end","submitted_at","notion_doc_page_id","text_parse_status"].map(key => raw[key]));
  io.archive.mockResolvedValue(source); io.body.mockResolvedValue(body);
  io.master.mockResolvedValue({ object: "page", id: masterId, archived: false, in_trash: false, parent: { type: "database_id", database_id: masterDb },
    properties: { 銘柄コード: { type: "rich_text", rich_text: [{ type: "text", plain_text: latest.stockCode, text: { content: latest.stockCode } }] } } });
});
afterEach(() => { sqlite.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("qualifies the real saved issuer/native/body with one exact canonical relation and bounded issuer SQL", async () => {
  const before = sha(JSON.stringify(row()));
  const result = await readQualifiedCompanyNameRefresh(db(), latest, row(), masterId);
  expect(sha(JSON.stringify(result))).toBe(sha(JSON.stringify(body)));
  expect(sha(JSON.stringify(row()))).toBe(before);
  expect(io.archive).toHaveBeenCalledExactlyOnceWith(latest.doc!.docId, 5);
  expect(sqls).toHaveLength(3);
  expect(sqls[0].includes('"core_stocks"."code" = ?') && sqls[0].includes("limit ?"), "old/current docs use one bounded issuer query").toBe(true);
  expect(sqls.slice(1).every(sql => sql.includes("json_each(")), "latest recheck keeps its existing code-first scope").toBe(true);
  expect(sqls.every(sql => sql.includes('"is_active"') && sql.includes('"instrument_type"'))).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
it("shared audit/native qualification preserves the existing empty-pointer rejection", () => {
  expect(() => qualifyBiztagArchiveSource({ ...latest, doc: { ...latest.doc!, notionDocPageId: "" } },
    { ...document, notionDocPageId: "" } as Parameters<typeof qualifyBiztagArchiveSource>[1], source)).toThrow("latest_body_unqualified");
});

it.each(["multiple", "different", "missing"])("%s relation cannot authorize a name write", async fault => {
  const changed = row(); changed.masterPageIds = fault === "multiple" ? [masterId, masterId] : fault === "different" ? [masterDb] : undefined;
  await expect(readQualifiedCompanyNameRefresh(db(), latest, changed, masterId)).rejects.toBeInstanceOf(BiztagTextQualificationError);
  expect(io.archive).not.toHaveBeenCalled(); expect(sqls).toHaveLength(0);
});
it.each(["archived", "parent", "code", "incomplete"])("invalid canonical master %s stops before issuer originals", async fault => {
  const changed = await io.master(); io.master.mockClear();
  if (fault === "archived") changed.archived = true;
  if (fault === "parent") changed.parent.database_id = masterId;
  if (fault === "code") changed.properties.銘柄コード.rich_text[0].plain_text = "wrong";
  if (fault === "incomplete") changed.properties.銘柄コード.has_more = true;
  io.master.mockResolvedValue(changed);
  await expect(readQualifiedCompanyNameRefresh(db(), latest, row(), masterId)).rejects.toBeInstanceOf(BiztagTextQualificationError);
  expect(io.archive).not.toHaveBeenCalled();
});
it.each(["edinetCode", "secCode", "filerName", "docID", "docTypeCode", "periodStart", "periodEnd", "submitDateTime"])("different source %s rejects before body/write", async field => {
  io.archive.mockResolvedValue({ ...source, metadata: { ...source.metadata, [field]: null } });
  await expect(readQualifiedCompanyNameRefresh(db(), latest, row(), masterId)).rejects.toBeInstanceOf(BiztagTextQualificationError);
  expect(io.body).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
it.each(["doc", "period", "clock", "receipt", "body", "manifest"])("unproved old %s cannot be treated as a display-only change", async fault => {
  const changed = row();
  if (fault === "doc") changed.docId = null;
  if (fault === "period") changed.periodEnd = null;
  if (fault === "clock") changed.submittedAt = null;
  if (fault === "receipt") changed.textSyncReceipt = null;
  if (fault === "body") changed.texts["事業の内容"] = "";
  if (fault === "manifest") io.archive.mockResolvedValue({ ...source, originalManifest: "unknown" });
  await expect(readQualifiedCompanyNameRefresh(db(), latest, changed, masterId)).rejects.toBeInstanceOf(BiztagTextQualificationError);
});
it("a different latest document or D1 issuer cannot adopt the old row's name/body", async () => {
  await expect(readQualifiedCompanyNameRefresh(db(), { ...latest, doc: { ...latest.doc!, docId: "S100WZGB" } }, row(), masterId))
    .rejects.toBeInstanceOf(BiztagTextQualificationError);
  expect(io.archive).not.toHaveBeenCalled();
  sqlite.prepare("UPDATE yuho_documents SET edinet_code=?").run("E05494");
  await expect(readQualifiedCompanyNameRefresh(db(), latest, row(), masterId)).rejects.toBeInstanceOf(BiztagTextQualificationError);
  expect(io.body).not.toHaveBeenCalled();
});
it("saved-source read failure and same-length body drift never reach a name write", async () => {
  io.archive.mockRejectedValueOnce(new Error("declared archived-source read fault"));
  await expect(readQualifiedCompanyNameRefresh(db(), latest, row(), masterId)).rejects.toBeInstanceOf(BiztagTextQualificationError);
  expect(io.body).not.toHaveBeenCalled();
  io.body.mockResolvedValueOnce(body.map((section: { text: string }, index: number) => index === 0
    ? { ...section, text: section.text.replace(/./u, "異") } : section));
  await expect(readQualifiedCompanyNameRefresh(db(), latest, row(), masterId)).rejects.toBeInstanceOf(BiztagTextQualificationError);
  expect(fetch).not.toHaveBeenCalled();
});
it("a separate old document must independently qualify its native identity/body before adopting the current display name", async () => {
  // An explicit old-document protocol control reuses the real 6963 CSV/body; it is not a claimed historical filing.
  const oldId = "S000OLD1", oldPointer = "00000000-0000-4000-8000-000000000003", oldClock = Number(raw.submitted_at) - 60;
  const insert = sqlite.prepare("INSERT INTO yuho_documents VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  insert.run(Number(raw.id) + 1, raw.stock_id, oldId, raw.doc_type_code, raw.edinet_code, raw.filer_name, raw.period_start,
    raw.period_end, oldClock, oldPointer, "ok");
  const oldRow = { ...row(), docId: oldId, submittedAt: new Date(oldClock * 1000).toISOString(),
    textSyncReceipt: JSON.stringify({ ...receipt, docId: oldId, textPageId: oldPointer }) };
  const nativeClock = (value: number) => new Date(value * 1000).toISOString().slice(0, 16).replace("T", " ");
  io.archive.mockImplementation(async (docId: string) => docId === oldId
    ? { ...source, metadata: { ...source.metadata, docID: oldId, submitDateTime: nativeClock(oldClock) } } : source);
  expect(sha(JSON.stringify(await readQualifiedCompanyNameRefresh(db(), latest, oldRow, masterId)))).toBe(sha(JSON.stringify(body)));
  expect(io.archive.mock.calls.map(call => call[0]).sort()).toEqual([oldId, latest.doc!.docId].sort());
  expect(new Set(io.body.mock.calls.map(call => call[0].d1DocumentId)).size).toBe(2);
  io.archive.mockClear(); io.body.mockClear();
  sqlite.prepare("UPDATE yuho_documents SET edinet_code=? WHERE doc_id=?").run("E05494", oldId);
  await expect(readQualifiedCompanyNameRefresh(db(), latest, oldRow, masterId)).rejects.toBeInstanceOf(BiztagTextQualificationError);
  expect(io.archive).not.toHaveBeenCalled();
});
it.each(["company", "sector", "period", "clock", "stock", "duplicate"])("D1 %s drift cannot authorize display-name refresh", async fault => {
  if (fault === "company") sqlite.prepare("UPDATE core_stocks SET name=?").run("declared mismatch control");
  if (fault === "sector") sqlite.prepare("UPDATE core_stocks SET sector33=?").run("declared mismatch control");
  if (fault === "period") sqlite.prepare("UPDATE yuho_documents SET period_end=NULL").run();
  if (fault === "clock") sqlite.prepare("UPDATE yuho_documents SET submitted_at=submitted_at+60").run();
  if (fault === "stock") sqlite.prepare("UPDATE yuho_documents SET stock_id=stock_id+1").run();
  if (fault === "duplicate") sqlite.exec("INSERT INTO yuho_documents SELECT * FROM yuho_documents");
  await expect(readQualifiedCompanyNameRefresh(db(), latest, row(), masterId)).rejects.toBeInstanceOf(BiztagTextQualificationError);
  expect(io.body).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

// Private original paragraphs stay outside Git. Physical reader/master-page envelopes are replay controls,
// not a new live-source or current master qualification; the manifest records those limits explicitly.
const privateCase = resolve("tmp/supplement-qualified-name-refresh-proof-v1/CASE2683.private.json");
it.runIf(existsSync(privateCase))("replays actual2683 old/new names, native identity and legacy receipt; only the display-name input changes", async () => {
  const manifest = JSON.parse(readFileSync(privateCase, "utf8"));
  const read = (key: string) => { const input = manifest.inputs[key], bytes = readFileSync(input.path); expect(sha(bytes), "private input SHA").toBe(input.sha256); return JSON.parse(bytes.toString()); };
  const measured = read("metadata"), lineage = read("lineage"), audit = read("source").results.find((value: { stockCode: string }) => value.stockCode === "2683");
  const physical = read("physical").reads.find((value: { type: number }) => value.type === 5), current = measured.latest;
  const actualLatest: LatestDoc = { stockCode: current.stock_code, companyName: current.company_name, sector33: current.sector33,
    doc: { docId: current.doc_id, docTypeCode: current.doc_type_code, periodEnd: current.period_end,
      submittedAt: current.submitted_at_iso, notionDocPageId: current.notion_doc_page_id, textParseStatus: current.text_parse_status } };
  const actualRow: SupplementRow = { ...row(), ...measured.row, pageId: audit.supplementPageId,
    textSyncReceipt: lineage.textSyncReceipt || null, judgeInput: lineage.judgeInput, masterPageIds: lineage.masterPageIds,
    texts: Object.fromEntries(audit.cells.map((value: { title: string; currentText: string | null }) => [value.title, value.currentText ?? ""])) };
  sqlite.exec("DELETE FROM core_stocks; DELETE FROM yuho_documents");
  sqlite.prepare("INSERT INTO core_stocks VALUES(?,?,?,?,1,'equity')").run(current.stock_id,current.stock_code,current.company_name,current.sector33);
  sqlite.prepare("INSERT INTO yuho_documents VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(current.d1_id,current.stock_id,current.doc_id,current.doc_type_code,current.edinet_code,current.filer_name,current.period_start,current.period_end,current.submitted_at,current.notion_doc_page_id,current.text_parse_status);
  io.master.mockResolvedValue({ object: "page", id: lineage.masterPageIds[0], archived: false, in_trash: false, parent: { type: "database_id", database_id: masterDb },
    properties: { 銘柄コード: { type: "rich_text", rich_text: [{ type: "text", plain_text: "2683", text: { content: "2683" } }] } } });
  io.archive.mockResolvedValue({ pageId: physical.pageId, metadata: { ...physical.native8, edinetDocType: physical.type }, originalManifest: physical.originalManifest });
  vi.spyOn(csv, "parseEdinetCsvZip").mockReturnValue([]);
  vi.spyOn(textSections, "extractTextSections").mockReturnValue(audit.source.sections);
  io.body.mockResolvedValue(audit.source.sections);
  const qualified = await readQualifiedCompanyNameRefresh(db(), actualLatest, actualRow, lineage.masterPageIds[0]);
  const next = await mechanicalTextInput(actualLatest, actualRow, qualified, lineage.masterPageIds[0]);
  const oldDisplay = await mechanicalTextInput({ ...actualLatest, companyName: actualRow.companyName }, actualRow, qualified, lineage.masterPageIds[0]);
  expect(Object.keys(next).filter(key => JSON.stringify(next[key as keyof typeof next]) !== JSON.stringify(oldDisplay[key as keyof typeof oldDisplay]))).toEqual(["companyName"]);
  expect(next.companyName).toBe("ＵＯＧｒｏｕｐ"); expect(actualRow.companyName).toBe("魚喜");
  for (const key of ["upstream", "tagStatus", "tagDoc", "judgeInput", "evidenceText"]) expect(next).not.toHaveProperty(key);
  expect(fetch).not.toHaveBeenCalled();
});
