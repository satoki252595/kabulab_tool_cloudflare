/** 実5820の無加工ZIP。changed Map / decoder / budgetは明示protocol負例であり実源ではない。 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeIssuedShares } from "../services/edinet/issued-shares.js";
import * as textSections from "../services/edinet/text-sections.js";
import * as zipReader from "../services/edinet/zip.js";
const base = "./fixtures/issued-paid-5820-S100YG3G";
const p = JSON.parse(readFileSync(new URL(`${base}.provenance.json`, import.meta.url), "utf8"));
const zip = readFileSync(new URL(`${base}.zip`, import.meta.url)), entries = zipReader.unzip(zip);
const evidence = { rawSubmitDateTime: p.rawSubmitDateTime, provenance: "saved-archive-metadata" as const };
const baseline = observeIssuedShares(zip, p.source, evidence, entries);
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const oldFields = (value: ReturnType<typeof observeIssuedShares>) => { const { reportedPaidIssuance: _new, ...old } = value; return old; };
const re = /(<jpcrp_cor:ChangesInNumberOfIssuedSharesStatedCapitalEtcTextBlock\b[^>]*>)([\s\S]*?)(<\/jpcrp_cor:ChangesInNumberOfIssuedSharesStatedCapitalEtcTextBlock>)/;
function changed(change: (body: string) => string) {
  const altered = new Map(entries);
  altered.set(p.instance, Buffer.from(altered.get(p.instance)!.toString().replace(re, (_, a, b, c) => a + change(b.normalize("NFKC")) + c)));
  return observeIssuedShares(zip, p.source, evidence, altered);
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("普通株の第三者割当・明記払込期日の限定診断", () => {
  it("原ZIP/単一history/普通株FYと表の注2/date/delta/balanceに束縛し、隣接行使期間を混ぜない", () => {
    expect(zip.length).toBe(p.zipBytes); expect(sha(zip)).toBe(p.zipSha256); expect(sha(entries.get(p.instance)!)).toBe(p.memberSha256);
    expect(baseline.reportedPaidIssuance).toMatchObject({ status: "observed", historyFactSha256: p.historyFactSha256,
      normalizedTextSha256: p.normalizedTextSha256, nativeContext: { entity: "E01351-000", instantDate: "2026-06-22" },
      statements: [{ kind: "third-party-allotment", reportedPaymentDate: "2026-01-21", reportedIncreaseShares: "160000",
        shareClass: "ordinary", unit: "shares", legalEffectiveDate: null, marketExDate: null, rightsApplication: "unknown" }] });
    expect(baseline.reportedPaidIssuance!.statements).toHaveLength(1);
    expect(baseline.reportedOptionExercises).toMatchObject({ status: "held", statements: [] });
    expect(baseline.reportedCancellations).toMatchObject({ status: "not-observed" });
    const ordinary = baseline.observations!.find(o => o.qualification.kind === "fiscal-year-end")!;
    expect(ordinary.rawValue).toBe("4279965");
    expect(baseline.reportedPaidIssuance!.statements[0].ordinaryFiscalYearFactSha256).toBe(ordinary.factSha256);
    expect(Buffer.byteLength(JSON.stringify({ reportedOptionExercises: baseline.reportedOptionExercises,
      reportedCancellations: baseline.reportedCancellations, reportedPaidIssuance: baseline.reportedPaidIssuance })) - 1).toBeLessThanOrEqual(8192);
  });
  it("既verified Mapを再利用し追加展開/HTTP0、未有効・未資格を観測0へ補完しない", () => {
    const unzip = vi.spyOn(zipReader, "unzip"), fetch = vi.fn(() => { throw Error("HTTP forbidden"); }); vi.stubGlobal("fetch", fetch);
    expect(observeIssuedShares(zip, p.source, evidence, entries)).toEqual(baseline);
    expect(unzip).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(observeIssuedShares(zip, null).reportedPaidIssuance).toBeUndefined();
    expect(observeIssuedShares(zip, p.source, null, entries).reportedPaidIssuance).toMatchObject({ status: "held" });
  });
  it.each([
    ["planned", (v: string) => v.replace("日を払込期日", "日を予定払込期日")],
    ["subsidiary", (v: string) => v.replace("増資による普通株式", "増資による子会社の普通株式")],
    ["class", (v: string) => v.replace("増資による普通株式", "増資による優先株式")],
    ["revoked", (v: string) => v.replace("増資による普通株式", "増資を取消した普通株式")],
    ["quantity-unit", (v: string) => v.replace("160,000株", "160,000千株")],
    ["adjacent-option", (v: string) => v.replace("160,000株", "320,000株")],
    ["invalid-date", (v: string) => v.replace("1月21日を払込", "2月30日を払込")],
    ["future-date", (v: string) => v.replace("2026年1月21日を払込", "2027年1月21日を払込")],
    ["table-note", (v: string) => v.replace("(注2)", "(注9)")],
    ["table-date", (v: string) => v.replace("2026年1月21日", "2026年1月22日")],
    ["table-unit", (v: string) => v.replace("(株)", "(千株)")],
    ["table-balance", (v: string) => v.replace("3,959,965", "3,959,964")],
    ["FY-balance", (v: string) => v.replace("4,279,965", "4,279,964")],
    ["capital-unit", (v: string) => v.replace("資本金増減額(千円)", "資本金増減額(百万円)")],
    ["capital-note", (v: string) => v.replace("45,440千円増加", "45,439千円増加")],
    ["extra-wording", (v: string) => v + "第三者割当の訂正がありました。"],
  ])("%sは新診断HOLD、既存株数/価格/optionを補完しない", (_, change) => {
    const result = changed(change);
    expect(result.reportedPaidIssuance).toMatchObject({ status: "held", statements: [] });
    expect(result.observations!.map(o => [o.element, o.rawValue, o.factSha256, o.qualification]))
      .toEqual(baseline.observations!.map(o => [o.element, o.rawValue, o.factSha256, o.qualification]));
  });
  it("普通株unit/提出時計/historyの重複が不明なら採用しない", () => {
    const altered = new Map([...entries].map(([name, value]) => [name, Buffer.from(value.toString().replaceAll(":shares</", ":pure</"))]));
    expect(observeIssuedShares(zip, p.source, evidence, altered).reportedPaidIssuance).toMatchObject({ status: "held" });
    expect(observeIssuedShares(zip, p.source, { ...evidence, rawSubmitDateTime: "2026-06-21 09:54" }, entries).reportedPaidIssuance).toMatchObject({ status: "held" });
    const duplicate = new Map(entries), xml = duplicate.get(p.instance)!.toString(), fact = re.exec(xml)![0];
    duplicate.set(p.instance, Buffer.from(xml.replace(fact, fact + fact)));
    expect(observeIssuedShares(zip, p.source, evidence, duplicate).reportedPaidIssuance).toMatchObject({ status: "held" });
  });
  it("新decoder例外だけHOLD、既存全field/option/消却は同一", () => {
    const real = textSections.stripHtml; let calls = 0;
    vi.spyOn(textSections, "stripHtml").mockImplementation(v => { if (++calls === 5) throw Error("paid parser fault"); return real(v); });
    const actual = observeIssuedShares(zip, p.source, evidence, entries);
    expect(actual.reportedPaidIssuance).toMatchObject({ status: "held", reason: expect.stringContaining("parser-exception") });
    expect(oldFields(actual)).toEqual(oldFields(baseline));
  });
  it("既8KiB不足では旧診断を追い出さず、追加欠測をoperator HOLDへ明示", () => {
    const real = Buffer.byteLength;
    vi.spyOn(Buffer, "byteLength").mockImplementation((v, encoding) => typeof v === "string" && v.startsWith('{"reportedOptionExercises":') &&
      v.includes('"reportedPaidIssuance":') ? 8194 : real(v, encoding));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {}), actual = observeIssuedShares(zip, p.source, evidence, entries);
    expect(actual.reportedPaidIssuance).toBeUndefined(); expect(oldFields(actual)).toEqual(oldFields(baseline));
    expect(warn).toHaveBeenCalledOnce(); expect(JSON.parse(warn.mock.calls[0][0])).toMatchObject({ diagnostic: "reportedPaidIssuance", status: "held", reason: "diagnostic-budget" });
  });
});
