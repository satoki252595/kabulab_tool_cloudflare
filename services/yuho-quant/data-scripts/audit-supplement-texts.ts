/** Finite, read-only current-cell/source join. Never repairs, downloads EDINET or invokes a model. */
import "dotenv/config";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { createD1HttpDb } from "../../../src/shared/db/d1-http-client.js";
import { sharedEnv } from "../../../src/shared/env.js";
import { parseStockCode } from "../../../src/shared/jpx/stock-code.js";
import { findUniqueBackupChildByTitle } from "../../../src/shared/notion-archive/archive.js";
import { notionRequest, notionStats } from "../../../src/shared/notion-archive/client.js";
import { NotionConfigError, notionEnv } from "../../../src/shared/notion-archive/env.js";
import { loadSupplementRows, normalizeSupplementText, readSupplementRowFully, SUPPLEMENT_DB_TITLE, SUPPLEMENT_PROPS, type SupplementRow } from "../../../src/shared/notion-archive/stock-supplement.js";
import { installCatchupDeadline } from "../../../scripts/sync/catchup-launch.js";
import { loadLatestDocs, qualifyBiztagArchiveSource, type BiztagSourceDb, type LatestDoc } from "../src/biztag/source.js";
import { hasUsableText, rowTextSyncReceipt } from "../src/biztag/plan.js";
import * as schema from "../src/db/schema.js";
import { readSavedEdinetZip, SavedEdinetZipQualificationError } from "../src/services/edinet/archive.js";
import { extractTextSections, matchesTextSection, TEXT_SECTIONS } from "../src/services/edinet/text-sections.js";
import { readVerifiedDocText } from "../src/services/text-backup.js";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const titles = TEXT_SECTIONS.map(s => s.title);
type Source = Awaited<ReturnType<typeof readSavedEdinetZip>>;
type Document = typeof schema.yuhoDocuments.$inferSelect;
type CellReason = "matched" | "source_value_missing_in_notion" | "source_target_absent" | "source_or_identity_insufficient" | "time_difference" | "unverified";
class AuditObservationChangedError extends Error {}
class AuditBodyDifferenceError extends Error {}
type AuditStage = "configuration" | "d1_latest" | "notion_database" | "notion_schema" | "existing_schema_missing" | "notion_rows" | "code_admission" |
  "notion_current39" | "d1_source_document" | "notion_saved_zip" | "notion_source_body" | "verify_current_snapshot";
