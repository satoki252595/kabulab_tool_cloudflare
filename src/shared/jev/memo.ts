/**
 * 同じ入力 (state・質問) には同じ回答を返す jev クライアント (プロセス内メモ化)。
 *
 * 用途: 単語帳の関門 (`pnpm biztag gate`) は今の版と提案の版を同じゴールデン
 * セットで測って比べる。jev はしきい値付近で回答が揺れる (実測: 同じ入力に
 * 0.25 と 0.33) ため、2 回を別々に問い合わせると「提案と関係ない項目の揺れ」で
 * 比較が決まってしまう (2026-09-26 に精度 0.9652→0.9650 の揺れで不採用になった)。
 * 1 回の関門の中で入力が同一の問いは同じ回答を使い、差が出るのは提案で入力
 * (候補語・抜粋・定義) が変わった項目だけにする。
 *
 * - キーは state のハッシュ + questionId + 質問内容のハッシュ。定義文が変われば
 *   別の問いとして問い直す (古い回答を流用しない)。
 * - 回答の無い問いだけをまとめて元のクライアントへ 1 回で問い合わせる。
 *   元のクライアントが失敗したらそのまま投げる (既定値で埋めない)。
 * - 全問がメモにあれば jev は呼ばず、トークン 0・試行 0 を返す。
 */
import { sha256Hex } from "../sha256.js";
import type { JevAskResult, JevClient, JevNoulQuestion } from "./client.js";

export function createMemoizedJevClient(inner: JevClient): JevClient {
  const memo = new Map<string, { probability: number; model: string }>();

  return {
    async askNoul(state: string, questions: Record<string, JevNoulQuestion>): Promise<JevAskResult> {
      const qids = Object.keys(questions);
      if (qids.length === 0) {
        throw new Error("jev askNoul: questions が空です（呼び出し側の実装ミス）");
      }
      const stateHash = await sha256Hex(state);
      const keyOf = new Map<string, string>();
      for (const qid of qids) {
        keyOf.set(qid, `${stateHash}:${qid}:${await sha256Hex(JSON.stringify(questions[qid]))}`);
      }

      const missing = qids.filter((qid) => !memo.has(keyOf.get(qid)!));
      let fresh: JevAskResult | undefined;
      if (missing.length > 0) {
        const sub: Record<string, JevNoulQuestion> = {};
        for (const qid of missing) sub[qid] = questions[qid];
        fresh = await inner.askNoul(state, sub);
        for (const qid of missing) {
          memo.set(keyOf.get(qid)!, { probability: fresh.answers[qid], model: fresh.model });
        }
      }

      const answers: Record<string, number> = {};
      const models = new Set<string>();
      for (const qid of qids) {
        const hit = memo.get(keyOf.get(qid)!)!;
        answers[qid] = hit.probability;
        models.add(hit.model);
      }
      if (models.size !== 1) {
        throw new Error(`jev memo: 1 回の問い合わせの中でモデルが混在しました (${[...models].join(", ")})`);
      }

      // 全問がメモにあった (jev を呼んでいない) ときのトークン・試行は実際に 0。
      if (fresh === undefined) {
        return { model: [...models][0], answers, inputTokens: 0, outputTokens: 0, latencyMs: 0, attempts: 0 };
      }
      return {
        model: [...models][0],
        answers,
        inputTokens: fresh.inputTokens,
        outputTokens: fresh.outputTokens,
        latencyMs: fresh.latencyMs,
        attempts: fresh.attempts,
      };
    },
  };
}
