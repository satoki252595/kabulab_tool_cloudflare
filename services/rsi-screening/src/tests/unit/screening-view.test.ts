/**
 * スクリーニング画面の鮮度表示の検証。
 *
 * 古い行を黙って落とすと「該当なし」と「古い行しか無い」の区別が読者に付かない。
 * 除外件数と母数が実際に HTML に出ていることを固定する。
 */
import { describe, expect, it } from "vitest";
import { screeningPage } from "../../views/screening.js";
import type { ScreeningRow } from "../../services/screening-service.js";
import { screeningQuerySchema } from "../../validators/screening.js";

const NOW = new Date("2026-09-14T21:30:00.000Z");
const query = screeningQuerySchema.parse({});

function row(overrides: Partial<ScreeningRow> = {}): ScreeningRow {
  return {
    code: "1001",
    name: "テスト銘柄",
    market: "プライム",
    sector: "情報・通信業",
    price: 1200,
    per: 12.3,
    pbr: 1.1,
    dividendYield: 2.5,
    marketCap: 1.2e11,
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
    computedAt: new Date("2026-09-11T21:10:00.000Z"),
    ...overrides,
  };
}

describe("screeningPage の鮮度表示", () => {
  it("鮮度不足で除外した件数を出す", () => {
    const html = screeningPage({
      query,
      result: { rows: [row()], totalMatched: 1, staleExcluded: 49, maxAgeDays: 7 },
      now: NOW,
    });

    expect(html).toContain("鮮度不足で除外");
    expect(html).toContain("49 件");
  });

  it("除外が無いときは除外表示を出さない", () => {
    const html = screeningPage({
      query,
      result: { rows: [row()], totalMatched: 1, staleExcluded: 0, maxAgeDays: 7 },
      now: NOW,
    });

    expect(html).not.toContain("鮮度不足で除外");
  });

  it("全件が鮮度不足なら空状態でその理由を述べる", () => {
    const html = screeningPage({
      query,
      result: { rows: [], totalMatched: 0, staleExcluded: 3, maxAgeDays: 7 },
      now: NOW,
    });

    expect(html).toContain("3 銘柄はすべて 7 日超の古い算出値");
    expect(html).not.toContain("条件に合致する銘柄が見つかりません");
  });

  it("母数と算出日 (経過日数) を行に出す", () => {
    const html = screeningPage({
      query,
      result: { rows: [row({ percentileSampleBars: 461 })], totalMatched: 1, staleExcluded: 0, maxAgeDays: 7 },
      now: NOW,
    });

    expect(html).toContain("461");
    expect(html).toContain("2026-09-11");
    // 金曜算出を月曜に見ているので 3 日前。
    expect(html).toContain("3d");
  });

  it("母数が未計算の行は 0 で埋めず「—」を出す", () => {
    const html = screeningPage({
      query,
      result: {
        rows: [row({ percentileSampleBars: null })],
        totalMatched: 1,
        staleExcluded: 0,
        maxAgeDays: 7,
      },
      now: NOW,
    });

    expect(html).not.toContain(">0</td>");
  });
});

describe("screeningPage の総数表示 (F-07 同型)", () => {
  it("HITS は全件数で、途切れるときは先頭件数を明記する", () => {
    const html = screeningPage({
      query,
      result: { rows: [row()], totalMatched: 201, staleExcluded: 0, maxAgeDays: 7 },
      now: NOW,
    });

    expect(html).toContain("201 HITS");
    expect(html).toContain("先頭1件を表示（全201件）");
  });

  it("途切れなしでは注記を出さない", () => {
    const html = screeningPage({
      query,
      result: { rows: [row()], totalMatched: 1, staleExcluded: 0, maxAgeDays: 7 },
      now: NOW,
    });

    expect(html).toContain("1 HITS");
    expect(html).not.toContain("件を表示（全");
    expect(html).not.toContain("件目を表示");
  });

  it("offset 適用時は表示範囲を件目で明記する", () => {
    const offsetQuery = screeningQuerySchema.parse({ offset: 200 });
    const html = screeningPage({
      query: offsetQuery,
      result: { rows: [row()], totalMatched: 201, staleExcluded: 0, maxAgeDays: 7 },
      now: NOW,
    });

    expect(html).toContain("201 HITS");
    expect(html).toContain("201〜201件目を表示（全201件）");
  });

  it("offset が全件を超えた空表示では「該当なし」と言わない", () => {
    const offsetQuery = screeningQuerySchema.parse({ offset: 201 });
    const html = screeningPage({
      query: offsetQuery,
      result: { rows: [], totalMatched: 201, staleExcluded: 0, maxAgeDays: 7 },
      now: NOW,
    });

    expect(html).toContain("全201件中、202件目以降に表示できる行がありません");
    expect(html).not.toContain("条件に合致する銘柄が見つかりません");
  });
});
