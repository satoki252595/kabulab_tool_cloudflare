import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import app from "../src/private";
import { marginDates, marginLatest, marginPage, marginSnapshot } from "../src/shared/jpx-margin";
import { handleMcp } from "../src/shared/mcp";
import type { PrivateEnv } from "../src/shared/types";
import { stubD1, stubR2 } from "./helpers";

const base = new URL("../../../tmp/feature-audit-20261013/jss-jpx-native/", import.meta.url);
const available = existsSync(new URL("2026-10-09.json", base));
const auth = { headers: { "X-API-Key": "k" } };
function native() { return JSON.parse(readFileSync(new URL("2026-10-09.json", base), "utf8")); }
const env = (VWAP: R2Bucket): PrivateEnv => ({ DB: stubD1(() => []), RAW: stubR2({}), SUPPLY: stubR2({}), VWAP, SURFACE: "private", JSS_API_KEYS: "k" });

it("日付だけのページ境界は20+1で重複せず終端へ達する", () => {
  // データ値を持たないcursor機構の構造試験。
  const dates=Array.from({length:21},(_,i)=>new Date(Date.UTC(2026,9,9-i)).toISOString().slice(0,10));
  const a=marginPage(dates,{});expect(a.selected).toHaveLength(20);expect(a.cursor).toBe(dates[20]);
  const b=marginPage(dates,{cursor:a.cursor!});expect(b.selected).toEqual([dates[20]]);expect(b.cursor).toBeNull();
  expect(()=>marginPage(dates,{cursor:"2020-01-01"})).toThrow();
});

it("壊れたindex・重複・不可能日付・過大bodyを成功にしない", async () => {
  for (const value of [{}, ["2026-02-30"], ["2026-10-09", "2026-10-09"]]) {
    await expect(marginDates(stubR2({"margin/dates.json": value}))).rejects.toThrow();
  }
  let bodyRead = false;
  const oversized = { get: async () => ({size: 128 * 1024 + 1, arrayBuffer: async () => {bodyRead = true; return new ArrayBuffer(0);}}) } as unknown as R2Bucket;
  await expect(marginDates(oversized)).rejects.toThrow(); expect(bodyRead).toBe(false);
});

it("不正なcalendar/cursorをREST/MCP双方が要求前に拒否する", async () => {
  let calls = 0; const bucket = {get: async () => {calls++; throw new Error("must not read");}} as unknown as R2Bucket;
  const e = env(bucket);
  const rest = await app.request("/v1/supply/7203?series=jpx_margin&cursor=2026-02-30", auth, e);
  expect(rest.status).toBe(400);
  const response = await handleMcp(new Request("https://x/mcp", {method:"POST",body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"jp_supply_series",arguments:{code:"7203",series:"jpx_margin",cursor:"2026-02-30"}}})}), e);
  expect((await response.json() as {result:{isError:boolean}}).result.isError).toBe(true); expect(calls).toBe(0);
});

describe.skipIf(!available)("保存済みJPX日次実原本（取得・合成0）", () => {
  it("4247銘柄の買売/株数/金額/出典をnativeのまま返す", async () => {
    const s = native();
    const bucket = stubR2({"margin/dates.json":[s.basisDate],[`margin/daily/${s.basisDate}.json`]:s});
    const rows = await marginLatest(bucket); expect(rows).toHaveLength(4247);
    const actual = s.rows.find((r: {sourceCode:string}) => r.sourceCode === "72030");
    const row = rows.find(r => r.code === "7203")!;
    expect(row.shares).toEqual(actual.shares); expect(row.amounts).toEqual(actual.amounts);
    expect(row.source).toEqual({url:s.sourceUrl,raw_sha256:s.rawSha256,archive_page_id:s.rawPageId,basis_date:s.basisDate,publication_date:s.publicationDate,fetched_at:null});
    expect(row).not.toHaveProperty("loan_bal");
  });
  it("破損値/来歴/合計をactual入力の明示改変で拒否する", async () => {
    for (const mutate of [(s: ReturnType<typeof native>) => {s.publicationDate="2026-02-30";}, (s: ReturnType<typeof native>) => {s.rawSha256="bad";}, (s: ReturnType<typeof native>) => {s.rows[0].shares.buyOutstanding++;}, (s: ReturnType<typeof native>) => {s.rows[0].shares.buyChg="bad";}]) {
      const s=native(); mutate(s); await expect(marginSnapshot(stubR2({"margin/daily/2026-10-09.json":s}),"2026-10-09")).rejects.toThrow();
    }
  });
  it("20日cursorのREST/MCP入力接続・全件・終端が一致する", async () => {
    // 保存実snapshotの時計だけを変えるページ境界試験。値の生成/本番利用はしない。
    const s=native(), dates=Array.from({length:21},(_,i)=>new Date(Date.UTC(2026,9,9-i)).toISOString().slice(0,10));
    const objects: Record<string,unknown>={"margin/dates.json":dates};
    for(const d of dates) objects[`margin/daily/${d}.json`]={...s,basisDate:d};
    const e=env(stubR2(objects)), seen:string[]=[]; let cursor:string|null=null;
    for(let page=0;page<2;page++) {
      const args={code:"7203",series:"jpx_margin",...(cursor?{cursor}:{})};
      const rest=await app.request(`/v1/supply/7203?series=jpx_margin${cursor?`&cursor=${cursor}`:""}`,auth,e);
      const r=await rest.json() as {data:{updated:null;series:{jpx_margin:Array<{d:string}>}};meta:{cursor:string|null}};
      expect(rest.status).toBe(200);expect(r.data.updated).toBeNull();
      const m=await handleMcp(new Request("https://x/mcp",{method:"POST",body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"jp_supply_series",arguments:args}})}),e);
      const body=await m.json() as {result:{content:Array<{text:string}>}};expect(JSON.parse(body.result.content[0]!.text)).toEqual(r);
      expect(r.data.series.jpx_margin).toHaveLength(page===0?20:1);seen.push(...r.data.series.jpx_margin.map(p=>p.d));cursor=r.meta.cursor;
    }
    expect(cursor).toBeNull();expect(new Set(seen).size).toBe(21);expect([...seen].sort()).toEqual([...dates].sort());
  });
});
