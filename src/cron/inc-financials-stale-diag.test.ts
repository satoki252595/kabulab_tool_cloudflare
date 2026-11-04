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
  formatMacroGateHoldLines,
  formatMissingJpLegHoldLine,
  formatStockSessionDiag,
  macroHoldReasonCode,
  readChartSessionClock,
  type MacroGateHoldLogInput,
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

const SESSION_START = 1_790_726_400;
const SESSION_END = 1_790_749_800;

function sessionRaw(rmt: number, extra: Record<string, unknown> = {}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    chart: {
      result: [{
        meta: {
          exchangeTimezoneName: "Asia/Tokyo",
          regularMarketTime: rmt,
          currentTradingPeriod: { regular: { start: SESSION_START, end: SESSION_END } },
          ...extra,
        },
      }],
    },
  }));
}

function holdInput(overrides: Partial<MacroGateHoldLogInput> = {}): MacroGateHoldLogInput {
  return {
    reason: "VIX 確定日 2026-10-30 ≠ GSPC 2026-11-02 (混ぜない)",
    charts: {
      "^N225": { date: "2026-11-02" },
      "^VIX": { date: "2026-10-30" },
      "^GSPC": { date: "2026-11-02" },
      "NIY=F": { date: "2026-11-02" },
    },
    nikkeiViDate: "2026-11-02",
    attempts: [],
    jpN225ReceivedAt: null,
    jpViReceivedAt: null,
    ...overrides,
  };
}

