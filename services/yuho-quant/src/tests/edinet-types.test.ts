/**
 * 有報判定 / 会計期末確定のテスト。実 EDINET で観測した形 (訂正有報は
 * periodEnd=null で docDescription にのみ対象期間、投資信託 有報は
 * ord 030/form 07A000) を固定する。
 */
import { describe, it, expect } from "vitest";
import {
  isAnnualSecuritiesReport,
  resolveReportPeriodEnd,
  secCodeToTicker,
} from "../services/edinet/types.js";
import type { EdinetDoc } from "../services/edinet/types.js";

function doc(p: Partial<EdinetDoc>): EdinetDoc {
  return {
    seqNumber: 1,
    docID: "S100XXXX",
    edinetCode: "E00000",
    secCode: "70110",
    JCN: null,
    filerName: "テスト株式会社",
    ordinanceCode: "010",
    formCode: "030000",
    docTypeCode: "120",
    periodStart: "2024-04-01",
    periodEnd: "2025-03-31",
    submitDateTime: "2025-06-20 15:00",
    docDescription: "有価証券報告書－第10期",
    xbrlFlag: "1",
    csvFlag: "1",
    withdrawalStatus: "0",
    ...p,
  };
}

describe("isAnnualSecuritiesReport", () => {
  it("事業会社の有報(120/010/030000) は true", () => {
    expect(isAnnualSecuritiesReport(doc({}))).toBe(true);
  });
  it("訂正有報(130/010/030001) は true", () => {
    expect(
      isAnnualSecuritiesReport(
        doc({ docTypeCode: "130", formCode: "030001", periodEnd: null })
      )
    ).toBe(true);
  });
  it("投資信託 有報(120/030/07A000) は false", () => {
    expect(
      isAnnualSecuritiesReport(
        doc({ ordinanceCode: "030", formCode: "07A000", secCode: null })
      )
    ).toBe(false);
  });
  it("取下げ(withdrawalStatus=1) は false", () => {
    expect(isAnnualSecuritiesReport(doc({ withdrawalStatus: "1" }))).toBe(false);
  });
  it("四半期等(他 docTypeCode) は false", () => {
    expect(isAnnualSecuritiesReport(doc({ docTypeCode: "140" }))).toBe(false);
  });
});

describe("resolveReportPeriodEnd (ルール2: 不明は null, 捏造しない)", () => {
  it("periodEnd があればそれを返す", () => {
    expect(resolveReportPeriodEnd(doc({}))).toBe("2025-03-31");
  });
  it("訂正有報: periodEnd=null → docDescription の対象期間末を抽出", () => {
    const d = doc({
      docTypeCode: "130",
      formCode: "030001",
      periodEnd: null,
      docDescription: "訂正有価証券報告書－第77期(2024/04/01－2025/03/31)",
    });
    expect(resolveReportPeriodEnd(d)).toBe("2025-03-31");
  });
  it("全角括弧・1桁月日でも末日を抽出", () => {
    const d = doc({
      periodEnd: null,
      docDescription: "訂正有価証券報告書－第16期（2022/1/1－2022/12/31）",
    });
    expect(resolveReportPeriodEnd(d)).toBe("2022-12-31");
  });
  it("訂正有報: 和暦表記 (令和N年M月D日) を西暦に変換して末日抽出", () => {
    const d = doc({
      docTypeCode: "130",
      formCode: "030001",
      periodEnd: null,
      docDescription:
        "訂正有価証券報告書－第19期(令和2年1月1日－令和2年12月31日)",
    });
    expect(resolveReportPeriodEnd(d)).toBe("2020-12-31");
  });
  it("和暦 元年 / 平成 / 全角数字も解決", () => {
    expect(
      resolveReportPeriodEnd(
        doc({
          periodEnd: null,
          docDescription: "訂正有価証券報告書－第10期（令和元年4月1日－令和２年３月31日）",
        })
      )
    ).toBe("2020-03-31");
    expect(
      resolveReportPeriodEnd(
        doc({
          periodEnd: null,
          docDescription: "訂正有価証券報告書（平成31年4月1日－平成31年12月31日）",
        })
      )
    ).toBe("2019-12-31");
  });
  it("期間が読めなければ null (埋めない)", () => {
    expect(
      resolveReportPeriodEnd(doc({ periodEnd: null, docDescription: "訂正有価証券報告書" }))
    ).toBeNull();
    expect(
      resolveReportPeriodEnd(doc({ periodEnd: null, docDescription: null }))
    ).toBeNull();
  });
});

describe("secCodeToTicker (JPX 英数字コード対応)", () => {
  it("5 文字 secCode の下 4 文字をティッカーにする (旧挙動維持)", () => {
    expect(secCodeToTicker("70110")).toBe("7011");
  });

  it("英数字コードの 5 文字 secCode (例 130A0) を 130A に変換する", () => {
    expect(secCodeToTicker("130A0")).toBe("130A");
  });

  it("小文字・前後空白を正規化する", () => {
    expect(secCodeToTicker(" 130a0 ")).toBe("130A");
  });

  it("4 文字でそのまま来る場合も受理する", () => {
    expect(secCodeToTicker("7011")).toBe("7011");
    expect(secCodeToTicker("130A")).toBe("130A");
  });

  it("ティッカー部が形式不正なら null (捏造しない・ルール2)", () => {
    expect(secCodeToTicker("ABCDE")).toBeNull(); // 下4文字 ABCD は数字始まりでない
    expect(secCodeToTicker("700")).toBeNull(); // 桁不足
    expect(secCodeToTicker("700000")).toBeNull(); // 桁過多
    expect(secCodeToTicker(null)).toBeNull();
    expect(secCodeToTicker("")).toBeNull();
  });
});
