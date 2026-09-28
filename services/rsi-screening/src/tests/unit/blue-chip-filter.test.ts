import { describe, it, expect } from "vitest";
import {
  judgeTrend,
  evaluateBlueChip,
  hasDefinitionBreak,
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
      { fiscalYear: 2022, fiscalPeriodEnd: "2022-03-31", consolidated: "連結", revenue: 100 },
      { fiscalYear: 2023, fiscalPeriodEnd: "2023-03-31", consolidated: "連結", revenue: 115 },
      { fiscalYear: 2024, fiscalPeriodEnd: "2024-03-31", consolidated: "連結", revenue: 130 },
    ];
    const result = evaluateBlueChip(financials, 0.12);
    expect(result.isBlueChip).toBe(true);
    expect(result.revenueTrend).toBe(1);
    expect(result.operatingMarginTtm).toBe(0.12);
  });

  it("売上が増加でも TTM 営業利益率が閾値未満なら非優良", () => {
    const financials: AnnualFinancial[] = [
      { fiscalYear: 2022, fiscalPeriodEnd: "2022-03-31", consolidated: "連結", revenue: 100 },
      { fiscalYear: 2023, fiscalPeriodEnd: "2023-03-31", consolidated: "連結", revenue: 115 },
      { fiscalYear: 2024, fiscalPeriodEnd: "2024-03-31", consolidated: "連結", revenue: 130 },
    ];
    const result = evaluateBlueChip(financials, 0.03);
    expect(result.isBlueChip).toBe(false);
    expect(result.revenueTrend).toBe(1);
    expect(result.operatingMarginTtm).toBe(0.03);
  });

  it("TTM 営業利益率が高くても売上が下降なら非優良", () => {
    const financials: AnnualFinancial[] = [
      { fiscalYear: 2022, fiscalPeriodEnd: "2022-03-31", consolidated: "連結", revenue: 130 },
      { fiscalYear: 2023, fiscalPeriodEnd: "2023-03-31", consolidated: "連結", revenue: 115 },
      { fiscalYear: 2024, fiscalPeriodEnd: "2024-03-31", consolidated: "連結", revenue: 100 },
    ];
    const result = evaluateBlueChip(financials, 0.20);
    expect(result.isBlueChip).toBe(false);
    expect(result.revenueTrend).toBe(-1);
  });

  it("TTM 営業利益率が null なら非優良", () => {
    const financials: AnnualFinancial[] = [
      { fiscalYear: 2022, fiscalPeriodEnd: "2022-03-31", consolidated: "連結", revenue: 100 },
      { fiscalYear: 2023, fiscalPeriodEnd: "2023-03-31", consolidated: "連結", revenue: 115 },
      { fiscalYear: 2024, fiscalPeriodEnd: "2024-03-31", consolidated: "連結", revenue: 130 },
    ];
    const result = evaluateBlueChip(financials, null);
    expect(result.isBlueChip).toBe(false);
    expect(result.revenueTrend).toBe(1);
    expect(result.operatingMarginTtm).toBeNull();
  });

  it("閾値ちょうど (5%) は優良に含まれる", () => {
    const financials: AnnualFinancial[] = [
      { fiscalYear: 2022, fiscalPeriodEnd: "2022-03-31", consolidated: "連結", revenue: 100 },
      { fiscalYear: 2023, fiscalPeriodEnd: "2023-03-31", consolidated: "連結", revenue: 115 },
      { fiscalYear: 2024, fiscalPeriodEnd: "2024-03-31", consolidated: "連結", revenue: 130 },
    ];
    const result = evaluateBlueChip(financials, OPERATING_MARGIN_TTM_THRESHOLD);
    expect(result.isBlueChip).toBe(true);
  });
});

