import { describe, expect, it } from "vitest";
import { selectMissingDocs } from "../services/edinet/missing.js";
import type { EdinetDoc } from "../services/edinet/types.js";

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
