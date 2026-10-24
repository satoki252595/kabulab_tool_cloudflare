/** Legacy custody migration requires qualified nonzero holdings or a requalified typed absence. */
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyLatestHoldings, prepareLatestHoldings } from "./backfill-shareholdings.js";
import { parseShareholdingsData, type ShareholdingsSource, type ShareholdingsNotApplicable } from "../src/services/edinet/shareholdings.js";
import { HoldingsPriceIndex, qualifyHoldingValuation } from "../src/services/edinet/shareholdings-valuation.js";
import { selectLatestHoldingsDocuments } from "./lib/shareholdings-backfill.js";
import { readSavedHoldingsZip, publishVerifiedShareholdings } from "../../../src/shared/notion-archive/shareholdings.js";
import { recordEdinetZip } from "../src/services/edinet/archive.js";
import { verifyArchivedAttachments } from "../../../src/shared/notion-archive/readback.js";
import { observeIssuedShares } from "../src/services/edinet/issued-shares.js";
vi.mock("../../../src/shared/db/d1-http-client.js", () => ({ createD1HttpDb: vi.fn(() => ({})) }));
vi.mock("./lib/shareholdings-backfill.js", () => ({ selectLatestHoldingsDocuments: vi.fn() }));
vi.mock("../../../src/shared/notion-archive/shareholdings.js", async original => ({ ...await original<typeof import("../../../src/shared/notion-archive/shareholdings.js")>(), readSavedHoldingsZip: vi.fn(), publishVerifiedShareholdings: vi.fn() }));
vi.mock("../../../src/shared/notion-archive/readback.js", () => ({ verifyArchivedAttachments: vi.fn() }));
vi.mock("../src/services/edinet/archive.js", () => ({ recordEdinetZip: vi.fn(), edinetArchiveFilename: (doc: string) => `${doc}_xbrl.zip` }));
vi.mock("../../../scripts/notion/shareholdings.js", async original => ({ ...await original<typeof import("../../../scripts/notion/shareholdings.js")>(), guardedHoldingsMutation: async (_path: string, _label: string, execute: () => Promise<unknown>) => execute() }));
vi.mock("../src/services/edinet/shareholdings.js", async original => ({ ...await original<typeof import("../src/services/edinet/shareholdings.js")>(), parseShareholdingsData: vi.fn() }));
vi.mock("../src/services/edinet/shareholdings-valuation.js", () => ({
  HoldingsPriceIndex: vi.fn(function () {}), parseHoldingsCodeList: vi.fn(() => ({ asOf: "2026-06-30", byLegalName: new Map() })),
  qualifyHoldingValuation: vi.fn(),
}));
const source = { docId: "S100STRUCTURAL", stockCode: "1001", edinetCode: "E00001", fiscalYearEnd: "2026-03-31" };
const bytes = Buffer.from("Protocol test only; source parser covered in separate suites");
const sha = createHash("sha256").update(bytes).digest("hex");
const parserSourceSha256 = createHash("sha256").update(readFileSync(new URL("../src/services/edinet/shareholdings.ts", import.meta.url))).digest("hex");
const issuedSharesSourceSha256 = createHash("sha256").update(readFileSync(new URL("../src/services/edinet/issued-shares.ts", import.meta.url))).digest("hex");
const metadata = { docID: source.docId, edinetCode: source.edinetCode, secCode: "10010", periodEnd: source.fiscalYearEnd };
let dir: string;
function fixture(status = "ready", rows = 2) {
  const zipPath = join(dir, "saved.zip"); writeFileSync(zipPath, bytes);
  writeFileSync(join(dir, "plan.json"), JSON.stringify({ version: 1, parserSourceSha256, issuedSharesSourceSha256, selection: { afterCode: null, limit: 50 }, valuationPath: null,
    items: [{ parserSourceSha256, issuedSharesSourceSha256, source, ownerName: "構造検証", status, reason: status === "held" ? "明細表なし" : null, parsedRows: rows,
      archivePageId: "a".repeat(32), zipPath, zipSha256: sha, sourceCustody: "legacy", sourceMetadata: metadata, sourceFetchedAt: "2026-06-30T00:00:00Z" }] }));
}
beforeEach(() => { vi.clearAllMocks(); process.exitCode = 0; dir = mkdtempSync(join(tmpdir(), "kabulab-holdings-protocol-"));
  vi.mocked(selectLatestHoldingsDocuments).mockResolvedValue({ rows: [{ stockId: 1, stockCode: source.stockCode, docId: source.docId, edinetCode: source.edinetCode,
    ownerName: "構造検証", fiscalYearEnd: source.fiscalYearEnd, submittedAt: new Date("2026-06-30T00:00:00Z") }], more: false });
  vi.mocked(readSavedHoldingsZip).mockResolvedValue({ status: "ready", archivePageId: "a".repeat(32), bytes, sha256: sha, originalManifest: "known",
    sourceCustody: "legacy", metadata, fetchedAt: "2026-06-30T00:00:00Z", metadataMissing: [] });
  vi.mocked(recordEdinetZip).mockResolvedValue({ outcome: "recorded", pageId: "b".repeat(32), fileTooLarge: false, manifestMatch: "written" });
  vi.mocked(publishVerifiedShareholdings).mockResolvedValue({ status: "published", parsed: 2, created: 2, updated: 0, unchanged: 0 });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); process.exitCode = 0; });
