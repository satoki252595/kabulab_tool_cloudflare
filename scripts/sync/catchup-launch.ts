/** GitHub組込envはこの入口だけで読み、旧scheduleを取得前に止める。secret/config追加なし。 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installScheduledDeadline, parseScheduledAt } from "../../src/shared/scheduled-admission.js";
import { CATCHUP_START_TIME, CATCHUP_JOIN_CUTOFF_TIME } from "../../src/scheduler/stock.js";

type CatchupPart = "all" | "tdnet" | "edinet";
export const launchEnv = {
  eventName: (): string | undefined => process.env.GITHUB_EVENT_NAME,
  eventRef: (): string | undefined => process.env.GITHUB_REF,
  eventSha: (): string | undefined => process.env.GITHUB_SHA,
  eventPath: (): string => {
    const path = process.env.GITHUB_EVENT_PATH;
    if (!path) throw new Error("workflow_dispatchのGITHUB_EVENT_PATHがありません");
    return path;
  },
};

export function assertCatchupCodeLease(ref: string | undefined, sha: string | undefined, revisions: string): void {
  if (ref !== "refs/heads/main" || sha === undefined || !/^[a-f0-9]{40}$/.test(sha) || revisions !== `${sha}\n${sha}`) {
    throw new Error("catchupのevent/main/checkout revisionが一致しません（取得前停止）");
  }
}

export function assertCatchupInvocation(part: CatchupPart, eventName: string | undefined, event: unknown, nowMs: number): number | undefined {
  if (eventName === "schedule") throw new Error("旧catchup scheduleを取得前に停止しました（再送なし）");
  // 手元CLIとpush/PRのテスト実行は従来どおり。日時を補完しない。
  if (eventName !== "workflow_dispatch") return;
  if (typeof event !== "object" || event === null || Array.isArray(event)) throw new Error("catchup dispatch payloadが不正です");
  const inputs = (event as Record<string, unknown>).inputs;
  if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs)) throw new Error("catchup dispatch inputsがありません");
  const { target, scheduled_date: date } = inputs as Record<string, unknown>;
  if (target !== "all" && target !== "tdnet" && target !== "edinet" && target !== "scheduled-catchup") throw new Error("catchup targetが不正です");
  if (part !== "all" && target !== "all" && target !== part && target !== "scheduled-catchup") throw new Error("catchup targetとCLIが一致しません");
  if (target !== "scheduled-catchup") return;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(nowMs)) throw new Error("catchup scheduled_date/clockが不正です");
  const scheduledMs = parseScheduledAt((inputs as Record<string, unknown>).scheduled_at);
  const floor = Date.parse(`${date}T${CATCHUP_START_TIME}`);
  const cutoff = Date.parse(`${date}T${CATCHUP_JOIN_CUTOFF_TIME}`);
  const day = new Date(floor);
  const scheduledDate = new Date(scheduledMs).toISOString().slice(0, 10);
  // 19:00〜19:05はscheduled_at。19:53は実時計の後続締切。
  if (!Number.isFinite(floor) || day.toISOString().slice(0, 10) !== date || day.getUTCDay() === 0 || day.getUTCDay() === 6 || scheduledDate !== date || scheduledMs > nowMs || nowMs >= cutoff || scheduledMs < floor || scheduledMs > floor + 5 * 60_000) {
    throw new Error("catchupの予定日/平日/19:00〜19:05初回/19:53後続窓が一致しません（再送なし）");
  }
  return cutoff;
}

export function assertCatchupDeadline(deadlineMs: number | undefined): void {
  if (deadlineMs !== undefined && Date.now() >= deadlineMs) throw new Error("catchupの絶対締切です（未完・再送なし）");
}

/** この定時CLIだけの期限。共有clientの順序/380ms/unknown分類を変更しない。 */
export function installCatchupDeadline(deadlineMs: number): () => void {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs - Date.now() > 60 * 60_000) throw new Error("catchup絶対締切が不正です");
  // hard19:53は最も早い外部終了19:54より前。CPU/S3/長い待機の最終境界はjob54分。
  const restore = installScheduledDeadline(deadlineMs, () => assertCatchupDeadline(deadlineMs));
  const guarded = globalThis.fetch;
  // 従来catchupのfetchは同期guard失敗もPromise rejectionとして返す。
  const asyncGuard: typeof fetch = async (input, init) => guarded(input, init);
  globalThis.fetch = asyncGuard;
  return () => { if (globalThis.fetch === asyncGuard) { globalThis.fetch = guarded; restore(); } };
}

export function validateCatchupLaunch(part: CatchupPart): number | undefined {
  const name = launchEnv.eventName();
  const event: unknown = name === "workflow_dispatch" ? JSON.parse(readFileSync(launchEnv.eventPath(), "utf8")) : undefined;
  const deadline = assertCatchupInvocation(part, name, event, Date.now());
  if (name === "workflow_dispatch") {
    const revisions = execFileSync("git", ["rev-parse", "HEAD", "refs/remotes/origin/main"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    assertCatchupCodeLease(launchEnv.eventRef(), launchEnv.eventSha(), revisions);
    execFileSync("git", ["diff", "--quiet", "HEAD", "--"], { stdio: "ignore" });
  }
  // git確認の後も、19:53の実時計締切を超えていないことを見る。
  assertCatchupInvocation(part, name, event, Date.now());
  if (deadline !== undefined) installCatchupDeadline(deadline);
  return deadline;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { validateCatchupLaunch("all"); }
  catch { console.error("catchup起動資格が不正。取得前に停止しました（再送なし）。"); process.exitCode = 1; }
}
