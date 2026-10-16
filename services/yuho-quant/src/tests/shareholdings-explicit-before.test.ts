/** Real saved 4116/7609 issuer notes and ordinary-share facts. No fetched or synthesized prices. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qualifyOfficialIssuerEnglishName } from "../services/edinet/shareholdings-issuer-names.js";
import { observePreSplitFiscalYearBasis } from "../services/edinet/shareholdings-split-basis.js";
import { parseHoldingsCodeList } from "../services/edinet/shareholdings-valuation.js";
import { verifySavedHoldingsSource } from "../services/edinet/shareholdings.js";
import { stripHtml } from "../services/edinet/text-sections.js";
import * as zipReader from "../services/edinet/zip.js";
const dir = "./fixtures/holdings-split-explicit-before/";
const read = (name: string) => readFileSync(new URL(dir + name, import.meta.url));
const provenance = JSON.parse(read("provenance.json").toString());
const prior = JSON.parse(readFileSync(new URL("./fixtures/holdings-split-1798/provenance.json", import.meta.url)).toString());
const codes = readFileSync(new URL("./fixtures/holdings-split-1798/Edinetcode.zip", import.meta.url));
const catalog = parseHoldingsCodeList({ ...prior.codeList, bytes: codes });
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
afterEach(() => vi.restoreAllMocks());

describe("明示された普通株の分割前期末単位だけを読む", () => {
  for (const item of provenance.items) {
    it(`実${item.code}の別文型を通常issuer経路でも読み、原法的日付/FY株数/SHAを保持する`, () => {
      const zip = read(item.filename), entries = zipReader.unzip(zip);
      expect(zip.length).toBe(item.zipBytes); expect(sha(zip)).toBe(item.zipSha256);
      expect(verifySavedHoldingsSource(zip, item.source).status).toBe("verified");
      expect(sha(entries.get(item.basis.filename)!)).toBe(item.basis.memberSha256);
      const unzip = vi.spyOn(zipReader, "unzip");
      expect(observePreSplitFiscalYearBasis(zip, item.source, item.basis.filename, entries)).toEqual(item.basis);
      expect(unzip).not.toHaveBeenCalled();
      const identities = [...catalog.byLegalName.values()].flat().filter(v => v.code === item.code);
      expect(identities.length).toBe(1);
      const normal = qualifyOfficialIssuerEnglishName({ identity: identities[0], source: item.source, ownerName: item.ownerName,
        archived: { archivePageId: item.archivePageId, filename: `${item.source.docId}_xbrl.zip`, sha256: item.zipSha256, bytes: zip },
        metadata: item.sourceMetadata, fetchedAt: item.sourceFetchedAt, priceCapturedAt: item.derivedPriceReference.receivedAt });
      expect(normal.status).toBe("verified");
      if (normal.status !== "verified") throw new Error(normal.reason);
      expect(normal.evidence.preSplitFiscalYearBasis).toEqual(item.basis);
      expect(unzip).toHaveBeenCalledTimes(1);
      expect(item.basis.legalEffectiveDate > item.source.fiscalYearEnd).toBe(true);
      expect(item.basis.legalEffectiveDate).not.toBe(item.derivedPriceReference.reportedSplit.date);
      expect(sha(zip)).toBe(item.zipSha256);
    });
  }
  it("非当期/重複/子会社/予定/一部/分子分母/小数/日付不正を一意のbasisへ採らない", () => {
    const item = provenance.items[0], zip = read(item.filename), entries = zipReader.unzip(zip);
    const original = entries.get(item.basis.filename)!.toString();
    const fact = /<jpcrp_cor:NotesRegardingIssuedSharesAndTreasurySharesTextBlock contextRef="CurrentYearDuration">[\s\S]*?<\/jpcrp_cor:NotesRegardingIssuedSharesAndTreasurySharesTextBlock>/.exec(original)![0];
    // Negative cases project the exact note display text; HTML spans otherwise split literal dates/numbers.
    const display = stripHtml(stripHtml(fact.slice(fact.indexOf(">") + 1, fact.lastIndexOf("</")))).normalize("NFKC");
    const plain = `<jpcrp_cor:NotesRegardingIssuedSharesAndTreasurySharesTextBlock contextRef="CurrentYearDuration">${display}</jpcrp_cor:NotesRegardingIssuedSharesAndTreasurySharesTextBlock>`;
    const projected = original.replace(fact, plain), projectedEntries = new Map(entries);
    projectedEntries.set(item.basis.filename, Buffer.from(projected));
    expect(observePreSplitFiscalYearBasis(zip, item.source, item.basis.filename, projectedEntries)?.statement).toBe(item.basis.statement);
    const cases = [projected.replace(plain, plain + plain),
      projected.replace(plain, plain.replace('contextRef="CurrentYearDuration"', 'contextRef="Prior1YearDuration"')),
      projected.replace(plain, plain.replace("当社は2026年", "子会社は2026年")),
      projected.replace(plain, plain.replace("行っておりますが", "予定しておりますが")),
      projected.replace(plain, plain.replace("上記の事項は", "上記の事項の一部は")),
      projected.replace(plain, plain.replace("1株につき4株", "0株につき4株")),
      projected.replace(plain, plain.replace("1株につき4株", "1株につき1株")),
      projected.replace(plain, plain.replace("1株につき4株", "1株につき4.5株")),
      projected.replace(plain, plain.replace("2026年4月1日", "2026年4月31日")),
      projected.replace(plain, plain.replaceAll("NotesRegardingIssuedSharesAndTreasurySharesTextBlock", "ChangesInNumberOfIssuedSharesStatedCapitalEtcTextBlock"))];
    for (const xml of cases) {
      const changed = new Map(entries); changed.set(item.basis.filename, Buffer.from(xml));
      expect(observePreSplitFiscalYearBasis(zip, item.source, item.basis.filename, changed)).toBeUndefined();
    }
    expect(sha(zip)).toBe(item.zipSha256);
  });
  it("FY/普通株dimension/株数unitの不一致はHOLDし、異なる保有者FYへ基準を借りない", () => {
    const item = provenance.items[0], zip = read(item.filename), entries = zipReader.unzip(zip), original = entries.get(item.basis.filename)!.toString();
    expect(observePreSplitFiscalYearBasis(zip, { ...item.source, fiscalYearEnd: "2025-03-31" }, item.basis.filename, entries)).toBeUndefined();
    const shareFact = [...original.matchAll(/<jpcrp_cor:NumberOfIssuedSharesAsOfFiscalYearEndIssuedSharesTotalNumberOfSharesEtc\b[^>]*>[\s\S]*?<\/jpcrp_cor:NumberOfIssuedSharesAsOfFiscalYearEndIssuedSharesTotalNumberOfSharesEtc>/g)]
      .find(fact => sha(fact[0]) === item.basis.issuedSharesFactSha256)!;
    for (const xml of [original.replaceAll("jpcrp_cor:OrdinaryShareMember", "jpcrp_cor:ClassAShareMember"),
      original.replace(shareFact[0], shareFact[0].replace(/\bunitRef="[^"]+"/, 'unitRef="JPY"'))]) {
      const changed = new Map(entries); changed.set(item.basis.filename, Buffer.from(xml));
      expect(observePreSplitFiscalYearBasis(zip, item.source, item.basis.filename, changed)).toBeUndefined();
    }
    const other = provenance.items[1];
    expect(other.source.fiscalYearEnd).toBe("2025-12-31");
    expect(other.derivedPriceReference.ownerFiscalYearEnd).toBe("2026-03-31");
    expect(other.source.fiscalYearEnd).not.toBe(other.derivedPriceReference.ownerFiscalYearEnd);
  });
});
