/**
 * 月次 rebuild (Phase 2: otakara の派生表の再構築) の母集団の検証。
 *
 * 日次取込を active かつ equity に絞ったので (src/cron/daily.ts `loadDailyTargets`)、
 * 非普通株の断面 (`core_stock_financials` / `swing_stock_indicators`) は更新されずに
 * 凍結する。月次がその銘柄も再構築すると、凍結した値に**今日の `data_date`** を付けて
 * `otakara_stock_financials` へ書き、古い値が「今日の値」を名乗る (ルール2)。
 * 固定したい契約:
 *
 *   1. 再構築されるのは active かつ equity かつ is_yutai の銘柄だけ。
 *   2. 既にある非普通株の otakara 行は消さず、今日の日付でも上書きしない
 *      (公開面は同じ述語で隠す)。
 *
 * `runMonthlyRebuild` は Yahoo 等の外部 I/O を持たない (DB だけを読み書きする) ので、
 * sqlite-proxy の DB をそのまま渡して全 Phase を走らせる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as coreSchema from "../shared/db/core-schema.js";
import * as swingSchema from "../../services/swing-trading/src/db/schema.js";
import * as otakaraSchema from "../../services/otakara-yutai/src/db/schema.js";
import { INSTRUMENT_TYPES } from "../shared/jpx/instrument-type.js";
import { runMonthlyRebuild } from "./monthly.js";

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

/** createD1HttpDb と同じ sqlite-proxy 経路をローカル SQLite に向ける。 */
function makeProxyDb(target: DatabaseSync) {
  return drizzle(
    async (sqlStr, params, method) => {
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
    { schema: { ...coreSchema, ...swingSchema, ...otakaraSchema } }
  );
}

type Db = Parameters<typeof runMonthlyRebuild>[0];

const EQUITY_ID = 1;
const REIT_ID = 2;
const FROZEN_DATE = "2026-09-01";

let sqlite: DatabaseSync;

/** 優待あり (yutai_benefits に行がある) 銘柄を、断面と指標つきで 1 件入れる。 */
function seedYutaiStock(id: number, code: string, instrumentType: string): void {
  sqlite
    .prepare(
      "INSERT INTO core_stocks (id, code, name, market, is_active, is_yutai, instrument_type) VALUES (?, ?, ?, 'プライム', 1, 1, ?)"
    )
    .run(id, code, `銘柄${code}`, instrumentType);
  sqlite
    .prepare(
      "INSERT INTO core_stock_financials (stock_id, price, per, pbr, dividend_yield, roe, data_date) VALUES (?, 1000, 12, 1.1, 3.0, 0.1, ?)"
    )
    .run(id, FROZEN_DATE);
  sqlite
    .prepare(
      "INSERT INTO swing_stock_indicators (stock_id, sma_25, rsi_14, macd, macd_signal) VALUES (?, 990, 45, 1.2, 0.8)"
    )
    .run(id);
  sqlite
    .prepare(
      "INSERT INTO yutai_benefits (stock_id, genre_id, description, short_summary, min_shares, record_month, estimated_value) VALUES (?, 1, '掲載文', '1000円相当', 100, 3, 1000)"
    )
    .run(id);
}

function stockIds(table: "otakara_stock_financials" | "otakara_stock_scores"): number[] {
  return (
    sqlite.prepare(`SELECT stock_id FROM ${table} ORDER BY stock_id`).all() as { stock_id: number }[]
  ).map((r) => r.stock_id);
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  sqlite = new DatabaseSync(":memory:");
  applyD1Migrations(sqlite);
  sqlite.exec("INSERT INTO yutai_genres (id, name, slug) VALUES (1, 'QUOカード', 'quo')");
  seedYutaiStock(EQUITY_ID, "7203", INSTRUMENT_TYPES.equity);
  seedYutaiStock(REIT_ID, "8951", INSTRUMENT_TYPES.reitFund);
});

afterEach(() => {
  sqlite.close();
  vi.restoreAllMocks();
});

describe("runMonthlyRebuild の母集団 (active かつ equity かつ is_yutai)", () => {
  it("otakara_stock_financials / otakara_stock_scores には equity の行だけができる", async () => {
    const result = await runMonthlyRebuild(makeProxyDb(sqlite) as unknown as Db);

    expect(result.scoredStocks).toBe(1);
    expect(stockIds("otakara_stock_financials")).toEqual([EQUITY_ID]);
    expect(stockIds("otakara_stock_scores")).toEqual([EQUITY_ID]);
  });

  it("既にある非普通株の otakara 行は消さず、今日の data_date で上書きしない", async () => {
    // 絞り込み前の月次が書いた行。日次が止まった後の断面に今日の日付を付けて
    // 書き直すと、古い値が新しい値を名乗る。
    sqlite
      .prepare(
        "INSERT INTO otakara_stock_financials (stock_id, price, data_date) VALUES (?, 500, ?)"
      )
      .run(REIT_ID, FROZEN_DATE);

    await runMonthlyRebuild(makeProxyDb(sqlite) as unknown as Db);

    const reit = sqlite
      .prepare("SELECT price, data_date AS dataDate FROM otakara_stock_financials WHERE stock_id = ?")
      .get(REIT_ID);
    expect(reit).toEqual({ price: 500, dataDate: FROZEN_DATE });
    const today = new Date().toISOString().split("T")[0];
    const equity = sqlite
      .prepare("SELECT data_date AS dataDate FROM otakara_stock_financials WHERE stock_id = ?")
      .get(EQUITY_ID);
    expect(equity).toEqual({ dataDate: today });
  });
});
