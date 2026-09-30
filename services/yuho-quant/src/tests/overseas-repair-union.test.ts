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
 * 禁止は「旧1695 を新候補数と偽ること/母集合混同」のみで、
 * `computeOfflineCandidates` が旧集合を引数に取らないこと + report の別 field
 * (`SeparatedCounts`: 旧数・offline 候補・liveReady・applyQualified) で構造保証する。
 */
import { describe, expect, it } from "vitest";
import {
  buildUnion,
  censusTags,
  classifyReceipt,
  computeOfflineCandidates,
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
  const actual = { sha256: "a".repeat(64), bytes: 120 };

  it("証跡不在は ARCHIVE_PENDING (実 docID)", () => {
    const receipts = new Map();
    expect(classifyReceipt("S1008Q8O", receipts, actual)).toEqual({
      state: "ARCHIVE_PENDING",
      shaMatch: false,
    });
    expect(classifyReceipt("S100AKTK", receipts, actual).state).toBe("ARCHIVE_PENDING");
  });

  it("形状外の証跡は HOLD_RECEIPT (不正/unknown は HOLD)", () => {
    expect(
      classifyReceipt("S1008Q8O", new Map([["S1008Q8O", { sha256: "zz", bytes: 12 }]]), actual)
    ).toEqual({ state: "HOLD_RECEIPT", shaMatch: false });
    expect(
      classifyReceipt(
        "S1008Q8O",
        new Map([["S1008Q8O", { sha256: "x".repeat(64), bytes: Number.NaN }]]),
        actual
      ).state
    ).toBe("HOLD_RECEIPT");
  });

  it("実 bytes と不一致の証跡は HOLD_RECEIPT", () => {
    expect(
      classifyReceipt(
        "S1008Q8O",
        new Map([["S1008Q8O", { sha256: "b".repeat(64), bytes: 120 }]]),
        actual
      )
    ).toEqual({ state: "HOLD_RECEIPT", shaMatch: false });
    expect(
      classifyReceipt(
        "S1008Q8O",
        new Map([["S1008Q8O", { sha256: "a".repeat(64), bytes: 121 }]]),
        actual
      ).state
    ).toBe("HOLD_RECEIPT");
  });

  it("sha/bytes 一致のみでは RECEIVED にしない (hosted 証明なし。shaMatch のみ保持)", () => {
    expect(
      classifyReceipt(
        "S1008Q8O",
        new Map([["S1008Q8O", { sha256: "a".repeat(64), bytes: 120 }]]),
        actual
      )
    ).toEqual({ state: "ARCHIVE_PENDING", shaMatch: true });
  });

  it("既存 explicit unique/full-physical 証跡 + 実 bytes 一致のみ RECEIVED", () => {
    const verified = {
      sha256: "a".repeat(64),
      bytes: 120,
      receipt: { pageId: "page-1", manifestMatch: "same" },
    };
    expect(classifyReceipt("S1008Q8O", new Map([["S1008Q8O", verified]]), actual)).toEqual({
      state: "RECEIVED",
      shaMatch: true,
    });
    // 検証記録があっても実 bytes 不一致は HOLD。
    const bad = { ...verified, sha256: "b".repeat(64) };
    expect(classifyReceipt("S1008Q8O", new Map([["S1008Q8O", bad]]), actual).state).toBe(
      "HOLD_RECEIPT"
    );
  });
});

describe("母集合分離 (旧1695 と新候補の混同防止)", () => {
  const newVerdicts: NewVerdict[] = [
    { doc: "S1008Q8O", parseOK: true, validateOK: true, pinPresent: true, pinMismatch: false, scopeKnown: true, receipt: "ARCHIVE_PENDING" },
    { doc: "S1008XET", parseOK: true, validateOK: true, pinPresent: true, pinMismatch: false, scopeKnown: true, receipt: "ARCHIVE_PENDING" },
    { doc: "S100AKTK", parseOK: true, validateOK: false, pinPresent: false, pinMismatch: false, scopeKnown: false, receipt: "ARCHIVE_PENDING" },
    { doc: "S1008Q8W", parseOK: true, validateOK: true, pinPresent: true, pinMismatch: false, scopeKnown: true, receipt: "ARCHIVE_PENDING" },
  ];

  it("旧 L1changed の doc でも receipt なしは offline 候補にならない", () => {
    // S1008Q8O/S100AKTK/S1008Q8W は旧1695 側だが、新判定は新 verdict のみ。
    expect(computeOfflineCandidates(newVerdicts)).toEqual([]);
  });

  it("pinMismatch・parse/validation HOLD・unknown scope は候補にしない", () => {
    const base: NewVerdict = { doc: "S1008Q8O", parseOK: true, validateOK: true, pinPresent: true, pinMismatch: false, scopeKnown: true, receipt: "RECEIVED" };
    expect(computeOfflineCandidates([base])).toEqual(["S1008Q8O"]);
    expect(computeOfflineCandidates([{ ...base, pinMismatch: true }])).toEqual([]);
    expect(computeOfflineCandidates([{ ...base, parseOK: false }])).toEqual([]);
    expect(computeOfflineCandidates([{ ...base, validateOK: false }])).toEqual([]);
    expect(computeOfflineCandidates([{ ...base, scopeKnown: false }])).toEqual([]);
    expect(computeOfflineCandidates([{ ...base, pinPresent: false }])).toEqual([]);
  });

  it("全条件を満たした doc のみ offline 候補 (意味は OFFLINE_CANDIDATE)", () => {
    const withReceipt: NewVerdict[] = [
      ...newVerdicts,
      { doc: "S1008XET", parseOK: true, validateOK: true, pinPresent: true, pinMismatch: false, scopeKnown: true, receipt: "RECEIVED" },
    ];
    // 同一 doc の 2 verdicts (pending + received): received の方が候補。
    expect(computeOfflineCandidates(withReceipt)).toEqual(["S1008XET"]);
  });

  it("report は旧数・offline 候補・liveReady・applyQualified を別 field で保持する (混同防止)", () => {
    const counts = separatedCounts(1695, computeOfflineCandidates(newVerdicts), 0, 0);
    expect(counts).toEqual({
      oldL1Changed1695: 1695,
      offlineCandidates: 0,
      liveReady: 0,
      applyQualified: 0,
    });
    // 旧数を新数に代入する混同は型で不可: 別名 field のみ。
    expect("oldL1Changed1695" in counts).toBe(true);
    expect("offlineCandidates" in counts).toBe(true);
    expect("liveReady" in counts).toBe(true);
    expect("applyQualified" in counts).toBe(true);
  });
});
