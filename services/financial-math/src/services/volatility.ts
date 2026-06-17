/**
 * ヒストリカル・ボラティリティ算出
 *
 * 日次ログリターンの標準偏差 × √(252) を年率ボラティリティとする。
 * ブラック・ショールズ式に渡す σ の初期値として使用する。
 */

export interface HistoricalVolResult {
  /** 年率ボラティリティ (小数。0.32 = 32%) */
  annualizedVolatility: number;
  /** 日次標準偏差 */
  dailyStdev: number;
  /** 使用サンプル数 */
  sampleSize: number;
}

const DEFAULT_TRADING_DAYS_PER_YEAR = 252;

/**
 * 終値配列 (古い順) から年率ボラティリティを推定。
 *
 * @param closes 終値時系列 (NULL/Infinity は除外)
 * @param tradingDaysPerYear 年率換算係数 (デフォルト 252 営業日)
 * @returns 有効サンプルが 20 未満なら null
 */
export function calcHistoricalVolatility(
  closes: ReadonlyArray<number | null>,
  tradingDaysPerYear: number = DEFAULT_TRADING_DAYS_PER_YEAR
): HistoricalVolResult | null {
  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const curr = closes[i];
    if (
      prev === null ||
      curr === null ||
      !Number.isFinite(prev) ||
      !Number.isFinite(curr) ||
      prev <= 0 ||
      curr <= 0
    ) {
      continue;
    }
    logReturns.push(Math.log(curr / prev));
  }

  const n = logReturns.length;
  if (n < 20) return null;

  const mean = logReturns.reduce((a, b) => a + b, 0) / n;
  let sumSq = 0;
  for (const r of logReturns) {
    const d = r - mean;
    sumSq += d * d;
  }
  // 標本分散 (n-1)
  const variance = sumSq / (n - 1);
  const dailyStdev = Math.sqrt(variance);

  return {
    annualizedVolatility: dailyStdev * Math.sqrt(tradingDaysPerYear),
    dailyStdev,
    sampleSize: n,
  };
}