describe("hasDefinitionBreak (連結/単体の混在検出)", () => {
  it("2倍超のジャンプを段差とみなす", () => {
    expect(hasDefinitionBreak([100, 300])).toBe(true);
  });

  it("半減を段差とみなす", () => {
    expect(hasDefinitionBreak([300, 100])).toBe(true);
  });

  it("ちょうど2倍は段差ではない (境界は閾値を超えた側だけ)", () => {
    expect(hasDefinitionBreak([100, 200])).toBe(false);
    expect(hasDefinitionBreak([200, 100])).toBe(false);
  });

  it("既存フィクスチャ相当の成長 (1.15倍) は段差ではない", () => {
    expect(hasDefinitionBreak([100, 115, 130])).toBe(false);
  });

  it("null は除外して隣接判定する", () => {
    expect(hasDefinitionBreak([null, 100, 110])).toBe(false);
    expect(hasDefinitionBreak([100, null, 1000])).toBe(true);
  });

  it("0 や負の売上は比率が定義できないので段差にしない", () => {
    expect(hasDefinitionBreak([0, 100])).toBe(false);
    expect(hasDefinitionBreak([100, -50])).toBe(false);
  });
});

describe("evaluateBlueChip: 連結/単体混在のガード", () => {
  // 7203 トヨタの実データ。FY2024/FY2025 に単体売上が入り、FY2026 で連結に戻る。
  // 素通りさせると直近3年が +188% と算出されるが、実際の連結は +12.4% (45.1→48.0→50.7兆)。
  it("判定窓に2倍超のジャンプがあれば revenueTrend は null (7203 の実データ)", () => {
    const financials: AnnualFinancial[] = [
      { fiscalYear: 2024, fiscalPeriodEnd: "2024-03-31", consolidated: "連結", revenue: 17.58e12 },
      { fiscalYear: 2025, fiscalPeriodEnd: "2025-03-31", consolidated: "連結", revenue: 18.28e12 },
      { fiscalYear: 2026, fiscalPeriodEnd: "2026-03-31", consolidated: "連結", revenue: 50.68e12 },
    ];
    const result = evaluateBlueChip(financials, 0.12);
    expect(result.revenueTrend).toBeNull();
    // 営業利益率 TTM が閾値を満たしていても優良株にしない
    expect(result.isBlueChip).toBe(false);
  });

  it("判定窓に半減があれば revenueTrend は null (2340 相当の V 字)", () => {
    const financials: AnnualFinancial[] = [
      { fiscalYear: 2024, fiscalPeriodEnd: "2024-03-31", consolidated: "連結", revenue: 12.8e9 },
      { fiscalYear: 2025, fiscalPeriodEnd: "2025-03-31", consolidated: "連結", revenue: 0.865e9 },
      { fiscalYear: 2026, fiscalPeriodEnd: "2026-03-31", consolidated: "連結", revenue: 15.2e9 },
    ];
    const result = evaluateBlueChip(financials, 0.12);
    expect(result.revenueTrend).toBeNull();
    expect(result.isBlueChip).toBe(false);
  });

  it("正常な系列は従来どおり +1 のまま (ガードで巻き込まない)", () => {
    const financials: AnnualFinancial[] = [
      { fiscalYear: 2022, fiscalPeriodEnd: "2022-03-31", consolidated: "連結", revenue: 100 },
      { fiscalYear: 2023, fiscalPeriodEnd: "2023-03-31", consolidated: "連結", revenue: 115 },
      { fiscalYear: 2024, fiscalPeriodEnd: "2024-03-31", consolidated: "連結", revenue: 130 },
    ];
    const result = evaluateBlueChip(financials, 0.12);
    expect(result.revenueTrend).toBe(1);
    expect(result.isBlueChip).toBe(true);
  });

  // 区分が単体で揃っている窓は単体として判定する (表示も「単体」と出す)。
  // 旧 Yahoo 年次には区分が無かったため、窓が単体側に揃って連結並みの
  // 扱いになる混在は段差ガードでは検出できない既知の限界だった。
  // 正本 jss 由来の系列は gate が最新期の区分に単一化し、表示に区分を出すので、
  // ここでは「単一の既知区分で揃った窓はその区分で判定する」を固定する。
  it("窓が単体で揃っていれば単体として判定する (区分は表示で明示)", () => {
    // 7203 の単体水準だけで窓が埋まったケース (連結なら 45〜50 兆の規模)
    const allParentOnly: AnnualFinancial[] = [
      { fiscalYear: 2023, fiscalPeriodEnd: "2023-03-31", consolidated: "単体", revenue: 16.5e12 },
      { fiscalYear: 2024, fiscalPeriodEnd: "2024-03-31", consolidated: "単体", revenue: 17.58e12 },
      { fiscalYear: 2025, fiscalPeriodEnd: "2025-03-31", consolidated: "単体", revenue: 18.28e12 },
    ];
    const result = evaluateBlueChip(allParentOnly, 0.12);
    expect(result.revenueTrend).toBe(1);
    expect(result.isBlueChip).toBe(true);
  });
});

