import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "../index.js";

/**
 * L-62: EDINET 由来のみの公開面の Cache-Control と vwap 静的配信。
 *
 * - yuho-quant の SSR: ホーム/一覧は `public, max-age=300`、詳細は 60。
 *   facts は日次取込でしか更新されない。404/422 通知ページには付けない。
 * - `public/_headers`: vwap の data/app.js/vendor を 1 日キャッシュ。
 * - lightweight-charts は unpkg 参照をやめ `vendor/` 同梱の相対参照。
 *
 * D1 シムは sector-ranking-key-switch.test.ts と同じ方式。スキーマは
 * drizzle/d1 のマイグレーションをそのまま流す。
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      run: async () => ({ results: [], success: true, meta: sqlite.prepare(query).run(...(params as any[])) }),
      raw: async () => {
        const stmt = sqlite.prepare(query);
        const names = stmt.columns().map((col) => col.name);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows = stmt.all(...(params as any[])) as Record<string, unknown>[];
        return rows.map((row) => names.map((n) => row[n]));
      },
      first: async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row = sqlite.prepare(query).get(...(params as any[]));
        return row ?? null;
      },
      bind: (...params2: unknown[]) => make(params2),
    });
    return make([]);
  };
  return { prepare };
}

let sqlite: DatabaseSync;

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  applyD1Migrations(sqlite);
});

afterEach(() => {
  sqlite.close();
});

function request(path: string) {
  return app.request(path, {}, { DB: createD1(sqlite) });
}

/** /stock/7203 を 200 にする最小 seed (受注 1 書類・全社合計 1 行)。 */
function seedOrderTrend(): void {
  sqlite
    .prepare(
      "INSERT INTO core_stocks (code, name, market, sector33) VALUES ('7203', 'トヨタ自動車', 'プライム', '輸送用機器')"
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO yuho_documents
         (stock_id, edinet_code, doc_id, doc_type_code, filer_name, period_end, submitted_at, parse_status)
       VALUES (1, 'E00001', 'S100TEST1', '120', 'テスト', '2026-03-31', 1, 'ok_pattern_a')`
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO yuho_order_facts
         (document_id, stock_id, fiscal_year_end, segment_name, segment_kind, unit_label,
          orders_received_yen, order_backlog_yen, pattern)
       VALUES (1, 1, '2026-03-31', '全社', 'total', '百万円', 100, 50, 'pattern_a')`
    )
    .run();
}

describe("yuho-quant SSR の Cache-Control (L-62)", () => {
  it("ホームは public, max-age=300 (検索なし・あり両方)", async () => {
    const bare = await request("/");
    expect(bare.status).toBe(200);
    expect(bare.headers.get("Cache-Control")).toBe("public, max-age=300");
    const searched = await request("/?q=%E3%83%88%E3%83%A8%E3%82%BF");
    expect(searched.status).toBe(200);
    expect(searched.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  it("受注スクリーニング一覧と JSON は public, max-age=300", async () => {
    const page = await request("/screening");
    expect(page.status).toBe(200);
    expect(page.headers.get("Cache-Control")).toBe("public, max-age=300");
    const api = await request("/api/screening");
    expect(api.status).toBe(200);
    expect(api.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  it("銘柄詳細と JSON は public, max-age=60", async () => {
    seedOrderTrend();
    const page = await request("/stock/7203");
    expect(page.status).toBe(200);
    expect(page.headers.get("Cache-Control")).toBe("public, max-age=60");
    const api = await request("/api/trend/7203");
    expect(api.status).toBe(200);
    expect(api.headers.get("Cache-Control")).toBe("public, max-age=60");
  });

  it("存在しない銘柄の 404 には Cache-Control を付けない", async () => {
    const page = await request("/stock/9999");
    expect(page.status).toBe(404);
    expect(page.headers.get("Cache-Control")).toBeNull();
    const api = await request("/api/trend/9999");
    expect(api.status).toBe(404);
    expect(api.headers.get("Cache-Control")).toBeNull();
  });
});

describe("vwap 静的配信 (L-62)", () => {
  it("public/_headers が data/app.js/vendor に 86400 を付ける", () => {
    const headers = readFileSync(join(ROOT, "public", "_headers"), "utf-8");
    for (const path of [
      "/vwap-analysis/data/*",
      "/vwap-analysis/app.js",
      "/vwap-analysis/vendor/*",
    ]) {
      expect(headers).toContain(path);
    }
    expect(headers).toContain("Cache-Control: public, max-age=86400");
  });

  it("index.html は unpkg を参照せず vendor 同梱を読む", () => {
    const html = readFileSync(
      join(ROOT, "public", "vwap-analysis", "index.html"),
      "utf-8"
    );
    expect(html).not.toContain("unpkg.com");
    expect(html).toContain(
      "./vendor/lightweight-charts.standalone.production.js"
    );
    const vendor = join(
      ROOT,
      "public",
      "vwap-analysis",
      "vendor",
      "lightweight-charts.standalone.production.js"
    );
    expect(existsSync(vendor)).toBe(true);
    // unpkg の v4.2.0 と同一 (台帳の実測 163,551 B)。差し替え検出用。
    expect(readFileSync(vendor, "utf-8")).toContain(
      "Lightweight Charts™ v4.2.0"
    );
  });
});
