/**
 * E&E パターン判定 — swing-trading の patterns.ts からの純粋移植
 *
 * Notion ガイド「エントリー&エグジット編」の 6 パターンを日足ベースで判定する。
 * 分足が必要な「パターン 5: VWAP」「パターン 3 の当日 14 時急増」はスコープ外。
 *
 * DB アクセスは行わない純関数。事前計算された指標 (IndicatorSnapshot) と
 * OHLCV 配列を入力に取り、シグナル (0-N 個) を返す。
 */

import type { Ohlcv } from "./indicators/technical.js";

export interface IndicatorSnapshot {
  latestClose: number;
  prevClose: number | null;
  latestHigh: number | null;
  latestLow: number | null;
  latestOpen: number | null;
  atr14: number | null;
  atrPct: number | null;
  sma5: number | null;
  sma20: number | null;
  sma60: number | null;
  rsi14: number | null;
  macd: number | null;
  macdSignal: number | null;
  range20dHigh: number | null;
  range20dLow: number | null;
  rangeWidth: number | null;
  fib382: number | null;
  fib618: number | null;
  volumeRatio: number | null;
  avgTurnover20d: number | null;
  perfectOrderLong: boolean;
  perfectOrderShort: boolean;
  pctChange1d: number | null;
}

export interface Signal {
  pattern:
    | "breakout_long"
    | "breakout_short"
    | "pullback_long"
    | "pullback_short"
    | "volume_surge"
    | "gap_follow"
    | "gap_fade"
    | "post_earnings";
  direction: "long" | "short";
  entryPrice: number;
  stopLoss: number;
  target1: number | null;
  target2: number | null;
  riskRewardRatio: number | null;
  signalStrength: number;
  note: string;
}

function calcRR(
  entry: number,
  stop: number,
  target: number | null
): number | null {
  if (target === null) return null;
  const risk = Math.abs(entry - stop);
  if (risk === 0) return null;
  return Math.abs(target - entry) / risk;
}

// -----------------------------------------------------------------------------
// パターン 1: ブレイクアウト
// -----------------------------------------------------------------------------

function detectBreakoutLong(snap: IndicatorSnapshot): Signal | null {
  if (
    snap.range20dHigh === null ||
    snap.rangeWidth === null ||
    snap.volumeRatio === null ||
    snap.rangeWidth <= 0
  ) {
    return null;
  }
  if (snap.latestClose >= snap.range20dHigh && snap.volumeRatio >= 1.5) {
    const entry = snap.latestClose;
    const stop = snap.range20dHigh - snap.rangeWidth * 0.5;
    const target1 = entry + snap.rangeWidth;
    const target2 = entry + snap.rangeWidth * 2;
    const rr = calcRR(entry, stop, target1);
    const strength = Math.min(100, snap.volumeRatio * 20);
    return {
      pattern: "breakout_long",
      direction: "long",
      entryPrice: entry,
      stopLoss: stop,
      target1,
      target2,
      riskRewardRatio: rr,
      signalStrength: strength,
      note: `20日高値 ${snap.range20dHigh.toFixed(0)} 突破 / 出来高 ${snap.volumeRatio.toFixed(1)}x`,
    };
  }
  return null;
}

function detectBreakoutShort(snap: IndicatorSnapshot): Signal | null {
  if (
    snap.range20dLow === null ||
    snap.rangeWidth === null ||
    snap.volumeRatio === null ||
    snap.rangeWidth <= 0
  ) {
    return null;
  }
  if (snap.latestClose <= snap.range20dLow && snap.volumeRatio >= 1.5) {
    const entry = snap.latestClose;
    const stop = snap.range20dLow + snap.rangeWidth * 0.5;
    const target1 = entry - snap.rangeWidth;
    const target2 = entry - snap.rangeWidth * 2;
    const rr = calcRR(entry, stop, target1);
    const strength = Math.min(100, snap.volumeRatio * 20);
    return {
      pattern: "breakout_short",
      direction: "short",
      entryPrice: entry,
      stopLoss: stop,
      target1,
      target2,
      riskRewardRatio: rr,
      signalStrength: strength,
      note: `20日安値 ${snap.range20dLow.toFixed(0)} 割れ / 出来高 ${snap.volumeRatio.toFixed(1)}x`,
    };
  }
  return null;
}

// -----------------------------------------------------------------------------
// パターン 2: 押し目買い / 戻り売り
// -----------------------------------------------------------------------------