describe("macro gate HOLD diag", () => {
  it("gate の日本語 reason をコードへ写し、未知の文は null", () => {
    expect(macroHoldReasonCode("VIX 確定日 2026-10-30 ≠ GSPC 2026-11-02 (混ぜない)")).toBe("vix_date_ne_gspc");
    expect(macroHoldReasonCode("N225 確定日 2026-09-25 ≠ GSPC 2026-09-29 (混ぜない)")).toBe("n225_date_ne_gspc");
    expect(macroHoldReasonCode("VI 日付 2026-09-30 ≠ GSPC 2026-09-29 (混ぜない)")).toBe("vi_date_ne_gspc");
    expect(macroHoldReasonCode("GSPC 確定日 2026-11-02 ≠ 予定日 2026-11-03 (過去日を代用しない)")).toBe("gspc_date_ne_expected");
    expect(macroHoldReasonCode("GSPC 確定日が無い (取得失敗または session 不足)")).toBe("gspc_date_missing");
    expect(macroHoldReasonCode("N225 確定日が無い (取得失敗または session 不足)")).toBe("n225_date_missing");
    expect(macroHoldReasonCode("VIX 確定日が無い (取得失敗または session 不足)")).toBe("vix_date_missing");
    expect(macroHoldReasonCode("VI 日付が無い (取得失敗または session 不足)")).toBe("vi_date_missing");
    expect(macroHoldReasonCode("JPX 休場日 (休日) は書かない")).toBe("jpx_closed");
    expect(macroHoldReasonCode("NIY snapshotが無い (部分行を書かない)")).toBe("niy_price_missing");
    expect(macroHoldReasonCode("VI 価格が無い (部分行を書かない)")).toBe("vi_price_missing");
    expect(macroHoldReasonCode("想定外の文")).toBeNull();
  });

  it("rmt が regularEnd 未満なら ended=false、同値以上なら true。JST で出す", () => {
    expect(readChartSessionClock(sessionRaw(1_790_732_425))).toEqual({
      exchangeSessionDate: "2026-09-30",
      regularStart: "2026-09-30T09:00:00+09:00",
      regularEnd: "2026-09-30T15:30:00+09:00",
      regularEndSec: SESSION_END,
      regularMarketTime: "2026-09-30T10:40:25+09:00",
      regularMarketTimeSec: 1_790_732_425,
      ended: false,
    });
    expect(readChartSessionClock(sessionRaw(SESSION_END)).ended).toBe(true);
    expect(readChartSessionClock(sessionRaw(SESSION_END)).regularMarketTime).toBe("2026-09-30T15:30:00+09:00");
  });

  it("原文が壊れていても null で戻り、crumb や URL は行に出さない", () => {
    expect(readChartSessionClock(null)).toEqual({
      exchangeSessionDate: null,
      regularStart: null,
      regularEnd: null,
      regularEndSec: null,
      regularMarketTime: null,
      regularMarketTimeSec: null,
      ended: null,
    });
    expect(readChartSessionClock(new TextEncoder().encode("{broken"))).toMatchObject({ ended: null, regularEnd: null });
    const lines = formatMacroGateHoldLines(holdInput({
      attempts: [{
        target: "^VIX",
        attempt: 0,
        requestedAt: "2026-11-02T21:00:00.000Z",
        completedAt: "2026-11-02T21:00:01.000Z",
        receivedAt: "2026-11-02T21:00:01.000Z",
        bytes: sessionRaw(1_790_732_425, {
          crumb: "secret-crumb",
          url: "https://query.example/v8/finance/chart/^VIX?crumb=secret-crumb&cookie=abc",
        }),
      }],
    }));
    expect(lines).toHaveLength(5);
    expect(lines.map((line) => line.startsWith(`${INC_FINANCIALS_STALE_TAG} macro-hold `)).every(Boolean)).toBe(true);
    const joined = lines.join("\n");
    expect(joined).not.toMatch(/crumb|cookie|https?:|secret/i);
    const vix = JSON.parse(lines[1].slice(lines[1].indexOf("{"))) as Record<string, unknown>;
    expect(vix).toMatchObject({
      symbol: "^VIX",
      sessionDate: "2026-10-30",
      exchangeSessionDate: "2026-09-30",
      regularEnd: "2026-09-30T15:30:00+09:00",
      regularMarketTimeSec: 1_790_732_425,
      ended: false,
      receivedAt: "2026-11-02T21:00:01.000Z",
      reason: "vix_date_ne_gspc",
    });
    const n225 = JSON.parse(lines[0].slice(lines[0].indexOf("{"))) as Record<string, unknown>;
    expect(n225).toMatchObject({
      symbol: "^N225",
      sessionDate: "2026-11-02",
      regularEnd: null,
      ended: null,
      receivedAt: null,
      reason: "vix_date_ne_gspc",
    });
  });

  it("bytes の無い後続 attempt より、本文のある attempt の時計を使う", () => {
    const lines = formatMacroGateHoldLines(holdInput({
      attempts: [
        {
          target: "^GSPC",
          attempt: 0,
          requestedAt: "2026-11-02T21:00:00.000Z",
          completedAt: "2026-11-02T21:00:01.000Z",
          receivedAt: "2026-11-02T21:00:01.000Z",
          bytes: sessionRaw(SESSION_END),
        },
        {
          target: "^GSPC",
          attempt: 1,
          requestedAt: "2026-11-02T21:00:02.000Z",
          completedAt: "2026-11-02T21:00:03.000Z",
          receivedAt: null,
          bytes: null,
        },
      ],
    }));
    const gspc = JSON.parse(lines[2].slice(lines[2].indexOf("{"))) as Record<string, unknown>;
    expect(gspc).toMatchObject({
      ended: true,
      attempt: 0,
      receivedAt: "2026-11-02T21:00:01.000Z",
      regularMarketTimeSec: SESSION_END,
    });
  });

  it("JP leg の取得時刻は chart attempt が無い記号にだけ付ける", () => {
    const lines = formatMacroGateHoldLines(holdInput({
      jpN225ReceivedAt: "2026-11-02T06:30:00.000Z",
      jpViReceivedAt: "2026-11-02T06:31:00.000Z",
    }));
    const n225 = JSON.parse(lines[0].slice(lines[0].indexOf("{"))) as Record<string, unknown>;
    const vix = JSON.parse(lines[1].slice(lines[1].indexOf("{"))) as Record<string, unknown>;
    const vi = JSON.parse(lines[4].slice(lines[4].indexOf("{"))) as Record<string, unknown>;
    expect(n225.receivedAt).toBe("2026-11-02T06:30:00.000Z");
    expect(vix.receivedAt).toBeNull();
    expect(vi).toMatchObject({
      symbol: "NIKKEI_VI",
      sessionDate: "2026-11-02",
      ended: null,
      regularEnd: null,
      receivedAt: "2026-11-02T06:31:00.000Z",
    });
  });

  it("JP leg 欠落行は ID と理由コードだけ", () => {
    expect(formatMissingJpLegHoldLine("2026-11-03")).toBe(
      `${INC_FINANCIALS_STALE_TAG} jp-leg-missing ${JSON.stringify({
        reason: "missing_jp_leg",
        expectedDate: "2026-11-03",
      })}`
    );
    expect(formatMissingJpLegHoldLine("not-a-date")).toContain('"expectedDate":null');
  });
});
