import { gte, type SQL } from "drizzle-orm";
import { stockFinancials } from "../../../../src/shared/db/core-schema.js";
import { stockRsiPercentile } from "../db/schema.js";

/** 当日金融だけ更新した部分成功で、旧RSIを現在値として使わない。DB時計は秒単位。 */
export function percentileMatchesFinancialSnapshot(): SQL {
  return gte(stockRsiPercentile.computedAt, stockFinancials.fetchedAt);
}

/** 詳細表示も一覧と同じ資格。金融行・時計の欠測は不適格のまま。 */
export function isPercentileSnapshotCurrent(computedAt: Date, fetchedAt: Date | undefined): boolean {
  return fetchedAt !== undefined && Number.isFinite(fetchedAt.getTime()) &&
    Number.isFinite(computedAt.getTime()) && computedAt.getTime() >= fetchedAt.getTime();
}
