import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as zipReader from "../services/edinet/zip.js";
import { observeIssuedShares } from "../services/edinet/issued-shares.js";
import { parseShareholdingsData, verifyHoldingsSourceEntries, verifySavedHoldingsSource } from "../services/edinet/shareholdings.js";

const provenance = JSON.parse(readFileSync(new URL("./fixtures/issued-shares-9252-S100X7D0.provenance.json", import.meta.url), "utf8"));
const zip = readFileSync(new URL("./fixtures/issued-shares-9252-S100X7D0.zip", import.meta.url));
const entries = zipReader.unzip(zip), source = provenance.source;
const filingDateEvidence = { rawSubmitDateTime: "2025-11-28 10:39", provenance: "saved-archive-metadata" as const };
const instance = provenance.instance as string;
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const baseline = observeIssuedShares(zip, source, filingDateEvidence);
const observed = baseline.observations!.filter(o => o.qualification.status === "observed-kind");
const first = observed[0];
const firstRaw = `<${first.element}${first.rawAttributes}>${first.rawValue}</${first.element}>`;

/** Protocol-negative injection into real members; never a qualified physical source or business value. */
function changed(change: (name: string, text: string) => string) {
  const altered = new Map([...entries].map(([name, bytes]) => [name, Buffer.from(change(name, bytes.toString("utf8")))]));
  vi.spyOn(zipReader, "unzip").mockReturnValue(altered);
  return observeIssuedShares(zip, source, filingDateEvidence);
}
afterEach(() => vi.restoreAllMocks());

