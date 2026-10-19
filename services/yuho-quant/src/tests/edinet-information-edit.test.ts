/** Real saved6963 CSV/XBRL/facts/37texts. Information-edit flags/list archive ACKs are declared protocol controls. */
import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { openActualSnapshot, readSnapshot } from "../../data-scripts/lib/saved-overseas-atomic.js";
import type { Database } from "../db/client.js";
import type { D1BatchStatement } from "../../../../src/shared/db/d1-http-client.js";
import { edinetDocSchema, edinetListResponseSchema } from "../services/edinet/types.js";
import { recordReportedChanges, assertReportedDocumentUsable } from "../services/edinet/reported-changes.js";
import { requalifyInformationEdit } from "../services/edinet/information-edit.js";
import { parseEdinetCsvZip } from "../services/edinet/csv.js";
import { parseOrderData, RX_ORDER_KEYWORD } from "../services/edinet/order-parser.js";
import { RX_OVERSEAS_KEYWORD } from "../services/overseas-parser.js";
import { extractTextSections } from "../services/edinet/text-sections.js";
import { NotionUnknownResultError } from "../../../../src/shared/notion-archive/client.js";

const io = vi.hoisted(() => ({ original: vi.fn(), savedList: vi.fn(), saved: vi.fn(), text: vi.fn() }));
vi.mock("../services/edinet/list-snapshot.js", async original => ({
  ...await original<typeof import("../services/edinet/list-snapshot.js")>(),
  captureListSnapshot: io.original, readListSnapshot: io.savedList,
}));
vi.mock("../services/edinet/archive.js", async original => ({
  ...await original<typeof import("../services/edinet/archive.js")>(), readSavedEdinetZip: io.saved,
}));
vi.mock("../services/text-backup.js", async original => ({
  ...await original<typeof import("../services/text-backup.js")>(), readVerifiedDocText: io.text,
}));
vi.mock("../services/edinet/csv.js", async original => {
  const actual = await original<typeof import("../services/edinet/csv.js")>();
  return { ...actual, parseEdinetCsvZip: vi.fn(actual.parseEdinetCsvZip) };
});
const fixture = new URL("./fixtures/ingest-csv-reingest-6963/", import.meta.url);
const saved = JSON.parse(readFileSync(new URL("saved-business.json", fixture), "utf8"));
const texts = JSON.parse(gunzipSync(readFileSync(new URL("sections.json.gz", fixture))).toString("utf8"));
const d = saved.d1.yuho_documents[0];
const annual = edinetDocSchema.parse({ ...saved.sourceMetadata, seqNumber: 79, JCN: null,
  ordinanceCode: "010", formCode: "030000", xbrlFlag: "1", csvFlag: "1", withdrawalStatus: "0",
  docInfoEditStatus: "1", disclosureStatus: "0", parentDocID: null, opeDateTime: "2026-10-19 15:11", legalStatus: "1" });
