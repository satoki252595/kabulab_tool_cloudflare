/** Source-only finite repair. A physical native date-list receipt is mandatory; D1 never supplies raw metadata. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { createD1HttpDb } from "../../../src/shared/db/d1-http-client.js";
import { stocks } from "../../../src/shared/db/core-schema.js";
import { recordEdinetZip, readSavedEdinetZip, SavedEdinetZipMissingError, custodyOf, edinetArchiveKey,
  type EdinetArchiveDocType } from "../src/services/edinet/archive.js";
import { edinetArchiveMetadata } from "../src/services/edinet/archive-metadata.js";
import { listSnapshotSchema, readListSnapshot, type ListSnapshot } from "../src/services/edinet/list-snapshot.js";
import { loadEdinetTickerMap } from "../src/services/edinet/identity.js";
import { assertReportedDocumentUsable, reportedDocumentMetadata, reportedStandaloneHold } from "../src/services/edinet/reported-changes.js";
import { isAnnualSecuritiesReport, parseSubmitDateTime, resolveReportPeriodEnd, secCodeToTicker, type EdinetDoc } from "../src/services/edinet/types.js";
import { downloadDocument, EdinetNotFoundError, EdinetDocumentFetchError, EdinetDocumentArchiveError } from "../src/services/edinet/client.js";
import * as yuhoSchema from "../src/db/schema.js";

export class ZipRepairQualificationError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ZipRepairQualificationError"; }
}
function requireSource(condition: unknown, code: string): asserts condition {
  if (!condition) throw new ZipRepairQualificationError(code);
}
export function zipRepairArguments(args: string[]) {
  const values = new Map<string, string>();
  for (const arg of args) {
    const match = /^--(doc|source-snapshot|source-snapshot-sha256)=(.+)$/.exec(arg);
    requireSource(match && !values.has(match[1]), "arguments_invalid");
    values.set(match[1], match[2]);
  }
  const docIds = values.get("doc")?.split(",");
  const sourceSnapshot = values.get("source-snapshot"), sourceSnapshotSha256 = values.get("source-snapshot-sha256");
  requireSource(docIds && docIds.length > 0 && docIds.length <= 5 && new Set(docIds).size === docIds.length &&
    docIds.every(id => /^S[0-9A-Z]{7}$/.test(id)) && sourceSnapshot && sourceSnapshotSha256 &&
    /^[a-f0-9]{64}$/.test(sourceSnapshotSha256), "arguments_invalid");
  return { docIds, sourceSnapshot, sourceSnapshotSha256 };
}
function readReceipt(path: string, expectedSha256: string): ListSnapshot {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    requireSource(stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600 && stat.size <= 65_536,
      "snapshot_receipt_invalid");
    const bytes = readFileSync(fd);
    requireSource(bytes.length === stat.size && createHash("sha256").update(bytes).digest("hex") === expectedSha256,
      "snapshot_receipt_sha_mismatch");
    return listSnapshotSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } finally { closeSync(fd); }
}
type SavedDocument = Pick<typeof yuhoSchema.yuhoDocuments.$inferSelect,
  "docId" | "edinetCode" | "filerName" | "docTypeCode" | "periodStart" | "periodEnd" | "submittedAt"> & { stockCode: string };

/** Native issuer, period and submission clock must agree with the existing document; none is reconstructed. */
export function qualifyZipRepairSource(doc: EdinetDoc, row: SavedDocument, snapshot: ListSnapshot) {
  requireSource(isAnnualSecuritiesReport(doc) && !reportedStandaloneHold(doc) && doc.withdrawalStatus === "0" &&
    doc.docInfoEditStatus === "0" && doc.disclosureStatus === "0" && doc.csvFlag === "1", "source_state_unqualified");
  const periodEnd = resolveReportPeriodEnd(doc);
  requireSource(periodEnd !== null && doc.docID === row.docId && doc.edinetCode === row.edinetCode &&
    doc.filerName === row.filerName && doc.docTypeCode === row.docTypeCode && doc.periodStart === row.periodStart &&
    periodEnd === row.periodEnd && secCodeToTicker(doc.secCode) === row.stockCode, "source_identity_mismatch");
  requireSource(doc.submitDateTime !== null && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(doc.submitDateTime) &&
    snapshot.date === doc.submitDateTime.slice(0, 10) && row.submittedAt instanceof Date &&
    Number.isFinite(row.submittedAt.getTime()) && parseSubmitDateTime(doc.submitDateTime).getTime() === row.submittedAt.getTime(),
    "source_submission_mismatch");
  return { ...edinetArchiveMetadata(doc, periodEnd), ...reportedDocumentMetadata(doc),
    sourceListSnapshot: snapshot, repairedBy: "source-qualified-zip-repair-v1" };
}

