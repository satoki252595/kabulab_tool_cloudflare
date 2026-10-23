import {
  runWorkflowDispatch, schedulerToken,
  type ScheduledControllerLike, type SchedulerEnv,
} from "./stock.js";

/** 公表済み資料の取得。市場休場で提出・公表処理を止めない。時刻はUTC。 */
export const TIMED_WORKFLOWS = [
  { cron: "17 3 * * MON-FRI", name: "supply", workflow: "supply_daily.yml", hours: [3], minute: 17 },
  { cron: "0 0-10 * * MON-FRI", name: "tdnet", workflow: "tdnet_hourly.yml", hours: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], minute: 0 },
  { cron: "0 12 * * MON-FRI", name: "edinet", workflow: "edinet_daily.yml", hours: [12], minute: 0 },
  { cron: "0 8 * * MON-FRI", name: "margin", workflow: "vwap-ingest.yml", hours: [8], minute: 0 },
] as const;

export function isTimedCron(cron: string): boolean {
  return TIMED_WORKFLOWS.some(p => p.cron === cron);
}

/** 秒を含むCF時計を予定分へ正規化。時間別receiptでTDnetの各slotを区別する。 */
export function timedDispatchPlan(controller: ScheduledControllerLike, nowMs: number) {
  const profile = TIMED_WORKFLOWS.find(p => p.cron === controller.cron);
  if (profile === undefined) throw new Error("未知の時刻指定workflowです");
  const plannedMs = Math.floor(controller.scheduledTime / 60_000) * 60_000;
  if (!Number.isFinite(plannedMs) || !Number.isFinite(nowMs) || controller.scheduledTime > nowMs) {
    throw new Error("予定日時/実時計が不正です");
  }
  const planned = new Date(plannedMs);
  if (planned.getUTCDay() === 0 || planned.getUTCDay() === 6 ||
      !(profile.hours as readonly number[]).includes(planned.getUTCHours()) || planned.getUTCMinutes() !== profile.minute) {
    throw new Error("予定日時がcronの公表取得slotと一致しません");
  }
  // CFの遅配はここで止める。Actions待機・環境準備後にも各CLIが別途受付を判定する。
  if (nowMs > plannedMs + 5 * 60_000) throw new Error("定時dispatchの5分受付を超過しました");
  const scheduledAt = planned.toISOString().replace(".000Z", "Z");
  const scheduledDate = scheduledAt.slice(0, 10);
  const inputs: Record<string, string> = profile.name === "margin"
    ? { target: "scheduled-margin", scheduled_date: scheduledDate }
    : { scheduled_at: scheduledAt };
  return { ...profile, scheduledAt, scheduledDate, inputs,
    key: `timed-scheduler/${profile.name}/${scheduledAt}.json` };
}

export async function handleTimedScheduled(controller: ScheduledControllerLike, env: SchedulerEnv,
  options: { nowMs?: number; fetchFn?: typeof fetch } = {}) {
  const nowMs = options.nowMs === undefined ? Date.now() : options.nowMs;
  const plan = timedDispatchPlan(controller, nowMs);
  return runWorkflowDispatch({ bucket: env.BUCKET, token: schedulerToken(env), cron: controller.cron,
    scheduledDate: plan.scheduledDate, scheduledAt: plan.scheduledAt, key: plan.key,
    workflow: plan.workflow, inputs: plan.inputs, nowMs,
    fetchFn: options.fetchFn === undefined ? fetch : options.fetchFn });
}
