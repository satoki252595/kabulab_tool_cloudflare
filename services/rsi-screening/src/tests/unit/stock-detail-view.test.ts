import { describe, it, expect } from "vitest";
import {
  stockDetailPage,
  ANNUAL_BREAK_NOTE,
} from "../../views/stock-detail.js";
import type { StockDetail } from "../../services/stock-detail-service.js";

/**
 * 年度売上テーブルの注記 (連結/単体の混在)
 *
 * revenueTrend を「判定不能」にしても、テーブルが素の数値を並べていれば
 * 読者はそこから成長率を読み取ってしまう。表示面でも段差を明示することを
 * 仕様として固定する。
 */
function detailWith(
  annual: Array<{ fiscalYear: number; revenue: number | null }>,
  revenueTrend: number | null
): StockDetail {
  return {
    code: "7203",
    name: "トヨタ自動車",
    market: "プライム",
    sector: "輸送用機器",
    financials: null,
    rsi: {
      rsi10: 40,
      rsi10Percentile: 10,
      rsi40: 45,
      rsi40Percentile: 12,
      rsi120: 50,
      rsi120Percentile: 15,
      rsiMinPercentile: 10,
      isBlueChip: false,
      operatingMarginTtm: 0.12,
      revenueTrend,
    },
    annualFinancials: annual,
  };
}

describe("stockDetailPage: 年度売上テーブルの段差注記", () => {
  it("系列に2倍超の段差があれば注記を出す", () => {
    const html = stockDetailPage({
      detail: detailWith(
        [
          { fiscalYear: 2024, revenue: 17.58e12 },
          { fiscalYear: 2025, revenue: 18.28e12 },
          { fiscalYear: 2026, revenue: 50.68e12 },
        ],
        null
      ),
    });
    expect(html).toContain(ANNUAL_BREAK_NOTE);
    expect(html).toContain("判定不能");
  });

  it("段差が無ければ注記は出さない", () => {
    const html = stockDetailPage({
      detail: detailWith(
        [
          { fiscalYear: 2024, revenue: 100e8 },
          { fiscalYear: 2025, revenue: 115e8 },
          { fiscalYear: 2026, revenue: 130e8 },
        ],
        1
      ),
    });
    expect(html).not.toContain(ANNUAL_BREAK_NOTE);
    expect(html).toContain("上昇基調");
  });

  // 判定窓 (直近3期) の外にある段差は revenueTrend を null にしないが、
  // 表には写っているので注記は出す — ガードの「窓の外は素通り」を表示面で埋める。
  it("段差が判定窓の外でも、表示系列に写っていれば注記を出す", () => {
    const html = stockDetailPage({
      detail: detailWith(
        [
          { fiscalYear: 2022, revenue: 1.6e12 },
          { fiscalYear: 2023, revenue: 45.1e12 },
          { fiscalYear: 2024, revenue: 48.0e12 },
          { fiscalYear: 2025, revenue: 50.7e12 },
        ],
        1
      ),
    });
    expect(html).toContain(ANNUAL_BREAK_NOTE);
    expect(html).toContain("上昇基調");
  });
});
