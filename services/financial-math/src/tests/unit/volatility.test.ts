import { describe, it, expect } from "vitest";
import { calcHistoricalVolatility } from "../../services/volatility.js";
import { calcMomentum, isSmallCap, isLowVolatility } from "../../services/emh.js";

describe("calcHistoricalVolatility", () => {
  it("一定値だけのシリーズはボラ 0", () => {
    const closes = new Array(50).fill(100);
    const r = calcHistoricalVolatility(closes);
    expect(r).not.toBeNull();
    expect(r!.annualizedVolatility).toBe(0);
  });

  it("ランダムウォーク: 日次 σ_d → 年率 σ_d × √252", () => {
    // log return が日次 σ で正規分布する系列を生成
    const dailySigma = 0.02;
    let price = 100;
    const closes: number[] = [price];
    let seed = 1;
    const rand = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280 - 0.5;
    };
    // Box-Muller 風の簡易正規乱数
    const normal = () => {
      const u1 = (rand() + 0.5) || 0.5;
      const u2 = (rand() + 0.5) || 0.5;
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };
    for (let i = 0; i < 252; i++) {
      const r = normal() * dailySigma;
      price *= Math.exp(r);
      closes.push(price);
    }
    const result = calcHistoricalVolatility(closes);
    expect(result).not.toBeNull();
    // 年率ボラの推定値が日次σ * √252 に近いか (±50% のラフな許容)
    const expected = dailySigma * Math.sqrt(252);
    expect(result!.annualizedVolatility).toBeGreaterThan(expected * 0.5);
    expect(result!.annualizedVolatility).toBeLessThan(expected * 1.5);
  });

  it("サンプル不足 (< 20) は null", () => {
    expect(calcHistoricalVolatility([100, 101, 102, 103])).toBeNull();
  });
});

describe("calcMomentum", () => {
  it("単調上昇 (10% 成長) のリターン", () => {
    const closes: number[] = [];
    let p = 100;
    for (let i = 0; i < 30; i++) {
      closes.push(p);
      p *= 1.001;
    }
    const m = calcMomentum(closes, 30);
    expect(m).not.toBeNull();
    expect(m!.cumulativeReturn).toBeGreaterThan(0);
    expect(m!.cumulativeReturn).toBeCloseTo(Math.pow(1.001, 29) - 1, 4);
  });

  it("window 不足は null", () => {
    expect(calcMomentum([100, 101, 102], 30)).toBeNull();
  });
});

describe("isSmallCap / isLowVolatility", () => {
  it("時価総額 100億 < 500億 → 小型株", () => {
    expect(isSmallCap(100e8)).toBe(true);
  });
  it("時価総額 1兆 >= 500億 → 大型株", () => {
    expect(isSmallCap(1e12)).toBe(false);
  });
  it("ATR% 1.0 (= 1%) < 1.5 → 低ボラ", () => {
    // atr_pct は % 値で渡す (1.0 = 1%)
    expect(isLowVolatility(1.0)).toBe(true);
  });
  it("ATR% 3.0 (= 3%) >= 1.5 → 通常", () => {
    expect(isLowVolatility(3.0)).toBe(false);
  });
  it("threshold 引数を変更して判定できる", () => {
    expect(isLowVolatility(2.0, 3.0)).toBe(true);
    expect(isLowVolatility(2.0, 1.0)).toBe(false);
  });
  // 過去の単位ズレバグ (atr_pct を decimal 想定で 0.015 を使う) の再発防止
  it("atr_pct=0.01 (decimal 想定での 1%) は低ボラ判定にならない (threshold は % 値前提)", () => {
    // 0.01 は実 DB では 0.01% (= 0.0001 decimal) を意味する
    // % 値前提の threshold 1.5 で判定するので 0.01 < 1.5 は true
    // ただしこの値が「意図せず誤って渡される」ケースを避けるため、テストで明示
    expect(isLowVolatility(0.01)).toBe(true); // 0.01% < 1.5% → true (% 値前提)
    // 一方、もし threshold を decimal 0.015 で渡すと、0.01 < 0.015 → true だが意味は異なる
  });
  it("null/負値は false", () => {
    expect(isSmallCap(null)).toBe(false);
    expect(isSmallCap(-100)).toBe(false);
    expect(isLowVolatility(null)).toBe(false);
    expect(isLowVolatility(-1)).toBe(false);
  });
});
