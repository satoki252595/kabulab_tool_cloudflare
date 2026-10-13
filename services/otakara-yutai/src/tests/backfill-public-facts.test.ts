/** 試験専用の合成行。実制度・実データの証拠として扱わない。 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { planPublicFactsBackfill, applyPublicFactsBackfillOnce, assertPublicFactsRowsMatch, type PublicFactsPreimage } from "../../data-scripts/backfill-public-facts.js";
import type { D1BatchStatement } from "../../../../src/shared/db/d1-http-client.js";
import { parsePublicBenefitFacts } from "../public-facts.js";

const row = (id: number, shares = 100): PublicFactsPreimage => ({
  id, stockId: 1, stockCode: "7203", stockName: "試験用架空株式", genreId: 1,
  description: "架空QUOカード3,000円分", shortSummary: "架空カード3,000円分", estimatedValue: 3000,
  estimateValueSource: "company", minShares: shares, recordMonth: 3, recordDate: null,
  createdAt: 1234567890, updatedAt: 1234567891, publicFacts: null,
});
const source = (rows: PublicFactsPreimage[]) => rows.map(({ genreId, createdAt, publicFacts, ...value }) => {
  void genreId; void createdAt; void publicFacts; return value;
});

function database(rows: PublicFactsPreimage[]) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE core_stocks(id INTEGER PRIMARY KEY,code TEXT,is_active INTEGER,instrument_type TEXT); INSERT INTO core_stocks VALUES(1,'7203',1,'equity'); CREATE TABLE yutai_benefits(id INTEGER PRIMARY KEY,stock_id INTEGER,genre_id INTEGER,description TEXT,short_summary TEXT,min_shares INTEGER,record_month INTEGER,record_date TEXT,estimated_value INTEGER,estimate_value_source TEXT,created_at INTEGER,updated_at INTEGER,public_facts TEXT)");
  const insert = db.prepare("INSERT INTO yutai_benefits VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
  for (const r of rows) insert.run(r.id,r.stockId,r.genreId,r.description,r.shortSummary,r.minShares,r.recordMonth,r.recordDate,r.estimatedValue,r.estimateValueSource,r.createdAt,r.updatedAt,r.publicFacts);
  const send = async (statements: readonly D1BatchStatement[]) => {
    db.exec("BEGIN");
    try {
      for (const s of statements) db.prepare(s.sql).all(...s.params as (string | number | null)[]);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  return { db, send };
}

describe("公開条件の一度だけの保守取込", () => {
  it("同一本文の全recipient contextを使い、更新する列を条件JSONだけに限定する", async () => {
    const rows = [row(1), row(2,1000)];
    const plan = planPublicFactsBackfill(source(rows), rows);
    expect(plan.groups).toBe(1);
    expect(parsePublicBenefitFacts(plan.expected[0].publicFacts)?.valueReasons).toEqual(["mixed_share_context"]);
    const { db, send } = database(rows);
    const before = db.prepare("SELECT * FROM yutai_benefits ORDER BY id").all();
    await send(plan.statements);
    const after = db.prepare("SELECT * FROM yutai_benefits ORDER BY id").all();
    expect(after).toEqual(before.map((r,i) => ({ ...r, public_facts: plan.expected[i].publicFacts })));
    db.close();
  });

  it.each(["description", "min_shares", "record_month", "updated_at", "public_facts"])("%sのdriftで全batchをrollbackする", async column => {
    const rows = [row(1), row(2)];
    const plan = planPublicFactsBackfill(source(rows), rows);
    const { db, send } = database(rows);
    db.prepare(`UPDATE yutai_benefits SET ${column}=? WHERE id=2`).run(column === "description" || column === "public_facts" ? "changed" : 9);
    const before = db.prepare("SELECT * FROM yutai_benefits ORDER BY id").all();
    await expect(send(plan.statements)).rejects.toThrow();
    expect(db.prepare("SELECT * FROM yutai_benefits ORDER BY id").all()).toEqual(before);
    db.close();
  });

  it("sourceの欠落・重複ID・既存DTOは計画段階で停止する", () => {
    expect(() => planPublicFactsBackfill([], [row(1)])).toThrow(/行数/);
    expect(() => planPublicFactsBackfill(source([row(1),row(1)]), [row(1),row(1)])).toThrow(/重複/);
    const existing = { ...row(1), publicFacts: "{}" };
    expect(() => planPublicFactsBackfill(source([existing]), [existing])).toThrow(/上書き/);
    expect(() => assertPublicFactsRowsMatch([row(1)], [{ ...row(1), description: "changed" }])).toThrow(/description/);
  });

  it("結果不明後は再送を禁止し、readbackへ進まない", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yutai-public-facts-"));
    try {
      const plan = planPublicFactsBackfill(source([row(1)]), [row(1)]);
      const sender = vi.fn(async () => { throw new Error("outcome unknown"); });
      const readback = vi.fn(async () => plan.expected);
      const input = { dir, expected: plan.expected, statements: plan.statements, sender, readback };
      await expect(applyPublicFactsBackfillOnce(input)).rejects.toThrow(/unknown/);
      await expect(applyPublicFactsBackfillOnce(input)).rejects.toThrow(/EEXIST/);
      expect(sender).toHaveBeenCalledTimes(1); expect(readback).not.toHaveBeenCalled();
      expect(existsSync(join(dir,"applied.json"))).toBe(false);
    } finally { rmSync(dir,{ recursive:true,force:true }); }
  });

  it("成功応答でも全列readbackが異なれば完了扱いしない", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yutai-public-facts-"));
    try {
      const plan = planPublicFactsBackfill(source([row(1)]), [row(1)]);
      await expect(applyPublicFactsBackfillOnce({ dir, ...plan, sender: async () => {}, readback: async () => [{ ...plan.expected[0], createdAt: 1 }] })).rejects.toThrow(/createdAt/);
      expect(existsSync(join(dir,"readback.json"))).toBe(true);
      expect(existsSync(join(dir,"applied.json"))).toBe(false);
    } finally { rmSync(dir,{ recursive:true,force:true }); }
  });
});
