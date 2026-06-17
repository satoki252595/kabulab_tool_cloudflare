import { describe, it, expect } from "vitest";
import {
  sma,
  smaSeries,
  emaSeries,
  atr14,
  rsi14,
  macd,
  rangeAndFib,
  avgTurnover,
  avgVolume,
  volumeRatio,
  pctChange1d,
  type Ohlcv,
} from "../../../../../src/shared/indicators/technical.js";

/** テスト用 OHLCV ヘルパ (高値=close+2, 安値=close-2, volume=1000 固定) */
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

describe("sma", () => {
  it("5 期間の平均を返す", () => {
    expect(sma([1, 2, 3, 4, 5], 5)).toBe(3);
  });

  it("データ不足なら null", () => {
    expect(sma([1, 2, 3], 5)).toBeNull();
  });

  it("最新 period 個だけで計算する", () => {
    expect(sma([100, 100, 1, 2, 3, 4, 5], 5)).toBe(3);
  });

  it("null を含む配列では null を除外して計算する", () => {
    expect(sma([1, null, 2, 3, 4, 5], 5)).toBe(3);
  });

  it("period 0 以下は null", () => {
    expect(sma([1, 2, 3], 0)).toBeNull();
    expect(sma([1, 2, 3], -1)).toBeNull();
  });
});

describe("smaSeries", () => {
  it("配列長と同じ長さを返す", () => {
    const out = smaSeries([1, 2, 3, 4, 5], 3);
    expect(out.length).toBe(5);
  });

  it("先頭 period-1 個は null", () => {
    const out = smaSeries([1, 2, 3, 4, 5], 3);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBe(2); // (1+2+3)/3
    expect(out[3]).toBe(3); // (2+3+4)/3
    expect(out[4]).toBe(4); // (3+4+5)/3
  });
});

describe("emaSeries", () => {
  it("先頭 period 個は null / SMA で初期化", () => {
    const out = emaSeries([10, 12, 14, 16, 18], 3);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo((10 + 12 + 14) / 3); // 12
  });

  it("再帰式で EMA を計算する", () => {
    const out = emaSeries([10, 10, 10, 10, 10], 3);
    // 全部 10 なら EMA も 10
    expect(out[4]).toBeCloseTo(10);
  });
});

describe("atr14", () => {
  it("15 日未満なら null", () => {
    const out = atr14(mockOhlcv([1, 2, 3, 4, 5]));
    expect(out).toBeNull();
  });

  it("全て同じ値なら ATR は 4 (固定レンジ)", () => {
    // 高値=close+2, 安値=close-2 → hl = 4 で固定 → ATR = 4
    const out = atr14(mockOhlcv(new Array(20).fill(100)));
    expect(out).toBeCloseTo(4, 5);
  });

  it("null 行を除外する", () => {
    const rows: Ohlcv[] = new Array(20).fill(null).map((_, i) => ({
      date: `2026-01-${i + 1}`,
      open: null,
      high: i === 5 ? null : 102,
      low: i === 5 ? null : 98,
      close: i === 5 ? null : 100,
      volume: null,
    }));
    const out = atr14(rows);
    expect(out).toBeCloseTo(4, 5);
  });
});

describe("rsi14", () => {
  it("15 日未満なら null", () => {
    expect(rsi14([1, 2, 3])).toBeNull();
  });

  it("単調上昇なら 100 付近", () => {
    const values = new Array(30).fill(0).map((_, i) => 100 + i);
    const out = rsi14(values);
    expect(out).toBeCloseTo(100, 0);
  });

  it("単調下降なら 0 付近", () => {
    const values = new Array(30).fill(0).map((_, i) => 100 - i);
    const out = rsi14(values);
    expect(out).toBeCloseTo(0, 0);
  });

  it("横這いは 50 付近", () => {
    const values = new Array(30).fill(100);
    const out = rsi14(values);
    expect(out).toBe(50); // gain=0, loss=0 の特殊ケース
  });
});

describe("macd", () => {
  it("35 日未満 (26+9) なら null", () => {
    const values = new Array(30).fill(100);
    const out = macd(values);
    expect(out.macd).toBeNull();
  });

  it("データ十分なら数値を返す", () => {
    const values = new Array(60).fill(0).map((_, i) => 100 + i * 0.5);
    const out = macd(values);
    expect(out.macd).not.toBeNull();
    expect(out.signal).not.toBeNull();
    expect(out.hist).not.toBeNull();
  });
});

describe("rangeAndFib", () => {
  it("20 日の高値安値と fib 38.2/50/61.8 を返す", () => {
    const data = mockOhlcv(new Array(20).fill(0).map((_, i) => 100 + i));
    // closes: 100..119, high=close+2, low=close-2 → high=121, low=98, width=23
    const out = rangeAndFib(data, 20);
    expect(out.high).toBe(121);
    expect(out.low).toBe(98);
    expect(out.width).toBe(23);
    expect(out.fib382).toBeCloseTo(121 - 23 * 0.382);
    expect(out.fib500).toBeCloseTo(121 - 23 * 0.5);
    expect(out.fib618).toBeCloseTo(121 - 23 * 0.618);
  });

  it("データが空なら null", () => {
    const out = rangeAndFib([], 20);
    expect(out.high).toBeNull();
    expect(out.low).toBeNull();
  });
});

describe("avgTurnover / avgVolume / volumeRatio", () => {
  it("avgTurnover は close × volume の平均", () => {
    // close = 100, volume = 1000 → turnover = 100,000
    const out = avgTurnover(mockOhlcv(new Array(20).fill(100)), 20);
    expect(out).toBe(100_000);
  });

  it("avgVolume は volume の平均", () => {
    const out = avgVolume(mockOhlcv(new Array(20).fill(100)), 20);
    expect(out).toBe(1000);
  });

  it("volumeRatio は当日 / 過去 20 日平均", () => {
    const data = mockOhlcv(new Array(22).fill(100));
    data[21] = { ...data[21], volume: 3000 }; // 当日のみ 3000
    const out = volumeRatio(data, 20);
    expect(out).toBe(3);
  });

  it("データ不足なら null", () => {
    const out = volumeRatio(mockOhlcv([100]), 20);
    expect(out).toBeNull();
  });
});

describe("pctChange1d", () => {
  it("前日終値と比較して%を返す", () => {
    const data = mockOhlcv([100, 105]);
    expect(pctChange1d(data)).toBe(5);
  });

  it("下落も負の値で返す", () => {
    const data = mockOhlcv([100, 95]);
    expect(pctChange1d(data)).toBe(-5);
  });

  it("データ不足なら null", () => {
    expect(pctChange1d(mockOhlcv([100]))).toBeNull();
  });
});
