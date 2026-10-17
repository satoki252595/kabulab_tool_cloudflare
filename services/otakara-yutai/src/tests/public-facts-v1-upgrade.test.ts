/** Labelled protocol rows + optional actual saved23-row snapshot. No network/production writes. */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import type { D1BatchStatement } from "../../../../src/shared/db/d1-http-client.js";
import { assertPublicFactsUpgradeReady, claimPublicFactsUpgrade, planPublicFactsV1Upgrade, parsePublicFactsUpgradeScope,
  applyPublicFactsBackfillOnce, type PublicFactsPreimage, type PublicFactsUpgradeScope } from "../../data-scripts/backfill-public-facts.js";
import { benefitKey } from "../../data-scripts/benefit-key.js";
import { buildPublicBenefitFacts } from "../../data-scripts/public-facts.js";
import { parsePublicBenefitFacts } from "../public-facts.js";
import saved from "./fixtures/choice-list-saved15.json";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const source = (rows: PublicFactsPreimage[]) => rows.map(({ genreId, createdAt, publicFacts, ...value }) => {
  void genreId; void createdAt; void publicFacts; return value;
});
const dirs: string[] = [];
const dir = () => { const p = mkdtempSync(join(tmpdir(), "yutai-v1-upgrade-")); dirs.push(p); return p; };
afterEach(() => { for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true }); vi.unstubAllGlobals(); });