class AuditConfigurationError extends Error {
  constructor(readonly keys: string[]) { super("audit_configuration_invalid"); }
}
class AuditSchemaMissingError extends Error {
  constructor(readonly keys: string[]) { super("audit_existing_schema_missing"); }
}
export function assertAuditSupplementSchema(properties: Record<string, { id: string }>) {
  const missing = Object.entries(SUPPLEMENT_PROPS).filter(([, title]) => typeof properties[title]?.id !== "string" || properties[title].id.length === 0).map(([key]) => key);
  missing.push(...TEXT_SECTIONS.filter(s => typeof properties[s.title]?.id !== "string" || properties[s.title].id.length === 0).map(s => `text:${s.key}`));
  if (missing.length > 0) throw new AuditSchemaMissingError(missing);
}
/** Validate typed accessors before the first HTTP; never print values or create missing configuration. */
export function auditConfiguration() {
  const invalid: string[] = [];
  const read = (key: string, getter: () => string | undefined) => {
    try { return getter(); } catch { invalid.push(key); return undefined; }
  };
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "D1_DATABASE_ID"] as const) read(key, sharedEnv[key]);
  for (const key of ["NOTION_TOKEN", "NOTION_ARCHIVE_PAGE_ID"] as const) read(key, notionEnv[key]);
  const supplementId = read("NOTION_STOCK_SUPPLEMENT_DB_ID", notionEnv.NOTION_STOCK_SUPPLEMENT_DB_ID);
  const parentPageId = supplementId === undefined ? read("NOTION_STOCK_INFO_PAGE_ID", notionEnv.NOTION_STOCK_INFO_PAGE_ID) : undefined;
  const textDbId = read("NOTION_YUHO_TEXT_DB_ID", notionEnv.NOTION_YUHO_TEXT_DB_ID);
  if (invalid.length > 0) throw new AuditConfigurationError(invalid);
  return { supplementId, parentPageId, textDbId: textDbId! };
}
/** Finite stage/code only. Raw error messages can contain URLs, SQL or credentials. */
export function auditFailure(stage: AuditStage, error: unknown) {
  if (error instanceof AuditConfigurationError) return { stage, code: "configuration_invalid", configKeys: error.keys };
  if (error instanceof AuditSchemaMissingError) return { stage: "existing_schema_missing" as const, code: "required_properties_missing", propertyKeys: error.keys };
  const codes = { audit_deadline: "deadline_exceeded", audit_request_limit: "request_limit",
    audit_source_get_forbidden: "read_only_guard", audit_mutation_forbidden: "read_only_guard", audit_notion_write_forbidden: "read_only_guard",
    audit_d1_write_forbidden: "read_only_guard", audit_post_forbidden: "read_only_guard" } as Record<string, string>;
  const guarded = error instanceof assert.AssertionError && Object.hasOwn(codes, error.message) ? codes[error.message] : undefined;
  return { stage, code: guarded === undefined ? error instanceof NotionConfigError ? "read_contract_invalid" : "read_failed" : guarded };
}
const normalize = (value: string | null) => { const v = normalizeSupplementText(value); return v === "" ? null : v; };
function texts39(values: ReadonlyArray<{ sectionKey: string; text: string }>): Record<string, string | null> {
  const result = Object.fromEntries(TEXT_SECTIONS.map(s => [s.title, null])) as Record<string, string | null>;
  const seen = new Set<string>();
  for (const value of values) {
    const def = TEXT_SECTIONS.find(s => s.key === value.sectionKey);
    assert(def && !seen.has(value.sectionKey) && typeof value.text === "string", "source_section_invalid");
    seen.add(value.sectionKey); result[def.title] = normalize(value.text);
  }
  return result;
}
function current39(row: SupplementRow) {
  return Object.fromEntries(titles.map(title => { assert(typeof row.texts[title] === "string", "current_39_incomplete"); return [title, normalize(row.texts[title])]; }));
}
function digest(texts: Record<string, string | null>) { return sha(JSON.stringify(TEXT_SECTIONS.map(s => [s.title, texts[s.title]]))); }

/** Explicitly rejects writes and new upstream sources, including any accidental ensure/create path. */
export function installReadOnlyAuditGuard(maxRequests: number, deadline: number) {
  const original = globalThis.fetch; let requests = 0;
  globalThis.fetch = async (input, init) => {
    assert(Date.now() < deadline, "audit_deadline"); assert(requests < maxRequests, "audit_request_limit");
    const request = input instanceof Request ? input : null;
    const url = new URL(request === null ? String(input) : request.url), method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    if (method === "GET") {
      assert(url.protocol === "https:" && !url.username && !url.password && (url.hostname === "api.notion.com" ||
        url.hostname === "file.notion.so" || url.hostname.endsWith(".notion.so") || url.hostname.endsWith(".notionso.com") ||
        url.hostname === "prod-files-secure.s3.us-west-2.amazonaws.com" || url.hostname === "s3.us-west-2.amazonaws.com"), "audit_source_get_forbidden");
    } else {
      assert(method === "POST" && typeof init?.body === "string", "audit_mutation_forbidden");
      if (url.hostname === "api.notion.com") assert(/^\/v1\/(?:search|databases\/[0-9a-f-]+\/query)$/.test(url.pathname), "audit_notion_write_forbidden");
      else {
        assert(url.hostname === "api.cloudflare.com" && /^\/client\/v4\/accounts\/[^/]+\/d1\/database\/[^/]+\/query$/.test(url.pathname), "audit_post_forbidden");
        const body = JSON.parse(init.body) as { sql?: unknown };
        assert(typeof body.sql === "string" && /^\s*select\b/i.test(body.sql) && !body.sql.includes(";"), "audit_d1_write_forbidden");
      }
    }
    requests++; return original(input, init);
  };
  return { count: () => requests, restore: () => { globalThis.fetch = original; } };
}

