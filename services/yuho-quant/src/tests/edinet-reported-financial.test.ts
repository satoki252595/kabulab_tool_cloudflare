/** Actual 3106 six-table PRE; reported-state mutations below are declared protocol faults, not observed withdrawals. */
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { describe, expect, it } from "vitest";
import type { Database } from "../db/client.js";
import { buildOrdersAtomicWithCommonProjection, openActualSnapshot, readSnapshot, type Snapshot } from "../../data-scripts/lib/saved-overseas-atomic.js";
import { parseOrderData } from "../services/edinet/order-parser.js";
import { getOrderTrend, screenOrderGrowth, listSectorsWithOrders } from "../services/order-query.js";
import { screenOverseasGrowth, listSectorsWithOverseas } from "../services/overseas-query.js";
import { loadLatestDocs } from "../biztag/source.js";
import { getLatestTextSections } from "../services/text-sections-query.js";
import { selectLatestHoldingsDocuments } from "../../data-scripts/lib/shareholdings-backfill.js";
import { reportedGrowthHold, REPORTED_DOCUMENT_HOLD_REASON } from "../services/edinet/reported-changes.js";
import { yuhoGrowthProjection as projection } from "../../../../src/shared/db/projection-schema.js";

const before = JSON.parse(readFileSync(new URL("./fixtures/order-saved-3106/snapshot.json", import.meta.url), "utf8")) as Snapshot;
function open(snapshot:Snapshot=before) {
  const sqlite = openActualSnapshot(process.cwd(), snapshot);
  const db = drizzle(async (query, args, method) => {
    const stmt = sqlite.prepare(query), params = args as (number | string | null)[];
    if (method === "run") { stmt.run(...params); return { rows: [] }; }
    const names = stmt.columns().map(column => column.name);
    const rows = (stmt.all(...params) as Record<string, unknown>[]).map(row => names.map(name => row[name]));
    return { rows: method === "get" ? rows[0] : rows };
  }) as unknown as Database;
  const hold = (docId: string, state = "reported_withdrawal") => sqlite.prepare(
    "insert into yuho_edinet_reported_changes (source_page_id,seq_number,source_raw_sha256,doc_id,parent_doc_id,reported_state,observation_json) values (?,?,?,?,?,?,?)"
  ).run("declared-protocol-source", 1, "declared-not-a-raw-SHA", docId, null, state,
    JSON.stringify({ kind: "declared-state-fault-on-actual-financial-baseline", docId, state }));
  return { sqlite, db, hold };
}

