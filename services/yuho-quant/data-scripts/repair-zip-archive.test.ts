/** Actual saved6963 metadata/ZIPs; list receipt and a second document are explicit offline transport projections. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { createD1HttpDb } from "../../../src/shared/db/d1-http-client.js";
import { NotionUnknownResultError } from "../../../src/shared/notion-archive/client.js";
import { recordEdinetZip } from "../src/services/edinet/archive.js";
import { edinetArchiveMetadata } from "../src/services/edinet/archive-metadata.js";
import { readListSnapshot, type ListSnapshot } from "../src/services/edinet/list-snapshot.js";
import { loadEdinetTickerMap } from "../src/services/edinet/identity.js";
import { downloadDocument, EdinetDocumentArchiveError, EdinetDocumentFetchError } from "../src/services/edinet/client.js";
import type { Database } from "../src/db/client.js";
import type { EdinetDoc } from "../src/services/edinet/types.js";
import { openActualSnapshot, readSnapshot, type Snapshot } from "./lib/saved-overseas-atomic.js";
import { repairZipArchives, zipRepairArguments } from "./repair-zip-archive.js";

vi.mock("../../../src/shared/db/d1-http-client.js", async original => ({
  ...await original<typeof import("../../../src/shared/db/d1-http-client.js")>(), createD1HttpDb: vi.fn(),
}));
vi.mock("../src/services/edinet/archive.js", async original => ({
  ...await original<typeof import("../src/services/edinet/archive.js")>(), recordEdinetZip: vi.fn(),
}));
vi.mock("../src/services/edinet/client.js", async original => ({
  ...await original<typeof import("../src/services/edinet/client.js")>(), downloadDocument: vi.fn(),
}));
vi.mock("../src/services/edinet/list-snapshot.js", async original => ({
  ...await original<typeof import("../src/services/edinet/list-snapshot.js")>(), readListSnapshot: vi.fn(),
}));
vi.mock("../src/services/edinet/identity.js", async original => ({
  ...await original<typeof import("../src/services/edinet/identity.js")>(), loadEdinetTickerMap: vi.fn(),
}));
const fixture = new URL("../src/tests/fixtures/ingest-csv-reingest-6963/", import.meta.url);
const saved = JSON.parse(readFileSync(new URL("saved-business.json", fixture), "utf8")) as {
  sourceMetadata: Record<string, unknown>; d1: Snapshot; item: { stockId: number };
};
const csv = readFileSync(new URL("S100YF41-csv.zip", fixture)), xbrl = readFileSync(new URL("S100YF41.zip", fixture));
const native = { ...saved.sourceMetadata, seqNumber: 1, JCN: null, ordinanceCode: "010", formCode: "030000",
  xbrlFlag: "1", csvFlag: "1", withdrawalStatus: "0", docInfoEditStatus: "0", disclosureStatus: "0", parentDocID: null } as EdinetDoc;
const snapshot: ListSnapshot = { date: "2026-06-19", pageId: "3e1d74ff84cd812ebc79f7aff3f2d7ca",
  filename: "edinet-list-2026-06-19.json.gz", gzipSha256: "0".repeat(64), rawSha256: "1".repeat(64),
  rawBytes: 1, httpStatus: 200, qualified: true, fetchedAt: "2026-10-25T00:00:00Z" };
let dir: string, sqlite: ReturnType<typeof openActualSnapshot>, queries: string[];
let options: ReturnType<typeof zipRepairArguments>;
function source(docs: EdinetDoc[]) {
  vi.mocked(readListSnapshot).mockResolvedValue({ metadata: { status: "200", message: "OK", resultset: { count: docs.length } }, results: docs });
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("offline transport only"); }));
  dir = mkdtempSync(join(tmpdir(), "edinet-zip-repair-test-"));
  const path = join(dir, "source-receipt.json"), bytes = JSON.stringify(snapshot);
  writeFileSync(path, bytes, { mode: 0o600 });
  options = zipRepairArguments(["--doc=S100YF41", `--source-snapshot=${path}`,
    `--source-snapshot-sha256=${createHash("sha256").update(bytes).digest("hex")}`]);
  sqlite = openActualSnapshot(fileURLToPath(new URL("../../..", import.meta.url)), saved.d1); queries = [];
  const db = drizzle(async (sql, params, method) => {
    expect(sql).toMatch(/^select\b/i); queries.push(sql); // repair must perform no D1 DML
    const stmt = sqlite.prepare(sql), columns = stmt.columns().map(c => c.name);
    const rows = (stmt.all(...params as never[]) as Record<string, unknown>[]).map(r => columns.map(n => r[n]));
    return { rows: method === "get" ? (rows[0] ?? []) : rows };
  }) as unknown as Database;
  vi.mocked(createD1HttpDb).mockReturnValue(db as ReturnType<typeof createD1HttpDb>);
  vi.mocked(loadEdinetTickerMap).mockResolvedValue(new Map([["E01953", "6963"]]));
  source([native]);
  vi.mocked(downloadDocument).mockImplementation(async (_id, type) => type === 5 ? csv : xbrl);
  vi.mocked(recordEdinetZip).mockResolvedValue({ pageId: snapshot.pageId, outcome: "recorded", fileTooLarge: false, manifestMatch: "written" });
});
afterEach(() => { sqlite.close(); rmSync(dir, { recursive: true }); vi.unstubAllGlobals(); });

it("uses all8 native fields unchanged for each type, without D1 or business changes", async () => {
  const before = readSnapshot(sqlite, saved.item.stockId);
  expect(await repairZipArchives(options)).toEqual({ recorded: 1, skipped_existing: 0, edinet_not_found: 0 });
  expect(readListSnapshot).toHaveBeenCalledExactlyOnceWith(snapshot);
  expect(vi.mocked(recordEdinetZip).mock.calls.map(([args]) => args.type)).toEqual([5, 1]);
  for (const [args] of vi.mocked(recordEdinetZip).mock.calls) {
    expect(args.metadata).toMatchObject({ ...edinetArchiveMetadata(native, "2026-03-31"), sourceListSnapshot: snapshot });
    expect(args.metadata.submitDateTime).toBe("2026-06-19 15:15"); expect(args.force).toBe(false);
  }
  expect(vi.mocked(downloadDocument).mock.calls.map(args => args[1])).toEqual([5, 1]);
  expect(readSnapshot(sqlite, saved.item.stockId)).toEqual(before); expect(queries.length).toBeGreaterThan(0);
  expect(fetch).not.toHaveBeenCalled();
});
it.each(["secCode", "periodStart"] as const)("a missing native %s never comes from existing D1", async key => {
  const missing = { ...native }; delete (missing as Partial<EdinetDoc>)[key]; source([missing]);
  await expect(repairZipArchives(options)).rejects.toThrow("source_identity_mismatch");
  expect(downloadDocument).not.toHaveBeenCalled(); expect(recordEdinetZip).not.toHaveBeenCalled();
});
it.each([
  { edinetCode: "E03365" }, { periodStart: "2025-03-01" }, { periodEnd: "2025-03-31" },
  { submitDateTime: "2026-06-19 15:16" }, { secCode: "26830" }, { docInfoEditStatus: "1" },
])("a declared native mismatch or HOLD stops before any new source: %j", async change => {
  source([{ ...native, ...change }]);
  await expect(repairZipArchives(options)).rejects.toThrow(/source_(identity|submission|state)_/);
  expect(downloadDocument).not.toHaveBeenCalled(); expect(recordEdinetZip).not.toHaveBeenCalled();
});
it("the current reported HOLD is preserved even if an old snapshot had literal0 flags", async () => {
  sqlite.prepare(`INSERT INTO yuho_edinet_reported_changes
    (source_page_id,seq_number,source_raw_sha256,doc_id,reported_state,observation_json)
    VALUES (?,?,?,?,?,?)`).run(snapshot.pageId, 1, snapshot.rawSha256, native.docID, "reported_withdrawal", JSON.stringify({ doc: { ...native, withdrawalStatus: "1" } }));
  await expect(repairZipArchives(options)).rejects.toMatchObject({ name: "ReportedDocumentHoldError" });
  expect(downloadDocument).not.toHaveBeenCalled(); expect(recordEdinetZip).not.toHaveBeenCalled();
});
it.each([{ docs: [] }, { docs: [native, native] }])("absent/ambiguous exact doc never selects a neighbouring metadata row", async ({ docs }) => {
  source(docs);
  await expect(repairZipArchives(options)).rejects.toThrow("snapshot_document_not_unique");
  expect(downloadDocument).not.toHaveBeenCalled(); expect(recordEdinetZip).not.toHaveBeenCalled();
});
it("a corrupted receipt rejects before reading saved source or D1", async () => {
  await expect(repairZipArchives({ ...options, sourceSnapshotSha256: "f".repeat(64) })).rejects.toThrow("snapshot_receipt_sha_mismatch");
  expect(readListSnapshot).not.toHaveBeenCalled(); expect(createD1HttpDb).not.toHaveBeenCalled();
  expect(downloadDocument).not.toHaveBeenCalled();
});
it("preserves native metadata on CSV closure after a known type1 source failure", async () => {
  const failure = new EdinetDocumentFetchError(native.docID, 1, "declared offline source failure");
  vi.mocked(downloadDocument).mockResolvedValueOnce(csv).mockRejectedValueOnce(failure);
  await expect(repairZipArchives(options)).rejects.toBe(failure);
  expect(recordEdinetZip).toHaveBeenCalledTimes(1);
  expect(vi.mocked(recordEdinetZip).mock.calls[0][0].metadata).toMatchObject({ ...edinetArchiveMetadata(native, "2026-03-31"), ingestPhase: "partial-source" });
});
it.each(["type5", "type1", "partial"] as const)("an archive unknown at %s never proceeds to the next document", async phase => {
  // Clone metadata only as a declared two-document transport control, not an actual second filing.
  const second = { ...native, docID: "S100YF42", seqNumber: 2 };
  const row = saved.d1.yuho_documents[0];
  sqlite.prepare("INSERT INTO yuho_documents (stock_id,edinet_code,doc_id,doc_type_code,filer_name,period_start,period_end,submitted_at,parse_status) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(row.stock_id, row.edinet_code, second.docID, row.doc_type_code, row.filer_name, row.period_start, row.period_end, row.submitted_at, row.parse_status);
  source([native, second]);
  const unknown = new NotionUnknownResultError("declared offline unknown ACK");
  if (phase === "type1") vi.mocked(recordEdinetZip).mockResolvedValueOnce({ pageId: snapshot.pageId, outcome: "recorded", fileTooLarge: false, manifestMatch: "written" }).mockRejectedValueOnce(unknown);
  else vi.mocked(recordEdinetZip).mockRejectedValueOnce(unknown);
  if (phase === "partial") vi.mocked(downloadDocument).mockResolvedValueOnce(csv).mockRejectedValueOnce(new EdinetDocumentFetchError(native.docID, 1, "declared source failure"));
  const error = await repairZipArchives({ ...options, docIds: [native.docID, second.docID] }).then(() => null, error => error);
  expect(error).toBeInstanceOf(EdinetDocumentArchiveError); expect(error.cause).toBe(unknown);
  expect(vi.mocked(downloadDocument).mock.calls.every(([id]) => id === native.docID)).toBe(true);
  expect(recordEdinetZip).toHaveBeenCalledTimes(phase === "type1" ? 2 : 1);
});
it("requires a finite explicit source receipt and refuses force-overwrite", () => {
  for (const args of [[], ["--doc=S100YF41"], ["--doc=S100YF41,S100YF41"], ["--force"]])
    expect(() => zipRepairArguments(args)).toThrow("arguments_invalid");
});
