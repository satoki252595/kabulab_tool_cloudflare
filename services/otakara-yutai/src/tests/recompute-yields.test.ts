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
import type { D1BatchStatement } from "../../../../src/shared/db/d1-http-client.js";
import { scoreStock } from "../../../../src/shared/scoring.js";
import {
  applyYieldRecomputeAtomically,
  computeYieldEntries,
  fetchYieldInputs,
  planYieldRecompute,
  type RecomputeYieldsDb,
} from "../../data-scripts/recompute-yields.js";
import { snapshotStockPreimages } from "../../data-scripts/atomic-apply.js";
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
    "INSERT INTO yutai_benefits (stock_id, genre_id, description, short_summary, min_shares, record_month, estimated_value, estimate_value_source) VALUES (?, 1, ?, ?, ?, ?, ?, 'company')"
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
    // 予定値は文言と整合するものだけ通る (2,000 円の額面に 2,000 円)。
    sqlite.prepare("UPDATE yutai_benefits SET description = ? WHERE stock_id = ?").run("架空ギフト 2,000円相当", STOCK_C);
    const rowId = (
      sqlite.prepare("SELECT id FROM yutai_benefits WHERE stock_id = ?").get(STOCK_C) as { id: number }
    ).id;
    const plan = await planYieldRecompute(db, [STOCK_C], new Map([[rowId, { value: 2000, source: "company" }]]));
    expect(plan.entries.map((e) => [e.prev, e.next, e.changed])).toEqual([[1.0, 2.0, true]]);
    // overlay は DB を変えない
    expect(finOf(STOCK_C).yutai_yield).toBe(1.0);
  });

  it("overlay の null は利回り入力から外す", () => {
    const entries = computeYieldEntries(
      [STOCK_C],
      {
        prices: new Map([[STOCK_C, { price: 1000, yutaiYield: 1.0, dataDate: "2026-09-13", fetchedAt: 1 }]]),
        benefits: new Map([
          [
            STOCK_C,
            [
              {
                rowId: 7,
                minShares: 100,
                recordMonth: 3,
                description: "架空",
                shortSummary: null,
                estimatedValue: 1000,
                estimateValueSource: "company",
                updatedAt: 1,
              },
            ],
          ],
        ]),
        scoreInputs: new Map(),
        scores: new Map(),
        parents: new Map(),
      },
      new Map([[7, { value: null, source: null }]])
    );
    expect(entries.entries.map((e) => [e.prev, e.next, e.changed])).toEqual([[1.0, null, true]]);
  });

  it("source NULL の非 null 値は利回りに入れない (0 フォールバックしない)", () => {
    const entries = computeYieldEntries(
      [STOCK_C],
      {
        prices: new Map([[STOCK_C, { price: 1000, yutaiYield: 1.0, dataDate: "2026-09-13", fetchedAt: 1 }]]),
        benefits: new Map([
          [
            STOCK_C,
            [
              {
                rowId: 7,
                minShares: 100,
                recordMonth: 3,
                description: "架空",
                shortSummary: null,
                estimatedValue: 1000,
                estimateValueSource: null,
                updatedAt: 1,
              },
            ],
          ],
        ]),
        scoreInputs: new Map(),
        scores: new Map(),
        parents: new Map(),
      }
    );
    // 由来なし値は分子に入らず、算定不能 (null) になる。0 にはしない。
    expect(entries.entries.map((e) => [e.prev, e.next, e.changed])).toEqual([[1.0, null, true]]);
  });

  it("裸の company 値 (不認定文言) は利回りに入れない", () => {
    const entries = computeYieldEntries(
      [STOCK_C],
      {
        prices: new Map([[STOCK_C, { price: 1000, yutaiYield: 1.0, dataDate: "2026-09-13", fetchedAt: 1 }]]),
        benefits: new Map([
          [
            STOCK_C,
            [
              {
                rowId: 7,
                minShares: 100,
                recordMonth: 3,
                description: "カタログより選択 5,000円相当",
                shortSummary: null,
                estimatedValue: 5000,
                estimateValueSource: "company",
                updatedAt: 1,
              },
            ],
          ],
        ]),
        scoreInputs: new Map(),
        scores: new Map(),
        parents: new Map(),
      }
    );
    // choice HOLD → 算定不能 (null)。company スタンプだけでは通さない。
    expect(entries.entries.map((e) => [e.prev, e.next, e.changed])).toEqual([[1.0, null, true]]);
  });

  it("旧 source NULL 行への company 書き込み予定は post-image の出典で拾う", () => {
    const entries = computeYieldEntries(
      [STOCK_C],
      {
        prices: new Map([[STOCK_C, { price: 1000, yutaiYield: null, dataDate: "2026-09-13", fetchedAt: 1 }]]),
        benefits: new Map([
          [
            STOCK_C,
            [
              {
                rowId: 7,
                minShares: 100,
                recordMonth: 3,
                description: "架空ギフト 1,000円相当",
                shortSummary: null,
                estimatedValue: null,
                estimateValueSource: null,
                updatedAt: 1,
              },
            ],
          ],
        ]),
        scoreInputs: new Map(),
        scores: new Map(),
        parents: new Map(),
      },
      new Map([[7, { value: 1000, source: "company" }]])
    );
    expect(entries.entries.map((e) => [e.prev, e.next, e.changed])).toEqual([[null, 1.0, true]]);
  });

  it("同一文言の群に株数違いの行があれば混在 HOLD (NULL の兄弟行も数える)", () => {
    const entries = computeYieldEntries(
      [STOCK_C],
      {
        prices: new Map([[STOCK_C, { price: 1000, yutaiYield: 1.0, dataDate: "2026-09-13", fetchedAt: 1 }]]),
        benefits: new Map([
          [
            STOCK_C,
            [
              {
                rowId: 7,
                minShares: 100,
                recordMonth: 3,
                description: "架空ギフト 1,000円相当",
                shortSummary: null,
                estimatedValue: 1000,
                estimateValueSource: "company",
                updatedAt: 1,
              },
              {
                rowId: 8,
                minShares: 1000,
                recordMonth: 3,
                description: "架空ギフト 1,000円相当",
                shortSummary: null,
                estimatedValue: null,
                estimateValueSource: null,
                updatedAt: 1,
              },
            ],
          ],
        ]),
        scoreInputs: new Map(),
        scores: new Map(),
        parents: new Map(),
      }
    );
    // 株数混在 (100/1000) の同一文言は 1 つの金額を決めない。
    expect(entries.entries.map((e) => [e.prev, e.next, e.changed])).toEqual([[1.0, null, true]]);
  });
});

