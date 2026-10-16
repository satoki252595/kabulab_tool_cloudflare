/** Exact retained 1799 owner / 1798 issuer / complete Yahoo gzip. No generated business values. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qualifyOfficialIssuerEnglishName } from "../services/edinet/shareholdings-issuer-names.js";
import { observePreSplitFiscalYearBasis } from "../services/edinet/shareholdings-split-basis.js";
import { HoldingPriceShareBasisMismatch, HoldingsPriceIndex, parseHoldingsCodeList, qualifyHoldingValuation } from "../services/edinet/shareholdings-valuation.js";
import { parseShareholdingsData, verifySavedHoldingsSource } from "../services/edinet/shareholdings.js";
import * as zipReader from "../services/edinet/zip.js";
import { parseDailyChart } from "../../../../src/shared/yahoo/client.js";

const read = (filename: string) => readFileSync(new URL(`./fixtures/holdings-split-1798/${filename}`, import.meta.url));
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const provenance = JSON.parse(read("provenance.json").toString());
const issuerZip = read("S100YDA3.zip"), ownerZip = read("S100YILN.zip"), priceZip = read("price-raw.json.gz"), codes = read("Edinetcode.zip");
const catalog = parseHoldingsCodeList({ ...provenance.codeList, bytes: codes });
const holding = parseShareholdingsData(ownerZip, provenance.owner.source).holdings.find(h => h.name === "㈱守谷商会")!;
const identity = catalog.byLegalName.get("株式会社守谷商会")![0];
const archived = { archivePageId: provenance.issuer.archivePageId, filename: "S100YDA3_xbrl.zip", sha256: provenance.issuer.zipSha256, bytes: issuerZip };
const name = qualifyOfficialIssuerEnglishName({ identity, source: provenance.issuer.source, ownerName: provenance.issuer.ownerName,
  archived, metadata: provenance.issuer.metadata, fetchedAt: provenance.issuer.fetchedAt, priceCapturedAt: provenance.member.receivedAt });
if (name.status !== "verified") throw new Error(name.reason);
const evidence = name.evidence, basis = evidence.preSplitFiscalYearBasis!;
const entries = zipReader.unzip(issuerZip);
const priceSource = { archivePageId: provenance.price.archivePageId, filename: provenance.price.filename,
  sha256: provenance.price.gzipSha256, bytes: priceZip };
const prices = new HoldingsPriceIndex([priceSource]);
const args = { holding, fiscalYearEnd: provenance.owner.source.fiscalYearEnd, catalog, prices };
afterEach(() => vi.restoreAllMocks());

describe("期末株数の法的分割日前後と市場日付の区別", () => {
  it("実1723の別明示文型も同じissuer/FY/普通株資格で法的日付を観測し、市場日と混同しない", () => {
    const actual = (name: string) => readFileSync(new URL(`./fixtures/holdings-split-1723/${name}`, import.meta.url));
    const source = JSON.parse(actual("provenance.json").toString());
    const zip = actual("S100YH9O.zip"), files = zipReader.unzip(zip);
    expect(hash(zip)).toBe(source.zipSha256); expect(zip.length).toBe(source.zipBytes);
    expect(hash(files.get(source.filename)!)).toBe(source.memberSha256);
    expect(verifySavedHoldingsSource(zip, source.source).status).toBe("verified");
    const unzip = vi.spyOn(zipReader, "unzip");
    const observed = observePreSplitFiscalYearBasis(zip, source.source, source.filename, files);
    expect(unzip).not.toHaveBeenCalled();
    expect(observed).toMatchObject({ source: source.source, legalEffectiveDate: "2026-04-01", numerator: 4, denominator: 1,
      fiscalYearShares: "16395000", context: { entity: "E00313-000", endDate: "2026-03-31" } });
    expect(observed?.statement).toContain("上記の事項 は、当該株式分割前の株式数を基準としております");
    expect(source.derivedPriceReference.reportedSplitDate).toBe("2026-03-30");
    expect(observed?.legalEffectiveDate).not.toBe(source.derivedPriceReference.reportedSplitDate);
    const native = files.get(source.filename)!.toString();
    for (const changed of [native.replaceAll("当社は、2026年", "子会社は、2026年"),
      native.replaceAll("上記の事項", "上記の事項の一部"), native.replaceAll("株式分割を行っております", "株式分割を予定しております")]) {
      const input = new Map(files); input.set(source.filename, Buffer.from(changed));
      expect(observePreSplitFiscalYearBasis(zip, source.source, source.filename, input)).toBeUndefined();
    }
    expect(hash(zip)).toBe(source.zipSha256);
  });
  it("全原本SHA/DEI/普通株期末fact/当期durationを固定し、原注記の明示法的4/1を観測する", () => {
    expect(hash(issuerZip)).toBe(provenance.issuer.zipSha256); expect(hash(ownerZip)).toBe(provenance.owner.zipSha256);
    expect(hash(priceZip)).toBe(provenance.price.gzipSha256); expect(hash(codes)).toBe(provenance.codeList.sha256);
    expect(verifySavedHoldingsSource(issuerZip, provenance.issuer.source).status).toBe("verified");
    expect(verifySavedHoldingsSource(ownerZip, provenance.owner.source).status).toBe("verified");
    expect(holding).toMatchObject({ shares: 7000, bookValueYen: 41790000 });
    expect(basis).toMatchObject({ source: provenance.issuer.source, legalEffectiveDate: "2026-04-01", numerator: 5, denominator: 1,
      fiscalYearShares: "2260000", context: { entity: "E00251-000", startDate: "2025-04-01", endDate: "2026-03-31" } });
    expect(basis.factSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence).toEqual(JSON.parse(read("qualified-evidence.json").toString()));
    const unzip = vi.spyOn(zipReader, "unzip");
    expect(observePreSplitFiscalYearBasis(issuerZip, provenance.issuer.source, evidence.filename, entries)).toEqual(basis);
    expect(unzip).not.toHaveBeenCalled();
  });
  it("元raw close1194/株数7000を再補正せず、missing根拠はunavailable、確定不一致は事前known HOLD", async () => {
    const native = JSON.parse(gunzipSync(priceZip).toString()).members.find((m: { api: string; symbol: string }) => m.api === "daily" && m.symbol === "1798.T");
    const raw = Buffer.from(native.bodyBase64, "base64");
    expect(hash(raw)).toBe(provenance.member.sha256); expect(raw.length).toBe(provenance.member.byteLength);
    const before = await parseDailyChart(native.symbol, "10y", raw, native.receivedAt);
    expect(before.splits).toContainEqual({ date: "2026-03-30", ratio: 5 });
    expect(await qualifyHoldingValuation(args)).toMatchObject({ status: "unavailable", reason: expect.stringContaining("法的分割日") });
    const input = { ...args, officialIssuerNames: new Map([[identity.code, evidence]]) };
    await expect(qualifyHoldingValuation(input)).rejects.toMatchObject({ name: "HoldingPriceShareBasisMismatch", proof: {
      symbol: "1798.T", fiscalYearEnd: "2026-03-31", marketExDate: "2026-03-30", priceBodySha256: provenance.member.sha256, basis } });
    await expect(qualifyHoldingValuation(input)).rejects.toBeInstanceOf(HoldingPriceShareBasisMismatch);
    expect(await parseDailyChart(native.symbol, "10y", raw, native.receivedAt)).toEqual(before);
    expect(hash(raw)).toBe(provenance.member.sha256); expect(hash(priceZip)).toBe(provenance.price.gzipSha256);
    expect(holding.shares).toBe(7000); expect(holding.bookValueYen).toBe(41790000);
  });
  it("別FY/ratio不一致は既知不一致へ昇格せず、根拠不明を保留する", async () => {
    for (const changed of [{ ...basis, numerator: 2 }, { ...basis, legalEffectiveDate: "2026-03-31" }]) {
      expect(await qualifyHoldingValuation({ ...args, officialIssuerNames: new Map([[identity.code, { ...evidence, preSplitFiscalYearBasis: changed }]]) }))
        .toMatchObject({ status: "unavailable", reason: expect.stringContaining("法的分割日") });
    }
    expect((await qualifyHoldingValuation({ ...args, fiscalYearEnd: "2026-03-30", officialIssuerNames: new Map([[identity.code, evidence]]) })).status).toBe("unavailable");
    for (const changed of [{ ...basis, source: { ...basis.source, stockCode: "1799" } }, { ...basis, context: { ...basis.context, entity: "E00250-000" } },
      { ...basis, memberSha256: "0".repeat(64) }, { ...basis, legalEffectiveDate: "2027-04-01" }]) {
      await expect(qualifyHoldingValuation({ ...args, officialIssuerNames: new Map([[identity.code, { ...evidence, preSplitFiscalYearBasis: changed }]]) })).rejects.toThrow();
    }
  });
  it("子会社/予定/別注記/文型/重複/namespace/contextの未資格はunknownのまま", () => {
    const original = entries.get(evidence.filename)!.toString();
    const note = /<jpcrp_cor:NotesRegardingIssuedSharesAndTreasurySharesTextBlock contextRef="CurrentYearDuration">[\s\S]*?<\/jpcrp_cor:NotesRegardingIssuedSharesAndTreasurySharesTextBlock>/.exec(original)![0];
    const modified = [
      original.replace(note, note.replace("当社は2026年", "子会社は2026年")),
      original.replace(note, note.replace("行っていますが", "予定していますが")),
      original.replace(note, note.replaceAll("NotesRegardingIssuedSharesAndTreasurySharesTextBlock", "NotesRegardingDividendTextBlock")),
      original.replace(note, note.replace("上記事項は当該株式分割前", "上記事項の一部は当該株式分割前")),
      original.replace(note, note + note), original.replace(note, note.replace('contextRef="CurrentYearDuration"', 'contextRef="CurrentYearDuration" xmlns:jpcrp_cor="http://untrusted.invalid"')),
      original.replace('<xbrli:context id="CurrentYearDuration">', '<xbrli:context id="CurrentYearDuration" extra="unsupported">'),
      original.replace(note, note.replace("2026年４月１日", "2026年２月30日")),
    ];
    for (const xml of modified) {
      const changed = new Map(entries); changed.set(evidence.filename, Buffer.from(xml));
      expect(observePreSplitFiscalYearBasis(issuerZip, provenance.issuer.source, evidence.filename, changed)).toBeUndefined();
    }
  });
});
