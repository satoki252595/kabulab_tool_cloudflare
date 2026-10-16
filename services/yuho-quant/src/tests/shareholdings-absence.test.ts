import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import * as zipReader from "../services/edinet/zip.js";
import { parseShareholdingsData, type ShareholdingsSource } from "../services/edinet/shareholdings.js";

const bytes = readFileSync(new URL("./fixtures/holdings-explicit-not-applicable.json.gz", import.meta.url));
const provenance = JSON.parse(readFileSync(new URL("./fixtures/holdings-explicit-not-applicable.provenance.json", import.meta.url), "utf8"));
const fixtures = JSON.parse(gunzipSync(bytes).toString("utf8")) as Array<{
  source: ShareholdingsSource; filename: string; members: Record<string, string>;
}>;
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
// Full real members at the unzip boundary. The gzip test container is explicitly not an original physical EDINET ZIP.
function parse(code: string, change = (_name: string, text: string) => text) {
  const fixture = fixtures.find(f => f.source.stockCode === code)!;
  vi.spyOn(zipReader, "unzip").mockReturnValue(new Map(Object.entries(fixture.members).map(([name, text]) => [name, Buffer.from(change(name, text))])));
  return parseShareholdingsData(bytes, fixture.source);
}
afterEach(() => vi.restoreAllMocks());

describe("提出会社の株式保有節の明示不該当", () => {
  it("保存142A/143Aの全段落・DEI・同issuerの実contextだけを資格化し、株数0や期末日を作らない", () => {
    expect(sha(bytes)).toBe(provenance.fixtureSha256);
    for (const code of ["142A", "143A"]) {
      const fixture = fixtures.find(f => f.source.stockCode === code)!;
      const proof = provenance.members.find((m: { source: ShareholdingsSource }) => m.source.stockCode === code);
      for (const member of proof.members) expect(sha(fixture.members[member.filename])).toBe(member.memberSha256);
      const result = parse(code);
      expect(result).toMatchObject({ status: "explicit_not_applicable", holderScope: "filer_only", holdings: [],
        notApplicable: { version: 1, basis: code === "142A" ? "filer_both_investment_purposes_absent" : "whole_section_not_applicable",
          zipSha256: sha(bytes), filename: fixture.filename, memberSha256: sha(fixture.members[fixture.filename]),
          blockHtmlSha256: proof.blockHtmlSha256,
          context: { contextRef: "FilingDateInstant", entity: `${fixture.source.edinetCode}-000`, instantDate: "2026-06-23" } } });
      expect(result.notApplicable!.context.instantDate).not.toBe(result.source.fiscalYearEnd);
      expect(result.notApplicable!.statement).toContain("該当事項はありません。");
    }
  });
  it("141Aの子会社5銘柄・提出会社非上場1と一部不該当を全保有無しにしない", () => {
    expect(parse("141A")).toMatchObject({ status: "no_detail_table", holdings: [], holderScope: "unqualified" });
    expect(parse("141A").notApplicable).toBeUndefined();
  });
  it.each(["filer", "clause", "visible", "partial", "continued", "nil", "namespace", "extra"])("原本から作った負例%sは資格化しない", mode => {
    const code = mode === "filer" || mode === "clause" ? "142A" : "143A";
    const fixture = fixtures.find(f => f.source.stockCode === code)!;
    const result = parse(code, (name, text) => {
      if (name !== fixture.filename) return text;
      if (mode === "namespace") return text.replace('xmlns:jpcrp_cor="http://disclosure.edinet-fsa.go.jp/taxonomy/jpcrp/2025-11-01/jpcrp_cor"', 'xmlns:jpcrp_cor="urn:protocol-negative"');
      const target = /<ix:nonNumeric\b[^>]*\bname="jpcrp_cor:ShareholdingsTextBlock"[^>]*>[\s\S]*?<\/ix:nonNumeric>/.exec(text)![0];
      const altered = mode === "filer" ? target.replace("当社は、", "当社の子会社は、") :
        mode === "clause" ? target.replace("純投資目的以外の目的の株式のいずれも", "純投資目的以外の目的の株式を") :
        mode === "visible" ? target.replace("該当事項はありません。", "該当事項がありません。") :
        mode === "partial" ? target.replace("【株式の保有状況】", "【みなし保有株式】") :
        mode === "continued" ? target.replace('escape="true">', 'escape="true" continuedAt="unresolved">') :
        mode === "nil" ? target.replace('escape="true">', 'escape="true" xsi:nil="true">') :
        target.replace("該当事項はありません。", "該当事項はありません。当社");
      expect(altered).not.toBe(target);
      return text.replace(target, altered);
    });
    expect(result.status).not.toBe("explicit_not_applicable"); expect(result.status).not.toBe("ok");
    expect(result.notApplicable).toBeUndefined(); expect(result.holdings).toEqual([]);
  });
  it.each(["entity", "date", "duplicate", "dei"])("同issuer/context/DEIが%sで不明なら節だけから補完しない", mode => {
    const result = parse("143A", (name, text) => {
      if (!name.endsWith(".xbrl") && !name.includes("_header_")) return text;
      if (mode === "entity") return text.replaceAll("E39406-000", "E39367-000");
      if (mode === "date") return text.replaceAll("2026-06-23", "2026-03-31");
      if (mode === "dei") return text.replace(":SecurityCodeDEI", ":UnqualifiedSecurityCodeDEI");
      const context = /<xbrli:context\s+id="FilingDateInstant"\s*>[\s\S]*?<\/xbrli:context>/.exec(text)!;
      return text.replace(context[0], context[0] + context[0]);
    });
    expect(result.status).not.toBe("explicit_not_applicable"); expect(result.notApplicable).toBeUndefined();
  });
});
