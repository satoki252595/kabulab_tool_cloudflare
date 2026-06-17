import { describe, it, expect } from "vitest";
import { detectAllPatterns, type IndicatorSnapshot } from "../../../../../src/shared/patterns.js";
import type { Ohlcv } from "../../../../../src/shared/indicators/technical.js";

/** デフォルト IndicatorSnapshot (中立の値) */
function baseSnap(overrides: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot {
  return {
    latestClose: 1000,
    prevClose: 990,
    latestOpen: 995,
    latestHigh: 1005,
    latestLow: 985,
    atr14: 20,
    atrPct: 2,
    sma5: 990,
    sma20: 985,
    sma60: 980,
    rsi14: 50,
    macd: 0,
    macdSignal: 0,
    range20dHigh: 1010,
    range20dLow: 960,
    rangeWidth: 50,
    fib382: 990,
    fib618: 975,
    volumeRatio: 1,
    avgTurnover20d: 2e9,
    perfectOrderLong: false,
    perfectOrderShort: false,
    pctChange1d: 1,
    ...overrides,
  };
}

function mockOhlcv(closes: number[]): Ohlcv[] {
  return closes.map((c, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    open: c - 1,
    high: c + 2,
    low: c - 2,
    close: c,
    volume: 1000,
  }));
}

describe("detectBreakoutLong", () => {
  it("20日高値突破 + 出来高 1.5x で検出", () => {
    const snap = baseSnap({
      latestClose: 1015, // > range20dHigh(1010)
      volumeRatio: 2,
    });
    const signals = detectAllPatterns(snap, mockOhlcv([1000]));
    const breakout = signals.find((s) => s.pattern === "breakout_long");
    expect(breakout).toBeDefined();
    expect(breakout!.entryPrice).toBe(1015);
    expect(breakout!.stopLoss).toBe(985); // range20dHigh(1010) - rangeWidth(50)*0.5 = 985
    expect(breakout!.target1).toBe(1065); // entry + rangeWidth
    expect(breakout!.target2).toBe(1115); // entry + rangeWidth*2
  });

  it("出来高不足だと検出しない", () => {
    const snap = baseSnap({ latestClose: 1015, volumeRatio: 1.2 });
    const signals = detectAllPatterns(snap, mockOhlcv([1000]));
    expect(signals.find((s) => s.pattern === "breakout_long")).toBeUndefined();
  });

  it("レンジ内だと検出しない", () => {
    const snap = baseSnap({ latestClose: 1005, volumeRatio: 2 });
    const signals = detectAllPatterns(snap, mockOhlcv([1000]));
    expect(signals.find((s) => s.pattern === "breakout_long")).toBeUndefined();
  });
});

describe("detectBreakoutShort", () => {
  it("20日安値割れ + 出来高 1.5x で検出", () => {
    const snap = baseSnap({
      latestClose: 955, // < range20dLow(960)
      volumeRatio: 2,
    });
    const signals = detectAllPatterns(snap, mockOhlcv([1000]));
    const breakout = signals.find((s) => s.pattern === "breakout_short");
    expect(breakout).toBeDefined();
    expect(breakout!.direction).toBe("short");
  });
});

