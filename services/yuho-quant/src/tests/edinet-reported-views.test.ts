/** Saved source values; HOLD/fact absence below are declared offline protocol faults. */
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { expect, it } from "vitest";
import type { Database } from "../db/client.js";
import { openActualSnapshot, readSnapshot, type Snapshot } from "../../data-scripts/lib/saved-overseas-atomic.js";
import { getOrderTrend } from "../services/order-query.js";
import type { OverseasTrend } from "../services/overseas-query.js";
import type { OverseasFact } from "../services/overseas-parser.js";
import { toOverseasSaveRows } from "../services/overseas-save-rows.js";
import { REPORTED_DOCUMENT_HOLD_REASON } from "../services/edinet/reported-changes.js";
import { stockDetailPage } from "../views/stock-detail.js";
import { overseasSection } from "../views/overseas-section.js";

const chart = (html: string) => html.match(/<svg[\s\S]*?<\/svg>/)?.[0];

it("actual3106 latest HOLD with no facts cannot replace its current summary with an older FY", async () => {
  const before = JSON.parse(readFileSync(new URL("./fixtures/order-saved-3106/snapshot.json", import.meta.url), "utf8")) as Snapshot;
  const sqlite = openActualSnapshot(process.cwd(), before);
  const db = drizzle(async (query, args, method) => {
    const statement = sqlite.prepare(query), params = args as (string | number | null)[];
    const names = statement.columns().map(column => column.name);
    const rows = (statement.all(...params) as Record<string, unknown>[]).map(row => names.map(name => row[name]));
    return { rows: method === "get" ? rows[0] : rows };
  }) as unknown as Database;
  try {
    // Only the fact-absence/HOLD protocol changes; actual original documents and old FY values remain.
    sqlite.exec("delete from yuho_order_facts where document_id=(select id from yuho_documents where doc_id='S100YIYE')");
    const normal = (await getOrderTrend(db, 2243))!, normalHtml = stockDetailPage(normal, null);
    expect(normalHtml).toContain('class="latest-stat"');
    expect(chart(normalHtml)).toBeDefined();
    sqlite.prepare("insert into yuho_edinet_reported_changes (source_page_id,seq_number,source_raw_sha256,doc_id,parent_doc_id,reported_state,observation_json) values (?,?,?,?,?,?,?)")
      .run("declared-view-protocol", 1, "declared-not-original-SHA", "S100YIYE", null, "reported_withdrawal", "{}");
    const held = (await getOrderTrend(db, 2243))!, stored = readSnapshot(sqlite, 2243), html = stockDetailPage(held, null);
    expect(held.points).toEqual(normal.points);
    expect(held.points.some(point => point.fiscalYearEnd === held.documents[0].periodEnd)).toBe(false);
    expect(html).not.toContain('class="latest-stat"');
    expect(html).toContain(`${held.documents[0].periodEnd}: ${REPORTED_DOCUMENT_HOLD_REASON}`);
    expect(chart(html)).toBe(chart(normalHtml));
    expect(readSnapshot(sqlite, 2243)).toEqual(stored);
    const unimported = stockDetailPage({ ...held, documents: [{ ...held.documents[0], origin: "reported_observation" }, ...held.documents.slice(1)] }, null);
    expect(unimported).toContain("提出書類一覧で確認");
    expect(unimported).not.toContain("SOURCE — 取り込んだ有報");
    expect(unimported).not.toContain('class="latest-stat"');
    // A distinct historical HOLD must not suppress a normally selected current-document summary.
    const historical = normal.documents.at(-1)!;
    expect(historical.periodEnd).not.toBe(normal.documents[0].periodEnd);
    expect(stockDetailPage({ ...normal, documents: normal.documents.map(doc => doc === historical
      ? { ...doc, parseStatus: "reported_document_hold" } : doc) }, null)).toContain('class="latest-stat"');
  } finally { sqlite.close(); }
});

it("actual372A overseas values retain their chart while a declared current-document HOLD suppresses the summary", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/overseas-omission-records.actual.json", import.meta.url), "utf8"))
    .find((row: { code: string }) => row.code === "372A") as {
      code: string; metadata: { filerName: string; docTypeCode: string; submittedAt: string };
      record: { docId: string; periodEnd: string }; status: string; facts: OverseasFact[];
    };
  const rows = toOverseasSaveRows(fixture.facts, fixture.status as "ok_geo_rows");
  const total = rows.find(row => row.regionKind === "total")!, overseas = rows.find(row => row.regionKind === "overseas_total")!;
  const normal: OverseasTrend = {
    // ID is an offline routing control, unused by this view; all displayed source values are actual.
    stock: { id: 1, code: fixture.code, name: fixture.metadata.filerName, market: null, sector: null },
    documents: [{ docId: fixture.record.docId, periodEnd: fixture.record.periodEnd,
      submittedAt: new Date(fixture.metadata.submittedAt.replace(" ", "T") + ":00+09:00"), docTypeCode: fixture.metadata.docTypeCode,
      overseasParseStatus: fixture.status, overseasOmission: null }],
    points: [{ fiscalYearEnd: total.fiscalYearEnd, isConsolidated: total.isConsolidated, unitLabel: total.unitLabel,
      totalYen: total.salesYen, overseasYen: overseas.salesYen, ratioPct: overseas.ratioPct,
      domesticYen: rows.find(row => row.regionKind === "domestic")!.salesYen, regions: rows.filter(row => row.regionKind === "overseas")
        .map(row => ({ name: row.regionName, yen: row.salesYen, ratioPct: row.ratioPct })) }], hasStructuredData: true,
  };
  const original = JSON.stringify(normal), normalHtml = overseasSection(normal);
  expect(normalHtml).toContain('class="latest-stat"');
  expect(chart(normalHtml)).toBeDefined();
  // Declared document-status fault only; source point/chart values are not overwritten or inferred.
  const held: OverseasTrend = { ...normal, documents: [{ ...normal.documents[0], overseasParseStatus: "reported_document_hold" }] };
  const html = overseasSection(held);
  expect(html).not.toContain('class="latest-stat"');
  expect(html).toContain(`${fixture.record.periodEnd}: ${REPORTED_DOCUMENT_HOLD_REASON}`);
  expect(chart(html)).toBe(chart(normalHtml));
  expect(JSON.stringify(normal)).toBe(original);
  expect(overseasSection(normal)).toBe(normalHtml);
  const unimported = overseasSection({ ...held, documents: [{ ...held.documents[0], origin: "reported_observation" }] });
  expect(unimported).toContain("提出書類一覧で確認");
  expect(unimported).not.toContain('class="latest-stat"');
});
