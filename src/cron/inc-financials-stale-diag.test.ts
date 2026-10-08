/**
 * INC-20261008-kabulab_tool_cloudflare-financials-stale 計測ヘルパのテスト。
 * diagnoseConfirmedCloses は selectConfirmedCloses の HOLD 理由区分だけを返し、
 * 決して throw しないこと、ログ行に ID タグが付くことを固定する。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseChartResponse } from "../shared/yahoo/client.js";
import { guardChartBars } from "../shared/yahoo/bar-sanity.js";
import type { DailyOhlcv } from "../shared/types.js";
import { diagnoseConfirmedCloses, selectConfirmedCloses } from "./macro-session.js";
import {
  INC_FINANCIALS_STALE_TAG,
  formatConfirmedHoldDiag,
  formatStockSessionDiag,
} from "./inc-financials-stale-diag.js";

const FX = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__/macro-canonical");
const fxBytes = (name: string): Uint8Array => readFileSync(join(FX, name));

function prodBars(symbol: string, raw: Uint8Array): DailyOhlcv[] {
  const json = JSON.parse(new TextDecoder().decode(raw));
  const parsed = parseChartResponse(json, symbol);
  const { bars } = guardChartBars(parsed.bars, parsed.meta.regularMarketPrice, symbol);
  return [...bars];
}

interface MinBar { ts: number; close: number | null }
const T29 = 1_790_640_000;
const T30 = 1_790_726_400;

function minRaw(bars: MinBar[], rmt = 1_790_732_425): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    chart: {
      result: [{
        meta: {
          symbol: "^N225",
          dataGranularity: "1d",
          exchangeTimezoneName: "Asia/Tokyo",
          regularMarketTime: rmt,
          currentTradingPeriod: { regular: { start: 1_790_726_400, end: 1_790_749_800 } },
        },
        timestamp: bars.map((b) => b.ts),
        indicators: { quote: [{ close: bars.map((b) => b.close) }] },
      }],
      error: null,
    },
  }));
}

function minBars(bars: MinBar[]): DailyOhlcv[] {
  return bars.map((b) => ({
    date: new Date(b.ts * 1000).toISOString().split("T")[0],
    open: null, high: null, low: null, close: b.close, volume: null, adj: null,
  }));
}

describe("diagnoseConfirmedCloses", () => {
  it("actual 旧 N225 (9/28 候補 close NULL) は null 区分 (selectConfirmedCloses は HOLD)", () => {
    const raw = fxBytes("n225-20260929.json");
    const bars = prodBars("^N225", raw);
    expect(() => selectConfirmedCloses(raw, bars, "^N225")).toThrow(/実終値を証明できない/);
    const d = diagnoseConfirmedCloses(raw, bars, "^N225");
    expect(d.reason).toBe("null");
    expect(d.candidateDate).toBe("2026-09-28");
  });

  it("actual 正常 N225 は ok で selectConfirmedCloses と同じ日付", () => {
    const raw = fxBytes("n225-20260930.json");
    const bars = prodBars("^N225", raw);
    const d = diagnoseConfirmedCloses(raw, bars, "^N225");
    expect(d.reason).toBe("ok");
    expect(d.candidateDate).toBe(selectConfirmedCloses(raw, bars, "^N225").date);
  });

  it.each([
    ["non_positive", [{ ts: T29, close: 0 }, { ts: T30, close: 101 }], undefined],
    ["removed", [{ ts: T29, close: 100 }, { ts: T30, close: 101 }], minBars([{ ts: T30, close: 101 }])],
    ["mismatch", [{ ts: T29, close: 100 }, { ts: T30, close: 101 }],
      minBars([{ ts: T29, close: 999 }, { ts: T30, close: 101 }])],
    ["no_candidate", [{ ts: T30, close: 101 }], undefined],
  ] as const)("%s 区分", (reason, rawBars, guardBars) => {
    const raw = minRaw([...rawBars]);
    const bars = guardBars ?? minBars([...rawBars]);
    expect(diagnoseConfirmedCloses(raw, bars, "^N225").reason).toBe(reason);
  });

  it("guard 側の候補日重複は duplicate 区分", () => {
    const rawBars = [{ ts: T29, close: 100 }, { ts: T30, close: 101 }];
    const one = minBars([rawBars[0]])[0];
    const bars = [one, { ...one }, ...minBars([rawBars[1]])];
    expect(diagnoseConfirmedCloses(minRaw(rawBars), bars, "^N225").reason).toBe("duplicate");
  });

  it("原文破損でも throw せず other", () => {
    const d = diagnoseConfirmedCloses(new TextEncoder().encode("{broken"), [], "^N225");
    expect(d).toEqual({ reason: "other", candidateDate: null, sessionDate: null, ended: null });
  });
});

describe("format*Diag", () => {
  it("株式 session 行は ID タグ付きで最新・1本前の日付と null 有無を出す", () => {
    const line = formatStockSessionDiag(
      [
        { date: "2026-10-06", close: 70683.98, adj: 70683.98 },
        { date: "2026-10-07", close: null, adj: null },
      ],
      "2026-10-07T17:14:19.000Z",
      "2026-10-07"
    );
    expect(line.startsWith(`${INC_FINANCIALS_STALE_TAG} stocks-session `)).toBe(true);
    expect(JSON.parse(line.slice(line.indexOf("{")))).toEqual({
      targetDate: "2026-10-07",
      receivedAt: "2026-10-07T17:14:19.000Z",
      latestBarDate: "2026-10-07",
      latestCloseNull: true,
      latestAdjNull: true,
      prevBarDate: "2026-10-06",
    });
  });

  it("空の ohlcv でも throw しない", () => {
    const line = formatStockSessionDiag([], undefined, "2026-10-07");
    expect(JSON.parse(line.slice(line.indexOf("{")))).toMatchObject({
      latestBarDate: null, latestCloseNull: null, prevBarDate: null, receivedAt: null,
    });
  });

  it("HOLD 理由行は ID タグ付き", () => {
    const line = formatConfirmedHoldDiag("macro", "^N225", undefined,
      { reason: "null", candidateDate: "2026-10-07", sessionDate: "2026-10-08", ended: false });
    expect(line).toBe(`${INC_FINANCIALS_STALE_TAG} macro {"symbol":"^N225","receivedAt":null,"reason":"null",` +
      `"candidateDate":"2026-10-07","sessionDate":"2026-10-08","ended":false}`);
  });
});
