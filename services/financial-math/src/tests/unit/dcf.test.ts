import { describe, it, expect } from "vitest";
import {
  calcGordonValue,
  calcTwoStageDcf,
  calcDividendCagr,
} from "../../services/dcf.js";

describe("calcGordonValue (Gordon 成長モデル)", () => {
  it("Notion 三菱商事 (8058) の例題: D=200, k=7%, g=3% → 5,000 円", () => {
    const r = calcGordonValue({
      expectedDividend: 200,
      requiredReturn: 0.07,
      growthRate: 0.03,
    });
    expect(r.intrinsicValue).toBeCloseTo(5000, 6);
    // 感応度マトリクスは 5×5
    expect(r.sensitivity.requiredReturns.length).toBe(5);
    expect(r.sensitivity.growthRates.length).toBe(5);
    expect(r.sensitivity.values.length).toBe(5);
  });

  it("k <= g なら throw", () => {
    expect(() =>
      calcGordonValue({ expectedDividend: 100, requiredReturn: 0.05, growthRate: 0.05 })
    ).toThrow();
    expect(() =>
      calcGordonValue({ expectedDividend: 100, requiredReturn: 0.04, growthRate: 0.06 })
    ).toThrow();
  });

  it("配当 <= 0 なら throw", () => {
    expect(() =>
      calcGordonValue({ expectedDividend: 0, requiredReturn: 0.07, growthRate: 0.03 })
    ).toThrow();
    expect(() =>
      calcGordonValue({ expectedDividend: -10, requiredReturn: 0.07, growthRate: 0.03 })
    ).toThrow();
  });

  it("感応度: k>g のセルは正、k<=g のセルは null", () => {
    const r = calcGordonValue({
      expectedDividend: 100,
      requiredReturn: 0.07,
      growthRate: 0.03,
    });
    for (let g = 0; g < r.sensitivity.growthRates.length; g++) {
      for (let k = 0; k < r.sensitivity.requiredReturns.length; k++) {
        const cellK = r.sensitivity.requiredReturns[k];
        const cellG = r.sensitivity.growthRates[g];
        if (cellK <= cellG) {
          expect(r.sensitivity.values[g][k]).toBeNull();
        } else {
          expect(r.sensitivity.values[g][k]).not.toBeNull();
          expect(r.sensitivity.values[g][k]!).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("calcTwoStageDcf", () => {
  it("g_high = g_terminal なら Gordon と一致 (簡略ケース)", () => {
    // g_high = g_terminal の場合、2段階は事実上 Gordon と等価
    const D = 100;
    const k = 0.08;
    const g = 0.03;
    const N = 5;
    const gordon = D / (k - g);

    const ts = calcTwoStageDcf({
      expectedDividend: D,
      requiredReturn: k,
      highGrowthRate: g,
      highGrowthYears: N,
      terminalGrowthRate: g,
    });
    // 数値誤差込みで近い値であることを確認
    expect(ts.intrinsicValue).toBeCloseTo(gordon, 4);
  });

  it("年次配当が高成長率で増加していく", () => {
    const ts = calcTwoStageDcf({
      expectedDividend: 100,
      requiredReturn: 0.10,
      highGrowthRate: 0.10,
      highGrowthYears: 5,
      terminalGrowthRate: 0.02,
    });
    expect(ts.yearlyDividends.length).toBe(5);
    expect(ts.yearlyDividends[0]).toBeCloseTo(100, 6);
    expect(ts.yearlyDividends[1]).toBeCloseTo(110, 6);
    expect(ts.yearlyDividends[4]).toBeCloseTo(146.41, 1);
  });

  it("k <= g_terminal なら throw", () => {
    expect(() =>
      calcTwoStageDcf({
        expectedDividend: 100,
        requiredReturn: 0.05,
        highGrowthRate: 0.10,
        highGrowthYears: 5,
        terminalGrowthRate: 0.05,
      })
    ).toThrow();
  });

  it("highGrowthYears が範囲外なら throw", () => {
    expect(() =>
      calcTwoStageDcf({
        expectedDividend: 100,
        requiredReturn: 0.10,
        highGrowthRate: 0.05,
        highGrowthYears: 0,
        terminalGrowthRate: 0.02,
      })
    ).toThrow();
  });
});

describe("calcDividendCagr", () => {
  it("100 → 200 を 4 年で成長 → 約 18.92%", () => {
    // 5 個の値で 4 年間 (index 0..4)
    const cagr = calcDividendCagr([100, 119, 141, 168, 200]);
    expect(cagr).toBeCloseTo(0.1892, 3);
  });

  it("単調成長 (年 10%)", () => {
    const cagr = calcDividendCagr([100, 110, 121, 133.1]);
    expect(cagr).toBeCloseTo(0.1, 4);
  });

  it("サンプル不足は null", () => {
    expect(calcDividendCagr([])).toBeNull();
    expect(calcDividendCagr([100])).toBeNull();
  });

  it("無効値は除外される", () => {
    expect(calcDividendCagr([NaN, 100, 110])).toBeCloseTo(0.1, 4);
  });
});
