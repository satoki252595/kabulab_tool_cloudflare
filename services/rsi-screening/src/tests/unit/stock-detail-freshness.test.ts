/**
 * 銘柄詳細ページの鮮度表示の検証。
 *
 * 一覧は鮮度上限を超えた行を除外するが、詳細ページは除外しない (1 銘柄しか
 * 無いのでページが空になるだけ)。除外しない代わりに警告が出ていることを固定する
 * —— バルーンヘルプが「7 日を超えた古い値は表から除外する」と述べているため、
 * 警告が無いと「表示されている = 7 日以内」と誤読される。
 */
import { describe, expect, it } from "vitest";
import { stockDetailPage } from "../../views/stock-detail.js";
import { PERCENTILE_MAX_AGE_DAYS } from "../../services/screening-service.js";
import type { StockDetail } from "../../services/stock-detail-service.js";

const NOW = new Date("2026-09-14T21:30:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function detail(computedAt: Date): StockDetail {
  return {
    code: "1001",
    name: "テスト銘柄",
    market: "プライム",
    sector: "情報・通信業",
    financials: {
      price: 1200,
      per: 12.3,
      pbr: 1.1,
      dividendYield: 2.5,
      eps: 97.5,
      bps: 1090,
      roe: 0.09,
      roa: 0.05,
      marketCap: 1.2e11,
      operatingMargin: 0.12,
      dataDate: "2026-09-11",
    },
    rsi: {
      rsi10: 25,
      rsi10Percentile: 2,
      rsi40: 30,
      rsi40Percentile: 5,
      rsi120: 35,
      rsi120Percentile: 8,
      rsiMinPercentile: 2,
      isBlueChip: false,
      operatingMarginTtm: 0.12,
      revenueTrend: 1,
      percentileSampleBars: 1223,
      computedAt,
    },
    annualFinancials: [{ fiscalYear: 2026, revenue: 1.0e11 }],
  };
}

describe("stockDetailPage の鮮度表示", () => {
  it("鮮度上限内なら算出日と経過日数だけを出す", () => {
    const html = stockDetailPage({
      detail: detail(new Date(NOW.getTime() - 3 * DAY_MS)),
      now: NOW,
    });

    expect(html).toContain("2026-09-11");
    expect(html).toContain("3 日前");
    expect(html).not.toContain("鮮度不足");
  });

  it("鮮度上限を超えた算出値は「一覧では除外される値」と警告する", () => {
    // 実測で残っていた 2026-05-15 算出の行。一覧からは消えるが、詳細ページは
    // URL 直打ちで到達できるので、古いまま黙って出さない。
    const html = stockDetailPage({
      detail: detail(new Date("2026-05-15T21:10:00.000Z")),
      now: NOW,
    });

    expect(html).toContain("鮮度不足のため一覧では除外される値");
    expect(html).toContain('class="bad"');
  });

  it("境界 (上限ちょうど) は警告しない", () => {
    const html = stockDetailPage({
      detail: detail(new Date(NOW.getTime() - PERCENTILE_MAX_AGE_DAYS * DAY_MS)),
      now: NOW,
    });

    expect(html).not.toContain("鮮度不足");
  });
});
