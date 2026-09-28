import { describe, it, expect } from "vitest";
import {
  diffStaleScreeningFlags,
  screenStock,
  type ScreeningInput,
} from "./screener.js";

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

describe("diffStaleScreeningFlags: F-02 修復の最小経路 (3 bool だけ)", () => {
  // BASE は流動性・long トレンドが通過する形。旧閾値 (0.02%) の保存値は
  // volatilityOk=true で、現行 2% では 1.5% が落ちる。
  const STALE = { volatilityOk: true, allPassedLong: true, allPassedShort: false };

  it("旧閾値の保存行は 3 bool の再計算値を返し changed=true", () => {
    const { next, changed } = diffStaleScreeningFlags(
      { ...BASE, atrPct: 1.5 },
      STALE
    );
    expect(next).toEqual({
      volatilityOk: false,
      allPassedLong: false,
      allPassedShort: false,
    });
    expect(changed).toBe(true);
  });

  it("現行値と一致する保存行は changed=false (書込対象外・冪等)", () => {
    const { next, changed } = diffStaleScreeningFlags(
      { ...BASE, atrPct: 1.5 },
      { volatilityOk: false, allPassedLong: false, allPassedShort: false }
    );
    expect(next.volatilityOk).toBe(false);
    expect(changed).toBe(false);
  });

  it("2% ちょうどの保存行は通過のまま changed=false", () => {
    const { next, changed } = diffStaleScreeningFlags(
      { ...BASE, atrPct: 2 },
      { volatilityOk: true, allPassedLong: true, allPassedShort: false }
    );
    expect(next).toEqual({
      volatilityOk: true,
      allPassedLong: true,
      allPassedShort: false,
    });
    expect(changed).toBe(false);
  });
});
