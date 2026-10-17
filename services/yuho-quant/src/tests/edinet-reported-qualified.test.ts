/** Declared list/master protocol projections of actual 3106 metadata; not observed withdrawals or fresh master qualification. */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { describe, expect, it } from "vitest";
import { openActualSnapshot, readSnapshot, type Snapshot } from "../../data-scripts/lib/saved-overseas-atomic.js";
import type { Database } from "../db/client.js";
import { edinetListResponseSchema } from "../services/edinet/types.js";
import { recordReportedChanges, assertReportedDocumentUsable, reportedDocumentsHoldQuery, assertReportedDocumentsResult } from "../services/edinet/reported-changes.js";
import { loadLatestDocs } from "../biztag/source.js";
import { selectLatestHoldingsDocuments } from "../../data-scripts/lib/shareholdings-backfill.js";
import { getOrderTrend, listSectorsWithOrders } from "../services/order-query.js";
import { getLatestTextSections } from "../services/text-sections-query.js";
import { stockDetailPage } from "../views/stock-detail.js";

const before=JSON.parse(readFileSync(new URL("./fixtures/order-saved-3106/snapshot.json",import.meta.url),"utf8")) as Snapshot;
const raw=JSON.parse(readFileSync(new URL("./fixtures/edinet-reported-lineage.json",import.meta.url),"utf8")).entries.find((e:{original:{docID:string}})=>e.original.docID==="S100YSGA");
const current=before.yuho_documents.find(d=>d.doc_id==="S100YIYE")!, stock=before.core_stocks[0];
function open(){
 const sqlite=openActualSnapshot(process.cwd(),before),queries:Array<{sql:string;params:unknown[]}>=[];
 sqlite.exec("create table jss_notion_pages(code text,db text,page_id text,primary key(code,db))");
 sqlite.prepare("insert into jss_notion_pages values (?,'stock_master_by_edinet',?)").run(current.edinet_code as string,stock.code as string);
 const db=drizzle(async(sql,params,method)=>{queries.push({sql,params});const stmt=sqlite.prepare(sql), names=stmt.columns().map(c=>c.name);
  if(method==="run"){stmt.run(...params as never[]);return{rows:[]};}
  const rows=(stmt.all(...params as never[]) as Record<string,unknown>[]).map(r=>names.map(n=>r[n]));return{rows:method==="get"?rows[0]:rows};}) as unknown as Database;
 return{sqlite,db,queries};
}
function projection(changes:Record<string,unknown>={}){
 const doc={...raw.original,docID:current.doc_id,edinetCode:current.edinet_code,secCode:`${stock.code}0`,filerName:current.filer_name,
  docTypeCode:current.doc_type_code,periodEnd:current.period_end,docDescription:null,
  submitDateTime:new Date((current.submitted_at as number)*1000).toISOString().slice(0,16).replace("T"," "),docInfoEditStatus:"1",withdrawalStatus:"0",disclosureStatus:"0",...changes};
 const list=edinetListResponseSchema.parse({metadata:{status:"200",message:"OK",resultset:{count:1}},results:[doc]});
 const bytes=Buffer.from(JSON.stringify(list)),sha=createHash("sha256").update(bytes).digest("hex");
 const snapshot={date:raw.source.date,pageId:raw.source.retainedArchive[0].pageId,filename:`edinet-list-${raw.source.date}.json.gz`,
  gzipSha256:sha,rawSha256:sha,rawBytes:bytes.length,httpStatus:200,qualified:true,fetchedAt:`${raw.source.date}T12:00:00.000Z`};
 return{list,snapshot}; // declared capture transport; raw original and 3106 six-table source remain unchanged
}

