import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { handleTimedScheduled, isTimedCron, timedDispatchPlan, TIMED_WORKFLOWS } from "./timed.js";
import { type SchedulerBucket } from "./stock.js";

const start = Date.parse("2026-10-23T00:00:00Z");
const cron = "0 0-10 * * MON-FRI";
const controller = { cron, scheduledTime: start + 52_000 };
const dispatch = { workflow_run_id: 101,
  run_url: "https://api.github.com/repos/satoki252595/kabulab_tool_cloudflare/actions/runs/101",
  html_url: "https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/101" };

function bucket() {
  const data = new Map<string, string>();
  const store: SchedulerBucket = {
    async get(key) { const value = data.get(key); return value === undefined ? null : { async text() { return value; } }; },
    async put(key, value, options) {
      if (options?.onlyIf instanceof Headers && data.has(key)) return null;
      data.set(key, value); return { etag: "etag" };
    },
  };
  return { data, store };
}

afterEach(() => { vi.useRealTimers(); });
describe("公表取得のCF起動は予定slot保持・one-shot", () => {
  it("4系統のcron設定・workflow入力を実ファイルと一致させる", () => {
    const toml = readFileSync("wrangler.toml", "utf8");
    for (const profile of TIMED_WORKFLOWS) {
      expect(isTimedCron(profile.cron)).toBe(true);
      expect(toml).toContain(`"${profile.cron}"`);
      const workflow = readFileSync(`.github/workflows/${profile.workflow}`, "utf8");
      expect(workflow).toContain(profile.name === "margin" ? "scheduled-margin" : "scheduled_at:");
      const ms = start + profile.hours[0] * 3_600_000 + profile.minute * 60_000;
      const plan = timedDispatchPlan({ cron: profile.cron, scheduledTime: ms }, ms);
      expect(plan.scheduledAt).toBe(new Date(ms).toISOString().replace(".000Z", "Z"));
      expect(plan.inputs).toEqual(profile.name === "margin"
        ? { target: "scheduled-margin", scheduled_date: "2026-10-23" }
        : { scheduled_at: plan.scheduledAt });
    }
    expect(isTimedCron("0 9 * * MON-FRI")).toBe(false);
  });
  it("秒は切り捨てるが5分受付を52秒延長せず、未来・土日・slot違いをclaim前に停止", async () => {
    expect(timedDispatchPlan(controller, start + 300_000).scheduledAt).toBe("2026-10-23T00:00:00Z");
    const { store, data } = bucket(), fetchFn = vi.fn<typeof fetch>();
    for (const [c, now] of [
      [controller, start + 300_001], [controller, start],
      [{ cron, scheduledTime: start + 60_000 }, start + 60_000],
      [{ cron, scheduledTime: start + 11 * 3_600_000 }, start + 11 * 3_600_000],
      [{ cron, scheduledTime: start + 86_400_000 }, start + 86_400_000],
      [{ cron: "unknown", scheduledTime: start }, start],
    ] as const) {
      await expect(handleTimedScheduled(c, { BUCKET: store, GITHUB_ACTIONS_TOKEN: "test-token" }, { nowMs: now, fetchFn })).rejects.toThrow();
    }
    expect(data.size).toBe(0); expect(fetchFn).not.toHaveBeenCalled();
  });
  it("同slotのduplicateはPOST0、次時刻slotは別receiptで各1回", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(start + 52_000);
    const { store, data } = bucket();
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(dispatch), { status: 200 }));
    const env = { BUCKET: store, GITHUB_ACTIONS_TOKEN: "test-token" };
    expect(await handleTimedScheduled(controller, env, { fetchFn })).toEqual({ status: "dispatched", workflowRunId: 101 });
    expect(await handleTimedScheduled(controller, env, { fetchFn })).toEqual({ status: "duplicate", workflowRunId: 101 });
    vi.setSystemTime(start + 3_600_000);
    await handleTimedScheduled({ cron, scheduledTime: Date.now() }, env, { fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(2); expect(data.size).toBe(2);
    expect(JSON.parse(String(fetchFn.mock.calls[0][1]?.body))).toEqual({ ref: "main", inputs: { scheduled_at: "2026-10-23T00:00:00Z" } });
    expect(fetchFn.mock.calls[0][0]).toContain("tdnet_hourly.yml/dispatches");
  });
  it("claimed/unknownは再送せず、別時間receiptのコピーも拒否する", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(start + 52_000);
    const { store, data } = bucket(), env = { BUCKET: store, GITHUB_ACTIONS_TOKEN: "test-token" };
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new Error("transport unknown"));
    await expect(handleTimedScheduled(controller, env, { fetchFn })).rejects.toThrow("unknown");
    await expect(handleTimedScheduled(controller, env, { fetchFn })).rejects.toThrow("未完了");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const key = timedDispatchPlan(controller, Date.now()).key;
    const receipt = JSON.parse(data.get(key)!);
    data.set(key, JSON.stringify({ ...receipt, status: "dispatched", scheduledAt: "2026-10-23T01:00:00Z",
      dispatchedAt: new Date().toISOString(), workflowRunId: 101, runUrl: dispatch.run_url, htmlUrl: dispatch.html_url }));
    await expect(handleTimedScheduled(controller, env, { fetchFn })).rejects.toThrow("予定slot");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
