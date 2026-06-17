import { describe, it, expect } from "vitest";
import { calcPositionSize, drawdownMode } from "../../services/risk.js";

describe("calcPositionSize", () => {
  it("Notion ガイドの例題: 500 万 / 2% / 2000 / 1940 → 1,600 株", () => {
    const out = calcPositionSize({
      accountYen: 5_000_000,
      riskPct: 0.02,
      entryPrice: 2000,
      stopLoss: 1940,
    });
    expect(out.maxRiskYen).toBe(100_000);
    expect(out.riskPerShare).toBe(60);
    expect(out.shares).toBe(1600);
    expect(out.positionValue).toBe(1600 * 2000);
    expect(out.actualRiskYen).toBe(1600 * 60);
  });

  it("ショート方向 (stopLoss > entryPrice) でも正しく計算する", () => {
    const out = calcPositionSize({
      accountYen: 1_000_000,
      riskPct: 0.01,
      entryPrice: 1000,
      stopLoss: 1050,
    });
    // 許容 10,000 / 1 株あたりリスク 50 → 200 株
    expect(out.shares).toBe(200);
  });

  it("100 株単元で切り下げる", () => {
    const out = calcPositionSize({
      accountYen: 1_000_000,
      riskPct: 0.02,
      entryPrice: 1000,
      stopLoss: 970,
    });
    // 20,000 / 30 = 666.66 → 100 株単元で 600 株
    expect(out.shares).toBe(600);
  });

  it("リスクリワード比を計算する", () => {
    const out = calcPositionSize({
      accountYen: 1_000_000,
      riskPct: 0.02,
      entryPrice: 1000,
      stopLoss: 970,
      target1: 1090,
    });
    // (1090 - 1000) / (1000 - 970) = 90 / 30 = 3.0
    expect(out.riskRewardRatio).toBeCloseTo(3);
    expect(out.warnings).toHaveLength(0);
  });

  it("RR が 2 未満なら警告を出す", () => {
    const out = calcPositionSize({
      accountYen: 1_000_000,
      riskPct: 0.02,
      entryPrice: 1000,
      stopLoss: 970,
      target1: 1020,
    });
    // RR = 20 / 30 = 0.67
    expect(out.riskRewardRatio).toBeCloseTo(0.67, 1);
    expect(out.warnings.length).toBeGreaterThan(0);
  });

  it("必要金額が口座を超えると警告を出す", () => {
    const out = calcPositionSize({
      accountYen: 100_000,
      riskPct: 0.02,
      entryPrice: 1000,
      stopLoss: 990,
    });
    // 許容 2000 / リスク 10 = 200 株 → 200,000 円 > 100,000 (信用取引前提)
    expect(out.exceedsAccount).toBe(true);
    expect(out.warnings.some((w) => w.includes("ポジション金額"))).toBe(true);
  });

  it("entryPrice == stopLoss なら throw", () => {
    expect(() =>
      calcPositionSize({
        accountYen: 1_000_000,
        riskPct: 0.02,
        entryPrice: 1000,
        stopLoss: 1000,
      })
    ).toThrow();
  });

  it("負の口座は throw", () => {
    expect(() =>
      calcPositionSize({
        accountYen: -1,
        riskPct: 0.02,
        entryPrice: 1000,
        stopLoss: 990,
      })
    ).toThrow();
  });
});

describe("drawdownMode", () => {
  it("0〜5% は通常モード", () => {
    expect(drawdownMode(3).label).toBe("通常");
    expect(drawdownMode(3).maxRiskPct).toBe(2);
  });

  it("5〜10% は警戒モード", () => {
    expect(drawdownMode(7).label).toBe("警戒");
    expect(drawdownMode(7).maxRiskPct).toBe(1.5);
  });

  it("10〜15% は防御モード", () => {
    expect(drawdownMode(12).label).toBe("防御");
  });

  it("15〜20% は最小モード", () => {
    expect(drawdownMode(18).label).toBe("最小");
  });

  it("20% 超は停止", () => {
    expect(drawdownMode(25).label).toBe("停止");
    expect(drawdownMode(25).maxRiskPct).toBe(0);
  });
});
