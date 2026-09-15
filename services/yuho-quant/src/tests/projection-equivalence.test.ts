import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Database } from "../db/client.js";
import {
  listSectorsWithOrders,
  screenOrderGrowth,
} from "../services/order-query.js";
import {
  listSectorsWithOverseas,
  screenOverseasGrowth,
} from "../services/overseas-query.js";
import { rebuildYuhoGrowthProjection } from "../services/projection.js";

/**
 * L-51/K4b: L2 投影 `p_yuho_growth` の再生成と画面読みの等価性。
 *
 * ファクトを seed → 再生成 → 新画面、の全経路を通し、旧実装 (JS で全行
 * 畳み込み) と同じ ScreenRow が出ることを手計算値で固定する。
 * 7203 以外のコードは合成 (1000〜1299)。
 */

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

function applyD1Migrations(target: DatabaseSync): void {
  const dir = join(ROOT, "drizzle", "d1");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf-8").split(
      "--> statement-breakpoint"
    )) {
      if (stmt.trim()) target.exec(stmt);
    }
  }
}

/** drizzle-orm/d1 が触る範囲だけの D1Database シム。 */
function createD1(sqlite: DatabaseSync): unknown {
  const prepare = (query: string) => {
    const make = (params: unknown[]) => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      all: async () => ({ results: sqlite.prepare(query).all(...(params as any[])), success: true, meta: {} }),
      raw: async () => {
        const stmt = sqlite.prepare(query);
        const names = stmt.columns().map((col) => col.name);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows = stmt.all(...(params as any[])) as Record<string, unknown>[];
        return rows.map((row) => names.map((n) => row[n]));
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      run: async () => ({ results: [], success: true, meta: sqlite.prepare(query).run(...(params as any[])) }),
      first: async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row = sqlite.prepare(query).get(...(params as any[]));
        return row ?? null;
      },
      bind: (...next: unknown[]) => make(next),
    });
    return make([]);
  };
  return { prepare };
}

let sqlite: DatabaseSync;
let db: Database;
let docSeq = 0;

function seedStock(
  id: number,
  code: string,
  instrumentType: string | null,
  sector33: string
): void {
  sqlite
    .prepare(
      "INSERT INTO core_stocks (id, code, name, market, is_active, instrument_type, sector33) VALUES (?, ?, ?, 'プライム', 1, ?, ?)"
    )
    .run(id, code, `テスト${code}`, instrumentType, sector33);
}

function seedFin(stockId: number, opMargin: number | null): void {
  sqlite
    .prepare(
      "INSERT INTO core_stock_financials (stock_id, price, per, roe, market_cap, operating_margin, dividend_yield, data_date) VALUES (?, 1000, 12, 0.1, 1.0e11, ?, 2.0, '2026-09-11')"
    )
    .run(stockId, opMargin);
}

function seedDoc(stockId: number, submittedAt: number): number {
  docSeq += 1;
  sqlite
    .prepare(
      "INSERT INTO yuho_documents (id, stock_id, edinet_code, doc_id, doc_type_code, filer_name, period_end, submitted_at, parse_status) VALUES (?, ?, ?, ?, '120', ?, '2025-03-31', ?, 'ok_pattern_a')"
    )
    .run(docSeq, stockId, `E${docSeq}`, `S100T${docSeq}`, `テスト${stockId}`, submittedAt);
  return docSeq;
}

function seedOrder(
  docId: number,
  stockId: number,
  fy: string,
  ordersYen: number | null,
  backlogYen: number | null
): void {
  sqlite
    .prepare(
      "INSERT INTO yuho_order_facts (document_id, stock_id, fiscal_year_end, segment_name, segment_kind, unit_label, orders_received_yen, order_backlog_yen, pattern) VALUES (?, ?, ?, '合計', 'total', '百万円', ?, ?, 'pattern_a')"
    )
    .run(docId, stockId, fy, ordersYen, backlogYen);
}

