/** Actual public filing bytes; protocol negatives do not represent qualified physical sources. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { observeIssuedShares } from "../services/edinet/issued-shares.js";
import * as textSections from "../services/edinet/text-sections.js";
import * as zipReader from "../services/edinet/zip.js";

const p = JSON.parse(readFileSync(new URL("./fixtures/issued-shares-2375-S100XHRP.provenance.json", import.meta.url), "utf8"));
const zip = readFileSync(new URL("./fixtures/issued-shares-2375-S100XHRP.zip", import.meta.url));
const entries = zipReader.unzip(zip);
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const observed = observeIssuedShares(zip, p.source, null, entries);
const re = /(<jpcrp_cor:ChangesInNumberOfIssuedSharesStatedCapitalEtcTextBlock\b[^>]*>)([\s\S]*?)(<\/jpcrp_cor:ChangesInNumberOfIssuedSharesStatedCapitalEtcTextBlock>)/;
function changed(change: (value: string, name: string) => string) {
  const altered = new Map([...entries].map(([name, bytes]) => [name, Buffer.from(change(bytes.toString("utf8"), name))]));
  return observeIssuedShares(zip, p.source, null, altered);
}
function textChanged(change: (value: string) => string) {
  return changed((value, name) => name === p.instance ? value.replace(re, (_, open, body, close) => open + change(body.normalize("NFKC")) + close) : value);
}
afterEach(() => vi.restoreAllMocks());

describe("実2375の明示新株予約権行使期間・掲載増加株数", () => {
  it("原ZIP/fact/SHAを保ち6期間だけ観測し、各行使日・普通株・係数を推定しない", () => {
    expect(zip.length).toBe(p.zipBytes); expect(sha(zip)).toBe(p.zipSha256);
    expect(sha(entries.get(p.instance)!)).toBe(p.memberSha256);
    const option = observed.reportedOptionExercises!;
    expect(option.status).toBe("observed"); expect(option.factSha256).toBe(p.factSha256);
    expect(option.nativeContext).toEqual({ entity: "E05356-000", instantDate: p.nativeFilingDateInstant });
    expect(option.statements.map(s => [s.periodStart, s.periodEnd, s.reportedIncreaseShares])).toEqual(p.expectedPeriods);
    for (const statement of option.statements) expect(statement).toMatchObject({ unit: "shares", shareClass: "unknown",
      individualExerciseDate: null, legalEffectiveDate: null, rightsApplication: "unknown" });
    expect(observed.sourceQualification.status).toBe("verified");
  });
  it("同じMapは追加ZIP展開/通信0で決定的に再生する", () => {
    const unzip = vi.spyOn(zipReader, "unzip"), fetch = vi.fn(() => { throw new Error("network forbidden"); });
    vi.stubGlobal("fetch", fetch);
    try { expect(observeIssuedShares(zip, p.source, null, entries)).toEqual(observed); expect(unzip).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.unstubAllGlobals(); }
  });
  it.each([
    ["malformed commas", (v: string) => v.replaceAll("5,350株", "5,35株")],
    ["thousand shares", (v: string) => v.replaceAll("5,350株", "5,350千株")],
    ["invalid date", (v: string) => v.replaceAll("2021年3月31日", "2021年3月32日")],
    ["reverse interval", (v: string) => v.replaceAll("2020年11月1日", "2022年11月1日")],
    ["future interval", (v: string) => v.replaceAll("2025年10月31日", "2027年10月31日")],
    ["excluded amount", (v: string) => v.replaceAll("5,350株増加しております", "5,350株の増加は含まれておりません")],
  ])("%s は補完せず新診断HOLD・旧発行株数を保持", (_, change) => {
    const actual = textChanged(change);
    expect(actual.reportedOptionExercises).toMatchObject({ status: "held", statements: [] });
    expect(actual.observations!.map(o => [o.element, o.rawValue, o.factSha256, o.qualification]))
      .toEqual(observed.observations!.map(o => [o.element, o.rawValue, o.factSha256, o.qualification]));
  });
  it("新HTML診断だけの例外を隔離し、旧観測の値と全proofを保持する", () => {
    const boom = vi.spyOn(textSections, "stripHtml").mockImplementation(() => { throw new RangeError("protocol decoder failure"); });
    const actual = observeIssuedShares(zip, p.source, null, entries);
    boom.mockRestore();
    const { reportedOptionExercises, reportedCancellations: _new, reportedPaidIssuance: _paid, ...old } = actual;
    const { reportedOptionExercises: prior, reportedCancellations: _priorNew, reportedPaidIssuance: _priorPaid, ...expected } = observed;
    expect(old).toEqual(expected); expect(prior!.status).toBe("observed");
    expect(reportedOptionExercises).toMatchObject({ status: "held", statements: [], reason: expect.stringContaining("parser-exception") });
    const invalidEntity = textChanged(v => v.replaceAll("5,350株", "&#999999999999;株"));
    expect(invalidEntity.reportedOptionExercises).toMatchObject({ status: "held", statements: [] });
    expect(invalidEntity.status).toBe(observed.status);
    expect(invalidEntity.observations!.map(o => [o.element, o.rawValue, o.factSha256, o.qualification]))
      .toEqual(observed.observations!.map(o => [o.element, o.rawValue, o.factSha256, o.qualification]));
  });
  it("旧64KiB近傍でも旧値を捨てず、新診断の別8KiBを含む72KiB内に保存する", () => {
    const actual = changed((value, name) => name === p.instance ? value.replace(
      '<xbrli:context id="FilingDateInstant_OrdinaryShareMember">',
      '<xbrli:context id="FilingDateInstant_OrdinaryShareMember">' + " ".repeat(25_100)) : value);
    const { reportedOptionExercises, reportedCancellations: _new, reportedPaidIssuance: _paid, ...old } = actual;
    const oldBytes = Buffer.byteLength(JSON.stringify(old));
    expect(oldBytes).toBeGreaterThan(63 * 1024); expect(oldBytes).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(JSON.stringify(actual))).toBeGreaterThan(64 * 1024);
    expect(Buffer.byteLength(JSON.stringify(actual))).toBeLessThanOrEqual(72 * 1024);
    expect(reportedOptionExercises!.statements).toHaveLength(6);
    expect(actual.observations!.map(o => [o.rawValue, o.qualification])).toEqual(observed.observations!.map(o => [o.rawValue, o.qualification]));
  });
  it("提出時計の明示矛盾/不正はnativecontextで埋めず新診断HOLD", () => {
    for (const rawSubmitDateTime of ["2026-01-27 10:00", "2026-01-28T10:00:00Z"]) {
      expect(observeIssuedShares(zip, p.source, { rawSubmitDateTime, provenance: "saved-archive-metadata" }, entries)
        .reportedOptionExercises).toMatchObject({ status: "held", statements: [] });
    }
  });
  it("unknown context/entity/namespace、未完・重複の原文を採用しない", () => {
    for (const change of [
      (value: string, name: string) => name === p.instance ? value.replace(re, (_, open, body, close) => open.replace('contextRef="FilingDateInstant"', 'contextRef="UnqualifiedInstant"') + body + close) : value,
      (value: string) => value.replace(/<xbrli:identifier scheme="http:\/\/disclosure.edinet-fsa.go.jp">E05356-000<\/xbrli:identifier>/g, '<xbrli:identifier scheme="http://disclosure.edinet-fsa.go.jp">E02144-000</xbrli:identifier>'),
      (value: string, name: string) => name === p.instance ? value.replace('xmlns:jpcrp_cor="http://disclosure.edinet-fsa.go.jp/taxonomy/jpcrp/2024-11-01/jpcrp_cor"', 'xmlns:jpcrp_cor="urn:unqualified"') : value,
      (value: string, name: string) => name === p.instance ? value.replace(re, "$1$2") : value,
      (value: string, name: string) => name === p.instance ? value.replace(re, "$&$&") : value,
    ]) expect(changed(change).reportedOptionExercises).toMatchObject({ status: "held", statements: [] });
  });
});