export function parseAuditArgs(argv: string[]) {
  const { values } = parseArgs({ args: argv, strict: true, options: { codes: { type: "string" }, "out-dir": { type: "string" },
    "budget-min": { type: "string" }, "max-requests": { type: "string", default: "800" } } });
  const codes = values.codes?.split(",");
  assert(codes && codes.length > 0 && codes.length <= 50 && new Set(codes).size === codes.length && codes.every(code => parseStockCode(code) === code), "fixed_1_to_50_codes_required");
  const budgetMs = Number(values["budget-min"]) * 60_000, maxRequests = Number(values["max-requests"]);
  assert(Number.isSafeInteger(budgetMs) && budgetMs > 0 && budgetMs <= 15 * 60_000, "explicit_budget_1_to_15_min_required");
  assert(Number.isSafeInteger(maxRequests) && maxRequests > 0 && maxRequests <= 2000, "invalid_request_limit");
  assert(values["out-dir"] && values["out-dir"].trim() !== "", "private_new_output_directory_required");
  return { codes, budgetMs, maxRequests, outDir: resolve(values["out-dir"]) };
}

/** Same active/latest/reported-HOLD and strict saved body qualification as normal publishing; extra ZIP evidence is read-only. */
export function qualifyAuditSource(latest: LatestDoc, document: Document, source: Source) {
  const { rows, sections } = qualifyBiztagArchiveSource(latest, document, source);
  return { rows, sections, texts: texts39(sections) };
}

export function classifyAuditCells(current: Record<string, string | null>, source: ReturnType<typeof qualifyAuditSource> | null,
  blocked?: Exclude<CellReason, "matched" | "source_value_missing_in_notion" | "source_target_absent">) {
  return TEXT_SECTIONS.map(section => {
    const actual = current[section.title], expected = source === null ? null : source.texts[section.title];
    let reason: CellReason;
    if (blocked !== undefined) reason = blocked;
    else if (source === null) reason = "unverified";
    else if (expected !== null) reason = actual === expected ? "matched" : actual === null ? "source_value_missing_in_notion" : "unverified";
    else if (actual !== null) reason = "unverified";
    else reason = source.rows.some(row => matchesTextSection(row, section)) ? "unverified" : "source_target_absent";
    return { sectionKey: section.key, title: section.title, reason, currentText: actual, sourceText: expected,
      currentSha256: sha(JSON.stringify(actual)), sourceSha256: source === null ? null : sha(JSON.stringify(expected)) };
  });
}

