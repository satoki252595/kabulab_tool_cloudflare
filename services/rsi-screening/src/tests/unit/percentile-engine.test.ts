import { describe, it, expect } from "vitest";
import { computeRsiPercentileSnapshot } from "../../../../../src/shared/indicators/percentile.js";

describe("computeRsiPercentileSnapshot", () => {
  it("全期間の最新RSIとパーセンタイル、最小値を返す", () => {
    const rsiHistory = {
      rsi10: [null, 80, 70, 60, 50, 30], // 現在30 (低め)
      rsi40: [null, null, 70, 65, 60, 55], // 現在55 (中程度)
      rsi120: [null, null, null, 50, 48, 46], // 現在46
    };
    const snap = computeRsiPercentileSnapshot(rsiHistory);
    expect(snap.rsi10).toBe(30);
    expect(snap.rsi40).toBe(55);
    expect(snap.rsi120).toBe(46);
    expect(snap.rsi10Percentile).not.toBeNull();
    expect(snap.rsi40Percentile).not.toBeNull();
    expect(snap.rsi120Percentile).not.toBeNull();
    expect(snap.rsiMinPercentile).toBe(
      Math.min(snap.rsi10Percentile!, snap.rsi40Percentile!, snap.rsi120Percentile!)
    );
  });

  it("履歴が空の場合はnull", () => {
    const snap = computeRsiPercentileSnapshot({
      rsi10: [],
      rsi40: [],
      rsi120: [],
    });
    expect(snap.rsi10).toBeNull();
    expect(snap.rsiMinPercentile).toBeNull();
  });

  it("現在値が最小ならパーセンタイルは0に近い", () => {
    const rsiHistory = {
      rsi10: [50, 60, 70, 80, 20], // 最小が末尾
      rsi40: [50, 60, 70, 80, 30],
      rsi120: [50, 60, 70, 80, 10],
    };
    const snap = computeRsiPercentileSnapshot(rsiHistory);
    expect(snap.rsi10Percentile).toBeLessThan(20);
    expect(snap.rsi120Percentile).toBeLessThan(20);
  });
});
