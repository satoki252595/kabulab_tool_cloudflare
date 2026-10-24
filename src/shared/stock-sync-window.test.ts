import { afterEach, describe, expect, it, vi } from "vitest";
import { assertStockSyncDeadline, assertStockSyncStart, installStockSyncDeadline, scheduledStockSyncWindow, stockSyncExecutionWindow, stockSyncRunDate } from "./stock-sync-window.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("通常株式UTC対象日と実clockの窓", () => {
  it("JST翌未開場でもUTC対象日を変えず、正常runと保存原本に同じ窓を適用する", () => {
    // 実8303原本capture/V6読取clockと、JST日跨ぎの機構境界。
    for (const instant of ["2026-10-14T10:15:47.400Z", "2026-10-14T14:52:16.588Z", "2026-10-14T15:00:00.000Z", "2026-10-14T20:59:59.999Z"]) {
      const at = Date.parse(instant);
      expect(stockSyncRunDate(at)).toBe("2026-10-14");
      expect(() => assertStockSyncStart(at)).not.toThrow();
      expect(() => assertStockSyncDeadline("2026-10-14", at)).not.toThrow();
    }
    expect(stockSyncRunDate(Date.parse("2026-10-15T00:00:00Z"))).toBe("2026-10-15");
  });

  it("元の06:30開始と21:00書込期限の境界・例外文を保持する", () => {
    expect(() => assertStockSyncStart(Date.parse("2026-10-14T06:29:59.999Z"))).toThrow("東証15:30 JST終了後");
    expect(() => assertStockSyncStart(Date.parse("2026-10-14T06:30:00.000Z"))).not.toThrow();
    expect(() => assertStockSyncStart(Date.parse("2026-10-14T21:00:00.000Z"))).toThrow("翌06:00 JST基準");
    expect(() => assertStockSyncDeadline("2026-10-14", Date.parse("2026-10-14T21:00:00.000Z"))).toThrow("21:00 UTC期限");
  });
  it("定時だけ18〜20時に受付し、210分を残した23:30で新規保存を止める", () => {
    const date = "2026-10-14", window = scheduledStockSyncWindow(date);
    expect(window.deadline - window.latestStart).toBe(210 * 60_000);
    for (const now of [window.start, window.latestStart]) expect(() => assertStockSyncStart(now, date)).not.toThrow();
    for (const now of [window.start - 1, window.latestStart + 1, NaN]) expect(() => assertStockSyncStart(now, date)).toThrow();
    expect(() => assertStockSyncDeadline(date, window.deadline - 1, true)).not.toThrow();
    expect(() => assertStockSyncDeadline(date, window.deadline, true)).toThrow("23:30");
    for (const date of ["2026-02-30", "2026-10-17", ""]) expect(() => scheduledStockSyncWindow(date)).toThrow();
  });
  it("実期限直前のHTTPは元signalを保持し、期限端では次の取得/保存を送らない", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const date = "2026-10-14", deadline = scheduledStockSyncWindow(date).deadline;
    vi.setSystemTime(deadline - 10_000);
    const native = vi.fn<typeof fetch>(async () => new Response("accepted")); vi.stubGlobal("fetch", native);
    const restore = installStockSyncDeadline(date), original = new AbortController();
    try {
      await fetch("https://example.invalid", { signal: original.signal });
      expect(native).toHaveBeenCalledTimes(1);
      original.abort(); expect(native.mock.calls[0][1]?.signal?.aborted).toBe(true);
      vi.setSystemTime(deadline);
      expect(() => fetch("https://example.invalid", { method: "POST" })).toThrow("23:30");
      expect(native).toHaveBeenCalledTimes(1);
    } finally { restore(); }
    expect(globalThis.fetch).toBe(native);
  });
  it("手動Actionsもnative閉鎖の端で次HTTP0、SSHの旧絶対窓は維持する", async () => {
    const date = "2026-10-14", jobStartedAt = `${date}T06:30:00.000Z`;
    const { deadline } = stockSyncExecutionWindow(date, false, Date.parse(jobStartedAt), jobStartedAt);
    expect(stockSyncExecutionWindow(date, false, deadline).deadline).toBe(Date.parse(`${date}T21:00:00.000Z`));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(deadline - 1000);
    const native = vi.fn<typeof fetch>(async () => new Response("known")); vi.stubGlobal("fetch", native);
    const restore = installStockSyncDeadline(date, { scheduled: false, jobStartedAt });
    try {
      await fetch("https://example.invalid");
      vi.setSystemTime(deadline);
      expect(() => fetch("https://example.invalid", { method: "POST" })).toThrow("jobの原本閉鎖期限");
      expect(native).toHaveBeenCalledTimes(1);
    } finally { restore(); }
  });
});
