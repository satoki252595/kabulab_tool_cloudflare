/**
 * RSI パーセンタイル スナップショット
 *
 * rsi-screening の `services/rsi-screening/src/services/percentile-engine.ts`
 * からの純粋移植。
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

  return {
    rsi10: currentRsi10,
    rsi10Percentile: p10,
    rsi40: currentRsi40,
    rsi40Percentile: p40,
    rsi120: currentRsi120,
    rsi120Percentile: p120,
    rsiMinPercentile,
  };
}

function lastValid(arr: (number | null)[]): number | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null) return arr[i];
  }
  return null;
}
