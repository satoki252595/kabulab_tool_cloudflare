/**
 * 競合他社の jev 判定質問の組み立てとバッチ判定。
 * 設計: docs/005-yuho-quant-business-tags.md「競合他社」節 §2 jev 判定。
 *
 * 会社Aの有報「事業の内容」抜粋を state とし、会社Bごとに 1 問
 * (`cp.<Bの銘柄コード>`) を作る。B の説明はコードが組み立てる (question.ts は
 * `summary.ts` の出力をそのまま埋め込むだけで、LLM に B の説明を作文させない)。
 * biztag の `judge.ts` と同じく 1 往復最大 `batchSize`(既定20) 問まで。
 */
import type { JevClient, JevNoulQuestion } from "../../../../../src/shared/jev/index.js";
import { bandOf, type Band, type BtThresholds } from "../judge.js";
import { buildCompanySummary, type CompanySummaryInput } from "./summary.js";

/** 会社Aの状態 (state) に埋め込む「事業の内容」の上限字数。 */
export const STATE_BUSINESS_MAX = 8000;

export interface CompanyAInput {
  stockCode: string;
  companyName: string;
  sector33: string | null;
  businessText: string;
}

/** 会社Aの jev 状態 (state) を組み立てる。 */
export function buildCompetitorState(a: CompanyAInput): string {
  const header = [`銘柄コード: ${a.stockCode}`, `会社名: ${a.companyName}`, `33業種: ${a.sector33 ?? "不明"}`].join(
    "\n"
  );
  const text =
    a.businessText.length <= STATE_BUSINESS_MAX ? a.businessText : `${a.businessText.slice(0, STATE_BUSINESS_MAX)}…`;
  return `${header}\n\n【事業の内容】\n${text}`;
}

/** 会社Bの候補ごとの質問 id (`cp.<銘柄コード>`)。 */
export function questionIdForCandidate(stockCode: string): string {
  return `cp.${stockCode}`;
}

/**
 * 会社Bごとの jev 質問を組み立てる。指示文は設計書 §2 のとおり固定
 * (文言を変えたら calibration.ts で測り直すこと)。
 */
export function buildCompetitorQuestion(b: CompanySummaryInput): JevNoulQuestion {
  const bSummary = buildCompanySummary(b);
  return {
    instructions:
      "Answer only from the excerpt of company A's annual securities report given as the state (company A's main business). " +
      "Does company B compete with company A — i.e. does B sell substitutable products or services to the same customer " +
      "segment/market as company A's main business? " +
      `Company B: ${bSummary} ` +
      "Answer false if company B is only a supplier, customer, or business partner of company A (not a rival seller); " +
      "if B operates in the same broad industry as A but sells different, non-substitutable products; " +
      "or if any overlap between A and B is only in a minor/peripheral business for either company (not A's main business).",
    criteria: {
      true:
        "Company B offers products or services that are substitutable for company A's main business, to the same customer segment/market, based on A's excerpt and B's stated business.",
      false:
        "Company B is a supplier, customer, or partner of company A; or B is in the same broad industry with different, non-substitutable products; or the overlap is only minor/peripheral.",
    },
  };
}

export interface CompetitorJudgment {
  stockCode: string;
  probability: number;
  band: Band;
}

export interface JudgeCompetitorsResult {
  judgments: CompetitorJudgment[];
  calls: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

/**
 * 会社Aに対する候補 (会社B群) をまとめて jev に判定させる。
 * `judge.ts` の `judgeCandidates` と同じバッチ構成 (1 往復最大 `batchSize` 問)。
 */
export async function judgeCompetitorCandidates(
  client: JevClient,
  state: string,
  candidates: CompanySummaryInput[],
  t: BtThresholds,
  opts?: { batchSize?: number }
): Promise<JudgeCompetitorsResult> {
  if (candidates.length === 0) {
    throw new Error("judgeCompetitorCandidates: 候補が空 (呼び出し側のバグ)");
  }
  const batchSize = opts?.batchSize ?? 20;

  const judgments: CompetitorJudgment[] = [];
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let model: string | undefined;

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const questions: Record<string, JevNoulQuestion> = {};
    for (const b of batch) {
      questions[questionIdForCandidate(b.stockCode)] = buildCompetitorQuestion(b);
    }

    const result = await client.askNoul(state, questions);
    calls += 1;
    inputTokens += result.inputTokens;
    outputTokens += result.outputTokens;

    if (model === undefined) {
      model = result.model;
    } else if (model !== result.model) {
      throw new Error(`judgeCompetitorCandidates: バッチ間でモデルが変わった (${model} → ${result.model})`);
    }

    for (const b of batch) {
      const qid = questionIdForCandidate(b.stockCode);
      const p = result.answers[qid];
      if (p === undefined) {
        throw new Error(`judgeCompetitorCandidates: ${qid} の応答が無い`);
      }
      if (p < 0 || p > 1) {
        throw new Error(`judgeCompetitorCandidates: ${qid} の確率が範囲外 (${p})`);
      }
      judgments.push({ stockCode: b.stockCode, probability: p, band: bandOf(p, t) });
    }
  }

  if (model === undefined) {
    throw new Error("judgeCompetitorCandidates: モデル名を取得できなかった");
  }

  return { judgments, calls, inputTokens, outputTokens, model };
}
