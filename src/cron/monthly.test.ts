import { describe, expect, it } from "vitest";

import { runMonthlyRebuild } from "./monthly.js";
import * as coreSchema from "../shared/db/core-schema.js";
import * as swingSchema from "../../services/swing-trading/src/db/schema.js";
import * as otakaraSchema from "../../services/otakara-yutai/src/db/schema.js";

/**
 * L-56: 月次 rebuild は表ごとに multi-row upsert で書き戻す。
 *
 * 旧実装は 1 銘柄=2 upsert を db.batch で逐次 (1,615 銘柄で 3,230 往復・
 * 670 秒)。新実装は全行を貯めてチャンク分割の一括 upsert にする。
 *
 * このテストは stub db で insert() 呼び出し回数とチャンク上限を検証する。
 * stub に batch() が無いこと自体が、旧逐次パスを使わないことの保証になる
 * (使えば TypeError で落ちる)。
 */
describe("runMonthlyRebuild batch writes (L-56)", () => {
  const N = 40;
  const active = Array.from({ length: N }, (_, i) => ({
    id: i + 1,
    code: `${1000 + i}`,
  }));
  // scoreStock / calcYutaiYield が例外を出さない穏当な値
  const core = active.map((s) => ({
    stockId: s.id,
    price: 1000,
    per: 10,
    pbr: 1,
    dividendYield: 2,
    eps: 100,
    bps: 1000,
    roe: 8,
    roa: 4,
    marketCap: 100000,
  }));
  const swing = active.map((s) => ({
    stockId: s.id,
    sma5: 1000,
    sma25: 990,
    sma75: 980,
    rsi14: 50,
    macd: 1,
    macdSignal: 0.5,
  }));
  const benefits = active.map((s) => ({
    stockId: s.id,
    minShares: 100,
    estimatedValue: 1000,
    recordMonth: 3,
    genreId: 1,
  }));

  type Db = Parameters<typeof runMonthlyRebuild>[0];

  function makeStub() {
    const calls: { table: unknown; rowCount: number; rows: unknown[] }[] = [];
    const fakeDb = {
      update: () => ({ set: () => ({ where: async () => [] as unknown[] }) }),
      select: () => ({
        from: (t: unknown) => {
          if (t === coreSchema.stocks) return { where: async () => active };
          if (t === coreSchema.stockFinancials) return core;
          if (t === swingSchema.stockIndicators) return swing;
          // 同一テーブルに .where() 付き (利回り用) となし (月/ジャンル用) が
          // あるため、await 可能かつ .where() を持つ thenable を返す
          if (t === otakaraSchema.yutaiBenefits) {
            return {
              where: async () => benefits,
              then: (
                resolve: (v: typeof benefits) => void,
                reject?: (e: unknown) => void
              ) => Promise.resolve(benefits).then(resolve, reject),
            };
          }
          throw new Error("unexpected table in stub select");
        },
      }),
      insert: (t: unknown) => ({
        values: (rows: unknown[]) => ({
          onConflictDoUpdate: async () => {
            calls.push({ table: t, rowCount: rows.length, rows });
            return [] as unknown[];
          },
        }),
      }),
    };
    return { db: fakeDb as unknown as Db, calls };
  }

  it("全 N 銘柄をスコア化する", async () => {
    const { db } = makeStub();
    const result = await runMonthlyRebuild(db);
    expect(result.scoredStocks).toBe(N);
  });

  it("insert は ceil(N/5) + ceil(N/16) 回だけ呼ばれる", async () => {
    const { db, calls } = makeStub();
    await runMonthlyRebuild(db);
    // 40 銘柄: financials 8 回 (5×8) + scores 3 回 (16+16+8)
    expect(calls).toHaveLength(8 + 3);
    const fin = calls.filter((c) => c.table === otakaraSchema.stockFinancials);
    const scores = calls.filter((c) => c.table === otakaraSchema.stockScores);
    expect(fin).toHaveLength(8);
    expect(scores).toHaveLength(3);
    expect(fin.map((c) => c.rowCount)).toEqual([5, 5, 5, 5, 5, 5, 5, 5]);
    expect(scores.map((c) => c.rowCount)).toEqual([16, 16, 8]);
  });

  it("チャンク行数は D1 bind 上限 (100/文) を超えない", async () => {
    const { db, calls } = makeStub();
    await runMonthlyRebuild(db);
    // financials 18 列×行数 ≤ 100 → 5 行まで、scores 6 列×行数 ≤ 100 → 16 行まで
    for (const c of calls) {
      if (c.table === otakaraSchema.stockFinancials) {
        expect(c.rowCount).toBeLessThanOrEqual(5);
      } else if (c.table === otakaraSchema.stockScores) {
        expect(c.rowCount).toBeLessThanOrEqual(16);
      } else {
        throw new Error("unexpected insert target");
      }
    }
    // 合計行数が N ずつ (欠けも重複もなし)
    const finTotal = calls
      .filter((c) => c.table === otakaraSchema.stockFinancials)
      .reduce((a, c) => a + c.rowCount, 0);
    const scoreTotal = calls
      .filter((c) => c.table === otakaraSchema.stockScores)
      .reduce((a, c) => a + c.rowCount, 0);
    expect(finTotal).toBe(N);
    expect(scoreTotal).toBe(N);
  });

  it("書き戻し行の stockId に欠け・重複がない", async () => {
    const { db, calls } = makeStub();
    await runMonthlyRebuild(db);
    for (const c of calls) {
      const ids = (c.rows as { stockId: number }[]).map((r) => r.stockId);
      expect(new Set(ids).size).toBe(ids.length);
    }
    const allFinIds = calls
      .filter((c) => c.table === otakaraSchema.stockFinancials)
      .flatMap((c) => (c.rows as { stockId: number }[]).map((r) => r.stockId))
      .sort((a, b) => a - b);
    expect(allFinIds).toEqual(active.map((s) => s.id));
  });
});