function protocolRows(): PublicFactsPreimage[] {
  // 文法・CAS試験専用。実制度を表す値ではない。
  const description = '【種別："カタログギフトまたは食事券"】\n◆以下より1点を選択\n1、カタログギフト 1,000円相当\n2、食事券 2,000円分';
  const next = buildPublicBenefitFacts({ code: "7203", description, context: { minShares: [100], recordMonths: [3] }, fetchedAt: null, batchFetchedAt: null });
  if (next.version !== 2) throw new Error("v2 producer required");
  const { conditionStructure, ...fields } = next; void conditionStructure;
  const row = { id: 1, stockId: 1, stockCode: "7203", stockName: "試験専用", genreId: 1, description,
    shortSummary: "優待を1点選択", estimatedValue: null, estimateValueSource: null, minShares: 100, recordMonth: 3, recordDate: null,
    createdAt: 1, updatedAt: 2, publicFacts: JSON.stringify({ ...fields, version: 1 }) };
  return [row, { ...row, id: 2, description: "別の試験専用商品", publicFacts: null }];
}
function scope(rows: PublicFactsPreimage[]): PublicFactsUpgradeScope {
  const first = rows[0];
  return parsePublicFactsUpgradeScope({ version: 1, groups: [{ code: first.stockCode, taskId: benefitKey(first.stockCode, first.description),
    sourceSha256: sha(first.description), rows: 1, recipients: [{ minShares: first.minShares, recordMonth: first.recordMonth, recordDate: first.recordDate }] }] });
}
function database(rows: PublicFactsPreimage[]) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE core_stocks(id INTEGER PRIMARY KEY,code TEXT,name TEXT,is_active INTEGER,instrument_type TEXT); CREATE TABLE yutai_benefits(id INTEGER PRIMARY KEY,stock_id INTEGER,genre_id INTEGER,description TEXT,short_summary TEXT,min_shares INTEGER,record_month INTEGER,record_date TEXT,estimated_value INTEGER,estimate_value_source TEXT,created_at INTEGER,updated_at INTEGER,public_facts TEXT)");
  for (const r of new Map(rows.map(row => [row.stockId, row])).values()) db.prepare("INSERT INTO core_stocks VALUES(?,?,?,1,'equity')").run(r.stockId, r.stockCode, r.stockName);
  for (const r of rows) db.prepare("INSERT INTO yutai_benefits VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(r.id,r.stockId,r.genreId,r.description,r.shortSummary,r.minShares,r.recordMonth,r.recordDate,r.estimatedValue,r.estimateValueSource,r.createdAt,r.updatedAt,r.publicFacts);
  const read = () => db.prepare("SELECT * FROM yutai_benefits ORDER BY id").all();
  const send = async (statements: readonly D1BatchStatement[]) => {
    db.exec("BEGIN"); try { for (const s of statements) db.prepare(s.sql).all(...s.params as (string | number | null)[]); db.exec("COMMIT"); }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  return { db, read, send };
}

describe("明示v1条件だけの有限更新", () => {
  it("version/構造だけを変え、対象外の行・価格・要約・時計を全列で保持する", async () => {
    const before = protocolRows(), plan = planPublicFactsV1Upgrade(source(before), before, scope(before));
    expect(plan).toMatchObject({ groups: 1, targetRows: 1, codes: ["7203"] });
    expect(plan.expected[1]).toEqual(before[1]);
    const old = parsePublicBenefitFacts(before[0].publicFacts), next = parsePublicBenefitFacts(plan.expected[0].publicFacts);
    if (next === null || next.version !== 2) throw new Error("v2 required");
    const { conditionStructure, ...fields } = next;
    expect({ ...fields, version: 1 }).toEqual(old);
    expect(conditionStructure.status).toBe("literal_parsed");
    const { db, read, send } = database(before);
    try { const raw = read(); await send(plan.statements); expect(read()).toEqual(raw.map(row => ({ ...row, public_facts: plan.expected.find(v => v.id === row.id)!.publicFacts }))); }
    finally { db.close(); }
  });
  it.each(["description", "min_shares", "short_summary", "estimated_value", "created_at", "updated_at", "public_facts"])("対象外の%s driftでも全batchをrollbackする", async column => {
    const before = protocolRows(), plan = planPublicFactsV1Upgrade(source(before), before, scope(before)), { db, read, send } = database(before);
    try { db.prepare(`UPDATE yutai_benefits SET ${column}=? WHERE id=2`).run(["description", "short_summary", "public_facts"].includes(column) ? "changed" : 9);
      const drift = read(); await expect(send(plan.statements)).rejects.toThrow(); expect(read()).toEqual(drift); }
    finally { db.close(); }
  });
  it("scope追加行・主体変更を有限count/full identity guardで止める", async () => {
    const before = protocolRows(), plan = planPublicFactsV1Upgrade(source(before), before, scope(before));
    for (const sql of ["INSERT INTO yutai_benefits SELECT 3,stock_id,genre_id,description,short_summary,min_shares,record_month,record_date,estimated_value,estimate_value_source,created_at,updated_at,public_facts FROM yutai_benefits WHERE id=2", "UPDATE core_stocks SET name='changed'", "UPDATE core_stocks SET is_active=0"]) {
      const { db, read, send } = database(before); try { db.exec(sql); const drift = read(); await expect(send(plan.statements)).rejects.toThrow(); expect(read()).toEqual(drift); } finally { db.close(); }
    }
  });
  it("NULL/v2/未知・旧v1意味差・別原文・受取条件欠けを読取/送信前に拒否する", () => {
    const before = protocolRows(), fixed = scope(before), plan = planPublicFactsV1Upgrade(source(before), before, fixed);
    const old = JSON.parse(before[0].publicFacts!);
    for (const publicFacts of [null, plan.expected[0].publicFacts, "{}", JSON.stringify({ ...old, lottery: true })]) {
      const rows = [{ ...before[0], publicFacts }, before[1]];
      expect(() => planPublicFactsV1Upgrade(source(rows), rows, fixed)).toThrow();
    }
    expect(() => planPublicFactsV1Upgrade(source(before), before, { ...fixed, groups: [{ ...fixed.groups[0], sourceSha256: "a".repeat(64) }] })).toThrow();
    expect(() => parsePublicFactsUpgradeScope({ ...fixed, groups: [...fixed.groups, ...fixed.groups] })).toThrow();
    expect(() => parsePublicFactsUpgradeScope({ ...fixed, groups: [{ ...fixed.groups[0], rows: 2 }] })).toThrow();
    expect(() => planPublicFactsV1Upgrade(source(before.slice(0,1)), before.slice(0,1), { ...fixed, groups: [{ ...fixed.groups[0], rows: 2, recipients: [...fixed.groups[0].recipients, { minShares: 1000, recordMonth: 3, recordDate: null }] }] })).toThrow();
  });
  it("canonical一度latchはunknown後の別output/別PREもHTTP0で止め、旧bytesを保持する", () => {
    const state = join(dir(), "state"), native = vi.fn(); vi.stubGlobal("fetch", native);
    claimPublicFactsUpgrade(state, { scopeSha256: "a".repeat(64), output: "first" });
    const path = join(state, "upgrade-v1-started.json"), original = readFileSync(path);
    expect(() => assertPublicFactsUpgradeReady(state)).toThrow(/再送/);
    expect(() => claimPublicFactsUpgrade(state, { scopeSha256: "b".repeat(64), output: "different" })).toThrow(/再送/);
    expect(readFileSync(path).equals(original)).toBe(true); expect(native).not.toHaveBeenCalled();
  });
  it("fullPOST成功後も物理POSTunknownなら完了markerを作らず再送しない", async () => {
    const before = protocolRows(), plan = planPublicFactsV1Upgrade(source(before), before, scope(before)), output = dir(), sender = vi.fn(async () => {});
    await expect(applyPublicFactsBackfillOnce({ dir: output, ...plan, sender, readback: async () => plan.expected,
      verifyPost: async () => { throw new Error("physical POST unknown"); } })).rejects.toThrow(/POST unknown/);
    expect(existsSync(join(output, "readback.json"))).toBe(true); expect(existsSync(join(output, "applied.json"))).toBe(false);
    await expect(applyPublicFactsBackfillOnce({ dir: output, ...plan, sender, readback: async () => plan.expected })).rejects.toThrow(); expect(sender).toHaveBeenCalledOnce();
  });

  const actualPath = join(ROOT, "tmp/v1-upgrade-saved15-v1/actual-scoped.private.json");
  it.skipIf(!existsSync(actualPath))("保存実23行を正常planner/SQLiteへ通し、15群19行だけ更新・他4行全値不変・再送拒否", async () => {
    const bytes = readFileSync(actualPath); expect(sha(bytes)).toBe("b205478fe66369d68596d15af5300a2f1bac581631e05f1d656f6f5c3acd6f85");
    const rows = JSON.parse(bytes.toString()) as PublicFactsPreimage[];
    const fixed = parsePublicFactsUpgradeScope({ version: 1, groups: saved.groups.map(({ code, taskId, sourceSha256, rows, recipients }) => ({ code, taskId, sourceSha256, rows, recipients })) });
    const plan = planPublicFactsV1Upgrade(source(rows), rows, fixed);
    expect(plan).toMatchObject({ groups: 15, targetRows: 19, codes: ["3148", "7585", "8278"] });
    expect(plan.expected.filter((row,i) => row.publicFacts !== rows[i].publicFacts)).toHaveLength(19);
    for (const [index, row] of plan.expected.entries()) expect(sha(JSON.stringify({ ...row, publicFacts: rows[index].publicFacts }))).toBe(sha(JSON.stringify(rows[index])));
    const { db, read, send } = database(rows); try { const before = read(); await send(plan.statements); expect(sha(JSON.stringify(read()))).toBe(sha(JSON.stringify(before.map(row => ({ ...row, public_facts: plan.expected.find(v => v.id === row.id)!.publicFacts })))));
      const accepted = read(); await expect(send(plan.statements)).rejects.toThrow(); expect(sha(JSON.stringify(read()))).toBe(sha(JSON.stringify(accepted))); }
    finally { db.close(); }
  });
});
