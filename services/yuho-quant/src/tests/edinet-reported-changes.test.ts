import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { createReportedSourceTestDb } from "../../../../src/shared/notion-archive/reported-source-test-db.js";
import { edinetDocSchema, edinetListResponseSchema, isAnnualSecuritiesReport } from "../services/edinet/types.js";
import { captureListSnapshot } from "../services/edinet/list-snapshot.js";
import { observeDocuments } from "../services/edinet/client.js";
import { recordPrimaryData, verifyArchivedAttachments } from "../../../../src/shared/notion-archive/index.js";
import { assertReportedDocumentUsable, buildReportedChanges, recordReportedChanges, reportedDocumentMetadata,
  reportedStandaloneHold, ReportedDocumentHoldError, reportedDocumentsHoldQuery, assertReportedDocumentsResult } from "../services/edinet/reported-changes.js";

vi.mock("../services/edinet/client.js", () => ({ observeDocuments: vi.fn() }));
vi.mock("../../../../src/shared/notion-archive/index.js", () => ({ recordPrimaryData: vi.fn(), verifyArchivedAttachments: vi.fn() }));
const fixture = JSON.parse(readFileSync(new URL("./fixtures/edinet-reported-lineage.json", import.meta.url), "utf8"));
type Entry = { source: { date: string; rawSha256: string; retainedArchive: Array<{ pageId: string }> }; original: Record<string, unknown> };
const entries = fixture.entries as Entry[];
const find = (id: string) => { const entry = entries.find(e => e.original.docID === id); if (!entry) throw new Error("missing real fixture"); return entry; };

beforeEach(() => { vi.resetAllMocks(); });
async function captured(entry: Entry, related: Entry[] = []) {
  // Original result row is unchanged. This count/clock/archive transport is a declared protocol projection,
  // not a claim that the full retained original HTTP body or real archive ACK is replayed here.
  const raw = new TextEncoder().encode(JSON.stringify({ metadata: { parameter: { date: entry.source.date, type: "2" },
    status: "200", message: "OK", resultset: { count: 1 + related.length } }, results: [entry.original, ...related.map(e => e.original)] }));
  vi.mocked(observeDocuments).mockResolvedValue({ date: entry.source.date, httpStatus: 200,
    fetchedAt: `${entry.source.date}T12:00:00.000Z`, bytes: raw });
  vi.mocked(recordPrimaryData).mockResolvedValue({ pageId: entry.source.retainedArchive[0].pageId,
    outcome: "recorded", manifestMatch: "match" } as never);
  vi.mocked(verifyArchivedAttachments).mockResolvedValue(undefined);
  const result = await captureListSnapshot(entry.source.date);
  expect(result.snapshot.rawSha256).toBe(createHash("sha256").update(raw).digest("hex"));
  expect(result.snapshot.rawSha256).not.toBe(entry.source.rawSha256);
  return result;
}

