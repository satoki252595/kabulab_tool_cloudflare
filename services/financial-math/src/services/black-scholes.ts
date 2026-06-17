/**
 * Black-Scholes-Merton モデル — オプション価格 + Greeks + Implied Volatility
 *
 * Notion 「金融数学入門」より:
 *   コール価格 C = S × N(d1) - K × e^(-rT) × N(d2)
 *   プット価格 P = K × e^(-rT) × N(-d2) - S × N(-d1)
 *
 *   d1 = (ln(S/K) + (r + σ²/2) × T) / (σ × √T)
 *   d2 = d1 - σ × √T
 *
 * Greeks (5 つの感応度):
 *   Δ (Delta)  = ∂C/∂S
 *   Γ (Gamma)  = ∂²C/∂S²
 *   ν (Vega)   = ∂C/∂σ        ※ 1% ボラ変化に対する価格変化
 *   Θ (Theta)  = -∂C/∂T       ※ 1 日経過に対する価格変化
 *   ρ (Rho)    = ∂C/∂r        ※ 1% 金利変化に対する価格変化
 *
 * 配当落ち補正は (q を入れて S → S × e^(-qT)) で対応可能だが、
 * ここでは無配当 (q=0) のヨーロピアン式を実装する。
 *
 * すべて純関数。条件違反は throw。
 */

export interface BsInput {
  /** 株価 S */
  spot: number;
  /** 行使価格 K */
  strike: number;
  /** 残存期間 T (年) */
  timeToExpiry: number;
  /** リスクフリーレート r (年率、小数) */
  riskFreeRate: number;
  /** ボラティリティ σ (年率、小数) */
  volatility: number;
}

export interface Greeks {
  /** Δ (株価1円変化に対する価格変化) */
  delta: number;
  /** Γ (Δ自体の変化率、株価1円変化あたり) */
  gamma: number;
  /** ν (ボラ1%変化に対する価格変化、円) */
  vega: number;
  /** Θ (1日経過に対する価格変化、円) */
  theta: number;
  /** ρ (金利1%変化に対する価格変化、円) */
  rho: number;
}

export interface BsResult {
  /** コールオプション理論価格 (円) */
  callPrice: number;
  /** プットオプション理論価格 (円) */
  putPrice: number;
  /** d1 (内部値) */
  d1: number;
  /** d2 (内部値) */
  d2: number;
  /** コール側の Greeks */
  callGreeks: Greeks;
  /** プット側の Greeks */
  putGreeks: Greeks;
  /** プット-コール・パリティ検算: C - P と S - K*e^(-rT) の差 (理論的に 0) */
  parityResidual: number;
}

/**
 * Black-Scholes 価格 + Greeks を一括計算。
 */
export function calcBlackScholes(input: BsInput): BsResult {
  validate(input);

  const { spot: S, strike: K, timeToExpiry: T, riskFreeRate: r, volatility: sigma } = input;

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  const Nd1 = normCdf(d1);
  const Nd2 = normCdf(d2);
  const NminusD1 = normCdf(-d1);
  const NminusD2 = normCdf(-d2);
  const phiD1 = normPdf(d1);

  const discount = Math.exp(-r * T);

  const callPrice = S * Nd1 - K * discount * Nd2;
  const putPrice = K * discount * NminusD2 - S * NminusD1;

  // === Greeks ===
  // Common
  const gamma = phiD1 / (S * sigma * sqrtT);
  const vegaPerUnitVol = S * phiD1 * sqrtT; // σ あたり
  const vegaPer1Pct = vegaPerUnitVol * 0.01;

  // Call
  const callDelta = Nd1;
  const callThetaPerYear = -(S * phiD1 * sigma) / (2 * sqrtT) - r * K * discount * Nd2;
  const callThetaPerDay = callThetaPerYear / 365;
  const callRhoPerUnit = K * T * discount * Nd2;
  const callRhoPer1Pct = callRhoPerUnit * 0.01;

  // Put
  const putDelta = Nd1 - 1;
  const putThetaPerYear = -(S * phiD1 * sigma) / (2 * sqrtT) + r * K * discount * NminusD2;
  const putThetaPerDay = putThetaPerYear / 365;
  const putRhoPerUnit = -K * T * discount * NminusD2;
  const putRhoPer1Pct = putRhoPerUnit * 0.01;

  const callGreeks: Greeks = {
    delta: callDelta,
    gamma,
    vega: vegaPer1Pct,
    theta: callThetaPerDay,
    rho: callRhoPer1Pct,
  };
  const putGreeks: Greeks = {
    delta: putDelta,
    gamma,
    vega: vegaPer1Pct,
    theta: putThetaPerDay,
    rho: putRhoPer1Pct,
  };

  // パリティ検算: C - P = S - K*e^(-rT)
  const parityResidual = callPrice - putPrice - (S - K * discount);

  return {
    callPrice,
    putPrice,
    d1,
    d2,
    callGreeks,
    putGreeks,
    parityResidual,
  };
}

