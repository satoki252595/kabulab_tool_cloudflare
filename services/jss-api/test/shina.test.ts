import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCsvRows } from "../../moneyflow/lib/sources/mof-portfolio-flows";
import { assertShinaUnitNote, parseShina, shinaLatest } from "../src/shared/shina";
import type { PrivateEnv } from "../src/shared/types";
import { stubD1, stubR2 } from "./helpers";
const base = new URL("../../../tmp/feature-audit-20261013/jss-shina-native/", import.meta.url);
const available=existsSync(new URL("shina.csv",base));
const env=(rows:Record<string,unknown>[],RAW:R2Bucket):PrivateEnv=>({DB:stubD1(()=>rows),RAW,SUPPLY:stubR2({}),VWAP:stubR2({}),SURFACE:"private"});

it("単位注記の欠落/前日定義変更をnative unitとして成功にしない",()=>{
  const note="最高料率および前日品貸料率は1日1株・口当り、当日品貸料率は1日1株・口当りの品貸料率に当日品貸日数を乗じて表示";
  expect(()=>assertShinaUnitNote(note)).not.toThrow();
  expect(()=>assertShinaUnitNote(note.replace("前日品貸料率", "翌日品貸料率"))).toThrow();
  expect(()=>assertShinaUnitNote(undefined)).toThrow();
});

it("既存indexなしは空、偽index・同時刻複数原本はGET前に停止する",async()=>{
  let calls=0;const RAW={get:async()=>{calls++;throw new Error("must not fetch");}} as unknown as R2Bucket;
  expect(await shinaLatest(env([],RAW))).toEqual([]);
  await expect(shinaLatest(env([{last_fetched_at:1},{last_fetched_at:1}],RAW))).rejects.toThrow();
  await expect(shinaLatest(env([{last_fetched_at:1,license_tag:"open"}],RAW))).rejects.toThrow();expect(calls).toBe(0);
});
it("未閉引用符を途中の正常CSVへ黙って変換しない",()=>{expect(()=>parseCsvRows('"unfinished')).toThrow();});
it("不正encoding・別様式・未完CSVを実績0で埋めない",()=>{
  expect(()=>parseShina(new Uint8Array([0x81]).buffer)).toThrow();
  expect(()=>parseShina(new TextEncoder().encode("<html>error</html>").buffer)).toThrow();
});

describe.skipIf(!available)("保存JSF shina actual全CSV（外部取得0）",()=>{
  const bytes=()=>new Uint8Array(readFileSync(new URL("shina.csv",base)));
  const index=()=>JSON.parse(readFileSync(new URL("oauth-qualified-index.json",base),"utf8")).rows[0] as Record<string,unknown>;
  it("943行全取引所とnative基準日を保持し、取得時計と混同しない",async()=>{
    const row=index(), parsed=parseShina(bytes().buffer), result=await shinaLatest(env([row],stubR2({[row.r2_key as string]:bytes()})));
    expect(result).toHaveLength(943);expect(parsed).toHaveLength(943);
    expect(new Set(result.map(r=>r.data_date))).toEqual(new Set(["2026-10-09"]));
    expect(result.filter(r=>r.exchange==="東証")).toHaveLength(942);expect(result.filter(r=>r.exchange==="名証")).toHaveLength(1);
    expect(result[0]!.source).toEqual({raw_sha256:row.sha256,r2_key:row.r2_key,index_data_date:"2026-10-13",first_fetched_at:row.first_fetched_at,last_fetched_at:row.last_fetched_at});
    expect(result.every(r=>!("loan_bal" in r))).toBe(true);
  });
  it("actual原本1byte破損は全文SHAで拒否する",async()=>{
    const row=index(), corrupted=bytes();corrupted[corrupted.length-1]=corrupted[corrupted.length-1]!^1;
    await expect(shinaLatest(env([row],stubR2({[row.r2_key as string]:corrupted})))).rejects.toThrow("SHA");
  });
  it("actual CSVの単位注記だけを改変した入力を拒否する",()=>{
    const text=new TextDecoder("shift_jis").decode(bytes()).replace("前日品貸料率は", "翌日品貸料率は");
    // UnicodeからCP932を逆変換して架空原本を作らず、原文noteだけ同guardへ通す。
    expect(()=>assertShinaUnitNote(text.split("\n")[1])).toThrow();
  });
  it("空欄/マスクのnative nullを0にしない",()=>{
    const rows=parseShina(bytes().buffer);
    const masked=rows.filter(r=>r.today_rate===null);expect(masked.length).toBeGreaterThan(0);expect(masked.every(r=>r.today_rate!==0)).toBe(true);
  });
});
