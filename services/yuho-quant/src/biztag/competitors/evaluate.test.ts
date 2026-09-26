import { describe, expect, it, vi } from "vitest";
import type { JevAskResult, JevClient, JevNoulQuestion } from "../../../../../src/shared/jev/index.js";
import { evaluateCompetitorEvalSet, evaluateCompetitorsAtThresholds, type EvalCompanyInput, type EvalPerPairResult } from "./evaluate.js";
import type { CompetitorEvalSet } from "./evalset.js";

function fakeResult(answers: Record<string, number>): JevAskResult {
  return { model: "jev-test-1", answers, inputTokens: 5, outputTokens: 0, latencyMs: 1, attempts: 1 };
}

const thresholds = { yesMin: 0.6, noMax: 0.3 };

describe("evaluateCompetitorsAtThresholds", () => {
  const rows: EvalPerPairResult[] = [
    { a: "1", b: "2", expectedLabel: true, category: "same_market_substitute", probability: 0.9, band: "yes", correct: true },
    { a: "1", b: "3", expectedLabel: false, category: "unrelated", probability: 0.05, band: "no", correct: true },
    { a: "1", b: "4", expectedLabel: true, category: "same_market_substitute", probability: 0.2, band: "no", correct: false },
    { a: "1", b: "5", expectedLabel: false, category: "supplier_customer", probability: 0.5, band: "uncertain", correct: true },
  ];

  it("precisionYes/recallYes/confusion を集計する", () => {
    const m = evaluateCompetitorsAtThresholds(rows, thresholds);
    expect(m.confusion.truePositive).toBe(1);
    expect(m.confusion.falseNegative).toBe(1);
    expect(m.confusion.trueNegative).toBe(2);
    expect(m.confusion.falsePositive).toBe(0);
    expect(m.precisionYes).toBe(1);
    expect(m.recallYes).toBe(0.5);
    expect(m.byCategory.same_market_substitute.total).toBe(2);
    expect(m.byCategory.same_market_substitute.correct).toBe(1);
  });

  it("「はい」判定が0件ならprecisionYesはnull", () => {
    const m = evaluateCompetitorsAtThresholds([rows[2]], thresholds);
    expect(m.precisionYes).toBeNull();
  });
});

describe("evaluateCompetitorEvalSet", () => {
  it("Aごとにまとめて jev を呼び、期待ラベルと突き合わせる", async () => {
    const evalSet: CompetitorEvalSet = {
      version: "v1",
      createdAt: "2026-09-26",
      companies: {
        "1000": { name: "会社A", sector33: null, docId: "d", periodEnd: "p", group: null, quote: "実在の引用文が入る" },
        "1001": { name: "会社B", sector33: null, docId: "d", periodEnd: "p", group: null, quote: "実在の引用文が入る2" },
        "1002": { name: "会社C", sector33: null, docId: "d", periodEnd: "p", group: null, quote: "実在の引用文が入る3" },
      },
      pairs: [
        { a: "1000", b: "1001", label: true, category: "same_market_substitute", reason: "同じ市場" },
        { a: "1000", b: "1002", label: false, category: "unrelated", reason: "無関係" },
      ],
    };

    const companyOf = (code: string): EvalCompanyInput => ({
      stockCode: code,
      companyName: `会社${code}`,
      sector33: null,
      tags: [],
      businessText: "事業の内容テキスト",
    });

    const askNoul = vi.fn(async (_state: string, questions: Record<string, JevNoulQuestion>) => {
      const answers: Record<string, number> = {};
      for (const qid of Object.keys(questions)) {
        answers[qid] = qid === "cp.1001" ? 0.9 : 0.05;
      }
      return fakeResult(answers);
    });
    const client: JevClient = { askNoul };

    const { perPair, jevCalls } = await evaluateCompetitorEvalSet(evalSet, companyOf, client, thresholds);

    expect(jevCalls).toBe(1); // Aは1000のみ登場するので1回にまとまる
    expect(perPair).toHaveLength(2);
    const byB = new Map(perPair.map((r) => [r.b, r]));
    expect(byB.get("1001")?.correct).toBe(true);
    expect(byB.get("1002")?.correct).toBe(true);
  });
});
