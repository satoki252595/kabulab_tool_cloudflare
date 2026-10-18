import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHoldingOfficialNamesLoader } from "./holdings-issuer-names.js";
import { createD1HttpDb } from "../../src/shared/db/d1-http-client.js";
import { selectLatestHoldingsDocuments } from "../../services/yuho-quant/data-scripts/lib/shareholdings-backfill.js";
import { readSavedHoldingsZip } from "../../src/shared/notion-archive/shareholdings.js";
import { qualifyOfficialIssuerEnglishName, type OfficialIssuerEnglishName } from "../../services/yuho-quant/src/services/edinet/shareholdings-issuer-names.js";
import { parseHoldingsCodeList } from "../../services/yuho-quant/src/services/edinet/shareholdings-valuation.js";
vi.mock("../../src/shared/db/d1-http-client.js", () => ({ createD1HttpDb: vi.fn(() => ({})) }));
vi.mock("../../services/yuho-quant/data-scripts/lib/shareholdings-backfill.js", () => ({ selectLatestHoldingsDocuments: vi.fn() }));
vi.mock("../../src/shared/notion-archive/shareholdings.js", () => ({ readSavedHoldingsZip: vi.fn() }));
vi.mock("../../services/yuho-quant/src/services/edinet/shareholdings-issuer-names.js", () => ({ qualifyOfficialIssuerEnglishName: vi.fn() }));
const zip = readFileSync(new URL("../../pipeline/tests/fixtures/edinet/Edinetcode.zip", import.meta.url)),sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const identity = [...parseHoldingsCodeList({ archivePageId: "a".repeat(32), filename: "Edinetcode.zip", bytes: zip, sha256: sha(zip) }).byLegalName.values()].flat().find(value => value.code === "8418")!;
const latest = { stockId: 1, stockCode: identity.code, docId: "S100YE1V", edinetCode: identity.edinetCode, ownerName: identity.legalName, fiscalYearEnd: "2026-03-31", submittedAt: new Date("2026-06-18T06:30:00Z") };
const target = { identity, priceCapturedAt: "2026-10-04T12:00:00Z" },budget = () => ({ remainingBytes: 256 * 1024 * 1024 });
const evidence = { code: identity.code, englishName: "Yamaguchi Financial Group, Inc.", priceCapturedAt: target.priceCapturedAt } as OfficialIssuerEnglishName;
beforeEach(() => {
  vi.clearAllMocks(); vi.mocked(selectLatestHoldingsDocuments).mockResolvedValue({ rows: [latest], more: false });
  vi.mocked(readSavedHoldingsZip).mockImplementation(async (_source, limit) => { if (limit) limit.remainingBytes -= zip.length; return { status: "ready", archivePageId: "b".repeat(32), bytes: zip, sha256: sha(zip), originalManifest: "known", sourceCustody: "typed", metadata: {}, fetchedAt: "2026-06-18T15:30:00Z", metadataMissing: [] }; });
  vi.mocked(qualifyOfficialIssuerEnglishName).mockReturnValue({ status: "verified", evidence });
});
describe("通常priceの保存issuer英字名loader", () => {
  it("canonical一致だけならD1/原本読取0、必要主体だけscoped selector+保存readerを使う", async () => {
    const loader = createHoldingOfficialNamesLoader(),limit = budget();
    const empty = await loader([],limit);expect(empty.status).toBe("ready"); if (empty.status !== "ready") throw new Error(empty.reason);
    expect(await empty.checkCurrent()).toEqual({ status: "verified" }); expect(createD1HttpDb).not.toHaveBeenCalled(); expect(readSavedHoldingsZip).not.toHaveBeenCalled();
    const first = await loader([target],limit), second = await loader([target],limit);
    expect(first.status).toBe("ready"); expect(second.status).toBe("ready");
    expect(selectLatestHoldingsDocuments).toHaveBeenCalledWith(expect.anything(), { afterCode: null, limit: 1, onlyCode: identity.code });
    expect(readSavedHoldingsZip).toHaveBeenCalledTimes(1);expect(selectLatestHoldingsDocuments).toHaveBeenCalledTimes(1);expect(limit.remainingBytes).toBe(budget().remainingBytes-zip.length);
    if (first.status !== "ready") throw new Error(first.reason);expect(first.names.get(identity.code)).toBe(evidence);
    expect(await first.checkCurrent()).toEqual({ status: "verified" });expect(selectLatestHoldingsDocuments).toHaveBeenCalledTimes(2);expect(readSavedHoldingsZip).toHaveBeenCalledTimes(1);
  });
  it("原本/transport unknownは同runで再送せず予約を返さない", async () => {
    vi.mocked(readSavedHoldingsZip).mockImplementation(async (_source,limit) => { if (limit) limit.remainingBytes -= zip.length; throw new Error("SOURCE_UNKNOWN"); });
    const loader = createHoldingOfficialNamesLoader(),limit = budget();
    await expect(loader([target],limit)).rejects.toThrow("SOURCE_UNKNOWN"); await expect(loader([target],limit)).rejects.toThrow("SOURCE_UNKNOWN");
    expect(readSavedHoldingsZip).toHaveBeenCalledTimes(1);expect(selectLatestHoldingsDocuments).toHaveBeenCalledTimes(1);expect(limit.remainingBytes).toBe(budget().remainingBytes-zip.length);
  });
  it("既知budgetだけ再資格可能とし、issuer不在/主体変更は名前証拠へ追加せずその行だけ未資格に残す", async () => {
    vi.mocked(readSavedHoldingsZip).mockResolvedValueOnce({ status: "held", reasonCode: "budget_exhausted", reason: "全文予算不足" });
    const loader = createHoldingOfficialNamesLoader(),limit = budget();
    expect(await loader([target],limit)).toMatchObject({ status: "held", reasonCode: "budget_exhausted" });
    expect((await loader([target],limit)).status).toBe("ready"); expect(readSavedHoldingsZip).toHaveBeenCalledTimes(2);
    vi.mocked(selectLatestHoldingsDocuments).mockResolvedValueOnce({ rows: [], more: false });
    expect(await createHoldingOfficialNamesLoader()([target],limit)).toMatchObject({ status: "ready", names: new Map() });
    vi.mocked(selectLatestHoldingsDocuments).mockResolvedValueOnce({ rows: [{ ...latest, ownerName: "別主体" }], more: false });
    expect(await createHoldingOfficialNamesLoader()([target],limit)).toMatchObject({ status: "ready", names: new Map() }); expect(readSavedHoldingsZip).toHaveBeenCalledTimes(2);
  });
  it("純qualifier後の最新doc変更も明示HOLDし、保存ZIPを別名へ交換しない", async () => {
    const result = await createHoldingOfficialNamesLoader()([target],budget());expect(result.status).toBe("ready");if (result.status !== "ready") throw new Error(result.reason);
    vi.mocked(selectLatestHoldingsDocuments).mockResolvedValueOnce({ rows: [{ ...latest, docId: "S100Z123" }], more: false });
    expect(await result.checkCurrent()).toMatchObject({ status: "held", reasonCode: "issuer_source_unavailable" });expect(readSavedHoldingsZip).toHaveBeenCalledTimes(1);
  });
  it("一名の既知issuer不在は他の保存英字名を巻き込まず、未資格cacheを再読しない", async () => {
    const otherEvidence = JSON.parse(readFileSync(new URL("../../services/yuho-quant/src/tests/fixtures/holdings-split-1798/qualified-evidence.json", import.meta.url), "utf8")) as OfficialIssuerEnglishName;
    const otherIdentity = [...parseHoldingsCodeList({ archivePageId: "a".repeat(32), filename: "Edinetcode.zip", bytes: zip, sha256: sha(zip) }).byLegalName.values()].flat().find(value => value.code === otherEvidence.code)!;
    if (otherEvidence.source.edinetCode === null) throw new Error("保存fixtureの提出者が未資格です");
    const otherLatest = { ...latest, ...otherEvidence.source, edinetCode: otherEvidence.source.edinetCode, ownerName: otherIdentity.legalName, submittedAt: new Date(otherEvidence.submittedAt) };
    const otherTarget = { identity: otherIdentity, priceCapturedAt: otherEvidence.priceCapturedAt };
    vi.mocked(selectLatestHoldingsDocuments).mockImplementation(async (_db, opts) => ({ rows: opts.onlyCode === identity.code ? [] : [otherLatest], more: false }));
    vi.mocked(qualifyOfficialIssuerEnglishName).mockReturnValue({ status: "verified", evidence: otherEvidence });
    const loader = createHoldingOfficialNamesLoader(), limit = budget();
    for (let repeat = 0; repeat < 2; repeat++) {
      const result = await loader([target, otherTarget], limit);expect(result.status).toBe("ready");if (result.status !== "ready") throw new Error(result.reason);
      expect([...result.names.keys()]).toEqual([otherEvidence.code]);expect(result.names.get(otherEvidence.code)).toEqual(otherEvidence);
      if (repeat === 1) expect(await result.checkCurrent()).toEqual({ status: "verified" });
    }
    expect(readSavedHoldingsZip).toHaveBeenCalledTimes(1);expect(selectLatestHoldingsDocuments).toHaveBeenCalledTimes(3);
    expect(vi.mocked(selectLatestHoldingsDocuments).mock.calls.at(-1)?.[1].onlyCode).toBe(otherEvidence.code);
  });
  it("実時間超過は各新latest/保存読取/書込前latestの開始前で止め、unknownを既知HOLDへ置換しない", async () => {
    let stopped = true;
    const shouldStop = () => stopped, loader = createHoldingOfficialNamesLoader(), limit = budget();
    expect(await loader([target],limit,shouldStop)).toMatchObject({ status: "held", reasonCode: "budget_exhausted" });
    expect(selectLatestHoldingsDocuments).not.toHaveBeenCalled(); expect(readSavedHoldingsZip).not.toHaveBeenCalled();
    stopped = false;
    vi.mocked(selectLatestHoldingsDocuments).mockImplementationOnce(async () => { stopped = true; return { rows: [latest], more: false }; });
    expect(await loader([target],limit,shouldStop)).toMatchObject({ status: "held", reasonCode: "budget_exhausted" });
    expect(selectLatestHoldingsDocuments).toHaveBeenCalledTimes(1); expect(readSavedHoldingsZip).not.toHaveBeenCalled();
    stopped = false;
    const ready = await loader([target],limit,shouldStop); if (ready.status !== "ready") throw new Error(ready.reason);
    stopped = true;
    expect(await ready.checkCurrent()).toMatchObject({ status: "held", reasonCode: "budget_exhausted" });
    expect(selectLatestHoldingsDocuments).toHaveBeenCalledTimes(2); expect(readSavedHoldingsZip).toHaveBeenCalledTimes(1);
    stopped = false;
    vi.mocked(selectLatestHoldingsDocuments).mockImplementationOnce(async () => { stopped = true; return { rows: [latest], more: false }; });
    expect(await ready.checkCurrent()).toMatchObject({ status: "held", reasonCode: "budget_exhausted" });
    stopped = false;
    vi.mocked(readSavedHoldingsZip).mockImplementationOnce(async () => { stopped = true; throw new Error("SOURCE_UNKNOWN"); });
    const unknown = createHoldingOfficialNamesLoader();
    await expect(unknown([target],limit,shouldStop)).rejects.toThrow("SOURCE_UNKNOWN");
    await expect(unknown([target],limit,shouldStop)).rejects.toThrow("SOURCE_UNKNOWN");
    expect(readSavedHoldingsZip).toHaveBeenCalledTimes(2);
  });
});