describe("保有明細backfillのlegacy適用境界", () => {
  it("現observer SHAへ新規準備した実ZIP planは同じwriterへ到達する（typed custodyはprotocol境界）", async () => {
    const nativeSource = { docId: "S100X7D0", stockCode: "9252", edinetCode: "E37098", fiscalYearEnd: "2025-08-31" };
    const nativeBytes = readFileSync(new URL("../src/tests/fixtures/issued-shares-9252-S100X7D0.zip", import.meta.url));
    const nativeSha = createHash("sha256").update(nativeBytes).digest("hex"), zipPath = join(dir, "S100X7D0.zip"); writeFileSync(zipPath, nativeBytes);
    vi.mocked(selectLatestHoldingsDocuments).mockResolvedValue({ rows: [{ stockId: 1, ...nativeSource, ownerName: "株式会社ラストワンマイル", submittedAt: new Date("2025-11-28T10:39:00+09:00") }], more: false });
    writeFileSync(join(dir, "plan.json"), JSON.stringify({ version: 1, parserSourceSha256, issuedSharesSourceSha256,
      selection: { afterCode: null, limit: 1 }, valuationPath: null, items: [{ parserSourceSha256, issuedSharesSourceSha256, source: nativeSource,
        ownerName: "株式会社ラストワンマイル", status: "ready", reason: null, parsedRows: 1, archivePageId: "a".repeat(32), sourceCustody: "typed", zipPath, zipSha256: nativeSha,
        sourceMetadata: { docID: nativeSource.docId, secCode: "92520", edinetCode: nativeSource.edinetCode, periodEnd: nativeSource.fiscalYearEnd, submitDateTime: "2025-11-28 10:39" } }] }));
    vi.mocked(publishVerifiedShareholdings).mockResolvedValueOnce({ status: "published", parsed: 1, created: 1, updated: 0, unchanged: 0 });
    await applyLatestHoldings(dir, 1);
    expect(publishVerifiedShareholdings).toHaveBeenCalledWith(expect.objectContaining({ source: nativeSource, zip: nativeBytes, observeIssuedShares: true,
      issuedSharesFilingDateEvidence: { rawSubmitDateTime: "2025-11-28 10:39", provenance: "saved-archive-metadata" } }));
    expect(recordEdinetZip).not.toHaveBeenCalled(); expect(readSavedHoldingsZip).not.toHaveBeenCalled();
  });
  it.each([["plan", undefined], ["plan", "0".repeat(64)], ["item", undefined], ["item", "0".repeat(64)]] as const)("旧observer %s/%s はnative読取/書込前に停止する", async (scope, pin) => {
    fixture();
    const path = join(dir, "plan.json"), plan = JSON.parse(readFileSync(path, "utf8"));
    if (scope === "plan") plan.issuedSharesSourceSha256 = pin; else plan.items[0].issuedSharesSourceSha256 = pin;
    writeFileSync(path, JSON.stringify(plan));
    await expect(applyLatestHoldings(dir, 100)).rejects.toThrow("旧observer");
    expect(selectLatestHoldingsDocuments).not.toHaveBeenCalled(); expect(readSavedHoldingsZip).not.toHaveBeenCalled();
    expect(recordEdinetZip).not.toHaveBeenCalled(); expect(verifyArchivedAttachments).not.toHaveBeenCalled(); expect(publishVerifiedShareholdings).not.toHaveBeenCalled();
  });
  it("保存prepareの実ZIPは通常archiveと同じ純observerへ渡し、書込/再取得を足さない", async () => {
    const nativeSource = { docId: "S100X7D0", stockCode: "9252", edinetCode: "E37098", fiscalYearEnd: "2025-08-31" };
    const nativeBytes = readFileSync(new URL("../src/tests/fixtures/issued-shares-9252-S100X7D0.zip", import.meta.url));
    const nativeSha = createHash("sha256").update(nativeBytes).digest("hex");
    vi.mocked(selectLatestHoldingsDocuments).mockResolvedValue({ rows: [{ stockId: 1, ...nativeSource, ownerName: "株式会社ラストワンマイル", submittedAt: new Date("2025-11-28T00:00:00Z") }], more: false });
    vi.mocked(readSavedHoldingsZip).mockResolvedValue({ status: "ready", archivePageId: "a".repeat(32), bytes: nativeBytes, sha256: nativeSha,
      originalManifest: "unknown", sourceCustody: "legacy", metadata: {}, fetchedAt: "2025-11-28T10:39:00.000+00:00", metadataMissing: [],
      issuedSharesObservation: observeIssuedShares(nativeBytes, nativeSource, { rawSubmitDateTime: "2025-11-28 10:39", provenance: "saved-archive-metadata" }) });
    vi.mocked(parseShareholdingsData).mockReturnValue({ status: "no_detail_table", source: nativeSource, filename: null, elementId: "jpcrp_cor:ShareholdingsTextBlock",
      contextRef: null, reason: "保有明細とは独立の観測回帰", holderScope: "unqualified", holdings: [] });
    await prepareLatestHoldings({ limit: 1, afterCode: null, dir, valuationPath: null });
    const item = JSON.parse(readFileSync(join(dir, "9252-S100X7D0.item.json"), "utf8"));
    expect(item.issuedSharesObservation).toEqual(observeIssuedShares(nativeBytes, nativeSource, { rawSubmitDateTime: "2025-11-28 10:39", provenance: "saved-archive-metadata" }));
    expect(item.issuedSharesSourceSha256).toBe(createHash("sha256").update(readFileSync(new URL("../src/services/edinet/issued-shares.ts", import.meta.url))).digest("hex"));
    expect(item.zipSha256).toBe(nativeSha); expect(item.status).toBe("held");
    expect(readSavedHoldingsZip).toHaveBeenCalledTimes(1); expect(recordEdinetZip).not.toHaveBeenCalled(); expect(publishVerifiedShareholdings).not.toHaveBeenCalled();
    expect(readSavedHoldingsZip).toHaveBeenCalledWith(nativeSource, undefined, { observeIssuedShares: true });
  });
  it.each([undefined, "0".repeat(64)])("旧parser/別parserのplanはfreshD1前に拒否して旧計画を適用しない", async pin => {
    fixture();
    const path = join(dir, "plan.json"), plan = JSON.parse(readFileSync(path, "utf8"));
    plan.parserSourceSha256 = pin; writeFileSync(path, JSON.stringify(plan));
    await expect(applyLatestHoldings(dir, 100)).rejects.toThrow();
    expect(selectLatestHoldingsDocuments).not.toHaveBeenCalled();
    expect(readSavedHoldingsZip).not.toHaveBeenCalled();
    expect(recordEdinetZip).not.toHaveBeenCalled();
    expect(publishVerifiedShareholdings).not.toHaveBeenCalled();
  });

  it.each([["held", 0, 100]] as const)("原表HOLDは原本二重保存も業務書込もしない", async (status, rows, maxRows) => {
    fixture(status, rows); await applyLatestHoldings(dir, maxRows);
    expect(readSavedHoldingsZip).not.toHaveBeenCalled();expect(recordEdinetZip).not.toHaveBeenCalled();expect(publishVerifiedShareholdings).not.toHaveBeenCalled();
  });
  it("明示不該当のtyped根拠を原本から再資格し、同custody/publisherへ渡すが価格処理はしない", async () => {
    const notApplicable = { version: 1 as const, basis: "whole_section_not_applicable" as const, zipSha256: sha, filename: "structural.htm",
      memberSha256: sha, blockHtmlSha256: sha, elementNamespace: "http://disclosure.edinet-fsa.go.jp/taxonomy/jpcrp/2025-11-01/jpcrp_cor",
      inlineNamespace: "http://www.xbrl.org/2008/inlineXBRL", context: { contextRef: "FilingDateInstant", entity: `${source.edinetCode}-000`, instantDate: "2026-06-30" }, statement: "原本資格は別suite。ここはtyped結果の伝播だけ" };
    vi.mocked(parseShareholdingsData).mockReturnValue({ status: "explicit_not_applicable", reason: "原本明示不該当", source,
      filename: notApplicable.filename, elementId: "jpcrp_cor:ShareholdingsTextBlock", contextRef: "FilingDateInstant", holderScope: "filer_only", holdings: [], notApplicable });
    await prepareLatestHoldings({ limit: 1, afterCode: null, dir, valuationPath: null });
    const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
    expect(plan.items[0]).toMatchObject({ status: "held", parsedRows: 0, notApplicable, sourceFetchedAt: "2026-06-30T00:00:00Z" });
    expect(readFileSync(plan.items[0].zipPath)).toEqual(bytes);
    vi.mocked(publishVerifiedShareholdings).mockResolvedValueOnce({ status: "held", parsed: 0, reason: "原本明示不該当", reasonCode: "explicit_not_applicable", notApplicable });
    vi.mocked(readSavedHoldingsZip).mockClear(); await applyLatestHoldings(dir, 100);
    expect(readSavedHoldingsZip).toHaveBeenCalledOnce(); expect(recordEdinetZip).toHaveBeenCalledOnce();
    expect(publishVerifiedShareholdings).toHaveBeenCalledWith(expect.objectContaining({ maxRows: 0, archivePageId: "b".repeat(32) }));
    expect(qualifyHoldingValuation).not.toHaveBeenCalled(); expect(process.exitCode).toBe(0);
  });
  const actualAbsences: Array<{ source: ShareholdingsSource & { edinetCode: string }; ownerName: string; fixture: string; originalZipSha256: string;
    originalZipBytes: number; sourceFetchedAt: string; notApplicable: ShareholdingsNotApplicable }> = JSON.parse(readFileSync(new URL("../src/tests/fixtures/holdings-absence-cli/provenance.json", import.meta.url), "utf8")).items;
  it.each(actualAbsences)("保存実原本 $source.stockCode は通常prepare→再資格→custody→同publisher→型付きHOLD receiptを通る", async fixture => {
    const actual = await vi.importActual<typeof import("../src/services/edinet/shareholdings.js")>("../src/services/edinet/shareholdings.js");
    vi.mocked(parseShareholdingsData).mockImplementation(actual.parseShareholdingsData);
    const zip = readFileSync(new URL(`../src/tests/fixtures/holdings-absence-cli/${fixture.fixture}`, import.meta.url));
    expect(createHash("sha256").update(zip).digest("hex")).toBe(fixture.originalZipSha256); expect(zip.length).toBe(fixture.originalZipBytes);
    const parsed = actual.parseShareholdingsData(zip, fixture.source); expect(parsed.notApplicable).toEqual(fixture.notApplicable);
    vi.mocked(selectLatestHoldingsDocuments).mockResolvedValue({ rows: [{ stockId: 1, stockCode: fixture.source.stockCode,
      docId: fixture.source.docId, edinetCode: fixture.source.edinetCode, fiscalYearEnd: fixture.source.fiscalYearEnd,
      ownerName: fixture.ownerName, submittedAt: new Date(fixture.notApplicable.context.instantDate) }], more: false });
    vi.mocked(readSavedHoldingsZip).mockResolvedValue({ status: "ready", archivePageId: "a".repeat(32), bytes: zip,
      sha256: fixture.originalZipSha256, originalManifest: "known", sourceCustody: "legacy", metadata: {},
      fetchedAt: fixture.sourceFetchedAt, metadataMissing: [] });
    vi.mocked(publishVerifiedShareholdings).mockResolvedValue({ status: "held", parsed: 0, reason: parsed.reason!,
      reasonCode: "explicit_not_applicable", notApplicable: parsed.notApplicable });
    await prepareLatestHoldings({ limit: 1, afterCode: null, dir, valuationPath: null });
    const prepared = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")).items[0];
    expect(prepared).toMatchObject({ status: "held", parsedRows: 0, source: fixture.source, notApplicable: fixture.notApplicable });
    await applyLatestHoldings(dir, 1); await applyLatestHoldings(dir, 1);
    expect(recordEdinetZip).toHaveBeenCalledOnce(); expect(publishVerifiedShareholdings).toHaveBeenCalledOnce();
    expect(publishVerifiedShareholdings).toHaveBeenCalledWith(expect.objectContaining({ source: fixture.source, zip, maxRows: 0 }));
    const receipt = JSON.parse(readFileSync(join(dir, `${fixture.source.stockCode}-${fixture.source.docId}.held.json`), "utf8"));
    expect(receipt.result).toMatchObject({ status: "held", parsed: 0, reasonCode: "explicit_not_applicable", notApplicable: fixture.notApplicable });
    expect(existsSync(join(dir, `${fixture.source.stockCode}-${fixture.source.docId}.published.json`))).toBe(false);
    expect(qualifyHoldingValuation).not.toHaveBeenCalled(); expect(process.exitCode).toBe(0);
  }, 15_000); // Complete saved ZIP parsing plus fsynced CLI receipts under parallel CI; no network.
  it("planだけに明示不該当を後付けしても原本再資格が失敗すればcustody/native前に停止", async () => {
    fixture("held", 0); const path = join(dir, "plan.json"), plan = JSON.parse(readFileSync(path, "utf8"));
    plan.items[0].notApplicable = { basis: "whole_section_not_applicable" }; writeFileSync(path, JSON.stringify(plan));
    vi.mocked(parseShareholdingsData).mockReturnValue({ source, status: "no_detail_table", holderScope: "unqualified",
      reason: "提出者不明", holdings: [], filename: null, contextRef: null, elementId: "jpcrp_cor:ShareholdingsTextBlock" });
    await expect(applyLatestHoldings(dir, 1)).rejects.toThrow(); expect(selectLatestHoldingsDocuments).not.toHaveBeenCalled();
    expect(readSavedHoldingsZip).not.toHaveBeenCalled(); expect(recordEdinetZip).not.toHaveBeenCalled(); expect(publishVerifiedShareholdings).not.toHaveBeenCalled();
  });
  it("資格成立の非0件だけ同bytesを現行keyへ保存し、そのpageIdで公開する", async () => {
    fixture();await applyLatestHoldings(dir, 100);
    expect(recordEdinetZip).toHaveBeenCalledWith(expect.objectContaining({ docID: source.docId, type: 1, zip: bytes, force: false, fetchedAt: "2026-06-30T00:00:00Z" }));
    expect(publishVerifiedShareholdings).toHaveBeenCalledWith(expect.objectContaining({ archivePageId: "b".repeat(32), zip: bytes }));
    expect(existsSync(join(dir, `${source.stockCode}-${source.docId}.modern-custody.json`))).toBe(true);
  });
  it("原本保存の結果不明なら後続publish・保存receiptへ進まない", async () => {
    fixture();vi.mocked(recordEdinetZip).mockRejectedValueOnce(new Error("UNKNOWN_WRITE"));
    await expect(applyLatestHoldings(dir, 100)).rejects.toThrow("UNKNOWN_WRITE");expect(publishVerifiedShareholdings).not.toHaveBeenCalled();
    expect(existsSync(join(dir, `${source.stockCode}-${source.docId}.modern-custody.json`))).toBe(false);
  });
  it("確定済み現行custody receiptはfull readbackだけで再uploadしない", async () => {
    fixture();writeFileSync(join(dir, `${source.stockCode}-${source.docId}.modern-custody.json`), JSON.stringify({ zipSha256: sha, result: { pageId: "b".repeat(32) } }));
    await applyLatestHoldings(dir, 100);expect(recordEdinetZip).not.toHaveBeenCalled();expect(readSavedHoldingsZip).not.toHaveBeenCalled();
    expect(verifyArchivedAttachments).toHaveBeenCalledWith("b".repeat(32), expect.any(Array), expect.any(String));
  });

  it("小予算でも確定windowを記録し、次回は通常publisherのsource cursorから続ける", async () => {
    fixture();
    vi.mocked(publishVerifiedShareholdings).mockResolvedValueOnce({ status: "held", parsed: 2, reason: "次windowへ再開待ち", usedRows: 1, pending: true })
      .mockResolvedValueOnce({ status: "published", parsed: 1, created: 1, updated: 0, unchanged: 0 });
    await applyLatestHoldings(dir, 1);
    expect(publishVerifiedShareholdings).toHaveBeenLastCalledWith(expect.objectContaining({ maxRows: 1 }));
    expect(existsSync(join(dir, `${source.stockCode}-${source.docId}.published.json`))).toBe(false);
    expect(existsSync(join(dir, `${source.stockCode}-${source.docId}.held.json`))).toBe(false);
    await applyLatestHoldings(dir, 1);
    expect(recordEdinetZip).toHaveBeenCalledTimes(1);
    expect(publishVerifiedShareholdings).toHaveBeenCalledTimes(2);
    expect(existsSync(join(dir, `${source.stockCode}-${source.docId}.published.json`))).toBe(true);
  });

  it("100行を超える原表も1windowだけ公開し、正常pendingをunknownにしない", async () => {
    fixture("ready", 150);
    vi.mocked(publishVerifiedShareholdings).mockResolvedValueOnce({ status: "held", parsed: 150, reason: "残50行", usedRows: 100, pending: true });
    await applyLatestHoldings(dir, 1000);
    expect(publishVerifiedShareholdings).toHaveBeenCalledWith(expect.objectContaining({ maxRows: 100 }));
    expect(existsSync(join(dir, `${source.stockCode}-${source.docId}.published.json`))).toBe(false);
  });

  it("価格windowのpublished/pendingも通全体の完了receiptにはしない", async () => {
    fixture();
    vi.mocked(publishVerifiedShareholdings).mockResolvedValueOnce({ status: "published", parsed: 1, created: 0, updated: 1, unchanged: 0, unavailable: 0, pending: true });
    await applyLatestHoldings(dir, 1);
    expect(existsSync(join(dir, `${source.stockCode}-${source.docId}.published.json`))).toBe(false);
    expect(existsSync(join(dir, `${source.stockCode}-${source.docId}.held.json`))).toBe(false);
  });

  it("旧CLIが完了扱いした価格pending receiptを完了として再利用しない", async () => {
    fixture();
    writeFileSync(join(dir, `${source.stockCode}-${source.docId}.published.json`), JSON.stringify({ source, zipSha256: sha,
      result: { status: "published", parsed: 1, created: 0, updated: 1, unchanged: 0, pending: true } }));
    await expect(applyLatestHoldings(dir, 100)).rejects.toThrow("旧完了receiptに未完window");
    expect(publishVerifiedShareholdings).not.toHaveBeenCalled();
  });

  it("既存行の資格HOLDは既知結果として固定し、自動で再送しない", async () => {
    fixture();
    vi.mocked(publishVerifiedShareholdings).mockResolvedValueOnce({ status: "held", parsed: 2, reason: "旧行の保有主体名が一致しません" });
    await applyLatestHoldings(dir, 100);
    await applyLatestHoldings(dir, 100);
    expect(publishVerifiedShareholdings).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dir, `${source.stockCode}-${source.docId}.held.json`))).toBe(true);
    expect(existsSync(join(dir, `${source.stockCode}-${source.docId}.published.json`))).toBe(false);
  });

  it.each(["edinetCode", "fiscalYearEnd", "ownerName"] as const)("同じdocIDでもfresh %s変更なら公開しない", async field => {
    fixture();
    const fresh = await selectLatestHoldingsDocuments({} as never, { afterCode: null, limit: 50 });
    vi.mocked(selectLatestHoldingsDocuments).mockResolvedValueOnce({ ...fresh, rows: [{ ...fresh.rows[0], [field]: "changed" }] });
    await expect(applyLatestHoldings(dir, 100)).rejects.toThrow();
    expect(recordEdinetZip).not.toHaveBeenCalled();
    expect(publishVerifiedShareholdings).not.toHaveBeenCalled();
  });

  it("原本custody照合後にも最新文書を再確認する", async () => {
    fixture();
    const fresh = await selectLatestHoldingsDocuments({} as never, { afterCode: null, limit: 50 });
    vi.mocked(selectLatestHoldingsDocuments).mockResolvedValueOnce(fresh)
      .mockResolvedValueOnce({ ...fresh, rows: [{ ...fresh.rows[0], docId: "S100CHANGED" }] });
    await expect(applyLatestHoldings(dir, 100)).rejects.toThrow("最新有報・発行体・期末");
    expect(recordEdinetZip).toHaveBeenCalledTimes(1);
    expect(publishVerifiedShareholdings).not.toHaveBeenCalled();
  });

  it("準備の全明細で一つの価格indexを共有し、欠測理由を個別に維持する", async () => {
    const holding = { name: "構造検証", kind: "特定投資株式" as const, shares: 12, sharesRaw: 12, sharesUnit: "株" as const,
      bookValueRaw: 34, bookValueUnit: "千円" as const, bookValueYen: 34000, listingStatus: "unknown" as const,
      price: null, priceDate: null, priceCurrency: null, tableIndex: 0, rowIndex: 3 };
    vi.mocked(parseShareholdingsData).mockReturnValue({ status: "ok", source, filename: "structural.htm", elementId: "jpcrp_cor:ShareholdingsTextBlock",
      contextRef: "FilingDateInstant", reason: null, holderScope: "filer_only", holdings: [holding, { ...holding, rowIndex: 4 }] });
    vi.mocked(qualifyHoldingValuation).mockResolvedValueOnce({ status: "unavailable", identity: null, reason: "価格保存なし" })
      .mockResolvedValueOnce({ status: "unavailable", identity: null, reason: "当期株数非開示" });
    const evidence = { path: join(dir, "price.gz"), archivePageId: "1".repeat(32), filename: "structure.gz", sha256: sha };
    writeFileSync(evidence.path, bytes);
    const valuationPath = join(dir, "valuation.json");
    writeFileSync(valuationPath, JSON.stringify({ codeList: evidence, prices: [evidence] }));
    await prepareLatestHoldings({ limit: 50, afterCode: null, dir, valuationPath });
    expect(HoldingsPriceIndex).toHaveBeenCalledTimes(1);
    const calls = vi.mocked(qualifyHoldingValuation).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0].prices).toBe(calls[1][0].prices);
    expect(calls[0][0].prices).toBeInstanceOf(HoldingsPriceIndex);
    const records = readFileSync(join(dir, `${source.stockCode}-${source.docId}.current.jsonl`), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(records.map(row => row.valuation.reason)).toEqual(["価格保存なし", "当期株数非開示"]);
    expect(publishVerifiedShareholdings).not.toHaveBeenCalled();
    expect(recordEdinetZip).not.toHaveBeenCalled();
  });
});
