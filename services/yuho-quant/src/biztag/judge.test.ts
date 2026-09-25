/**
 * judge.ts のユニットテスト。
 *
 * src/shared/jev/ は別 agent が並行実装中のため、JevClient は型 import のみ
 * (実行時には解決しない) にし、テストでは同じ形の fake を渡す。
 */
import { describe, expect, it, vi } from "vitest";
import type {
  JevAskResult,
  JevClient,
  JevNoulQuestion,
} from "../../../../src/shared/jev/index.js";
import { bandOf, buildQuestion, judgeCandidates, questionIdFor } from "./judge.js";
import rawVocab from "./fixtures/test-vocab.json" with { type: "json" };
import { VocabularySchema, type BusinessTerm, type Vocabulary } from "./vocabulary/schema.js";

const vocab: Vocabulary = VocabularySchema.parse(rawVocab);
const activeTerms = vocab.business.filter((t): t is BusinessTerm => !t.deprecated);
const term = (id: string): BusinessTerm => {
  const t = activeTerms.find((x) => x.id === id);
  if (t === undefined) throw new Error(`fixture に無い id: ${id}`);
  return t;
};

const baseInput = { state: "テスト用の状態文字列", inputSummary: "", businessChars: 0, businessTruncated: false, supportParagraphsUsed: 0, supportParagraphsOmitted: 0 };

function fakeResult(answers: Record<string, number>, overrides?: Partial<JevAskResult>): JevAskResult {
  return { model: "jev-test-1", answers, inputTokens: 10, outputTokens: 0, latencyMs: 1, attempts: 1, ...overrides };
}

describe("questionIdFor", () => {
  it("bt. + termId", () => {
    expect(questionIdFor("B.MED.NUCLEIC_ACID_DRUG")).toBe("bt.B.MED.NUCLEIC_ACID_DRUG");
  });
});

describe("buildQuestion", () => {
  it("definitionEn を指示文に埋め込み、true/false の短い判定基準を持つ", () => {
    const q = buildQuestion(term("B.MED.NUCLEIC_ACID_DRUG"));
    expect(q.instructions).toContain(term("B.MED.NUCLEIC_ACID_DRUG").definitionEn);
    expect(q.instructions).toContain("Answer only from the excerpt");
    expect(q.criteria?.true).toBeTruthy();
    expect(q.criteria?.false).toBeTruthy();
  });
});

describe("bandOf", () => {
  const t = { yesMin: 0.8, noMax: 0.3 };
  it("yesMin 以上は yes、noMax 以下は no、それ以外は uncertain", () => {
    expect(bandOf(0.8, t)).toBe("yes");
    expect(bandOf(0.95, t)).toBe("yes");
    expect(bandOf(0.3, t)).toBe("no");
    expect(bandOf(0.0, t)).toBe("no");
    expect(bandOf(0.5, t)).toBe("uncertain");
  });

  it("0 < noMax < yesMin < 1 でなければ throw する", () => {
    expect(() => bandOf(0.5, { yesMin: 0.3, noMax: 0.8 })).toThrow(/しきい値が不正/);
    expect(() => bandOf(0.5, { yesMin: 1, noMax: 0.3 })).toThrow(/しきい値が不正/);
    expect(() => bandOf(0.5, { yesMin: 0.5, noMax: 0 })).toThrow(/しきい値が不正/);
  });
});

describe("judgeCandidates", () => {
  const thresholds = { yesMin: 0.8, noMax: 0.3 };

  it("同じ state を渡し、応答を確率と帯にまとめる", async () => {
    const terms = [term("B.MED.NUCLEIC_ACID_DRUG"), term("B.MED.INNOVATOR_DRUG")];
    const askNoul = vi.fn(async (_state: string, questions: Record<string, JevNoulQuestion>) =>
      fakeResult(Object.fromEntries(Object.keys(questions).map((qid) => [qid, 0.9])))
    );
    const client: JevClient = { askNoul };

    const result = await judgeCandidates(client, baseInput, terms, thresholds);

    expect(askNoul).toHaveBeenCalledTimes(1);
    expect(askNoul).toHaveBeenCalledWith(baseInput.state, expect.any(Object));
    expect(result.calls).toBe(1);
    expect(result.model).toBe("jev-test-1");
    expect(result.judgments).toEqual([
      { termId: "B.MED.NUCLEIC_ACID_DRUG", probability: 0.9, band: "yes" },
      { termId: "B.MED.INNOVATOR_DRUG", probability: 0.9, band: "yes" },
    ]);
  });

  it("batchSize を超えたら複数回に分けて呼ぶ", async () => {
    const terms = [term("B.MED.NUCLEIC_ACID_DRUG"), term("B.MED.INNOVATOR_DRUG")];
    const askNoul = vi.fn(async (_state: string, questions: Record<string, JevNoulQuestion>) =>
      fakeResult(Object.fromEntries(Object.keys(questions).map((qid) => [qid, 0.9])))
    );
    const client: JevClient = { askNoul };

    const result = await judgeCandidates(client, baseInput, terms, thresholds, { batchSize: 1 });
    expect(askNoul).toHaveBeenCalledTimes(2);
    expect(result.calls).toBe(2);
    expect(result.judgments).toHaveLength(2);
  });

  it("jev の応答が JevUnavailableError 相当を投げたらそのまま伝播する(判定不能への読み替えは呼び出し側の責務)", async () => {
    class FakeJevUnavailableError extends Error {}
    const client: JevClient = {
      askNoul: async () => {
        throw new FakeJevUnavailableError("jev unavailable");
      },
    };
    await expect(
      judgeCandidates(client, baseInput, [term("B.MED.NUCLEIC_ACID_DRUG")], thresholds)
    ).rejects.toThrow("jev unavailable");
  });

  it("バッチ間でモデルが変わったら throw する(版を固定する前提が崩れるため)", async () => {
    let n = 0;
    const client: JevClient = {
      askNoul: async (_state, questions) => {
        n += 1;
        return fakeResult(
          Object.fromEntries(Object.keys(questions).map((qid) => [qid, 0.9])),
          { model: n === 1 ? "model-a" : "model-b" }
        );
      },
    };
    const terms = [term("B.MED.NUCLEIC_ACID_DRUG"), term("B.MED.INNOVATOR_DRUG")];
    await expect(
      judgeCandidates(client, baseInput, terms, thresholds, { batchSize: 1 })
    ).rejects.toThrow(/バッチ間でモデルが変わった/);
  });

  it("問うた qid の応答が無ければ黙って埋めず throw する", async () => {
    const client: JevClient = { askNoul: async () => fakeResult({}) };
    await expect(
      judgeCandidates(client, baseInput, [term("B.MED.NUCLEIC_ACID_DRUG")], thresholds)
    ).rejects.toThrow(/応答が無い/);
  });

  it("確率が0〜1の範囲外なら throw する(既定値で埋めない)", async () => {
    const client: JevClient = {
      askNoul: async (_s, questions) =>
        fakeResult(Object.fromEntries(Object.keys(questions).map((qid) => [qid, 1.2]))),
    };
    await expect(
      judgeCandidates(client, baseInput, [term("B.MED.NUCLEIC_ACID_DRUG")], thresholds)
    ).rejects.toThrow(/範囲外/);
  });

  it("候補語が空なら呼び出し側のバグとして throw する", async () => {
    const client: JevClient = { askNoul: async () => fakeResult({}) };
    await expect(judgeCandidates(client, baseInput, [], thresholds)).rejects.toThrow(
      /候補語が空/
    );
  });
});
