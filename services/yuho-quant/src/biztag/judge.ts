/**
 * jev(TypeSafe System One)による事業タグ判定。
 * 設計: docs/005-yuho-quant-business-tags.md §5.5。
 *
 * 語ごとの質問を `bt.<termId>` の noul 質問としてまとめ、jev に投げる。
 * jev 呼び出し自体のリトライ・エラー処理は src/shared/jev/ の責務
 * (ここでは JevUnavailableError をそのまま呼び出し元へ伝播させ、
 * 呼び出し元(process.ts)が「判定不能」に読み替える)。
 */
import type { JevClient, JevNoulQuestion } from "../../../../src/shared/jev/index.js";
import type { JudgeInput } from "./excerpt.js";
import type { BusinessTerm } from "./vocabulary/schema.js";

export interface BtThresholds {
  yesMin: number;
  noMax: number;
}

export type Band = "yes" | "uncertain" | "no";

export interface TermJudgment {
  termId: string;
  probability: number;
  band: Band;
}

function assertValidThresholds(t: BtThresholds): void {
  if (!(t.noMax > 0 && t.noMax < t.yesMin && t.yesMin < 1)) {
    throw new Error(
      `しきい値が不正 (0 < noMax < yesMin < 1 が必要): noMax=${t.noMax}, yesMin=${t.yesMin}`
    );
  }
}

/** 語の id から jev の質問 id を作る唯一の場所。 */
export function questionIdFor(termId: string): string {
  return `bt.${termId}`;
}

/**
 * 語の定義から jev の noul 質問を組み立てる。設計 §5.5 の指示文に固定する。
 *
 * 抜粋には「事業の内容」に加えて MD&A・研究開発活動の当たった段落が入るため
 * (prefilter.ts の冒頭コメント)、研究段階・計画・需要の追い風・借入先などの
 * 言及を「いいえ」に倒すことを明示する。文言を変えたらゴールデンセットで
 * しきい値を測り直すこと (calibration.json)。
 */
export function buildQuestion(term: BusinessTerm): JevNoulQuestion {
  return {
    instructions:
      "Answer only from the excerpt of this company's annual securities report. " +
      `Does this company itself (including its consolidated subsidiaries) currently operate ${term.definitionEn} ` +
      "as a business segment, product line, commercially sold product or service, or explicitly stated business? " +
      "Answer false if it is only its customers' industry or a demand driver, a supplier, partner or lender, " +
      "research and development without current sales, a future plan, or an incidental mention.",
    criteria: {
      true: "The excerpt states that the company itself currently makes, sells or provides this.",
      false:
        "The excerpt mentions this only as a customer's industry, demand driver, supplier, partner, lender, R&D without sales, plan, or in passing.",
    },
  };
}

export function bandOf(p: number, t: BtThresholds): Band {
  assertValidThresholds(t);
  if (p >= t.yesMin) return "yes";
  if (p <= t.noMax) return "no";
  return "uncertain";
}

export interface JudgeCandidatesResult {
  judgments: TermJudgment[];
  calls: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

/**
 * 候補語をまとめて jev に判定させる。
 *
 * 1 往復で最大 `opts.batchSize`(既定 20)語まで。すべての呼び出しに同じ
 * `input.state` を渡す。モデルがバッチ間で変わったら throw する
 * (版を固定するという設計 §5.5 の前提が崩れているため)。
 */
export async function judgeCandidates(
  client: JevClient,
  input: JudgeInput,
  terms: BusinessTerm[],
  t: BtThresholds,
  opts?: { batchSize?: number }
): Promise<JudgeCandidatesResult> {
  assertValidThresholds(t);
  if (terms.length === 0) {
    throw new Error("judgeCandidates: 候補語が空 (呼び出し側のバグ)");
  }
  const batchSize = opts?.batchSize ?? 20;

  const judgments: TermJudgment[] = [];
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let model: string | undefined;

  for (let i = 0; i < terms.length; i += batchSize) {
    const batch = terms.slice(i, i + batchSize);
    const questions: Record<string, JevNoulQuestion> = {};
    for (const term of batch) {
      questions[questionIdFor(term.id)] = buildQuestion(term);
    }

    const result = await client.askNoul(input.state, questions);
    calls += 1;
    inputTokens += result.inputTokens;
    outputTokens += result.outputTokens;

    if (model === undefined) {
      model = result.model;
    } else if (model !== result.model) {
      throw new Error(`judgeCandidates: バッチ間でモデルが変わった (${model} → ${result.model})`);
    }

    for (const term of batch) {
      const qid = questionIdFor(term.id);
      const p = result.answers[qid];
      if (p === undefined) {
        throw new Error(`judgeCandidates: ${qid} の応答が無い`);
      }
      if (p < 0 || p > 1) {
        throw new Error(`judgeCandidates: ${qid} の確率が範囲外 (${p})`);
      }
      judgments.push({ termId: term.id, probability: p, band: bandOf(p, t) });
    }
  }

  if (model === undefined) {
    throw new Error("judgeCandidates: モデル名を取得できなかった");
  }

  return { judgments, calls, inputTokens, outputTokens, model };
}
