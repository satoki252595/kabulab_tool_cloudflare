/**
 * `aggregateMoneyflowSector` の値の検証。
 *
 * D1 シムは src/cron/daily-sector-aggregate.test.ts / active-equity-universe.test.ts
 * と同じ方式 (node:sqlite に drizzle/d1 のマイグレーションをそのまま流し、
 * drizzle-orm/sqlite-proxy で発行 SQL をそのローカル SQLite へ向ける)。
 *
 * 固定したい契約:
 *   1. 業種の集約キーは `core_stocks.sector` (JPX 33 業種)。本エンドポイントは
 *      認証付き内部面のみで、公開面には出さない (計画書「個人利用のため
 *      personal-only の列を使える」)。
 *   2. 母集団は active かつ equity (`activeEquityCondition()`)。非対象は
 *      turnover にも時価総額にも入らない。
 *   3. 前日比 (上昇日/下落日) は対象期間の直前の実データ (欠損日をまたいでも
 *      直近の close) で判定し、前日値が無い日はどちらにも計上しない。
 *   4. close/volume が NULL の行は turnover に計上しない (捏造しない)。
 *   5. 時価総額は `core_stock_financials.market_cap` の現在値の合計 (対象期間の
 *      値ではなくスナップショット)。NULL の銘柄は合計から除外し、寄与銘柄数を返す。
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as coreSchema from "../shared/db/core-schema.js";
import * as rsiSchema from "../../services/rsi-screening/src/db/schema.js";
import * as swingSchema from "../../services/swing-trading/src/db/schema.js";
import * as projectionSchema from "../shared/db/projection-schema.js";
import { aggregateMoneyflowSector, isoWeekToDateRange } from "./moneyflow-sector.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function applyD1Migrations(target: DatabaseSync): void {
  const dir = join(ROOT, "drizzle", "d1");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf-8").split("--> statement-breakpoint")) {
      if (stmt.trim()) target.exec(stmt);
    }
  }
}

let sqlite: DatabaseSync;

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
    { schema: { ...coreSchema, ...rsiSchema, ...swingSchema, ...projectionSchema } }
  );
}

type Db = Parameters<typeof aggregateMoneyflowSector>[0];
const db = (): Db => makeProxyDb(sqlite) as unknown as Db;

function seedStock(opts: {
  id: number;
  sector: string | null;
  active?: boolean;
  instrumentType?: string | null;
  marketCap?: number | null;
}): void {
  sqlite
    .prepare(
      "INSERT INTO core_stocks (id, code, name, market, sector, is_active, instrument_type) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      opts.id,
      String(1000 + opts.id),
      `銘柄${opts.id}`,
      "プライム",
      opts.sector,
      opts.active === false ? 0 : 1,
      opts.instrumentType === undefined ? "equity" : opts.instrumentType
    );
  if (opts.marketCap !== undefined) {
    sqlite
      .prepare(
        "INSERT INTO core_stock_financials (stock_id, market_cap, data_date) VALUES (?, ?, ?)"
      )
      .run(opts.id, opts.marketCap, "2026-09-25");
  }
}

function seedOhlcv(stockId: number, date: string, close: number | null, volume: number | null): void {
  sqlite
    .prepare("INSERT INTO swing_daily_ohlcv (stock_id, date, close, volume) VALUES (?, ?, ?, ?)")
    .run(stockId, date, close, volume);
}

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  applyD1Migrations(sqlite);
});

afterEach(() => {
  sqlite.close();
});

describe("aggregateMoneyflowSector", () => {
  it("業種別の売買代金・シェア・上昇/下落日の売買代金・銘柄数・時価総額を集計する", async () => {
    // 電気機器: 銘柄1 (月曜比で上昇), 銘柄2 (上昇)
    seedStock({ id: 1, sector: "電気機器", marketCap: 1_000_000 });
    seedOhlcv(1, "2026-09-11", 100, 1000); // lookback (from の前営業日)
    seedOhlcv(1, "2026-09-14", 110, 1000); // 上昇 (110>100) turnover=110,000
    seedStock({ id: 2, sector: "電気機器", marketCap: 2_000_000 });
    seedOhlcv(2, "2026-09-11", 200, 500);
    seedOhlcv(2, "2026-09-14", 150, 500); // 下落 (150<200) turnover=75,000

    // 銀行業: 銘柄3 (前日データ無し = up/down どちらにも入らない)
    seedStock({ id: 3, sector: "銀行業", marketCap: 3_000_000 });
    seedOhlcv(3, "2026-09-14", 300, 100); // turnover=30,000 だが前日値なし

    const result = await aggregateMoneyflowSector(db(), { from: "2026-09-14", to: "2026-09-14" });

    const denki = result.sectors.find((s) => s.sector === "電気機器");
    const ginko = result.sectors.find((s) => s.sector === "銀行業");
    expect(denki).toBeDefined();
    expect(ginko).toBeDefined();

    expect(denki?.turnover).toBe(110_000 + 75_000);
    expect(denki?.upTurnover).toBe(110_000);
    expect(denki?.downTurnover).toBe(75_000);
    expect(denki?.stockCount).toBe(2);
    expect(denki?.marketCap).toBe(3_000_000);
    expect(denki?.marketCapStockCount).toBe(2);

    expect(ginko?.turnover).toBe(30_000);
    expect(ginko?.upTurnover).toBe(0);
    expect(ginko?.downTurnover).toBe(0);

    // 電気機器 185,000 + 銀行業 30,000 = 215,000 (全業種合計)。
    expect(denki?.turnoverShare).toBeCloseTo(185_000 / 215_000, 10);
    expect(ginko?.turnoverShare).toBeCloseTo(30_000 / 215_000, 10);

    expect(result.marketCapAsOf).toBe("snapshot_at_fetch");
  });

  it("非アクティブ・非普通株は turnover にも時価総額にも入らない", async () => {
    seedStock({ id: 1, sector: "電気機器", marketCap: 1_000_000 });
    seedOhlcv(1, "2026-09-14", 100, 1000);
    seedStock({ id: 2, sector: "電気機器", marketCap: 999_999_999, active: false });
    seedOhlcv(2, "2026-09-14", 100, 1000);
    seedStock({ id: 3, sector: "電気機器", marketCap: 999_999_999, instrumentType: "reit_fund" });
    seedOhlcv(3, "2026-09-14", 100, 1000);

    const result = await aggregateMoneyflowSector(db(), { from: "2026-09-14", to: "2026-09-14" });
    const denki = result.sectors.find((s) => s.sector === "電気機器");
    expect(denki?.stockCount).toBe(1);
    expect(denki?.marketCap).toBe(1_000_000);
  });

  it("sector が NULL の銘柄は「未分類」にまとめる (JPX sector へのフォールバックはしない前提と同型)", async () => {
    seedStock({ id: 1, sector: null, marketCap: 500 });
    seedOhlcv(1, "2026-09-14", 100, 10);

    const result = await aggregateMoneyflowSector(db(), { from: "2026-09-14", to: "2026-09-14" });
    expect(result.sectors.map((s) => s.sector)).toEqual(["未分類"]);
  });

  it("close/volume が NULL の行は turnover に計上しない", async () => {
    seedStock({ id: 1, sector: "電気機器" });
    seedOhlcv(1, "2026-09-14", null, null);

    const result = await aggregateMoneyflowSector(db(), { from: "2026-09-14", to: "2026-09-14" });
    const denki = result.sectors.find((s) => s.sector === "電気機器");
    expect(denki?.turnover).toBe(0);
    expect(denki?.stockCount).toBe(1);
    expect(denki?.marketCapStockCount).toBe(0);
  });

  it("時価総額が NULL の銘柄は合計から除外し、寄与銘柄数だけ減る", async () => {
    seedStock({ id: 1, sector: "電気機器", marketCap: 1_000_000 });
    seedOhlcv(1, "2026-09-14", 100, 10);
    seedStock({ id: 2, sector: "電気機器" }); // marketCap 未設定 (financials 行なし)
    seedOhlcv(2, "2026-09-14", 100, 10);

    const result = await aggregateMoneyflowSector(db(), { from: "2026-09-14", to: "2026-09-14" });
    const denki = result.sectors.find((s) => s.sector === "電気機器");
    expect(denki?.marketCap).toBe(1_000_000);
    expect(denki?.marketCapStockCount).toBe(1);
    expect(denki?.stockCount).toBe(2);
  });

  it("期間内で売買代金降順に並ぶ", async () => {
    seedStock({ id: 1, sector: "小さい業種" });
    seedOhlcv(1, "2026-09-14", 100, 1);
    seedStock({ id: 2, sector: "大きい業種" });
    seedOhlcv(2, "2026-09-14", 100, 100000);

    const result = await aggregateMoneyflowSector(db(), { from: "2026-09-14", to: "2026-09-14" });
    expect(result.sectors[0]?.sector).toBe("大きい業種");
    expect(result.sectors[1]?.sector).toBe("小さい業種");
  });
});

describe("isoWeekToDateRange との組み合わせ (週指定の実データ集計)", () => {
  it("2026-W38 (月〜日) の範囲で正しく集計する", async () => {
    seedStock({ id: 1, sector: "電気機器" });
    seedOhlcv(1, "2026-09-13", 90, 1); // 週の前 (日曜、lookback 用)
    seedOhlcv(1, "2026-09-14", 100, 10); // 月 (週内)
    seedOhlcv(1, "2026-09-20", 110, 20); // 日 (週内)
    seedOhlcv(1, "2026-09-21", 999, 999); // 週外 (含まれてはいけない)

    const range = isoWeekToDateRange("2026-W38");
    expect(range).toEqual({ from: "2026-09-14", to: "2026-09-20" });

    const result = await aggregateMoneyflowSector(db(), range);
    const denki = result.sectors.find((s) => s.sector === "電気機器");
    expect(denki?.turnover).toBe(100 * 10 + 110 * 20);
  });
});
