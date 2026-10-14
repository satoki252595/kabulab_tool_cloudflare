/** 通常株式同期のUTC対象日・開始窓・書込期限。元の実時計を変更しない。 */
export function stockSyncRunDate(startedAt: number): string {
  return new Date(startedAt).toISOString().split("T")[0];
}

export function assertStockSyncStart(startedAt: number): void {
  const utcMinutes = new Date(startedAt).getUTCHours() * 60 + new Date(startedAt).getUTCMinutes();
  if (utcMinutes < 390 || utcMinutes >= 1260) {
    throw new Error("株式同期は東証15:30 JST終了後から翌06:00 JST基準までに実行してください");
  }
}

export function assertStockSyncDeadline(targetDate: string, now: number): void {
  if (now >= Date.parse(`${targetDate}T21:00:00Z`)) {
    throw new Error("株式同期が21:00 UTC期限に達したため新たな書込みを止めます");
  }
}
