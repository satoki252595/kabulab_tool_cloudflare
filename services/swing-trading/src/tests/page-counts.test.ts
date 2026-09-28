import { describe, expect, it } from "vitest";
import {
  screeningPage,
  type ScreeningRow,
} from "../views/screening.js";
import { signalsPage, type SignalRow } from "../views/signals.js";

/**
 * F-07: 総数 (同一 where の COUNT) と表示件数 (先頭 200 件) の区別。
 *
 * route が渡す totalCount は全件。表示が途切れるときは
 * 「先頭N件を表示（全M件）」を明記する。途切れなしでは注記を出さない。
 */

function screeningRow(code: string): ScreeningRow {
  return {
    code,
    name: `銘柄${code}`,
    sector: "電機",
    latestClose: 1000,
    pctChange1d: 1,
    avgTurnover20d: 20 * 1e8,
    atrPct: 2.5,
    sma5: 1100,
    sma20: 1000,
    volumeRatio: 1,
    liquidityOk: true,
    volatilityOk: true,
    trendOk: true,
  };
}

function signalRow(code: string): SignalRow {
  return {
    code,
    name: `銘柄${code}`,
    sector: "電機",
    pattern: "breakout_long",
    direction: "long",
    entryPrice: 1000,
    stopLoss: 950,
    target1: 1100,
    target2: null,
    riskRewardRatio: 2,
    signalStrength: 70,
    note: "",
  };
}

describe("screeningPage の件数表示 (F-07)", () => {
  it("途切れありでは先頭件数と全件を明記する", () => {
    const html = screeningPage({
      direction: "long",
      rows: [screeningRow("7203"), screeningRow("7974")],
      totalCount: 5,
    });
    expect(html).toContain("先頭2件を表示（全5件）");
  });

  it("途切れなしでは注記を出さない", () => {
    const html = screeningPage({
      direction: "short",
      rows: [screeningRow("7203")],
      totalCount: 1,
    });
    expect(html).not.toContain("先頭");
  });

  it("LONG/SHORT に初心者向けバルーンヘルプを付ける (ルール7)", () => {
    const html = screeningPage({
      direction: "long",
      rows: [screeningRow("7203")],
      totalCount: 1,
    });
    expect(html).toContain('class="tip"');
    expect(html).toContain("値上がりを狙う買い方");
  });
});

describe("signalsPage の件数表示 (F-07 同型)", () => {
  it("途切れありでは先頭件数と全件を明記する", () => {
    const html = signalsPage({
      pattern: "all",
      rows: [signalRow("7203")],
      totalCount: 3,
    });
    expect(html).toContain("先頭1件を表示（全3件）");
  });

  it("途切れなしでは注記を出さない", () => {
    const html = signalsPage({
      pattern: "all",
      rows: [signalRow("7203")],
      totalCount: 1,
    });
    expect(html).not.toContain("先頭");
  });
});
