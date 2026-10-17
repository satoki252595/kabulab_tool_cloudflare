/** Actual saved sources; no generated names, share counts, monetary values or dates. */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseShareholdingsData, verifyHoldingsSourceEntries, type ShareholdingsSource, type ShareholdingsExtraction } from "../services/edinet/shareholdings.js";
import { unzip } from "../services/edinet/zip.js";
const dir = new URL("./fixtures/holdings-largest-holder/", import.meta.url);
interface SavedSource {
  filename: string; zipBytes: number; zipSha256: string; nativeMember: string;
  memberSha256: string; blockUtf8Range: [number, number]; wholeBlockSha256: string;
  baselineParsed: ShareholdingsExtraction; baselineFieldsSha256: string; source: ShareholdingsSource;
}
const provenance: { items: SavedSource[] } = JSON.parse(readFileSync(new URL("provenance.json", dir), "utf8"));
const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("実保存の最大保有会社と提出会社を区別するscope", () => {
  it.each(provenance.items)("$source.stockCode 原文/順序/旧全fieldを保存", item => {
    const zip = readFileSync(new URL(item.filename, dir));
    expect(zip.length).toBe(item.zipBytes); expect(sha(zip)).toBe(item.zipSha256);
    const entries = unzip(zip), member = entries.get(item.nativeMember)!;
    expect(sha(member)).toBe(item.memberSha256);
    expect(sha(member.subarray(...item.blockUtf8Range))).toBe(item.wholeBlockSha256);
    expect(sha(JSON.stringify(item.baselineParsed))).toBe(item.baselineFieldsSha256);
    const parsed = parseShareholdingsData(zip, item.source, { qualifySource: value => verifyHoldingsSourceEntries(value, item.source) });
    if (item.source.stockCode === "208A") {
      expect(parsed).toMatchObject({ status: "unsupported", holderScope: "unqualified", holdings: [], reason: expect.stringContaining("株式会社構造計画研究所") });
      const oldFields = (value: ShareholdingsExtraction) => { const { status: _status, reason: _reason, holdings: _rows, holderScope: _scope, ...rest } = value; return rest; };
      expect(oldFields(parsed)).toEqual(oldFields(item.baselineParsed));
    } else {
      // 1518 declaration is AFTER filer rows; 2498 has an explicit self phrase;
      // 1407 resumes an explicit filer section after the named other company.
      expect(parsed).toEqual(item.baselineParsed);
    }
  });
  it("7322の別名義はHOLDを維持し、純投資目的変更表をskipして70行採用しない", () => {
    const base = new URL("./fixtures/holdings-split-explicit-before/", import.meta.url);
    const items: Array<{ code: string; filename: string; zipSha256: string; source: ShareholdingsSource }> = JSON.parse(readFileSync(new URL("provenance.json", base), "utf8")).items;
    const item = items.find(i => i.code === "7322")!;
    const zip = readFileSync(new URL(item.filename, base)); expect(sha(zip)).toBe(item.zipSha256);
    expect(parseShareholdingsData(zip, item.source, { qualifySource: value => verifyHoldingsSourceEntries(value, item.source) }))
      .toMatchObject({ status: "unsupported", holdings: [], holderScope: "unqualified", reason: expect.stringContaining("株式会社三十三銀行") });
  });
  it("通常parserは追加HTTPを使わず、元ZIP/metadata/既存価格を変更しない", () => {
    const fetch = vi.fn(() => { throw new Error("source HTTP forbidden"); }); vi.stubGlobal("fetch", fetch);
    try {
      const item = provenance.items[0], zip = readFileSync(new URL(item.filename, dir)), before = sha(zip), source = JSON.stringify(item.source);
      const parsed = parseShareholdingsData(zip, item.source, { qualifySource: value => verifyHoldingsSourceEntries(value, item.source) });
      expect(parsed.status).toBe("unsupported"); expect(sha(zip)).toBe(before); expect(JSON.stringify(item.source)).toBe(source); expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});
