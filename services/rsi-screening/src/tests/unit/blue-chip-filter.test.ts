import { describe, it, expect } from "vitest";
import {
  judgeTrend,
  evaluateBlueChip,
  OPERATING_MARGIN_TTM_THRESHOLD,
} from "../../../../../src/shared/indicators/blue-chip.js";
import type { AnnualFinancial } from "../../../../../src/shared/types.js";

describe("judgeTrend", () => {
  it("2点未満ならnull", () => {
    expect(judgeTrend([])).toBeNull();
    expect(judgeTrend([100])).toBeNull();
    expect(judgeTrend([null, null])).toBeNull();
  });

  it("単調増加は+1", () => {
    expect(judgeTrend([100, 110, 120])).toBe(1);
  });

  it("単調減少は-1", () => {
    expect(judgeTrend([100, 90, 80])).toBe(-1);
  });

  it("途中下落を含む成長は0 (安定性重視)", () => {
    // 全期で+5%以上だが途中で-10%下落 → 0
    expect(judgeTrend([100, 90, 105])).toBe(0);
  });

  it("横ばい(変化小)は0", () => {
    expect(judgeTrend([100, 101, 102])).toBe(0);
  });

  it("nullを除外して判定する", () => {
    expect(judgeTrend([null, 100, 110, 120])).toBe(1);
  });
});

describe("evaluateBlueChip", () => {
  it("3年未満のデータでは優良株ではない", () => {
    const financials: AnnualFinancial[] = [
      { fiscalYear: 2023, revenue: 100 },
    ];
    const result = evaluateBlueChip(financials, 0.12);
    expect(result.isBlueChip).toBe(false);
    expect(result.revenueTrend).toBeNull();
    expect(result.operatingMarginTtm).toBe(0.12);
  });

  it("売上が3年で増加 AND TTM 営業利益率が閾値以上 → 優良株", () => {
    const financials: AnnualFinancial[] = [
      { fiscalYear: 2022, revenue: 100 },
      { fiscalYear: 2023, revenue: 115 },
      { fiscalYear: 2024, revenue: 130 },
    ];
    const result = evaluateBlueChip(financials, 0.12);
    expect(result.isBlueChip).toBe(true);
    expect(result.revenueTrend).toBe(1);
    expect(result.operatingMarginTtm).toBe(0.12);
  });

  it("売上が増加でも TTM 営業利益率が閾値未満なら非優良", () => {
    const financials: AnnualFinancial[] = [
      { fiscalYear: 2022, revenue: 100 },
      { fiscalYear: 2023, revenue: 115 },
      { fiscalYear: 2024, revenue: 130 },
    ];
    const result = evaluateBlueChip(financials, 0.03);
    expect(result.isBlueChip).toBe(false);
    expect(result.revenueTrend).toBe(1);
    expect(result.operatingMarginTtm).toBe(0.03);
  });

  it("TTM 営業利益率が高くても売上が下降なら非優良", () => {
    const financials: AnnualFinancial[] = [
      { fiscalYear: 2022, revenue: 130 },
      { fiscalYear: 2023, revenue: 115 },
      { fiscalYear: 2024, revenue: 100 },
    ];
    const result = evaluateBlueChip(financials, 0.20);
    expect(result.isBlueChip).toBe(false);
    expect(result.revenueTrend).toBe(-1);
  });

  it("TTM 営業利益率が null なら非優良", () => {
    const financials: AnnualFinancial[] = [
      { fiscalYear: 2022, revenue: 100 },
      { fiscalYear: 2023, revenue: 115 },
      { fiscalYear: 2024, revenue: 130 },
    ];
    const result = evaluateBlueChip(financials, null);
    expect(result.isBlueChip).toBe(false);
    expect(result.revenueTrend).toBe(1);
    expect(result.operatingMarginTtm).toBeNull();
  });

  it("閾値ちょうど (5%) は優良に含まれる", () => {
    const financials: AnnualFinancial[] = [
      { fiscalYear: 2022, revenue: 100 },
      { fiscalYear: 2023, revenue: 115 },
      { fiscalYear: 2024, revenue: 130 },
    ];
    const result = evaluateBlueChip(financials, OPERATING_MARGIN_TTM_THRESHOLD);
    expect(result.isBlueChip).toBe(true);
  });
});