function validate(input: BsInput): void {
  if (!Number.isFinite(input.spot) || input.spot <= 0) {
    throw new Error("株価は正の数を入力してください");
  }
  if (!Number.isFinite(input.strike) || input.strike <= 0) {
    throw new Error("行使価格は正の数を入力してください");
  }
  if (!Number.isFinite(input.timeToExpiry) || input.timeToExpiry <= 0) {
    throw new Error("残存期間 (年) は正の数を入力してください");
  }
  if (input.timeToExpiry > 5) {
    throw new Error("残存期間は 5 年以下で入力してください");
  }
  if (!Number.isFinite(input.riskFreeRate)) {
    throw new Error("リスクフリーレートを数値で入力してください");
  }
  if (input.riskFreeRate < -0.05 || input.riskFreeRate > 0.2) {
    throw new Error("リスクフリーレートは -5%〜+20% の範囲で入力してください");
  }
  if (!Number.isFinite(input.volatility) || input.volatility <= 0) {
    throw new Error("ボラティリティは正の数 (年率小数) を入力してください");
  }
  if (input.volatility > 5) {
    throw new Error("ボラティリティは 500% 以下で入力してください");
  }
}

// =============================================================================
// 標準正規分布の CDF / PDF
// =============================================================================

/**
 * 標準正規分布の累積分布関数 N(x)。
 * Abramowitz & Stegun 7.1.26 の有理式近似 (誤差 ≤ 7.5e-8)。
 */
export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/**
 * 標準正規分布の確率密度関数 φ(x)。
 */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * 誤差関数 erf(x) — Abramowitz & Stegun 7.1.26。
 */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

// =============================================================================
// Implied Volatility (二分法)
// =============================================================================

export type OptionType = "call" | "put";

export interface ImpliedVolInput {
  /** 観測されたオプション市場価格 */
  marketPrice: number;
  /** call or put */
  type: OptionType;
  spot: number;
  strike: number;
  timeToExpiry: number;
  riskFreeRate: number;
}

/**
 * 二分法で Implied Volatility を逆算。
 *
 * BS 価格は σ に対し単調増加なので二分法で安全に解ける。
 * 解の範囲は σ ∈ [0.001, 5.0] (0.1%〜500%) に制限。
 *
 * @returns 解が範囲内に存在しない場合 null
 */
export function calcImpliedVolatility(input: ImpliedVolInput): number | null {
  if (!Number.isFinite(input.marketPrice) || input.marketPrice <= 0) {
    throw new Error("オプション市場価格は正の数を入力してください");
  }

  const priceAt = (sigma: number): number => {
    const bs = calcBlackScholes({
      spot: input.spot,
      strike: input.strike,
      timeToExpiry: input.timeToExpiry,
      riskFreeRate: input.riskFreeRate,
      volatility: sigma,
    });
    return input.type === "call" ? bs.callPrice : bs.putPrice;
  };

  let lo = 0.001;
  let hi = 5.0;
  const TARGET = input.marketPrice;
  const TOL = 1e-5;
  const MAX_ITER = 100;

  // 範囲外チェック (BS 価格が市場価格に届かない / 既に超えている場合)
  const priceLo = priceAt(lo);
  const priceHi = priceAt(hi);
  if (TARGET < priceLo - TOL || TARGET > priceHi + TOL) return null;

  for (let i = 0; i < MAX_ITER; i++) {
    const mid = (lo + hi) / 2;
    const price = priceAt(mid);
    if (Math.abs(price - TARGET) < TOL) return mid;
    if (price < TARGET) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}
