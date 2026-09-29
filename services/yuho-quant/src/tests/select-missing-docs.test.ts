import { describe, expect, it } from "vitest";
import { applyCompletionFilter, selectMissingDocs } from "../services/edinet/missing.js";
import type { DocCustody } from "../services/edinet/archive.js";
import type { EdinetDoc } from "../services/edinet/types.js";

const CUSTODY = (t1: DocCustody["t1"], t5: DocCustody["t5"]): DocCustody => ({ t1, t5 });

/** 取りこぼし選別。入力はテスト用の最小構造データ。 */

function doc(partial: Partial<EdinetDoc> & { docID: string }): EdinetDoc {
  const { docID, ...rest } = partial;
  return {
    seqNumber: 1,
    docID,
    edinetCode: "E00001",
    secCode: "10010",
    JCN: "1000000000000",
    filerName: "テスト",
    ordinanceCode: "010",
    formCode: "030000",
    docTypeCode: "120",
    periodStart: "2025-04-01",
    periodEnd: "2026-03-31",
    submitDateTime: "2026-06-26 15:00",
    docDescription: "有価証券報告書",
    xbrlFlag: "1",
    csvFlag: "1",
    withdrawalStatus: "0",
    ...rest,
  };
}

const CODE_TO_ID = new Map([["1001", 1]]);

describe("selectMissingDocs", () => {
  it("未取込の有報だけを残す", () => {
    const listed = [
      doc({ docID: "S1NEW" }),
      doc({ docID: "S1OLD" }),
      doc({ docID: "S1OUT", secCode: "99990" }),
      doc({ docID: "S1Q", docTypeCode: "140" }),
    ];
    const r = selectMissingDocs(listed, new Set(["S1OLD"]), CODE_TO_ID, false);
    expect(r.missing.map((m) => m.doc.docID)).toEqual(["S1NEW"]);
    expect(r.missing[0]!.stockId).toBe(1);
    expect(r.skippedExisting).toBe(1);
    expect(r.outOfUniverse).toBe(1);
  });

  it("includeExisting=true では取込済みも通す (force 再処理用)", () => {
    const r = selectMissingDocs(
      [doc({ docID: "S1OLD" })],
      new Set(["S1OLD"]),
      CODE_TO_ID,
      true
    );
    expect(r.missing.map((m) => m.doc.docID)).toEqual(["S1OLD"]);
    expect(r.skippedExisting).toBe(0);
  });
});

describe("applyCompletionFilter", () => {
  it("memo の未完成は呼ぶたび毎回除外する (翌日再掲でも漏らさない)", () => {
    const existing = new Set(["S1", "S2"]);
    const memo = new Map<string, DocCustody>([
      ["S1", CUSTODY("missing", "complete")],
      ["S2", CUSTODY("complete", "complete")],
    ]);
    const day1 = applyCompletionFilter(existing, new Set(), memo, ["S1", "S2"]);
    expect([...day1.effective].sort()).toEqual(["S2"]);
    expect(day1.metadataOnly).toEqual([]);
    // 同じ memo で翌日も同じ listed が来たら同じく除外する (適用漏れなし)
    const day2 = applyCompletionFilter(existing, new Set(), memo, ["S1", "S2"]);
    expect([...day2.effective].sort()).toEqual(["S2"]);
  });

  it("pointer 未完成は既存集合から外し、metadata-only は報告列挙する", () => {
    const existing = new Set(["P1", "M1", "M2"]);
    const memo = new Map<string, DocCustody>([
      ["M1", CUSTODY("metadata-only", "complete")],
      ["M2", CUSTODY("complete", "complete")],
    ]);
    const r = applyCompletionFilter(existing, new Set(["P1"]), memo, ["P1", "M1", "M2"]);
    expect([...r.effective].sort()).toEqual(["M1", "M2"]);
    expect(r.metadataOnly).toEqual(["M1"]);
  });
});
