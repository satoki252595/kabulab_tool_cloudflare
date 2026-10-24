/** Actual public 6963 CSV/body; surrounding current Notion/archive envelopes are explicit offline protocol controls. */
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { assertAuditSupplementSchema, auditFailure, auditOne, classifyAuditCells, installReadOnlyAuditGuard, main, parseAuditArgs, qualifyAuditSource } from "./audit-supplement-texts.js";
import { NotionConfigError } from "../../../src/shared/notion-archive/env.js";
import { TEXT_SECTIONS } from "../src/services/edinet/text-sections.js";
import { withTextSyncReceipt, type TextSyncReceipt } from "../src/biztag/plan.js";
import type { LatestDoc } from "../src/biztag/source.js";
import { SUPPLEMENT_PROPS, type SupplementRow } from "../../../src/shared/notion-archive/stock-supplement.js";
import type { yuhoDocuments } from "../src/db/schema.js";

const fixture = new URL("../src/tests/fixtures/ingest-csv-reingest-6963/", import.meta.url);
const saved = JSON.parse(readFileSync(new URL("saved-business.json", fixture), "utf8"));
const raw = saved.d1.yuho_documents[0];
const document: typeof yuhoDocuments.$inferSelect = Object.fromEntries(Object.entries(raw).map(([key, value]) =>
  [key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), ["submitted_at", "ingested_at"].includes(key) ? new Date(Number(value) * 1000) : value])) as typeof yuhoDocuments.$inferSelect;
const bytes = readFileSync(new URL("S100YF41-csv.zip", fixture));
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const source = { pageId: saved.item.archivePageId, bytes, sha256: sha(bytes), metadata: { ...saved.sourceMetadata, edinetDocType: 5 }, originalManifest: "unknown" as const };
const latest: LatestDoc = { stockCode: saved.item.stockCode, companyName: saved.sourceMetadata.filerName, sector33: null,
  doc: { docId: document.docId, docTypeCode: "120", periodEnd: document.periodEnd, submittedAt: document.submittedAt.toISOString(),
    notionDocPageId: document.notionDocPageId, textParseStatus: "ok" } };
const parsed = qualifyAuditSource(latest, document, source);
const body = JSON.parse(gunzipSync(readFileSync(new URL("sections.json.gz", fixture))).toString("utf8"));
const receipt: TextSyncReceipt = { docId: document.docId, textPageId: document.notionDocPageId!, textsSha256: sha(JSON.stringify(TEXT_SECTIONS.map(s => [s.title, parsed.texts[s.title]]))) };
const row: SupplementRow = { pageId: saved.item.archivePageId, stockCode: latest.stockCode, companyName: latest.companyName,
  sector33: null, docId: document.docId, docType: "有報", periodEnd: document.periodEnd, submittedAt: document.submittedAt.toISOString(),
  textStatus: "取得済", tagStatus: null, tagDoc: null, vocabVersion: null, judgedAt: null, candidateCount: null,
  judgeInput: withTextSyncReceipt(null, receipt), attempts: null, nextRetryAt: null, error: null, upstream: [], downstream: [], distribution: [], themes: [],
  uncertain: null, evidenceText: null, masterLinked: false, texts: Object.fromEntries(TEXT_SECTIONS.map(s => {
    const value = parsed.texts[s.title]; return [s.title, value === null ? "" : value];
  })) };
const deps = () => ({ readDocument: vi.fn(async () => [document]), readSource: vi.fn(async () => source), readBody: vi.fn(async () => body),
  assertCurrent: vi.fn(async () => {}), textDbId: saved.item.archivePageId });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("joins all37 actual sections and39 current cells; missing target is not a non-disclosure claim", async () => {
  expect(source.sha256).toBe("b1f127e76e1d32fe540b48d3c9c162d2470ff6b7399072b665837472cba34fb0");
  expect(parsed.sections).toHaveLength(37);
  const d = deps(), result = await auditOne(latest, row, d);
  expect(result.detail).toBeNull(); expect(result.cells).toHaveLength(39);
  expect(result.cells.filter(c => c.reason === "matched")).toHaveLength(37);
  expect(result.cells.filter(c => c.reason === "source_target_absent")).toHaveLength(2);
  expect(d.readSource).toHaveBeenCalledWith("S100YF41", 5); expect(d.assertCurrent).toHaveBeenCalledOnce();
  expect(result.source).toMatchObject({ zipSha256: source.sha256, originalManifest: "unknown" });
});

