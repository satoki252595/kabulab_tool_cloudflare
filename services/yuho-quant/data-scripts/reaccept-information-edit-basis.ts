/** 明示1docの派生metadataだけを訂正する。情報修正の解決は通常strict/v1へ残す。 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { stocks } from "../../../src/shared/db/core-schema.js";
import { disclosureIngestCondition } from "../../../src/shared/db/active-equity.js";
import { createD1HttpDb, createD1HttpBatchSender, toD1BatchStatements } from "../../../src/shared/db/d1-http-client.js";
import { recordPrimaryData, verifyArchivedAttachments } from "../../../src/shared/notion-archive/index.js";
import { notionEnv } from "../../../src/shared/notion-archive/env.js";
import { withSharedPublishingWriter, publishingStore } from "../../../scripts/mechanical-publishing/shared-writer.js";
import { installCatchupDeadline } from "../../../scripts/sync/catchup-launch.js";
import * as schema from "../src/db/schema.js";
import type { Database } from "../src/db/client.js";
import { informationEditMetadata, informationEditRowsGuard, isInformationEdit, readInformationEditState, verifyInformationEditData, type InformationEditState } from "../src/services/edinet/information-edit.js";
import { readSavedEdinetZip, readSavedEdinetZipReference } from "../src/services/edinet/archive.js";
import { edinetArchiveMetadata } from "../src/services/edinet/archive-metadata.js";
import { listSnapshotSchema, readListSnapshot, type ListSnapshot } from "../src/services/edinet/list-snapshot.js";
import { edinetTickerIdentityGuard, loadEdinetTickerMap } from "../src/services/edinet/identity.js";
import { edinetDocSchema, parseSubmitDateTime, secCodeToTicker, type EdinetDoc } from "../src/services/edinet/types.js";
import { parseEdinetCsvZip } from "../src/services/edinet/csv.js";
import { parseOrderData } from "../src/services/edinet/order-parser.js";
import { unzip } from "../src/services/edinet/zip.js";
import { parseOverseasData } from "../src/services/overseas-parser.js";
import { parseOverseasOmission, serializeOverseasOmission } from "../src/services/overseas-omission.js";
import { readVerifiedDocText } from "../src/services/text-backup.js";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const normalized = (value: unknown): unknown => value instanceof Date ? value.getTime() / 1000 : Array.isArray(value) ? value.map(normalized) :
  value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, normalized(v)])) : value;
const encoded = (value: unknown) => JSON.stringify(normalized(value));
const equal = (a: unknown, b: unknown) => assert.equal(encoded(a), encoded(b), "basis_input_changed_or_mismatched");
const nid = (value: string) => value.replaceAll("-", "").toLowerCase();
const save = (path: string, value: unknown) => {
  const bytes = value instanceof Uint8Array ? value : Buffer.from(encoded(value) + "\n");
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(dirname(path), constants.O_RDONLY); try { fsyncSync(parent); } finally { closeSync(parent); }
  return sha(bytes);
};
function receipt(path: string, expected: string): ListSnapshot {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd); assert(stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600 && stat.size <= 65_536, "private_receipt_invalid");
    const bytes = readFileSync(fd); assert.equal(bytes.length, stat.size); assert.equal(sha(bytes), expected);
    return listSnapshotSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } finally { closeSync(fd); }
}
export function parseBasisArguments(argv: string[]) {
  const { values } = parseArgs({ args: argv, strict: true, options: { doc: { type: "string" }, "event-snapshot": { type: "string" },
    "event-sha256": { type: "string" }, "original-snapshot": { type: "string" }, "original-sha256": { type: "string" },
    "expected-pre-sha256": { type: "string" }, "budget-min": { type: "string" }, execute: { type: "boolean", default: false } } });
  assert(values.doc && /^S[0-9A-Z]{7}$/.test(values.doc), "one_explicit_doc_required");
  const budgetMs = Number(values["budget-min"]) * 60_000; assert(Number.isSafeInteger(budgetMs) && budgetMs > 0 && budgetMs <= 10 * 60_000, "explicit_10min_maximum");
  for (const key of ["event-snapshot", "original-snapshot"] as const) assert(values[key] && values[key].trim() !== "", "explicit_saved_snapshot_required");
  for (const key of ["event-sha256", "original-sha256"] as const) assert(values[key] && /^[a-f0-9]{64}$/.test(values[key]), "snapshot_sha_required");
  assert(!values.execute || values["expected-pre-sha256"] && /^[a-f0-9]{64}$/.test(values["expected-pre-sha256"]), "reviewed_pre_sha_required");
  return { docId: values.doc, event: receipt(values["event-snapshot"]!, values["event-sha256"]!),
    original: receipt(values["original-snapshot"]!, values["original-sha256"]!), budgetMs,
    execute: values.execute, expectedPreSha256: values["expected-pre-sha256"] };
}
async function context(db: Database, docId: string, source: ListSnapshot, stop: () => void) {
  stop(); const found = await db.select({ stockId: schema.yuhoDocuments.stockId }).from(schema.yuhoDocuments).where(eq(schema.yuhoDocuments.docId, docId)).limit(2);
  assert.equal(found.length, 1, "document_not_unique");
  const state = await readInformationEditState(db, docId, found[0].stockId, stop);
  stop(); const observations = await db.select().from(schema.edinetReportedChanges).where(eq(schema.edinetReportedChanges.docId, docId)).limit(51);
  stop(); const resolutions = await db.select().from(schema.edinetReportedResolutions).where(eq(schema.edinetReportedResolutions.docId, docId)).limit(51);
  stop(); const progress = await db.select().from(schema.edinetCatchupProgress).where(and(eq(schema.edinetCatchupProgress.scope, "main"), eq(schema.edinetCatchupProgress.date, source.date))).limit(2);
  assert(observations.length > 0 && observations.length <= 50 && resolutions.length === 0, "observations_or_prior_resolution_unqualified");
  assert(progress.length === 1 && progress[0].inFlightDocId === null && progress[0].snapshot !== null, "progress_not_idle");
  equal(JSON.parse(progress[0].snapshot!), source);
  const pending: unknown = JSON.parse(progress[0].pendingIds);
  assert(Array.isArray(pending) && pending.some(row => row.docId === docId), "document_not_pending");
  return { state, observations, resolutions, progress };
}
type Context = Awaited<ReturnType<typeof context>>;
function nativeIdentity(doc: EdinetDoc, state: InformationEditState) {
  const d = state.document[0];
  assert(isInformationEdit(doc) && doc.docInfoEditStatus === "1", "explicit_information_edit_required");
  assert(doc.docID === d.docId && secCodeToTicker(doc.secCode) === state.stock[0].code && d.edinetCode === doc.edinetCode &&
    d.filerName === doc.filerName && d.docTypeCode === doc.docTypeCode && d.periodStart === doc.periodStart && d.periodEnd === doc.periodEnd &&
    doc.submitDateTime !== null && parseSubmitDateTime(doc.submitDateTime).getTime() === d.submittedAt.getTime(), "native_identity_mismatch");
}
function observationsMatch(c: Context, doc: EdinetDoc, event: ListSnapshot, original: ListSnapshot, old: EdinetDoc) {
  assert(c.observations.some(row => nid(row.sourcePageId) === nid(event.pageId) && row.sourceRawSha256 === event.rawSha256 && row.seqNumber === doc.seqNumber), "event_observation_missing");
  for (const row of c.observations) {
    const observed = JSON.parse(row.observationJson) as { doc: unknown; reportedIdentity?: { status: string; ticker: string; edinetCode: string; stockId: number; periodEnd: string } };
    const value = edinetDocSchema.parse(observed.doc), identity = observed.reportedIdentity, d = c.state.document[0];
    assert(row.reportedState === "reported_status_unqualified" && isInformationEdit(value) && row.stockId === d.stockId && row.periodEnd === d.periodEnd &&
      row.submittedAt?.getTime() === d.submittedAt.getTime() && identity?.status === "qualified_reported_metadata" && identity.ticker === c.state.stock[0].code &&
      identity.stockId === d.stockId && identity.edinetCode === d.edinetCode && identity.periodEnd === d.periodEnd, "different_reported_state_or_identity");
    if (value.docInfoEditStatus === "2") {
      assert(nid(row.sourcePageId) === nid(original.pageId) && row.sourceRawSha256 === original.rawSha256 && row.seqNumber === old.seqNumber, "different_original_observation"); equal(value, old);
    } else equal(informationEditMetadata(value), informationEditMetadata(doc));
  }
}
/** 全memberを比較する。抽出時に同名が潰れるZIPは受け入れない。 */
export function equalZipMembers(before: Buffer, after: Buffer) {
  const read = (bytes: Buffer) => {
    const entries = unzip(bytes, { maxEntries: 1000, maxExpandedBytes: 64 * 1024 ** 2 });
    let end = bytes.length - 22;
    for (; end >= Math.max(0, bytes.length - 65_557); end--) if (bytes.readUInt32LE(end) === 0x06054b50) break;
    // ponytail: directory entries are rejected with duplicate names; expand only if a qualified real EDINET ZIP needs them.
    assert(end >= 0 && bytes.readUInt16LE(end + 10) === entries.size, "zip_duplicate_or_directory_entry");
    return entries;
  };
  const a = read(before), b = read(after); equal([...a.keys()].sort(), [...b.keys()].sort());
  for (const [name, bytes] of a) assert(bytes.equals(b.get(name)!), "zip_member_changed");
  return [...a].map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: sha(bytes) }));
}
/** 候補4列を載せても元のstrict全比較を通らなければ、訂正候補を作らない。 */
export function basisCandidate(state: InformationEditState, csv: Awaited<ReturnType<typeof readSavedEdinetZip>>, current: Awaited<ReturnType<typeof readSavedEdinetZip>>,
  old: Awaited<ReturnType<typeof readSavedEdinetZipReference>>, body: Awaited<ReturnType<typeof readVerifiedDocText>>) {
  const d = state.document[0], identity = { docId: d.docId, periodEnd: d.periodEnd, edinetCode: d.edinetCode };
  const previous = parseOverseasOmission(d.overseasOmissionJson, identity); assert(previous, "explicit_old_omission_required");
  assert(nid(previous.archivePageId) === nid(old.pageId) && previous.zipSha256 === old.sha256 && previous.archiveManifest === old.originalManifest, "old_raw_reference_changed");
  const members = equalZipMembers(old.bytes, current.bytes), rows = parseEdinetCsvZip(csv.bytes);
  const order = parseOrderData(current.bytes, d.periodEnd), overseas = parseOverseasData(current.bytes, d.periodEnd);
  assert(overseas.omission, "current_omission_missing"); equal(previous.omission, overseas.omission);
  assert(d.parseStatus === order.status && d.textParseStatus === "ok", "unapproved_status_change");
  const update = { honbunFile: order.honbunFile, overseasParseStatus: overseas.status, overseasHonbunFile: overseas.honbunFile,
    overseasOmissionJson: serializeOverseasOmission({ ...identity, archivePageId: current.pageId, archiveManifest: current.originalManifest,
      zipSha256: current.sha256, omission: overseas.omission }) };
  const expected = { ...state, document: [{ ...d, ...update }] };
  verifyInformationEditData(expected, rows, current, body);
  assert(encoded(state.document) !== encoded(expected.document), "already_current_no_correction");
  return { update, expected, members };
}
async function materials(db: Database, options: ReturnType<typeof parseBasisArguments>, stop: () => void) {
  const docFrom = async (snapshot: ListSnapshot) => {
    stop(); const list = await readListSnapshot(snapshot), found = list.results.filter(doc => doc.docID === options.docId);
    assert.equal(found.length, 1, "snapshot_exact_doc_not_unique"); return found[0];
  };
  const doc = await docFrom(options.event), original = await docFrom(options.original), c = await context(db, options.docId, options.event, stop), d = c.state.document[0];
  nativeIdentity(doc, c.state);
  assert(original.docInfoEditStatus === "2" && original.withdrawalStatus === "0" && original.disclosureStatus === "0" && options.original.date === d.submittedAt.toISOString().slice(0, 10), "original_snapshot_unqualified");
  for (const key of ["docID", "edinetCode", "secCode", "JCN", "filerName", "ordinanceCode", "formCode", "docTypeCode", "periodStart", "periodEnd", "submitDateTime", "parentDocID"] as const) equal(original[key], doc[key]);
  observationsMatch(c, doc, options.event, options.original, original);
  stop(); assert.equal((await loadEdinetTickerMap(db, [d.edinetCode])).get(d.edinetCode), c.state.stock[0].code, "issuer_map_changed");
  const native = edinetArchiveMetadata(doc, d.periodEnd);
  stop(); const csv = await readSavedEdinetZip(d.docId, 5); stop(); const current = await readSavedEdinetZip(d.docId, 1);
  for (const zip of [csv, current]) { assert.equal(zip.originalManifest, "known", "typed_manifest_unqualified"); for (const [key, value] of Object.entries(native)) equal(zip.metadata[key], value); }
  const omission = parseOverseasOmission(d.overseasOmissionJson, { docId: d.docId, edinetCode: d.edinetCode, periodEnd: d.periodEnd }); assert(omission);
  stop(); const old = await readSavedEdinetZipReference({ docID: d.docId, type: 1, pageId: omission.archivePageId, sha256: omission.zipSha256,
    originalManifest: omission.archiveManifest, nativeMetadata: native });
  assert(d.notionDocPageId !== null && d.textParseStatus === "ok", "current_text_unqualified");
  stop(); const body = await readVerifiedDocText({ dbId: notionEnv.NOTION_YUHO_TEXT_DB_ID(), rowPageId: d.notionDocPageId, stockCode: c.state.stock[0].code,
    docId: d.docId, d1DocumentId: d.id, fiscalYearEnd: d.periodEnd, textParseStatus: d.textParseStatus, sectionCount: c.state.text.length,
    charCount: c.state.text.reduce((n, row) => n + row.charCount, 0) });
  const candidate = basisCandidate(c.state, csv, current, old, body);
  return { context: c, doc, original, native, csv, current, old, body, candidate };
}
type Material = Awaited<ReturnType<typeof materials>>;
const bundle = (m: Material, options: ReturnType<typeof parseBasisArguments>) => ({
  context: m.context, event: options.event, original: options.original, doc: m.doc, originalDoc: m.original, native: m.native,
  csv: { ...m.csv, bytes: m.csv.bytes.toString("base64") }, current: { ...m.current, bytes: m.current.bytes.toString("base64") },
  old: { ...m.old, bytes: m.old.bytes.toString("base64") }, body: m.body, candidate: m.candidate,
});
/** 固定canonical latchと共有ownerを使い、失敗後に出力dirを変えた再送を許さない。 */
export async function runBasisReaccept(options: ReturnType<typeof parseBasisArguments>, canonicalRoot: string) {
  const deadline = Date.now() + options.budgetMs, stop = () => assert(Date.now() < deadline, "basis_deadline");
  const baseDir = join(canonicalRoot, "tmp/edinet-information-edit-basis"), stateDir = join(baseDir, options.docId);
  const pending = join(stateDir, "pending.json"), completed = join(stateDir, "completed.json");
  if (options.execute) assert(!existsSync(pending) && !existsSync(completed), "canonical_basis_evidence_no_reentry");
  const restore = installCatchupDeadline(deadline);
  try {
    const db = createD1HttpDb(schema) as unknown as Database;
    const first = await materials(db, options, stop), pre = bundle(first, options), preText = encoded(pre), preSha256 = sha(preText);
    if (!options.execute) return { status: "planned" as const, docId: options.docId, preSha256, update: first.candidate.update };
    assert.equal(preSha256, options.expectedPreSha256, "reviewed_pre_changed");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    assert.equal(realpathSync(baseDir), resolve(baseDir), "canonical_state_parent_symlink");
    const baseStat = lstatSync(baseDir); assert(baseStat.uid === process.getuid?.() && (baseStat.mode & 0o077) === 0, "canonical_state_parent_not_private");
    const stat = lstatSync(stateDir); assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0, "canonical_state_not_private");
    assert(!existsSync(completed), "basis_already_completed_no_reentry");
    save(pending, { docId: options.docId, preSha256, startedAt: new Date().toISOString(), noReplay: true });
    const result = await withSharedPublishingWriter(async () => {
      const archive = async (phase: "PRE" | "POST", bytes: Uint8Array) => {
        assert(bytes.length <= 20 * 1024 ** 2, "basis_audit_size_limit");
        const filename = `${options.docId}-derived-metadata-${phase}.json.gz`;
        const result = await recordPrimaryData({ service: "yuho-quant", key: `information-edit-basis:${options.docId}:${preSha256}:${phase}`,
          source: "Explicit saved EDINET derived metadata correction; upstream GET 0", fetchedAt: new Date().toISOString(),
          metadata: { docId: options.docId, preSha256, phase, bytes: bytes.length, sha256: sha(bytes), noReplay: true },
          files: [{ filename, bytes, contentType: "application/gzip" }], requireExistingDatabase: true, force: false });
        assert(result.outcome === "recorded" && !result.fileTooLarge && result.manifestMatch === "written", "basis_audit_not_new_physical");
        await verifyArchivedAttachments(result.pageId, [{ filename, bytes }], "派生metadata訂正の完全audit"); return result;
      };
      const preBytes = gzipSync(preText); save(join(stateDir, "PRE.json.gz"), preBytes); const preArchive = await archive("PRE", preBytes);
      // 物理PREの保管後、全原本・全本文・issuer・観測と進捗も再読取。DBはさらに同一batchでCASする。
      const fresh = await materials(db, options, stop); equal(bundle(fresh, options), pre);
      const c = fresh.context, d = c.state.document[0];
      const guards = [edinetTickerIdentityGuard(db, d.edinetCode, c.state.stock[0].code),
        db.select({ stockUnchanged: sql`json(case when exists(select 1 from ${stocks} where ${stocks.id}=${d.stockId}
          and ${stocks.code}=${c.state.stock[0].code} and ${disclosureIngestCondition()}) then 'null' else '' end)` }).from(sql`(select 1)`),
        informationEditRowsGuard(db, schema.yuhoDocuments, eq(schema.yuhoDocuments.docId, d.docId), c.state.document),
        informationEditRowsGuard(db, schema.orderFacts, eq(schema.orderFacts.documentId, d.id), c.state.orders),
        informationEditRowsGuard(db, schema.overseasSalesFacts, eq(schema.overseasSalesFacts.documentId, d.id), c.state.overseas),
        informationEditRowsGuard(db, schema.textSections, eq(schema.textSections.documentId, d.id), c.state.text),
        informationEditRowsGuard(db, schema.edinetReportedChanges, eq(schema.edinetReportedChanges.docId, d.docId), c.observations),
        informationEditRowsGuard(db, schema.edinetReportedResolutions, eq(schema.edinetReportedResolutions.docId, d.docId), c.resolutions),
        informationEditRowsGuard(db, schema.edinetCatchupProgress, and(eq(schema.edinetCatchupProgress.scope, "main"), eq(schema.edinetCatchupProgress.date, options.event.date))!, c.progress)];
      const statements = toD1BatchStatements([...guards, db.update(schema.yuhoDocuments).set(fresh.candidate.update).where(eq(schema.yuhoDocuments.id, d.id)) as never]);
      stop(); save(join(stateDir, "INTENT.json"), { preSha256, preArchive, statements, expectedState: fresh.candidate.expected, noReplay: true });
      await createD1HttpBatchSender()(statements);
      const after = await context(db, options.docId, options.event, stop);
      equal(after, { ...c, state: fresh.candidate.expected });
      stop(); const postBody = await readVerifiedDocText({ dbId: notionEnv.NOTION_YUHO_TEXT_DB_ID(), rowPageId: d.notionDocPageId!, stockCode: c.state.stock[0].code,
        docId: d.docId, d1DocumentId: d.id, fiscalYearEnd: d.periodEnd, textParseStatus: d.textParseStatus!, sectionCount: c.state.text.length,
        charCount: c.state.text.reduce((n, row) => n + row.charCount, 0) }); equal(postBody, fresh.body);
      verifyInformationEditData(after.state, parseEdinetCsvZip(fresh.csv.bytes), fresh.current, postBody);
      const postBytes = gzipSync(encoded({ preSha256, before: c, after, body: postBody, resolutionStillPending: true }));
      save(join(stateDir, "POST.json.gz"), postBytes); const postArchive = await archive("POST", postBytes);
      const result = { status: "basis_reaccepted_resolution_pending" as const, docId: d.docId, preSha256, preArchive, postArchive,
        updatedColumns: Object.keys(fresh.candidate.update), financialWrites: 0, textWrites: 0, resolutionWrites: 0, upstreamGets: 0 };
      return result;
    }, publishingStore(deadline));
    save(completed, result); unlinkSync(pending);
    const dir = openSync(stateDir, constants.O_RDONLY); try { fsyncSync(dir); } finally { closeSync(dir); }
    return result;
  } finally { restore(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseBasisArguments(process.argv.slice(2));
    const common = realpathSync(resolve(execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim()));
    const canonicalRoot = dirname(common), envPath = realpathSync(resolve(".env"));
    assert.equal(dirname(envPath), canonicalRoot, "canonical_env_root_mismatch");
    const envStat = lstatSync(envPath); assert(envStat.isFile() && envStat.uid === process.getuid?.() && (envStat.mode & 0o077) === 0, "canonical_env_not_private");
    const report = await runBasisReaccept(options, canonicalRoot);
    // 掲載原文・metadata JSON・SQL・認証値は出力しない。
    console.info(JSON.stringify({ status: report.status, docId: report.docId, preSha256: report.preSha256 }));
  } catch { console.error("[information-edit-basis] STOP。canonical pending/ownerを保全し、再送せず照合してください"); process.exitCode = 1; }
}
