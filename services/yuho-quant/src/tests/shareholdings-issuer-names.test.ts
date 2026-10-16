/** 公式code listの実主体と構造XMLで、英字名集合の証拠境界を検証する。 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseHoldingsCodeList } from "../services/edinet/shareholdings-valuation.js";
import { qualifyOfficialIssuerEnglishName } from "../services/edinet/shareholdings-issuer-names.js";
import { unzip } from "../services/edinet/zip.js";
vi.mock("../services/edinet/zip.js", async original => ({ ...await original<typeof import("../services/edinet/zip.js")>(), unzip: vi.fn((await original<typeof import("../services/edinet/zip.js")>()).unzip) }));
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const list = readFileSync(new URL("../../../../pipeline/tests/fixtures/edinet/Edinetcode.zip", import.meta.url));
const catalog = parseHoldingsCodeList({ archivePageId: "a".repeat(32), filename: "Edinetcode.zip", bytes: list, sha256: sha(list) });
const identity = [...catalog.byLegalName.values()].flat().find(value => value.code === "8418")!;
const source = { docId: "S100YE1V", stockCode: identity.code, edinetCode: identity.edinetCode, fiscalYearEnd: "2026-03-31" };
const filename = "XBRL/PublicDoc/jpcrp030000-asr-001_E03622-000_2026-03-31_01_2026-06-18.xbrl";
const zip = Buffer.from("構造境界検証。実ZIP/gzipはprivate純local再現に保持");
const metadata = { docID: source.docId, edinetCode: source.edinetCode, secCode: "84180", periodEnd: source.fiscalYearEnd,
  filerName: identity.legalName, submitDateTime: "2026-06-18 15:30" };
const xml = `<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:dei="http://disclosure.edinet-fsa.go.jp/taxonomy/jpdei/2013-08-31/jpdei_cor">
<xbrli:context id="FilingDateInstant"><xbrli:entity><xbrli:identifier scheme="http://disclosure.edinet-fsa.go.jp">E03622-000</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:instant>2026-06-18</xbrli:instant></xbrli:period></xbrli:context>
<dei:EDINETCodeDEI contextRef="FilingDateInstant">E03622</dei:EDINETCodeDEI><dei:SecurityCodeDEI contextRef="FilingDateInstant">84180</dei:SecurityCodeDEI>
<dei:CurrentFiscalYearEndDateDEI contextRef="FilingDateInstant">2026-03-31</dei:CurrentFiscalYearEndDateDEI>
<dei:FilerNameInJapaneseDEI contextRef="FilingDateInstant">${identity.legalName}</dei:FilerNameInJapaneseDEI>
<dei:FilerNameInEnglishDEI contextRef="FilingDateInstant">Yamaguchi Financial Group, Inc.</dei:FilerNameInEnglishDEI></xbrli:xbrl>`;
const args = { identity, source, ownerName: identity.legalName, archived: { archivePageId: "b".repeat(32), filename: "S100YE1V_xbrl.zip", bytes: zip, sha256: sha(zip) },
  metadata, fetchedAt: "2026-06-18T15:30:00Z", priceCapturedAt: "2026-10-04T12:00:00Z" };
const check = (body: string) => { vi.mocked(unzip).mockReturnValue(new Map([[filename, Buffer.from(body)]])); return qualifyOfficialIssuerEnglishName(args); };
beforeEach(() => vi.mocked(unzip).mockReturnValue(new Map([[filename, Buffer.from(xml)]])));
describe("公式issuer英字名集合の事前資格", () => {
  it("最新主体・日本語名・公式DEI・実FilingDate context/提出日を束縛し元code list英字名を保持する", () => {
    expect(identity.englishName).toBe("Yamaguchi Finacial Group,Inc.");
    const result = check(xml); expect(result.status).toBe("verified");
    if (result.status !== "verified") throw new Error(result.reason);
    expect(result.evidence).toMatchObject({ code: "8418", edinetCode: "E03622", englishName: "Yamaguchi Financial Group, Inc.",
      source, zipSha256: sha(zip), memberSha256: sha(Buffer.from(xml)), filingDate: "2026-06-18", submittedAt: "2026-06-18T15:30+09:00", priceCapturedAt: args.priceCapturedAt });
    expect(identity.englishName).toBe("Yamaguchi Finacial Group,Inc."); expect(args.archived.bytes).toBe(zip);
  });
  it.each([
    xml.replace("E03622-000</", "E00000-000</"), xml.replace("<xbrli:instant>2026-06-18", "<xbrli:instant>2026-06-17"),
    xml.replaceAll("FilingDateInstant", "OtherInstant"), xml.replace("<dei:FilerNameInEnglishDEI", '<dei:FilerNameInEnglishDEI xmlns:dei="http://untrusted.invalid"'),
    xml.replace("http://www.xbrl.org/2003/instance", "http://untrusted.invalid"),
    xml.replace(`>${identity.legalName}</`, ">別主体</"),
  ])("context/entity/日付/namespace/法定名の反例はSTOPする", body => { expect(() => check(body)).toThrow(); });
  it("公式英字名の欠落/重複/空と価格captureより後の文書は明示HOLDする", () => {
    const tag = /<dei:FilerNameInEnglishDEI[^>]*>[^<]*<\/dei:FilerNameInEnglishDEI>/;
    expect(check(xml.replace(tag, "")).status).toBe("held");
    expect(check(xml.replace("</xbrli:xbrl>", xml.match(tag)![0] + "</xbrli:xbrl>")).status).toBe("held");
    expect(check(xml.replace("Yamaguchi Financial Group, Inc.", "")).status).toBe("held");
    expect(qualifyOfficialIssuerEnglishName({ ...args, priceCapturedAt: "2026-06-17T12:00:00Z" })).toMatchObject({ status: "held", reason: expect.stringContaining("capture") });
  });
  it("同じ英字名でも別code/EDINET/日本語名/metadata/SHAからは集合を作れない", () => {
    for (const invalid of [{ source: { ...source, stockCode: "2874" } }, { source: { ...source, edinetCode: "E02576" } },
      { ownerName: "別主体" }, { metadata: { ...metadata, docID: "S100XBSF" } }, { metadata: { ...metadata, secCode: "28740" } },
      { archived: { ...args.archived, sha256: "0".repeat(64) } }]) expect(() => qualifyOfficialIssuerEnglishName({ ...args, ...invalid })).toThrow();
  });
});