it("a cleared actual current value is a qualified omission; a matched empty element remains unverified", async () => {
  const altered = structuredClone(row); altered.texts["事業の内容"] = "";
  const result = await auditOne(latest, altered, deps());
  expect(result.cells.find(c => c.sectionKey === "business")?.reason).toBe("source_value_missing_in_notion");
  const absent = TEXT_SECTIONS.find(s => parsed.texts[s.title] === null)!;
  // Empty-value projection of an actual CSV row, testing only target-presence vs parser result.
  const candidate = { ...parsed.rows[0], elementId: "jpcrp_cor:AuditControlTextBlock", itemName: absent.title, value: "" };
  const inspected = { ...parsed, rows: [...parsed.rows, candidate] };
  expect(classifyAuditCells(parsed.texts, inspected).find(c => c.sectionKey === absent.key)?.reason).toBe("unverified");
});

it.each(["legacy", "independent"] as const)("reads the shared %s receipt without changing tag lineage", async kind => {
  const current = { ...row, ...(kind === "independent" ? { judgeInput: null, textSyncReceipt: JSON.stringify(receipt) } : {}) };
  const before = JSON.stringify(current), result = await auditOne(latest, current, deps());
  expect(result.detail).toBeNull(); expect(result.syncTextPageId).toBe(document.notionDocPageId); expect(JSON.stringify(current)).toBe(before);
});

it("missing lineage, reported hold, issuer mismatch and body drift cannot prove source absence", async () => {
  const d = deps();
  expect((await auditOne(latest, { ...row, judgeInput: null }, d)).cells.every(c => c.reason === "source_or_identity_insufficient")).toBe(true);
  expect(d.readSource).not.toHaveBeenCalled();
  expect((await auditOne({ ...latest, reportedHoldReason: "declared qualification hold control" }, row, d)).cells.every(c => c.reason === "source_or_identity_insufficient")).toBe(true);
  const changed = { ...source, metadata: { ...source.metadata, secCode: null } };
  const mismatch = await auditOne(latest, row, { ...deps(), readSource: vi.fn(async () => changed) });
  expect(mismatch.cells.every(c => c.reason === "source_or_identity_insufficient")).toBe(true);
  const difference = await auditOne(latest, row, { ...deps(), readBody: vi.fn(async () => []) });
  expect(difference.cells.every(c => c.reason === "unverified")).toBe(true); expect(difference.detail).toBe("saved_body_parser_difference");
});

it("different document/pointer and concurrent current changes stay time differences; failed reads stay unverified", async () => {
  const d = deps();
  const changed = await auditOne(latest, { ...row, docId: null }, d);
  expect(changed.cells.every(c => c.reason === "time_difference")).toBe(true); expect(d.readSource).not.toHaveBeenCalled();
  const failed = await auditOne(latest, row, { ...deps(), readSource: vi.fn(async () => { throw new Error("declared read fault"); }) });
  expect(failed.cells.every(c => c.reason === "unverified")).toBe(true); expect(failed.detail).toBe("unknown_read_failure");
});

it("guards actual send boundary: SELECT/query/hostedGET only, no source or business mutation, finite requests", async () => {
  const fetch = vi.fn(async () => new Response("{}")); vi.stubGlobal("fetch", fetch);
  const guard = installReadOnlyAuditGuard(3, Date.now() + 60_000);
  try {
    await expect(globalThis.fetch("https://api.notion.com/v1/pages", { method: "POST", body: "{}" })).rejects.toThrow("audit_notion_write_forbidden");
    await expect(globalThis.fetch("https://api.edinet-fsa.go.jp/api/v2/documents/S100YF41?type=5")).rejects.toThrow("audit_source_get_forbidden");
    const d1 = "https://api.cloudflare.com/client/v4/accounts/control/d1/database/control/query";
    await expect(globalThis.fetch(d1, { method: "POST", body: JSON.stringify({ sql: "DELETE FROM yuho_documents" }) })).rejects.toThrow("audit_d1_write_forbidden");
    expect(fetch).not.toHaveBeenCalled();
    await globalThis.fetch(d1, { method: "POST", body: JSON.stringify({ sql: "select doc_id from yuho_documents where doc_id=?", params: [document.docId] }) });
    await globalThis.fetch("https://api.notion.com/v1/databases/3f9d74ff-84cd-81b7-be46-f73620c34cd2/query", { method: "POST", body: "{}" });
    await globalThis.fetch("https://file.notion.so/control");
    await expect(globalThis.fetch("https://api.notion.com/v1/pages/control")).rejects.toThrow("audit_request_limit");
    expect(fetch).toHaveBeenCalledTimes(3); expect(guard.count()).toBe(3);
  } finally { guard.restore(); }
  const expired = installReadOnlyAuditGuard(3, Date.now());
  try { await expect(globalThis.fetch("https://api.notion.com/v1/pages/control")).rejects.toThrow("audit_deadline"); }
  finally { expired.restore(); }
});

