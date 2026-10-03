import {beforeEach, describe, expect, it} from "vitest";
import {DatabaseSync} from "node:sqlite";
import {readFileSync} from "node:fs";
import {drizzle} from "drizzle-orm/sqlite-proxy";
import type {Database} from "../db/client.js";
import {enqueueDates, progressQueue, progressSummary, saveProgress, jstDate} from "../services/edinet/catchup-progress.js";

let sqlite: DatabaseSync;
let db: Database;
beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../../../../drizzle/d1/0027_edinet_catchup_progress.sql", import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""));
  db = drizzle(async (query, args, method) => {
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

  it("JST翌日の未封印一覧のみ再観測対象に残す", async () => {
    expect(jstDate(new Date("2026-06-12T14:59:59Z"))).toBe("2026-06-12");
    expect(jstDate(new Date("2026-06-12T15:00:00Z"))).toBe("2026-06-13");
    await enqueueDates(db, "main", "2026-06-12");
    sqlite.exec("UPDATE yuho_edinet_catchup_progress SET finished=1,sealed=1");
    sqlite.exec("UPDATE yuho_edinet_catchup_progress SET sealed=0 WHERE date='2026-06-12'");
    expect(await progressQueue(db, "main", "2026-06-12")).toEqual([]);
    expect((await progressQueue(db, "main", "2026-06-13")).map((r) => r.date)).toEqual(["2026-06-12"]);
  });
});
