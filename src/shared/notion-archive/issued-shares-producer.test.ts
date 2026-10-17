/** Actual saved ZIP through normal publisher/reader; Notion is a protocol boundary, no live HTTP. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { observeIssuedShares } from "../../../services/yuho-quant/src/services/edinet/issued-shares.js";
import { notionRequest } from "./client.js";
import { queryUniqueRow, recordPrimaryData } from "./archive.js";
vi.mock("./client.js", async original => ({ ...await original<typeof import("./client.js")>(), notionRequest: vi.fn() }));
vi.mock("./archive.js", () => ({ findUniqueBackupChildByTitle: vi.fn(async () => "d".repeat(32)), queryUniqueRow: vi.fn(), recordPrimaryData: vi.fn() }));
vi.mock("./env.js", () => ({ notionEnv: { NOTION_ARCHIVE_PAGE_ID: () => "a".repeat(32), NOTION_STOCK_HOLDINGS_DB_ID: () => "h".repeat(32) } }));
vi.mock("./page-file.js", () => ({ listPageFiles: vi.fn(async () => [{ name: "S100X7D0_xbrl.zip", kind: "file", url: "https://example.invalid/protocol-only" }]) }));
vi.mock("./archived-download.js", () => ({ downloadArchivedFile: vi.fn(async () => zip) }));
const zip = readFileSync(new URL("../../../services/yuho-quant/src/tests/fixtures/issued-shares-9252-S100X7D0.zip", import.meta.url));
const source = { docId: "S100X7D0", stockCode: "9252", edinetCode: "E37098", fiscalYearEnd: "2025-08-31" };
const filingDateEvidence = { rawSubmitDateTime: "2025-11-28 10:39", provenance: "same-edinet-document" as const };
const archivePageId = "a".repeat(32), zipSha256 = createHash("sha256").update(zip).digest("hex");
const rich = (value: string) => ({ type: "rich_text", rich_text: [{ type: "text", text: { content: value }, plain_text: value }] });
let page: Record<string, unknown>;
function protocolProperties(properties: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(properties).map(([name, raw]) => {
    const value = raw as Record<string, unknown>, type = Object.keys(value)[0];
    return [name, { type, ...value, ...(type === "rich_text" ? { rich_text: (value.rich_text as Array<{ text: { content: string } }>).map(p => ({ ...p, type: "text", plain_text: p.text.content })) } : {}) }];
  }));
}
beforeEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks(); vi.resetModules();
  page = { object: "page", id: archivePageId, parent: { type: "database_id", database_id: "d".repeat(32) }, archived: false, in_trash: false,
    properties: { Key: { type: "title", title: [{ type: "text", text: { content: "S100X7D0:type1" }, plain_text: "S100X7D0:type1" }] },
      Metadata: rich(JSON.stringify({ docID: source.docId, edinetCode: source.edinetCode, secCode: "92520", periodEnd: source.fiscalYearEnd, submitDateTime: filingDateEvidence.rawSubmitDateTime, edinetDocType: 1 })),
      "Fetched At": { date: { start: "2025-11-28T10:39:00.000+00:00" } } } };
  vi.mocked(queryUniqueRow).mockImplementation(async () => structuredClone(page) as never);
  vi.mocked(notionRequest).mockImplementation(async (method, path, body) => {
    if (method === "POST" && path === `/databases/${"d".repeat(32)}/query`) {
      expect(body).toEqual({ filter: { property: "保有明細状態", select: { equals: "実行中（結果未確定）" } },
        sorts: [{ timestamp: "created_time", direction: "ascending" }], page_size: 6 });
      return { object: "list", results: [], has_more: false, next_cursor: null } as never;
    }
    if (method === "GET" && path === `/databases/${"d".repeat(32)}`) return { properties: Object.fromEntries(["保有明細", "保有価格"].flatMap(phase => [
      [`${phase}状態`, { type: "select" }], [`${phase}理由`, { type: "rich_text" }], [`${phase}再開情報`, { type: "rich_text" }],
    ])) } as never;
    if (path !== `/pages/${archivePageId}`) throw new Error(`unexpected protocol request ${method} ${path}`);
    if (method === "PATCH") page.properties = { ...page.properties as object, ...protocolProperties((body as { properties: Record<string, unknown> }).properties) };
    else if (method !== "GET") throw new Error("unexpected protocol method");
    return structuredClone(page) as never;
  });
});
describe("発行株数観測の正常producerと保存reader", () => {
  it("実正常原本の全明細値を保持し、既存1展開と同じ再開PATCH/readbackへ診断を載せる", async () => {
    const zipReader = await import("../../../services/yuho-quant/src/services/edinet/zip.js");
    const { publishVerifiedShareholdings } = await import("./shareholdings.js");
    const unzip = vi.spyOn(zipReader, "unzip");
    const result = await publishVerifiedShareholdings({ source, ownerName: "株式会社ラストワンマイル", zip, archivePageId, maxRows: 0, observeIssuedShares: true, issuedSharesFilingDateEvidence: filingDateEvidence });
    expect(result).toMatchObject({ status: "held", parsed: 1 });
    expect(unzip).toHaveBeenCalledTimes(1);
    const expected = observeIssuedShares(zip, source, filingDateEvidence, unzip.mock.results[0].value!);
    expect(result.issuedSharesObservation).toEqual(expected);
    const props = page.properties as Record<string, ReturnType<typeof rich>>;
    const info = JSON.parse(props["保有明細再開情報"].rich_text.map(p => p.plain_text).join(""));
    expect(info.issuedSharesObservation).toEqual(expected); expect(info.zipSha256).toBe(zipSha256); expect(info.sourceNextHoldingOffset).toBe(0);
    expect(notionRequest).toHaveBeenCalledTimes(6);
    expect(vi.mocked(notionRequest).mock.calls.filter(([method]) => method === "PATCH")).toHaveLength(1);
    expect(recordPrimaryData).not.toHaveBeenCalled();
  });
  it.each([["mismatch", true], ["unassigned", true], ["mismatch", undefined], ["unassigned", undefined]] as const)("DEI %s/full=%s は診断HOLDに加え、保有明細の公開も止める", async (mode, observeIssuedShares) => {
    const zipReader = await import("../../../services/yuho-quant/src/services/edinet/zip.js");
    const entries = zipReader.unzip(zip);
    if (mode === "unassigned") for (const [name, bytes] of entries) if (name.endsWith(".xbrl")) entries.set(name, Buffer.from(bytes.toString("utf8").replace(/(<[^:<>]+:SecurityCodeDEI\b[^>]*>)92520(<\/[^:<>]+:SecurityCodeDEI>)/, (_all, before, after) => `${before}00000${after}`)));
    vi.spyOn(zipReader, "unzip").mockReturnValue(entries);
    const { publishVerifiedShareholdings } = await import("./shareholdings.js");
    const result = await publishVerifiedShareholdings({ source: mode === "mismatch" ? { ...source, stockCode: "7203" } : source, ownerName: "株式会社ラストワンマイル", zip, archivePageId, maxRows: 100, observeIssuedShares });
    expect(result).toMatchObject({ status: "held", parsed: 0, issuedSharesObservation: { status: "held", sourceQualification: { status: "held" } } });
    expect(result.issuedSharesObservation!.reason).not.toBeNull(); expect(notionRequest).toHaveBeenCalledTimes(5);
    expect(vi.mocked(notionRequest).mock.calls.filter(([method, path]) => method === "POST" && !path.endsWith("/query") || path.startsWith("/databases/") && method !== "GET" && !path.endsWith("/query"))).toHaveLength(0);
    expect(recordPrimaryData).not.toHaveBeenCalled();
  });
  it("Worker型の未有効callerは共通DEIだけを通り、full観測を呼ばずtyped未観測を返す", async () => {
    const zipReader = await import("../../../services/yuho-quant/src/services/edinet/zip.js");
    const observer = await import("../../../services/yuho-quant/src/services/edinet/issued-shares.js");
    const full = vi.spyOn(observer, "observeIssuedShares").mockImplementation(() => { throw new Error("full observation forbidden"); });
    const unzip = vi.spyOn(zipReader, "unzip");
    const { publishVerifiedShareholdings } = await import("./shareholdings.js");
    const result = await publishVerifiedShareholdings({ source, ownerName: "株式会社ラストワンマイル", zip, archivePageId, maxRows: 0 });
    expect(result.issuedSharesObservation).toMatchObject({ status: "not-observed", sourceQualification: { status: "verified" }, observations: null, candidateCount: null });
    expect(result.issuedSharesObservation!.reason).toContain("有効化していません");
    expect(full).not.toHaveBeenCalled(); expect(unzip).toHaveBeenCalledTimes(1); expect(notionRequest).toHaveBeenCalledTimes(6);
  });
  it("保存prepareは既存DEI展開を再利用し、追加upload/PATCH/sourceなしで同じ観測を返す", async () => {
    const zipReader = await import("../../../services/yuho-quant/src/services/edinet/zip.js");
    const { readSavedHoldingsZip } = await import("./shareholdings.js");
    const unzip = vi.spyOn(zipReader, "unzip");
    const saved = await readSavedHoldingsZip(source, undefined, { observeIssuedShares: true });
    if (saved.status !== "ready") throw new Error(saved.reason); expect(saved.status).toBe("ready");
    expect(unzip).toHaveBeenCalledTimes(1);
    expect(saved.issuedSharesObservation).toEqual(observeIssuedShares(zip, source, { ...filingDateEvidence, provenance: "saved-archive-metadata" }, unzip.mock.results[0].value!));
    expect(saved.originalManifest).toBe("unknown"); expect(saved.sha256).toBe(zipSha256);
    expect(notionRequest).not.toHaveBeenCalled(); expect(recordPrimaryData).not.toHaveBeenCalled();
  });
});
