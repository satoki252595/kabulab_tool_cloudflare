/**
 * CAPM (Capital Asset Pricing Model) — 期待リターン算出
 *
 *   E[R_i] = R_f + β_i × (E[R_m] - R_f)
 *
 * β は「個別銘柄リターンと市場リターンの共分散 / 市場リターンの分散」で求める。
 * 本実装では日次リターンの線形回帰 (OLS) で β を推定する。
 *
 * 必要データ:
 *   - 個別銘柄の日次終値 (約 60 営業日以上)
 *   - 市場 (TOPIX or 日経平均) の日次終値 (同期間)
 *
 * 制約:
 *   - サンプル数が 30 営業日未満 → β 計算不能 (null)
 *   - 市場リターンの分散が 0 → β 計算不能
 *
 * すべて純関数。
 */

export interface CapmInput {
  /** β (市場感応度) */
  beta: number;
  /** リスクフリーレート (年率、小数) */
  riskFreeRate: number;
  /** 市場期待リターン (年率、小数) */
  marketReturn: number;
}

export interface CapmResult {
  /** 期待リターン (年率、小数) */
  expectedReturn: number;
  /** リスクプレミアム = β × (Rm - Rf) */
  riskPremium: number;
  /** 市場リスクプレミアム = Rm - Rf */
  marketRiskPremium: number;
}

/**
 * CAPM 期待リターン。
 *
 *   E[R] = R_f + β × (R_m - R_f)
 */
export function calcCapmExpectedReturn(input: CapmInput): CapmResult {
  if (!Number.isFinite(input.beta)) {
    throw new Error("β を数値で入力してください");
  }
  if (!Number.isFinite(input.riskFreeRate)) {
    throw new Error("リスクフリーレートを数値で入力してください");
  }
  if (!Number.isFinite(input.marketReturn)) {
    throw new Error("市場期待リターンを数値で入力してください");
  }
  if (input.riskFreeRate < -0.05 || input.riskFreeRate > 0.2) {
    throw new Error("リスクフリーレートは -5%〜+20% の範囲で入力してください");
  }
  if (input.marketReturn < -0.5 || input.marketReturn > 0.5) {
    throw new Error("市場期待リターンは -50%〜+50% の範囲で入力してください");
  }
  if (input.beta < -5 || input.beta > 5) {
    throw new Error("β は -5〜+5 の範囲で入力してください");
  }

  const marketRiskPremium = input.marketReturn - input.riskFreeRate;
  const riskPremium = input.beta * marketRiskPremium;
  return {
    expectedReturn: input.riskFreeRate + riskPremium,
    riskPremium,
    marketRiskPremium,
  };
}

// =============================================================================
// β 推定 (Ordinary Least Squares 線形回帰)
// =============================================================================

export interface BetaEstimate {
  /** 推定 β */
  beta: number;
  /** 切片 α (CAPM の超過リターン: 年率換算済) */
  alphaAnnualized: number;
  /** 決定係数 R² */
  rSquared: number;
  /** 使用したサンプル数 (両系列の共通有効データ) */
  sampleSize: number;
  /** 銘柄リターンの年率ボラティリティ */
  stockVolAnnualized: number;
  /** 市場リターンの年率ボラティリティ */
  marketVolAnnualized: number;
  /** ピアソン相関係数 */
  correlation: number;
}

/**
 * 終値時系列 (古い順) からログリターン配列を計算。
 * NaN/Infinity は除外。
 */
export function calcLogReturns(closes: ReadonlyArray<number | null>): number[] {
  const out: number[] = [];
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
    out.push(Math.log(curr / prev));
  }
  return out;
}

/**
 * 銘柄リターンと市場リターンの OLS 回帰で β を推定。
 *
 *   r_i = α + β × r_m + ε
 *
 * 入力配列は同じ長さの日次リターンであること。
 * `tradingDaysPerYear` は年率換算 (デフォルト 252 営業日)。
 *
 * @returns サンプル数 < 30 もしくは市場リターン分散が 0 の場合 null
 */
export function estimateBetaOLS(
  stockReturns: ReadonlyArray<number>,
  marketReturns: ReadonlyArray<number>,
  tradingDaysPerYear = 252
): BetaEstimate | null {
  if (stockReturns.length !== marketReturns.length) {
    throw new Error(
      `銘柄リターンと市場リターンの長さが一致しない (stock=${stockReturns.length}, market=${marketReturns.length})`
    );
  }

  // 両系列で有効なペアのみを抽出
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < stockReturns.length; i++) {
    const m = marketReturns[i];
    const s = stockReturns[i];
    if (Number.isFinite(m) && Number.isFinite(s)) {
      xs.push(m);
      ys.push(s);
    }
  }

  const n = xs.length;
  if (n < 30) return null;

  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let covXY = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    covXY += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  covXY /= n;
  varX /= n;
  varY /= n;

  if (varX === 0) return null;

  const beta = covXY / varX;
  const alpha = meanY - beta * meanX;
  const correlation = covXY / Math.sqrt(varX * varY);
  const rSquared = correlation * correlation;

  return {
    beta,
    alphaAnnualized: alpha * tradingDaysPerYear,
    rSquared,
    sampleSize: n,
    stockVolAnnualized: Math.sqrt(varY * tradingDaysPerYear),
    marketVolAnnualized: Math.sqrt(varX * tradingDaysPerYear),
    correlation,
  };
}
