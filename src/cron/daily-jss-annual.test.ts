/**
 * 日次 sync の正本年次一括読込 (`loadJssAnnualMap`) の検証。
 *
 * `createD1HttpDb` と同じ sqlite-proxy 経路をローカル SQLite に向ける
 * (daily-targets.test.ts と同じ方式)。`jss_financials` は pipeline 所有で
 * drizzle migration に無いため、テスト用 DDL を手書きする。
 * 系列への整形は共有 gate (`pickAnnualSeries`) が行うので、ここでは
 * 「1 文で本決算 × commercial-ok だけを引き、銘柄ごとに束ねる」ことと
 * 「絞り込みが SQL の WHERE で行われる」ことだけを見る。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as coreSchema from "../shared/db/core-schema.js";
import * as rsiSchema from "../../services/rsi-screening/src/db/schema.js";
import * as swingSchema from "../../services/swing-trading/src/db/schema.js";
import * as projectionSchema from "../shared/db/projection-schema.js";
import { loadJssAnnualMap } from "./daily.js";

const DDL = `
CREATE TABLE jss_financials (
  code text NOT NULL,
  fiscal_period_end text NOT NULL,
  disclosure_type text NOT NULL,
  consolidated text NOT NULL,
  net_sales real,
  license_tag text NOT NULL,
  PRIMARY KEY (code, fiscal_period_end, disclosure_type, consolidated)
);
`;

let sqlite: DatabaseSync;
let executed: string[];

function makeProxyDb(target: DatabaseSync, log: string[]) {
  return drizzle(
    async (sqlStr, params, method) => {
      log.push(sqlStr);
      const stmt = target.prepare(sqlStr);
      const bind = params as (null | number | bigint | string | Uint8Array)[];
      if (method === "run") {
        stmt.run(...bind);
        return { rows: [] };
      }
      const objs = stmt.all(...bind) as Record<string, unknown>[];
      const rows = objs.map((o) => Object.values(o));
      return { rows: method === "get" ? (rows[0] ?? []) : rows };
    },
    { schema: { ...coreSchema, ...rsiSchema, ...swingSchema, ...projectionSchema } }
  );
}

type Db = Parameters<typeof loadJssAnnualMap>[0];
const db = (): Db => makeProxyDb(sqlite, executed) as unknown as Db;

function seed(
  code: string,
  fiscalPeriodEnd: string,
  disclosureType: string,
  consolidated: string,
  netSales: number | null,
  licenseTag: string
): void {
  sqlite
    .prepare(
      "INSERT INTO jss_financials (code, fiscal_period_end, disclosure_type, consolidated, net_sales, license_tag) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(code, fiscalPeriodEnd, disclosureType, consolidated, netSales, licenseTag);
}

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(DDL);
  executed = [];
});

afterEach(() => {
  sqlite.close();
});

describe("loadJssAnnualMap", () => {
  it("本決算 × commercial-ok だけを銘柄ごとに束ねて返す", async () => {
    seed("8154", "2025-03-31", "本決算", "連結", 547_779_000_000, "commercial-ok");
    seed("8154", "2026-03-31", "本決算", "連結", 658_941_000_000, "commercial-ok");
    seed("1002", "2025-03-31", "本決算", "単体", 10_000_000_000, "commercial-ok");
    // 予想・四半期・factual-cite・personal-only は混ぜない。
    seed("8154", "2026-03-31", "予想", "連結", 999, "commercial-ok");
    seed("8154", "2025-09-30", "中間", "連結", 888, "commercial-ok");
    seed("8154", "2024-03-31", "本決算", "連結", 777, "factual-cite");
    seed("1002", "2024-03-31", "本決算", "単体", 666, "personal-only");

    const byCode = await loadJssAnnualMap(db());

    expect([...byCode.keys()].sort()).toEqual(["1002", "8154"]);
    expect(byCode.get("8154")).toEqual([
      { fiscalPeriodEnd: "2025-03-31", consolidated: "連結", revenue: 547_779_000_000 },
      { fiscalPeriodEnd: "2026-03-31", consolidated: "連結", revenue: 658_941_000_000 },
    ]);
    expect(byCode.get("1002")).toEqual([
      { fiscalPeriodEnd: "2025-03-31", consolidated: "単体", revenue: 10_000_000_000 },
    ]);
  });

  it("1 文で引き、絞り込みは SQL の WHERE で行う", async () => {
    seed("8154", "2025-03-31", "本決算", "連結", 547_779_000_000, "commercial-ok");

    await loadJssAnnualMap(db());

    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain(
      'where ("jss_financials"."disclosure_type" = ? and "jss_financials"."license_tag" = ?)'
    );
  });
});
