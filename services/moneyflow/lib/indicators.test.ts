/**
 * 指標定義カタログの整合性チェック (静的データの検証)。
 */
import { describe, expect, it } from "vitest";
import {
  isMoneyflowFlowType,
  isMoneyflowFrequency,
  isMoneyflowLicense,
  isMoneyflowRequirement,
} from "../../../src/shared/notion-archive/moneyflow.js";
import { MONEYFLOW_INDICATORS } from "./indicators.js";

describe("MONEYFLOW_INDICATORS", () => {
  it("Phase 1 (R1) の 6 指標がある", () => {
    expect(MONEYFLOW_INDICATORS).toHaveLength(6);
  });

  it("指標キーは重複しない", () => {
    const keys = MONEYFLOW_INDICATORS.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("各項目の値域・必須文字列を満たす (moneyflow.ts の select 選択肢と一致)", () => {
    for (const ind of MONEYFLOW_INDICATORS) {
      expect(isMoneyflowRequirement(ind.requirement)).toBe(true);
      expect(isMoneyflowFlowType(ind.flowType)).toBe(true);
      expect(isMoneyflowLicense(ind.license)).toBe(true);
      expect(isMoneyflowFrequency(ind.frequency)).toBe(true);
      expect(ind.displayName.length).toBeGreaterThan(0);
      expect(ind.description.length).toBeGreaterThan(20);
      expect(ind.limitations.length).toBeGreaterThan(0);
      expect(ind.sourceUrl.length).toBeGreaterThan(0);
    }
  });

  it("信用残 (margin) の指標は含まない (今回の実装範囲外・TODO扱い)", () => {
    const keys = MONEYFLOW_INDICATORS.map((i) => i.key);
    expect(keys.some((k) => k.includes("margin"))).toBe(false);
  });

  it("説明文はどれも「純流入」がゼロである旨、または流入出ではない旨を明示する", () => {
    for (const ind of MONEYFLOW_INDICATORS) {
      const text = ind.description;
      expect(text).toMatch(/ではない|ではなく|を意味しない/);
    }
  });

  it("「出典URL」列は url 型プロパティのため、全指標で実際にリンクできる https:// URL のみを持つ (自由記述の由来説明を混ぜない)", () => {
    for (const ind of MONEYFLOW_INDICATORS) {
      expect(ind.sourceUrl).toMatch(/^https:\/\/\S+$/);
      expect(() => new URL(ind.sourceUrl)).not.toThrow();
    }
  });

  it("D1由来 (既存 swing_daily_ohlcv 集計) の指標は、取得元の説明を limitations 側に持つ", () => {
    const d1Derived = ["sector_turnover", "sector_turnover_share", "sector_up_turnover", "sector_down_turnover"];
    for (const key of d1Derived) {
      const ind = MONEYFLOW_INDICATORS.find((i) => i.key === key);
      expect(ind).toBeDefined();
      expect(ind?.limitations).toMatch(/取得元/);
    }
  });
});
