/**
 * 通常 import 実経路の原子適用 (`applyImportAtomically`) のテスト。
 * D1 には触らない。送信口だけ差し替え、束ね方と失敗時の振る舞いを固定する。
 *
 * - 同一銘柄の要約・推定値・利回り・スコアの全 UPDATE が 1 送信 (1 batch) になる。
 *   D1 REST 側の 1 リクエスト原子性 (全文ロールバック) は隔離の一時 D1 で観測済み
 *   (実証後に削除)。ここの送信ダブルは BEGIN/COMMIT でその all-or-nothing を
 *   模す — 本番コードは BEGIN/COMMIT を送らない (D1 REST が受け付けないため)。
 *   envelope の形 (`{batch:[{sql,params}]}`) 自体は
 *   `src/shared/db/d1-http-batch-sender.test.ts` で完全一致で固定する。
 * - 途中の文の失敗では銘柄内の全 preimage が残り、エラーが伝播する。
 * - 正常成功では従来の逐次適用と同一の値になる (builder≡writer を別途固定)。
 * - 混合再開 (更新なし・stale のタスク行) は純 recompute の batch で追随し、
 *   無変更の銘柄には触らない。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import type { D1BatchStatement } from "../../../../src/shared/db/d1-http-client.js";
import { scoreStock } from "../../../../src/shared/scoring.js";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import type { AtomicBatchSender } from "../../data-scripts/atomic-apply.js";
import { planAtomicBatches } from "../../data-scripts/atomic-apply.js";
import {
  applyImportAtomically,
  makeSummaryWriter,
} from "../../data-scripts/import-summary-results.js";
import {
  buildBenefitUpdateStatements,
  type PlannedUpdate,
} from "../../data-scripts/summary-import.js";
import {
  buildYieldScoreStatements,
  type RecomputeYieldsDb,
  type YieldRecomputeEntry,
} from "../../data-scripts/recompute-yields.js";

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

const STOCK_A = 101; // 要約更新あり + 利回り stale (要約・値・利回り・スコアの全 batch)
const STOCK_D = 104; // 要約更新なし + 利回り stale (純 recompute の batch。混合再開の形)
const STOCK_C = 103; // 要約更新なし + 一致 (触らない)

let sqlite: DatabaseSync;
let db: RecomputeYieldsDb;

function scoreOf(price: number, yutaiYield: number | null) {
  const s = scoreStock({
    price, per: 10, pbr: 1.0, dividendYield: 2.0, roe: 8.0,
    ma25: null, rsi14: null, macd: null, macdSignal: null, yutaiYield,
  });
  return [s.fundamentalScore, s.technicalScore, s.totalScore] as const;
}

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  applyD1Migrations(sqlite);
  const insStock = sqlite.prepare(
    "INSERT INTO core_stocks (id, code, name, market, is_active, is_yutai, instrument_type) VALUES (?, ?, ?, 'テスト市場', 1, 1, 'equity')"
  );
  for (const [id, code] of [[STOCK_A, "9101"], [STOCK_C, "9103"], [STOCK_D, "9104"]] as const) {
    insStock.run(id, code, `テスト${code}`);
  }
  sqlite.prepare("INSERT INTO yutai_genres (id, name, slug, description) VALUES (1, 'その他', 'other', '')").run();
  const insBenefit = sqlite.prepare(
    "INSERT INTO yutai_benefits (id, stock_id, genre_id, description, short_summary, min_shares, record_month, estimated_value, estimate_value_source, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 1, 1)"
  );
  insBenefit.run(1001, STOCK_A, "架空ギフト 5,000円相当", "旧要約A", 100, 3, 1000, null);
  insBenefit.run(1003, STOCK_C, "架空ギフト 1,000円相当", "要約C", 100, 3, 1000, "company");
  insBenefit.run(1004, STOCK_D, "架空ギフト 1,000円相当", "要約D", 100, 3, 1000, "company");
  const insFin = sqlite.prepare(
    "INSERT INTO otakara_stock_financials (stock_id, price, per, pbr, dividend_yield, roe, yutai_yield, data_date) VALUES (?, ?, ?, ?, ?, ?, ?, '2026-09-13')"
  );
  insFin.run(STOCK_A, 993, 10, 1.0, 2.0, 8.0, 1.0070493454179255);
  insFin.run(STOCK_C, 1000, 10, 1.0, 2.0, 8.0, 1.0);
  insFin.run(STOCK_D, 1000, 10, 1.0, 2.0, 8.0, 0.5);
  const insScore = sqlite.prepare(
    "INSERT INTO otakara_stock_scores (stock_id, fundamental_score, technical_score, total_score) VALUES (?, ?, ?, ?)"
  );
  insScore.run(STOCK_A, ...scoreOf(993, 1.0070493454179255));
  insScore.run(STOCK_C, ...scoreOf(1000, 1.0));
  insScore.run(STOCK_D, ...scoreOf(1000, 0.5));
  db = makeProxyDb(sqlite) as unknown as RecomputeYieldsDb;
});

afterEach(() => {
  sqlite.close();
});

/**
 * 実証済み REST batch の all-or-nothing を模す送信ダブル。
 * 1 送信 = 1 トランザクション。途中の文で落ちたら全 preimage が残る。
 */