export async function auditOne(latest: LatestDoc, row: SupplementRow, dependencies: {
  readDocument: () => Promise<Document[]>; readSource: typeof readSavedEdinetZip; readBody: typeof readVerifiedDocText;
  assertCurrent: () => Promise<void>; textDbId: string;
}) {
  const current = current39(row);
  let source: ReturnType<typeof qualifyAuditSource> | null = null;
  let sourceProof: { pageId: string; zipSha256: string; byteLength: number; originalManifest: Source["originalManifest"];
    metadataSha256: string; all39Sha256: string; sections: ReturnType<typeof extractTextSections> } | null = null;
  let blocked: "time_difference" | "source_or_identity_insufficient" | "unverified" | undefined, detail: string | null = null;
  let stage: AuditStage = "d1_source_document", failure: ReturnType<typeof auditFailure> | null = null;
  let pointer: string | null = null, syncDocId: string | null = null;
  try { const receipt = rowTextSyncReceipt(row); if (receipt !== null) { pointer = receipt.textPageId; syncDocId = receipt.docId; } }
  catch { /* No invented receipt; exact source/body evidence below is still required. */ }
  if (latest.reportedHoldReason !== undefined || !hasUsableText(latest.doc)) {
    blocked = "source_or_identity_insufficient"; detail = "latest_source_not_qualified";
  } else if (row.stockCode !== latest.stockCode || row.docId !== latest.doc.docId ||
      pointer !== null && (pointer !== latest.doc.notionDocPageId || syncDocId !== latest.doc.docId)) {
    blocked = "time_difference"; detail = "current_doc_or_sync_pointer_differs";
  } else if (pointer === null) {
    blocked = "source_or_identity_insufficient"; detail = "current_sync_lineage_missing_or_malformed";
  } else {
    try {
      const documents = await dependencies.readDocument(); assert(documents.length === 1, "document_not_unique");
      stage = "notion_saved_zip";
      const saved = await dependencies.readSource(latest.doc.docId, 5);
      source = qualifyAuditSource(latest, documents[0], saved);
      sourceProof = { pageId: saved.pageId, zipSha256: saved.sha256, byteLength: saved.bytes.length, originalManifest: saved.originalManifest,
        metadataSha256: sha(JSON.stringify(saved.metadata)), all39Sha256: digest(source.texts), sections: source.sections };
      stage = "notion_source_body";
      const body = await dependencies.readBody({ dbId: dependencies.textDbId, rowPageId: latest.doc.notionDocPageId,
        stockCode: latest.stockCode, docId: latest.doc.docId, d1DocumentId: documents[0].id, fiscalYearEnd: latest.doc.periodEnd,
        textParseStatus: "ok", sectionCount: source.sections.length, charCount: source.sections.reduce((n, s) => n + [...s.text].length, 0) });
      if (JSON.stringify(body.map(s => [s.sectionKey, s.itemName, s.text])) !== JSON.stringify(source.sections.map(s => [s.sectionKey, s.itemName, s.text]))) {
        throw new AuditBodyDifferenceError("saved_body_parser_difference");
      }
      stage = "verify_current_snapshot"; await dependencies.assertCurrent();
    } catch (error) {
      failure = auditFailure(stage, error);
      blocked = error instanceof AuditObservationChangedError ? "time_difference" :
        error instanceof SavedEdinetZipQualificationError || error instanceof assert.AssertionError ? "source_or_identity_insufficient" : "unverified";
      detail = error instanceof AuditBodyDifferenceError || error instanceof AuditObservationChangedError || error instanceof SavedEdinetZipQualificationError ? error.message :
        error instanceof assert.AssertionError ? error.message.split("\n")[0] : "unknown_read_failure";
    }
  }
  return { stockCode: latest.stockCode, supplementPageId: row.pageId, currentDocId: row.docId, syncDocId, syncTextPageId: pointer,
    latestDoc: latest.doc, observedAt: new Date().toISOString(), current39Sha256: digest(current), source: sourceProof, detail, failure,
    cells: classifyAuditCells(current, source, blocked) };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseAuditArgs(argv), startedAt = new Date().toISOString(), deadline = Date.now() + options.budgetMs;
  mkdirSync(options.outDir, { mode: 0o700 }); // New, private directory only; never replace an old report.
  const restoreDeadline = installCatchupDeadline(deadline), guard = installReadOnlyAuditGuard(options.maxRequests, deadline);
  let stage: AuditStage = "configuration";
  const report: { version: number; startedAt: string; codes: string[]; results: Awaited<ReturnType<typeof auditOne>>[];
    unverified: Array<{ stockCode: string; reason: string; failure?: ReturnType<typeof auditFailure> }>; stopped: boolean; failure: ReturnType<typeof auditFailure> | null } =
    { version: 1, startedAt, codes: options.codes, results: [], unverified: [], stopped: false, failure: null };
  try {
    const configuration = auditConfiguration();
    const db = createD1HttpDb(schema) as unknown as BiztagSourceDb;
    stage = "d1_latest";
    const latest = await loadLatestDocs(db, options.codes);
    stage = "notion_database";
    const supplementId = configuration.supplementId === undefined ? await findUniqueBackupChildByTitle({ parentPageId: configuration.parentPageId!, title: SUPPLEMENT_DB_TITLE, kind: "database" }) : configuration.supplementId;
    assert(supplementId !== null, "existing_supplement_db_required");
    stage = "notion_schema";
    const structure = await notionRequest<{ properties: Record<string, { id: string }> }>("GET", `/databases/${supplementId}`);
    assertAuditSupplementSchema(structure.properties);
    stage = "notion_rows";
    const rows = await loadSupplementRows(supplementId, Object.fromEntries(Object.entries(structure.properties).map(([name, value]) => [name, value.id])), { codes: options.codes });
    for (const code of options.codes) {
      if (Date.now() >= deadline || guard.count() >= options.maxRequests) {
        report.stopped = true; report.failure = { stage: "code_admission", code: Date.now() >= deadline ? "deadline_exceeded" : "request_limit" }; break;
      }
      const selected = latest.find(s => s.stockCode === code), row = rows.find(s => s.stockCode === code);
      if (!selected || !row) { report.unverified.push({ stockCode: code, reason: selected ? "supplement_row_missing" : "not_in_current_active_scope" }); continue; }
      try {
        stage = "notion_current39";
        const full = await readSupplementRowFully(row.pageId, supplementId, titles, () => assert(Date.now() < deadline, "audit_deadline"));
        assert(full.stockCode === code && full.pageId === row.pageId, "current_identity_changed");
        report.results.push(await auditOne(selected, full, {
          readDocument: () => db.select().from(schema.yuhoDocuments).where(eq(schema.yuhoDocuments.docId, selected.doc!.docId)).limit(2),
          readSource: readSavedEdinetZip, readBody: readVerifiedDocText, textDbId: configuration.textDbId,
          assertCurrent: async () => {
            if (JSON.stringify(await loadLatestDocs(db, [code])) !== JSON.stringify([selected])) throw new AuditObservationChangedError("latest_changed_during_read");
            const after = await readSupplementRowFully(row.pageId, supplementId, titles, () => assert(Date.now() < deadline, "audit_deadline"));
            if (after.stockCode !== full.stockCode || after.docId !== full.docId || after.judgeInput !== full.judgeInput ||
              after.textSyncReceipt !== full.textSyncReceipt || digest(current39(after)) !== digest(current39(full))) throw new AuditObservationChangedError("current_changed_during_read");
          },
        }));
      } catch (error) { report.unverified.push({ stockCode: code, reason: "current_read_incomplete", failure: auditFailure(stage, error) }); }
    }
  } catch (error) { report.stopped = true; report.failure = auditFailure(stage, error); }
  finally { guard.restore(); restoreDeadline(); }
  const observedCodes = new Set([...report.results.map(r => r.stockCode), ...report.unverified.map(r => r.stockCode)]);
  const cellCounts: Record<string, number> = {}, blankCounts: Record<string, number> = {};
  for (const result of report.results) for (const cell of result.cells) {
    cellCounts[cell.reason] = (cellCounts[cell.reason] ?? 0) + 1;
    if (cell.currentText === null) blankCounts[cell.reason] = (blankCounts[cell.reason] ?? 0) + 1;
  }
  const body = JSON.stringify({ ...report, toolSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
    unstartedCodes: options.codes.filter(code => !observedCodes.has(code)),
    finishedAt: new Date().toISOString(), requests: guard.count(), notion: notionStats(),
    cellCounts, blankCounts,
    completedCodes: report.results.length + report.unverified.length, businessWrites: 0, upstreamDownloads: 0, modelCalls: 0,
    historical7074Reconstruction: false, wholeSupplementComplete: false }, null, 2) + "\n";
  writeFileSync(resolve(options.outDir, "report.json"), body, { flag: "wx", mode: 0o600 });
  console.info(JSON.stringify({ reportSha256: sha(body), codes: options.codes.length, observedCodes: report.results.length,
    unverifiedCodes: report.unverified.length, stopped: report.stopped, failure: report.failure, cellCounts, blankCounts, requests: guard.count(), businessWrites: 0, modelCalls: 0 }));
  return report.stopped || report.unverified.length > 0 || Object.keys(cellCounts).some(key => !["matched", "source_target_absent"].includes(key)) ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await main(); } catch { console.error("supplement_text_audit_stopped"); process.exitCode = 2; }
}
