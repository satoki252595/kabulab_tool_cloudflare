/** CFの予定時刻。ミリ秒付きUTCだけを受け、欠落や別形式を時刻にしない。 */
const SCHEDULED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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
export function scheduledAtForDate(value: unknown, expectedDate: string): number {
  const ms = parseScheduledAt(value);
  if (new Date(ms).toISOString().slice(0, 10) !== expectedDate) {
    throw new Error("scheduled_atの日付が予定日と一致しません");
  }
  return ms;
}

/** 信用残の平日17:00受付と17:30新規IO。Workerからingest-marginをimportしない。 */
export function scheduledMarginWindow(date: string) {
  const start = Date.parse(`${date}T08:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(start) ||
      new Date(start).toISOString().slice(0, 10) !== date || [0, 6].includes(new Date(start).getUTCDay())) {
    throw new Error("信用残の予定日は実在する平日が必要です");
  }
  return { start, latestStart: start + 10 * 60_000, deadline: start + 30 * 60_000 };
}