function makeAtomicSender() {
  const calls: D1BatchStatement[][] = [];
  const sender: AtomicBatchSender = async (statements) => {
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

const UPDATE_A: PlannedUpdate = {
  taskId: "0123456789abcdef",
  ids: [1001],
  shortSummary: "新要約A",
  estimatedValue: 5000,
  estimateValueSource: "company",
};

const benefitOf = (id: number) =>
  sqlite
    .prepare(
      "SELECT short_summary, estimated_value, estimate_value_source, updated_at FROM yutai_benefits WHERE id = ?"
    )
    .get(id) as {
    short_summary: string;
    estimated_value: number | null;
    estimate_value_source: string | null;
    updated_at: number;
  };

const finOf = (stockId: number) =>
  sqlite
    .prepare("SELECT yutai_yield, data_date FROM otakara_stock_financials WHERE stock_id = ?")
    .get(stockId) as { yutai_yield: number | null; data_date: string };

const scoreOfRow = (stockId: number) =>
  sqlite
    .prepare(
      "SELECT fundamental_score, technical_score, total_score FROM otakara_stock_scores WHERE stock_id = ?"
    )
    .get(stockId) as { fundamental_score: number; technical_score: number; total_score: number };

describe("applyImportAtomically", () => {
  it("同一銘柄の全 UPDATE が 1 送信になり、混合再開の stale 行も純 recompute で追随する", async () => {
    const { calls, sender } = makeAtomicSender();
    const res = await applyImportAtomically(db, sender, {
      targetIds: [1001, 1003, 1004],
      updates: [UPDATE_A],
    });
    expect(res.groups).toBe(1);
    expect(res.rows).toBe(1);

    // A: 要約・値・利回り・スコアの 3 文を 1 送信。D: 利回り・スコアの 2 文を 1 送信。
    // C (無変更) には送信しない。
    expect(calls.map((c) => c.length)).toEqual([3, 2]);
    const [aBatch, dBatch] = calls;
    expect(aBatch[0].sql).toContain("UPDATE yutai_benefits");
    expect(aBatch[0].params).toEqual(["新要約A", 5000, "company", 1001]);
    expect(aBatch[1].sql).toContain("UPDATE otakara_stock_financials");
    expect(aBatch[1].params).toEqual([(5000 / (993 * 100)) * 100, STOCK_A]);
    expect(aBatch[2].sql).toContain("UPDATE otakara_stock_scores");
    expect(aBatch[2].params.slice(3)).toEqual([STOCK_A]);
    expect(dBatch[0].sql).toContain("UPDATE otakara_stock_financials");
    expect(dBatch[0].params).toEqual([1.0, STOCK_D]);
    expect(dBatch[1].sql).toContain("UPDATE otakara_stock_scores");

    // 適用結果: 利回りは書き込み予定値込みで正しく、data_date は月次のまま。
    expect(benefitOf(1001)).toMatchObject({
      short_summary: "新要約A",
      estimated_value: 5000,
      estimate_value_source: "company",
    });
    expect(benefitOf(1001).updated_at).toBeGreaterThan(1);
    expect(finOf(STOCK_A).yutai_yield).toBeCloseTo(5.0352467, 6);
    expect(finOf(STOCK_A).data_date).toBe("2026-09-13");
    expect(finOf(STOCK_D).yutai_yield).toBe(1.0);
    expect(scoreOfRow(STOCK_A)).toEqual({
      fundamental_score: scoreOf(993, finOf(STOCK_A).yutai_yield)[0],
      technical_score: scoreOf(993, finOf(STOCK_A).yutai_yield)[1],
      total_score: scoreOf(993, finOf(STOCK_A).yutai_yield)[2],
    });
    // C は無変更。
    expect(benefitOf(1003).updated_at).toBe(1);
    expect(finOf(STOCK_C).yutai_yield).toBe(1.0);
  });

  it("途中の文の失敗では銘柄内の全 preimage が残り、エラーが伝播する", async () => {
    sqlite.exec(
      "CREATE TRIGGER fail_mid BEFORE UPDATE ON otakara_stock_scores BEGIN SELECT RAISE(ABORT, 'injected-mid-batch-failure'); END"
    );
    const { calls, sender } = makeAtomicSender();
    await expect(
      applyImportAtomically(db, sender, { targetIds: [1001], updates: [UPDATE_A] })
    ).rejects.toThrow(/injected-mid-batch-failure/);
    // 3 文は 1 送信で出ており、失敗で全 preimage が残る (要約だけ書かれない)。
    expect(calls.map((c) => c.length)).toEqual([3]);
    expect(benefitOf(1001)).toEqual({
      short_summary: "旧要約A",
      estimated_value: 1000,
      estimate_value_source: null,
      updated_at: 1,
    });
    expect(finOf(STOCK_A).yutai_yield).toBe(1.0070493454179255);
  });

  it("再実行は冪等 (値は不変。要約の再適用だけ再送される)", async () => {
    const first = makeAtomicSender();
    await applyImportAtomically(db, first.sender, { targetIds: [1001, 1004], updates: [UPDATE_A] });
    expect(first.calls.map((c) => c.length)).toEqual([3, 2]);

    const second = makeAtomicSender();
    await applyImportAtomically(db, second.sender, { targetIds: [1001, 1004], updates: [UPDATE_A] });
    // A は要約の再適用のみ (利回り・スコアは無変更で文なし)。D は送信なし。
    expect(second.calls.map((c) => c.length)).toEqual([1]);
    expect(second.calls[0][0].sql).toContain("UPDATE yutai_benefits");
    expect(benefitOf(1001)).toMatchObject({ short_summary: "新要約A", estimated_value: 5000 });
    expect(finOf(STOCK_A).yutai_yield).toBeCloseTo(5.0352467, 6);
    expect(finOf(STOCK_D).yutai_yield).toBe(1.0);
  });

  it("対象が空なら送らない", async () => {
    const { calls, sender } = makeAtomicSender();
    const res = await applyImportAtomically(db, sender, { targetIds: [], updates: [] });
    expect(res).toMatchObject({ groups: 0, rows: 0 });
    expect(calls).toEqual([]);
  });
});

describe("planAtomicBatches", () => {
  it("銘柄を引けない優待行があれば書く前に投げる (黙って落とさない)", () => {
    expect(() =>
      planAtomicBatches({
        updates: [UPDATE_A],
        yieldPlan: { entries: [], skippedNoRow: [], skippedNoScore: [] },
        stockOfBenefit: () => undefined,
      })
    ).toThrow(/銘柄が今の D1 から引けません/);
  });
});

describe("buildBenefitUpdateStatements / buildYieldScoreStatements", () => {
  it("builder は逐次 writer と同一の列・値を書く", async () => {
    const vals = { shortSummary: "新要約A", estimatedValue: 5000, estimateValueSource: "company" as const };
    for (const s of buildBenefitUpdateStatements([1001], vals)) {
      sqlite.prepare(s.sql).run(...(s.params as (null | number | string)[]));
    }
    await makeSummaryWriter(db).update([1003], vals);
    const { updated_at: _a, ...a } = benefitOf(1001);
    const { updated_at: _c, ...c } = benefitOf(1003);
    expect(a).toEqual(c);
    expect(_a).toBeGreaterThan(1);
    expect(_c).toBeGreaterThan(1);
  });

  it("利回り・スコアの builder は変わる列だけ持ち、値をそのまま束縛する", () => {
    const entry: YieldRecomputeEntry = {
      stockId: STOCK_A,
      prev: 1.0,
      next: 1.5,
      changed: true,
      scorePrev: { fundamentalScore: 1, technicalScore: 2, totalScore: 3 },
      scoreNext: { fundamentalScore: 4, technicalScore: 5, totalScore: 6 },
      scoreChanged: true,
    };
    expect(buildYieldScoreStatements(entry)).toEqual([
      {
        sql: "UPDATE otakara_stock_financials SET yutai_yield = ?, fetched_at = (unixepoch()) WHERE stock_id = ?",
        params: [1.5, STOCK_A],
      },
      {
        sql: "UPDATE otakara_stock_scores SET fundamental_score = ?, technical_score = ?, total_score = ? WHERE stock_id = ?",
        params: [4, 5, 6, STOCK_A],
      },
    ]);
    expect(buildYieldScoreStatements({ ...entry, changed: false, scoreChanged: false })).toEqual([]);
    expect(buildBenefitUpdateStatements([], { shortSummary: "x", estimatedValue: null, estimateValueSource: null })).toEqual([]);
  });
});
