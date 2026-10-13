/** Legacy custody migration is restricted to qualified nonzero holdings, never to HOLD rows. */
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyLatestHoldings } from "./backfill-shareholdings.js";
import { selectLatestHoldingsDocuments } from "./lib/shareholdings-backfill.js";
import { readSavedHoldingsZip, publishVerifiedShareholdings } from "../../../src/shared/notion-archive/shareholdings.js";
import { recordEdinetZip } from "../src/services/edinet/archive.js";
import { verifyArchivedAttachments } from "../../../src/shared/notion-archive/readback.js";
vi.mock("../../../src/shared/db/d1-http-client.js", () => ({ createD1HttpDb: vi.fn(() => ({})) }));
vi.mock("./lib/shareholdings-backfill.js", () => ({ selectLatestHoldingsDocuments: vi.fn() }));
vi.mock("../../../src/shared/notion-archive/shareholdings.js", () => ({ readSavedHoldingsZip: vi.fn(), publishVerifiedShareholdings: vi.fn() }));
vi.mock("../../../src/shared/notion-archive/readback.js", () => ({ verifyArchivedAttachments: vi.fn() }));
vi.mock("../src/services/edinet/archive.js", () => ({ recordEdinetZip: vi.fn(), edinetArchiveFilename: (doc: string) => `${doc}_xbrl.zip` }));
vi.mock("../../../scripts/notion/shareholdings.js", () => ({ guardedHoldingsMutation: async (_path: string, _label: string, execute: () => Promise<unknown>) => execute() }));
const source = { docId: "S100STRUCTURAL", stockCode: "1001", edinetCode: "E00001", fiscalYearEnd: "2026-03-31" };
const bytes = Buffer.from("Protocol test only; source parser covered in separate suites");
const sha = createHash("sha256").update(bytes).digest("hex");
const parserSourceSha256 = createHash("sha256").update(readFileSync(new URL("../src/services/edinet/shareholdings.ts", import.meta.url))).digest("hex");
const metadata = { docID: source.docId, edinetCode: source.edinetCode, secCode: "10010", periodEnd: source.fiscalYearEnd };
let dir: string;
function fixture(status = "ready", rows = 2) {
  const zipPath = join(dir, "saved.zip"); writeFileSync(zipPath, bytes);
  writeFileSync(join(dir, "plan.json"), JSON.stringify({ version: 1, parserSourceSha256, selection: { afterCode: null, limit: 50 }, valuationPath: null,
    items: [{ parserSourceSha256, source, ownerName: "構造検証", status, reason: status === "held" ? "明細表なし" : null, parsedRows: rows,
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

  it.each([["held", 0, 100], ["ready", 2, 1]] as const)("HOLDまたは予算外は原本二重保存も業務書込もしない", async (status, rows, maxRows) => {
    fixture(status, rows); await applyLatestHoldings(dir, maxRows);
    expect(readSavedHoldingsZip).not.toHaveBeenCalled();expect(recordEdinetZip).not.toHaveBeenCalled();expect(publishVerifiedShareholdings).not.toHaveBeenCalled();
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
});
