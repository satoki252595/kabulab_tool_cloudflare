/** 単発優待の実基準日。NULL は通常月または随時、不明な値を NULL に補わない。 */
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

/** 0 は公式の「随時」専用。未取得の月を 0 で補わない。 */
export const ANYTIME_RECORD_MONTH = 0;
export type RecordMonth = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

/** 保存する権利時期は「随時」または実月 1〜12。 */
export function assertRecordMonth(value: unknown): asserts value is RecordMonth {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 12) {
    throw new Error("優待の権利時期が不正です (公式随時=0 / 実月1〜12が必要)");
  }
}

/** 内部 enum の 0 を「0月」として公開しない。 */
export function formatRecordMonth(value: number): string {
  assertRecordMonth(value);
  return value === ANYTIME_RECORD_MONTH ? "随時" : `${value}月`;
}

/** 随時と単発実日を混ぜた未確定条件を保存・表示しない。 */
export function assertBenefitSchedule(row: { recordMonth: unknown; recordDate: unknown }): asserts row is { recordMonth: RecordMonth; recordDate: string | null } {
  assertRecordMonth(row.recordMonth);
  assertRecordDate(row.recordDate);
  if (row.recordMonth === ANYTIME_RECORD_MONTH && row.recordDate !== null) {
    throw new Error("公式随時と単発基準日が混在しているため停止します");
  }
}

/** 定常の月表示・年間利回りへ含めてよい優待か。随時の回数を推定しない。 */
export function isRecurringBenefit(row: { recordMonth: number; recordDate: string | null }): boolean {
  assertBenefitSchedule(row);
  return row.recordDate === null && row.recordMonth !== ANYTIME_RECORD_MONTH;
}