describe("evaluateBlueChip: 年次比較の可否ガード", () => {
  // FY2022/FY2024/FY2026 は 3 年連続ではない。数値が伸びていても
  // 欠年を挟んだ成長率は主張できないので判定不能に倒す。
  it("年欠落があれば revenueTrend は null (飛び年は比較しない)", () => {
    const financials: AnnualFinancial[] = [
      { fiscalYear: 2022, fiscalPeriodEnd: "2022-03-31", consolidated: "連結", revenue: 100 },
      { fiscalYear: 2024, fiscalPeriodEnd: "2024-03-31", consolidated: "連結", revenue: 115 },
      { fiscalYear: 2026, fiscalPeriodEnd: "2026-03-31", consolidated: "連結", revenue: 130 },
    ];
    const result = evaluateBlueChip(financials, 0.12);
    expect(result.revenueTrend).toBeNull();
    expect(result.isBlueChip).toBe(false);
  });

  // 決算期変更の端数期 (2021-12-31) は表示に残るが、年次比較の窓には
  // 入れない。12 ヶ月換算などの年率化もしない。
  it("決算期変更があれば revenueTrend は null (端数期は表示のみ)", () => {
    const financials: AnnualFinancial[] = [
      { fiscalYear: 2021, fiscalPeriodEnd: "2021-03-31", consolidated: "連結", revenue: 20e9 },
      { fiscalYear: 2021, fiscalPeriodEnd: "2021-12-31", consolidated: "連結", revenue: 15e9 },
      { fiscalYear: 2022, fiscalPeriodEnd: "2022-12-31", consolidated: "連結", revenue: 22e9 },
    ];
    const result = evaluateBlueChip(financials, 0.12);
    expect(result.revenueTrend).toBeNull();
    expect(result.isBlueChip).toBe(false);
  });

  // 最新期の区分が不明の系列は表示に「不明」と出すが、区分を保証できない
  // ため既知区分の優良株にはしない。
  it("区分が不明なら revenueTrend は null (不明のまま判定しない)", () => {
    const financials: AnnualFinancial[] = [
      { fiscalYear: 2023, fiscalPeriodEnd: "2023-03-31", consolidated: "不明", revenue: 100 },
      { fiscalYear: 2024, fiscalPeriodEnd: "2024-03-31", consolidated: "不明", revenue: 115 },
      { fiscalYear: 2025, fiscalPeriodEnd: "2025-03-31", consolidated: "不明", revenue: 130 },
    ];
    const result = evaluateBlueChip(financials, 0.12);
    expect(result.revenueTrend).toBeNull();
    expect(result.isBlueChip).toBe(false);
  });

  // 窓の中に未取得 (null) があれば、残り 2 期だけで成長率は主張しない。
  it("窓の中に未取得があれば revenueTrend は null (穴埋めしない)", () => {
    const financials: AnnualFinancial[] = [
      { fiscalYear: 2022, fiscalPeriodEnd: "2022-03-31", consolidated: "連結", revenue: 100 },
      { fiscalYear: 2023, fiscalPeriodEnd: "2023-03-31", consolidated: "連結", revenue: null },
      { fiscalYear: 2024, fiscalPeriodEnd: "2024-03-31", consolidated: "連結", revenue: 130 },
    ];
    const result = evaluateBlueChip(financials, 0.12);
    expect(result.revenueTrend).toBeNull();
    expect(result.isBlueChip).toBe(false);
  });
});
