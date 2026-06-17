import { describe, it, expect } from "vitest";
import {
  calculateRsiSeries,
  calculateAllRsiSeries,
  calculatePercentileRank,
  RSI_PERIODS,
} from "../../../../../src/shared/indicators/rsi.js";

describe("calculateRsiSeries", () => {
  it("期間に満たないデータではnull配列を返す", () => {
    const prices = [100, 101, 102];
    const result = calculateRsiSeries(prices, 14);
    expect(result.every((v) => v === null)).toBe(true);
    expect(result).toHaveLength(3);
  });

  it("全て上昇の場合はRSI=100", () => {
    const prices = Array.from({ length: 20 }, (_, i) => 100 + i);
    const result = calculateRsiSeries(prices, 14);
    const last = result[result.length - 1];
    expect(last).toBe(100);
  });

  it("全て下落の場合はRSI=0", () => {
    const prices = Array.from({ length: 20 }, (_, i) => 100 - i);
    const result = calculateRsiSeries(prices, 14);
    const last = result[result.length - 1];
    expect(last).toBe(0);
  });

  it("変動なしの場合はRSI=50", () => {
    const prices = Array.from({ length: 20 }, () => 100);
    const result = calculateRsiSeries(prices, 14);
    const last = result[result.length - 1];
    expect(last).toBe(50);
  });

  it("period番目以降にRSI値が存在する", () => {
    const prices = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61,
      46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64,
    ];
    const result = calculateRsiSeries(prices, 14);
    // period=14 では最初の14個の価格差分で初期平均を算出するため、result[14]から値が入る
    expect(result[13]).toBeNull();
    expect(result[14]).not.toBeNull();
    // 既知のRSI値: 約70前後
    expect(result[14]).toBeGreaterThan(60);
    expect(result[14]).toBeLessThan(90);
  });
});

describe("calculateAllRsiSeries", () => {
  it("3期間分のRSI時系列を返す", () => {
    const prices = Array.from({ length: 150 }, (_, i) => 100 + Math.sin(i / 10) * 10);
    const series = calculateAllRsiSeries(prices);
    expect(series.rsi10).toHaveLength(150);
    expect(series.rsi40).toHaveLength(150);
    expect(series.rsi120).toHaveLength(150);
    expect(series.rsi10[RSI_PERIODS.short]).not.toBeNull();
    expect(series.rsi40[RSI_PERIODS.mid]).not.toBeNull();
    expect(series.rsi120[RSI_PERIODS.long]).not.toBeNull();
  });
});

describe("calculatePercentileRank", () => {
  it("currentがnullならnullを返す", () => {
    expect(calculatePercentileRank([50, 60, 70], null)).toBeNull();
  });

  it("履歴が空ならnullを返す", () => {
    expect(calculatePercentileRank([null, null], 50)).toBeNull();
  });

  it("最小値は低いパーセンタイルになる", () => {
    const history = [20, 40, 60, 80, 100];
    const pct = calculatePercentileRank(history, 20);
    expect(pct).toBeLessThan(20);
  });

  it("最大値は高いパーセンタイルになる", () => {
    const history = [20, 40, 60, 80, 100];
    const pct = calculatePercentileRank(history, 100);
    expect(pct).toBeGreaterThan(80);
  });

  it("中央値は約50%になる", () => {
    const history = [10, 20, 30, 40, 50, 60, 70, 80, 90];
    const pct = calculatePercentileRank(history, 50);
    expect(pct).toBeGreaterThanOrEqual(40);
    expect(pct).toBeLessThanOrEqual(60);
  });
});
