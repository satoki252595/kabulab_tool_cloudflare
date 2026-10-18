/** 公式公表済みの現物市場休業日。未収録年・不正日付は推測せず停止する。
 * 年次更新時は原文を共有 notion-archive へ保管し、JSONの出典・確認日も更新する。
 * NYSEの短縮取引日は休場ではない。確定closeは既存の原文session guardが証明する。
 */
import calendar from "./market-calendar.json";

export type Market = keyof typeof calendar.markets;
export interface MarketClosure { market: Market; reason: string; sourceUrl: string }

export function marketClosure(market: Market, date: string): MarketClosure | null {
  const stamp = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(stamp) ||
      new Date(stamp).toISOString().slice(0, 10) !== date) {
    throw new Error(`市場カレンダーの日付が不正です: ${date}`);
  }
  const source = calendar.markets[market];
  const holidays = (source.years as Record<string, Record<string, string>>)[date.slice(0, 4)];
  if (holidays === undefined) throw new Error(`${market}の公式休業日が未収録です: ${date}`);
  const named = holidays[date.slice(5)];
  const day = new Date(stamp).getUTCDay();
  if (named !== undefined) return { market, reason: named, sourceUrl: source.sourceUrl };
  if (day === 0 || day === 6) return { market, reason: "土日休場", sourceUrl: source.sourceUrl };
  return null;
}

export interface JpxReferenceSession {
  date: string;
  closedDates: string[];
  calendarSources: Array<{ sourceUrl: string; fetchedAt: string; sha256: string; bytes: number; pageId: string; readback: boolean }>;
}

/** 公式休場だけを遡る。2025土日は同原本の有効session集合を別途必須とし、価格欠測を飛ばさない。 */
export function lastJpxSessionOnOrBefore(date: string, observedSessions?: ReadonlySet<string>): JpxReferenceSession | undefined {
  const stamp = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== date) {
    throw new Error(`市場カレンダーの日付が不正です: ${date}`);
  }
  const closedDates: string[] = [], calendarSources: JpxReferenceSession["calendarSources"] = [];
  let candidate = date;
  for (let i = 0; i < 14; i++) {
    const yearEnd = calendar.markets.JPX.yearEndSessions.find(record => record.lastSession <= candidate && candidate <= record.closedThrough);
    if (yearEnd !== undefined) {
      for (let d = candidate; d > yearEnd.lastSession; d = new Date(Date.parse(`${d}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)) closedDates.push(d);
      return { date: yearEnd.lastSession, closedDates, calendarSources: [...calendarSources, ...yearEnd.sources] };
    }
    if (!Object.hasOwn(calendar.markets.JPX.years, candidate.slice(0, 4))) {
      // 2025は土日休業だけ資格済み。金曜は同原本の有効bar必須で、祝日/欠測を遡らない。
      const day = new Date(`${candidate}T00:00:00Z`).getUTCDay();
      if (candidate.slice(0, 4) !== "2025" || (day !== 0 && day !== 6)) return;
      const friday = new Date(Date.parse(`${candidate}T00:00:00Z`) - (day === 6 ? 1 : 2) * 86400000).toISOString().slice(0, 10);
      // 沿革で明示休業の年始3日間を有効sessionに倒さない。年末は先行の公式記録だけ。
      if (friday <= "2025-01-03" || !observedSessions?.has(friday)) return;
      for (let d = candidate; d > friday; d = new Date(Date.parse(`${d}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)) closedDates.push(d);
      const source = calendar.markets.JPX.weekendClosure2025;
      return { date: friday, closedDates, calendarSources: [...calendarSources, { sourceUrl: source.sourceUrl, ...source.sourcePin }] };
    }
    const closed = marketClosure("JPX", candidate);
    if (!closed) return { date: candidate, closedDates, calendarSources };
    if (calendarSources.length === 0) calendarSources.push({ sourceUrl: calendar.markets.JPX.sourceUrl, ...calendar.markets.JPX.sourcePin });
    closedDates.push(candidate);
    candidate = new Date(Date.parse(`${candidate}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  }
}
