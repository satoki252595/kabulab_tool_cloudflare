/** D1 の日/通 checkpoint。未知の送信は in-flight を残して再送しない。 */
import { and, asc, desc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import { z } from "../../../../../src/shared/zod-mini.js";
import type { Database } from "../../db/client.js";
import { edinetCatchupProgress as table } from "../../db/schema.js";
import { listSnapshotSchema } from "./list-snapshot.js";

const idsSchema = z.array(z.string());
const pendingSchema = z.array(z.object({docId: z.string(), reason: z.enum([
  "identity_unresolved", "metadata_unresolved", "parse_error", "text_readback_mismatch",
  "reported_document_state",
])}));
export type PendingDocument = z.infer<typeof pendingSchema>[number];
export type Progress = typeof table.$inferSelect;

export function jstDate(now = new Date()): string {
  return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}
export function shiftDate(date: string, days: number): string {
  const result = new Date(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || result.toISOString().slice(0, 10) !== date) {
    throw new Error("EDINET checkpoint 日付が不正");
  }
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}
export function progressContents(row: Progress) {
  const completed = idsSchema.parse(JSON.parse(row.completedIds));
  const pending = pendingSchema.parse(JSON.parse(row.pendingIds));
  if (new Set(completed).size !== completed.length ||
      new Set(pending.map((p) => p.docId)).size !== pending.length ||
      pending.some((p) => completed.includes(p.docId))) {
    throw new Error("EDINET checkpoint 文書集合が不正");
  }
  const snapshot = row.snapshot === null ? null : listSnapshotSchema.parse(JSON.parse(row.snapshot));
  if (snapshot !== null && snapshot.date !== row.date) throw new Error("EDINET checkpoint 原本日付が不一致");
  return {completed, pending, snapshot};
}

/** 最初だけ60日を seed。その後は保存済末日の翌日から追加し、古い未完を保持する。 */
export async function enqueueDates(db: Database, scope: string, today: string): Promise<boolean> {
  const [last] = await db.select({date: table.date}).from(table)
    .where(eq(table.scope, scope)).orderBy(desc(table.date)).limit(1);
  let date = last ? shiftDate(last.date, 1) : shiftDate(today, -59);
  const dates: string[] = [];
  while (date <= today && dates.length < 60) { dates.push(date); date = shiftDate(date, 1); }
  // Drizzle は既定値も bind する (現スキーマ7個/行)。D1 の上限100以内。
  for (let i = 0; i < dates.length; i += 10) {
    await db.insert(table).values(dates.slice(i, i + 10).map((date) => ({scope, date})))
      .onConflictDoNothing();
  }
  return date <= today;
}

export async function progressQueue(db: Database, scope: string, today: string): Promise<Progress[]> {
  const active = await db.select().from(table).where(and(eq(table.scope, scope),
    or(eq(table.finished, false), and(eq(table.sealed, false), lt(table.date, today)))))
    .orderBy(asc(table.date)).limit(61);
  // NULL 提出者等の保留は別に再照合。保留が後続の日付取得を永久に塞がない。
  const pending = await db.select().from(table).where(and(eq(table.scope, scope),
    eq(table.finished, true), eq(table.sealed, true), ne(table.pendingIds, "[]"),
    or(isNull(table.pendingCheckedDate), lt(table.pendingCheckedDate, today))))
    .orderBy(asc(table.date)).limit(10);
  return [...active, ...pending.filter((r) => !active.some((a) => a.date === r.date))];
}

export async function saveProgress(db: Database, row: Progress,
  changes: Partial<Omit<Progress, "scope" | "date" | "revision" | "updatedAt">>): Promise<Progress> {
  const expected = {...row, ...changes, revision: row.revision + 1};
  progressContents(expected); // 入力不正を旧進捗へ書く前に拒否する。
  const saved = await db.update(table).set({...changes, revision: row.revision + 1,
    updatedAt: sql`unixepoch()`}).where(and(eq(table.scope, row.scope), eq(table.date, row.date),
      eq(table.revision, row.revision), row.inFlightDocId === null ? isNull(table.inFlightDocId)
        : eq(table.inFlightDocId, row.inFlightDocId))).returning();
  if (saved.length !== 1) throw new Error("EDINET checkpoint CAS が不一致 (再送なし)");
  if (Object.entries(expected).some(([key, value]) => key !== "updatedAt" && saved[0][key as keyof Progress] !== value)) {
    throw new Error("EDINET checkpoint CAS ACK が不一致 (再送なし)");
  }
  progressContents(saved[0]);
  return saved[0];
}

/** 未処理 queue と今日再照合済みの保留も、成功 summary から消さない。 */
export async function progressSummary(db: Database, scope: string, today: string) {
  const pendingCount = (reason: PendingDocument["reason"]) => sql<number>`coalesce(sum((
    select count(*) from json_each(${table.pendingIds}) p
    where json_extract(p.value, '$.reason') = ${reason}
  )), 0)`.as(reason);
  const rows = await db.select({
    pendingDocuments: sql<number>`coalesce(sum(json_array_length(${table.pendingIds})), 0)`,
    queuedDays: sql<number>`coalesce(sum(case when ${table.finished} = 0 or (${table.sealed} = 0 and ${table.date} < ${today}) then 1 else 0 end), 0)`,
    pendingRecheckDueDays: sql<number>`coalesce(sum(case when ${table.finished} = 1 and ${table.sealed} = 1 and ${table.pendingIds} <> '[]' and (${table.pendingCheckedDate} is null or ${table.pendingCheckedDate} < ${today}) then 1 else 0 end), 0)`,
    sameDayPendingWaitDays: sql<number>`coalesce(sum(case when ${table.finished} = 1 and ${table.sealed} = 1 and ${table.pendingIds} <> '[]' and ${table.pendingCheckedDate} = ${today} then 1 else 0 end), 0)`,
    futurePendingWaitDays: sql<number>`coalesce(sum(case when ${table.finished} = 1 and ${table.sealed} = 1 and ${table.pendingIds} <> '[]' and ${table.pendingCheckedDate} > ${today} then 1 else 0 end), 0)`,
    unsealedTodayWaitDays: sql<number>`coalesce(sum(case when ${table.finished} = 1 and ${table.sealed} = 0 and ${table.date} = ${today} then 1 else 0 end), 0)`,
    inFlightDays: sql<number>`coalesce(sum(case when ${table.inFlightDocId} is not null then 1 else 0 end), 0)`,
    pendingByReason: {
      identity_unresolved: pendingCount("identity_unresolved"),
      metadata_unresolved: pendingCount("metadata_unresolved"),
      parse_error: pendingCount("parse_error"),
      text_readback_mismatch: pendingCount("text_readback_mismatch"),
      reported_document_state: pendingCount("reported_document_state"),
    },
  }).from(table).where(eq(table.scope, scope));
  if (rows.length !== 1) throw new Error("EDINET checkpoint summary 不正");
  const {pendingByReason, ...counts} = rows[0];
  if (![...Object.values(counts), ...Object.values(pendingByReason)].every((v) => Number.isSafeInteger(v) && v >= 0) ||
      Object.values(pendingByReason).reduce((sum, count) => sum + count, 0) !== counts.pendingDocuments) {
    throw new Error("EDINET checkpoint summary 不正");
  }
  return rows[0];
}
