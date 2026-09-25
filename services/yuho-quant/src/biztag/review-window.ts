/**
 * 年次見直しの期間 (docs/005-yuho-quant-business-tags.md §6.1・§6.3)。
 *
 * 見直しは 8 月第 1 月曜 (JST) に始まり、その 7 日後が提案の期限。Cursor Automation は
 * 「8 月第 1 月曜」を cron で正確に表せないので、毎週月曜 06:00 JST に起動し、
 * review-packet の `reviewWindow.open` が false なら何もせず終える
 * (日付の計算を LLM にさせない)。gate.ts の期限切れ検査も同じ関数を使う。
 * Worker からも読むので、重い依存 (unpdf 等) を持つ gate.ts から切り出している。
 */
import { addDaysJst } from "./date-jst.js";

/** 8月第1月曜 (YYYY-MM-DD)。 */
export function firstMondayOfAugust(year: number): string {
  const aug1 = Date.UTC(year, 7, 1);
  const weekday = new Date(aug1).getUTCDay();
  const offsetDays = (8 - weekday) % 7;
  const d = new Date(aug1 + offsetDays * 24 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** 見直し提案の期限 = 8月第1月曜 + 7日。 */
export function reviewDeadline(year: number): string {
  return addDaysJst(firstMondayOfAugust(year), 7);
}

export interface ReviewWindow {
  /** 判定に使った今日 (JST, YYYY-MM-DD) */
  todayJst: string;
  /** 今年の見直し開始日 (8 月第 1 月曜) */
  start: string;
  /** 今年の提案期限 (開始日 + 7 日) */
  deadline: string;
  /** 今日が開始日〜期限の間か */
  open: boolean;
}

/** 今日 (JST) が今年の見直し期間に入っているか。 */
export function reviewWindowOf(todayJst: string): ReviewWindow {
  const year = Number(todayJst.slice(0, 4));
  if (!Number.isInteger(year) || !/^\d{4}-\d{2}-\d{2}$/.test(todayJst)) {
    throw new Error(`reviewWindowOf: 日付の形式が不正です (YYYY-MM-DD 必須): ${todayJst}`);
  }
  const start = firstMondayOfAugust(year);
  const deadline = reviewDeadline(year);
  return { todayJst, start, deadline, open: todayJst >= start && todayJst <= deadline };
}
