/**
 * 記録再生の jev クライアント。実際に記録した jev 応答 (noul 確率) だけを返す。
 *
 * CLAUDE.md ルール1 (ダミーデータ禁止) をテストに対して機械的に強制するための
 * 実装: 記録に無い (state, questionId) の組み合わせを要求されたら、既定値を
 * 返さず必ず throw する (テストが架空の回答でうっかり緑になることを防ぐ)。
 */
import { sha256Hex } from "../sha256.js";
import type { JevAskResult, JevClient, JevNoulQuestion } from "./client.js";

/** 記録キー: `${await sha256Hex(state)}:${questionId}`。 */
export function jevRecordingKey(stateHash: string, questionId: string): string {
  return `${stateHash}:${questionId}`;
}

/**
 * `recordings` (キー → noul 確率) だけを返す jev クライアントを作る。
 * `recordings` に無いキーを要求されたら必ず throw する。
 */
export function createRecordedJevClient(
  recordings: Record<string, number>,
  model: string
): JevClient {
  return {
    async askNoul(
      state: string,
      questions: Record<string, JevNoulQuestion>
    ): Promise<JevAskResult> {
      const qids = Object.keys(questions);
      if (qids.length === 0) {
        throw new Error("jev askNoul: questions が空です（呼び出し側の実装ミス）");
      }

      const stateHash = await sha256Hex(state);
      const answers: Record<string, number> = {};
      for (const qid of qids) {
        const key = jevRecordingKey(stateHash, qid);
        const value = recordings[key];
        if (value === undefined) {
          throw new Error(
            `記録にない state/question の組み合わせです（key="${key}"）。` +
              "テストは実際に記録された jev 応答のみを使うこと（架空の回答は作らない）。"
          );
        }
        answers[qid] = value;
      }

      return {
        model,
        answers,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        attempts: 1,
      };
    },
  };
}
