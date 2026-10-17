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
  planPublicFactsV1HoldingUpgrade, parsePublicFactsHoldingUpgradeScope,
  planPublicFactsV1RecordTierUpgrade, parsePublicFactsRecordTierUpgradeScope,
  applyPublicFactsBackfillOnce, type PublicFactsPreimage, type PublicFactsUpgradeScope } from "../../data-scripts/backfill-public-facts.js";
import { benefitKey } from "../../data-scripts/benefit-key.js";
import { buildPublicBenefitFacts } from "../../data-scripts/public-facts.js";
import { parsePublicBenefitFacts } from "../public-facts.js";
import saved from "./fixtures/choice-list-saved15.json";
import holdingSaved from "./fixtures/holding-period-saved4.json";
import recordTierSaved from "./fixtures/record-tier-saved1.json";

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
function holdingRows(): PublicFactsPreimage[] {
  // 文法・CAS試験専用。実制度を表す値ではない。
  const description = '【種別："オンラインショップ・クーポン（長期保有者向け）"】\n【半年以上保有】\n1,000円相当';
  const next = buildPublicBenefitFacts({ code: "7203", description, context: { minShares: [100], recordMonths: [3] }, fetchedAt: null, batchFetchedAt: null });
  if (next.version !== 3) throw new Error("v3 producer required");
  const { conditionStructure, ...fields } = next; void conditionStructure;
  const rows = protocolRows();
  rows[0] = { ...rows[0], description, publicFacts: JSON.stringify({ ...fields, version: 1 }) };
  return rows;
}
const holdingScope = (rows: PublicFactsPreimage[]) => parsePublicFactsHoldingUpgradeScope({ ...scope(rows), kind: "single-holding-period-v1" });
function recordTierRows(): PublicFactsPreimage[] {
  // 全文文法/CASの境界専用。実原文の回帰は下のprivate保存入力で行う。
  const description = '【種別："オリジナルQUOカード"】\n【1年未満保有株主】\n2,000円相当\n【1年以上保有株主】\n5,000円相当\n■継続保有期間について\n1年以上継続保有:株主名簿に3回以上記載または記録\n\n■贈呈時期\n毎年3月下旬発送予定';
  const next = buildPublicBenefitFacts({ code: "7203", description, context: { minShares: [100], recordMonths: [3] }, fetchedAt: null, batchFetchedAt: null });
  if (next.version !== 4) throw new Error("v4 producer required");
  const { conditionStructure, ...fields } = next; void conditionStructure;
  const rows = protocolRows(); rows[0] = { ...rows[0], description, publicFacts: JSON.stringify({ ...fields, version: 1 }) }; return rows;
}
const recordTierScope = (rows: PublicFactsPreimage[]) => parsePublicFactsRecordTierUpgradeScope({ ...scope(rows), kind: "holding-record-tiers-v1" });
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
  it("新record-tier modeだけが1群/1行のv4を全列CASで更新し、旧choice/holding入口を使わない", async () => {
    const before = recordTierRows(), fixed = recordTierScope(before), plan = planPublicFactsV1RecordTierUpgrade(source(before), before, fixed);
    expect(plan).toMatchObject({ groups: 1, targetRows: 1, codes: ["7203"] });
    const next = parsePublicBenefitFacts(plan.expected[0].publicFacts)!;
    expect(next).toMatchObject({ version: 4, qualifiedAmount: null, valueReasons: ["ambiguous_condition_tiers"], conditionStructure: { applicability: "unverified" } });
    if (next.version !== 4) throw new Error("v4 required");
    const { conditionStructure, ...fields } = next; void conditionStructure;
    expect({ ...fields, version: 1 }).toEqual(parsePublicBenefitFacts(before[0].publicFacts));
    expect(plan.expected[1]).toEqual(before[1]);
    expect(() => planPublicFactsV1Upgrade(source(before), before, scope(before))).toThrow();
    expect(() => planPublicFactsV1HoldingUpgrade(source(before), before, holdingScope(before))).toThrow();
    expect(() => parsePublicFactsUpgradeScope(fixed)).toThrow();
    expect(() => parsePublicFactsHoldingUpgradeScope(fixed)).toThrow();
    const { db, read, send } = database(before);
    try { const original = read(); await send(plan.statements); expect(read()).toEqual(original.map(row => ({ ...row, public_facts: plan.expected.find(v => v.id === row.id)!.publicFacts })));
      const accepted = read(); await expect(send(plan.statements)).rejects.toThrow(); expect(read()).toEqual(accepted); }
    finally { db.close(); }
  });
  it("record-tierの群/行/主体追加・原文/旧DTO差・既更新・全列driftをHTTP前又は原子rollbackで止める", async () => {
    const before = recordTierRows(), fixed = recordTierScope(before), group = fixed.groups[0], native = vi.fn(); vi.stubGlobal("fetch", native);
    for (const groups of [[group, { ...group, code: "1301", taskId: "a".repeat(16) }],
      [{ ...group, rows: 2, recipients: [group.recipients[0], { ...group.recipients[0], minShares: 200 }] }]]) {
      expect(() => parsePublicFactsRecordTierUpgradeScope({ ...fixed, groups })).toThrow();
    }
    const plan = planPublicFactsV1RecordTierUpgrade(source(before), before, fixed);
    for (const first of [{ ...before[0], publicFacts: plan.expected[0].publicFacts },
      { ...before[0], publicFacts: JSON.stringify({ ...JSON.parse(before[0].publicFacts!), qualifiedAmount: 2000 }) },
      { ...before[0], description: before[0].description + "\n同一株主番号で連続記録" }]) {
      const changed = [first, before[1]]; expect(() => planPublicFactsV1RecordTierUpgrade(source(changed), changed, fixed)).toThrow();
    }
    for (const column of ["genre_id", "description", "short_summary", "min_shares", "record_month", "record_date", "estimated_value", "estimate_value_source", "created_at", "updated_at", "public_facts"]) {
      const { db, read, send } = database(before);
      try { db.prepare(`UPDATE yutai_benefits SET ${column}=? WHERE id=2`).run(["description", "short_summary", "record_date", "estimate_value_source", "public_facts"].includes(column) ? "drift" : 9);
        const drift = read(); await expect(send(plan.statements)).rejects.toThrow(); expect(read()).toEqual(drift); }
      finally { db.close(); }
    }
    expect(native).not.toHaveBeenCalled();
  });
  const privateRecordTier = join(ROOT, "tmp/yutai-record-tier-proof-v1/saved1.private.json");
  it.skipIf(!existsSync(privateRecordTier))("実1899保存1行を同じv4 planner/SQLへ通し、元全値と12月の権利月を保持する", async () => {
    const bytes = readFileSync(privateRecordTier); expect(sha(bytes)).toBe(recordTierSaved.provenance.privateFixtureSha256);
    const original = JSON.parse(bytes.toString()), before = original.rows as PublicFactsPreimage[];
    expect(sha(before[0].description)).toBe(recordTierSaved.provenance.sourceSha256);
    const plan = planPublicFactsV1RecordTierUpgrade(source(before), before, recordTierScope(before));
    expect(plan.targetRows).toBe(1); expect(plan.expected[0]).toEqual({ ...before[0], publicFacts: expect.any(String) });
    expect(parsePublicBenefitFacts(plan.expected[0].publicFacts)).toEqual({ ...recordTierSaved.oldFacts, version: 4, conditionStructure: recordTierSaved.expectedStructure });
    const { db, read, send } = database(before);
    try { const old = read(); await send(plan.statements); expect(read()).toEqual(old.map(row => ({ ...row, public_facts: plan.expected[0].publicFacts })));
      expect(read()[0].record_month).toBe(12); expect(read()[0].record_date).toBeNull(); }
    finally { db.close(); }
  });
  it("明示holding modeだけがv3を扱い、choice scope/構造と混在しない", async () => {
    const before = holdingRows(), fixed = holdingScope(before), plan = planPublicFactsV1HoldingUpgrade(source(before), before, fixed);
    expect(plan).toMatchObject({ groups: 1, targetRows: 1, codes: ["7203"] });
    const next = parsePublicBenefitFacts(plan.expected[0].publicFacts)!;
    expect(next).toMatchObject({ version: 3, qualifiedAmount: 1000, conditionStructure: { applicability: "unverified" } });
    if (next.version !== 3) throw new Error("v3 required");
    const { version, conditionStructure, ...fields } = next; void version; void conditionStructure;
    expect({ ...fields, version: 1 }).toEqual(parsePublicBenefitFacts(before[0].publicFacts));
    expect(plan.expected[1]).toEqual(before[1]);
    const native = vi.fn(); vi.stubGlobal("fetch", native);
    expect(() => planPublicFactsV1Upgrade(source(before), before, scope(before))).toThrow();
    expect(() => parsePublicFactsUpgradeScope(fixed)).toThrow();
    expect(() => parsePublicFactsHoldingUpgradeScope(scope(before))).toThrow();
    const choice = protocolRows();
    expect(() => planPublicFactsV1HoldingUpgrade(source(choice), choice, holdingScope(choice))).toThrow();
    expect(native).not.toHaveBeenCalled();
    const { db, read, send } = database(before);
    try { const original = read(); await send(plan.statements); expect(read()).toEqual(original.map(row => ({ ...row, public_facts: plan.expected.find(v => v.id === row.id)!.publicFacts })));
      const accepted = read(); await expect(send(plan.statements)).rejects.toThrow(); expect(read()).toEqual(accepted); }
    finally { db.close(); }
  });
  it("holding scopeの4群/4行/2code上限とv3/意味差・部分原文をHTTP前に拒否する", () => {
    const before = holdingRows(), fixed = holdingScope(before), group = fixed.groups[0], native = vi.fn(); vi.stubGlobal("fetch", native);
    for (const groups of [
      Array.from({ length: 5 }, (_, index) => ({ ...group, taskId: index.toString(16).padStart(16,"0") })),
      Array.from({ length: 3 }, (_, index) => ({ ...group, code: `720${index}`, taskId: index.toString(16).padStart(16,"0") })),
      [{ ...group, rows: 5, recipients: Array.from({ length: 5 }, (_, index) => ({ ...group.recipients[0], minShares: index + 1 })) }],
    ]) expect(() => parsePublicFactsHoldingUpgradeScope({ ...fixed, groups })).toThrow();
    const plan = planPublicFactsV1HoldingUpgrade(source(before), before, fixed);
    for (const publicFacts of [plan.expected[0].publicFacts, JSON.stringify({ ...JSON.parse(before[0].publicFacts!), qualifiedAmount: 2000 })]) {
      const changed = [{ ...before[0], publicFacts }, before[1]];
      expect(() => planPublicFactsV1HoldingUpgrade(source(changed), changed, fixed)).toThrow();
    }
    const changed = [{ ...before[0], description: before[0].description + "\n同じ株主番号が必要" }, before[1]];
    expect(() => planPublicFactsV1HoldingUpgrade(source(changed), changed, fixed)).toThrow();
    expect(native).not.toHaveBeenCalled();
  });
  it("全PREを保持するholdingだけ128kまで扱い、旧choiceの64kと全target64k上限を広げない", () => {
    // 大きい対象外列の境界専用。実掲載文・実制度を表さない。
    const large = (rows: PublicFactsPreimage[], size: number) => [rows[0], { ...rows[1], description: "x".repeat(size) }];
    const holding = large(holdingRows(), 65_000);
    expect(Buffer.byteLength(JSON.stringify(holding))).toBeGreaterThan(64_000);
    expect(() => planPublicFactsV1HoldingUpgrade(source(holding), holding, holdingScope(holding))).not.toThrow();
    const choice = large(protocolRows(), 65_000);
    expect(() => planPublicFactsV1Upgrade(source(choice), choice, scope(choice))).toThrow(/有限上限/);
    const over = large(holdingRows(), 128_000);
    expect(() => planPublicFactsV1HoldingUpgrade(source(over), over, holdingScope(over))).toThrow(/有限上限/);
  });
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

  const holdingPath = join(ROOT, "tmp/holding-upgrade-pure-v1/actual-scoped.private.json");
  it.skipIf(!existsSync(holdingPath))("保存実47行から4群だけv3へ採用し、他43行・旧額・時計を全列保持する", async () => {
    const bytes = readFileSync(holdingPath); expect(sha(bytes)).toBe("f0979385aed0a710d54ce39dc7f274635f218d6233a4b7c26c1b6801711deffa");
    const rows = JSON.parse(bytes.toString()) as PublicFactsPreimage[];
    const fixed = parsePublicFactsHoldingUpgradeScope({ version: 1, kind: "single-holding-period-v1", groups: holdingSaved.groups.map(group => ({
      code: group.code, taskId: group.sourceGroup, sourceSha256: group.sourceSha256, rows: group.rows,
      recipients: rows.filter(row => benefitKey(row.stockCode, row.description) === group.sourceGroup).map(({ minShares, recordMonth, recordDate }) => ({ minShares, recordMonth, recordDate })),
    })) });
    const plan = planPublicFactsV1HoldingUpgrade(source(rows), rows, fixed);
    expect(plan).toMatchObject({ groups: 4, targetRows: 4, codes: ["2282", "9048"] });
    expect(plan.expected.filter((row,index) => row.publicFacts !== rows[index].publicFacts)).toHaveLength(4);
    for (const [index, row] of plan.expected.entries()) expect({ ...row, publicFacts: rows[index].publicFacts }).toEqual(rows[index]);
    for (const group of holdingSaved.groups) {
      const row = plan.expected.find(value => benefitKey(value.stockCode, value.description) === group.sourceGroup)!;
      expect(parsePublicBenefitFacts(row.publicFacts)).toMatchObject({ version: 3, qualifiedAmount: group.oldFacts.qualifiedAmount,
        conditionStructure: { applicability: "unverified", sourceSha256: group.sourceSha256, ast: group.ast } });
    }
    const { db, read, send } = database(rows);
    try { const before = read(); await send(plan.statements); expect(read()).toEqual(before.map(row => ({ ...row, public_facts: plan.expected.find(value => value.id === row.id)!.publicFacts })));
      const accepted = read(); await expect(send(plan.statements)).rejects.toThrow(); expect(read()).toEqual(accepted); }
    finally { db.close(); }
    const wrongChoice = { version: 1 as const, groups: fixed.groups };
    expect(() => planPublicFactsV1Upgrade(source(rows), rows, wrongChoice)).toThrow();
  });
});
