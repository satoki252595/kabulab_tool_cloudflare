import {beforeEach, describe, expect, it} from "vitest";
import {DatabaseSync} from "node:sqlite";
import {readFileSync} from "node:fs";
import {drizzle} from "drizzle-orm/sqlite-proxy";
import type {Database} from "../db/client.js";
import {enqueueDates, progressQueue, progressSummary, saveProgress, jstDate} from "../services/edinet/catchup-progress.js";

let sqlite: DatabaseSync;
let db: Database;
let insertCalls: number;
let queryCalls: number;
beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  insertCalls = 0;
  queryCalls = 0;
  sqlite.exec(readFileSync(new URL("../../../../drizzle/d1/0027_edinet_catchup_progress.sql", import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""));
  db = drizzle(async (query, args, method) => {
    queryCalls++;
    expect(args.length).toBeLessThanOrEqual(100); // 実生成SQLの既定値bindもD1上限に含む。
    if (/^insert\b/i.test(query)) insertCalls++;
    const stmt = sqlite.prepare(query);
    const bind = args as (string | number | null)[];
    if (method === "run") {stmt.run(...bind); return {rows: []};}
    const rows = (stmt.all(...bind) as Record<string, unknown>[]).map((r) => Object.values(r));
    return {rows: method === "get" ? rows[0] : rows};
  }) as unknown as Database;
});