function seedOverseas(
  docId: number,
  stockId: number,
  fy: string,
  regionName: string,
  regionKind: string,
  salesYen: number | null
): void {
  sqlite
    .prepare(
      "INSERT INTO yuho_overseas_facts (document_id, stock_id, fiscal_year_end, region_name, region_kind, unit_label, sales_yen, pattern) VALUES (?, ?, ?, ?, ?, '百万円', ?, 'geo_rows')"
    )
    .run(docId, stockId, fy, regionName, regionKind, salesYen);
}

beforeEach(async () => {
  sqlite = new DatabaseSync(":memory:");
  applyD1Migrations(sqlite);
  docSeq = 0;

  // A=7203: 受注 5 期 (年率ちょうど +10%) + 海外 5 期 + 地域行
  seedStock(1, "7203", "equity", "輸送用機器");
  seedFin(1, 0.1);
  const docA = seedDoc(1, 1750000000);
  const orders = [100, 110, 121, 133.1, 146.41];
  ["2021-03-31", "2022-03-31", "2023-03-31", "2024-03-31", "2025-03-31"].forEach(
    (fy, i) => {
      seedOrder(docA, 1, fy, orders[i], 200);
      seedOverseas(docA, 1, fy, "海外売上高", "overseas_total", 100 + i * 25);
      seedOverseas(docA, 1, fy, "連結売上高", "total", 1000);
    }
  );
  // 末端期の地域行。中国は単独合致 2 行 (30+20)、複合 "アジア・中国" は除外。
  seedOverseas(docA, 1, "2025-03-31", "中国", "overseas", 30);
  seedOverseas(docA, 1, "2025-03-31", "中華圏", "overseas", 20);
  seedOverseas(docA, 1, "2025-03-31", "アジア・中国", "overseas", 1000);
  seedOverseas(docA, 1, "2025-03-31", "米国", "overseas", 40);
  seedOverseas(docA, 1, "2025-03-31", "台湾", "overseas", 5);

  // B=1001: 訂正 (同 fy に旧新 2 書類) + 2 期のみ + 受注残高 null + 財務 null
  seedStock(2, "1001", "equity", "輸送用機器");
  seedFin(2, null);
  const docBold = seedDoc(2, 1750000000);
  seedOrder(docBold, 2, "2024-03-31", 999, null);
  const docBnew = seedDoc(2, 1760000000);
  seedOrder(docBnew, 2, "2024-03-31", 100, null);
  seedOrder(docBnew, 2, "2025-03-31", 121, null);

  // C=1002: 海外合計のみ 3 期 (地域行なし)
  seedStock(3, "1002", "equity", "情報・通信業");
  seedFin(3, 0.1);
  const docC = seedDoc(3, 1750000000);
  ["2023-03-31", "2024-03-31", "2025-03-31"].forEach((fy) => {
    seedOverseas(docC, 3, fy, "海外売上高", "overseas_total", 200);
    seedOverseas(docC, 3, fy, "連結売上高", "total", 1000);
  });

  // D=1003: 非普通株 (投影行は作るが画面は出さない)
  seedStock(4, "1003", "reit_fund", "REIT業種");
  seedFin(4, 0.1);
  const docD = seedDoc(4, 1750000000);
  ["2023-03-31", "2024-03-31", "2025-03-31"].forEach((fy) => {
    seedOrder(docD, 4, fy, 100, 100);
  });

  // E=1004: ファクトなし (投影行なし)
  seedStock(5, "1004", "equity", "輸送用機器");

  db = createDb(createD1(sqlite) as D1Database);
  await rebuildYuhoGrowthProjection(db);
});

afterEach(() => {
  sqlite.close();
});

