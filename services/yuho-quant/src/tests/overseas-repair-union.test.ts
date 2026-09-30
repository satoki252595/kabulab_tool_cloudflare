/**
 * Repair PREP の union/tags/分離契約テスト (offline・実 docID)。
 *
 * 集合の実体 (okdocs/manifest/census/live/compare/prep) は private /tmp
 * の pinned bytes が正本で、ここでは値・表を一切持たず docID と
 * membership tags の対応だけを pin する (docID は EDINET 公開 ID。
 * per-doc の値・表は private 0600 のみ)。合成 fixture・state machine
 * は使わない。apply-qualified 0 / fetch-deny は実 producer 経路
 * (overseas-repair-prep.ts の run) で確認する。
 *
 * 同じ doc が複数母集合に属することは正当 (dedup + 全 tags 保持)。
 * 禁止は「旧1695 を新 qualified 候補数と偽ること/母集合混同」のみで、
 * `computeQualified` が旧集合を引数に取らないこと + report の別 field
 * (`SeparatedCounts`) で構造保証する。
 */
import { describe, expect, it } from "vitest";
import {
  buildUnion,
  censusTags,
  classifyReceipt,
  computeQualified,
  separatedCounts,
  type MembershipTag,
  type NewVerdict,
} from "../../data-scripts/lib/repair-union.js";

function tagEntries(): Array<{ doc: string; tag: MembershipTag }> {
  return [
    // S1008Q8O: 3 母集合の交差 (census 採用 ∩ live1781 ∩ 旧 L1changed)。
    { doc: "S1008Q8O", tag: "census-adopted" },
    { doc: "S1008Q8O", tag: "live1781" },
    { doc: "S1008Q8O", tag: "old-l1changed1695" },
    { doc: "S1008Q8O", tag: "hist804" },
    { doc: "S1008Q8O", tag: "remain745" },
    // S1008XET: outside-live の対照 (census 採用だが live 観測なし)。
    { doc: "S1008XET", tag: "census-adopted" },
    { doc: "S1008XET", tag: "stable2871" },
    // S100AKTK: unknown-pin の対照 (pin なし・census なし・live 観測あり)。
    { doc: "S100AKTK", tag: "live1781" },
    { doc: "S100AKTK", tag: "old-l1changed1695" },
    { doc: "S100AKTK", tag: "pin73unknown" },
    { doc: "S100AKTK", tag: "stable2871" },
    // S1008Q8W: stable 側の L1changed (census 採用 ∩ live ∩ 旧 changed)。
    { doc: "S1008Q8W", tag: "census-adopted" },
    { doc: "S1008Q8W", tag: "live1781" },
    { doc: "S1008Q8W", tag: "old-l1changed1695" },
    { doc: "S1008Q8W", tag: "stable2871" },
  ];
}

describe("repair union (実 docID)", () => {
  it("重複を dedup し全 membership tags を残す (交差の正当性)", () => {
    const union = buildUnion(tagEntries());
    expect(union.size).toBe(4);
    expect(union.get("S1008Q8O")).toEqual([
      "census-adopted",
      "live1781",
      "old-l1changed1695",
      "hist804",
      "remain745",
    ]);
    // 同じ doc が両母集合にあること自体は禁止しない (tags 併存)。
    expect(union.get("S1008Q8O")).toContain("census-adopted");
    expect(union.get("S1008Q8O")).toContain("old-l1changed1695");
  });

  it("outside-live の対照: live tag なし・census tag あり", () => {
    const union = buildUnion(tagEntries());
    expect(union.get("S1008XET")).toEqual(["census-adopted", "stable2871"]);
    expect(union.get("S1008XET")).not.toContain("live1781");
    expect(union.get("S1008XET")).not.toContain("old-l1changed1695");
  });

  it("unknown-pin の対照: pin73unknown + live 観測あり + census なし", () => {
    const union = buildUnion(tagEntries());
    expect(union.get("S100AKTK")).toEqual([
      "live1781",
      "old-l1changed1695",
      "pin73unknown",
      "stable2871",
    ]);
    const tags = union.get("S100AKTK") as MembershipTag[];
    expect(tags.some((t) => t.startsWith("census-"))).toBe(false);
  });

  it("census class 決定: adopted/held/reverse/other (reverse は adopted 併持)", () => {
    expect(censusTags("ok_geo_rows", "ok_geo_rows")).toEqual(["census-adopted"]);
    expect(censusTags("ok_geo_cols", "ok_geo_rows")).toEqual(["census-adopted"]);
    expect(censusTags("ok_geo_rows", "geo_present_unstructured")).toEqual(["census-held"]);
    expect(censusTags("geo_present_unstructured", "ok_geo_cols")).toEqual([
      "census-adopted",
      "census-reverse",
    ]);
    expect(censusTags("geo_present_unstructured", "geo_present_unstructured")).toEqual([
      "census-other",
    ]);
    expect(censusTags("no_overseas_table", "no_overseas_table")).toEqual(["census-other"]);
    expect(censusTags("no_overseas_table", "geo_present_unstructured")).toEqual([
      "census-other",
    ]);
  });
});