describe("qualified reported metadata with no ingested document row",()=>{
 it("same immutable source projection protects latest selection and public summary without inventing an ingested row or numeric point",async()=>{
  const {sqlite,db,queries}=open();try{
   sqlite.prepare("delete from yuho_order_facts where document_id=?").run(current.id as number);
   sqlite.prepare("delete from yuho_text_sections where document_id=?").run(current.id as number);
   sqlite.prepare("delete from yuho_documents where id=?").run(current.id as number);
   const unchanged=readSnapshot(sqlite,stock.id as number),p=projection();await recordReportedChanges(db,p.list,p.snapshot,()=>false);
   const obs=sqlite.prepare("select stock_id,period_end,submitted_at from yuho_edinet_reported_changes").get();
   expect(obs).toEqual({stock_id:stock.id,period_end:current.period_end,submitted_at:current.submitted_at});
   expect(queries.filter(q=>q.sql.includes('"jss_notion_pages"')).length).toBe(1);
   expect(queries.every(q=>q.params.length<=100)).toBe(true);
   expect((await loadLatestDocs(db))[0].reportedHoldReason).toBeDefined();
   expect((await selectLatestHoldingsDocuments(db,{afterCode:null,limit:1})).rows[0].reportedHoldReason).toBeDefined();
   const trend=(await getOrderTrend(db,stock.id as number))!;
   expect(trend.documents[0]).toMatchObject({docId:current.doc_id,parseStatus:"reported_document_hold",origin:"reported_observation"});
   expect(trend.points.some(p=>p.fiscalYearEnd===current.period_end)).toBe(false);
   expect(stockDetailPage(trend,null).includes('class="latest-stat"')).toBe(false);
   expect(await listSectorsWithOrders(db)).toEqual([]);
   expect(readSnapshot(sqlite,stock.id as number)).toEqual(unchanged);
   await recordReportedChanges(db,p.list,p.snapshot,()=>false);
   expect(sqlite.prepare("select count(*) as n from yuho_edinet_reported_changes").get()).toEqual({n:1});
  }finally{sqlite.close();}
 });
 it("complete same-FY later metadata protects normal source/set checks before PRE; a newer independent 130 remains usable",async()=>{
  const {sqlite,db}=open();try{
   const p=projection();await recordReportedChanges(db,p.list,p.snapshot,()=>false);
   await expect(assertReportedDocumentUsable(db,current.doc_id as string)).rejects.toThrow();
   const q=reportedDocumentsHoldQuery([current.doc_id as string]);expect(q.params).toEqual([current.doc_id]);
   expect(()=>assertReportedDocumentsResult([current.doc_id as string],sqlite.prepare(q.sql).all(...q.params) as Record<string,unknown>[])).toThrow();
   // Declared newer standalone correction: original parent row is kept, new ID/clock are an explicit protocol fault.
   const parent=before.yuho_documents.find(d=>d.doc_id==="S100W3NJ")!;
   sqlite.prepare("update yuho_documents set period_end=?,doc_type_code='130',submitted_at=? where id=?").run(current.period_end as string,(current.submitted_at as number)+60,parent.id as number);
   await expect(assertReportedDocumentUsable(db,parent.doc_id as string)).resolves.toBeUndefined();
   expect((await loadLatestDocs(db))[0].reportedHoldReason).toBeUndefined();
   expect((await selectLatestHoldingsDocuments(db,{afterCode:null,limit:1})).rows[0].reportedHoldReason).toBeUndefined();
  }finally{sqlite.close();}
 });
 it.each([{periodEnd:null},{periodEnd:"2026-02-30"},{periodEnd:"2099-01-01"},{submitDateTime:"2026-06-31 12:00"},{submitDateTime:"2026-06-30 25:00"},{submitDateTime:"2026-06-30"},{filerName:null},{secCode:null},{edinetCode:null}])("incomplete/invalid reported metadata stays nullable without an identity lookup: %j",async fault=>{
  const {sqlite,db,queries}=open();try{
   const p=projection(fault);await recordReportedChanges(db,p.list,p.snapshot,()=>false);
   expect(sqlite.prepare("select stock_id,period_end,submitted_at from yuho_edinet_reported_changes").get()).toEqual({stock_id:null,period_end:null,submitted_at:null});
   expect(queries.some(q=>q.sql.includes('"jss_notion_pages"'))).toBe(false);
  }finally{sqlite.close();}
 });
 it("issuer/ticker map disagreement never binds a different company; known null-metadata withdrawal does not guess its parent",async()=>{
  const {sqlite,db}=open();try{
   sqlite.prepare("delete from jss_notion_pages").run();
   const p=projection();await recordReportedChanges(db,p.list,p.snapshot,()=>false);
   expect(sqlite.prepare("select stock_id from yuho_edinet_reported_changes").get()).toEqual({stock_id:null});
  }finally{sqlite.close();}
 });
 it("same-FY latest known-HOLD with section0 refuses an older parent section before any Notion read",async()=>{
  const {sqlite,db}=open();try{
   sqlite.prepare("delete from yuho_text_sections where document_id=?").run(current.id as number);
   sqlite.prepare("update yuho_documents set period_end=? where doc_id='S100W3NJ'").run(current.period_end as string);
   sqlite.prepare("update yuho_text_sections set fiscal_year_end=? where document_id=(select id from yuho_documents where doc_id='S100W3NJ')").run(current.period_end as string);
   const p=projection();await recordReportedChanges(db,p.list,p.snapshot,()=>false);
   await expect(getLatestTextSections(db,stock.id as number)).rejects.toThrow(current.doc_id as string);
  }finally{sqlite.close();}
 });
});