function detectPullbackLong(snap: IndicatorSnapshot): Signal | null {
  if (
    !snap.perfectOrderLong ||
    snap.fib382 === null ||
    snap.fib618 === null ||
    snap.range20dHigh === null ||
    snap.rsi14 === null
  ) {
    return null;
  }
  if (snap.latestClose < snap.fib618 || snap.latestClose > snap.fib382) {
    return null;
  }

  const isBullishCandle =
    snap.latestOpen !== null &&
    snap.latestLow !== null &&
    snap.latestClose > snap.latestOpen &&
    snap.latestOpen - snap.latestLow >
      (snap.latestClose - snap.latestOpen) * 1.5;
  const rsiReversing = snap.rsi14 < 40;
  if (!isBullishCandle && !rsiReversing) return null;

  const entry = snap.latestClose;
  const stop = snap.fib618;
  const target1 = snap.range20dHigh;
  const rr = calcRR(entry, stop, target1);
  const rsiScore = Math.max(0, (50 - snap.rsi14) * 2);
  const strength = Math.min(100, 40 + rsiScore);
  return {
    pattern: "pullback_long",
    direction: "long",
    entryPrice: entry,
    stopLoss: stop,
    target1,
    target2: null,
    riskRewardRatio: rr,
    signalStrength: strength,
    note: `パーフェクトオーダー + fib ${snap.fib618.toFixed(0)}-${snap.fib382.toFixed(0)} 戻り / RSI ${snap.rsi14.toFixed(1)}`,
  };
}

function detectPullbackShort(snap: IndicatorSnapshot): Signal | null {
  if (
    !snap.perfectOrderShort ||
    snap.fib382 === null ||
    snap.fib618 === null ||
    snap.range20dLow === null ||
    snap.rsi14 === null
  ) {
    return null;
  }
  if (snap.latestClose < snap.fib618 || snap.latestClose > snap.fib382) {
    return null;
  }

  const isBearishCandle =
    snap.latestOpen !== null &&
    snap.latestHigh !== null &&
    snap.latestClose < snap.latestOpen &&
    snap.latestHigh - snap.latestOpen >
      (snap.latestOpen - snap.latestClose) * 1.5;
  const rsiReversing = snap.rsi14 > 60;
  if (!isBearishCandle && !rsiReversing) return null;

  const entry = snap.latestClose;
  const stop = snap.fib382;
  const target1 = snap.range20dLow;
  const rr = calcRR(entry, stop, target1);
  const rsiScore = Math.max(0, (snap.rsi14 - 50) * 2);
  const strength = Math.min(100, 40 + rsiScore);
  return {
    pattern: "pullback_short",
    direction: "short",
    entryPrice: entry,
    stopLoss: stop,
    target1,
    target2: null,
    riskRewardRatio: rr,
    signalStrength: strength,
    note: `逆パーフェクトオーダー + 戻り高値 / RSI ${snap.rsi14.toFixed(1)}`,
  };
}

// -----------------------------------------------------------------------------
// パターン 3: 出来高急増 (翌日エントリー狙い)
// -----------------------------------------------------------------------------

function detectVolumeSurge(
  snap: IndicatorSnapshot,
  ohlcv: ReadonlyArray<Ohlcv>
): Signal | null {
  if (
    snap.volumeRatio === null ||
    snap.pctChange1d === null ||
    snap.atr14 === null
  ) {
    return null;
  }
  if (snap.volumeRatio < 3 || Math.abs(snap.pctChange1d) < 3) return null;

  const prev = ohlcv[ohlcv.length - 1];
  if (!prev || prev.low === null) return null;

  const direction = snap.pctChange1d > 0 ? "long" : "short";
  const entry = snap.latestClose;
  const stop =
    direction === "long" ? prev.low : (prev.high ?? entry + snap.atr14);
  const target1 =
    direction === "long" ? entry + snap.atr14 * 2 : entry - snap.atr14 * 2;
  const rr = calcRR(entry, stop, target1);
  const strength = Math.min(
    100,
    snap.volumeRatio * 15 + Math.abs(snap.pctChange1d) * 2
  );

  return {
    pattern: "volume_surge",
    direction,
    entryPrice: entry,
    stopLoss: stop,
    target1,
    target2: null,
    riskRewardRatio: rr,
    signalStrength: strength,
    note: `出来高 ${snap.volumeRatio.toFixed(1)}x / 前日比 ${snap.pctChange1d.toFixed(2)}% / 翌日押し目狙い`,
  };
}

