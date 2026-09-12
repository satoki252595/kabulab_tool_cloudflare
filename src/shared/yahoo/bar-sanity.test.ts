/**
 * 日足バーの帯域チェック。
 *
 * 本番で実際に起きた事故を固定する: 1909 日本ドライケミカルの 2026-09-11 が
 * close=16,278,046,720 / volume=0（前日終値 3,700）で取り込まれ、
 * pct_change_1d が 439,947,108.65% になって業種平均を汚染し、
 * 003 のトップページに「機械 +2,105,009.25%」が表示された。
 */
import { describe, expect, it } from "vitest";

import { MAX_DAILY_RATIO, type Bar, checkBarSelf, sanitizeBars } from "./bar-sanity.js";

/** close を指定したら open/high/low/adj もそれに合わせる（明示指定が優先）。 */
const bar = (over: Partial<Bar> & { date: string }): Bar => {
  const close = over.close ?? 3700;
  return {
    open: close,
    high: close,
    low: close,
    close,
    volume: 69900,
    adj: close,
    ...over,
  };
};

describe("checkBarSelf", () => {
  it("正常なバーは通す", () => {
    expect(checkBarSelf(bar({ date: "2026-09-10" })).ok).toBe(true);
  });

  it("欠測（全て null）は棄却しない", () => {
    expect(
      checkBarSelf({
        date: "2026-09-10",
        open: null, high: null, low: null, close: null, volume: null, adj: null,
      }).ok,
    ).toBe(true);
  });

  it("終値が高安のわずか外は棄却しない（本番 18 本・最大乖離 1.695%）", () => {
    // 7112 2026-08-27: high 700 / low 698 / close 697。Yahoo 側の丸めや
    // 取引時間の差によるもので、弾くと正当なバーを失う
    expect(
      checkBarSelf({
        date: "2026-08-27",
        open: 700, high: 700, low: 698, close: 697, volume: 700, adj: 697,
      }).ok,
    ).toBe(true);
  });

  it.each([
    ["終値が 0", { close: 0 }, "non_positive_close"],
    ["終値が負", { close: -1 }, "non_positive_close"],
    ["高値 < 安値", { high: 100, low: 200, close: 150 }, "high_low_inverted"],
  ])("%s は棄却する", (_l, over, reason) => {
    const r = checkBarSelf(bar({ date: "2026-09-11", ...over }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(reason);
  });
});

describe("sanitizeBars — 本番で起きた事故", () => {
  it("1909 の 2026-09-11 を採用しない", () => {
    const bars = [
      bar({ date: "2026-09-09", close: 3700, volume: 32200 }),
      bar({ date: "2026-09-10", close: 3700, volume: 69900 }),
      bar({
        date: "2026-09-11",
        open: 16278046720, high: 16278046720, low: 16278046720,
        close: 16278046720, volume: 0, adj: 16278046720,
      }),
    ];
    const { bars: kept, rejected } = sanitizeBars(bars);
    expect(kept.map((b) => b.date)).toEqual(["2026-09-09", "2026-09-10"]);
    expect(rejected).toEqual([{ date: "2026-09-11", reason: "jump_without_volume" }]);
  });

  it("出来高を伴う急変は通す（ストップ高・TOB を誤って弾かない）", () => {
    const bars = [
      bar({ date: "2026-09-10", close: 1000, volume: 10000 }),
      bar({ date: "2026-09-11", open: 30000, high: 30000, low: 30000, close: 30000, volume: 500000, adj: 30000 }),
    ];
    expect(sanitizeBars(bars).rejected).toEqual([]);
  });

  it("出来高 0 でも値動きが小さければ通す（薄商い）", () => {
    const bars = [
      bar({ date: "2026-09-10", close: 1000, volume: 10000 }),
      bar({ date: "2026-09-11", open: 1000, high: 1000, low: 1000, close: 1000, volume: 0, adj: 1000 }),
    ];
    expect(sanitizeBars(bars).rejected).toEqual([]);
  });

  it("壊れたバーを基準にせず、次の正常なバーを巻き込まない", () => {
    const bars = [
      bar({ date: "2026-09-09", close: 3700 }),
      bar({ date: "2026-09-10", open: 1e10, high: 1e10, low: 1e10, close: 1e10, volume: 0, adj: 1e10 }),
      bar({ date: "2026-09-11", close: 3750 }),
    ];
    const { bars: kept, rejected } = sanitizeBars(bars);
    expect(kept.map((b) => b.date)).toEqual(["2026-09-09", "2026-09-11"]);
    expect(rejected).toHaveLength(1);
  });

  it("境界: ちょうど MAX_DAILY_RATIO 倍は通す", () => {
    const bars = [
      bar({ date: "2026-09-10", close: 1000 }),
      bar({
        date: "2026-09-11",
        open: 1000 * MAX_DAILY_RATIO, high: 1000 * MAX_DAILY_RATIO,
        low: 1000 * MAX_DAILY_RATIO, close: 1000 * MAX_DAILY_RATIO,
        volume: 0, adj: 1000 * MAX_DAILY_RATIO,
      }),
    ];
    expect(sanitizeBars(bars).rejected).toEqual([]);
  });

  it("空配列でも落ちない", () => {
    expect(sanitizeBars([])).toEqual({ bars: [], rejected: [] });
  });
});
