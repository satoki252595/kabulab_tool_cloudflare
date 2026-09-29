/**
 * 日足バーの帯域チェック。
 *
 * 本番で実際に起きた事故を固定する: 1909 日本ドライケミカルの 2026-09-11 が
 * close=16,278,046,720 / volume=0（前日終値 3,700）で取り込まれ、
 * pct_change_1d が 439,947,108.65% になって業種平均を汚染し、
 * 003 のトップページに「機械 +2,105,009.25%」が表示された。
 */
import { describe, expect, it } from "vitest";

import {
  MAX_DAILY_RATIO,
  type Bar,
  assertRawBarsSane,
  assertResponsePriceCoherent,
  checkBarSelf,
  checkFreshClose,
  isProvenSamePoint,
  sanitizeBars,
} from "./bar-sanity.js";

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

  it("先頭から持続する異常水準は素通りする (応答guardが塞ぐ穴の記録)", () => {
    // 1909 の 2026-07-17 以降: 先頭 bar 自体が 1.6e10 で比較対象がなく、
    // 後続も比率 ~1 のため 40 本すべて採用された。bar 単位では塞げないため
    // assertResponsePriceCoherent (meta 価格との応答整合) で拒否する。
    const bars = [
      bar({ date: "2026-09-10", open: 1.62e10, high: 1.62e10, low: 1.62e10, close: 1.62e10, volume: 0, adj: 1.62e10 }),
      bar({ date: "2026-09-11", open: 1.62e10, high: 1.62e10, low: 1.62e10, close: 1.62e10, volume: 0, adj: 1.62e10 }),
      { date: "2026-09-14", open: null, high: null, low: null, close: null, volume: null, adj: null },
    ];
    expect(sanitizeBars(bars).rejected).toEqual([]);
  });
});

describe("assertResponsePriceCoherent — 同一応答の meta 価格との整合", () => {
  it("1909 形 (最新有効終値が meta の10倍超乖離 + 出来高0) は応答全体を拒否する", () => {
    expect(() =>
      assertResponsePriceCoherent({
        symbol: "1909",
        latestUsedClose: 16280000512,
        latestVolume: 0,
        metaPrice: 3700,
      }),
    ).toThrow(/応答全体を採用しません/);
  });

  it("出来高なしでも乖離がなければ通す（薄商い: 本番 volume=0 は 479 行）", () => {
    expect(() =>
      assertResponsePriceCoherent({
        symbol: "3600",
        latestUsedClose: 1000,
        latestVolume: 0,
        metaPrice: 1000,
      }),
    ).not.toThrow();
  });

  it("出来高を伴う乖離は通す（正規分割・急騰を誤って弾かない）", () => {
    expect(() =>
      assertResponsePriceCoherent({
        symbol: "7203",
        latestUsedClose: 30000,
        latestVolume: 500000,
        metaPrice: 1000,
      }),
    ).not.toThrow();
  });

  it("境界: ちょうど MAX_DAILY_RATIO 倍は通す", () => {
    expect(() =>
      assertResponsePriceCoherent({
        symbol: "7203",
        latestUsedClose: 1000 * MAX_DAILY_RATIO,
        latestVolume: 0,
        metaPrice: 1000,
      }),
    ).not.toThrow();
  });

  it.each([
    ["最新有効終値なし", { latestUsedClose: null, latestVolume: 0, metaPrice: 3700 }],
    ["meta 価格なし", { latestUsedClose: 3700, latestVolume: 0, metaPrice: null }],
    ["最新有効終値 undefined", { latestUsedClose: undefined, latestVolume: 0, metaPrice: 3700 }],
  ])("%s は判定不能として通す（欠損の扱いは日次 gate）", (_l, over) => {
    expect(() =>
      assertResponsePriceCoherent({ symbol: "1909", ...over }),
    ).not.toThrow();
  });

  it.each([
    ["終値が 0", { latestUsedClose: 0, latestVolume: 0, metaPrice: 3700 }],
    ["終値が負", { latestUsedClose: -5, latestVolume: 0, metaPrice: 3700 }],
    ["終値が非有限", { latestUsedClose: Number.NaN, latestVolume: 0, metaPrice: 3700 }],
    ["meta が非正", { latestUsedClose: 3700, latestVolume: 0, metaPrice: -1 }],
    ["meta が非有限", { latestUsedClose: 3700, latestVolume: 0, metaPrice: Number.NaN }],
  ])("%s は実数値の無効として応答全体を拒否する", (_l, over) => {
    expect(() =>
      assertResponsePriceCoherent({ symbol: "1909", ...over }),
    ).toThrow(/応答全体を採用しません/);
  });

  it.each([
    ["終値なし + meta が非有限", { latestUsedClose: null, latestVolume: 0, metaPrice: Number.NaN }],
    ["終値が負 + meta なし", { latestUsedClose: -5, latestVolume: 0, metaPrice: null }],
  ])("%s は片側 missing でも逆側の実在 invalid を拒否する", (_l, over) => {
    expect(() =>
      assertResponsePriceCoherent({ symbol: "1909", ...over }),
    ).toThrow(/応答全体を採用しません/);
  });
});

