import { describe, it, expect } from "vitest";
import {
  calcCapmExpectedReturn,
  calcLogReturns,
  estimateBetaOLS,
} from "../../services/capm.js";

describe("calcCapmExpectedReturn", () => {
  it("Notion ファーストリテイリング例: Rf=0.5%, Rm=6%, β=1.3 → 7.65%", () => {
    const r = calcCapmExpectedReturn({
      beta: 1.3,
      riskFreeRate: 0.005,
      marketReturn: 0.06,
    });
    expect(r.expectedReturn).toBeCloseTo(0.0765, 4);
    expect(r.marketRiskPremium).toBeCloseTo(0.055, 4);
    expect(r.riskPremium).toBeCloseTo(0.0715, 4);
  });

  it("β = 1.0 → 期待リターン = Rm", () => {
    const r = calcCapmExpectedReturn({
      beta: 1.0,
      riskFreeRate: 0.005,
      marketReturn: 0.06,
    });
    expect(r.expectedReturn).toBeCloseTo(0.06, 4);
  });

  it("β = 0 → 期待リターン = Rf", () => {
    const r = calcCapmExpectedReturn({
      beta: 0,
      riskFreeRate: 0.005,
      marketReturn: 0.06,
    });
    expect(r.expectedReturn).toBeCloseTo(0.005, 4);
  });

  it("β 範囲外で throw", () => {
    expect(() =>
      calcCapmExpectedReturn({ beta: 10, riskFreeRate: 0.005, marketReturn: 0.06 })
    ).toThrow();
  });
});

describe("calcLogReturns", () => {
  it("単純ケース", () => {
    const r = calcLogReturns([100, 110, 121]);
    expect(r.length).toBe(2);
    expect(r[0]).toBeCloseTo(Math.log(110 / 100), 6);
    expect(r[1]).toBeCloseTo(Math.log(121 / 110), 6);
  });

  it("null と非有限値は除外", () => {
    const r = calcLogReturns([100, null, 110, 0, 121]);
    // 100→null は skip, null→110 は skip, 110→0 は skip, 0→121 は skip
    // → 結果は空
    expect(r.length).toBe(0);
  });
});

describe("estimateBetaOLS", () => {
  it("β=1 (完全相関) のケース", () => {
    // r_stock = r_market のとき β = 1, R² = 1
    const market = Array.from({ length: 60 }, (_, i) => Math.sin(i / 5) * 0.01);
    const stock = market.slice();
    const e = estimateBetaOLS(stock, market);
    expect(e).not.toBeNull();
    expect(e!.beta).toBeCloseTo(1, 4);
    expect(e!.rSquared).toBeCloseTo(1, 4);
  });

  it("β=2 (高ベータ) のケース", () => {
    const market = Array.from({ length: 60 }, (_, i) => Math.sin(i / 5) * 0.01);
    const stock = market.map((m) => 2 * m);
    const e = estimateBetaOLS(stock, market);
    expect(e!.beta).toBeCloseTo(2, 4);
    expect(e!.rSquared).toBeCloseTo(1, 4);
  });

  it("ノイズあり β≈1.5", () => {
    const n = 100;
    const market: number[] = [];
    const stock: number[] = [];
    let seed = 42;
    const rand = () => {
      // 簡易疑似乱数 (再現性のため)
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280 - 0.5;
    };
    for (let i = 0; i < n; i++) {
      const m = rand() * 0.02;
      market.push(m);
      stock.push(1.5 * m + rand() * 0.005); // β=1.5 + noise
    }
    const e = estimateBetaOLS(stock, market);
    expect(e).not.toBeNull();
    expect(e!.beta).toBeGreaterThan(1.0);
    expect(e!.beta).toBeLessThan(2.0);
    expect(e!.rSquared).toBeGreaterThan(0.4);
  });

  it("サンプル数 < 30 で null", () => {
    const r = estimateBetaOLS([0.01, 0.02], [0.01, 0.02]);
    expect(r).toBeNull();
  });

  it("市場分散 0 で null", () => {
    const market = new Array(60).fill(0);
    const stock = Array.from({ length: 60 }, (_, i) => i * 0.001);
    const r = estimateBetaOLS(stock, market);
    expect(r).toBeNull();
  });

  it("長さ違いで throw", () => {
    expect(() => estimateBetaOLS([1, 2], [1, 2, 3])).toThrow();
  });
});
