import { describe, it, expect } from "vitest";
import {
  calcBlackScholes,
  calcImpliedVolatility,
  normCdf,
  normPdf,
} from "../../services/black-scholes.js";

describe("normCdf / normPdf", () => {
  it("N(0) = 0.5", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
  });
  it("N(1.96) ≈ 0.975", () => {
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
  });
  it("N(-x) = 1 - N(x)", () => {
    expect(normCdf(-1)).toBeCloseTo(1 - normCdf(1), 6);
  });
  it("φ(0) = 1/√(2π)", () => {
    expect(normPdf(0)).toBeCloseTo(1 / Math.sqrt(2 * Math.PI), 6);
  });
});

describe("calcBlackScholes", () => {
  it("Notion 任天堂 ATM コール例: S=K=8000, T=0.25, σ=30%, r=0.5% → ≒ 484 円", () => {
    const r = calcBlackScholes({
      spot: 8000,
      strike: 8000,
      timeToExpiry: 0.25,
      riskFreeRate: 0.005,
      volatility: 0.30,
    });
    // Notion の概数値は ≒ 484 円。誤差 5% 程度を許容。
    expect(r.callPrice).toBeGreaterThan(460);
    expect(r.callPrice).toBeLessThan(510);
  });

  it("プット-コール・パリティ: C - P = S - K·e^(-rT)", () => {
    const r = calcBlackScholes({
      spot: 100,
      strike: 100,
      timeToExpiry: 1,
      riskFreeRate: 0.05,
      volatility: 0.20,
    });
    expect(Math.abs(r.parityResidual)).toBeLessThan(1e-9);
  });

  it("ATM コール Δ ≈ 0.5 (T 短く r 小)", () => {
    const r = calcBlackScholes({
      spot: 100,
      strike: 100,
      timeToExpiry: 0.01,
      riskFreeRate: 0,
      volatility: 0.20,
    });
    expect(r.callGreeks.delta).toBeCloseTo(0.5, 1);
    expect(r.putGreeks.delta).toBeCloseTo(-0.5, 1);
  });

  it("Γ は call/put で同じ", () => {
    const r = calcBlackScholes({
      spot: 100,
      strike: 100,
      timeToExpiry: 1,
      riskFreeRate: 0.05,
      volatility: 0.20,
    });
    expect(r.callGreeks.gamma).toBeCloseTo(r.putGreeks.gamma, 8);
  });

  it("Vega も call/put で同じ", () => {
    const r = calcBlackScholes({
      spot: 100,
      strike: 100,
      timeToExpiry: 1,
      riskFreeRate: 0.05,
      volatility: 0.20,
    });
    expect(r.callGreeks.vega).toBeCloseTo(r.putGreeks.vega, 8);
  });

  it("σ <= 0 で throw", () => {
    expect(() =>
      calcBlackScholes({
        spot: 100,
        strike: 100,
        timeToExpiry: 1,
        riskFreeRate: 0.05,
        volatility: 0,
      })
    ).toThrow();
  });
});

describe("calcImpliedVolatility", () => {
  it("BS で σ=30% で算出した価格 → IV 逆算で σ=30% に戻る", () => {
    const truePrice = calcBlackScholes({
      spot: 100,
      strike: 100,
      timeToExpiry: 1,
      riskFreeRate: 0.05,
      volatility: 0.30,
    }).callPrice;

    const iv = calcImpliedVolatility({
      marketPrice: truePrice,
      type: "call",
      spot: 100,
      strike: 100,
      timeToExpiry: 1,
      riskFreeRate: 0.05,
    });
    expect(iv).not.toBeNull();
    expect(iv!).toBeCloseTo(0.30, 3);
  });

  it("プットでも逆算できる", () => {
    const truePrice = calcBlackScholes({
      spot: 100,
      strike: 95,
      timeToExpiry: 0.5,
      riskFreeRate: 0.02,
      volatility: 0.45,
    }).putPrice;

    const iv = calcImpliedVolatility({
      marketPrice: truePrice,
      type: "put",
      spot: 100,
      strike: 95,
      timeToExpiry: 0.5,
      riskFreeRate: 0.02,
    });
    expect(iv).not.toBeNull();
    expect(iv!).toBeCloseTo(0.45, 3);
  });

  it("解の範囲外 (極端な高値) は null", () => {
    const iv = calcImpliedVolatility({
      marketPrice: 9999,
      type: "call",
      spot: 100,
      strike: 100,
      timeToExpiry: 0.01,
      riskFreeRate: 0.005,
    });
    expect(iv).toBeNull();
  });
});