describe("checkFreshClose — 日次 writer 前提 (日付 + 実終値)", () => {
  it("対象日の実終値があれば通す", () => {
    expect(
      checkFreshClose(bar({ date: "2026-09-25", close: 2989.5 }), "2026-09-25"),
    ).toEqual({ ok: true });
  });

  it("adj がなくても close があれば通す (adj ?? close を使用値にする)", () => {
    expect(
      checkFreshClose(
        bar({ date: "2026-09-25", close: 2989.5, adj: null }),
        "2026-09-25",
      ),
    ).toEqual({ ok: true });
  });

  it("末尾が古い日なら stale_date (既存 gate と同義)", () => {
    expect(
      checkFreshClose(bar({ date: "2026-09-18", close: 2989.5 }), "2026-09-25"),
    ).toEqual({ ok: false, reason: "stale_date" });
  });

  it("対象日でも実終値が null なら missing_fresh_close (日付だけ合格にしない)", () => {
    expect(
      checkFreshClose(
        {
          date: "2026-09-25",
          open: null, high: null, low: null, close: null, volume: null, adj: null,
        },
        "2026-09-25",
      ),
    ).toEqual({ ok: false, reason: "missing_fresh_close" });
  });

  it.each([
    ["終値が 0", { close: 0, adj: 0 }],
    ["終値が負", { close: -5, adj: -5 }],
  ])("対象日でも使用値が%sなら missing_fresh_close", (_l, over) => {
    expect(
      checkFreshClose(bar({ date: "2026-09-25", ...over }), "2026-09-25"),
    ).toEqual({ ok: false, reason: "missing_fresh_close" });
  });
});

describe("assertRawBarsSane — filter 前の全 raw 行検査", () => {
  const row = (over: object = {}) => ({
    o: 100,
    h: 110,
    l: 90,
    c: 105,
    v: 1000,
    ...over,
  });

  it("正常・欠落 null は通す", () => {
    expect(() =>
      assertRawBarsSane("7203.T", [row(), row({ v: null }), row({ c: null })])
    ).not.toThrow();
  });

  it("非最新行の負値も欠落に隠さず拒否する", () => {
    expect(() =>
      assertRawBarsSane("7203.T", [row({ c: -5 }), row({ v: null })])
    ).toThrow(/raw c\[0\] が非正/);
  });

  it("負の出来高を拒否する (0 は正当)", () => {
    expect(() => assertRawBarsSane("7203.T", [row({ v: -5 })])).toThrow(
      /raw volume\[0\] が負/
    );
    expect(() => assertRawBarsSane("7203.T", [row({ v: 0 })])).not.toThrow();
  });

  it("高安逆転を拒否するが終値のレンジ外は正当 (7112 丸め)", () => {
    expect(() =>
      assertRawBarsSane("7203.T", [{ o: 100, h: 80, l: 90, c: 85, v: 10 }])
    ).toThrow(/高安逆転/);
    expect(() =>
      assertRawBarsSane("7112.T", [
        { o: 699, h: 700, l: 698, c: 697, v: 100 },
      ])
    ).not.toThrow();
  });

  it("実在 adj の非有限・非正を拒否し、null は欠落として通す", () => {
    expect(() =>
      assertRawBarsSane("7203.T", [row()], [Number.NaN])
    ).toThrow(/raw adj\[0\] が非有限/);
    expect(() => assertRawBarsSane("7203.T", [row()], [-3])).toThrow(
      /raw adj\[0\] が非正/
    );
    expect(() =>
      assertRawBarsSane("7203.T", [row()], [null])
    ).not.toThrow();
  });
});

describe("isProvenSamePoint — meta 時刻と bar interval の同時点証明", () => {
  it("interval 内の meta 時刻のみ true", () => {
    expect(isProvenSamePoint(1757635260, 1757635200, 300)).toBe(true);
    expect(isProvenSamePoint(1757635200, 1757635200, 300)).toBe(true);
  });

  it("欠落・非有限・interval 外は false (明示 skip 用)", () => {
    expect(isProvenSamePoint(null, 1757635200, 300)).toBe(false);
    expect(isProvenSamePoint(undefined, 1757635200, 300)).toBe(false);
    expect(isProvenSamePoint(Number.NaN, 1757635200, 300)).toBe(false);
    expect(isProvenSamePoint(1757635200 + 300, 1757635200, 300)).toBe(false);
    expect(isProvenSamePoint(1757635200 - 1, 1757635200, 300)).toBe(false);
    // 旧 session (前日) の bar と現 meta は誤比較しない。
    expect(isProvenSamePoint(1757635200, 1757548800, 300)).toBe(false);
  });
});
