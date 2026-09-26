import { describe, expect, it, vi } from "vitest";
import type { JevAskResult, JevClient, JevNoulQuestion } from "../../../../../src/shared/jev/index.js";
import {
  buildCompetitorQuestion,
  buildCompetitorState,
  judgeCompetitorCandidates,
  questionIdForCandidate,
} from "./question.js";
import type { CompanySummaryInput } from "./summary.js";

function fakeResult(answers: Record<string, number>, overrides?: Partial<JevAskResult>): JevAskResult {
  return { model: "jev-test-1", answers, inputTokens: 10, outputTokens: 0, latencyMs: 1, attempts: 1, ...overrides };
}

const thresholds = { yesMin: 0.6, noMax: 0.3 };

const companyB = (stockCode: string): CompanySummaryInput => ({
  stockCode,
  companyName: `会社${stockCode}`,
  sector33: "輸送用機器",
  tags: ["自動車完成車"],
  businessText: "自動車の製造販売を行っています。",
});

describe("questionIdForCandidate", () => {
  it("cp. + 銘柄コード", () => {
    expect(questionIdForCandidate("7203")).toBe("cp.7203");
  });
});

describe("buildCompetitorState", () => {
  it("会社Aのヘッダと事業の内容を含む", () => {
    const state = buildCompetitorState({
      stockCode: "7203",
      companyName: "トヨタ自動車",
      sector33: "輸送用機器",
      businessText: "自動車の製造販売を行っています。",
    });
    expect(state).toContain("7203");
    expect(state).toContain("トヨタ自動車");
    expect(state).toContain("自動車の製造販売を行っています。");
  });

  it("長すぎる事業の内容はSTATE_BUSINESS_MAXで切り詰める", () => {
    const longText = "あ".repeat(20000);
    const state = buildCompetitorState({ stockCode: "0000", companyName: "テスト", sector33: null, businessText: longText });
    expect(state.length).toBeLessThan(longText.length);
    expect(state).toContain("…");
  });
});

describe("buildCompetitorQuestion", () => {
  it("会社Bの説明 (コード生成) を指示文に埋め込む", () => {
    const q = buildCompetitorQuestion(companyB("7267"));
    expect(q.instructions).toContain("会社7267");
    expect(q.instructions).toContain("7267");
    expect(q.criteria?.true).toBeTruthy();
    expect(q.criteria?.false).toBeTruthy();
  });
});

describe("judgeCompetitorCandidates", () => {
  it("会社Aの状態を渡し、候補ごとの確率と帯にまとめる", async () => {
    const candidates = [companyB("1001"), companyB("1002")];
    const askNoul = vi.fn(async (_state: string, questions: Record<string, JevNoulQuestion>) =>
      fakeResult(Object.fromEntries(Object.keys(questions).map((qid) => [qid, 0.9])))
    );
    const client: JevClient = { askNoul };

    const result = await judgeCompetitorCandidates(client, "会社Aの状態", candidates, thresholds);

    expect(askNoul).toHaveBeenCalledTimes(1);
    expect(askNoul).toHaveBeenCalledWith("会社Aの状態", expect.any(Object));
    expect(result.judgments).toEqual([
      { stockCode: "1001", probability: 0.9, band: "yes" },
      { stockCode: "1002", probability: 0.9, band: "yes" },
    ]);
  });

  it("batchSizeを超えたら複数回に分けて呼ぶ", async () => {
    const candidates = [companyB("1001"), companyB("1002"), companyB("1003")];
    const askNoul = vi.fn(async (_state: string, questions: Record<string, JevNoulQuestion>) =>
      fakeResult(Object.fromEntries(Object.keys(questions).map((qid) => [qid, 0.1])))
    );
    const client: JevClient = { askNoul };

    const result = await judgeCompetitorCandidates(client, "state", candidates, thresholds, { batchSize: 1 });
    expect(askNoul).toHaveBeenCalledTimes(3);
    expect(result.calls).toBe(3);
    expect(result.judgments.every((j) => j.band === "no")).toBe(true);
  });

  it("候補が空なら呼び出し側のバグとして throw する", async () => {
    const client: JevClient = { askNoul: vi.fn() };
    await expect(judgeCompetitorCandidates(client, "state", [], thresholds)).rejects.toThrow(/候補が空/);
  });

  it("応答が欠けていたら黙って埋めずthrowする", async () => {
    const client: JevClient = { askNoul: async () => fakeResult({}) };
    await expect(
      judgeCompetitorCandidates(client, "state", [companyB("1001")], thresholds)
    ).rejects.toThrow(/応答が無い/);
  });

  it("バッチ間でモデルが変わったらthrowする", async () => {
    let n = 0;
    const client: JevClient = {
      askNoul: async (_s, questions) => {
        n += 1;
        return fakeResult(Object.fromEntries(Object.keys(questions).map((qid) => [qid, 0.5])), {
          model: n === 1 ? "model-a" : "model-b",
        });
      },
    };
    await expect(
      judgeCompetitorCandidates(client, "state", [companyB("1001"), companyB("1002")], thresholds, { batchSize: 1 })
    ).rejects.toThrow(/バッチ間でモデルが変わった/);
  });
});
