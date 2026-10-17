/** Actual saved 6963 finance with a declared invalid-type5/ACK transport projection. */
import { it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { ingestDocument } from "../services/ingest.js";
import { parseEdinetCsvZip } from "../services/edinet/csv.js";
import { downloadDocument } from "../services/edinet/client.js";
import { recordEdinetZip } from "../services/edinet/archive.js";
import { backupDocTextToNotion } from "../services/text-backup.js";
import { publishVerifiedShareholdings } from "../../../../src/shared/notion-archive/shareholdings.js";
import { openActualSnapshot, readSnapshot, type Snapshot } from "../../data-scripts/lib/saved-overseas-atomic.js";
import type { Database } from "../db/client.js";
import type { EdinetDoc } from "../services/edinet/types.js";
import type { D1BatchStatement } from "../../../../src/shared/db/d1-http-client.js";

vi.mock("../services/edinet/client.js", async (original) => ({
  ...await original<typeof import("../services/edinet/client.js")>(), downloadDocument: vi.fn(),
}));
vi.mock("../services/edinet/archive.js", async (original) => ({
  ...await original<typeof import("../services/edinet/archive.js")>(), recordEdinetZip: vi.fn(),
}));
vi.mock("../services/text-backup.js", () => ({ backupDocTextToNotion: vi.fn() }));
vi.mock("../../../../src/shared/notion-archive/shareholdings.js", () => ({ publishVerifiedShareholdings: vi.fn() }));

const codeRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const fixture = new URL("./fixtures/ingest-csv-reingest-6963/", import.meta.url);
const saved = JSON.parse(readFileSync(new URL("saved-business.json", fixture), "utf8")) as {
  item: { stockId: number; stockCode: string; documentId: number; zipSha256: string };
  sourceMetadata: Record<string, unknown>; d1: Snapshot;
};
const zip = readFileSync(new URL("S100YF41.zip", fixture));
// Historic archive metadata lacks original list flags. Literal0 is an explicit admission
// projection to isolate CSV replacement, never a current source qualification claim.
const doc = { ...saved.sourceMetadata, withdrawalStatus: "0" } as unknown as EdinetDoc;

it.each(["force", "pointer-missing"] as const)("failed CSV reingest preserves all saved nonempty values: %s", async (mode) => {
  vi.clearAllMocks();
  expect(createHash("sha256").update(zip).digest("hex")).toBe(saved.item.zipSha256);
  expect(() => parseEdinetCsvZip(zip)).toThrow(".csv が含まれていません");
  vi.mocked(downloadDocument).mockResolvedValue(zip); // actual type1 bytes as invalid type5
  vi.mocked(recordEdinetZip).mockResolvedValue({ pageId: "3e1d74ff-84cd-812e-bc79-f7aff3f2d7ca", outcome: "recorded", fileTooLarge: false, manifestMatch: "written" });
  const sqlite = openActualSnapshot(codeRoot, saved.d1);
  if (mode === "pointer-missing") sqlite.prepare("UPDATE yuho_documents SET notion_doc_page_id=NULL WHERE id=?").run(saved.item.documentId);
  const before = readSnapshot(sqlite, saved.item.stockId), batches: (readonly D1BatchStatement[])[] = [];
  const db = drizzle(async (sql, params, method) => {
    const stmt = sqlite.prepare(sql), columns = stmt.columns().map((c) => c.name);
    const rows = (stmt.all(...params as never[]) as Record<string, unknown>[]).map((r) => columns.map((n) => r[n]));
    return { rows: method === "get" ? (rows[0] ?? []) : rows };
  }) as unknown as Database;
  const sender = async (statements: readonly D1BatchStatement[]) => {
    batches.push(statements); sqlite.exec("BEGIN");
    try { for (const s of statements) sqlite.prepare(s.sql).run(...s.params as never[]); sqlite.exec("COMMIT"); }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  };
  const args = { stockId: saved.item.stockId, stockCode: saved.item.stockCode, doc, force: mode === "force",
    custody: { t1: "complete", t5: "missing" } as const, d1HttpBatch: sender };
  try {
    await expect(ingestDocument(db, args)).rejects.toThrow("旧facts/本文を置換せず停止");
    expect(before.yuho_order_facts).toHaveLength(6);
    expect(before.yuho_overseas_facts).toHaveLength(6);
    expect(before.yuho_text_sections).toHaveLength(37);
    expect(before.yuho_order_facts.some((r) => typeof r.orders_received_yen === "number" && r.orders_received_yen > 0)).toBe(true);
    expect(before.yuho_overseas_facts.some((r) => typeof r.sales_yen === "number" && r.sales_yen > 0)).toBe(true);
    expect(readSnapshot(sqlite, saved.item.stockId)).toEqual(before);
    expect(batches).toEqual([]);
    expect(vi.mocked(downloadDocument).mock.calls.map((c) => c[1])).toEqual([5]);
    expect(backupDocTextToNotion).not.toHaveBeenCalled();
    expect(publishVerifiedShareholdings).not.toHaveBeenCalled();
    expect(recordEdinetZip).toHaveBeenCalledTimes(1);
    const raw = vi.mocked(recordEdinetZip).mock.calls[0]![0];
    expect(raw.type).toBe(5); expect(Buffer.from(raw.zip).equals(zip)).toBe(true);
    expect(raw.force).toBe(mode === "force");
    expect(raw.metadata).toMatchObject({ docID: doc.docID, ingestPhase: "csv-reingest-rejected", csvParseStatus: "parse_error" });
    // An archive unknown must propagate identically and must not be relabelled as a known CSV stop.
    const unknown = new Error("declared archive unknown transport fault");
    vi.mocked(recordEdinetZip).mockRejectedValueOnce(unknown);
    await expect(ingestDocument(db, args)).rejects.toBe(unknown);
    expect(readSnapshot(sqlite, saved.item.stockId)).toEqual(before); expect(batches).toEqual([]);
  } finally { sqlite.close(); }
});

it("a first ingest with failed CSV still records parse_error rather than a reingest stop", async () => {
  vi.clearAllMocks(); vi.mocked(downloadDocument).mockResolvedValue(zip);
  vi.mocked(recordEdinetZip).mockResolvedValue({ pageId: "3e1d74ff-84cd-812e-bc79-f7aff3f2d7ca", outcome: "recorded", fileTooLarge: false, manifestMatch: "written" });
  const empty = Object.fromEntries(Object.entries(saved.d1).map(([t, rows]) => [t, t === "core_stocks" ? rows : []])) as Snapshot;
  const sqlite = openActualSnapshot(codeRoot, empty), batches: (readonly D1BatchStatement[])[] = [];
  const db = drizzle(async (sql, params, method) => {
    const stmt = sqlite.prepare(sql), columns = stmt.columns().map((c) => c.name);
    const rows = (stmt.all(...params as never[]) as Record<string, unknown>[]).map((r) => columns.map((n) => r[n]));
    return { rows: method === "get" ? (rows[0] ?? []) : rows };
  }) as unknown as Database;
  const sender = async (statements: readonly D1BatchStatement[]) => {
    batches.push(statements); sqlite.exec("BEGIN");
    try { for (const s of statements) sqlite.prepare(s.sql).run(...s.params as never[]); sqlite.exec("COMMIT"); }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  };
  try {
    const got = await ingestDocument(db, { stockId: saved.item.stockId, stockCode: saved.item.stockCode, doc,
      custody: { t1: "complete", t5: "missing" }, d1HttpBatch: sender });
    expect(got).toMatchObject({ outcome: "ingested", parseStatus: "parse_error", overseasParseStatus: "parse_error", textParseStatus: "parse_error" });
    expect(batches).toHaveLength(1); expect(readSnapshot(sqlite, saved.item.stockId).yuho_documents).toHaveLength(1);
  } finally { sqlite.close(); }
});