describe("p_yuho_growth の再生成 (L-51/K4b)", () => {
  it("ファクトのある 4 銘柄ぶん行を作る (非普通株も。画面側で落とす)", async () => {
    const r = await rebuildYuhoGrowthProjection(db);
    expect(r.stocks).toBe(4);
    const n = sqlite
      .prepare("SELECT COUNT(*) c FROM p_yuho_growth")
      .get() as { c: number };
    expect(n.c).toBe(4);
  });

  it("受注の窓・訂正・年率を旧式どおり畳む", () => {
    const a = sqlite
      .prepare("SELECT * FROM p_yuho_growth WHERE stock_id = 1")
      .get() as Record<string, unknown>;
    expect(a["ord_years"]).toBe(5);
    expect(a["ord_first_fy"]).toBe("2021-03-31");
    expect(a["ord_last_fy"]).toBe("2025-03-31");
    expect(a["ord_orders_cagr"]).toBeCloseTo(0.1, 12);
    expect(a["ord_backlog_cagr"]).toBe(0);
    expect(a["ord_orders_yoy"]).toBeCloseTo(0.1, 12);
    expect(a["ord_has_year_gap"]).toBe(0);

    // B は訂正で新書類 (100) が勝ち、2 期窓で年率 +21%
    const b = sqlite
      .prepare("SELECT * FROM p_yuho_growth WHERE stock_id = 2")
      .get() as Record<string, unknown>;
    expect(b["ord_years"]).toBe(2);
    expect(b["ord_first_orders_yen"]).toBe(100);
    expect(b["ord_orders_cagr"]).toBeCloseTo(0.21, 12);
    expect(b["ord_backlog_cagr"]).toBeNull();
  });

  it("海外の比率・年率・地域円貨を旧式どおり畳む", () => {
    const a = sqlite
      .prepare("SELECT * FROM p_yuho_growth WHERE stock_id = 1")
      .get() as Record<string, unknown>;
    expect(a["ovs_years"]).toBe(5);
    expect(a["ovs_latest_ratio_pct"]).toBe(20);
    expect(a["ovs_first_ratio_pct"]).toBe(10);
    expect(a["ovs_overseas_cagr"]).toBeCloseTo(Math.pow(2, 0.25) - 1, 12);
    expect(a["ovs_has_overseas_total"]).toBe(1);
    // 中国 30+20。複合 "アジア・中国" 1000 はどのバケットにも入らない
    expect(a["ovs_region_china_yen"]).toBe(50);
    expect(a["ovs_region_americas_yen"]).toBe(40);
    expect(a["ovs_region_europe_yen"]).toBeNull();
    expect(a["ovs_region_asia_yen"]).toBe(5);

    const c = sqlite
      .prepare("SELECT * FROM p_yuho_growth WHERE stock_id = 3")
      .get() as Record<string, unknown>;
    expect(c["ovs_latest_ratio_pct"]).toBe(20);
    expect(c["ovs_overseas_cagr"]).toBe(0);
    expect(c["ovs_region_china_yen"]).toBeNull();
  });

  it("来歴列を埋める", () => {
    const a = sqlite
      .prepare(
        "SELECT as_of, source_max_date FROM p_yuho_growth WHERE stock_id = 1"
      )
      .get() as { as_of: string; source_max_date: string };
    expect(a.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // MAX(submitted_at) = B の訂正新書類 1760000000
    expect(a.source_max_date).toBe(
      new Date(1760000000 * 1000).toISOString().slice(0, 10)
    );
  });

  it("ファクトが消えた銘柄の行を sweep する", async () => {
    sqlite.prepare("DELETE FROM yuho_order_facts WHERE stock_id = 2").run();
    const r = await rebuildYuhoGrowthProjection(db, {
      runStartedSec: Math.floor(Date.now() / 1000) + 5,
    });
    expect(r.stocks).toBe(3);
    const n = sqlite
      .prepare("SELECT COUNT(*) c FROM p_yuho_growth WHERE stock_id = 2")
      .get() as { c: number };
    expect(n.c).toBe(0);
  });
});

describe("投影読みの画面は旧実装と同じ行を返す", () => {
  it("受注: 年率・欠落・並び順", async () => {
    const rows = await screenOrderGrowth(db, {
      metric: "orders",
      minYears: 2,
      limit: 100,
    });
    // B (+21%) が A (+10%) より上
    expect(rows.map((r) => r.code)).toEqual(["1001", "7203"]);
    const a = rows[1];
    expect(a.years).toBe(5);
    expect(a.firstFiscalYearEnd).toBe("2021-03-31");
    expect(a.lastFiscalYearEnd).toBe("2025-03-31");
    expect(a.latestOrdersYen).toBe(146.41);
    expect(a.firstOrdersYen).toBe(100);
    expect(a.ordersCagr).toBeCloseTo(0.1, 12);
    expect(a.backlogCagr).toBe(0);
    expect(a.hasYearGap).toBe(false);
  });

  it("受注: minYears 未満は除外、metric null も除外", async () => {
    const y3 = await screenOrderGrowth(db, {
      metric: "orders",
      minYears: 3,
      limit: 100,
    });
    expect(y3.map((r) => r.code)).toEqual(["7203"]);
    // backlog 基準: B は backlog null で順位付け不能 → 除外
    const bl = await screenOrderGrowth(db, {
      metric: "backlog",
      minYears: 2,
      limit: 100,
    });
    expect(bl.map((r) => r.code)).toEqual(["7203"]);
  });

  it("受注: 年率・業種・ファンダ絞り込み", async () => {
    const cagr = await screenOrderGrowth(db, {
      metric: "orders",
      minYears: 2,
      minOrdersCagrPct: 15,
      limit: 100,
    });
    expect(cagr.map((r) => r.code)).toEqual(["1001"]);
    const sector = await screenOrderGrowth(db, {
      metric: "orders",
      minYears: 2,
      sector: "情報・通信業",
      limit: 100,
    });
    expect(sector).toEqual([]);
    // B は operating_margin null → 条件を満たせず除外
    const funda = await screenOrderGrowth(db, {
      metric: "orders",
      minYears: 2,
      minOpMarginPct: 5,
      limit: 100,
    });
    expect(funda.map((r) => r.code)).toEqual(["7203"]);
  });

  it("海外: 比率・年率・並び順", async () => {
    const rows = await screenOverseasGrowth(db, { minYears: 3, limit: 100 });
    // A も C も直近 20%。同率は code 昇順で確定
    expect(rows.map((r) => r.code)).toEqual(["1002", "7203"]);
    const a = rows[1];
    expect(a.latestRatioPct).toBe(20);
    expect(a.firstRatioPct).toBe(10);
    expect(a.ratioChangePp).toBe(10);
    expect(a.latestOverseasYen).toBe(200);
    expect(a.latestTotalYen).toBe(1000);
    expect(a.firstOverseasYen).toBe(100);
    expect(a.overseasCagr).toBeCloseTo(Math.pow(2, 0.25) - 1, 12);
    expect(a.regionLabel).toBeNull();
    expect(a.latestRegionYen).toBeNull();
    expect(a.regionRatioPct).toBeNull();
  });

  it("海外: 地域選択時は円貨と比率を復元する", async () => {
    const rows = await screenOverseasGrowth(db, {
      minYears: 3,
      region: "china",
      limit: 100,
    });
    expect(rows.map((r) => r.code)).toEqual(["1002", "7203"]);
    const a = rows[1];
    expect(a.regionLabel).toBe("中国・中華圏");
    expect(a.latestRegionYen).toBe(50);
    expect(a.regionRatioPct).toBe(5);
    const c = rows[0];
    expect(c.latestRegionYen).toBeNull();
    expect(c.regionRatioPct).toBeNull();
  });

  it("海外: 地域レンジは未開示を除外し、未選択時は無視する", async () => {
    const withRange = await screenOverseasGrowth(db, {
      minYears: 3,
      region: "china",
      minRegionRatioPct: 1,
      limit: 100,
    });
    expect(withRange.map((r) => r.code)).toEqual(["7203"]);
    // 地域未選択でレンジだけ入力 → 無視して全件
    const ignored = await screenOverseasGrowth(db, {
      minYears: 3,
      minRegionRatioPct: 99,
      limit: 100,
    });
    expect(ignored.map((r) => r.code)).toEqual(["1002", "7203"]);
  });

  it("プルダウンは結果表と同じ母集団", async () => {
    // 受注ファクトを持つのは A/B/D。画面に出る業種は A/B のみ
    expect(await listSectorsWithOrders(db)).toEqual(["輸送用機器"]);
    // overseas_total 行を持つのは A/C/D
    expect(await listSectorsWithOverseas(db)).toEqual([
      "情報・通信業",
      "輸送用機器",
    ]);
  });
});
