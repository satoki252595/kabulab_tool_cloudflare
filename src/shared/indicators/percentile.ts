/**
 * RSI パーセンタイル スナップショット
 *
 * 元は rsi-screening の percentile-engine.ts だったが、日次 sync (Node) と
 * Worker で同じ計算を使うためここへ移した。**移植元は既に削除済み**なので
 * 移植元パスを参照先として書かない (2026-04 の in-memory 化で消えている)。
 * 期待挙動の正本は services/rsi-screening/src/tests/unit/percentile-engine.test.ts。
 */

import { calculatePercentileRank } from "./rsi.js";

export interface RsiPercentileSnapshot {
  rsi10: number | null;
  rsi10Percentile: number | null;
  rsi40: number | null;
  rsi40Percentile: number | null;
  rsi120: number | null;
  rsi120Percentile: number | null;
  /** 3 期間のパーセンタイルのうち最小値 */
  rsiMinPercentile: number | null;
  /**
   * パーセンタイル母集団の元になった終値の本数。
   *
   * 「5 年パーセンタイル」と呼んでいるが、実際の母集団は Yahoo が返した
   * 本数で決まる (上場が浅い銘柄は 1.9 年分しか無い)。読者が深さの差に
   * 気づけるよう、算出側でこの本数を持って UI まで運ぶ。
   *
   * 期間別の分母はここから期間長を引いた本数 (rsi10 なら −10)。3 期間分を
   * 別々に持つ案は、D1 の列追加と UI の情報量に見合わないので採らない。
   */
  sampleBars: number;
}

/**
 * 銘柄の RSI 履歴から現在のパーセンタイル順位スナップショットを算出する
 */
export function computeRsiPercentileSnapshot(rsiHistory: {
  rsi10: (number | null)[];
  rsi40: (number | null)[];
  rsi120: (number | null)[];
}): RsiPercentileSnapshot {
  const currentRsi10 = lastValid(rsiHistory.rsi10);
  const currentRsi40 = lastValid(rsiHistory.rsi40);
  const currentRsi120 = lastValid(rsiHistory.rsi120);

  const p10 = calculatePercentileRank(rsiHistory.rsi10, currentRsi10);
  const p40 = calculatePercentileRank(rsiHistory.rsi40, currentRsi40);
  const p120 = calculatePercentileRank(rsiHistory.rsi120, currentRsi120);

  const pcts = [p10, p40, p120].filter((v): v is number => v !== null);
  const rsiMinPercentile = pcts.length > 0 ? Math.min(...pcts) : null;

  // 3 系列は calculateAllRsiSeries が同一の終値列から作るので長さは一致する。
  // 代表として rsi10 の長さ = 母集団の元になった終値の本数を採る。
  const sampleBars = rsiHistory.rsi10.length;

  return {
    rsi10: currentRsi10,
    rsi10Percentile: p10,
    rsi40: currentRsi40,
    rsi40Percentile: p40,
    rsi120: currentRsi120,
    rsi120Percentile: p120,
    rsiMinPercentile,
    sampleBars,
  };
}

function lastValid(arr: (number | null)[]): number | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null) return arr[i];
  }
  return null;
}