describe("EDINET reported state is distinct from qualified correction effects", () => {
  it("実8/28の同docID・別seq観測を両方保全し、seq重複と資格の取り違えを拒否する", async () => {
    const repeated = entries.filter(e => e.original.docID === "S100YXXA");
    expect(repeated.map(e => e.original.seqNumber)).toEqual([318, 345]);
    const source = await captured(repeated[0], repeated.slice(1));
    const { db, sqlite } = createReportedSourceTestDb();
    expect(await recordReportedChanges(db, source.list, source.snapshot, () => false)).toEqual({observations: 2, held: 2, relations: 0});
    const saved = sqlite.prepare("select seq_number, doc_id, observation_json from yuho_edinet_reported_changes order by seq_number").all();
    expect(saved.map(r => [r.seq_number, r.doc_id, JSON.parse(String(r.observation_json)).doc.docInfoEditStatus]))
      .toEqual([[318, "S100YXXA", "2"], [345, "S100YXXA", "1"]]);
    const before = sqlite.prepare("select total_changes() as n").get();
    await recordReportedChanges(db, source.list, source.snapshot, () => false);
    expect(sqlite.prepare("select total_changes() as n").get()).toEqual(before);
    await expect(assertReportedDocumentUsable(db, "S100YXXA")).rejects.toThrow(ReportedDocumentHoldError);
    // Declared qualification projection tests only: metadata belongs to one exact source sequence.
    const rows = buildReportedChanges(source.list, source.snapshot, new Map([[345, {
      stockId: 1, ticker: "4323", edinetCode: "E05236", periodEnd: "2026-03-31", submittedAt: new Date("2026-07-03T00:01:00Z"),
    }]]));
    expect(rows.map(r => [r.seqNumber, r.stockId])).toEqual([[318, null], [345, 1]]);
    const duplicate = {...source.list, results: [source.list.results[0], source.list.results[0]]};
    expect(() => buildReportedChanges(duplicate, source.snapshot)).toThrow("書類ID/順序");
    // Declared original-row fault: even a normal (unreported) row cannot share the observation sequence.
    const normalCollision = {...source.list, results: [
      {...source.list.results[0], docInfoEditStatus: "0"},
      {...source.list.results[1], seqNumber: source.list.results[0].seqNumber},
    ]};
    await expect(recordReportedChanges(db, normalCollision, source.snapshot, () => false)).rejects.toThrow("書類ID/順序");
    expect(sqlite.prepare("select total_changes() as n").get()).toEqual(before);
  });

  it("the shared real-D1 set read detects only exact held docs and rejects malformed/ambiguous responses", async () => {
    const { db, sqlite } = createReportedSourceTestDb(), source = await captured(find("S100YRSP"));
    await recordReportedChanges(db, source.list, source.snapshot, () => false);
    const ids = ["S100YRSP", "S100VVJZ", "S100YOCW"], query = reportedDocumentsHoldQuery(ids);
    expect(query.params).toEqual(ids); expect(query.params.length).toBeLessThanOrEqual(100);
    const rows = sqlite.prepare(query.sql).all(...query.params) as Record<string, unknown>[];
    expect(rows).toEqual([{ doc_id: "S100YRSP" }]); expect(() => assertReportedDocumentsResult(ids, rows)).toThrow(ReportedDocumentHoldError);
    const parentQuery = reportedDocumentsHoldQuery(["S100VVJZ"]);
    expect(() => assertReportedDocumentsResult(["S100VVJZ"], sqlite.prepare(parentQuery.sql).all(...parentQuery.params) as Record<string, unknown>[])).not.toThrow();
    for (const bad of [[{}], [{doc_id:"S100YRSP", extra:true}], [{doc_id:"S100YRSP"},{doc_id:"S100YRSP"}], [{doc_id:"S100OTHER"}]]) {
      expect(() => assertReportedDocumentsResult(ids, bad)).toThrow("応答が不明");
    }
    for (const invalid of [[],["S100YRSP","S100YRSP"],Array.from({length:101},(_,i)=>String(i))]) expect(() => reportedDocumentsHoldQuery(invalid)).toThrow("対象集合");
  });
  it("actual correction retains parent/null operation time; parent absent does not hold independently qualified annual facts", async () => {
    const entry = find("S100YOCW"), doc = edinetDocSchema.parse(entry.original);
    expect(doc.parentDocID).toBe("S100YI5H"); expect(doc.opeDateTime).toBeNull(); expect(doc.legalStatus).toBe("1");
    expect(isAnnualSecuritiesReport(doc)).toBe(true); expect(reportedStandaloneHold(doc)).toBe(false);
    expect(reportedDocumentMetadata(doc)).toMatchObject({ parentDocID: "S100YI5H", chainQualification: "unqualified", chainApplication: "not_applied" });
    const { db } = createReportedSourceTestDb(), source = await captured(entry);
    expect(await recordReportedChanges(db, source.list, source.snapshot, () => false)).toEqual({ observations: 1, held: 0, relations: 1 });
    await expect(assertReportedDocumentUsable(db, doc.docID)).resolves.toBeUndefined();
    await expect(assertReportedDocumentUsable(db, "S100YI5H")).resolves.toBeUndefined();
  });

  it("actual withdrawal with null issuer/type/FY persists and holds only its exact ID, never automatically its reported parent", async () => {
    const entry = find("S100YRSP"), doc = edinetDocSchema.parse(entry.original);
    expect([doc.edinetCode, doc.docTypeCode, doc.periodEnd]).toEqual([null, null, null]);
    expect(doc.parentDocID).toBe("S100VVJZ"); expect(reportedStandaloneHold(doc)).toBe(true);
    const { db, sqlite } = createReportedSourceTestDb(), source = await captured(entry);
    expect(await recordReportedChanges(db, source.list, source.snapshot, () => false)).toEqual({ observations: 1, held: 1, relations: 0 });
    await expect(assertReportedDocumentUsable(db, doc.docID)).rejects.toBeInstanceOf(ReportedDocumentHoldError);
    await expect(assertReportedDocumentUsable(db, "S100VVJZ")).resolves.toBeUndefined();
    const saved = sqlite.prepare("select observation_json from yuho_edinet_reported_changes").get() as { observation_json: string };
    const original = JSON.parse(saved.observation_json);
    expect(original.doc).toEqual(doc); expect(original.source.rawSha256).toBe(source.snapshot.rawSha256);
    expect(original.chainApplication).toBe("not_applied");
    expect(await recordReportedChanges(db, source.list, source.snapshot, () => false)).toEqual({ observations: 1, held: 1, relations: 0 });
    expect(sqlite.prepare("select count(*) as n from yuho_edinet_reported_changes").get()).toEqual({ n: 1 });
  });

  it("old absent fields remain absent; literal null is not converted to absent or a parent guess", () => {
    const original = structuredClone(find("S100YOCW").original);
    delete original.parentDocID; delete original.opeDateTime; delete original.legalStatus;
    const old = edinetDocSchema.parse(original);
    expect(Object.hasOwn(old, "parentDocID")).toBe(false);
    expect(Object.hasOwn(reportedDocumentMetadata(old), "parentDocID")).toBe(false);
    const nullable = edinetDocSchema.parse({ ...original, parentDocID: null });
    expect(reportedDocumentMetadata(nullable).parentDocID).toBeNull();
  });

  it.each(["S", "S100YOCW1", "S100YOC!", ""])("declared malformed own-ID %s stops before observation DML", async docID => {
    const source = await captured(find("S100YOCW"));
    const changed = edinetListResponseSchema.parse({ ...source.list, results: [{ ...source.list.results[0], docID }] });
    expect(() => buildReportedChanges(changed, source.snapshot)).toThrow("書類ID");
  });

  it.each(["S", "S100YOCW", "S100YI5H"])("declared invalid/self/unresolved parent %s never becomes qualified or invalidates standalone data", async parentDocID => {
    const source = await captured(find("S100YOCW"));
    const changed = edinetListResponseSchema.parse({ ...source.list, results: [{ ...source.list.results[0], parentDocID }] });
    const rows = buildReportedChanges(changed, source.snapshot);
    expect(JSON.parse(rows[0].observationJson).chainQualification).toBe("unqualified");
    expect(rows[0].reportedState).toBe("unqualified_relation");
  });

  it("same physical snapshot with changed body is rejected before any insert; source eligibility and budget faults also stop", async () => {
    const { db, sqlite } = createReportedSourceTestDb(), source = await captured(find("S100YRSP"));
    await recordReportedChanges(db, source.list, source.snapshot, () => false);
    sqlite.exec("update yuho_edinet_reported_changes set observation_json='{}'");
    const before = sqlite.prepare("select total_changes() as n").get();
    await expect(recordReportedChanges(db, source.list, source.snapshot, () => false)).rejects.toThrow("不一致");
    expect(sqlite.prepare("select total_changes() as n").get()).toEqual(before);
    expect(() => buildReportedChanges(source.list, { ...source.snapshot, qualified: false })).toThrow("未資格");
    await expect(recordReportedChanges(db, source.list, source.snapshot, () => true)).rejects.toThrow("予算");
  });

  it("declared lost ACK after real INSERT is not retried or turned into completion", async () => {
    const { sqlite } = createReportedSourceTestDb(), source = await captured(find("S100YRSP"));
    let inserts = 0;
    const db = drizzle(async (query, args, method) => {
      const stmt = sqlite.prepare(query); const params = args as (string | number | null)[];
      if (method === "run") { stmt.run(...params); inserts++; throw new Error("declared INSERT ACK unknown"); }
      const rows = (stmt.all(...params) as Record<string, unknown>[]).map(r => Object.values(r));
      return { rows: method === "get" ? rows[0] : rows };
    });
    const failure = await recordReportedChanges(db, source.list, source.snapshot, () => false).catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.cause?.message).toBe("declared INSERT ACK unknown");
    expect(inserts).toBe(1); expect(sqlite.prepare("select count(*) as n from yuho_edinet_reported_changes").get()).toEqual({ n: 1 });
  });

  it("distinct declared capture pages retain both observations of identical raw bytes; same-page clock drift is rejected", async () => {
    const { db, sqlite } = createReportedSourceTestDb(), source = await captured(find("S100YRSP"));
    await recordReportedChanges(db, source.list, source.snapshot, () => false);
    const next = { ...source.snapshot, pageId: "3a6d74ff84cd81d49ab9fa0e0868233b", fetchedAt: "2026-07-23T12:01:00.000Z" };
    await recordReportedChanges(db, source.list, next, () => false);
    expect(sqlite.prepare("select count(*) as n,count(distinct source_raw_sha256) as sources from yuho_edinet_reported_changes").get()).toEqual({ n: 2, sources: 1 });
    await expect(recordReportedChanges(db, source.list, { ...source.snapshot, fetchedAt: next.fetchedAt }, () => false)).rejects.toThrow("不一致");
  });
});