type NativeMetadata = ReturnType<typeof edinetArchiveMetadata>;
type SavedZip = Awaited<ReturnType<typeof readSavedEdinetZip>>;
function assertReusableZip(saved: SavedZip, native: NativeMetadata, type: EdinetArchiveDocType) {
  requireSource(saved.originalManifest === "known", "existing_archive_manifest_unqualified");
  requireSource(saved.metadata.edinetDocType === type && Object.entries(native).every(([key, value]) => saved.metadata[key] === value),
    "existing_archive_metadata_mismatch");
}
// Every physical archive failure stops the whole finite run, including ordinary type5/type1 and readback unknowns.
async function archive(input: Parameters<typeof recordEdinetZip>[0], native: NativeMetadata) {
  try {
    const result = await recordEdinetZip(input);
    // A row appearing after the missing-key qualification must satisfy the same reuse contract.
    if (result.outcome === "skipped_existing") {
      const saved = await readSavedEdinetZip(input.docID, input.type);
      assertReusableZip(saved, native, input.type);
      if (typeof input.metadata.xbrlUnavailable === "boolean") requireSource(saved.metadata.xbrlUnavailable === input.metadata.xbrlUnavailable,
        "existing_archive_nonprovision_mismatch");
    }
    return result;
  }
  catch (cause) { throw new EdinetDocumentArchiveError({ cause }); }
}