const scoreOf = (stockId: number) =>
  sqlite.prepare("SELECT fundamental_score, technical_score, total_score FROM otakara_stock_scores WHERE stock_id = ?").get(stockId) as {
    fundamental_score: number;
    technical_score: number;
    total_score: number;
  };

/** 実証済み REST batch の all-or-nothing を模す送信ダブル (1 送信 = 1 トランザクション)。 */
function makeAtomicSender() {
  const calls: D1BatchStatement[][] = [];
  const sender = async (statements: readonly D1BatchStatement[]): Promise<void> => {
    calls.push(statements.map((s) => ({ sql: s.sql, params: [...s.params] })));
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (const s of statements) {
        sqlite.prepare(s.sql).run(...(s.params as (null | number | string)[]));
      }
      sqlite.exec("COMMIT");
    } catch (e) {
      sqlite.exec("ROLLBACK");
      throw e;
    }
  };
  return { calls, sender };
}

describe("applyYieldRecomputeAtomically", () => {
  it("変わる行だけ yutai_yield とスコアを 1 銘柄 1 送信で書き、data_date は据え置く。再実行は 0 件", async () => {
    // 計算とガードは同一読取の snapshot から (本番の applyImportAtomically と同じ形)。
    const inputs = await fetchYieldInputs(db, [STOCK_A, STOCK_B, STOCK_C]);
    const plan = computeYieldEntries([STOCK_A, STOCK_B, STOCK_C], inputs);
    const preimages = snapshotStockPreimages(inputs, [STOCK_A, STOCK_B, STOCK_C]);
    const { calls, sender } = makeAtomicSender();
    const { updated, scoresUpdated } = await applyYieldRecomputeAtomically(sender, plan, preimages);
    expect(updated).toBe(1);
    expect(scoresUpdated).toBe(1);
    // 先頭 preflight + A の利回り・スコアの 2 文が 1 送信。B (対象外)・C (無変更) には送らない。
    expect(calls.map((c) => c.length)).toEqual([3]);
    expect(calls[0][0].sql.startsWith("-- preflight")).toBe(true);
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

    const againInputs = await fetchYieldInputs(db, [STOCK_A, STOCK_C]);
    const again = computeYieldEntries([STOCK_A, STOCK_C], againInputs);
    expect(again.entries.every((e) => !e.changed && !e.scoreChanged)).toBe(true);
    const redoSender = makeAtomicSender();
    const redo = await applyYieldRecomputeAtomically(
      redoSender.sender,
      again,
      snapshotStockPreimages(againInputs, [STOCK_A, STOCK_C])
    );
    expect(redo).toEqual({ updated: 0, scoresUpdated: 0 });
    expect(redoSender.calls).toEqual([]);
  });

  it("中断 (利回りだけ書いてスコア未書込) からの再実行で残りを回復する", async () => {
    // 旧逐次経路で残った部分状態も、同じ計画の再実行で回復することを固定する。
    sqlite
      .prepare("UPDATE otakara_stock_financials SET yutai_yield = ? WHERE stock_id = ?")
      .run((5000 / (993 * 100)) * 100, STOCK_A);
    // 利回りは新しいがスコアは旧利回りのまま = 部分状態
    const partialInputs = await fetchYieldInputs(db, [STOCK_A]);
    const partial = computeYieldEntries([STOCK_A], partialInputs);
    expect(partial.entries.map((e) => [e.changed, e.scoreChanged])).toEqual([[false, true]]);
    const { calls, sender } = makeAtomicSender();
    const healed = await applyYieldRecomputeAtomically(
      sender,
      partial,
      snapshotStockPreimages(partialInputs, [STOCK_A])
    );
    expect(healed).toEqual({ updated: 0, scoresUpdated: 1 });
    expect(calls.map((c) => c.length)).toEqual([2]);
    expect(calls[0][0].sql.startsWith("-- preflight")).toBe(true);
    const expectA = scoreStock({
      price: 993, per: 10, pbr: 1.0, dividendYield: 2.0, roe: 8.0,
      ma25: null, rsi14: null, macd: null, macdSignal: null, yutaiYield: finOf(STOCK_A).yutai_yield,
    });
    expect(scoreOf(STOCK_A)).toEqual({
      fundamental_score: expectA.fundamentalScore,
      technical_score: expectA.technicalScore,
      total_score: expectA.totalScore,
    });
    const again = await planYieldRecompute(db, [STOCK_A]);
    expect(again.entries.every((e) => !e.changed && !e.scoreChanged)).toBe(true);
  });
});
