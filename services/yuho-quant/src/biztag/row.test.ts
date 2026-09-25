/**
 * row.ts のユニットテスト。
 *
 * jev の判定そのものはモックせず、実コーパス(リボミック)の prefilter 結果に
 * 対して手で組んだ判定結果を渡す(judge.ts 自体は judge.test.ts で別途検証)。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prefilter, type PrefilterResult } from "./prefilter.js";
import { buildEvidenceText, EVIDENCE_TEXT_MAX_CHARS, summarizeJudgments } from "./row.js";
import type { TermJudgment } from "./judge.js";
import type { EvidenceBlockInput } from "../../../../src/shared/notion-archive/index.js";
import type { BusinessTerm } from "./vocabulary/schema.js";
import rawVocab from "./fixtures/test-vocab.json" with { type: "json" };
import { VocabularySchema, type Vocabulary } from "./vocabulary/schema.js";

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fx = (name: string) => readFileSync(join(FX, name), "utf8");
const vocab: Vocabulary = VocabularySchema.parse(rawVocab);

const business = fx("4591-ribomic-business.txt");
const segment = fx("4591-ribomic-segment-info.txt");
const result: PrefilterResult = prefilter(vocab, { business, segment_info: segment });

describe("summarizeJudgments", () => {
  it("『はい』は列(upstream/downstream)に、テーマは決定的に導出、根拠は原文の文を持つ", () => {
    const judgments: TermJudgment[] = [
      { termId: "B.MED.NUCLEIC_ACID_DRUG", probability: 0.95, band: "yes" },
      { termId: "B.MED.INNOVATOR_DRUG", probability: 0.95, band: "yes" },
    ];
    const outcome = summarizeJudgments(vocab, result.candidates, judgments);

    expect(outcome.upstream).toEqual([]);
    expect(outcome.downstream.sort()).toEqual(["医療用医薬品(新薬・先発品)", "核酸医薬"].sort());
    expect(outcome.themes).toEqual(["創薬・新薬開発"]);
    expect(outcome.uncertainText).toBeNull();

    expect(outcome.evidence).toHaveLength(2);
    const nucleic = outcome.evidence.find((e) => e.labelJa === "核酸医薬")!;
    expect(nucleic.band).toBe("yes");
    expect(nucleic.probability).toBe(0.95);
    expect(nucleic.sentences.length).toBeGreaterThan(0);
    expect(nucleic.sentences.length).toBeLessThanOrEqual(3);
    for (const s of nucleic.sentences) {
      expect(business.includes(s.text.replace(/^…|…$/g, ""))).toBe(true);
      expect(s.sectionTitle).toBe("事業の内容");
    }
  });

  it("『確認不能』は要確認タグ列に確率つきでまとめ、事業タグ列には出さない", () => {
    const judgments: TermJudgment[] = [
      { termId: "B.MED.NUCLEIC_ACID_DRUG", probability: 0.55, band: "uncertain" },
      { termId: "B.MED.INNOVATOR_DRUG", probability: 0.1, band: "no" },
    ];
    const outcome = summarizeJudgments(vocab, result.candidates, judgments);

    expect(outcome.upstream).toEqual([]);
    expect(outcome.downstream).toEqual([]);
    expect(outcome.uncertainText).toBe("核酸医薬（0.55）");
    expect(outcome.themes).toEqual([]);
    // 「いいえ」の語は根拠も残さない
    expect(outcome.evidence.map((e) => e.labelJa)).toEqual(["核酸医薬"]);
  });

  it("複数の要確認語は「 / 」で結合する", () => {
    const judgments: TermJudgment[] = [
      { termId: "B.MED.NUCLEIC_ACID_DRUG", probability: 0.55, band: "uncertain" },
      { termId: "B.MED.INNOVATOR_DRUG", probability: 0.6, band: "uncertain" },
    ];
    const outcome = summarizeJudgments(vocab, result.candidates, judgments);
    expect(outcome.uncertainText).toBe("核酸医薬（0.55） / 医療用医薬品(新薬・先発品)（0.60）");
  });

  it("判定が無い語(未判定)は何も残さない", () => {
    const outcome = summarizeJudgments(vocab, result.candidates, []);
    expect(outcome).toEqual({
      upstream: [],
      downstream: [],
      distribution: [],
      themes: [],
      uncertainText: null,
      evidence: [],
      evidenceText: null,
      evidenceTextTruncated: false,
    });
  });

  it("『はい』は事業タグの根拠文列にタグ名・確率・原文1〜2文・節名をまとめる", () => {
    const judgments: TermJudgment[] = [
      { termId: "B.MED.NUCLEIC_ACID_DRUG", probability: 0.95, band: "yes" },
    ];
    const outcome = summarizeJudgments(vocab, result.candidates, judgments);
    expect(outcome.evidenceTextTruncated).toBe(false);
    expect(outcome.evidenceText).not.toBeNull();
    expect(outcome.evidenceText).toContain("核酸医薬（はい 0.95）：「");
    expect(outcome.evidenceText).toContain("」— 事業の内容");
  });

  it("notionColumn=distribution の『はい』は事業タグ（流通・サービス）列に入る", () => {
    const distributionTerm: BusinessTerm = {
      id: "B.ICT.STAFFING",
      layer: "business",
      family: "ICT",
      subfamily: "人材サービス",
      notionColumn: "distribution",
      labelJa: "人材紹介・派遣",
      definitionJa: "テスト用の第3列(流通・サービス)語。",
      definitionEn: "Test-only distribution-column term.",
      keywords: ["人材紹介"],
      excludeKeywords: [],
      sources: [
        {
          title: "テスト出典",
          url: "https://example.test/staffing",
          date: "2026-01",
          section: "テスト項",
          quote: "テスト用の引用文です",
        },
      ],
      addedIn: "v1",
      deprecated: false,
    };
    const candidates: PrefilterResult["candidates"] = [
      {
        term: distributionTerm,
        hits: [
          {
            termId: distributionTerm.id,
            sectionKey: "business",
            sentence: { index: 0, start: 0, end: 6, text: "人材紹介を行う。" },
            keyword: "人材紹介",
          },
        ],
      },
    ];
    const judgments: TermJudgment[] = [{ termId: distributionTerm.id, probability: 0.9, band: "yes" }];
    const outcome = summarizeJudgments(
      { version: "v1", business: [distributionTerm], themes: [] },
      candidates,
      judgments
    );
    expect(outcome.upstream).toEqual([]);
    expect(outcome.downstream).toEqual([]);
    expect(outcome.distribution).toEqual(["人材紹介・派遣"]);
    expect(outcome.evidenceText).toContain("人材紹介・派遣（はい 0.90）");
  });

  it("『確認不能』は事業タグの根拠文列に「要確認」として残る", () => {
    const judgments: TermJudgment[] = [
      { termId: "B.MED.NUCLEIC_ACID_DRUG", probability: 0.55, band: "uncertain" },
    ];
    const outcome = summarizeJudgments(vocab, result.candidates, judgments);
    expect(outcome.evidenceText).toContain("核酸医薬（要確認 0.55）：「");
  });

  it("候補に無い語の判定結果が渡されたら呼び出し側のバグとして throw する", () => {
    const judgments: TermJudgment[] = [
      { termId: "B.SEMI.SILICON_WAFER", probability: 0.95, band: "yes" },
    ];
    expect(() => summarizeJudgments(vocab, result.candidates, judgments)).toThrow(
      /候補に無い語/
    );
  });
});

describe("buildEvidenceText", () => {
  it("語が無ければ null", () => {
    expect(buildEvidenceText([])).toEqual({ text: null, truncated: false });
  });

  it("上限内なら全語ぶんそのまま結合し、切り詰めフラグは立たない", () => {
    const items: EvidenceBlockInput["items"] = [
      {
        labelJa: "核酸医薬",
        band: "yes",
        probability: 0.93,
        sentences: [{ text: "核酸医薬を製造する。", sectionTitle: "事業の内容" }],
      },
      {
        labelJa: "新薬",
        band: "uncertain",
        probability: 0.55,
        sentences: [
          { text: "新薬開発に取り組んでいる。", sectionTitle: "研究開発活動" },
          { text: "治験を進めている。", sectionTitle: "研究開発活動" },
        ],
      },
    ];
    const { text, truncated } = buildEvidenceText(items);
    expect(truncated).toBe(false);
    expect(text).toBe(
      "核酸医薬（はい 0.93）：「核酸医薬を製造する。」— 事業の内容\n" +
        "新薬（要確認 0.55）：「新薬開発に取り組んでいる。治験を進めている。」— 研究開発活動"
    );
  });

  it("上限を超えたら切り詰め、末尾に正直な省略メモを残す(黙って削らない)", () => {
    const items: EvidenceBlockInput["items"] = Array.from({ length: 5000 }, (_, i) => ({
      labelJa: `語${i}`,
      band: "yes" as const,
      probability: 0.9,
      sentences: [{ text: "あ".repeat(50), sectionTitle: "事業の内容" }],
    }));
    const { text, truncated } = buildEvidenceText(items);
    expect(truncated).toBe(true);
    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThanOrEqual(EVIDENCE_TEXT_MAX_CHARS);
    expect(text).toContain("文字数上限のため以下省略");
    // 切り詰めても先頭の語は欠落しない
    expect(text!.startsWith("語0（はい 0.90）")).toBe(true);
  });
});
