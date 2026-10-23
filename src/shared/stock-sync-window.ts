/** 通常株式同期のUTC対象日・開始窓・書込期限。元の実時計を変更しない。 */
export function stockSyncRunDate(startedAt: number): string {
  return new Date(startedAt).toISOString().split("T")[0];
}

export function scheduledStockSyncWindow(date: string) {
  const start = Date.parse(`${date}T09:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(start) ||
      new Date(start).toISOString().slice(0, 10) !== date || [0, 6].includes(new Date(start).getUTCDay())) {
    throw new Error("定時株式の予定日が不正です");
  }
  return { start, latestStart: start + 120 * 60_000, deadline: Date.parse(`${date}T14:30:00.000Z`) };
}

export function assertStockSyncStart(startedAt: number, scheduledDate?: string): void {
  if (scheduledDate !== undefined) {
    const { start, latestStart } = scheduledStockSyncWindow(scheduledDate);
    if (!Number.isFinite(startedAt) || startedAt < start || startedAt > latestStart) {
      throw new Error("定時株式の開始は予定日18:00〜20:00 JSTです（取得前停止）");
    }
    return;
  }
  const utcMinutes = new Date(startedAt).getUTCHours() * 60 + new Date(startedAt).getUTCMinutes();
  if (utcMinutes < 390 || utcMinutes >= 1260) {
    throw new Error("株式同期は東証15:30 JST終了後から翌06:00 JST基準までに実行してください");
  }
}

export function stockSyncDeadline(targetDate: string, scheduled = false): number {
  return scheduled ? scheduledStockSyncWindow(targetDate).deadline : Date.parse(`${targetDate}T21:00:00Z`);
}

export function assertStockSyncDeadline(targetDate: string, now: number, scheduled = false): void {
  if (scheduled && (!Number.isFinite(now) || now >= stockSyncDeadline(targetDate, true))) {
    throw new Error("定時株式が23:30 JST期限に達したため新規IO・金融保存を止めます");
  }
  if (now >= stockSyncDeadline(targetDate)) {
    throw new Error("株式同期が21:00 UTC期限に達したため新たな書込みを止めます");
  }
}

/** Node定時入口だけで使う。既存signalを保ち、待機後のHTTP開始も固定期限で止める。 */
export function installStockSyncDeadline(targetDate: string): () => void {
  const deadline = stockSyncDeadline(targetDate, true);
  assertStockSyncDeadline(targetDate, Date.now(), true);
  const nativeFetch = globalThis.fetch;
  const signal = AbortSignal.timeout(deadline - Date.now());
  const guarded: typeof fetch = (input, init) => {
    assertStockSyncDeadline(targetDate, Date.now(), true);
    const original = init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined;
    return nativeFetch(input, { ...init, signal: original ? AbortSignal.any([original, signal]) : signal });
  };
  globalThis.fetch = guarded;
  return () => { if (globalThis.fetch === guarded) globalThis.fetch = nativeFetch; };
}
