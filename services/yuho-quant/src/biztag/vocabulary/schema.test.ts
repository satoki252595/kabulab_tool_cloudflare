/**
 * `SourceSchema.quote` のテスト。
 *
 * レビュー指摘の回帰: `quote` は `nonEmpty()` (長さ ≥ 1) だけしか検査して
 * いなかったため、`.go.jp` 等の実在ページを出典に指定しつつ `quote` に
 * 単なる助詞・句読点 1 文字 (例: 「の」「は」「。」) を入れると、
 * `sources-verify.ts` の正規化部分一致がほぼどんな公的資料にも一致してしまい、
 * 「引用が実際にその語の定義を裏付けているか」を何も確認できなかった。
 */
import { describe, expect, it } from "vitest";
import { BusinessTermSchema, SOURCE_QUOTE_MIN_CHARS, SourceSchema } from "./schema.js";

function sourceOf(quote: string) {
  return {
    title: "日本標準産業分類",
    url: "https://www.soumu.go.jp/main_content/000941216.pdf",
    date: "2023-07",
    section: "細分類2661",
    quote,
  };
}

function businessTermOf(sourcesCount: number) {
  return {
    id: "B.MACH.MACHINE_TOOL",
    layer: "business" as const,
    family: "MACH" as const,
    subfamily: "工作機械",
    notionColumn: "upstream" as const,
    labelJa: "工作機械",
    definitionJa: "工作機械を製造する事業。",
    definitionEn: "Manufacture of machine tools.",
    keywords: ["工作機械"],
    excludeKeywords: [],
    sources: Array.from({ length: sourcesCount }, () => sourceOf("主として金属塊から切削加工製品を製造する")),
    addedIn: "v1" as const,
    deprecated: false,
  };
}

describe("SourceSchema.quote", () => {
  it("単なる助詞1文字 (の・は) は拒否する (finding の再現ケース)", () => {
    expect(SourceSchema.safeParse(sourceOf("の")).success).toBe(false);
    expect(SourceSchema.safeParse(sourceOf("は")).success).toBe(false);
  });

  it("句読点1文字 (。) は拒否する", () => {
    expect(SourceSchema.safeParse(sourceOf("。")).success).toBe(false);
  });

  it("助詞・句読点の組み合わせだけ (長さは十分でも) は拒否する", () => {
    expect(SourceSchema.safeParse(sourceOf("ですます。")).success).toBe(false);
  });

  it(`${SOURCE_QUOTE_MIN_CHARS}字未満の内容語は拒否する`, () => {
    expect(SourceSchema.safeParse(sourceOf("肥料")).success).toBe(false); // 2字
  });

  it("実データにある短い番号付き項目名 (例: 「薄膜堆積」4字・v1.json 実測最小) は許可する", () => {
    expect(SourceSchema.safeParse(sourceOf("薄膜堆積")).success).toBe(true);
    expect(SourceSchema.safeParse(sourceOf("①永久磁石")).success).toBe(true);
  });

  it("実在する意味のある引用 (通常の長さ) は許可する", () => {
    expect(
      SourceSchema.safeParse(
        sourceOf("主として金属塊から切削加工製品を製造する工作機械類を製造する事")
      ).success
    ).toBe(true);
  });
});

describe("BusinessTermSchema.sources — 1語あたりの出典数の上限 (関門の出典検査の長時間化対策)", () => {
  it("21件 (上限20件超) だと落ちる", () => {
    expect(BusinessTermSchema.safeParse(businessTermOf(21)).success).toBe(false);
  });

  it("20件 (上限ちょうど) までは通る", () => {
    expect(BusinessTermSchema.safeParse(businessTermOf(20)).success).toBe(true);
  });
});
