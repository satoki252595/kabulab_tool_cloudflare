import { describe, it, expect } from "vitest";
import { screenStock, type ScreeningInput } from "./screener.js";

/**
 * ② ボラ (ATR%) の境界。
 *
 * atrPct は `ratio × 100` の % 表記で渡ってくる (src/cron/daily.ts)。
 * 閾値は 2 (= 2%)。旧 swing-trading から継承した `0.02` との取り違え
 * (実効 0.02% のザル条件) を再発させないために境界だけ固定する。
 */
const BASE: ScreeningInput = {
  avgTurnover20d: 20 * 1e8,
  volumeRatio: 1,
  atrPct: 2,
  sma5: 110,
  sma20: 100,
  latestClose: 120,
};

describe("screenStock: ATR% 境界 (閾値 2%)", () => {
  it("1.99% は不通過", () => {
    expect(screenStock({ ...BASE, atrPct: 1.99 }).volatilityOk).toBe(false);
  });

  it("2% ちょうどは通過", () => {
    expect(screenStock({ ...BASE, atrPct: 2 }).volatilityOk).toBe(true);
  });

  it("2.01% は通過", () => {
    expect(screenStock({ ...BASE, atrPct: 2.01 }).volatilityOk).toBe(true);
  });

  it("未取得 (null) は不通過 — 欠損を通過扱いにしない", () => {
    expect(screenStock({ ...BASE, atrPct: null }).volatilityOk).toBe(false);
  });
});
