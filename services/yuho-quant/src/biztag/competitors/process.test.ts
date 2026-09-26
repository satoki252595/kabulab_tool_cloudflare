import { describe, expect, it, vi } from "vitest";
import type { JevAskResult, JevClient, JevNoulQuestion } from "../../../../../src/shared/jev/index.js";
import type { CandidateScore, CompanyProfile } from "./candidates.js";
import { processCompanyCompetitors } from "./process.js";

function fakeResult(answers: Record<string, number>): JevAskResult {
  return { model: "jev-test-1", answers, inputTokens: 5, outputTokens: 0, latencyMs: 1, attempts: 1 };
}

const a: CompanyProfile = {
  stockCode: "1000",
  companyName: "会社A",
  pageId: "page-a",
  sector33: "輸送用機器",
  tags: ["自動車完成車"],
  businessText: "自動車の製造販売を行っています。",
  docId: "doc-1",
};

function candidate(stockCode: string): CandidateScore {
  return {
    stockCode,
    pageId: `page-${stockCode}`,
    companyName: `会社${stockCode}`,
    score: 0.8,
    tagSimilarity: 0.8,
    sectorMatch: true,
    textSimilarity: 0,
    sharedTags: ["自動車完成車"],
  };
}

function profileOf(stockCode: string): CompanyProfile {
  return {
    stockCode,
    companyName: `会社${stockCode}`,
    pageId: `page-${stockCode}`,
    sector33: "輸送用機器",
    tags: ["自動車完成車"],
    businessText: "自動車の製造販売を行っています。",
    docId: `doc-${stockCode}`,
  };
}

const thresholds = { yesMin: 0.6, noMax: 0.3 };

describe("processCompanyCompetitors", () => {
  it("「はい」判定の候補だけをrelationとして書き込む", async () => {
    const candidates = [candidate("1001"), candidate("1002")];
    const profiles = new Map([
      ["1001", profileOf("1001")],
      ["1002", profileOf("1002")],
    ]);
    const askNoul = vi.fn(async (_state: string, questions: Record<string, JevNoulQuestion>) =>
      fakeResult(Object.fromEntries(Object.keys(questions).map((qid) => [qid, qid === "cp.1001" ? 0.9 : 0.1])))
    );
    const client: JevClient = { askNoul };
    const writeCompetitorRelation = vi.fn(async () => {});

    const outcome = await processCompanyCompetitors(a, candidates, profiles, {
      jevClient: client,
      thresholds,
      versionTag: "cand-v1|jev-test-1",
      today: "2026-09-26",
      writeCompetitorRelation,
    });

    expect(outcome.competitorCodes).toEqual(["1001"]);
    expect(writeCompetitorRelation).toHaveBeenCalledWith("page-a", {
      competitorPageIds: ["page-1001"],
      judgedAt: "2026-09-26",
      version: "cand-v1|jev-test-1",
      judgedDocId: "doc-1",
    });
  });

  it("候補が0件でも判定した事実 (空relation) を記録する", async () => {
    const writeCompetitorRelation = vi.fn(async () => {});
    const askNoul = vi.fn();
    const outcome = await processCompanyCompetitors(a, [], new Map(), {
      jevClient: { askNoul },
      thresholds,
      versionTag: "cand-v1|jev-test-1",
      today: "2026-09-26",
      writeCompetitorRelation,
    });
    expect(outcome.competitorCodes).toEqual([]);
    expect(askNoul).not.toHaveBeenCalled();
    expect(writeCompetitorRelation).toHaveBeenCalledWith("page-a", {
      competitorPageIds: [],
      judgedAt: "2026-09-26",
      version: "cand-v1|jev-test-1",
      judgedDocId: "doc-1",
    });
  });

  it("候補のプロフィールが見つからなければ throw する", async () => {
    const candidates = [candidate("9999")];
    const askNoul = vi.fn();
    await expect(
      processCompanyCompetitors(a, candidates, new Map(), {
        jevClient: { askNoul },
        thresholds,
        versionTag: "v",
        today: "2026-09-26",
        writeCompetitorRelation: vi.fn(),
      })
    ).rejects.toThrow(/プロフィールが見つかりません/);
  });
});