it("requires a fixed finite explicit scope and budget before dependencies/network", () => {
  expect(parseAuditArgs(["--codes=6963", "--out-dir=tmp/private-control", "--budget-min=1"]).codes).toEqual(["6963"]);
  for (const args of [[], ["--codes=6963,6963"], ["--codes="], ["--codes=6963", "--budget-min=16"],
    [`--codes=${Array.from({ length: 51 }, (_, i) => String(1300 + i)).join(",")}`]]) {
    expect(() => parseAuditArgs([...args, "--out-dir=tmp/private-control"])).toThrow();
  }
});

it("missing Notion IDs are classified before D1/Notion HTTP; report is private and old evidence cannot be replaced", async () => {
  // Explicit configuration-only control, never sent to a service.
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "D1_DATABASE_ID", "NOTION_TOKEN"]) vi.stubEnv(key, "protocol-config-control");
  vi.stubEnv("NOTION_ARCHIVE_PAGE_ID", saved.item.archivePageId);
  for (const key of ["NOTION_STOCK_SUPPLEMENT_DB_ID", "NOTION_STOCK_INFO_PAGE_ID", "NOTION_YUHO_TEXT_DB_ID"]) vi.stubEnv(key, "");
  const fetch = vi.fn(() => { throw new Error("network forbidden"); }); vi.stubGlobal("fetch", fetch);
  const output = vi.spyOn(console, "info").mockImplementation(() => {});
  const base = mkdtempSync(join(tmpdir(), "field-audit-config-")), out = join(base, "actual");
  const args = ["--codes=6963", "--budget-min=1", `--out-dir=${out}`];
  try {
    expect(await main(args)).toBe(1); expect(fetch).not.toHaveBeenCalled();
    const reportBytes = readFileSync(join(out, "report.json"), "utf8"), report = JSON.parse(reportBytes);
    expect(report.failure).toEqual({ stage: "configuration", code: "configuration_invalid", configKeys: ["NOTION_STOCK_INFO_PAGE_ID", "NOTION_YUHO_TEXT_DB_ID"] });
    expect(report).toMatchObject({ stopped: true, requests: 0, results: [], unstartedCodes: ["6963"] });
    expect(statSync(out).mode & 0o777).toBe(0o700); expect(statSync(join(out, "report.json")).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(output.mock.calls)).not.toContain("protocol-config-control");
    await expect(main(args)).rejects.toThrow(); expect(readFileSync(join(out, "report.json"), "utf8")).toBe(reportBytes);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

it("stage/error codes never serialize upstream errors, signed URLs, SQL or secret values", () => {
  const sensitive = "https://file.notion.so/control?signature=protocol-secret SELECT confidential";
  expect(auditFailure("d1_latest", new Error(sensitive))).toEqual({ stage: "d1_latest", code: "read_failed" });
  expect(auditFailure("notion_schema", new NotionConfigError(sensitive))).toEqual({ stage: "notion_schema", code: "read_contract_invalid" });
});

it("legacy schema missing the three nullable lineage columns stops honestly before querying current rows", () => {
  // Property schema boundary projection only; no Notion row values or added columns are persisted.
  const properties = Object.fromEntries([...Object.values(SUPPLEMENT_PROPS), ...TEXT_SECTIONS.map(s => s.title)].map(name => [name, { id: name }]));
  expect(() => assertAuditSupplementSchema(properties)).not.toThrow();
  for (const key of ["textSyncReceipt", "textInputSha256", "tagInputSha256"] as const) delete properties[SUPPLEMENT_PROPS[key]];
  let failure;
  try { assertAuditSupplementSchema(properties); } catch (error) { failure = auditFailure("notion_schema", error); }
  expect(failure).toEqual({ stage: "existing_schema_missing", code: "required_properties_missing", propertyKeys: ["textSyncReceipt", "textInputSha256", "tagInputSha256"] });
});
