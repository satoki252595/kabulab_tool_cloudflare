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
