/** CFの予定時刻。ミリ秒付きUTCだけを受け、欠落や別形式を時刻にしない。 */
const SCHEDULED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class ScheduledSourceDeadlineError extends Error {}

export function parseScheduledAt(value: unknown): number {
  if (typeof value !== "string" || !SCHEDULED_AT_RE.test(value)) {
    throw new Error("scheduled_atが無いかUTC時刻として不正です");
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error("scheduled_atが無いかUTC時刻として不正です");
  }
  return ms;
}

export function scheduledAtIso(ms: number): string {
  if (!Number.isFinite(ms)) throw new Error("scheduled_atが無いかUTC時刻として不正です");
  const value = new Date(ms).toISOString();
  if (Date.parse(value) !== ms || new Date(value).toISOString() !== value) {
    throw new Error("scheduled_atが無いかUTC時刻として不正です");
  }
  return value;
}

/** 予定UTC日と scheduled_at の日付が違うときは、どちらかで埋めない。 */
export function scheduledAtForDate(value: unknown, expectedDate: string, nowMs: number): number {
  const ms = parseScheduledAt(value);
  if (!Number.isFinite(nowMs) || ms > nowMs) throw new Error("scheduled_atが未来か実時計が不正です");
  if (new Date(ms).toISOString().slice(0, 10) !== expectedDate) {
    throw new Error("scheduled_atの日付が予定日と一致しません");
  }
  return ms;
}

/** Jobs APIの実開始に束縛。外部killの5分前までに閉鎖し、その前にsourceを止める。 */
export function scheduledExecutionWindow(absoluteDeadline: number, nowMs: number,
  jobStartedAt: string | undefined, timeoutMinutes: number, closureMinutes: number) {
  if (![absoluteDeadline, nowMs, timeoutMinutes, closureMinutes].every(Number.isFinite) ||
      timeoutMinutes <= closureMinutes + 5 || closureMinutes <= 0) throw new Error("定時実行の時間予算が不正です");
  let deadline = absoluteDeadline;
  if (jobStartedAt !== undefined) {
    const started = parseScheduledAt(jobStartedAt);
    if (started > nowMs) throw new Error("job開始時刻が未来です");
    deadline = Math.min(deadline, started + (timeoutMinutes - 5) * 60_000);
  }
  return { deadline, sourceDeadline: deadline - closureMinutes * 60_000 };
}

/** 同jobの手動/月次入口。外部job時計のないSSHでは期限を補作しない。 */
export function nativeJobExecutionWindow(nowMs: number, jobStartedAt: string | undefined,
  timeoutMinutes: number, closureMinutes: number) {
  if (jobStartedAt === undefined) return undefined;
  return scheduledExecutionWindow(parseScheduledAt(jobStartedAt) + timeoutMinutes * 60_000,
    nowMs, jobStartedAt, timeoutMinutes, closureMinutes);
}

interface InstalledDeadline {
  readonly deadline: number;
  readonly signal: AbortSignal;
  assertActive(): void;
}
let installedDeadline: InstalledDeadline | undefined;

/** fetchの外側に監査wrapperがあっても、body読取へ同じhard期限を渡す。 */
export function currentScheduledDeadline(): InstalledDeadline | undefined { return installedDeadline; }

/** 開始済み通信にも絶対期限を届ける。unknownを成功・再送可能へ変換しない。 */
export function installScheduledDeadline(deadline: number, assertAllowed?: () => void): () => void {
  const previous = installedDeadline;
  const assertActive = () => {
    previous?.assertActive();
    assertAllowed?.();
    if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new Error("定時処理の原本閉鎖期限です（未完・再送なし）");
  };
  assertActive();
  const nativeFetch = globalThis.fetch, ownSignal = AbortSignal.timeout(Math.max(0, deadline - Date.now()));
  const signal = previous === undefined ? ownSignal : AbortSignal.any([previous.signal, ownSignal]);
  const guarded: typeof fetch = (input, init) => {
    assertActive();
    const original = init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined;
    return nativeFetch(input, { ...init, signal: original ? AbortSignal.any([original, signal]) : signal });
  };
  installedDeadline = { deadline: previous === undefined ? deadline : Math.min(previous.deadline, deadline), signal,
    assertActive: () => { assertActive(); signal.throwIfAborted(); } };
  globalThis.fetch = guarded;
  return () => { if (globalThis.fetch === guarded) { globalThis.fetch = nativeFetch; installedDeadline = previous; } };
}

/** 信用残の平日17:00受付と17:30新規IO。Workerからingest-marginをimportしない。 */
export function scheduledMarginWindow(date: string) {
  const start = Date.parse(`${date}T08:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(start) ||
      new Date(start).toISOString().slice(0, 10) !== date || [0, 6].includes(new Date(start).getUTCDay())) {
    throw new Error("信用残の予定日は実在する平日が必要です");
  }
  return { start, latestStart: start + 10 * 60_000, sourceDeadline: start + 20 * 60_000, deadline: start + 30 * 60_000 };
}

export function scheduledMacroWindow(date: string) {
  const start = Date.parse(`${date}T21:00:00.000Z`);
  return { start, latestStart: start + 30 * 60_000, sourceDeadline: start + 50 * 60_000,
    deadline: start + 60 * 60_000 };
}
