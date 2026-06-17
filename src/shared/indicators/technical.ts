/**
 * テクニカル指標の純粋関数
 *
 * swing-trading の `services/swing-trading/src/services/indicators.ts` を
 * 共有版に移植。otakara-yutai の内部計算と統合するため MA25 も sma() で
 * 同じ実装から取れる (ma25() は内部的に sma(closes, 25) を呼ぶだけ)。
 *
 * DB アクセスや外部 I/O は一切行わない。入力は「終値配列」や「OHLCV 配列」、
 * 出力は数値/配列。NaN / undefined は返さず、不足データは null を返す。
 */

import type { DailyOhlcv } from "../types.js";

/** swing.stock_indicators と互換性のあるローカル Ohlcv 型 */
export type Ohlcv = DailyOhlcv;

function compact(values: ReadonlyArray<number | null>): number[] {
  return values.filter(
    (v): v is number => v !== null && Number.isFinite(v)
  );
}

// -----------------------------------------------------------------------------
// SMA
// -----------------------------------------------------------------------------

/** 単純移動平均 */
export function sma(
  values: ReadonlyArray<number | null>,
  period: number
): number | null {
  if (period <= 0) return null;
  const compacted = compact(values);
  if (compacted.length < period) return null;
  const slice = compacted.slice(-period);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / period;
}

/**
 * SMA 時系列を計算する (配列全長分、データ不足の先頭は null)
 *
 * rolling window で null を除外して period 個揃ったときのみ値を入れる。
 * 本コードでは使わないが、単体テスト時の期待値確認に便利なので export する。
 */
