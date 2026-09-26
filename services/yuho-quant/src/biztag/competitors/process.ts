/**
 * 1 銘柄 (会社A) ぶんの競合他社判定・書き込み。
 * 設計: docs/005-yuho-quant-business-tags.md「競合他社」節 §2・§4。
 *
 * 対称性の扱い (設計上の運営決定): A の視点で判定した競合だけを A→B の
 * relation として書く。B 側の行には反映しない (B から見て A が競合かどうかは
 * 別途 B を処理したときに B 自身の視点で判定される)。
 */
import type { JevClient } from "../../../../../src/shared/jev/index.js";
import type { WriteCompetitorRelationInput } from "../../../../../src/shared/notion-archive/index.js";
import type { BtThresholds } from "../judge.js";
import type { CandidateScore, CompanyProfile } from "./candidates.js";
import { buildCompetitorState, judgeCompetitorCandidates } from "./question.js";
import type { CompanySummaryInput } from "./summary.js";

export interface ProcessCompetitorsDeps {
  jevClient: JevClient;
  thresholds: BtThresholds;
  /** `calibration.json` の `candidateVersion` + jev モデル名。判定版の追跡に使う。 */
  versionTag: string;
  /** 判定日 (JST, YYYY-MM-DD)。 */
  today: string;
  writeCompetitorRelation: (pageId: string, input: WriteCompetitorRelationInput) => Promise<void>;
  batchSize?: number;
}

export interface ProcessCompetitorsOutcome {
  stockCode: string;
  /** 「はい」と判定され relation に書いた候補の銘柄コード。 */
  competitorCodes: string[];
  candidateCount: number;
  jevCalls: number;
  jevInputTokens: number;
  jevOutputTokens: number;
}

function toSummaryInput(p: CompanyProfile): CompanySummaryInput {
  return { stockCode: p.stockCode, companyName: p.companyName, sector33: p.sector33, tags: p.tags, businessText: p.businessText };
}

/**
 * 会社Aの競合他社を判定し、relation として書き込む。
 * `candidates` は `buildCandidates` が作った上位K候補 (既にK件以内)。
 * `candidateProfiles` は候補の銘柄コード → プロフィール (jev 質問の材料)。
 */
export async function processCompanyCompetitors(
  a: CompanyProfile,
  candidates: CandidateScore[],
  candidateProfiles: ReadonlyMap<string, CompanyProfile>,
  deps: ProcessCompetitorsDeps
): Promise<ProcessCompetitorsOutcome> {
  const judgedDocId = a.docId ?? "";
  if (candidates.length === 0) {
    // 候補が0件でも「判定した」事実 (judgedAt/version/docId) は記録する
    // (未判定と「候補なしで該当なしと確定」を区別するため。ルール2の帰結)。
    await deps.writeCompetitorRelation(a.pageId, {
      competitorPageIds: [],
      judgedAt: deps.today,
      version: deps.versionTag,
      judgedDocId,
    });
    return { stockCode: a.stockCode, competitorCodes: [], candidateCount: 0, jevCalls: 0, jevInputTokens: 0, jevOutputTokens: 0 };
  }

  const state = buildCompetitorState(a);
  const candidateInputs: CompanySummaryInput[] = candidates.map((c) => {
    const profile = candidateProfiles.get(c.stockCode);
    if (!profile) {
      throw new Error(`processCompanyCompetitors: 候補 ${c.stockCode} のプロフィールが見つかりません (a=${a.stockCode})`);
    }
    return toSummaryInput(profile);
  });

  const { judgments, calls, inputTokens, outputTokens } = await judgeCompetitorCandidates(
    deps.jevClient,
    state,
    candidateInputs,
    deps.thresholds,
    deps.batchSize !== undefined ? { batchSize: deps.batchSize } : undefined
  );

  const pageIdByCode = new Map(candidates.map((c) => [c.stockCode, c.pageId] as const));
  const competitorCodes: string[] = [];
  const competitorPageIds: string[] = [];
  for (const j of judgments) {
    if (j.band !== "yes") continue;
    const pageId = pageIdByCode.get(j.stockCode);
    if (!pageId) {
      throw new Error(`processCompanyCompetitors: ${j.stockCode} の候補ページIDが見つかりません (a=${a.stockCode})`);
    }
    competitorCodes.push(j.stockCode);
    competitorPageIds.push(pageId);
  }

  await deps.writeCompetitorRelation(a.pageId, {
    competitorPageIds,
    judgedAt: deps.today,
    version: deps.versionTag,
    judgedDocId,
  });

  return {
    stockCode: a.stockCode,
    competitorCodes,
    candidateCount: candidates.length,
    jevCalls: calls,
    jevInputTokens: inputTokens,
    jevOutputTokens: outputTokens,
  };
}
