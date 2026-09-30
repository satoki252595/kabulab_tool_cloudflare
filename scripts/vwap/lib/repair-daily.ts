/**
 * Daily whole-post rebuild (純関数。VWAP adj demotion 済み)。
 *
 * 対象: 保存済み daily object の再構築 (7944/8303/8919 を含む)。
 * fresh Yahoo 10y (既存 fetchDaily 全 guard 済み) で whole post を再構築する。
 * 既存 schema/merge/identity/finite guard のみ reuse し、新規検証枠は作らない。
 * adj は金融入力に使わない (旧 bytes の adj は原文保管として温存し検証しない)。
 *
 * 契約:
 * - range {from,to} は要求 10y の frozen 明示指定 (既定なし。fresh 先頭日
 *   からの導出は禁止)。range 外の旧 bar は明示破棄 (件数+端を報告)。
 *   range 内旧 bar は qualified fresh で完全置換するまで保護する:
 *   実在旧 in-range 日付が fresh に欠ければ一律 HOLD (throw)。
 *   旧不良行も除外しない (修復対象日の silent drop 防止)。
 * - fresh 不合格 (OHLCV 非有限・非正・欠落・契約外・重複・splits 不正) は HOLD。
 * - 候補 post は既存 assertSavedDailyShape で最終証明する。
 * - 価格値は出さない (件数・日付・成否のみ)。
 */
import {
  assertSavedDailyShape,
  findInvalidBars,
  isCalendarDate,
  type DiscardedOutOfRange,
  type SavedDaily,
} from "./ingest-guard.js";
import type { DailyResult } from "../../../src/shared/yahoo/client.js";

export type RepairRange = { from: string; to: string };

export type RepairPost = {
  post: SavedDaily;
  postJson: string;
  freshFirst: string;
  freshLast: string;
  discardedOutOfRange: DiscardedOutOfRange;
  supersededInRange: number;
};

const hold = (why: string): never => {
  throw new Error(`repair HOLD: ${why}`);
};

export function buildRepairPost(args: {
  code: string;
  oldRaw: string;
  fresh: DailyResult;
  range: RepairRange;
  updatedAt: string;
}): RepairPost {
  const { code, oldRaw, fresh, range, updatedAt } = args;
  if (!isCalendarDate(range.from) || !isCalendarDate(range.to) || range.from > range.to) {
    hold(`range 契約不正 from=${range.from} to=${range.to}`);
  }
  if (typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt))) {
    hold("updatedAt 不正");
  }
  let old: unknown;
  try {
    old = JSON.parse(oldRaw) as unknown;
  } catch {
    hold("old parse 不能");
  }
  const o = old as Record<string, unknown>;
  if (o === null || typeof o !== "object" || Array.isArray(o)) hold("old 非 object");
  if ((o as { code?: unknown }).code !== code) hold("old code 不一致");
  const oldBars = (o as { bars?: unknown }).bars;
  if (!Array.isArray(oldBars)) hold("old bars 非配列");

  // fresh 全 bar の有限・正値 (既存 guard reuse。adj は金融入力に使わない)。
  const bad = findInvalidBars(
    fresh.bars.map((b) => ({ o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }))
  );
  if (bad.length > 0) {
    const fams = [...new Set(bad.flatMap((b) => b.reasons.map((r) => r.split(":")[0])))].sort();
    hold(`fresh 不合格 ${bad.length} 件 (${fams.join(",")})`);
  }
  // fresh 日付: 暦有効・昇順一意・契約内。
  const freshDates = fresh.bars.map((b) => b.date);
  for (const d of freshDates) {
    if (!isCalendarDate(d)) hold(`fresh 日付不正 ${d}`);
    if (d < range.from || d > range.to) hold(`fresh 契約外 ${d}`);
  }
  const freshSet = new Set(freshDates);
  if (freshSet.size !== freshDates.length) hold("fresh 日付重複");
  if (freshDates.length === 0) hold("fresh 空");
  const sorted = [...freshDates].sort();
  if (sorted.some((d, i) => d !== freshDates[i])) hold("fresh 非昇順");

  // 旧 bar の会計: range 外は明示破棄、range 内有効で fresh 欠落は HOLD。
  let discarded = 0;
  let discardedFirst: string | null = null;
  let discardedLast: string | null = null;
  let superseded = 0;
  const missingOld: string[] = [];
  for (const b of oldBars as Array<unknown>) {
    const r = b as Record<string, unknown> | null;
    const d = r !== null && typeof r === "object" ? (r as { date?: unknown }).date : undefined;
    if (typeof d !== "string" || !isCalendarDate(d)) hold("old 日付配置不能");
    if ((d as string) < range.from || (d as string) > range.to) {
      discarded += 1;
      if (discardedFirst === null || (d as string) < discardedFirst) discardedFirst = d as string;
      if (discardedLast === null || (d as string) > discardedLast) discardedLast = d as string;
      continue;
    }
    superseded += 1;
    // 旧 bar の良否を問わず、実在 in-range 日付の欠落は一律 HOLD。
    // (旧不良行は修復対象であり、除外は silent drop になる)
    if (!freshSet.has(d as string)) missingOld.push(d as string);
  }
  if (missingOld.length > 0) {
    const head = [...missingOld].sort().slice(0, 10).join(",");
    hold(`in-range 旧 ${missingOld.length} 件が fresh に欠落 (${head}${missingOld.length > 10 ? "…" : ""})`);
  }

  // 候補 post を既存保存形状で最終証明する。fresh の proof をそのまま継承する。
  const candidate = JSON.stringify({
    code,
    updated: updatedAt,
    bars: fresh.bars,
    splits: fresh.splits,
    proof: fresh.proof,
  });
  const post = assertSavedDailyShape(candidate, `daily/${code}.json`, code);
  return {
    post,
    postJson: candidate,
    freshFirst: freshDates[0],
    freshLast: freshDates[freshDates.length - 1],
    discardedOutOfRange: { count: discarded, first: discardedFirst, last: discardedLast },
    supersededInRange: superseded,
  };
}
