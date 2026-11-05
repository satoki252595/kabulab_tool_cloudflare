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

/**
 * 定時マクロの時刻窓。Python の macro_schedule と同じ式。
 *
 * L = ^VIX 通常引け 16:15 America/New_York + 45分 = 17:00 ET。
 * 受付は L..L+30、新規取得は L+50、保存と ops_check の日付切替は L+60、
 * readcheck は L+65。夏は 21:00 UTC、冬は 22:00 UTC。切替日もこの変換で決める。
 * 早期終了（regular.end 13:00 ET）でも L は動かさない。13:45 ET は
 * 立会中拒否（daily.ts の 9:30–16:00 ET）の内側になる。
 */
const ET_ZONE = "America/New_York";
const VIX_REGULAR_END_MINUTES = 16 * 60 + 15;
const MACRO_LAG_MINUTES = 45;
const MACRO_ADMISSION_MINUTES = 30;
const MACRO_FETCH_DEADLINE_MINUTES = 50;
const MACRO_SAVE_DEADLINE_MINUTES = 60;
const MACRO_READCHECK_MINUTES = 65;

interface EtParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function etParts(utcMs: number): EtParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(utcMs));
  const map = new Map(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const year = map.get("year");
  const month = map.get("month");
  const day = map.get("day");
  const hourRaw = map.get("hour");
  const minute = map.get("minute");
  if (year === undefined || month === undefined || day === undefined || hourRaw === undefined || minute === undefined) {
    throw new Error(`America/New_York の時刻分解に失敗しました: ${new Date(utcMs).toISOString()}`);
  }
  const hour = hourRaw === "24" ? 0 : Number(hourRaw);
  if (![Number(year), Number(month), Number(day), hour, Number(minute)].every(Number.isInteger)) {
    throw new Error(`America/New_York の時刻分解が数値ではありません: ${new Date(utcMs).toISOString()}`);
  }
  return { year: Number(year), month: Number(month), day: Number(day), hour, minute: Number(minute) };
}

/** date の ET 壁時計を UTC ms にする。17:00 は DST の隙間・重複に入らない。合わなければ throw。 */
function etWallToUtc(date: string, hour: number, minute: number): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(hour) || !Number.isInteger(minute) ||
      hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`ET壁時計が不正です: ${date} ${hour}:${minute}`);
  }
  const [y, m, d] = date.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined) throw new Error(`ET壁時計が不正です: ${date}`);
  const probe = Date.UTC(y, m - 1, d, 16, 0, 0);
  if (new Date(probe).toISOString().slice(0, 10) !== date) throw new Error(`マクロ予定日が実在しません: ${date}`);
  const probeEt = etParts(probe);
  const offsetMinutes = (Date.UTC(probeEt.year, probeEt.month - 1, probeEt.day, probeEt.hour, probeEt.minute) - probe) / 60_000;
  if (!Number.isInteger(offsetMinutes)) {
    throw new Error(`America/New_York のオフセットが分単位ではありません: ${date}`);
  }
  const utc = Date.UTC(y, m - 1, d, hour, minute) - offsetMinutes * 60_000;
  const got = etParts(utc);
  if (got.year !== y || got.month !== m || got.day !== d || got.hour !== hour || got.minute !== minute) {
    throw new Error(
      `America/New_York の ${date} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} を一意に変換できません` +
      ` (得た ${got.year}-${String(got.month).padStart(2, "0")}-${String(got.day).padStart(2, "0")} ${String(got.hour).padStart(2, "0")}:${String(got.minute).padStart(2, "0")})`,
    );
  }
  return utc;
}

export interface MacroWindow {
  /** L。受付の開始。 */
  start: number;
  /** L+30。受付の終端（この瞬間は含む）。 */
  latestStart: number;
  /** L+50。新規取得の期限。 */
  sourceDeadline: number;
  /** L+60。保存期限。 */
  deadline: number;
  /** L+65。readcheck。 */
  readcheck: number;
  /** L+60。ops_check が当日へ切り替える瞬間（保存期限と同じ）。 */
  dateSwitch: number;
}

export function scheduledMacroWindow(date: string): MacroWindow {
  const lMinutes = VIX_REGULAR_END_MINUTES + MACRO_LAG_MINUTES;
  if (lMinutes < 0 || lMinutes >= 24 * 60) throw new Error("マクロ開始が日をまたぎます");
  const start = etWallToUtc(date, Math.floor(lMinutes / 60), lMinutes % 60);
  const minute = 60_000;
  const deadline = start + MACRO_SAVE_DEADLINE_MINUTES * minute;
  return {
    start,
    latestStart: start + MACRO_ADMISSION_MINUTES * minute,
    sourceDeadline: start + MACRO_FETCH_DEADLINE_MINUTES * minute,
    deadline,
    readcheck: start + MACRO_READCHECK_MINUTES * minute,
    dateSwitch: deadline,
  };
}

/** 発火時刻の分が、その UTC 日の ET 窓（dispatch=L、readcheck=L+65）と一致するか。 */
export function macroTriggerMatches(scheduledTimeMs: number, kind: "dispatch" | "readcheck"): boolean {
  if (!Number.isFinite(scheduledTimeMs)) throw new Error("マクロ予定時刻が不正です");
  const date = new Date(scheduledTimeMs).toISOString().slice(0, 10);
  const window = scheduledMacroWindow(date);
  const expected = kind === "dispatch" ? window.start : window.readcheck;
  return Math.floor(scheduledTimeMs / 60_000) === Math.floor(expected / 60_000);
}
