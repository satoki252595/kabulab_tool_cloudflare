import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { installScheduledDeadline, nativeJobExecutionWindow, scheduledAtForDate, scheduledExecutionWindow } from "./scheduled-admission.js";
import { scheduledStockSyncWindow, assertStockSyncSource, stockSyncExecutionWindow } from "./stock-sync-window.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("同日でも未来の予定は拒否し、遅配・同時刻だけを受ける", () => {
  const scheduled = "2026-10-23T09:00:52.000Z", at = Date.parse(scheduled);
  for (const now of [at, at + 19 * 60_000]) expect(scheduledAtForDate(scheduled, "2026-10-23", now)).toBe(at);
  for (const now of [at - 1, NaN, Infinity]) expect(() => scheduledAtForDate(scheduled, "2026-10-23", now)).toThrow();
  expect(() => scheduledAtForDate(scheduled, "2026-10-22", at)).toThrow("一致");
});

it("株式は原本全量の閉鎖30分と後続原本保存枠600秒をnative360分の前へ予約する", () => {
  const window = scheduledStockSyncWindow("2026-10-23");
  expect(window.deadline - window.sourceDeadline).toBe(30 * 60_000);
  expect(() => assertStockSyncSource("2026-10-23", window.sourceDeadline - 1, true)).not.toThrow();
  expect(() => assertStockSyncSource("2026-10-23", window.sourceDeadline, true)).toThrow("新規取得期限");
  expect(window.deadline + 600_000).toBeLessThan(window.start + 360 * 60_000);
  const workflow = readFileSync(".github/workflows/stock-sync.yml", "utf8");
  expect(workflow).toContain("timeout-minutes: 360");
  expect(workflow).toContain("uses: ./.github/actions/record-job-clock");
});

it.each([false, true])("手動/定時(%s)も実job時計からsource/閉鎖/sector600秒/終了5分をnative360分に収める", (scheduled) => {
  const start = Date.parse(`2026-10-23T${scheduled ? "09:00" : "06:30"}:00.000Z`);
  const window = stockSyncExecutionWindow("2026-10-23", scheduled, start + 60_000, new Date(start).toISOString());
  expect(window.deadline - window.sourceDeadline).toBe(30 * 60_000);
  expect(window.deadline + 600_000 + 5 * 60_000).toBeLessThanOrEqual(start + 360 * 60_000);
  if (scheduled) expect(window.deadline).toBe(scheduledStockSyncWindow("2026-10-23").deadline);
  else expect(window.deadline).toBe(start + 345 * 60_000);
});

it.each([0, 19, 60, 300])("VWAPは%d分遅れでも固定23:30・job native360分より先に閉鎖する", (delay) => {
  const slot = Date.parse("2026-10-23T08:00:00.000Z"), start = slot + delay * 60_000;
  const fixed = Date.parse("2026-10-23T14:30:00.000Z");
  const window = scheduledExecutionWindow(fixed, start + 60_000, new Date(start).toISOString(), 360, 10);
  expect(window.sourceDeadline).toBe(window.deadline - 10 * 60_000);
  expect(window.deadline).toBeLessThanOrEqual(fixed);
  expect(window.deadline).toBeLessThanOrEqual(start + 355 * 60_000);
  const workflow = readFileSync(".github/workflows/vwap-ingest.yml", "utf8");
  expect(workflow.match(/timeout-minutes: 360/g)).toHaveLength(2);
  expect(workflow.match(/uses: \.\/\.github\/actions\/record-job-clock/g)).toHaveLength(2);
});

it("SSHの同CLIは外部killが無いため固定期限を使い、誤ったjob時計は補完しない", () => {
  const deadline = Date.parse("2026-10-23T14:30:00.000Z"), now = deadline - 60_000;
  expect(scheduledExecutionWindow(deadline, now, undefined, 360, 10).deadline).toBe(deadline);
  for (const started of ["", "invalid", new Date(now + 1).toISOString()]) {
    expect(() => scheduledExecutionWindow(deadline, now, started, 360, 10)).toThrow();
  }
});

it("同job末尾の月次にも元jobの残時間だけを渡し、CLI開始時計へ更新しない", () => {
  const start = "2026-10-23T06:30:00.000Z", at = Date.parse(start);
  expect(nativeJobExecutionWindow(at + 340 * 60_000, start, 360, 10)).toEqual({
    sourceDeadline: at + 345 * 60_000, deadline: at + 355 * 60_000,
  });
  expect(nativeJobExecutionWindow(at + 356 * 60_000, start, 360, 10)?.deadline).toBe(at + 355 * 60_000);
  expect(nativeJobExecutionWindow(at, undefined, 360, 10)).toBeUndefined();
  for (const value of ["", "invalid", new Date(at + 1).toISOString()]) {
    expect(() => nativeJobExecutionWindow(at, value, 360, 10)).toThrow();
  }
});

it("閉鎖期限でHTTPを中断し、元signalを維持して次POSTを送らない", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = Date.now(), original = new AbortController();
  const native = vi.fn<typeof fetch>(async () => new Response("known")); vi.stubGlobal("fetch", native);
  const restore = installScheduledDeadline(now + 1000);
  try {
    await fetch("https://example.invalid", { signal: original.signal });
    original.abort(); expect(native.mock.calls[0][1]?.signal?.aborted).toBe(true);
    vi.setSystemTime(now + 1000);
    expect(() => fetch("https://example.invalid", { method: "POST" })).toThrow("閉鎖期限");
    expect(native).toHaveBeenCalledTimes(1);
  } finally { restore(); }
  expect(globalThis.fetch).toBe(native);
});
