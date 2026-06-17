/**
 * RSI 計算 (Wilder's smoothing)
 *
 * 複数期間の RSI を時系列で計算する。rsi-screening の
 * `services/rsi-screening/src/services/rsi-calculator.ts` からの純粋移植。
 */

/** kabulab で扱う RSI 期間 (営業日) */
export const RSI_PERIODS = {
  short: 10, // 2 週間
  mid: 40, // 2 ヶ月
  long: 120, // 半年
} as const;

/**
 * 単一期間の RSI 時系列を計算する
 *
 * @param prices - 終値配列 (欠損なし、古い順)
 * @param period - RSI 期間
 * @returns 各日付に対応する RSI 値 (期間未満の先頭は null)
 */
export function calculateRsiSeries(
  prices: number[],
  period: number
): (number | null)[] {
  const n = prices.length;
  const result: (number | null)[] = new Array(n).fill(null);

  if (n < period + 1) return result;

  // 価格差分
  const changes: number[] = new Array(n - 1);
  for (let i = 1; i < n; i++) {
    changes[i - 1] = prices[i] - prices[i - 1];
  }

  // Wilder 初期値: 最初 period 個の平均
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    const c = changes[i];
    if (c > 0) avgGain += c;
    else avgLoss += Math.abs(c);
  }
  avgGain /= period;
  avgLoss /= period;

  result[period] = computeRsi(avgGain, avgLoss);

  for (let i = period; i < changes.length; i++) {
    const c = changes[i];
    const gain = c > 0 ? c : 0;
    const loss = c < 0 ? Math.abs(c) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i + 1] = computeRsi(avgGain, avgLoss);
  }

  return result;
}

function computeRsi(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** 001 で使う 3 期間を一括計算 */
export function calculateAllRsiSeries(prices: number[]): {
  rsi10: (number | null)[];
  rsi40: (number | null)[];
  rsi120: (number | null)[];
} {
  return {
    rsi10: calculateRsiSeries(prices, RSI_PERIODS.short),
    rsi40: calculateRsiSeries(prices, RSI_PERIODS.mid),
    rsi120: calculateRsiSeries(prices, RSI_PERIODS.long),
  };
}

/**
 * 履歴配列における現在値のパーセンタイル順位 (0-100)
 *
 * 中央値補正で同値の場合を調整する。
 */
export function calculatePercentileRank(
  history: (number | null)[],
  current: number | null
): number | null {
  if (current === null) return null;
  const valid = history.filter((v): v is number => v !== null);
  if (valid.length === 0) return null;

  let countBelow = 0;
  let countEqual = 0;
  for (const v of valid) {
    if (v < current) countBelow++;
    else if (v === current) countEqual++;
  }

  return ((countBelow + 0.5 * countEqual) / valid.length) * 100;
}