// -----------------------------------------------------------------------------
// パターン 4: ギャップトレード
// -----------------------------------------------------------------------------

function detectGap(snap: IndicatorSnapshot): Signal | null {
  if (
    snap.latestOpen === null ||
    snap.prevClose === null ||
    snap.volumeRatio === null ||
    snap.range20dHigh === null ||
    snap.range20dLow === null ||
    snap.atr14 === null
  ) {
    return null;
  }
  const gapPct = ((snap.latestOpen - snap.prevClose) / snap.prevClose) * 100;
  if (Math.abs(gapPct) < 1.5) return null;

  const breakoutSide =
    snap.latestOpen > snap.range20dHigh
      ? "long"
      : snap.latestOpen < snap.range20dLow
        ? "short"
        : null;
  if (breakoutSide && snap.volumeRatio >= 2) {
    const entry = snap.latestClose;
    const stop =
      breakoutSide === "long" ? snap.range20dHigh : snap.range20dLow;
    const target1 =
      breakoutSide === "long"
        ? entry + snap.atr14 * 2
        : entry - snap.atr14 * 2;
    const rr = calcRR(entry, stop, target1);
    return {
      pattern: "gap_follow",
      direction: breakoutSide,
      entryPrice: entry,
      stopLoss: stop,
      target1,
      target2: null,
      riskRewardRatio: rr,
      signalStrength: Math.min(100, 50 + snap.volumeRatio * 10),
      note: `ギャップ ${gapPct.toFixed(2)}% 放れ窓 / 出来高 ${snap.volumeRatio.toFixed(1)}x`,
    };
  }

  if (
    snap.latestOpen > snap.range20dLow &&
    snap.latestOpen < snap.range20dHigh &&
    snap.volumeRatio < 1.3
  ) {
    const direction = gapPct > 0 ? "short" : "long";
    const entry = snap.latestClose;
    const target1 = snap.prevClose;
    const stop =
      direction === "long"
        ? entry - snap.atr14 * 1.5
        : entry + snap.atr14 * 1.5;
    const rr = calcRR(entry, stop, target1);
    return {
      pattern: "gap_fade",
      direction,
      entryPrice: entry,
      stopLoss: stop,
      target1,
      target2: null,
      riskRewardRatio: rr,
      signalStrength: 40,
      note: `普通窓 ${gapPct.toFixed(2)}% / 窓埋め逆張り`,
    };
  }

  return null;
}

// -----------------------------------------------------------------------------
// パターン 6: 決算後初動 (近似)
// -----------------------------------------------------------------------------

function detectPostEarnings(snap: IndicatorSnapshot): Signal | null {
  if (
    snap.volumeRatio === null ||
    snap.pctChange1d === null ||
    snap.atr14 === null ||
    snap.atrPct === null
  ) {
    return null;
  }
  if (snap.volumeRatio < 2.5 || Math.abs(snap.pctChange1d) < 5 || snap.atrPct < 3) {
    return null;
  }

  const direction = snap.pctChange1d > 0 ? "long" : "short";
  const entry = snap.latestClose;
  const stop =
    direction === "long" ? entry - snap.atr14 * 1.5 : entry + snap.atr14 * 1.5;
  const target1 =
    direction === "long" ? entry + snap.atr14 * 3 : entry - snap.atr14 * 3;
  const rr = calcRR(entry, stop, target1);

  return {
    pattern: "post_earnings",
    direction,
    entryPrice: entry,
    stopLoss: stop,
    target1,
    target2: null,
    riskRewardRatio: rr,
    signalStrength: Math.min(100, 50 + snap.volumeRatio * 10),
    note: `決算/材料初動 (代理) / 前日比 ${snap.pctChange1d.toFixed(2)}% / ATR% ${snap.atrPct.toFixed(2)}`,
  };
}

// -----------------------------------------------------------------------------
// 統合
// -----------------------------------------------------------------------------

export function detectAllPatterns(
  snap: IndicatorSnapshot,
  ohlcv: ReadonlyArray<Ohlcv>
): Signal[] {
  const results: Signal[] = [];
  const push = (s: Signal | null) => {
    if (s !== null) results.push(s);
  };

  push(detectBreakoutLong(snap));
  push(detectBreakoutShort(snap));
  push(detectPullbackLong(snap));
  push(detectPullbackShort(snap));
  push(detectVolumeSurge(snap, ohlcv));
  push(detectGap(snap));
  push(detectPostEarnings(snap));

  return results;
}
