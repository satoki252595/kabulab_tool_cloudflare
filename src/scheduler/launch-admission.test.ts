import { expect, it } from "vitest";
import { CATCHUP_JOIN_CUTOFF_TIME, resolveRunDate } from "./stock.js";
import { assertCatchupInvocation } from "../../scripts/sync/catchup-launch.js";
import { timedDispatchPlan } from "./timed.js";

const FOUR_MIN_50_SEC = 4 * 60_000 + 50_000;
const NINETEEN_MIN = 19 * 60_000;

function catchupEvent(scheduledAt: unknown, date = "2026-10-14") {
  const inputs: Record<string, unknown> = { target: "scheduled-catchup", scheduled_date: date };
  if (scheduledAt !== undefined) inputs.scheduled_at = scheduledAt;
  return { inputs };
}

it("catchupは4分50秒遅れでもscheduled_atが19:00〜19:05なら受理する", () => {
  const scheduledAt = "2026-10-14T10:00:10.001Z";
  const now = Date.parse(scheduledAt) + FOUR_MIN_50_SEC;
  expect(new Date(now).toISOString()).toBe("2026-10-14T10:05:00.001Z");
  expect(() => assertCatchupInvocation("all", "workflow_dispatch", catchupEvent(scheduledAt), now)).not.toThrow();
});

it("marginは4分50秒遅れでも予定分が17:00なら受理し生のscheduled_atを渡す", () => {
  const scheduledTime = Date.parse("2026-10-23T08:00:52.000Z");
  const plan = timedDispatchPlan(
    { cron: "0 8 * * MON-FRI", scheduledTime },
    scheduledTime + FOUR_MIN_50_SEC,
  );
  expect(plan.inputs.scheduled_at).toBe("2026-10-23T08:00:52.000Z");
});

it("vwapは約19分遅れでも予定時刻が17:00の分なら受理する", () => {
  const scheduledTime = Date.parse("2026-10-16T08:00:52.000Z");
  expect(resolveRunDate("vwap-dispatch", scheduledTime, scheduledTime + NINETEEN_MIN)).toBe("2026-10-16");
});

it("catchupは約19分遅れでもscheduled_atが窓内かつ19:53前なら受理する", () => {
  const scheduledAt = "2026-10-14T10:00:00.000Z";
  expect(() => assertCatchupInvocation(
    "all", "workflow_dispatch", catchupEvent(scheduledAt), Date.parse(scheduledAt) + NINETEEN_MIN,
  )).not.toThrow();
});

it("vwapの実時計が23:30 JSTに達したら完了期限として拒否する", () => {
  const scheduledTime = Date.parse("2026-10-16T08:00:52.000Z");
  expect(() => resolveRunDate("vwap-dispatch", scheduledTime, Date.parse("2026-10-16T14:30:00.000Z")))
    .toThrow(/完了期限|23:30/);
});

it("catchupの実時計が19:53以降なら拒否する", () => {
  expect(() => assertCatchupInvocation(
    "all", "workflow_dispatch", catchupEvent("2026-10-14T10:00:00.000Z"),
    Date.parse(`2026-10-14T${CATCHUP_JOIN_CUTOFF_TIME}`),
  )).toThrow();
});

it("marginの実時計が17:30 JST以降なら拒否する", () => {
  const scheduledTime = Date.parse("2026-10-23T08:00:52.000Z");
  expect(() => timedDispatchPlan(
    { cron: "0 8 * * MON-FRI", scheduledTime },
    Date.parse("2026-10-23T08:30:00.000Z"),
  )).toThrow(/17:30/);
});

it("scheduled_atの欠落・空・非ISO・ミリ秒なしは受理しない", () => {
  const now = Date.parse("2026-10-14T10:00:10.000Z");
  for (const scheduledAt of [undefined, "", "not-a-time", "2026-10-14T10:00:00Z"]) {
    expect(() => assertCatchupInvocation("all", "workflow_dispatch", catchupEvent(scheduledAt), now))
      .toThrow(/scheduled_at/);
  }
});