describe("detectPullbackLong", () => {
  it("パーフェクトオーダー + fib 範囲 + 下ヒゲ陽線で検出", () => {
    const snap = baseSnap({
      perfectOrderLong: true,
      latestClose: 980, // fib618(975) < close < fib382(990)
      latestOpen: 978,  // 陽線 (close > open)
      latestLow: 970,   // 下ヒゲ長い (open - low = 8 > (close - open)*1.5 = 3)
      rsi14: 55,
    });
    const signals = detectAllPatterns(snap, mockOhlcv([1000]));
    const pullback = signals.find((s) => s.pattern === "pullback_long");
    expect(pullback).toBeDefined();
    expect(pullback!.stopLoss).toBe(975); // fib618
    expect(pullback!.target1).toBe(1010); // range20dHigh
  });

  it("パーフェクトオーダーでないと検出しない", () => {
    const snap = baseSnap({
      perfectOrderLong: false,
      latestClose: 980,
      rsi14: 30,
    });
    const signals = detectAllPatterns(snap, mockOhlcv([1000]));
    expect(signals.find((s) => s.pattern === "pullback_long")).toBeUndefined();
  });

  it("RSI 反転で反転サインを検出する", () => {
    const snap = baseSnap({
      perfectOrderLong: true,
      latestClose: 980,
      latestOpen: 985, // 陰線
      rsi14: 35, // < 40 = 反転サイン
    });
    const signals = detectAllPatterns(snap, mockOhlcv([1000]));
    expect(signals.find((s) => s.pattern === "pullback_long")).toBeDefined();
  });
});

describe("detectVolumeSurge", () => {
  it("出来高 3x + 値動き 3%+ で検出", () => {
    const snap = baseSnap({
      volumeRatio: 4,
      pctChange1d: 5,
      atr14: 20,
    });
    const prevBar: Ohlcv = {
      date: "2026-01-10",
      open: 990,
      high: 1000,
      low: 980,
      close: 990,
      volume: 1000,
    };
    const signals = detectAllPatterns(snap, [prevBar]);
    const surge = signals.find((s) => s.pattern === "volume_surge");
    expect(surge).toBeDefined();
    expect(surge!.direction).toBe("long");
    expect(surge!.stopLoss).toBe(980); // 前日安値
  });

  it("出来高不足なら検出しない", () => {
    const snap = baseSnap({ volumeRatio: 2, pctChange1d: 5 });
    const signals = detectAllPatterns(snap, mockOhlcv([990]));
    expect(signals.find((s) => s.pattern === "volume_surge")).toBeUndefined();
  });
});

describe("detectGap", () => {
  it("ギャップアップ + レンジ突破 + 出来高 2x で gap_follow long を検出", () => {
    const snap = baseSnap({
      latestOpen: 1020,   // > range20dHigh(1010)
      prevClose: 1000,
      latestClose: 1030,
      volumeRatio: 2.5,
      rangeWidth: 50,
    });
    const signals = detectAllPatterns(snap, mockOhlcv([1000]));
    const gap = signals.find((s) => s.pattern === "gap_follow");
    expect(gap).toBeDefined();
    expect(gap!.direction).toBe("long");
  });

  it("小さなギャップは普通窓として逆張り検出", () => {
    const snap = baseSnap({
      latestOpen: 985,  // 前日 1000 から -1.5% ギャップダウン
      prevClose: 1000,
      latestClose: 990, // まだ埋まっていない
      volumeRatio: 1,   // 出来高平常
      range20dHigh: 1010,
      range20dLow: 970, // open 985 はレンジ内
    });
    const signals = detectAllPatterns(snap, mockOhlcv([1000]));
    const gap = signals.find((s) => s.pattern === "gap_fade");
    expect(gap).toBeDefined();
    expect(gap!.direction).toBe("long"); // ギャップダウン → 反対方向(埋める)
    expect(gap!.target1).toBe(1000); // prevClose (窓埋め先)
  });
});

describe("detectPostEarnings", () => {
  it("出来高 2.5x + 値動き 5%+ + ATR% 3%+ で検出", () => {
    const snap = baseSnap({
      volumeRatio: 3,
      pctChange1d: 7,
      atrPct: 4,
      atr14: 40,
    });
    const signals = detectAllPatterns(snap, mockOhlcv([1000]));
    const earn = signals.find((s) => s.pattern === "post_earnings");
    expect(earn).toBeDefined();
    expect(earn!.direction).toBe("long");
  });
});

describe("detectAllPatterns integration", () => {
  it("何も該当しないときは空配列", () => {
    const snap = baseSnap();
    const signals = detectAllPatterns(snap, mockOhlcv([1000]));
    expect(signals).toEqual([]);
  });
});