export function smaSeries(
  values: ReadonlyArray<number | null>,
  period: number
): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (period <= 0) return out;
  for (let i = 0; i < values.length; i++) {
    const window: number[] = [];
    for (let j = i; j >= 0 && window.length < period; j--) {
      const v = values[j];
      if (v !== null && Number.isFinite(v)) window.unshift(v);
    }
    if (window.length === period) {
      const sum = window.reduce((a, b) => a + b, 0);
      out[i] = sum / period;
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// EMA (MACD 内部用)
// -----------------------------------------------------------------------------

export function emaSeries(
  values: ReadonlyArray<number>,
  period: number
): Array<number | null> {
  if (period <= 0) return values.map(() => null);
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (values.length < period) return out;

  const alpha = 2 / (period + 1);

  // 初期 period 個は SMA
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let ema = sum / period;
  out[period - 1] = ema;

  for (let i = period; i < values.length; i++) {
    ema = alpha * values[i] + (1 - alpha) * ema;
    out[i] = ema;
  }
  return out;
}

// -----------------------------------------------------------------------------
// ATR(14) — Wilder's smoothing
// -----------------------------------------------------------------------------

function trueRange(
  high: number,
  low: number,
  prevClose: number | null
): number {
  const hl = high - low;
  if (prevClose === null) return hl;
  const hc = Math.abs(high - prevClose);
  const lc = Math.abs(low - prevClose);
  return Math.max(hl, hc, lc);
}

export function atr14(ohlcv: ReadonlyArray<Ohlcv>): number | null {
  const period = 14;
  const cleaned: Array<{ high: number; low: number; close: number }> = [];
  for (const row of ohlcv) {
    if (
      row.high !== null &&
      row.low !== null &&
      row.close !== null &&
      Number.isFinite(row.high) &&
      Number.isFinite(row.low) &&
      Number.isFinite(row.close)
    ) {
      cleaned.push({ high: row.high, low: row.low, close: row.close });
    }
  }
  if (cleaned.length < period + 1) return null;

  const trs: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const prevClose = i === 0 ? null : cleaned[i - 1].close;
    trs.push(trueRange(cleaned[i].high, cleaned[i].low, prevClose));
  }

  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

// -----------------------------------------------------------------------------
// RSI(14) — Wilder's smoothing (swing 用の 1 点取得版)
// -----------------------------------------------------------------------------

export function rsi14(
  closes: ReadonlyArray<number | null>
): number | null {
  const period = 14;
  const values = compact(closes);
  if (values.length < period + 1) return null;

  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    gains.push(Math.max(diff, 0));
    losses.push(Math.max(-diff, 0));
  }

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// -----------------------------------------------------------------------------
// MACD(12, 26, 9)
// -----------------------------------------------------------------------------

export function macd(closes: ReadonlyArray<number | null>): {
  macd: number | null;
  signal: number | null;
  hist: number | null;
} {
  const values = compact(closes);
  if (values.length < 26 + 9) {
    return { macd: null, signal: null, hist: null };
  }
  const ema12 = emaSeries(values, 12);
  const ema26 = emaSeries(values, 26);
  const macdLine: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const a = ema12[i];
    const b = ema26[i];
    if (a === null || b === null) continue;
    macdLine.push(a - b);
  }
  if (macdLine.length < 9) {
    return { macd: null, signal: null, hist: null };
  }
  const signalArr = emaSeries(macdLine, 9);
  const lastMacd = macdLine[macdLine.length - 1];
  const lastSignal = signalArr[signalArr.length - 1];
  if (lastSignal === null) {
    return { macd: lastMacd, signal: null, hist: null };
  }
  return {
    macd: lastMacd,
    signal: lastSignal,
    hist: lastMacd - lastSignal,
  };
}

// -----------------------------------------------------------------------------
// 20 日レンジ + フィボナッチ
// -----------------------------------------------------------------------------

export function rangeAndFib(
  ohlcv: ReadonlyArray<Ohlcv>,
  period = 20
): {
  high: number | null;
  low: number | null;
  width: number | null;
  fib382: number | null;
  fib500: number | null;
  fib618: number | null;
} {
  const slice = ohlcv.slice(-period);
  const highs = compact(slice.map((r) => r.high));
  const lows = compact(slice.map((r) => r.low));
  if (highs.length === 0 || lows.length === 0) {
    return {
      high: null,
      low: null,
      width: null,
      fib382: null,
      fib500: null,
      fib618: null,
    };
  }
  const high = Math.max(...highs);
  const low = Math.min(...lows);
  const width = high - low;
  return {
    high,
    low,
    width,
    fib382: high - width * 0.382,
    fib500: high - width * 0.5,
    fib618: high - width * 0.618,
  };
}

// -----------------------------------------------------------------------------
// 出来高・売買代金・前日比
// -----------------------------------------------------------------------------

export function avgTurnover(
  ohlcv: ReadonlyArray<Ohlcv>,
  period = 20
): number | null {
  const slice = ohlcv.slice(-period);
  const values: number[] = [];
  for (const row of slice) {
    if (
      row.close !== null &&
      row.volume !== null &&
      Number.isFinite(row.close) &&
      Number.isFinite(row.volume)
    ) {
      values.push(row.close * row.volume);
    }
  }
  if (values.length < period) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function avgVolume(
  ohlcv: ReadonlyArray<Ohlcv>,
  period = 20
): number | null {
  const slice = ohlcv.slice(-period);
  const volumes = compact(slice.map((r) => r.volume));
  if (volumes.length < period) return null;
  return volumes.reduce((a, b) => a + b, 0) / volumes.length;
}

export function volumeRatio(
  ohlcv: ReadonlyArray<Ohlcv>,
  period = 20
): number | null {
  if (ohlcv.length === 0) return null;
  const latest = ohlcv[ohlcv.length - 1].volume;
  const history = ohlcv.slice(-period - 1, -1);
  const hist = compact(history.map((r) => r.volume));
  if (latest === null || hist.length < period) return null;
  const avg = hist.reduce((a, b) => a + b, 0) / hist.length;
  if (avg === 0) return null;
  return latest / avg;
}

export function pctChange1d(ohlcv: ReadonlyArray<Ohlcv>): number | null {
  const closes = compact(ohlcv.map((r) => r.close));
  if (closes.length < 2) return null;
  const today = closes[closes.length - 1];
  const yesterday = closes[closes.length - 2];
  if (yesterday === 0) return null;
  return ((today - yesterday) / yesterday) * 100;
}