describe("reported exact-document HOLD never selects older financial values", () => {
  it("a real null-issuer withdrawal absent from the saved financial cohort leaves all four public consumers unchanged",async()=>{
    const saved=JSON.parse(readFileSync(new URL("./fixtures/reported-latest-3113-3382/snapshot.json",import.meta.url),"utf8")) as Snapshot;
    const original=JSON.parse(readFileSync(new URL("./fixtures/edinet-reported-lineage.json",import.meta.url),"utf8")).entries.find((entry:{original:{docID:string}})=>entry.original.docID==="S100YRSP").original;
    const {sqlite,db,hold}=open(saved);try{
      expect(original.edinetCode).toBeNull();expect(original.withdrawalStatus).toBe("1");
      expect(saved.yuho_documents.some(d=>d.doc_id===original.docID)).toBe(false);
      const values=async()=>[await screenOrderGrowth(db,{metric:"orders",minYears:1,limit:100}),await screenOverseasGrowth(db,{minYears:1,limit:100}),await listSectorsWithOrders(db),await listSectorsWithOverseas(db)];
      const old=await values();hold(original.docID);
      expect(await values()).toEqual(old);
      for(const stock of saved.core_stocks)expect(readSnapshot(sqlite,stock.id as number)).toEqual(Object.fromEntries(Object.entries(saved).map(([table,rows])=>[table,rows.filter(row=>row[table==="core_stocks"?"id":"stock_id"]===stock.id)])));
    }finally{sqlite.close();}
  });
  it("qualified latest reported metadata with no document row still masks actual 3113/3382 screens and sectors",async()=>{
    const saved=JSON.parse(readFileSync(new URL("./fixtures/reported-latest-3113-3382/snapshot.json",import.meta.url),"utf8")) as Snapshot;
    for(const [code,kind,id] of [["3113","orders","S100YHET"],["3382","overseas","S100Y4VB"]] as const){
      const {sqlite,db}=open(saved);try{
        const row=saved.yuho_documents.find(d=>d.doc_id===id)!,stock=saved.core_stocks.find(s=>s.code===code)!;
        const screen=()=>kind==="orders"?screenOrderGrowth(db,{metric:"orders",minYears:1,limit:100}):screenOverseasGrowth(db,{minYears:1,limit:100});
        const sectors=()=>kind==="orders"?listSectorsWithOrders(db):listSectorsWithOverseas(db);
        expect((await screen()).rows.some(r=>r.code===code)).toBe(true);
        // Declared absent-document protocol on unchanged actual metadata, not an observed withdrawal.
        for(const table of ["yuho_order_facts","yuho_overseas_facts","yuho_text_sections"])sqlite.prepare(`delete from ${table} where document_id=?`).run(row.id as number);
        sqlite.prepare("delete from yuho_documents where id=?").run(row.id as number);
        const unchanged=readSnapshot(sqlite,stock.id as number);
        sqlite.prepare("insert into yuho_edinet_reported_changes values (?,?,?,?,?,?,?,?,?,?)")
          .run("declared-qualified-missing-document",1,"declared-protocol",id,null,"reported_withdrawal","{}",row.stock_id as number,row.period_end as string,row.submitted_at as number);
        expect((await screen()).rows.some(r=>r.code===code)).toBe(false);expect(await sectors()).not.toContain(stock.sector33);
        expect(readSnapshot(sqlite,stock.id as number)).toEqual(unchanged);
      }finally{sqlite.close();}
    }
  });
  it("actual 3113/3382 latest FY outside the projection window cannot leave stale screens/sectors usable under a declared HOLD/fact0 fault",async()=>{
    const saved=JSON.parse(readFileSync(new URL("./fixtures/reported-latest-3113-3382/snapshot.json",import.meta.url),"utf8")) as Snapshot;
    for(const [code,kind,id] of [["3113","orders","S100YHET"],["3382","overseas","S100Y4VB"]] as const){
      const {sqlite,db,hold}=open(saved);try{
        const screen=()=>kind==="orders"?screenOrderGrowth(db,{metric:"orders",minYears:1,limit:100}):screenOverseasGrowth(db,{minYears:1,limit:100});
        const sectors=()=>kind==="orders"?listSectorsWithOrders(db):listSectorsWithOverseas(db);
        const stock=saved.core_stocks.find(s=>s.code===code)!;
        expect((await screen()).rows.some(r=>r.code===code)).toBe(true);expect(await sectors()).toContain(stock.sector33);
        // Real stored source fields/values; only the declared state and latest fact absence are protocol mutations.
        sqlite.prepare(`delete from ${kind==="orders"?"yuho_order_facts":"yuho_overseas_facts"} where document_id=(select id from yuho_documents where doc_id=?)`).run(id);
        const unchanged=readSnapshot(sqlite,stock.id as number);hold(id);
        expect((await screen()).rows.some(r=>r.code===code)).toBe(false);expect(await sectors()).not.toContain(stock.sector33);
        expect(readSnapshot(sqlite,stock.id as number)).toEqual(unchanged);
      }finally{sqlite.close();}
    }
  });
  it("actual 3382 normal newest FY is not poisoned by a qualified historical HOLD outside its public projection window",async()=>{
    const saved=JSON.parse(readFileSync(new URL("./fixtures/reported-latest-3113-3382/snapshot.json",import.meta.url),"utf8")) as Snapshot;
    const {sqlite,db}=open(saved);try{
      const old=await screenOverseasGrowth(db,{minYears:1,limit:100}), row=saved.yuho_documents.find(d=>d.doc_id==="S100VT7P")!;
      expect(old.rows.some(r=>r.code==="3382")).toBe(true);
      sqlite.prepare("insert into yuho_edinet_reported_changes (source_page_id,seq_number,source_raw_sha256,doc_id,parent_doc_id,reported_state,observation_json,stock_id,period_end,submitted_at) values (?,?,?,?,?,?,?,?,?,?)")
        .run("declared-qualified-history",1,"declared-fault",row.doc_id as string,null,"reported_withdrawal","{}",row.stock_id as number,row.period_end as string,row.submitted_at as number);
      expect(await screenOverseasGrowth(db,{minYears:1,limit:100})).toEqual(old);
    }finally{sqlite.close();}
  });
  it("declared same-FY latest-document/fact-absence protocol prevents old-parent fallback and permits a newer standalone 130", async () => {
    const { sqlite, db, hold } = open();
    try {
      const facts = sqlite.prepare("select * from yuho_order_facts order by id").all();
      // Explicit metadata faults, not actual 3106 filings: give a fact-less same-FY current doc the real retained current ID.
      sqlite.exec("update yuho_documents set period_end='2022-03-31' where doc_id='S100YIYE'");
      hold("S100YIYE");
      const blocked = (await getOrderTrend(db, 2243))?.points.find(point => point.fiscalYearEnd === "2022-03-31");
      expect(blocked?.totalOrdersYen).toBeNull(); expect(blocked?.reportedHoldReason).toBe(REPORTED_DOCUMENT_HOLD_REASON);
      expect(await listSectorsWithOrders(db)).toEqual([]);
      // A declared newer standalone 130 uses its own unchanged actual fact rows; no parent/delta inheritance is exercised.
      sqlite.exec("update yuho_documents set doc_type_code='130',submitted_at=(select submitted_at+1 from yuho_documents where doc_id='S100YIYE') where doc_id='S100OGTM'");
      const usable = (await getOrderTrend(db, 2243))?.points.find(point => point.fiscalYearEnd === "2022-03-31");
      expect(usable?.reportedHoldReason).toBeUndefined(); expect(usable?.totalOrdersYen).toBe(13537000000);
      expect(await listSectorsWithOrders(db)).not.toEqual([]);
      expect(sqlite.prepare("select * from yuho_order_facts order by id").all()).toEqual(facts);
    } finally { sqlite.close(); }
  });
  it("actual 3106 normal atomic repair rejects a declared post-PRE withdrawal with full rollback; relation-only preserves normal facts", async () => {
    const fixture = new URL("./fixtures/order-saved-3106/", import.meta.url);
    const { item } = JSON.parse(readFileSync(new URL("provenance.json", fixture), "utf8"));
    const parsed = parseOrderData(readFileSync(new URL("S100YIYE.zip", fixture)), item.periodEnd);
    const built = await buildOrdersAtomicWithCommonProjection(process.cwd(), before, item, parsed, 1792190000);
    expect(built.statements[6].sql).toMatch(/^select json\(case when \(exists/i);
    expect(built.statements[6].params).toEqual([item.docId]);
    expect(built.statements.length).toBeLessThanOrEqual(1000); expect(built.statements.every(statement => statement.params.length <= 100)).toBe(true);
    for (const state of ["reported_withdrawal", "unqualified_relation"]) {
      const { sqlite, hold } = open();
      try {
        hold(item.docId, state); // declared race after prior source qualification; original raw/financial PRE unchanged
        sqlite.exec("begin");
        try {
          for (const statement of built.statements) sqlite.prepare(statement.sql).run(...statement.params as (string | number | null)[]);
          sqlite.exec("commit"); expect(state).toBe("unqualified_relation");
        } catch (error) {
          sqlite.exec("rollback"); expect(state).toBe("reported_withdrawal"); expect(String(error)).toContain("malformed JSON");
        }
        expect(readSnapshot(sqlite, item.stockId)).toEqual(state === "reported_withdrawal" ? before : built.expected);
      } finally { sqlite.close(); }
    }
  });
  it("masks the selected actual 2022 source and stale public projection, preserving all six stored tables", async () => {
    const { sqlite, db, hold } = open();
    try {
      const old = await getOrderTrend(db, 2243);
      expect(old?.points.find(point => point.fiscalYearEnd === "2022-03-31")?.totalOrdersYen).not.toBeNull();
      expect(await listSectorsWithOrders(db)).not.toEqual([]);
      hold("S100OGTM");
      const fresh = await getOrderTrend(db, 2243), point = fresh?.points.find(value => value.fiscalYearEnd === "2022-03-31");
      expect(point?.totalOrdersYen).toBeNull(); expect(point?.totalBacklogYen).toBeNull();
      expect(point?.reportedHoldReason).toBe(REPORTED_DOCUMENT_HOLD_REASON);
      expect(fresh?.documents.find(doc => doc.docId === "S100OGTM")?.parseStatus).toBe("reported_document_hold");
      expect(await screenOrderGrowth(db, { metric: "orders", minYears: 3, limit: 100 })).toEqual({ rows: [], totalMatched: 0 });
      expect(await listSectorsWithOrders(db)).toEqual([]);
      expect(readSnapshot(sqlite, 2243)).toEqual(before);
    } finally { sqlite.close(); }
  });

  it("a historical source outside the total projection does not mask independently selected public totals", async () => {
    const { sqlite, db, hold } = open();
    try {
      const old = await getOrderTrend(db, 2243), screen = await screenOrderGrowth(db, { metric: "orders", minYears: 3, limit: 100 });
      hold("S100TQE0");
      expect((await getOrderTrend(db, 2243))?.points.filter(point => point.fiscalYearEnd !== "2024-03-31")).toEqual(old?.points.filter(point => point.fiscalYearEnd !== "2024-03-31"));
      expect(await screenOrderGrowth(db, { metric: "orders", minYears: 3, limit: 100 })).toEqual(screen);
      expect(readSnapshot(sqlite, 2243)).toEqual(before);
    } finally { sqlite.close(); }
  });

  it("reported source outside the actual five-year window cannot invalidate the current projection", async () => {
    const { sqlite, db, hold } = open();
    try {
      const old = await screenOrderGrowth(db, { metric: "orders", minYears: 3, limit: 100 });
      hold("S100G89I");
      expect(await screenOrderGrowth(db, { metric: "orders", minYears: 3, limit: 100 })).toEqual(old);
    } finally { sqlite.close(); }
  });

  it("latest selectors retain the held current doc and never fall back; relation-only current reports stay usable", async () => {
    for (const state of ["reported_withdrawal", "unqualified_relation"]) {
      const { sqlite, db, hold } = open();
      try {
        const old = await loadLatestDocs(db), oldHolding = await selectLatestHoldingsDocuments(db, { afterCode: null, limit: 1 });
        hold("S100YIYE", state);
        const actual = await loadLatestDocs(db), actualHolding = await selectLatestHoldingsDocuments(db, { afterCode: null, limit: 1 });
        expect(actual[0].doc).toEqual(old[0].doc);
        expect(actualHolding.rows[0].docId).toBe(oldHolding.rows[0].docId);
        if (state === "unqualified_relation") { expect(actual).toEqual(old); expect(actualHolding).toEqual(oldHolding); }
        else { expect(actual[0].reportedHoldReason).toBe(REPORTED_DOCUMENT_HOLD_REASON); expect(actualHolding.rows[0].reportedHoldReason).toBe(REPORTED_DOCUMENT_HOLD_REASON); }
      } finally { sqlite.close(); }
    }
  });

  it("declared current-document HOLD refuses actual text-index selection before any Notion body read", async () => {
    const { sqlite, db, hold } = open();
    try {
      hold("S100YIYE");
      await expect(getLatestTextSections(db, 2243)).rejects.toThrow(REPORTED_DOCUMENT_HOLD_REASON);
    } finally { sqlite.close(); }
  });

  it("the shared predicate executes with stock/FY/doc indexes, without a table-wide parent lookup", async () => {
    const { sqlite, db } = open();
    try {
      const query = db.select({ held: reportedGrowthHold("orders", projection.stockId, projection.ordFirstFy, projection.ordLastFy) }).from(projection).toSQL();
      const plan = sqlite.prepare(`explain query plan ${query.sql}`).all(...query.params as (string | number | null)[]);
      expect(JSON.stringify(plan)).toContain("order_facts_stock_period_idx");
      expect(JSON.stringify(plan)).toContain("yuho_edinet_reported_doc_idx");
    } finally { sqlite.close(); }
  });
});
