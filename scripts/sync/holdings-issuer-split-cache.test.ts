/** Actual retained issuer ZIP and Yahoo gzip through the normal cache-only issuer path. */
import {readFileSync} from "node:fs";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {createHoldingOfficialNamesLoader} from "./holdings-issuer-names.js";
import {selectLatestHoldingsDocuments} from "../../services/yuho-quant/data-scripts/lib/shareholdings-backfill.js";
import {readSavedHoldingsZip} from "../../src/shared/notion-archive/shareholdings.js";
import {parseShareholdingsData} from "../../services/yuho-quant/src/services/edinet/shareholdings.js";
import {HoldingsPriceIndex, HoldingPriceShareBasisMismatch, parseHoldingsCodeList, qualifyHoldingValuation} from "../../services/yuho-quant/src/services/edinet/shareholdings-valuation.js";
vi.mock("../../src/shared/db/d1-http-client.js", () => ({createD1HttpDb: vi.fn(() => ({}))}));
vi.mock("../../services/yuho-quant/data-scripts/lib/shareholdings-backfill.js", () => ({selectLatestHoldingsDocuments: vi.fn()}));
vi.mock("../../src/shared/notion-archive/shareholdings.js", () => ({readSavedHoldingsZip: vi.fn()}));
const read = (name: string) => readFileSync(new URL(`../../services/yuho-quant/src/tests/fixtures/holdings-split-1798/${name}`, import.meta.url));
const provenance = JSON.parse(read("provenance.json").toString()), zip = read("S100YDA3.zip");
const catalog = parseHoldingsCodeList({...provenance.codeList, bytes: read("Edinetcode.zip")});
const identity = catalog.byLegalName.get(provenance.issuer.ownerName)![0];
const holding = parseShareholdingsData(read("S100YILN.zip"), provenance.owner.source).holdings.find(h => h.name === "㈱守谷商会")!;
const prices = new HoldingsPriceIndex([{archivePageId: provenance.price.archivePageId, filename: provenance.price.filename,
  sha256: provenance.price.gzipSha256, bytes: read("price-raw.json.gz")}]);
const target = {identity, priceCapturedAt: provenance.member.receivedAt}, budget = () => ({remainingBytes: 256 * 1024 ** 2});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(selectLatestHoldingsDocuments).mockResolvedValue({rows: [{...provenance.issuer.source, stockId: 1,
    ownerName: provenance.issuer.ownerName, submittedAt: new Date("2026-06-18T04:02:00Z")}], more: false});
  vi.mocked(readSavedHoldingsZip).mockImplementation(async (_source, limit) => {
    if (limit) limit.remainingBytes -= zip.length;
    return {status: "ready", archivePageId: provenance.issuer.archivePageId, sha256: provenance.issuer.zipSha256, bytes: zip,
      originalManifest: "unknown", sourceCustody: "legacy", metadata: provenance.issuer.metadata, fetchedAt: provenance.issuer.fetchedAt, metadataMissing: []};
  });
});
describe("canonical splitの既存issuer cacheだけを再利用する正常経路", () => {
  it("cold cacheはsource/D1/Notion読取0でunknown unavailable、明示した既存原本cacheだけknown HOLDへ使う", async () => {
    const loader = createHoldingOfficialNamesLoader(), limit = budget();
    const cold = await loader([{...target, cacheOnly: true}], limit);
    expect(cold.status).toBe("ready"); if (cold.status !== "ready") throw new Error(cold.reason);
    expect(cold.names.size).toBe(0); expect(await cold.checkCurrent()).toEqual({status: "verified"});
    expect(selectLatestHoldingsDocuments).not.toHaveBeenCalled(); expect(readSavedHoldingsZip).not.toHaveBeenCalled();
    expect(limit.remainingBytes).toBe(budget().remainingBytes);
    const args = {holding, fiscalYearEnd: provenance.owner.source.fiscalYearEnd, catalog, prices};
    expect((await qualifyHoldingValuation({...args, officialIssuerNames: cold.names})).status).toBe("unavailable");
    // Explicit existing-loader prewarm models already available verified input. Production cold canonical does NOT do this.
    expect((await loader([target], limit)).status).toBe("ready");
    expect(readSavedHoldingsZip).toHaveBeenCalledTimes(1); expect(selectLatestHoldingsDocuments).toHaveBeenCalledTimes(1);
    const warm = await loader([{...target, cacheOnly: true}], limit);
    expect(warm.status).toBe("ready"); if (warm.status !== "ready") throw new Error(warm.reason);
    expect(readSavedHoldingsZip).toHaveBeenCalledTimes(1); expect(selectLatestHoldingsDocuments).toHaveBeenCalledTimes(1);
    expect(warm.names.get(identity.code)).toEqual(JSON.parse(read("qualified-evidence.json").toString()));
    await expect(qualifyHoldingValuation({...args, officialIssuerNames: warm.names})).rejects.toBeInstanceOf(HoldingPriceShareBasisMismatch);
    expect(await warm.checkCurrent()).toEqual({status: "verified"}); expect(readSavedHoldingsZip).toHaveBeenCalledTimes(1);
    expect(limit.remainingBytes).toBe(budget().remainingBytes - zip.length);
    // A different capture never borrows the old issuer cache or starts a new source read.
    const other = await loader([{...target, priceCapturedAt: "2026-10-05T12:00:00Z", cacheOnly: true}], limit);
    expect(other.status).toBe("ready"); if (other.status !== "ready") throw new Error(other.reason);
    expect(other.names.size).toBe(0); expect(readSavedHoldingsZip).toHaveBeenCalledTimes(1);
  });
  it("cacheに残るtransport unknownは再送せずSTOPし、known heldはverified証拠として使わない", async () => {
    const loader = createHoldingOfficialNamesLoader(), limit = budget();
    vi.mocked(readSavedHoldingsZip).mockRejectedValueOnce(new Error("SOURCE_UNKNOWN"));
    await expect(loader([target], limit)).rejects.toThrow("SOURCE_UNKNOWN");
    await expect(loader([{...target, cacheOnly: true}], limit)).rejects.toThrow("SOURCE_UNKNOWN");
    expect(readSavedHoldingsZip).toHaveBeenCalledTimes(1);
    const held = createHoldingOfficialNamesLoader();
    vi.mocked(readSavedHoldingsZip).mockResolvedValueOnce({status: "held", reasonCode: "budget_exhausted", reason: "byte budget"});
    expect((await held([target], limit)).status).toBe("held");
    const cached = await held([{...target, cacheOnly: true}], limit);
    expect(cached.status).toBe("ready"); if (cached.status !== "ready") throw new Error(cached.reason);
    expect(cached.names.size).toBe(0); expect(readSavedHoldingsZip).toHaveBeenCalledTimes(2);
  });
});
