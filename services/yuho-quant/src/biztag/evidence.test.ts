/**
 * evidence.ts のユニットテスト。
 *
 * 切り詰め・重複除去は、実際にリボミック(有報)の実文で 300 字超の文・
 * 同じ文に複数キーワードが当たる実例が見つかったため、それをそのまま使う。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatPeriodJa, pickEvidenceSentences } from "./evidence.js";
import { prefilter } from "./prefilter.js";
import rawVocab from "./fixtures/test-vocab.json" with { type: "json" };
import { VocabularySchema, type Vocabulary } from "./vocabulary/schema.js";

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fx = (name: string) => readFileSync(join(FX, name), "utf8");
const vocab: Vocabulary = VocabularySchema.parse(rawVocab);

describe("formatPeriodJa", () => {
  it("YYYY-MM-DD を YYYY年M月期 に変換する", () => {
    expect(formatPeriodJa("2026-03-31")).toBe("2026年3月期");
    expect(formatPeriodJa("2025-12-01")).toBe("2025年12月期");
  });

  it("形式が違えば throw する", () => {
    expect(() => formatPeriodJa("2026/03/31")).toThrow(/形式が不正/);
    expect(() => formatPeriodJa("2026-3-31")).toThrow(/形式が不正/);
  });

  it("実在しない日付は throw する(黙って埋めない)", () => {
    expect(() => formatPeriodJa("2025-02-30")).toThrow(/実在しない日付/);
    expect(() => formatPeriodJa("2025-13-01")).toThrow(/月が不正/);
  });
});

describe("pickEvidenceSentences", () => {
  const business = fx("4591-ribomic-business.txt");
  const result = prefilter(vocab, { business });
  const nucleicHits = result.candidates.find((c) => c.term.id === "B.MED.NUCLEIC_ACID_DRUG")!.hits;

  it("同じ文が複数キーワードに当たっても 1 回だけ選ぶ(リボミックの実文冒頭)", () => {
    const firstSentenceHits = nucleicHits.filter((h) => h.sentence.start === 0 && h.sentence.end === 74);
    expect(firstSentenceHits.map((h) => h.keyword).sort()).toEqual(["アプタマー", "核酸医薬"].sort());
    const picked = pickEvidenceSentences(firstSentenceHits, 3, 300);
    expect(picked).toHaveLength(1);
    expect(picked[0].text).toBe(
      "３【事業の内容】 当社は、抗体に継ぐ次世代新薬として期待されているアプタマー（核酸医薬の一種）に特化して医薬品の研究開発を行うバイオベンチャーです。"
    );
    expect(picked[0].sectionKey).toBe("business");
  });

  it("maxChars を超える文はキーワードの前後を残して『…』付きで切り詰める(リボミックの実文・357字)", () => {
    const longHit = nucleicHits.find((h) => h.sentence.text.length === 357);
    expect(longHit).toBeDefined();
    const picked = pickEvidenceSentences([longHit!], 1, 300);
    expect(picked).toHaveLength(1);
    expect(picked[0].text.length).toBe(300);
    expect(picked[0].text.endsWith("…")).toBe(true);
    expect(picked[0].text).toContain(longHit!.keyword);
  });

  it("max 件までしか選ばない", () => {
    expect(nucleicHits.length).toBeGreaterThan(3);
    const picked = pickEvidenceSentences(nucleicHits, 3, 300);
    expect(picked).toHaveLength(3);
  });

  it("入力が空なら空を返す", () => {
    expect(pickEvidenceSentences([])).toEqual([]);
  });
});
