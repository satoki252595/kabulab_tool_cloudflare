import { describe, expect, it } from "vitest";
import { buildCompanySummary, leadExcerpt, SUMMARY_BUSINESS_LEAD_MAX } from "./summary.js";

describe("leadExcerpt", () => {
  it("文の区切りを保ったまま冒頭を切り出す", () => {
    const text = "自動車の製造販売を行っています。海外にも展開しています。三つ目の文です。";
    const out = leadExcerpt(text, 20);
    // 文の途中では切らない (「。」区切りを尊重)
    expect(out.endsWith("。") || out.endsWith("…")).toBe(true);
  });

  it("上限より短ければそのまま返す", () => {
    const text = "短い事業内容です。";
    expect(leadExcerpt(text, 100)).toBe(text);
  });

  it("1文だけで上限を超える場合はその文を切り詰めて…を付ける(黙って全文を混ぜない)", () => {
    const longSentence = "あ".repeat(500) + "。";
    const out = leadExcerpt(longSentence, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith("…")).toBe(true);
  });

  it("空文字列は空文字列", () => {
    expect(leadExcerpt("")).toBe("");
  });

  it("既定の上限はSUMMARY_BUSINESS_LEAD_MAX", () => {
    const text = "あ".repeat(SUMMARY_BUSINESS_LEAD_MAX + 100) + "。";
    const out = leadExcerpt(text);
    expect(out.length).toBeLessThanOrEqual(SUMMARY_BUSINESS_LEAD_MAX);
  });
});

describe("buildCompanySummary", () => {
  it("会社名・コード・33業種・タグ・事業の内容冒頭をこの順で機械的に連結する", () => {
    const s = buildCompanySummary({
      companyName: "トヨタ自動車",
      stockCode: "7203",
      sector33: "輸送用機器",
      tags: ["自動車完成車"],
      businessText: "自動車事業においては、セダン等の設計、製造および販売を行っています。",
    });
    expect(s).toContain("トヨタ自動車");
    expect(s).toContain("7203");
    expect(s).toContain("輸送用機器");
    expect(s).toContain("自動車完成車");
    expect(s).toContain("自動車事業においては");
  });

  it("33業種・タグが無くても壊れない (null/空配列)", () => {
    const s = buildCompanySummary({
      companyName: "テスト会社",
      stockCode: "0000",
      sector33: null,
      tags: [],
      businessText: "",
    });
    expect(s).toContain("テスト会社");
    expect(s).not.toContain("33業種");
    expect(s).not.toContain("事業タグ");
  });
});
