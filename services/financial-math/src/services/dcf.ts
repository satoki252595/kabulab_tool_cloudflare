/**
 * DCF 法 — Gordon 成長モデル + 感応度分析
 *
 * 数学的背景 (Notion 「金融数学入門」より):
 *   理論株価 = 来期配当 / (要求リターン − 配当成長率)
 *
 * 要求リターンと成長率の差 (k - g) で割るため、g を 1% 動かすだけで
 * 理論値は大きく動く。本サービスでは感応度マトリクスを必ず返して、
 * 単一値での意思決定を避けるよう促す。
 *
 * 制約条件:
 *   - 要求リターン k > 配当成長率 g (そうでないと無限大)
 *   - 来期配当 D1 > 0
 *
 * すべて純関数。フォールバック禁止 (条件違反は throw)。
 */

export interface GordonInput {
  /** 来期予想配当 (円/株) */
  expectedDividend: number;
  /** 要求リターン (年率、小数: 0.07 = 7%) */
  requiredReturn: number;
  /** 配当成長率 (年率、小数: 0.03 = 3%) */
  growthRate: number;
}

export interface GordonResult {
  /** Gordon モデル理論株価 (円/株) */
  intrinsicValue: number;
  /** 感応度マトリクス: g 軸 × k 軸 → 理論株価 */
  sensitivity: SensitivityMatrix;
}

export interface SensitivityMatrix {
  /** 横軸: 要求リターン候補 (年率小数) */
  requiredReturns: number[];
  /** 縦軸: 配当成長率候補 (年率小数) */
  growthRates: number[];
  /** values[gIdx][kIdx] = 理論株価 (k <= g の場合は null) */
  values: (number | null)[][];
}

/**
 * Gordon 成長モデルで理論株価を算出。
 *
 *   P = D1 / (k - g)
 *
 * 加えて、g を ±2% / k を ±2% の範囲で 5×5 の感応度マトリクスを返す。
 */
export function calcGordonValue(input: GordonInput): GordonResult {
  if (!Number.isFinite(input.expectedDividend) || input.expectedDividend <= 0) {
    throw new Error("来期予想配当は正の数を入力してください");
  }
  if (!Number.isFinite(input.requiredReturn) || input.requiredReturn <= 0) {
    throw new Error("要求リターンは正の数 (例: 0.07 = 7%) を入力してください");
  }
  if (!Number.isFinite(input.growthRate)) {
    throw new Error("配当成長率は数値で入力してください");
  }
  if (input.requiredReturn <= input.growthRate) {
    throw new Error(
      `Gordon モデルは k > g が必要 (現状 k=${(input.requiredReturn * 100).toFixed(2)}% ≤ g=${(input.growthRate * 100).toFixed(2)}%)`
    );
  }

  const intrinsicValue = input.expectedDividend / (input.requiredReturn - input.growthRate);

  // ±2% を 1% 刻みで 5 段階
  const STEP = 0.01;
  const RANGE = 2;
  const requiredReturns: number[] = [];
  const growthRates: number[] = [];
  for (let i = -RANGE; i <= RANGE; i++) {
    requiredReturns.push(Math.round((input.requiredReturn + i * STEP) * 1e4) / 1e4);
    growthRates.push(Math.round((input.growthRate + i * STEP) * 1e4) / 1e4);
  }

  const values: (number | null)[][] = growthRates.map((g) =>
    requiredReturns.map((k) => {
      if (k <= g || k <= 0) return null;
      return input.expectedDividend / (k - g);
    })
  );

  return {
    intrinsicValue,
    sensitivity: { requiredReturns, growthRates, values },
  };
}

// =============================================================================
// 多段階 DCF (Two-Stage) — 高成長期 → 安定成長期 (Gordon)
// =============================================================================

