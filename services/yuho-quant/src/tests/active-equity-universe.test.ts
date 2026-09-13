/**
 * yuho-quant の検索・スクリーニング・業種プルダウンが**同じ母集団
 * (active かつ equity)** を見ることの検証。**値**で見る。
 *
 * 公開面の一覧は日次取込と同じ述語 (src/shared/db/active-equity.ts) で絞る。
 * yuho の 5 つのクエリのうち 1 つでも `is_active` のままだと、結果表とプルダウンが
 * 別の集合になる (プルダウンにだけ出る業種を選ぶと結果が空振りする)。
 * 固定したい契約: 次の 5 つが equity の銘柄だけを返し、reit_fund と
 * instrument_type が NULL の銘柄を返さない。
 *
 *   - searchStocks (名前の部分一致)
 *   - screenOrderGrowth / listSectorsWithOrders
 *   - screenOverseasGrowth / listSectorsWithOverseas
 *
 * 3 銘柄とも受注・海外売上のデータを同じ形で持たせ、`instrument_type` 以外の
 * 条件では区別できないようにしてある。
 *
 * D1 シムは services/swing-trading/src/tests/sector-ranking-key-switch.test.ts と
 * 同じ方式。yuho の表 (yuho_documents / yuho_order_facts / yuho_overseas_facts) は
 * drizzle/d1 のマイグレーションに含まれているので、そのまま流す。
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Database } from "../db/client.js";
import {
  listSectorsWithOrders,
  screenOrderGrowth,
  searchStocks,
} from "../services/order-query.js";
import {
  listSectorsWithOverseas,
  screenOverseasGrowth,
} from "../services/overseas-query.js";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

function applyD1Migrations(target: DatabaseSync): void {
  const dir = join(ROOT, "drizzle", "d1");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf-8").split("--> statement-breakpoint")) {
      if (stmt.trim()) target.exec(stmt);
    }
  }
}

/** drizzle-orm/d1 が触る範囲だけの D1Database シム。 */
function createD1(sqlite: DatabaseSync): unknown {
  const prepare = (query: string) => {
    const make = (params: unknown[]) => ({
      all: async () => ({
        results: sqlite.prepare(query).all(...(params as never[])),
        success: true,
        meta: {},
      }),
      raw: async () => {
        const stmt = sqlite.prepare(query);
        const names = stmt.columns().map((col) => col.name);
        const rows = stmt.all(...(params as never[])) as Record<string, unknown>[];
        return rows.map((row) => names.map((n) => row[n]));
      },
      run: async () => ({
        results: [],
        success: true,
        meta: sqlite.prepare(query).run(...(params as never[])),
      }),
      first: async () => sqlite.prepare(query).get(...(params as never[])) ?? null,
      bind: (...next: unknown[]) => make(next),
    });
    return make([]);
  };
  return {
    prepare,
    batch: async (list: { all: () => Promise<unknown> }[]) =>
      Promise.all(list.map((s) => s.all())),
  };
}

/** 3 銘柄。`instrument_type` 以外 (名前・業種の有無・データの形) は揃えてある。 */
const STOCKS = [
  { id: 1, code: "7203", name: "テスト普通株", instrumentType: "equity", sector33: "輸送用機器" },
  { id: 2, code: "8951", name: "テストREIT", instrumentType: "reit_fund", sector33: "REIT業種" },
  { id: 3, code: "9999", name: "テスト未分類", instrumentType: null, sector33: "未分類業種" },
] as const;

const FISCAL_YEAR_ENDS = ["2023-03-31", "2024-03-31", "2025-03-31"];

let sqlite: DatabaseSync;
let db: Database;

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  applyD1Migrations(sqlite);

  const insStock = sqlite.prepare(
    "INSERT INTO core_stocks (id, code, name, market, is_active, instrument_type, sector33) VALUES (?, ?, ?, 'プライム', 1, ?, ?)"
  );
  const insFin = sqlite.prepare(
    "INSERT INTO core_stock_financials (stock_id, price, per, roe, market_cap, operating_margin, data_date) VALUES (?, 1000, 12, 0.1, 1.0e11, 0.1, '2026-09-11')"
  );
  const insDoc = sqlite.prepare(
    "INSERT INTO yuho_documents (id, stock_id, edinet_code, doc_id, doc_type_code, filer_name, period_end, submitted_at, parse_status) VALUES (?, ?, ?, ?, '120', ?, '2025-03-31', 1750000000, 'ok_pattern_a')"
  );
  const insOrder = sqlite.prepare(
    "INSERT INTO yuho_order_facts (document_id, stock_id, fiscal_year_end, segment_name, segment_kind, unit_label, orders_received_yen, order_backlog_yen, pattern) VALUES (?, ?, ?, '合計', 'total', '百万円', ?, ?, 'pattern_a')"
  );
  const insOverseas = sqlite.prepare(
    "INSERT INTO yuho_overseas_facts (document_id, stock_id, fiscal_year_end, region_name, region_kind, unit_label, sales_yen, pattern) VALUES (?, ?, ?, ?, ?, '百万円', ?, 'geo_rows')"
  );

  for (const s of STOCKS) {
    insStock.run(s.id, s.code, s.name, s.instrumentType, s.sector33);
    insFin.run(s.id);
    insDoc.run(s.id, s.id, `E0000${s.id}`, `S1000${s.id}`, s.name);
    FISCAL_YEAR_ENDS.forEach((fy, i) => {
      const scale = 1 + i * 0.1;
      insOrder.run(s.id, s.id, fy, 1.0e10 * scale, 2.0e10 * scale);
      insOverseas.run(s.id, s.id, fy, "海外計", "overseas_total", 4.0e9 * scale);
      insOverseas.run(s.id, s.id, fy, "連結", "total", 1.0e10 * scale);
    });
  }

  db = createDb(createD1(sqlite) as D1Database);
});

afterEach(() => {
  sqlite.close();
});

describe("yuho-quant の検索・スクリーニング・業種プルダウンは active かつ equity だけを見る", () => {
  it("searchStocks (名前の部分一致) は equity だけを返す", async () => {
    const hits = await searchStocks(db, "テスト");
    expect(hits.map((h) => h.code)).toEqual(["7203"]);
  });

  it("screenOrderGrowth は equity だけを返す", async () => {
    const rows = await screenOrderGrowth(db, { metric: "orders", minYears: 3, limit: 100 });
    expect(rows.map((r) => r.code)).toEqual(["7203"]);
  });

  it("listSectorsWithOrders は equity の業種だけを返す (結果表と同じ集合)", async () => {
    expect(await listSectorsWithOrders(db)).toEqual(["輸送用機器"]);
  });

  it("screenOverseasGrowth は equity だけを返す", async () => {
    const rows = await screenOverseasGrowth(db, { minYears: 3, limit: 100 });
    expect(rows.map((r) => r.code)).toEqual(["7203"]);
  });

  it("listSectorsWithOverseas は equity の業種だけを返す (結果表と同じ集合)", async () => {
    expect(await listSectorsWithOverseas(db)).toEqual(["輸送用機器"]);
  });
});