describe("保存実type1の発行株数限定観測", () => {
  it("原ZIP/member/原文SHAとFY/提出時の異なる実値を保持し、FilingDateInstantをFYへ転用しない", () => {
    expect(zip.length).toBe(provenance.zipBytes); expect(sha(zip)).toBe(provenance.zipSha256);
    expect(baseline.status).toBe("observed-with-holds"); expect(baseline.candidateCount).toBe(4);
    expect(baseline.instance!.memberSha256).toBe(sha(entries.get(instance)!));
    expect(baseline.instance!.namespaces!["xmlns:jpcrp_cor"]).toBe("http://disclosure.edinet-fsa.go.jp/taxonomy/jpcrp/2024-11-01/jpcrp_cor");
    expect(observed.map(o => [o.rawValue, o.qualification.kind, o.qualification.economicDate, o.qualification.nativeContextDate]))
      .toEqual([["2762891", "fiscal-year-end", "2025-08-31", "2025-11-28"], ["2774926", "filing-date", "2025-11-28", "2025-11-28"]]);
    for (const o of observed) {
      expect(o.factSha256).toBe(sha(`<${o.element}${o.rawAttributes}>${o.rawValue}</${o.element}>`));
      expect(o.qualification.rightsApplication).toBe("unknown");
      expect(o.contexts).toHaveLength(2); expect(o.units.every(u => u.valid)).toBe(true);
      for (const c of o.contexts) { expect(c.entity).toBe("E37098-000"); expect(c.definitions[0].rawDefinition).toContain(o.contextRef); }
    }
    expect(baseline.observations!.filter(o => o.qualification.status === "hold")).toHaveLength(2);
    expect(baseline.observations!.filter(o => o.qualification.status === "hold").every(o => o.qualification.reason!.includes("dimension-free"))).toBe(true);
    expect(baseline.observations!.some(o => /Summary|Treasury|Held|UnitShares/.test(o.element))).toBe(false);
  });
  it("同じ保存原本replayは決定的で、通信/モデルなし", () => {
    const fetch = vi.fn(() => { throw new Error("network forbidden"); }); vi.stubGlobal("fetch", fetch);
    try { expect(observeIssuedShares(zip, source, filingDateEvidence)).toEqual(baseline); expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.unstubAllGlobals(); }
  });
  it("共通DEIのZIP/entries入口は同じ資格を返し、既存Mapのobserverは追加展開0", () => {
    expect(verifySavedHoldingsSource(zip, source)).toEqual(verifyHoldingsSourceEntries(entries, source));
    const unzip = vi.spyOn(zipReader, "unzip");
    expect(observeIssuedShares(zip, source, filingDateEvidence, entries)).toEqual(baseline);
    expect(unzip).not.toHaveBeenCalled();
  });
  it("既存正常保有明細の全値を新source資格でも維持する", () => {
    const previous = parseShareholdingsData(zip, source);
    expect(previous.status).toBe("ok"); expect(previous.holdings).toHaveLength(1);
    const current = parseShareholdingsData(zip, source, { qualifySource: currentEntries => verifyHoldingsSourceEntries(currentEntries, source) });
    expect(current).toEqual(previous);
  });
  it("提出日契約が欠測ならnativecontextを経済提出日へ代用せず、矛盾は全kind HOLD", () => {
    const unknown = observeIssuedShares(zip, source);
    expect(unknown.observations!.filter(o => o.qualification.kind === "filing-date")).toHaveLength(0);
    expect(unknown.observations!.find(o => o.rawValue === "2774926")!.qualification.reason).toContain("filing-economic-date-unqualified");
    const mismatch = observeIssuedShares(zip, source, { ...filingDateEvidence, rawSubmitDateTime: "2025-08-31 10:39" });
    expect(mismatch.observations!.filter(o => o.qualification.status === "observed-kind")).toHaveLength(0);
    for (const rawSubmitDateTime of ["2025-11-28T10:39:00Z", "2025-11-28 99:99"]) {
      expect(observeIssuedShares(zip, source, { ...filingDateEvidence, rawSubmitDateTime }).observations!.filter(o => o.qualification.kind === "filing-date")).toHaveLength(0);
    }
  });
  it.each([null, { ...source, edinetCode: null }])("期待identity欠測はunknownのまま、原本から期待値を補わない", identity => {
    expect(observeIssuedShares(zip, identity)).toMatchObject({ status: "unknown", source: identity, observations: null, zipSha256: provenance.zipSha256 });
  });
  it.each([{ ...source, stockCode: "7203" }, { ...source, edinetCode: "E02144" }, { ...source, fiscalYearEnd: "2026-03-31" }])("DEI/issuer/FY不一致は全観測HOLD", identity => {
    expect(observeIssuedShares(zip, identity)).toMatchObject({ status: "held", observations: null });
  });
  it("壊れたZIPは明示HOLDし原SHAを保持する", () => {
    const broken = zip.subarray(0, zip.length - 22);
    expect(observeIssuedShares(broken, source)).toMatchObject({ status: "held", zipSha256: sha(broken), observations: null });
  });
  it.each(["nil", "precision", "fraction", "incomplete"])("不明な値/精度/未完fact %s を資格化しない", mode => {
    const replacement = mode === "nil" ? firstRaw.replace('decimals="0"', 'decimals="0" xsi:nil="true"') :
      mode === "precision" ? firstRaw.replace('decimals="0"', 'decimals="-3"') :
      mode === "fraction" ? firstRaw.replace(first.rawValue, `${first.rawValue}.5`) : firstRaw.replace(`</${first.element}>`, "");
    expect(replacement).not.toBe(firstRaw);
    const result = changed((name, text) => name === instance ? text.replace(firstRaw, replacement) : text);
    expect(result.observations?.find(o => o.contextRef === first.contextRef && o.element === first.element)?.qualification.status).not.toBe("observed-kind");
    if (mode === "incomplete") expect(result.status).toBe("held");
  });
  it.each(["unknown-dimension", "wrong-unit", "duplicate-context", "header-mismatch", "rebound", "unknown-taxonomy"])("native文脈 %s の曖昧さをHOLD", mode => {
    const result = changed((name, text) => {
      if (!name.endsWith(".xbrl") && !name.includes("_header_")) return text;
      if (mode === "unknown-dimension") return text.replaceAll(":OrdinaryShareMember", ":TotalClassesOfSharesMember");
      if (mode === "wrong-unit") return text.replaceAll(":shares</", ":pure</");
      if (mode === "unknown-taxonomy") return text.replaceAll("taxonomy/jpcrp/2024-11-01/jpcrp_cor", "taxonomy/jpcrp/unknown/jpcrp_cor");
      if (mode === "header-mismatch") return name.includes("_header_") ? text.replaceAll("E37098-000", "E02144-000") : text;
      if (mode === "rebound") return name === instance ? text.replace(firstRaw, firstRaw.replace("contextRef=", 'xmlns:jpcrp_cor="urn:protocol-negative" contextRef=')) : text;
      const definition = first.contexts[0].definitions[0].rawDefinition;
      return name === instance ? text.replace(definition, definition + definition) : text;
    });
    expect(result.observations!.filter(o => o.qualification.status === "observed-kind")).toHaveLength(0);
  });
  it("同element/context重複は同値でも採用しない", () => {
    const result = changed((name, text) => name === instance ? text.replace(firstRaw, firstRaw + firstRaw) : text);
    expect(result.observations!.filter(o => o.element === first.element && o.contextRef === first.contextRef).every(o => o.qualification.status === "hold")).toBe(true);
  });
  it("異なるcontextRefでも同kindが複数なら一方を選ばない", () => {
    const originalId = first.contextRef!, replacementId = `${originalId}_protocol_negative`;
    const result = changed((name, text) => {
      const c = first.contexts.find(c => c.definitions[0].filename === name);
      const withContext = c === undefined ? text : text.replace(c.definitions[0].rawDefinition, c.definitions[0].rawDefinition + c.definitions[0].rawDefinition.replace(`id="${originalId}"`, `id="${replacementId}"`));
      return name === instance ? withContext.replace(firstRaw, firstRaw + firstRaw.replace(`contextRef="${originalId}"`, `contextRef="${replacementId}"`)) : withContext;
    });
    expect(result.observations!.filter(o => o.element === first.element && o.contextRef!.includes("OrdinaryShareMember")).every(o => o.qualification.reason === "same-kind-multiple-contexts")).toBe(true);
  });
  it("診断予算超過を切り詰めた成功にしない", () => {
    const result = changed((name, text) => name === instance ? text.replace(firstRaw, firstRaw.repeat(65)) : text);
    expect(result).toMatchObject({ status: "held", candidateCount: 68, observations: null });
  });
});
