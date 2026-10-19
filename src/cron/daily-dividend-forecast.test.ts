/**
 * 日次 sync の予想配当基準の一括読込 (`loadDividendForecastLookup`) の検証。
 *
 * daily-jss-annual.test.ts と同じく sqlite-proxy 経路をローカル SQLite に向ける。
 * core_stocks / ir_disclosures は drizzle migration、jss_financials は手書き DDL。
 * 判定規則そのものは forecast-dividend-yield.test.ts。ここでは「最新短信の選択」
 * 「asOf より後の行・開示を読まない」「表題の分類が判定に届く」ことを見る。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { loadDividendForecastLookup } from "./daily.js";

const ROOT = join(import.meta.dirname, "..", "..");
const JSS_DDL = `
CREATE TABLE jss_financials (
  code text NOT NULL,
  fiscal_period_end text NOT NULL,
  disclosure_type text NOT NULL,
  consolidated text NOT NULL,
  net_sales real,
  license_tag text NOT NULL,
  source text NOT NULL,
  dps_forecast real,
  disclosed_at integer,
  PRIMARY KEY (code, fiscal_period_end, disclosure_type, consolidated)
);
`;
const AS_OF_DATE = "2026-10-16";
const sec = (iso: string) => Date.parse(iso) / 1000;

let sqlite: DatabaseSync;
type Db = Parameters<typeof loadDividendForecastLookup>[0];
const db = (): Db => drizzle(async (sqlStr, params, method) => {
  const stmt = sqlite.prepare(sqlStr);
  const bind = params as (null | number | bigint | string | Uint8Array)[];
  if (method === "run") { stmt.run(...bind); return { rows: [] }; }
  const rows = (stmt.all(...bind) as Record<string, unknown>[]).map((o) => Object.values(o));
  return { rows: method === "get" ? (rows[0] ?? []) : rows };
}) as unknown as Db;

function stock(id: number, code: string): void {
  sqlite.prepare("INSERT INTO core_stocks (id, code, name, market, is_active) VALUES (?, ?, ?, 'プライム', 1)")
    .run(id, code, `銘柄${code}`);
}
function tanshin(code: string, fpe: string, consolidated: string, dps: number | null, disclosedAt: number | null, source = "TDnet"): void {
  sqlite.prepare("INSERT INTO jss_financials (code, fiscal_period_end, disclosure_type, consolidated, license_tag, source, dps_forecast, disclosed_at) VALUES (?, ?, '1Q', ?, 'factual-cite', ?, ?, ?)")
    .run(code, fpe, consolidated, source, dps, disclosedAt);
}
let seq = 0;
function disclosure(stockId: number, title: string, pubdate: number): void {
  seq += 1;
  sqlite.prepare("INSERT INTO ir_disclosures (stock_id, tdnet_id, company_code, company_name, title, pubdate, document_url, tags) VALUES (?, ?, ?, '社名', ?, ?, 'https://example.invalid/doc', '[]')")
    .run(stockId, `t${seq}`, `${stockId}0`, title, pubdate);
}

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  const dir = join(ROOT, "drizzle", "d1");
  for (const f of readdirSync(dir).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf-8").split("--> statement-breakpoint")) {
      if (stmt.trim()) sqlite.exec(stmt);
    }
  }
  sqlite.exec(JSS_DDL);
});

describe("loadDividendForecastLookup", () => {
  it("最新短信の予想を採り、古い短信・EDINET 行・asOf 後の短信は読まない", async () => {
    stock(1, "1001");
    tanshin("1001", "2026-03-31", "連結", 60, sec("2026-05-12T06:00:00Z"));
    tanshin("1001", "2026-06-30", "連結", 70, sec("2026-08-07T06:00:00Z"));
    tanshin("1001", "2026-06-30", "単体", 70, sec("2026-08-07T06:00:00Z"));
    tanshin("1001", "2026-09-30", "連結", 90, sec("2026-10-17T06:00:00Z")); // asOf 後
    tanshin("1001", "2025-12-31", "連結", null, sec("2026-09-30T06:00:00Z"), "EDINET");
    disclosure(1, "2027年3月期 第1四半期決算短信〔日本基準〕(連結)", sec("2026-08-07T06:00:00Z"));
    disclosure(1, "2027年3月期 第2四半期決算短信〔日本基準〕(連結)", sec("2026-10-17T06:00:00Z")); // asOf 後
    const lookup = await loadDividendForecastLookup(db(), AS_OF_DATE);
    expect(lookup("1001")).toEqual({ kind: "forecast", dps: 70, disclosedAt: sec("2026-08-07T06:00:00Z") });
  });

  it("後続の配当開示・分割開示を表題から拾って未確定にする", async () => {
    stock(2, "1002");
    stock(3, "1003");
    stock(4, "1004");
    tanshin("1002", "2026-06-30", "連結", 40, sec("2026-08-07T06:00:00Z"));
    tanshin("1003", "2026-06-30", "連結", 40, sec("2026-08-07T06:00:00Z"));
    tanshin("1004", "2026-06-30", "連結", 40, sec("2026-08-07T06:00:00Z"));
    disclosure(2, "配当予想の修正（増配）に関するお知らせ", sec("2026-09-01T06:00:00Z"));
    disclosure(3, "株式分割及び定款の一部変更に関するお知らせ", sec("2026-05-20T06:00:00Z"));
    disclosure(4, "自己株式の取得状況に関するお知らせ", sec("2026-09-01T06:00:00Z"));
    const lookup = await loadDividendForecastLookup(db(), AS_OF_DATE);
    expect(lookup("1002")).toEqual({ kind: "unverified", reason: "superseded" });
    expect(lookup("1003")).toEqual({ kind: "unverified", reason: "share-split-basis" });
    expect(lookup("1004").kind).toBe("forecast");
  });

  it("短信行が無い銘柄・開示時刻の無い行は理由付きで未確定", async () => {
    stock(5, "1005");
    tanshin("1005", "2026-06-30", "連結", 40, null);
    const lookup = await loadDividendForecastLookup(db(), AS_OF_DATE);
    expect(lookup("1005")).toEqual({ kind: "unverified", reason: "disclosed-at-missing" });
    expect(lookup("1006")).toEqual({ kind: "unverified", reason: "no-forecast-row" });
  });

  it("codes 指定時はその銘柄だけ読む", async () => {
    stock(7, "1007");
    stock(8, "1008");
    tanshin("1007", "2026-06-30", "連結", 40, sec("2026-08-07T06:00:00Z"));
    tanshin("1008", "2026-06-30", "連結", 50, sec("2026-08-07T06:00:00Z"));
    const lookup = await loadDividendForecastLookup(db(), AS_OF_DATE, ["1007"]);
    expect(lookup("1007").kind).toBe("forecast");
    expect(lookup("1008")).toEqual({ kind: "unverified", reason: "no-forecast-row" });
  });
});