function source(doc = annual, pageId = saved.item.archivePageId) {
  const list = edinetListResponseSchema.parse({ metadata: { status: "200", message: "OK", resultset: { count: 1 } }, results: [doc] });
  const raw = Buffer.from(JSON.stringify(list)), hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  return { list, snapshot: { date: "2026-10-19", pageId, filename: "edinet-list-2026-10-19.json.gz",
    gzipSha256: hash(gzipSync(raw)), rawSha256: hash(raw), rawBytes: raw.length,
    httpStatus: 200, qualified: true, fetchedAt: "2026-10-19T10:19:15.596Z" } };
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("NOTION_YUHO_TEXT_DB_ID", "3f9d74ff84cd8129948cef7952f9cac9");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); }));
  const original = source({ ...annual, docInfoEditStatus: "2", opeDateTime: null });
  original.snapshot.date = annual.submitDateTime!.slice(0, 10);
  original.snapshot.filename = `edinet-list-${original.snapshot.date}.json.gz`;
  io.original.mockResolvedValue(original);
  io.savedList.mockResolvedValue(original.list);
  io.text.mockResolvedValue(texts);
  io.saved.mockImplementation(async (_id: string, type: 1 | 5) => {
    const bytes = readFileSync(new URL(type === 1 ? "S100YF41.zip" : "S100YF41-csv.zip", fixture));
    return { pageId: saved.item.archivePageId, bytes, sha256: createHash("sha256").update(bytes).digest("hex"),
      metadata: { ...saved.sourceMetadata, edinetDocType: type }, originalManifest: "unknown" };
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
async function open(currentParserState = true) {
  const sqlite = openActualSnapshot(process.cwd(), saved.d1);
  // Explicit protocol control: a previously stored current-parser result. The immutable actual
  // PRE has old NULL consolidation flags and must HOLD (separate test below), never silent normalization.
  if (currentParserState) for (const fact of parseOrderData(readFileSync(new URL("S100YF41.zip", fixture)), saved.item.periodEnd).facts)
    sqlite.prepare("UPDATE yuho_order_facts SET is_consolidated=? WHERE document_id=? AND fiscal_year_end=? AND segment_name=?")
      .run(fact.isConsolidated === null ? null : Number(fact.isConsolidated), d.id, fact.fiscalYearEnd, fact.segmentName);
  sqlite.exec("CREATE TABLE jss_notion_pages(code text,db text,page_id text,PRIMARY KEY(code,db))");
  sqlite.prepare("INSERT INTO jss_notion_pages VALUES (?,'stock_master_by_edinet',?)").run(saved.item.edinetCode, saved.item.stockCode);
  const db = drizzle(async (query, params, method) => {
    const statement = sqlite.prepare(query), names = statement.columns().map(c => c.name);
    if (method === "run") { statement.run(...params as never[]); return { rows: [] }; }
    const rows = (statement.all(...params as never[]) as Record<string, unknown>[]).map(r => names.map(n => r[n]));
    return { rows: method === "get" ? rows[0] : rows };
  }) as unknown as Database;
  const capture = source(); await recordReportedChanges(db, capture.list, capture.snapshot, () => false);
  const apply = (batch: D1BatchStatement[]) => {
    sqlite.exec("BEGIN");
    try { for (const statement of batch) sqlite.prepare(statement.sql).run(...statement.params as never[]); sqlite.exec("COMMIT"); }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  };
  const sender = vi.fn(async (batch: D1BatchStatement[]) => { apply(batch); return []; });
  const args = () => ({ doc: annual, source: capture.snapshot, stockId: saved.item.stockId, stockCode: saved.item.stockCode,
    shouldStop: () => false, d1HttpBatch: sender as never });
  return { sqlite, db, capture, apply, sender, args };
}

it("keeps HOLD through real read-only parser checks; appends only completion, and repeated event capture reparses zero times", async () => {
  const x = await open();
  try {
    const before = readSnapshot(x.sqlite, saved.item.stockId), originalRows = x.sqlite.prepare("SELECT * FROM yuho_edinet_reported_changes").all();
    await expect(assertReportedDocumentUsable(x.db, annual.docID)).rejects.toThrow();
    x.sender.mockImplementationOnce(async batch => { await expect(assertReportedDocumentUsable(x.db, annual.docID)).rejects.toThrow(); x.apply(batch); return []; });
    expect(await requalifyInformationEdit(x.db, x.args())).toEqual({ status: "resolved", observations: 1, reused: false });
    await expect(assertReportedDocumentUsable(x.db, annual.docID)).resolves.toBeUndefined();
    expect(readSnapshot(x.sqlite, saved.item.stockId)).toEqual(before);
    expect(x.sqlite.prepare("SELECT * FROM yuho_edinet_reported_changes").all()).toEqual(originalRows);
    expect(parseEdinetCsvZip).toHaveBeenCalledTimes(1);
    const next = source({ ...annual, seqNumber: 80 }, d.notion_doc_page_id);
    await recordReportedChanges(x.db, next.list, next.snapshot, () => false);
    expect(await requalifyInformationEdit(x.db, { ...x.args(), doc: next.list.results[0], source: next.snapshot })).toEqual({ status: "resolved", observations: 1, reused: true });
    expect(parseEdinetCsvZip).toHaveBeenCalledTimes(1);
    expect(x.sqlite.prepare("SELECT count(*) n FROM yuho_edinet_reported_resolutions").get()).toEqual({ n: 2 });
    expect(x.sender.mock.calls.every(([batch]) => batch.length < 1000 && batch.every(s => s.params.length <= 100))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  } finally { x.sqlite.close(); }
});

it.each(["reported_withdrawal", "reported_status_unqualified"])("a new %s between comparison and CAS rolls back completion and keeps old data", async state => {
  const x = await open();
  try {
    const before = readSnapshot(x.sqlite, saved.item.stockId);
    x.sender.mockImplementationOnce(async batch => {
      x.sqlite.prepare("INSERT INTO yuho_edinet_reported_changes(source_page_id,seq_number,source_raw_sha256,doc_id,reported_state,observation_json) VALUES ('declared-concurrent-source',1,?,?,?,'{}')")
        .run("0".repeat(64), annual.docID, state);
      x.apply(batch); return [];
    });
    await expect(requalifyInformationEdit(x.db, x.args())).rejects.toThrow();
    expect(x.sqlite.prepare("SELECT count(*) n FROM yuho_edinet_reported_resolutions").get()).toEqual({ n: 0 });
    expect(readSnapshot(x.sqlite, saved.item.stockId)).toEqual(before);
    await expect(assertReportedDocumentUsable(x.db, annual.docID)).rejects.toThrow();
  } finally { x.sqlite.close(); }
});

it("a lost completion ACK remains unknown with the existing inFlight reservation; no resend", async () => {
  const x = await open();
  try {
    x.sqlite.prepare("INSERT INTO yuho_edinet_catchup_progress(scope,date,in_flight_doc_id) VALUES ('main','2026-10-19',?)").run(annual.docID);
    x.sender.mockImplementationOnce(async batch => { x.apply(batch); throw new Error("declared lost ACK"); });
    await expect(requalifyInformationEdit(x.db, x.args())).rejects.toThrow("declared lost ACK");
    expect(x.sender).toHaveBeenCalledTimes(1);
    expect(x.sqlite.prepare("SELECT in_flight_doc_id FROM yuho_edinet_catchup_progress").get()).toEqual({ in_flight_doc_id: annual.docID });
    expect(x.sqlite.prepare("SELECT count(*) n FROM yuho_edinet_reported_resolutions").get()).toEqual({ n: 1 });
  } finally { x.sqlite.close(); }
});

it.each([{ withdrawalStatus: "1" }, { disclosureStatus: "3" }, { periodEnd: "2025-03-31" }, { formCode: "030001" }])("unsupported identity/status/form transition stays HOLD before business write: %j", async fault => {
  const x = await open();
  try {
    expect((await requalifyInformationEdit(x.db, { ...x.args(), doc: { ...annual, ...fault } })).status).toBe("held");
    expect(x.sender).not.toHaveBeenCalled(); expect(parseEdinetCsvZip).not.toHaveBeenCalled();
  } finally { x.sqlite.close(); }
});

it("a changed existing financial value is not overwritten or resolved", async () => {
  const x = await open();
  try {
    x.sqlite.exec("UPDATE yuho_order_facts SET orders_received_yen=orders_received_yen+1 WHERE id=(SELECT min(id) FROM yuho_order_facts)");
    const before = readSnapshot(x.sqlite, saved.item.stockId);
    expect((await requalifyInformationEdit(x.db, x.args())).status).toBe("held");
    expect(x.sender).not.toHaveBeenCalled(); expect(readSnapshot(x.sqlite, saved.item.stockId)).toEqual(before);
  } finally { x.sqlite.close(); }
});

it("the immutable actual old NULL-consolidation PRE remains HOLD under the newer normal parser", async () => {
  const x = await open(false);
  try {
    const before = readSnapshot(x.sqlite, saved.item.stockId);
    expect(await requalifyInformationEdit(x.db, x.args())).toMatchObject({ status: "held", reason: "受注全factsが一致しません（自動置換なし）" });
    expect(x.sender).not.toHaveBeenCalled(); expect(readSnapshot(x.sqlite, saved.item.stockId)).toEqual(before);
  } finally { x.sqlite.close(); }
});

it("a declared no-keyword CSV projection with zero financial facts qualifies without type1, and reuse reparses zero times", async () => {
  const x = await open();
  try {
    // Finite protocol projection from real CSV rows, not a claim that the original6963 has no overseas/orders.
    const native = await vi.importActual<typeof import("../services/edinet/csv.js")>("../services/edinet/csv.js");
    const rows = native.parseEdinetCsvZip(readFileSync(new URL("S100YF41-csv.zip", fixture))).filter(r =>
      !RX_ORDER_KEYWORD.test(r.itemName) && !RX_ORDER_KEYWORD.test(r.value) && !RX_OVERSEAS_KEYWORD.test(r.itemName) && !RX_OVERSEAS_KEYWORD.test(r.value));
    const sections = extractTextSections(rows); expect(sections.length).toBeGreaterThan(0);
    x.sqlite.exec("DELETE FROM yuho_order_facts; DELETE FROM yuho_overseas_facts; DELETE FROM yuho_text_sections; UPDATE yuho_documents SET parse_status='no_order_table',honbun_file=NULL,overseas_parse_status='no_overseas_table',overseas_honbun_file=NULL,overseas_omission_json=NULL");
    for (const s of sections) x.sqlite.prepare("INSERT INTO yuho_text_sections(document_id,stock_id,fiscal_year_end,section_key,element_id,item_name,context_id,char_count) VALUES (?,?,?,?,?,?,?,?)")
      .run(d.id, saved.item.stockId, d.period_end, s.sectionKey, s.elementId, s.itemName, s.contextId, s.charCount);
    vi.mocked(parseEdinetCsvZip).mockReturnValueOnce(rows);
    io.text.mockResolvedValue(sections.map(s => ({ sectionKey: s.sectionKey, itemName: s.itemName, text: s.text })));
    const readSaved = io.saved.getMockImplementation()!;
    io.saved.mockImplementation(async (id, type) => { if (type === 1) throw new Error("type1 must not be read"); return readSaved(id, type); });
    expect(await requalifyInformationEdit(x.db, x.args())).toMatchObject({ status: "resolved", reused: false });
    const proof = JSON.parse((x.sqlite.prepare("SELECT proof_json FROM yuho_edinet_reported_resolutions").get() as { proof_json: string }).proof_json);
    expect(proof.requiresXbrl).toBe(false); expect(proof.zips).toHaveLength(1);
    const next = source({ ...annual, seqNumber: 80 }, d.notion_doc_page_id);
    await recordReportedChanges(x.db, next.list, next.snapshot, () => false);
    expect(await requalifyInformationEdit(x.db, { ...x.args(), doc: next.list.results[0], source: next.snapshot })).toMatchObject({ status: "resolved", reused: true });
    expect(parseEdinetCsvZip).toHaveBeenCalledTimes(1);
    expect(io.saved.mock.calls.every(([, type]) => type === 5)).toBe(true);
  } finally { x.sqlite.close(); }
});

it("pre-send budget/read failure returns a safe HOLD, while an unclosed original archive stays unknown", async () => {
  const x = await open();
  try {
    expect(await requalifyInformationEdit(x.db, { ...x.args(), shouldStop: () => true })).toEqual({ status: "held",
      reason: "完了送信前の読取または処理予算が未成立です（次の通常処理で再確認）" });
    io.text.mockRejectedValueOnce(new Error("offline read failure detail must not reach log"));
    const read = await requalifyInformationEdit(x.db, x.args());
    expect(read).toEqual({ status: "held", reason: "完了送信前の読取または処理予算が未成立です（次の通常処理で再確認）" });
    expect(x.sender).not.toHaveBeenCalled();
    io.original.mockRejectedValueOnce(new Error("offline archive closure incomplete"));
    await expect(requalifyInformationEdit(x.db, x.args())).rejects.toBeInstanceOf(NotionUnknownResultError);
    expect(x.sender).not.toHaveBeenCalled();
    expect(x.sqlite.prepare("SELECT count(*) n FROM yuho_edinet_reported_resolutions").get()).toEqual({ n: 0 });
  } finally { x.sqlite.close(); }
});

it("only the physically verified original edit2 observation resolves with its event, then its normal revisit needs no parser", async () => {
  const x = await open();
  try {
    const original = source({ ...annual, seqNumber: 1, docInfoEditStatus: "2", opeDateTime: null }, d.notion_doc_page_id);
    original.snapshot.date = annual.submitDateTime!.slice(0, 10);
    original.snapshot.filename = `edinet-list-${original.snapshot.date}.json.gz`;
    await recordReportedChanges(x.db, original.list, original.snapshot, () => false);
    x.sqlite.prepare("INSERT INTO yuho_edinet_catchup_progress(scope,date,snapshot) VALUES ('main',?,?)")
      .run(original.snapshot.date, JSON.stringify(original.snapshot));
    io.savedList.mockResolvedValue(original.list);
    const before = x.sqlite.prepare("SELECT * FROM yuho_edinet_reported_changes ORDER BY source_page_id,seq_number").all();
    expect(await requalifyInformationEdit(x.db, { ...x.args(), doc: original.list.results[0], source: original.snapshot })).toMatchObject({ status: "held" });
    expect(x.sender).not.toHaveBeenCalled();
    expect(await requalifyInformationEdit(x.db, x.args())).toEqual({ status: "resolved", observations: 2, reused: false });
    await expect(assertReportedDocumentUsable(x.db, annual.docID)).resolves.toBeUndefined();
    expect(x.sqlite.prepare("SELECT * FROM yuho_edinet_reported_changes ORDER BY source_page_id,seq_number").all()).toEqual(before);
    expect(await requalifyInformationEdit(x.db, { ...x.args(), doc: original.list.results[0], source: original.snapshot })).toEqual({ status: "resolved", observations: 0, reused: true });
    expect(parseEdinetCsvZip).toHaveBeenCalledTimes(1); expect(io.original).not.toHaveBeenCalled();
    // A different archived snapshot's status2 is not covered by the proof just accepted.
    const unrelated = { ...original.snapshot, pageId: "3e1d74ff84cd81aba727edcc78c17285" };
    await recordReportedChanges(x.db, original.list, unrelated, () => false);
    expect((await requalifyInformationEdit(x.db, x.args())).status).toBe("held");
    expect(x.sender).toHaveBeenCalledTimes(1);
  } finally { x.sqlite.close(); }
});