describe("EDINET durable day/doc checkpoint", () => {
  it("60日をseed後、古い未完を削除せず保存末日の翌日から有限追加", async () => {
    expect(await enqueueDates(db, "main", "2026-06-12")).toBe(false);
    expect(sqlite.prepare("SELECT count(*) AS n FROM yuho_edinet_catchup_progress").get()).toEqual({n: 60});
    const seededInsertCalls = insertCalls;
    expect(await enqueueDates(db, "main", "2026-06-12")).toBe(false);
    expect(insertCalls).toBe(seededInsertCalls);
    const first = sqlite.prepare("SELECT min(date) AS date FROM yuho_edinet_catchup_progress").get();
    expect(await enqueueDates(db, "main", "2026-10-04")).toBe(true);
    expect(sqlite.prepare("SELECT min(date) AS date FROM yuho_edinet_catchup_progress").get()).toEqual(first);
    expect(sqlite.prepare("SELECT count(*) AS n FROM yuho_edinet_catchup_progress").get()).toEqual({n: 120});
    expect((await progressQueue(db, "main", "2026-10-04"))[0].date).toBe((first as {date: string}).date);
  });

  it("revision/in-flight CASの競合は拒否し、未確定の文書予約を残す", async () => {
    await enqueueDates(db, "main", "2026-06-12");
    const row = (await progressQueue(db, "main", "2026-06-12"))[0];
    const reserved = await saveProgress(db, row, {inFlightDocId: "S100YAVT"});
    await expect(saveProgress(db, row, {finished: true})).rejects.toThrow("CAS");
    expect((await progressQueue(db, "main", "2026-06-12"))[0].inFlightDocId).toBe("S100YAVT");
    const completed = await saveProgress(db, reserved, {inFlightDocId: null, completedIds: '["S100YAVT"]'});
    expect(completed.revision).toBe(2);
  });

  it("NULL identity保留は別queueへ残し、日付が進んでも未提出/完了へ変換しない", async () => {
    await enqueueDates(db, "main", "2026-06-12");
    const [row] = await progressQueue(db, "main", "2026-06-12");
    await saveProgress(db, row, {finished: true, sealed: true,
      pendingIds: '[{"docId":"S100YAVT","reason":"identity_unresolved"}]', pendingCheckedDate: "2026-06-12"});
    expect((await progressQueue(db, "main", "2026-06-12")).some((r) => r.date === row.date)).toBe(false);
    const queue = await progressQueue(db, "main", "2026-06-13");
    expect(queue.at(-1)?.date).toBe(row.date);
    expect((await progressSummary(db, "main", "2026-06-12")).pendingDocuments).toBe(1);
  });

  it("保存済み実日付12件の保留を最終照合日順に巡回し、後続2日を翌日に選ぶ", async () => {
    // 2026-10-25に資格化したEDINET一覧receiptの実日付。保留状態は本番観測ではなくテスト用。
    const dates = ["2025-10-28", "2025-11-25", "2025-11-26", "2025-12-22", "2025-12-24", "2026-01-28",
      "2026-03-24", "2026-03-27", "2026-04-16", "2026-05-25", "2026-05-27", "2026-06-17"];
    const pending = '[{"docId":"S100YAVT","reason":"identity_unresolved"}]';
    for (const date of dates) {
      sqlite.prepare("INSERT INTO yuho_edinet_catchup_progress(scope,date,finished,sealed,pending_ids) VALUES ('main',?,1,1,?)")
        .run(date, pending);
    }
    const first = await progressQueue(db, "main", "2026-10-25");
    expect(first.map((r) => r.date)).toEqual(dates.slice(0, 10));
    for (const row of first) await saveProgress(db, row, {pendingCheckedDate: "2026-10-25"});
    expect((await progressQueue(db, "main", "2026-10-25")).map((r) => r.date)).toEqual(dates.slice(10));

    const second = await progressQueue(db, "main", "2026-10-26");
    expect(second.map((r) => r.date)).toEqual([...dates.slice(10), ...dates.slice(0, 8)]);
    for (const row of second) await saveProgress(db, row, {pendingCheckedDate: "2026-10-26"});
    const third = await progressQueue(db, "main", "2026-10-27");
    expect(third.slice(0, 2).map((r) => r.date)).toEqual(dates.slice(8, 10));
    expect(new Set([...first, ...second].map((r) => r.date)).size).toBe(12);
    expect((await progressSummary(db, "main", "2026-10-26")).pendingDocuments).toBe(12);
    expect(sqlite.prepare("SELECT finished,sealed,pending_ids,completed_ids,in_flight_doc_id FROM yuho_edinet_catchup_progress").all())
      .toEqual(dates.map(() => ({finished: 1, sealed: 1, pending_ids: pending, completed_ids: "[]", in_flight_doc_id: null})));
  });

  it("JST翌日の未封印一覧のみ再観測対象に残す", async () => {
    expect(jstDate(new Date("2026-06-12T14:59:59Z"))).toBe("2026-06-12");
    expect(jstDate(new Date("2026-06-12T15:00:00Z"))).toBe("2026-06-13");
    await enqueueDates(db, "main", "2026-06-12");
    sqlite.exec("UPDATE yuho_edinet_catchup_progress SET finished=1,sealed=1");
    sqlite.exec("UPDATE yuho_edinet_catchup_progress SET sealed=0 WHERE date='2026-06-12'");
    expect(await progressQueue(db, "main", "2026-06-12")).toEqual([]);
    expect((await progressQueue(db, "main", "2026-06-13")).map((r) => r.date)).toEqual(["2026-06-12"]);
  });

  it("既存1SELECTで同日保留待ち/翌日再照合と実未完理由を分ける", async () => {
    await enqueueDates(db, "main", "2026-06-12");
    sqlite.exec("UPDATE yuho_edinet_catchup_progress SET finished=1,sealed=1");
    sqlite.prepare("UPDATE yuho_edinet_catchup_progress SET pending_ids=?,pending_checked_date=? WHERE date=?")
      .run('[{"docId":"S100YAVT","reason":"identity_unresolved"}]', "2026-06-12", "2026-06-11");
    sqlite.exec("UPDATE yuho_edinet_catchup_progress SET sealed=0 WHERE date='2026-06-12'");
    const before = queryCalls;
    const sameDay = await progressSummary(db, "main", "2026-06-12");
    expect(queryCalls - before).toBe(1);
    expect(sameDay).toMatchObject({pendingDocuments: 1, queuedDays: 0,
      pendingRecheckDueDays: 0, sameDayPendingWaitDays: 1, futurePendingWaitDays: 0,
      unsealedTodayWaitDays: 1, inFlightDays: 0,
      pendingByReason: {identity_unresolved: 1, metadata_unresolved: 0, parse_error: 0, text_readback_mismatch: 0}});
    expect(await progressQueue(db, "main", "2026-06-12")).toEqual([]);
    expect(await progressSummary(db, "main", "2026-06-13")).toMatchObject({
      pendingDocuments: 1, queuedDays: 1, pendingRecheckDueDays: 1,
      sameDayPendingWaitDays: 0, unsealedTodayWaitDays: 0});
    expect(sqlite.prepare("SELECT pending_ids FROM yuho_edinet_catchup_progress WHERE date='2026-06-11'").get()?.pending_ids)
      .toBe('[{"docId":"S100YAVT","reason":"identity_unresolved"}]');
  });
});
