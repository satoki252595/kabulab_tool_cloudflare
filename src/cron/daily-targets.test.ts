/**
 * 日次取込の処理対象 (`loadDailyTargets`) の検証。
 *
 * 2026-09-13 のユーザー決定で、日次の処理対象を `core_stocks` の
 * **active かつ equity (内国普通株)** に絞った。移行 P4b が非普通株 (+725 行) を
 * INSERT しても、日次の対象件数・Actions 時間・D1 書込が増えないようにするため。
 * 固定したい契約: 返すのは active かつ equity の行だけで、次は全部落ちる。
 *
 *   - 上場廃止 (is_active = 0) の普通株
 *   - active の非普通株 (reit_fund / etf_etn)
 *   - active で instrument_type が NULL (未分類) の行 — NULL を普通株扱いにしない
 *
 * スキーマは drizzle/d1 のマイグレーションをそのまま流して作る
 * (daily-sector-aggregate.test.ts と同じ)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as coreSchema from "../shared/db/core-schema.js";
import * as rsiSchema from "../../services/rsi-screening/src/db/schema.js";
import * as swingSchema from "../../services/swing-trading/src/db/schema.js";
import * as projectionSchema from "../shared/db/projection-schema.js";
import { INSTRUMENT_TYPES } from "../shared/jpx/instrument-type.js";
import { loadDailyTargets } from "./daily.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** drizzle/d1 の全マイグレーションを番号順に流す (本番 D1 と同じ形)。 */
function applyD1Migrations(target: DatabaseSync): void {
  const dir = join(ROOT, "drizzle", "d1");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf-8").split("--> statement-breakpoint")) {
      if (stmt.trim()) target.exec(stmt);
    }
  }
}

let sqlite: DatabaseSync;
let executed: string[];

/** createD1HttpDb と同じ sqlite-proxy 経路をローカル SQLite に向ける。 */
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

type Db = Parameters<typeof loadDailyTargets>[0];
const db = (): Db => makeProxyDb(sqlite, executed) as unknown as Db;

function seedStock(opts: {
  id: number;
  code: string;
  active: boolean;
  instrumentType: string | null;
  sector?: string | null;
}): void {
  sqlite
    .prepare(
      "INSERT INTO core_stocks (id, code, name, market, sector, is_active, instrument_type) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      opts.id,
      opts.code,
      `銘柄${opts.code}`,
      "プライム",
      opts.sector ?? null,
      opts.active ? 1 : 0,
      opts.instrumentType
    );
}

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  applyD1Migrations(sqlite);
  executed = [];
});

afterEach(() => {
  sqlite.close();
});

describe("loadDailyTargets", () => {
  it("active かつ equity の行だけを返す", async () => {
    seedStock({ id: 1, code: "7203", active: true, instrumentType: INSTRUMENT_TYPES.equity, sector: "輸送用機器" });
    seedStock({ id: 2, code: "1001", active: false, instrumentType: INSTRUMENT_TYPES.equity });
    seedStock({ id: 3, code: "8951", active: true, instrumentType: INSTRUMENT_TYPES.reitFund });
    seedStock({ id: 4, code: "1306", active: true, instrumentType: INSTRUMENT_TYPES.etfEtn });
    seedStock({ id: 5, code: "9999", active: true, instrumentType: null });

    const targets = await loadDailyTargets(db());

    expect(targets).toEqual([{ id: 1, code: "7203", sector: "輸送用機器" }]);
  });

  it("絞り込みは SQL の WHERE で行い、instrument_type を select しない", async () => {
    seedStock({ id: 1, code: "7203", active: true, instrumentType: INSTRUMENT_TYPES.equity });

    await loadDailyTargets(db());

    const [query] = executed;
    expect(query).toContain('where ("core_stocks"."is_active" = ? and "core_stocks"."instrument_type" = ?)');
    // 読むのは id / code / sector だけ (値を JS 側へ持ってこない)
    expect(query.slice(0, query.indexOf(" from "))).not.toContain("instrument_type");
  });
});
