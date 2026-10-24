/** MWF 17時の通常VWAPだけに適用する窓。保存原本の取得時計は変更しない。 */
export const VWAP_DISPATCH_CRON = "0 8 * * MON,WED,FRI";
export const VWAP_READCHECK_CRON = "35 14 * * MON,WED,FRI";
export const VWAP_START_DEADLINE_MINUTES = 10;

export function scheduledVwapWindow(plannedDate: string) {
  const start = Date.parse(`${plannedDate}T08:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(plannedDate) || !Number.isFinite(start) ||
      new Date(start).toISOString().slice(0, 10) !== plannedDate ||
      ![1, 3, 5].includes(new Date(start).getUTCDay())) {
    throw new Error("VWAP plannedDateは実在する月水金のYYYY-MM-DDが必要です");
  }
  const completionCutoff = Date.parse(`${plannedDate}T14:30:00.000Z`);
  return { start, admissionCutoff: start + VWAP_START_DEADLINE_MINUTES * 60_000,
    sourceCutoff: completionCutoff - 10 * 60_000, completionCutoff };
}

export function assertVwapAdmission(plannedDate: string, nowMs: number): void {
  const window = scheduledVwapWindow(plannedDate);
  if (!Number.isFinite(nowMs) || nowMs < window.start || nowMs > window.admissionCutoff) {
    throw new Error("VWAP開始期限の範囲外です (予定日17:00〜17:10 JST)。新規取得しません");
  }
}

export function assertVwapContinuation(plannedDate: string, admittedAt: string, nowMs: number): void {
  const admittedMs = Date.parse(admittedAt);
  if (!Number.isFinite(admittedMs) || new Date(admittedMs).toISOString() !== admittedAt) {
    throw new Error("VWAP admissionの実時計が不正です");
  }
  assertVwapAdmission(plannedDate, admittedMs);
  if (!Number.isFinite(nowMs) || nowMs < admittedMs || nowMs >= scheduledVwapWindow(plannedDate).completionCutoff) {
    throw new Error("VWAP完了期限の範囲外です (予定日23:30 JSTより前)。新規取得・価格PUTしません");
  }
}