export interface TwoStageDcfInput {
  /** 来期配当 (円/株) */
  expectedDividend: number;
  /** 要求リターン (年率) */
  requiredReturn: number;
  /** 高成長期の成長率 (年率) */
  highGrowthRate: number;
  /** 高成長期の年数 */
  highGrowthYears: number;
  /** 安定期の永続成長率 (年率) */
  terminalGrowthRate: number;
}

export interface TwoStageDcfResult {
  /** 理論株価 = 高成長期 PV + ターミナル PV */
  intrinsicValue: number;
  /** 各年の配当 (1..N) */
  yearlyDividends: number[];
  /** 各年の現在価値 */
  yearlyPV: number[];
  /** ターミナルバリュー (Year N で計算した永続価値) */
  terminalValue: number;
  /** ターミナルバリューの現在価値 */
  terminalPV: number;
}

/**
 * 2段階 DCF (Two-Stage Dividend Discount Model)
 *
 *   Year 1..N: D_t を高成長率で増やし、PV = D_t / (1+k)^t
 *   Year N 末: TV = D_{N+1} / (k - g_terminal)  ※ Gordon
 *   理論株価 = ΣPV(1..N) + TV / (1+k)^N
 */
export function calcTwoStageDcf(input: TwoStageDcfInput): TwoStageDcfResult {
  if (!Number.isFinite(input.expectedDividend) || input.expectedDividend <= 0) {
    throw new Error("来期予想配当は正の数を入力してください");
  }
  if (!Number.isFinite(input.requiredReturn) || input.requiredReturn <= 0) {
    throw new Error("要求リターンは正の数を入力してください");
  }
  if (!Number.isInteger(input.highGrowthYears) || input.highGrowthYears < 1 || input.highGrowthYears > 30) {
    throw new Error("高成長期年数は 1〜30 年の整数を入力してください");
  }
  if (input.requiredReturn <= input.terminalGrowthRate) {
    throw new Error(
      `安定期成長率は要求リターンより小さい必要があります (k=${(input.requiredReturn * 100).toFixed(2)}% ≤ g_terminal=${(input.terminalGrowthRate * 100).toFixed(2)}%)`
    );
  }

  const k = input.requiredReturn;
  const g1 = input.highGrowthRate;
  const g2 = input.terminalGrowthRate;
  const N = input.highGrowthYears;

  const yearlyDividends: number[] = [];
  const yearlyPV: number[] = [];
  let highGrowthPV = 0;

  // Year t (1..N) の配当: D_1, D_1*(1+g1), D_1*(1+g1)^2, ...
  for (let t = 1; t <= N; t++) {
    const dividend = input.expectedDividend * Math.pow(1 + g1, t - 1);
    const pv = dividend / Math.pow(1 + k, t);
    yearlyDividends.push(dividend);
    yearlyPV.push(pv);
    highGrowthPV += pv;
  }

  // Year N 末でのターミナル: TV = D_{N+1} / (k - g2)
  const dividendNplus1 = yearlyDividends[N - 1] * (1 + g2);
  const terminalValue = dividendNplus1 / (k - g2);
  const terminalPV = terminalValue / Math.pow(1 + k, N);

  return {
    intrinsicValue: highGrowthPV + terminalPV,
    yearlyDividends,
    yearlyPV,
    terminalValue,
    terminalPV,
  };
}

// =============================================================================
// 配当履歴から成長率推定 (CAGR)
// =============================================================================

/**
 * 配当履歴の CAGR (年率複利成長率) を計算。
 *
 *   CAGR = (D_last / D_first)^(1/(N-1)) - 1
 *
 * 配列は古い順 (index 0 が最古)。N < 2 の場合は null を返す。
 */
export function calcDividendCagr(dividends: ReadonlyArray<number>): number | null {
  const valid = dividends.filter((d) => Number.isFinite(d) && d > 0);
  if (valid.length < 2) return null;
  const first = valid[0];
  const last = valid[valid.length - 1];
  const years = valid.length - 1;
  return Math.pow(last / first, 1 / years) - 1;
}
