/** Actual official filings; mutations/budget faults below are protocol-negative projections only. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { observeIssuedShares } from "../services/edinet/issued-shares.js";
import * as textSections from "../services/edinet/text-sections.js";
import * as zipReader from "../services/edinet/zip.js";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const samples = [["6484", "S100YH48"], ["6908", "S100Z5N2"], ["7313", "S100YCXB"]].map(([code, doc]) => {
  const p = JSON.parse(readFileSync(new URL(`./fixtures/issued-cancellation-${code}-${doc}.provenance.json`, import.meta.url), "utf8"));
  const zip = readFileSync(new URL(`./fixtures/issued-cancellation-${code}-${doc}.zip`, import.meta.url));
  const entries = zipReader.unzip(zip), evidence = { rawSubmitDateTime: p.rawSubmitDateTime, provenance: "saved-archive-metadata" as const };
  return { p, zip, entries, evidence, baseline: observeIssuedShares(zip, p.source, evidence, entries) };
});
const sample = samples[1];
const re = /(<jpcrp_cor:ChangesInNumberOfIssuedSharesStatedCapitalEtcTextBlock\b[^>]*>)([\s\S]*?)(<\/jpcrp_cor:ChangesInNumberOfIssuedSharesStatedCapitalEtcTextBlock>)/;
function changed(change: (body: string) => string, target = sample) {
  const entries = new Map(target.entries);
  entries.set(target.p.instance, Buffer.from(entries.get(target.p.instance)!.toString().replace(re, (_, a, b, c) => a + change(b.normalize("NFKC")) + c)));
  return observeIssuedShares(target.zip, target.p.source, target.evidence, entries);
}
const legacy = (value: ReturnType<typeof observeIssuedShares>) => { const { reportedCancellations: _new, reportedPaidIssuance: _paid, ...old } = value; return old; };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("原文で実施済み普通株消却を明示する実3源", () => {
  it.each(samples)("$p.source.stockCode 原ZIP・history・普通株FY・表の日付と減少数を束縛", ({ p, zip, entries, baseline }) => {
    expect(zip.length).toBe(p.zipBytes); expect(sha(zip)).toBe(p.zipSha256); expect(sha(entries.get(p.instance)!)).toBe(p.memberSha256);
    const diagnostic = baseline.reportedCancellations!;
    expect(diagnostic).toMatchObject({ status: "observed", historyFactSha256: p.historyFactSha256,
      normalizedTextSha256: p.normalizedTextSha256, nativeContext: { instantDate: p.rawSubmitDateTime.slice(0, 10) } });
    expect(diagnostic.statements).toHaveLength(1);
    expect(diagnostic.statements[0]).toMatchObject({ reportedCancellationDate: p.expectedReportedDate,
      reportedCancelledShares: p.expectedReportedCancelledShares, shareClass: "ordinary", unit: "shares",
      legalEffectiveDate: null, marketExDate: null, rightsApplication: "unknown" });
    const fy = baseline.observations!.find(x => x.qualification.status === "observed-kind" && x.qualification.kind === "fiscal-year-end")!;
    expect(fy.rawValue).toBe(p.expectedOrdinaryFiscalYearEndShares);
    expect(diagnostic.statements[0].ordinaryFiscalYearFactSha256).toBe(fy.factSha256);
    expect(Buffer.byteLength(JSON.stringify({ reportedOptionExercises: baseline.reportedOptionExercises, reportedCancellations: diagnostic })) - 1).toBeLessThanOrEqual(8192);
  });
  it("同じMapを共用し追加展開/HTTPなしで決定的。未有効・旧receipt欠測を観測0にしない", () => {
    const unzip = vi.spyOn(zipReader, "unzip"), fetch = vi.fn(() => { throw new Error("network forbidden"); }); vi.stubGlobal("fetch", fetch);
    expect(observeIssuedShares(sample.zip, sample.p.source, sample.evidence, sample.entries)).toEqual(sample.baseline);
    expect(unzip).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(observeIssuedShares(sample.zip, null).reportedCancellations).toBeUndefined();
  });
  it.each([
    ["planned", (v: string) => v.replace("実施した", "実施予定の")],
    ["subsidiary", (v: string) => v.replace("普通株式122,819", "子会社の普通株式122,819")],
    ["third-party", (v: string) => v.replace("(注)", "(注)第三者割当")],
    ["revoked", (v: string) => v.replace("消却による", "消却を取消したことによる")],
    ["share-class", (v: string) => v.replace("普通株式122,819", "優先株式122,819")],
    ["thousand-shares", (v: string) => v.replace("122,819株の消却", "122,819千株の消却")],
    ["fraction", (v: string) => v.replace("122,819株の消却", "122,819.5株の消却")],
    ["invalid-date", (v: string) => v.replace("2月13日付", "2月30日付")],
    ["future-date", (v: string) => v.replace("2025年2月13日付", "2027年2月13日付")],
    ["table-unit", (v: string) => v.replace("(株)", "(千株)")],
    ["table-delta", (v: string) => v.replace("△122,819", "△122,818")],
    ["table-sign", (v: string) => v.replace("△122,819", "122,819")],
    ["table-fy-balance", (v: string) => v.replace("24,460,879", "24,460,878")],
  ])("%sはHOLD、原本観測値/価格/既存optionを補完しない", (_, change) => {
    const actual = changed(change);
    expect(actual.reportedCancellations).toMatchObject({ status: "held", statements: [] });
    // Corrupted member SHA must change; the original issued fact values/qualifications do not.
    expect(actual.observations!.map(o => [o.element, o.rawValue, o.factSha256, o.qualification]))
      .toEqual(sample.baseline.observations!.map(o => [o.element, o.rawValue, o.factSha256, o.qualification]));
  });
  it.each(["取得", "処分"])("消却ではない自己株式%sを非観測として区別", word => {
    expect(changed(v => v.replaceAll("消却", word)).reportedCancellations).toMatchObject({ status: "not-observed", statements: [] });
  });
  it("注番号・一意行・全原文の曖昧さをfirst-matchで採用しない", () => {
    const { p } = samples[2];
    expect(changed(v => v.replace("(注2)", "(注3)"), samples[2]).reportedCancellations).toMatchObject({ status: "held" });
    const repeated = changed(v => v.replace("消却によるものであります。", "消却によるものであります。(注)2025年2月13日付で実施した、普通株式122,819株の消却によるものであります。"));
    expect(repeated.reportedCancellations).toMatchObject({ status: "held" });
    expect(p.expectedReportedCancelledShares).toBe("12000000");
  });
  it("元の普通株unit/提出時計・決議日が未資格なら消却を採用しない", () => {
    for (const evidence of [null, { ...sample.evidence, rawSubmitDateTime: "2026-09-30 16:10" }]) {
      expect(observeIssuedShares(sample.zip, sample.p.source, evidence, sample.entries).reportedCancellations).toMatchObject({ status: "held" });
    }
    const entries = new Map([...sample.entries].map(([name, bytes]) => [name, Buffer.from(bytes.toString().replaceAll(":shares</", ":pure</"))]));
    expect(observeIssuedShares(sample.zip, sample.p.source, sample.evidence, entries).reportedCancellations).toMatchObject({ status: "held" });
    expect(changed(v => v.replace("2024年1月29日開催", "2024年2月29日開催"), samples[0]).reportedCancellations).toMatchObject({ status: "held" });
  });
  it("新診断だけの例外は旧全field/optionを保存してHOLD", () => {
    const real = textSections.stripHtml; let calls = 0;
    vi.spyOn(textSections, "stripHtml").mockImplementation(value => { if (++calls === 3) throw new RangeError("cancellation protocol decoder failure"); return real(value); });
    const actual = observeIssuedShares(sample.zip, sample.p.source, sample.evidence, sample.entries);
    expect(legacy(actual)).toEqual(legacy(sample.baseline));
    expect(actual.reportedCancellations).toMatchObject({ status: "held", reason: expect.stringContaining("parser-exception") });
  });
  it("合計8KiB不足は旧optionを保持。最小HOLDも入らない場合は明示operator HOLD通知してundefined", () => {
    const real = Buffer.byteLength;
    // Byte-budget fault injection only; no financial/string field is fabricated.
    vi.spyOn(Buffer, "byteLength").mockImplementation((value, encoding) => typeof value === "string" && value.startsWith('{"reportedOptionExercises":') &&
      value.includes('"reportedCancellations":') ? 8194 : real(value, encoding));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const actual = observeIssuedShares(sample.zip, sample.p.source, sample.evidence, sample.entries);
    expect(legacy(actual)).toEqual(legacy(sample.baseline)); expect(actual.reportedCancellations).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce(); expect(JSON.parse(warn.mock.calls[0][0])).toMatchObject({ status: "held", reason: "diagnostic-budget",
      code: sample.p.source.stockCode, docId: sample.p.source.docId, zipSha256: sample.p.zipSha256 });
  });
});