export async function repairZipArchives(options: ReturnType<typeof zipRepairArguments>) {
  const snapshot = readReceipt(options.sourceSnapshot, options.sourceSnapshotSha256);
  requireSource(snapshot.qualified && snapshot.httpStatus === 200, "snapshot_unqualified");
  const list = await readListSnapshot(snapshot);
  const db = createD1HttpDb(yuhoSchema), { yuhoDocuments } = yuhoSchema;
  const qualified: Array<{ doc: EdinetDoc; metadata: ReturnType<typeof qualifyZipRepairSource> }> = [];
  // Qualify the entire explicitly requested subset before the first new ZIP GET or archive write.
  for (const docId of options.docIds) {
    const candidates = list.results.filter(doc => doc.docID === docId);
    requireSource(candidates.length === 1, "snapshot_document_not_unique");
    const rows = await db.select({ docId: yuhoDocuments.docId, edinetCode: yuhoDocuments.edinetCode,
      filerName: yuhoDocuments.filerName, docTypeCode: yuhoDocuments.docTypeCode, periodStart: yuhoDocuments.periodStart,
      periodEnd: yuhoDocuments.periodEnd, submittedAt: yuhoDocuments.submittedAt, stockCode: stocks.code })
      .from(yuhoDocuments).innerJoin(stocks, eq(stocks.id, yuhoDocuments.stockId))
      .where(eq(yuhoDocuments.docId, docId)).limit(2);
    requireSource(rows.length === 1, "existing_document_not_unique");
    const metadata = qualifyZipRepairSource(candidates[0], rows[0], snapshot);
    requireSource((await loadEdinetTickerMap(db, [rows[0].edinetCode])).get(rows[0].edinetCode) === rows[0].stockCode,
      "current_issuer_mismatch");
    await assertReportedDocumentUsable(db, docId);
    qualified.push({ doc: candidates[0], metadata });
  }
  // Validate every existing type of every selected document before the first SOURCE request.
  const stored = new Map<string, Map<EdinetArchiveDocType, SavedZip>>();
  for (const { doc, metadata } of qualified) {
    const zips = new Map<EdinetArchiveDocType, SavedZip>(), native = edinetArchiveMetadata(doc, metadata.periodEnd);
    for (const type of [5, 1] as const) {
      let saved: SavedZip;
      try { saved = await readSavedEdinetZip(doc.docID, type); }
      catch (error) { if (error instanceof SavedEdinetZipMissingError) continue; throw error; }
      assertReusableZip(saved, native, type);
      zips.set(type, saved);
    }
    stored.set(doc.docID, zips);
  }
  const tally = { recorded: 0, skipped_existing: 0, reused_existing_types: 0, not_applicable_types: 0, edinet_not_found: 0 };
  for (const { doc, metadata } of qualified) {
    // A changed/withdrawn observation arriving during qualification must not be ignored.
    await assertReportedDocumentUsable(db, doc.docID);
    const zips = stored.get(doc.docID)!;
    const custody = custodyOf(new Map([...zips].map(([type, saved]) => [edinetArchiveKey(doc.docID, type),
      { fileCount: 1, metadata: saved.metadata }])), doc.docID);
    tally.reused_existing_types += zips.size;
    if (custody.t1 === "not-applicable") tally.not_applicable_types += 1;
    if (custody.t5 === "complete" && custody.t1 !== "missing") { tally.skipped_existing += 1; continue; }
    const native = edinetArchiveMetadata(doc, metadata.periodEnd);
    let csvZip: Awaited<ReturnType<typeof downloadDocument>> | undefined = zips.get(5)?.bytes;
    if (csvZip === undefined) {
      try { csvZip = await downloadDocument(doc.docID, 5); }
      catch (error) {
        if (!(error instanceof EdinetNotFoundError)) throw error;
        tally.edinet_not_found += 1; continue; // client physically archived the known HTTP404
      }
    }
    const csvFetchedAt = new Date().toISOString();
    let xbrlZip: Awaited<ReturnType<typeof downloadDocument>> | null = null;
    let xbrlFetchedAt: string | null = null;
    let xbrlUnavailable = custody.t1 === "not-applicable";
    if (custody.t1 === "missing") {
      try { xbrlZip = await downloadDocument(doc.docID, 1); xbrlFetchedAt = new Date().toISOString(); }
      catch (error) {
        if (!(error instanceof EdinetNotFoundError)) {
          // Already qualified CSV is reused; close only a newly received CSV after known type1 source failure.
          if (error instanceof EdinetDocumentFetchError && custody.t5 === "missing") await archive({ service: "yuho-quant", docID: doc.docID, type: 5,
            zip: csvZip, source: `EDINET API v2 /documents/${doc.docID}?type=5`, fetchedAt: csvFetchedAt,
            metadata: { ...metadata, ingestPhase: "partial-source", failedType: 1 }, force: false }, native);
          throw error;
        }
        // Do not overwrite an existing CSV solely to add a new non-provision marker.
        if (custody.t5 === "complete") { tally.edinet_not_found += 1; continue; }
        xbrlUnavailable = true;
      }
    }
    const completeMetadata = { ...metadata, xbrlUnavailable };
    let recorded = false;
    if (custody.t5 === "missing") {
      const r5 = await archive({ service: "yuho-quant", docID: doc.docID, type: 5, zip: csvZip,
        source: `EDINET API v2 /documents/${doc.docID}?type=5`, fetchedAt: csvFetchedAt, metadata: completeMetadata, force: false }, native);
      recorded = r5.outcome === "recorded";
      if (r5.outcome === "skipped_existing") tally.reused_existing_types += 1;
      if (xbrlUnavailable) tally.not_applicable_types += 1;
    }
    if (xbrlZip !== null) {
      requireSource(xbrlFetchedAt !== null, "xbrl_clock_missing");
      const r1 = await archive({ service: "yuho-quant", docID: doc.docID, type: 1, zip: xbrlZip,
        source: `EDINET API v2 /documents/${doc.docID}?type=1`, fetchedAt: xbrlFetchedAt, metadata: completeMetadata, force: false }, native);
      recorded = recorded || r1.outcome === "recorded";
      if (r1.outcome === "skipped_existing") tally.reused_existing_types += 1;
    }
    tally[recorded ? "recorded" : "skipped_existing"] += 1;
  }
  return tally;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const tally = await repairZipArchives(zipRepairArguments(process.argv.slice(2)));
    console.info("[zip-repair] " + JSON.stringify(tally));
    if (tally.edinet_not_found > 0) process.exitCode = 1;
  } catch (error) {
    const code = error instanceof ZipRepairQualificationError ? error.code :
      error instanceof EdinetDocumentArchiveError ? "archive_unclosed_no_retry" :
      error instanceof EdinetDocumentFetchError ? "source_failed_no_retry" : "repair_stopped_no_retry";
    console.error(`[zip-repair] ${code}`); process.exitCode = 1;
  }
}
