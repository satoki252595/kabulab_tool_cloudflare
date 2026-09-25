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
import { summarizeJudgments } from "./row.js";
import type { TermJudgment } from "./judge.js";
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
    expect(outcome).toEqual({ upstream: [], downstream: [], themes: [], uncertainText: null, evidence: [] });
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
