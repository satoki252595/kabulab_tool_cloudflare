import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Database } from "../db/client.js";
import { yuhoDocuments, overseasSalesFacts } from "../db/schema.js";
import { stocks } from "../../../../src/shared/db/core-schema.js";
import { serializeOverseasOmission, parseOverseasOmission, validateOverseasOmission, type OverseasOmissionRecord } from "../services/overseas-omission.js";
import { toOverseasSaveRows } from "../services/overseas-save-rows.js";
import type { OverseasFact, OverseasParseStatus } from "../services/overseas-parser.js";
import { getOverseasTrendByCode } from "../services/overseas-query.js";
import { overseasSection } from "../views/overseas-section.js";

const fixtureBytes = readFileSync(new URL("./fixtures/overseas-omission-records.actual.json", import.meta.url));
const fixtures = JSON.parse(fixtureBytes.toString()) as Array<{
  code: string;
  metadata: { edinetCode: string; filerName: string; docTypeCode: string; submittedAt: string; parseStatus: string };
  record: OverseasOmissionRecord; status: OverseasParseStatus; facts: OverseasFact[];
}>;
const provenance = JSON.parse(readFileSync(new URL("./fixtures/overseas-omission-records.provenance.json", import.meta.url), "utf8"));
const identity = (fixture: (typeof fixtures)[number]) => ({ ...fixture.record, edinetCode: fixture.metadata.edinetCode });
let sqlite: DatabaseSync;
let db: Database;

