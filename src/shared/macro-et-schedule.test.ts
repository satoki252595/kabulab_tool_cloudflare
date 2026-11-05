/**
 * INC-20261008-kabulab_tool_cloudflare-financials-stale
 *
 * 定時マクロの固定 UTC（開始 21:00、受付 +30分、取得 +50分、保存 +60分、
 * readcheck +65分）は夏時間の米東 17:00 とだけ一致する。冬時間の ^VIX
 * regular end 16:15 ET は 21:15 UTC で、21:00 UTC 開始より後になる。
 *
 * 承認した式: L = 16:15 America/New_York + 45分 = 17:00 ET。
 * 相対は L+30 / L+50 / L+60 / L+65。早期終了（Yahoo regular.end 13:00 ET）でも
 * L は 13:45 に進めない。13:45 は立会中拒否（9:30–16:00 ET）の内側で、
 * cron は夏 21:00 UTC と冬 22:00 UTC の2本だけ。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { diagnoseConfirmedCloses } from "../cron/macro-session.js";
import type { DailyOhlcv } from "./types.js";
import { scheduledMacroWindow } from "./scheduled-admission.js";
import * as scheduler from "../scheduler/stock.js";
import type { RunJob, SchedulerBucket } from "../scheduler/stock.js";

const SUMMER_DISPATCH = "0 21 * * MON-FRI";
const WINTER_DISPATCH = "0 22 * * MON-FRI";
const SUMMER_READCHECK = "5 22 * * MON-FRI";
const WINTER_READCHECK = "5 23 * * MON-FRI";
const TOKEN = "test-token";

function at(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`テスト時刻が不正です: ${iso}`);
  return ms;
}

function contextJobs(completed: string): RunJob[] {
  return [{
    name: "sync", run_id: 101, status: "completed", conclusion: "success",
    steps: [
      { name: "stock daily sync", status: "completed", conclusion: "skipped", completed_at: null },
      { name: "market context sync", status: "completed", conclusion: "success", completed_at: completed },
    ],
  }, { name: "moneyflow", run_id: 101, status: "completed", conclusion: "skipped" }];
}

function vixClock(args: {
  startIso: string;
  endIso: string;
  rmtIso: string;
  points: Array<{ iso: string; close: number }>;
}): { raw: Uint8Array; bars: DailyOhlcv[] } {
  const sec = (iso: string) => Math.floor(at(iso) / 1000);
  const raw = new TextEncoder().encode(JSON.stringify({
    chart: { result: [{
      meta: {
        symbol: "^VIX",
        dataGranularity: "1d",
        exchangeTimezoneName: "America/New_York",
        regularMarketTime: sec(args.rmtIso),
        currentTradingPeriod: { regular: { start: sec(args.startIso), end: sec(args.endIso) } },
      },
      timestamp: args.points.map((point) => sec(point.iso)),
      indicators: { quote: [{ close: args.points.map((point) => point.close) }] },
    }] },
  }));
  const bars = args.points.map((point) => ({
    date: new Date(at(point.iso)).toISOString().slice(0, 10),
    open: point.close, high: point.close, low: point.close, close: point.close, volume: 1,
  }));
  return { raw, bars };
}

async function fire(cron: string, iso: string) {
  const puts: string[] = [];
  const store = new Map<string, string>();
  const bucket: SchedulerBucket = {
    async get(key) {
      const body = store.get(key);
      return body === undefined ? null : { async text() { return body; } };
    },
    async put(key, value) {
      puts.push(key);
      store.set(key, value);
      return { etag: "etag" };
    },
  };
  const calls: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({
      workflow_run_id: 101,
      run_url: "https://api.github.com/repos/satoki252595/kabulab_tool_cloudflare/actions/runs/101",
      html_url: "https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/101",
    }), { status: 200 });
  };
  const scheduledTime = at(iso);
  const logs: string[] = [];
  const spy = vi.spyOn(console, "info").mockImplementation((message?: unknown) => {
    logs.push(String(message));
  });
  try {
    const result = await scheduler.handleStockScheduled(
      { cron, scheduledTime },
      { BUCKET: bucket, GITHUB_ACTIONS_TOKEN: TOKEN },
      { fetchFn, nowMs: scheduledTime + 30_000 },
    );
    return { result, puts, calls, logs };
  } finally {
    spy.mockRestore();
  }
}

function expectWindow(date: string, startIso: string) {
  const start = at(startIso);
  const window = scheduledMacroWindow(date);
  expect(window.start, `${date} L`).toBe(start);
  expect(window.latestStart, `${date} admission end`).toBe(start + 30 * 60_000);
  expect(window.sourceDeadline, `${date} fetch deadline`).toBe(start + 50 * 60_000);
  expect(window.deadline, `${date} save deadline`).toBe(start + 60 * 60_000);
  expect(window.readcheck, `${date} readcheck`).toBe(start + 65 * 60_000);
  expect(window.dateSwitch, `${date} ops date switch`).toBe(window.deadline);
}

describe("夏の平日（2026-07-15 EDT）", () => {
  it("L は 17:00 EDT = 21:00 UTC で、相対オフセットは固定", () => {
    expectWindow("2026-07-15", "2026-07-15T21:00:00.000Z");
  });

  it("冬の dispatch / readcheck は失敗にせずログして戻る", async () => {
    for (const [cron, iso] of [
      [WINTER_DISPATCH, "2026-07-15T22:00:00.000Z"],
      [WINTER_READCHECK, "2026-07-15T23:05:00.000Z"],
    ] as const) {
      const out = await fire(cron, iso);
      expect(out.result).toMatchObject({ status: "macro_cron_skipped", scheduledDate: "2026-07-15", cron });
      expect(out.puts, cron).toEqual([]);
      expect(out.calls, cron).toEqual([]);
      expect(out.logs.join("\n"), cron).toContain("macro cron skipped");
      expect(out.logs.join("\n"), cron).not.toContain(TOKEN);
    }
  });

  it("夏の cron は従来どおり受付する", async () => {
    const out = await fire(SUMMER_DISPATCH, "2026-07-15T21:00:52.000Z");
    expect(out.result).toMatchObject({ status: "dispatched", workflowRunId: 101 });
    expect(out.calls).toHaveLength(1);
    await expect(fire(SUMMER_READCHECK, "2026-07-15T22:05:52.000Z")).rejects.toThrow("receipt");
    expect(scheduler.evaluateContextReadcheck(contextJobs("2026-07-15T21:02:00.000Z"), "2026-07-15"))
      .toEqual({ contextCompletedAt: "2026-07-15T21:02:00.000Z" });
  });

  it("wrangler は夏冬の両方を登録する", () => {
    const toml = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8");
    for (const cron of [SUMMER_DISPATCH, WINTER_DISPATCH, SUMMER_READCHECK, WINTER_READCHECK]) {
      expect(toml, cron).toContain(`"${cron}"`);
    }
    expect(scheduler.CONTEXT_DISPATCH_CRON).toBe(SUMMER_DISPATCH);
    expect(scheduler.CONTEXT_READCHECK_CRON).toBe(SUMMER_READCHECK);
    expect(scheduler.CONTEXT_DISPATCH_CRON_WINTER).toBe(WINTER_DISPATCH);
    expect(scheduler.CONTEXT_READCHECK_CRON_WINTER).toBe(WINTER_READCHECK);
  });
});

describe("冬の平日（2026-11-04 EST）", () => {
  it("21:00 UTC は 16:00 EST で VIX 16:15 より前。L は 22:00 UTC", () => {
    const open = vixClock({
      startIso: "2026-11-04T14:30:00.000Z",
      endIso: "2026-11-04T21:15:00.000Z",
      rmtIso: "2026-11-04T21:00:00.000Z",
      points: [
        { iso: "2026-11-02T14:30:00.000Z", close: 18 },
        { iso: "2026-11-04T14:30:00.000Z", close: 19 },
      ],
    });
    expect(diagnoseConfirmedCloses(open.raw, open.bars, "^VIX").ended).toBe(false);
    expectWindow("2026-11-04", "2026-11-04T22:00:00.000Z");
    expect(at("2026-11-04T22:00:00.000Z") - at("2026-11-04T21:15:00.000Z")).toBe(45 * 60_000);
  });

  it("夏 cron は no-op、冬 cron だけが配送され、完了窓は 22:00〜23:00 UTC", async () => {
    const skipped = await fire(SUMMER_DISPATCH, "2026-11-04T21:00:52.000Z");
    expect(skipped.result).toMatchObject({ status: "macro_cron_skipped", cron: SUMMER_DISPATCH });
    expect(skipped.calls).toEqual([]);
    const dispatched = await fire(WINTER_DISPATCH, "2026-11-04T22:00:52.000Z");
    expect(dispatched.result).toMatchObject({ status: "dispatched", workflowRunId: 101 });
    expect(dispatched.calls).toHaveLength(1);
    expect(() => scheduler.resolveRunDate("context-dispatch", at("2026-11-04T21:00:30.000Z"), at("2026-11-04T21:00:31.000Z")))
      .toThrow("cronの分");
    expect(scheduler.resolveRunDate("context-dispatch", at("2026-11-04T22:00:52.000Z"), at("2026-11-04T22:49:00.000Z")))
      .toBe("2026-11-04");
    expect(() => scheduler.resolveRunDate("context-dispatch", at("2026-11-04T22:00:00.000Z"), at("2026-11-04T22:50:00.000Z")))
      .toThrow("開始期限");
    expect(scheduler.evaluateContextReadcheck(contextJobs("2026-11-04T22:30:00.000Z"), "2026-11-04"))
      .toEqual({ contextCompletedAt: "2026-11-04T22:30:00.000Z" });
    expect(() => scheduler.evaluateContextReadcheck(contextJobs("2026-11-04T21:30:00.000Z"), "2026-11-04"))
      .toThrow("範囲外");
    expect(() => scheduler.evaluateContextReadcheck(contextJobs("2026-11-04T23:00:00.001Z"), "2026-11-04"))
      .toThrow("範囲外");
    await expect(fire(WINTER_READCHECK, "2026-11-04T23:05:52.000Z")).rejects.toThrow("receipt");
    const off = await fire(SUMMER_READCHECK, "2026-11-04T22:05:00.000Z");
    expect(off.result).toMatchObject({ status: "macro_cron_skipped", cron: SUMMER_READCHECK });
    expect(off.calls).toEqual([]);
  });

  it("感謝祭の冬 cron は休場、夏 cron は休場ではなく no-op", async () => {
    const summer = await fire(SUMMER_DISPATCH, "2026-11-26T21:00:00.000Z");
    expect(summer.result).toMatchObject({ status: "macro_cron_skipped" });
    expect(summer.calls).toEqual([]);
    const winter = await fire(WINTER_DISPATCH, "2026-11-26T22:00:00.000Z");
    expect(winter.result).toMatchObject({ status: "market_closed", scheduledDate: "2026-11-26" });
    expect(winter.calls).toEqual([]);
  });
});

describe("DST 切替の前日と翌日", () => {
  it("秋の戻し（11/1）の前は EDT、後は EST。当日の 17:00 も ET で決める", () => {
    expectWindow("2026-11-02", "2026-11-02T22:00:00.000Z");
    expectWindow("2026-11-01", "2026-11-01T22:00:00.000Z");
    expectWindow("2026-10-30", "2026-10-30T21:00:00.000Z");
  });

  it("春の進め（3/8）の前は EST、後は EDT", () => {
    expectWindow("2026-03-06", "2026-03-06T22:00:00.000Z");
    expectWindow("2026-03-08", "2026-03-08T21:00:00.000Z");
    expectWindow("2026-03-09", "2026-03-09T21:00:00.000Z");
  });

  it("切替をまたぐ平日は、その日の ET と一致する cron だけを配送する", async () => {
    const beforeFall = await fire(SUMMER_DISPATCH, "2026-10-30T21:00:00.000Z");
    expect(beforeFall.result).toMatchObject({ status: "dispatched" });
    const beforeFallWinter = await fire(WINTER_DISPATCH, "2026-10-30T22:00:00.000Z");
    expect(beforeFallWinter.result).toMatchObject({ status: "macro_cron_skipped" });
    expect(beforeFallWinter.calls).toEqual([]);

    const afterFallSummer = await fire(SUMMER_DISPATCH, "2026-11-02T21:00:00.000Z");
    expect(afterFallSummer.result).toMatchObject({ status: "macro_cron_skipped" });
    expect(afterFallSummer.calls).toEqual([]);
    const afterFall = await fire(WINTER_DISPATCH, "2026-11-02T22:00:00.000Z");
    expect(afterFall.result).toMatchObject({ status: "dispatched" });

    const beforeSpringSummer = await fire(SUMMER_DISPATCH, "2026-03-06T21:00:00.000Z");
    expect(beforeSpringSummer.result).toMatchObject({ status: "macro_cron_skipped" });
    const beforeSpring = await fire(WINTER_DISPATCH, "2026-03-06T22:00:00.000Z");
    expect(beforeSpring.result).toMatchObject({ status: "dispatched" });

    const afterSpring = await fire(SUMMER_DISPATCH, "2026-03-09T21:00:00.000Z");
    expect(afterSpring.result).toMatchObject({ status: "dispatched" });
    const afterSpringWinter = await fire(WINTER_DISPATCH, "2026-03-09T22:00:00.000Z");
    expect(afterSpringWinter.result).toMatchObject({ status: "macro_cron_skipped" });
    expect(afterSpringWinter.calls).toEqual([]);
  });
});

describe("早期終了日（2026-11-27、Yahoo regular.end 13:00 ET）", () => {
  it("13:00 ET で session は終了しているが、L は 17:00 ET のまま", () => {
    const early = vixClock({
      startIso: "2026-11-27T14:30:00.000Z",
      endIso: "2026-11-27T18:00:00.000Z",
      rmtIso: "2026-11-27T18:00:00.000Z",
      points: [
        { iso: "2026-11-25T14:30:00.000Z", close: 17 },
        { iso: "2026-11-27T14:30:00.000Z", close: 16 },
      ],
    });
    expect(diagnoseConfirmedCloses(early.raw, early.bars, "^VIX").ended).toBe(true);
    expectWindow("2026-11-27", "2026-11-27T22:00:00.000Z");
    expect(at("2026-11-27T22:00:00.000Z") - at("2026-11-27T18:00:00.000Z")).toBe(4 * 60 * 60_000);
    expect(scheduledMacroWindow("2026-11-27").start).not.toBe(at("2026-11-27T18:45:00.000Z"));
  });

  it("早期終了日も冬 cron だけを配送する", async () => {
    const summer = await fire(SUMMER_DISPATCH, "2026-11-27T21:00:00.000Z");
    expect(summer.result).toMatchObject({ status: "macro_cron_skipped" });
    expect(summer.calls).toEqual([]);
    const winter = await fire(WINTER_DISPATCH, "2026-11-27T22:00:00.000Z");
    expect(winter.result).toMatchObject({ status: "dispatched", workflowRunId: 101 });
    expect(winter.calls).toHaveLength(1);
  });
});
