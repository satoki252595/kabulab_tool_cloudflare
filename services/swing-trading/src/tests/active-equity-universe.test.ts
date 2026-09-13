/**
 * swing-trading の公開面が**日次の母集団 (active かつ equity)** の銘柄だけを出すことの検証。
 * **値**で見る (書き方の検査は src/shared/db/active-equity.test.ts)。
 *
 * 日次取込 (src/cron/daily.ts) は 2026-09-13 から active かつ equity だけを更新する。
 * 非普通株 (REIT 等) の `swing_stock_screening` / `swing_entry_signals` 行は消されずに
 * 凍結するので、公開面が同じ述語で絞らないと古いシグナルや通過判定が今日の行として並ぶ。
 * 固定したい契約: 次のどこにも reit_fund の銘柄が出ない。
 *
 *   - GET /screening のロング / ショート (以前は is_active の条件も無かった)
 *   - GET /signals の all / pattern 指定
 *   - GET / の強度上位シグナルと「シグナル総数」
 *
 * GET /screening は core_stocks を CROSS JOIN + WHERE の等値で結ぶ (pages.ts のコメント)。
 * 結合条件はその等値 1 項だけが担うので、1 銘柄 1 行であることと、発行 SQL の形も固定する。
 *
 * 非普通株の行は、絞り込みが外れたら**先頭に来る**値 (売買代金・シグナル強度が最大)
 * にしてある。末尾に並ぶ値だと、limit で切れて「出ない」ように見えてしまう。
 *
 * D1 シムとスキーマは sector-ranking-key-switch.test.ts と同じ方式
 * (node:sqlite に drizzle/d1 のマイグレーションをそのまま流す)。
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { swingTradingApp } from "../../app.js";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

function applyD1Migrations(target: DatabaseSync): void {
  const dir = join(ROOT, "drizzle", "d1");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf-8").split("--> statement-breakpoint")) {
      if (stmt.trim()) target.exec(stmt);
    }
  }
}

/** drizzle-orm/d1 が触る範囲だけの D1Database シム。発行した SQL を `queries` に積む。 */
function createD1(sqlite: DatabaseSync, queries: string[]): unknown {
  const prepare = (query: string) => {
    queries.push(query);
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

const EQUITY_CODE = "7203";
const REIT_CODE = "8951";

let sqlite: DatabaseSync;
let queries: string[];

beforeEach(() => {
  queries = [];
  sqlite = new DatabaseSync(":memory:");
  applyD1Migrations(sqlite);

  const insStock = sqlite.prepare(
    "INSERT INTO core_stocks (id, code, name, market, is_active, instrument_type) VALUES (?, ?, ?, 'プライム', 1, ?)"
  );
  const insIndicator = sqlite.prepare(
    "INSERT INTO swing_stock_indicators (stock_id, latest_close, avg_turnover_20d, atr_pct, pct_change_1d) VALUES (?, 1000, ?, 2.0, 1.0)"
  );
  // ロング通過とショート通過の両方を立てる (1 銘柄 1 行なので同じ行に)。
  const insScreening = sqlite.prepare(
    "INSERT INTO swing_stock_screening (stock_id, liquidity_ok, volatility_ok, trend_ok_long, trend_ok_short, all_passed_long, all_passed_short) VALUES (?, 1, 1, 1, 1, 1, 1)"
  );
  const insSignal = sqlite.prepare(
    "INSERT INTO swing_entry_signals (stock_id, pattern, direction, entry_price, stop_loss, signal_strength, note) VALUES (?, 'breakout_long', 'long', 1000, 950, ?, 'テスト')"
  );

  insStock.run(1, EQUITY_CODE, "普通株テスト", "equity");
  insIndicator.run(1, 1.0e9);
  insScreening.run(1);
  insSignal.run(1, 50);

  // 日次の対象外になった REIT。絞り込みが外れたら先頭に来る値にする。
  insStock.run(2, REIT_CODE, "REITテスト", "reit_fund");
  insIndicator.run(2, 9.0e9);
  insScreening.run(2);
  insSignal.run(2, 99);
});

afterEach(() => {
  sqlite.close();
});

async function page(path: string): Promise<string> {
  const res = await swingTradingApp.request(path, {}, { DB: createD1(sqlite, queries) });
  expect(res.status, path).toBe(200);
  return res.text();
}

describe("swing-trading の一覧は active かつ equity の銘柄だけを出す", () => {
  it.each(["/screening?direction=long", "/screening?direction=short"])(
    "GET %s に reit_fund が出ない",
    async (path) => {
      const html = await page(path);
      expect(html).toContain(`/stock/${EQUITY_CODE}"`);
      expect(html).not.toContain(REIT_CODE);
    }
  );

  it.each(["/screening?direction=long", "/screening?direction=short"])(
    "GET %s は 1 銘柄 1 行で、core_stocks を CROSS JOIN + 等値で結ぶ",
    async (path) => {
      const html = await page(path);
      // 等値を消すと screening 行 × equity 行の直積になり、REIT の screening /
      // indicators の値が 7203 の名前でもう 1 行並ぶ。REIT のコードは出ないので、
      // 上の not.toContain(REIT_CODE) だけでは素通りする。
      expect(html.split(`/stock/${EQUITY_CODE}"`).length - 1).toBe(1);

      const screeningSql = queries.find((q) => q.includes('from "swing_stock_screening"'));
      expect(screeningSql).toBeDefined();
      // INNER JOIN に戻すと core_stocks の is_active 索引が外側ループになり、本番の
      // rows_read が long 356 → 7,585 / short 1,356 → 8,085 に増える (pages.ts)。
      expect(screeningSql).toContain('from "swing_stock_screening" cross join "core_stocks"');
      expect(screeningSql).toContain('"core_stocks"."id" = "swing_stock_screening"."stock_id"');
    }
  );

  it.each(["/signals?pattern=all", "/signals?pattern=breakout_long"])(
    "GET %s に reit_fund が出ない",
    async (path) => {
      const html = await page(path);
      expect(html).toContain(`/stock/${EQUITY_CODE}"`);
      expect(html).not.toContain(REIT_CODE);
    }
  );

  it("GET / の強度上位シグナルに reit_fund が出ない", async () => {
    const html = await page("/");
    expect(html).toContain(`/stock/${EQUITY_CODE}"`);
    expect(html).not.toContain(REIT_CODE);
  });

  it("GET / のシグナル総数に reit_fund のシグナルを数えない", async () => {
    // 一覧 (/signals) と同じ母集団で数える。述語を外すと REIT の凍結シグナルも数えて 2 になる。
    const html = await page("/");
    expect(html).toMatch(/シグナル総数<\/div>\s*<div class="val">1<\/div>/);
  });
});