beforeEach(async () => {
  sqlite = new DatabaseSync(":memory:");
  const migrations = new URL("../../../../drizzle/d1/", import.meta.url);
  for (const name of readdirSync(migrations).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort()) {
    sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  const prepare = (query: string) => {
    const make = (params: unknown[]) => ({
      bind: (...next: unknown[]) => make(next),
      raw: async () => {
        const statement = sqlite.prepare(query);
        statement.setReturnArrays(true);
        return statement.all(...params as never[]);
      },
      all: async () => ({ results: sqlite.prepare(query).all(...params as never[]), success: true }),
      run: async () => ({ results: [], success: true, meta: sqlite.prepare(query).run(...params as never[]) }),
    });
    return make([]);
  };
  db = createDb({ prepare } as never);
  for (const [index, fixture] of fixtures.entries()) {
    // PK/marketは明示offline SQLite schema control。本番入力へ到達せず、市場filter受入は対象外。
    // 会社・文書・日付・数値・理由は実fullZIPに由来する。
    const id = index + 1;
    await db.insert(stocks).values({ id, code: fixture.code, name: fixture.metadata.filerName, market: "OFFLINE_SCHEMA_CONTROL" });
    await db.insert(yuhoDocuments).values({ id, stockId: id, docId: fixture.record.docId,
      edinetCode: fixture.metadata.edinetCode, filerName: fixture.metadata.filerName,
      docTypeCode: fixture.metadata.docTypeCode, periodEnd: fixture.record.periodEnd,
      submittedAt: new Date(fixture.metadata.submittedAt.replace(" ", "T") + ":00+09:00"),
      parseStatus: fixture.metadata.parseStatus, overseasParseStatus: fixture.status });
    const facts = toOverseasSaveRows(fixture.facts, fixture.status);
    if (facts.length > 0) await db.insert(overseasSalesFacts).values(facts.map((fact) => ({ ...fact, documentId: id, stockId: id })));
  }
});
afterEach(() => sqlite.close());

it("実fullZIPの理由をnullable1列からquery/viewへ渡し、別表の数値と旧statusを保持する", async () => {
  expect(createHash("sha256").update(fixtureBytes).digest("hex")).toBe(provenance.fixtureSha256);
  const beforeFacts = sqlite.prepare("SELECT * FROM yuho_overseas_facts ORDER BY id").all();
  const beforeDocs = sqlite.prepare("SELECT * FROM yuho_documents ORDER BY id").all();
  for (const fixture of fixtures) {
    const json = serializeOverseasOmission(identity(fixture));
    expect(parseOverseasOmission(json, identity(fixture))).toEqual(fixture.record);
    await db.update(yuhoDocuments).set({ overseasOmissionJson: json }).where(eq(yuhoDocuments.docId, fixture.record.docId));
    const trend = await getOverseasTrendByCode(db, fixture.code);
    expect(trend!.documents[0].overseasParseStatus).toBe(fixture.status);
    expect(trend!.documents[0].overseasOmission).toEqual(fixture.record);
    const html = overseasSection(trend);
    expect(html).toContain(fixture.record.omission.evidence[0].quote);
    expect(html).not.toContain(fixture.record.zipSha256);
    expect(html).not.toContain(fixture.record.omission.evidence[0].honbunFile);
    expect(html).toContain(fixture.record.docId);
    expect(html).not.toContain(fixture.record.archivePageId);
    expect(html).not.toContain("OFFLINE_SCHEMA_CONTROL");
    expect(html).toContain('class="tip"');
    expect(html).toContain('<details class="omission-proof">');
    if (fixture.facts.length > 0) {
      expect(trend!.hasStructuredData).toBe(true);
      expect(html).toContain("YEARLY");
    } else expect(html).toContain("未対応");
  }
  expect(sqlite.prepare("SELECT * FROM yuho_overseas_facts ORDER BY id").all()).toEqual(beforeFacts);
  const afterDocs = sqlite.prepare("SELECT * FROM yuho_documents ORDER BY id").all();
  expect(afterDocs.map((row) => ({ ...row, overseas_omission_json: null }))).toEqual(beforeDocs);
});

it("NULLは理由未保存のまま、非開示・内需・90%を作らない", async () => {
  const fixture = fixtures[0];
  expect(parseOverseasOmission(null, identity(fixture))).toBeNull();
  const trend = await getOverseasTrendByCode(db, fixture.code);
  expect(trend!.documents[0].overseasOmission).toBeNull();
  const html = overseasSection(trend);
  expect(html).not.toContain("地域別の外部顧客売上の注記を省略");
  expect(html).not.toContain("内需企業");
  expect(html).not.toContain("90%");
  expect(html).not.toContain("売上の開示なし");
});

it("文書/FY不一致・無根拠理由・壊れたSHA・native期間不一致は受入しない", () => {
  const record = fixtures[0].record;
  const expected = identity(fixtures[0]);
  const wrongDoc = { ...record, docId: fixtures[1].record.docId };
  expect(() => validateOverseasOmission(wrongDoc, expected)).toThrow();
  expect(() => validateOverseasOmission(record, { ...expected, edinetCode: fixtures[1].metadata.edinetCode })).toThrow();
  for (const mutate of [
    (r: OverseasOmissionRecord) => { r.periodEnd = fixtures[1].record.periodEnd; },
    (r: OverseasOmissionRecord) => { r.omission.evidence = []; },
    (r: OverseasOmissionRecord) => { r.zipSha256 = ""; },
    (r: OverseasOmissionRecord) => { r.omission.evidence[0].quote = ""; },
    (r: OverseasOmissionRecord) => { r.omission.evidence[0].contextPeriod.endDate = fixtures[1].record.periodEnd; },
  ]) {
    const bad = structuredClone(record); mutate(bad);
    expect(() => validateOverseasOmission(bad, expected)).toThrow();
  }
});

it("不正な保存JSONはqueryで失敗し、NULL理由へ黙殺しない", async () => {
  const fixture = fixtures[0];
  await db.update(yuhoDocuments).set({ overseasOmissionJson: "{" }).where(eq(yuhoDocuments.docId, fixture.record.docId));
  await expect(getOverseasTrendByCode(db, fixture.code)).rejects.toThrow();
  await db.update(yuhoDocuments).set({ overseasOmissionJson: serializeOverseasOmission(identity(fixture)),
    edinetCode: fixtures[1].metadata.edinetCode }).where(eq(yuhoDocuments.docId, fixture.record.docId));
  await expect(getOverseasTrendByCode(db, fixture.code)).rejects.toThrow("提出者");
});