describe("receipt 分類 (既証跡の静読のみ)", () => {
  it("証跡不在は ARCHIVE_PENDING (実 docID)", () => {
    const receipts = new Map();
    expect(classifyReceipt("S1008Q8O", receipts)).toBe("ARCHIVE_PENDING");
    expect(classifyReceipt("S100AKTK", receipts)).toBe("ARCHIVE_PENDING");
  });

  it("形状外の証跡は HOLD_RECEIPT (不正/unknown は HOLD)", () => {
    expect(
      classifyReceipt("S1008Q8O", new Map([["S1008Q8O", { sha256: "zz", bytes: 12 }]]))
    ).toBe("HOLD_RECEIPT");
    expect(
      classifyReceipt(
        "S1008Q8O",
        new Map([["S1008Q8O", { sha256: "x".repeat(64), bytes: Number.NaN }]])
      )
    ).toBe("HOLD_RECEIPT");
  });

  it("64hex+bytes の証跡のみ RECEIVED", () => {
    expect(
      classifyReceipt(
        "S1008Q8O",
        new Map([["S1008Q8O", { sha256: "a".repeat(64), bytes: 120 }]])
      )
    ).toBe("RECEIVED");
  });
});

describe("母集合分離 (旧1695 と新 qualified の混同防止)", () => {
  const newVerdicts: NewVerdict[] = [
    { doc: "S1008Q8O", validateOK: true, pinPresent: true, receipt: "ARCHIVE_PENDING" },
    { doc: "S1008XET", validateOK: true, pinPresent: true, receipt: "ARCHIVE_PENDING" },
    { doc: "S100AKTK", validateOK: false, pinPresent: false, receipt: "ARCHIVE_PENDING" },
    { doc: "S1008Q8W", validateOK: true, pinPresent: true, receipt: "ARCHIVE_PENDING" },
  ];

  it("旧 L1changed の doc でも receipt なしは qualified にならない", () => {
    // S1008Q8O/S100AKTK/S1008Q8W は旧1695 側だが、新判定は新 verdict のみ。
    expect(computeQualified(newVerdicts)).toEqual([]);
  });

  it("3 条件 (validate+pin+receipt) を満たした doc のみ qualified", () => {
    const withReceipt: NewVerdict[] = [
      ...newVerdicts,
      { doc: "S1008XET", validateOK: true, pinPresent: true, receipt: "RECEIVED" },
    ];
    // 同一 doc の 2 verdicts (pending + received): received の方が qualified。
    expect(computeQualified(withReceipt)).toEqual(["S1008XET"]);
  });

  it("report は旧数と新数を別 field で保持する (混同防止)", () => {
    const counts = separatedCounts(1695, computeQualified(newVerdicts));
    expect(counts).toEqual({ oldL1Changed1695: 1695, newQualified: 0 });
    // 旧数を新数に代入する混同は型で不可: 別名 field のみ。
    expect("oldL1Changed1695" in counts).toBe(true);
    expect("newQualified" in counts).toBe(true);
  });
});
