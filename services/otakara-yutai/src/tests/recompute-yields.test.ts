/**
 * 要約取り込み後の優待利回り再計算 (`recompute-yields.ts`) のテスト。
 *
 * 固定したい契約:
 *   1. 計算式は月次 rebuild と同一 (`calcYutaiYield` を共有するため、式の
 *      二重実装による乖離は起きない)。
 *   2. 値が変わる銘柄だけ書く。変わらない銘柄・対象外の銘柄には触らない。
 *   3. `data_date` は月次の作り直し日に据え置く (行全体の作り直しではない)。
 *   4. dry-run の overlay は書き込み予定値を仮適用した利回りを見せる。
 *   5. 再実行で 0 件 (冪等)。
 *
 * D1 は yutai-full-import.test.ts と同じく、drizzle/d1 のマイグレーションを
 * 流したローカル SQLite に sqlite-proxy で向ける。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { scoreStock } from "../../../../src/shared/scoring.js";
import {
  applyYieldRecompute,
  computeYieldEntries,
  planYieldRecompute,
  type RecomputeYieldsDb,
} from "../../data-scripts/recompute-yields.js";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";

function applyD1Migrations(target: DatabaseSync): void {
  const dir = join(ROOT, "drizzle", "d1");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf-8").split("--> statement-breakpoint")) {
      if (stmt.trim()) target.exec(stmt);
    }
  }
}

function makeProxyDb(target: DatabaseSync) {
  return drizzle(async (sqlStr, params, method) => {
    const stmt = target.prepare(sqlStr);
    const bind = params as (null | number | bigint | string | Uint8Array)[];
    if (method === "run") {
      stmt.run(...bind);
      return { rows: [] };
    }
    const rows = (stmt.all(...bind) as Record<string, unknown>[]).map((o) => Object.values(o));
    return { rows: method === "get" ? (rows[0] ?? []) : rows };
  });
}

let sqlite: DatabaseSync;
let db: RecomputeYieldsDb;

const STOCK_A = 101; // 利回りが変わる (100株 1,000→5,000円)
const STOCK_B = 102; // 財務行が無い (対象外)
const STOCK_C = 103; // 変わらない
const STOCK_D = 104; // 触らない (stockIds に含めない)
const STOCK_E = 105; // 財務行はあるがスコア行が無い (スコアだけ対象外)

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  applyD1Migrations(sqlite);
  const insStock = sqlite.prepare(
    "INSERT INTO core_stocks (id, code, name, market, is_active, is_yutai, instrument_type) VALUES (?, ?, ?, 'テスト市場', 1, 1, 'equity')"
  );
  for (const [id, code] of [[STOCK_A, "9101"], [STOCK_B, "9102"], [STOCK_C, "9103"], [STOCK_D, "9104"], [STOCK_E, "9105"]] as const) {
    insStock.run(id, code, `テスト${code}`);
  }
  sqlite.prepare("INSERT INTO yutai_genres (id, name, slug, description) VALUES (1, 'その他', 'other', '')").run();
  const insBenefit = sqlite.prepare(
    "INSERT INTO yutai_benefits (stock_id, genre_id, description, short_summary, min_shares, record_month, estimated_value) VALUES (?, 1, ?, ?, ?, ?, ?)"
  );
  // A: 100株 5,000円 (現入力)。保存利回りは旧入力 (1,000円) の 1.007% のまま
  insBenefit.run(STOCK_A, "架空ギフト 5,000円相当", "要約A", 100, 3, 5000);
  // C: 100株 1,000円。保存利回りと一致
  insBenefit.run(STOCK_C, "架空ギフト 1,000円相当", "要約C", 100, 3, 1000);
  // D: 触らない銘柄の行
  insBenefit.run(STOCK_D, "架空ギフト 1,000円相当", "要約D", 100, 3, 1000);
  const insFin = sqlite.prepare(
    "INSERT INTO otakara_stock_financials (stock_id, price, per, pbr, dividend_yield, roe, yutai_yield, data_date) VALUES (?, ?, ?, ?, ?, ?, ?, '2026-09-13')"
  );
  insFin.run(STOCK_A, 993, 10, 1.0, 2.0, 8.0, 1.0070493454179255);
  insFin.run(STOCK_C, 1000, 10, 1.0, 2.0, 8.0, 1.0);
  insFin.run(STOCK_D, 1000, 10, 1.0, 2.0, 8.0, 1.0);
  insFin.run(STOCK_E, 1000, 10, 1.0, 2.0, 8.0, 1.0);
  // A のスコアは旧利回り (1.007%) で計算済み。C/D は現利回りと一致
  const insScore = sqlite.prepare(
    "INSERT INTO otakara_stock_scores (stock_id, fundamental_score, technical_score, total_score) VALUES (?, ?, ?, ?)"
  );
  const scoreOf = (yutaiYield: number | null) => {
    const s = scoreStock({
      price: 993, per: 10, pbr: 1.0, dividendYield: 2.0, roe: 8.0,
      ma25: null, rsi14: null, macd: null, macdSignal: null, yutaiYield,
    });
    return [s.fundamentalScore, s.technicalScore, s.totalScore] as const;
  };
  insScore.run(STOCK_A, ...scoreOf(1.0070493454179255));
  insScore.run(STOCK_C, ...scoreOf(1.0));
  insScore.run(STOCK_D, ...scoreOf(1.0));
  db = makeProxyDb(sqlite) as unknown as RecomputeYieldsDb;
});

afterEach(() => {
  sqlite.close();
});

const finOf = (stockId: number) =>
  sqlite.prepare("SELECT price, yutai_yield, data_date FROM otakara_stock_financials WHERE stock_id = ?").get(stockId) as {
    price: number;
    yutai_yield: number | null;
    data_date: string;
  };

describe("planYieldRecompute", () => {
  it("変わる銘柄だけ changed になり、財務行の無い銘柄は対象外", async () => {
    const plan = await planYieldRecompute(db, [STOCK_A, STOCK_B, STOCK_C]);
    expect(plan.skippedNoRow).toEqual([STOCK_B]);
    expect(plan.skippedNoScore).toEqual([]);
    const [a, c] = plan.entries;
    expect([a.stockId, a.prev, a.next, a.changed]).toEqual([
      STOCK_A,
      1.0070493454179255,
      (5000 / (993 * 100)) * 100,
      true,
    ]);
    expect([c.stockId, c.prev, c.next, c.changed, c.scoreChanged]).toEqual([
      STOCK_C,
      1.0,
      1.0,
      false,
      false,
    ]);
    // A は利回りと一緒にスコアも変わる (優待利回り 15% の重み)
    expect(a.scoreChanged).toBe(true);
    const expectA = scoreStock({
      price: 993, per: 10, pbr: 1.0, dividendYield: 2.0, roe: 8.0,
      ma25: null, rsi14: null, macd: null, macdSignal: null, yutaiYield: a.next,
    });
    expect(a.scoreNext).toEqual({
      fundamentalScore: expectA.fundamentalScore,
      technicalScore: expectA.technicalScore,
      totalScore: expectA.totalScore,
    });
  });

  it("スコア行の無い銘柄はスコアだけ対象外 (利回りは再計算する)", async () => {
    const plan = await planYieldRecompute(db, [STOCK_E]);
    expect(plan.skippedNoScore).toEqual([STOCK_E]);
    expect(plan.entries).toEqual([
      {
        stockId: STOCK_E,
        prev: 1.0,
        next: null,
        changed: true,
        scorePrev: null,
        scoreNext: expect.anything(),
        scoreChanged: false,
      },
    ]);
  });

  it("overlay は書き込み予定値を仮適用する (dry-run の先見せ)", async () => {
    const rowId = (
      sqlite.prepare("SELECT id FROM yutai_benefits WHERE stock_id = ?").get(STOCK_C) as { id: number }
    ).id;
    const plan = await planYieldRecompute(db, [STOCK_C], new Map([[rowId, 2000]]));
    expect(plan.entries.map((e) => [e.prev, e.next, e.changed])).toEqual([[1.0, 2.0, true]]);
    // overlay は DB を変えない
    expect(finOf(STOCK_C).yutai_yield).toBe(1.0);
  });

  it("overlay の null は利回り入力から外す", () => {
    const entries = computeYieldEntries(
      [STOCK_C],
      {
        prices: new Map([[STOCK_C, { price: 1000, yutaiYield: 1.0 }]]),
        benefits: new Map([[STOCK_C, [{ rowId: 7, minShares: 100, estimatedValue: 1000 }]]]),
        scoreInputs: new Map(),
        scores: new Map(),
      },
      new Map([[7, null]])
    );
    expect(entries.entries.map((e) => [e.prev, e.next, e.changed])).toEqual([[1.0, null, true]]);
  });
});

const scoreOf = (stockId: number) =>
  sqlite.prepare("SELECT fundamental_score, technical_score, total_score FROM otakara_stock_scores WHERE stock_id = ?").get(stockId) as {
    fundamental_score: number;
    technical_score: number;
    total_score: number;
  };

describe("applyYieldRecompute", () => {
  it("変わる行だけ yutai_yield とスコアを書き、data_date は据え置く。再実行は 0 件", async () => {
    const plan = await planYieldRecompute(db, [STOCK_A, STOCK_B, STOCK_C]);
    const { updated, scoresUpdated } = await applyYieldRecompute(db, plan);
    expect(updated).toBe(1);
    expect(scoresUpdated).toBe(1);
    expect(finOf(STOCK_A).yutai_yield).toBeCloseTo(5.0352467, 6);
    expect(finOf(STOCK_A).data_date).toBe("2026-09-13");
    expect(finOf(STOCK_C).yutai_yield).toBe(1.0);
    // スコアも新しい利回りで追随する
    const expectA = scoreStock({
      price: 993, per: 10, pbr: 1.0, dividendYield: 2.0, roe: 8.0,
      ma25: null, rsi14: null, macd: null, macdSignal: null, yutaiYield: finOf(STOCK_A).yutai_yield,
    });
    expect(scoreOf(STOCK_A)).toEqual({
      fundamental_score: expectA.fundamentalScore,
      technical_score: expectA.technicalScore,
      total_score: expectA.totalScore,
    });
    // 対象外の銘柄には触らない
    expect(finOf(STOCK_D).yutai_yield).toBe(1.0);

    const again = await planYieldRecompute(db, [STOCK_A, STOCK_C]);
    expect(again.entries.every((e) => !e.changed && !e.scoreChanged)).toBe(true);
    const redo = await applyYieldRecompute(db, again);
    expect(redo).toEqual({ updated: 0, scoresUpdated: 0 });
  });
});
