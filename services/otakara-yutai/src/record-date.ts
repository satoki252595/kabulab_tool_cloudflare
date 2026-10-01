/** 単発優待の実基準日。NULL は従来の月表示、不明な値を NULL に補わない。 */
export function isRecordDate(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  if (Number(value.slice(0, 4)) === 0) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** 欠落・不正暦日は停止する。月末や現在年への推測変換は行わない。 */
export function assertRecordDate(value: unknown): asserts value is string | null {
  if (!isRecordDate(value)) throw new Error("優待の単発基準日が不明または不正です (YYYY-MM-DD / NULL が必要)");
}

/** 定常の月表示・年間利回りへ含めてよい優待か。 */
export function isRecurringBenefit(row: { recordDate: string | null }): boolean {
  assertRecordDate(row.recordDate);
  return row.recordDate === null;
}
