/**
 * 較正用評価セット (`evalset/v1.json`) による精度測定。
 * 設計: docs/005-yuho-quant-business-tags.md「競合他社」節 §3 較正セット。
 * `golden.ts` (biztag 本体の較正) と同じ構成。
 *
 * 会社Aごとに、評価セット内でAに対して判定対象となっている会社B群
 * (`pairs[]` でAが登場する組の相手方) をまとめて 1 回 (20問以内なら) jev に
 * 判定させ、期待ラベルと比較する。
 */
import { bandOf, type BtThresholds } from "../judge.js";
import { buildCompetitorState, judgeCompetitorCandidates, type CompanyAInput } from "./question.js";
import type { CompanySummaryInput } from "./summary.js";
import type { CompetitorEvalSet, EvalCategory } from "./evalset.js";
import type { JevClient } from "../../../../../src/shared/jev/index.js";

export interface EvalCompanyInput extends CompanyAInput, CompanySummaryInput {}

export interface EvalPerPairResult {
  a: string;
  b: string;
  expectedLabel: boolean;
  category: EvalCategory;
  probability: number;
  band: "yes" | "uncertain" | "no";
  correct: boolean;
}

export interface EvalMetrics {
  /** 「はい」判定のうち期待どおり true だった比率。 */
  precisionYes: number | null;
  /** 期待 label=true のうち「はい」判定できた比率。 */
  recallYes: number | null;
  /** category ごとの正解率 (負例カテゴリの取り違え箇所を見るため)。 */
  byCategory: Record<string, { total: number; correct: number }>;
  confusion: { truePositive: number; falsePositive: number; trueNegative: number; falseNegative: number };
}

export function evaluateCompetitorsAtThresholds(perPair: EvalPerPairResult[], t: BtThresholds): EvalMetrics {
  let truePositive = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  let falseNegative = 0;
  const byCategory: Record<string, { total: number; correct: number }> = {};

  for (const r of perPair) {
    const band = bandOf(r.probability, t);
    const predictedYes = band === "yes";
    const correct = predictedYes === r.expectedLabel;

    if (r.expectedLabel) {
      if (predictedYes) truePositive++;
      else falseNegative++;
    } else if (predictedYes) {
      falsePositive++;
    } else {
      trueNegative++;
    }

    const cat = byCategory[r.category] ?? { total: 0, correct: 0 };
    cat.total++;
    if (correct) cat.correct++;
    byCategory[r.category] = cat;
  }

  const predictedYesCount = truePositive + falsePositive;
  const expectedTrueCount = truePositive + falseNegative;
  return {
    precisionYes: predictedYesCount === 0 ? null : truePositive / predictedYesCount,
    recallYes: expectedTrueCount === 0 ? null : truePositive / expectedTrueCount,
    byCategory,
    confusion: { truePositive, falsePositive, trueNegative, falseNegative },
  };
}

export interface EvalCompanyLookup {
  (stockCode: string): EvalCompanyInput;
}

/**
 * 評価セットの全組を jev に判定させ、しきい値によらない生の確率 (`perPair`) を返す。
 * `companyOf` が実データ (docId・periodEnd 一致の実本文・実タグ) を返すこと
 * (evalset.ts の `quote` はここでは使わない。取得済みの実本文をそのまま渡す
 * ため、呼び出し側が Notion/D1 から実際の行を読んで用意する)。
 */
export async function evaluateCompetitorEvalSet(
  evalSet: CompetitorEvalSet,
  companyOf: EvalCompanyLookup,
  jev: JevClient,
  thresholds: BtThresholds,
  opts?: { batchSize?: number }
): Promise<{ perPair: EvalPerPairResult[]; jevCalls: number; inputTokens: number; outputTokens: number }> {
  const pairsByA = new Map<string, typeof evalSet.pairs>();
  for (const pair of evalSet.pairs) {
    const list = pairsByA.get(pair.a) ?? [];
    list.push(pair);
    pairsByA.set(pair.a, list);
  }

  const perPair: EvalPerPairResult[] = [];
  let jevCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const [aCode, pairs] of pairsByA) {
    const a = companyOf(aCode);
    const state = buildCompetitorState(a);
    const candidates = pairs.map((p) => companyOf(p.b));
    const { judgments, calls, inputTokens: it, outputTokens: ot } = await judgeCompetitorCandidates(
      jev,
      state,
      candidates,
      thresholds,
      opts
    );
    jevCalls += calls;
    inputTokens += it;
    outputTokens += ot;

    const judgmentByCode = new Map(judgments.map((j) => [j.stockCode, j] as const));
    for (const pair of pairs) {
      const j = judgmentByCode.get(pair.b);
      if (j === undefined) {
        throw new Error(`evaluateCompetitorEvalSet: ${pair.b} の判定結果が無い (a=${aCode})`);
      }
      const predictedYes = j.band === "yes";
      perPair.push({
        a: aCode,
        b: pair.b,
        expectedLabel: pair.label,
        category: pair.category,
        probability: j.probability,
        band: j.band,
        correct: predictedYes === pair.label,
      });
    }
  }

  return { perPair, jevCalls, inputTokens, outputTokens };
}
