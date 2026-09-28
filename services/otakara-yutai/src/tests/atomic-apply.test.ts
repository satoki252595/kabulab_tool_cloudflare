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
 * - 非空 batch の先頭に必ず preflight 文が付く。full preimage の不一致
 *   (値・要約・掲載文の書き換え、行の追加・削除、利回り・日付・株価・
 *   スコア計算の実入力 8 列の書き換え、スコアの書き換え、財務・スコア行の
 *   削除/出現) は SQL エラーで batch 全体が落ち、書きかけを残さない
 *   (ドリフト行の除外はしない)。
 * - 検証時の対象タプルと適用時の再読が 1 行でも違えば、batch を作らず
 *   送らず全体 STOP する (再読の採用で旧 plan の上書きを許さない)。
 *   銘柄コードの対応も検証時の task 側と要求する。
 * - ABC 形式の統合更新 (null 化 + 要約更新) も同一 planner + ガードで扱う。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import type { D1BatchStatement } from "../../../../src/shared/db/d1-http-client.js";
import { scoreStock } from "../../../../src/shared/scoring.js";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import type {
  AtomicBatchSender,
  VerifiedBenefitTuple,
} from "../../data-scripts/atomic-apply.js";
import {
  applyAtomicBatches,
  planAtomicBatches,
  snapshotStockPreimages,
} from "../../data-scripts/atomic-apply.js";
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
  computeYieldEntries,
  fetchYieldInputs,
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
const STOCK_N = 105; // 財務・スコア行が無い (行の不在が preimage)

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
  for (const [id, code] of [[STOCK_A, "9101"], [STOCK_C, "9103"], [STOCK_D, "9104"], [STOCK_N, "9105"]] as const) {
    insStock.run(id, code, `テスト${code}`);
  }
  sqlite.prepare("INSERT INTO yutai_genres (id, name, slug, description) VALUES (1, 'その他', 'other', '')").run();
  const insBenefit = sqlite.prepare(
    "INSERT INTO yutai_benefits (id, stock_id, genre_id, description, short_summary, min_shares, record_month, estimated_value, estimate_value_source, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 1, 1)"
  );
  insBenefit.run(1001, STOCK_A, "架空ギフト 5,000円相当", "旧要約A", 100, 3, 1000, null);
  insBenefit.run(1003, STOCK_C, "架空ギフト 1,000円相当", "要約C", 100, 3, 1000, "company");
  insBenefit.run(1004, STOCK_D, "架空ギフト 1,000円相当", "要約D", 100, 3, 1000, "company");
  insBenefit.run(1005, STOCK_N, "架空ギフト 2,000円相当", "旧要約N", 100, 3, 2000, "company");
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

const UPDATE_N: PlannedUpdate = {
  taskId: "fedcba9876543210",
  ids: [1005],
  shortSummary: "新要約N",
  estimatedValue: 2000,
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

/** 検証時の読み (`loadBenefitRows` 相当) から対象タプルを切る。 */
function readVerified(ids: number[]): Map<number, VerifiedBenefitTuple> {
  const out = new Map<number, VerifiedBenefitTuple>();
  const stmt = sqlite.prepare(
    "SELECT b.id AS id, b.stock_id AS stock_id, s.code AS code, b.min_shares AS min_shares, b.record_month AS record_month, b.description AS description, b.short_summary AS short_summary, b.estimated_value AS estimated_value, b.estimate_value_source AS estimate_value_source, b.updated_at AS updated_at FROM yutai_benefits b INNER JOIN core_stocks s ON s.id = b.stock_id WHERE b.id = ?"
  );
  for (const id of ids) {
    const r = stmt.get(id) as
      | {
          id: number;
          stock_id: number;
          code: string;
          min_shares: number;
          record_month: number;
          description: string;
          short_summary: string | null;
          estimated_value: number | null;
          estimate_value_source: string | null;
          updated_at: number;
        }
      | undefined;
    if (!r) throw new Error(`fixture に優待行 ${id} がありません`);
    out.set(id, {
      id: r.id,
      stockId: r.stock_id,
      stockCode: r.code,
      minShares: r.min_shares,
      recordMonth: r.record_month,
      description: r.description,
      shortSummary: r.short_summary,
      estimatedValue: r.estimated_value,
      estimateValueSource: r.estimate_value_source,
      updatedAt: r.updated_at,
    });
  }
  return out;
}

describe("applyImportAtomically", () => {
  it("同一銘柄の全 UPDATE が 1 送信になり、混合再開の stale 行も純 recompute で追随する", async () => {
    const { calls, sender } = makeAtomicSender();
    const res = await applyImportAtomically(db, sender, {
      targetIds: [1001, 1003, 1004],
      updates: [UPDATE_A],
      verifiedBenefits: readVerified([1001, 1003, 1004]),
    });
    expect(res.groups).toBe(1);
    expect(res.rows).toBe(1);

    // A: preflight + 要約・値・利回り・スコアの 3 文を 1 送信。
    // D: preflight + 利回り・スコアの 2 文を 1 送信。C (無変更) には送信しない。
    expect(calls.map((c) => c.length)).toEqual([4, 3]);
    const [aBatch, dBatch] = calls;
    expect(aBatch[0].sql.startsWith("-- preflight")).toBe(true);
    expect(aBatch[1].sql).toContain("UPDATE yutai_benefits");
    expect(aBatch[1].params).toEqual(["新要約A", 5000, "company", 1001]);
    expect(aBatch[2].sql).toContain("UPDATE otakara_stock_financials");
    expect(aBatch[2].params).toEqual([(5000 / (993 * 100)) * 100, STOCK_A]);
    expect(aBatch[3].sql).toContain("UPDATE otakara_stock_scores");
    expect(aBatch[3].params.slice(3)).toEqual([STOCK_A]);
    expect(dBatch[0].sql.startsWith("-- preflight")).toBe(true);
    expect(dBatch[1].sql).toContain("UPDATE otakara_stock_financials");
    expect(dBatch[1].params).toEqual([1.0, STOCK_D]);
    expect(dBatch[2].sql).toContain("UPDATE otakara_stock_scores");

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
      applyImportAtomically(db, sender, {
        targetIds: [1001],
        updates: [UPDATE_A],
        verifiedBenefits: readVerified([1001]),
      })
    ).rejects.toThrow(/injected-mid-batch-failure/);
    // 4 文は 1 送信で出ており、失敗で全 preimage が残る (要約だけ書かれない)。
    expect(calls.map((c) => c.length)).toEqual([4]);
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
    await applyImportAtomically(db, first.sender, {
      targetIds: [1001, 1004],
      updates: [UPDATE_A],
      verifiedBenefits: readVerified([1001, 1004]),
    });
    expect(first.calls.map((c) => c.length)).toEqual([4, 3]);

    const second = makeAtomicSender();
    // 再実行は検証からやり直す (検証時タプルも取り直す)。
    await applyImportAtomically(db, second.sender, {
      targetIds: [1001, 1004],
      updates: [UPDATE_A],
      verifiedBenefits: readVerified([1001, 1004]),
    });
    // A は preflight + 要約の再適用のみ (利回り・スコアは無変更で文なし)。D は送信なし。
    expect(second.calls.map((c) => c.length)).toEqual([2]);
    expect(second.calls[0][0].sql.startsWith("-- preflight")).toBe(true);
    expect(second.calls[0][1].sql).toContain("UPDATE yutai_benefits");
    expect(benefitOf(1001)).toMatchObject({ short_summary: "新要約A", estimated_value: 5000 });
    expect(finOf(STOCK_A).yutai_yield).toBeCloseTo(5.0352467, 6);
    expect(finOf(STOCK_D).yutai_yield).toBe(1.0);
  });

  it("対象が空なら送らない", async () => {
    const { calls, sender } = makeAtomicSender();
    const res = await applyImportAtomically(db, sender, {
      targetIds: [],
      updates: [],
      verifiedBenefits: new Map(),
    });
    expect(res).toMatchObject({ groups: 0, rows: 0 });
    expect(calls).toEqual([]);
  });
});

describe("検証時タプルの持ち越し (検証→再読の改変は送らず STOP)", () => {
  const verifyMutations: [string, RegExp, () => void][] = [
    [
      "掲載文の書き換え",
      /優待行 1001 \(9101\) が検証後に変わりました \[description\] \(適用せず STOP\)/,
      () => sqlite.prepare("UPDATE yutai_benefits SET description = '架空書換' WHERE id = 1001").run(),
    ],
    [
      "要約の書き換え",
      /優待行 1001 \(9101\) が検証後に変わりました \[shortSummary\] \(適用せず STOP\)/,
      () => sqlite.prepare("UPDATE yutai_benefits SET short_summary = '別要約' WHERE id = 1001").run(),
    ],
    [
      "推定値と出典の書き換え",
      /優待行 1001 \(9101\) が検証後に変わりました \[estimatedValue, estimateValueSource\] \(適用せず STOP\)/,
      () =>
        sqlite
          .prepare("UPDATE yutai_benefits SET estimated_value = 9999, estimate_value_source = 'x' WHERE id = 1001")
          .run(),
    ],
    [
      "対象行の削除",
      /優待行 1001 \(9101\) が検証時から消えました \(適用せず STOP\)/,
      () => sqlite.prepare("DELETE FROM yutai_benefits WHERE id = 1001").run(),
    ],
    [
      "対象行の銘柄付け替え",
      /優待行 1001 \(9101\) が検証後に変わりました \[stockId\] \(適用せず STOP\)/,
      () => sqlite.prepare("UPDATE yutai_benefits SET stock_id = 104 WHERE id = 1001").run(),
    ],
  ];

  it.each(verifyMutations)("%sは batch を 1 送信もせず全体 STOP し、同銘柄の preimage は不変", async (_name, message, mutate) => {
    const verified = readVerified([1001]);
    mutate();
    const { calls, sender } = makeAtomicSender();
    await expect(
      applyImportAtomically(db, sender, {
        targetIds: [1001],
        updates: [UPDATE_A],
        verifiedBenefits: verified,
      })
    ).rejects.toThrow(message);
    expect(calls).toEqual([]);
    // 同銘柄の利回り・スコアも preimage のまま (計算も送らない)。
    expect(finOf(STOCK_A).yutai_yield).toBe(1.0070493454179255);
  });

  it("検証時タプルが対象を覆わない呼び出しは契約違反で投げる", async () => {
    const { calls, sender } = makeAtomicSender();
    await expect(
      applyImportAtomically(db, sender, {
        targetIds: [1001],
        updates: [UPDATE_A],
        verifiedBenefits: new Map(),
      })
    ).rejects.toThrow(/優待行 1001 の検証時タプルがありません/);
    expect(calls).toEqual([]);
  });

  it("銘柄コードの対応が検証時と違えば止める (元 task code の一致要求)", async () => {
    const verified = readVerified([1001]);
    // 行の stock_id は同じだが core 側のコードが振り直された形を模す。
    sqlite.prepare("UPDATE core_stocks SET code = '9999' WHERE id = 101").run();
    const { calls, sender } = makeAtomicSender();
    await expect(
      applyImportAtomically(db, sender, {
        targetIds: [1001],
        updates: [UPDATE_A],
        verifiedBenefits: verified,
      })
    ).rejects.toThrow(/優待行 1001 の銘柄が検証時 9101 から 9999 に変わりました \(適用せず STOP\)/);
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
        preimages: new Map(),
      })
    ).toThrow(/銘柄が今の D1 から引けません/);
    expect(() =>
      planAtomicBatches({
        updates: [UPDATE_A],
        yieldPlan: { entries: [], skippedNoRow: [], skippedNoScore: [] },
        stockOfBenefit: () => STOCK_A,
        preimages: new Map(),
      })
    ).toThrow(/preimage がありません/);
  });
});

describe("preflight ガード", () => {
  /** 計算とガードは同一読取から (本番の applyImportAtomically と同じ形)。 */
  async function planA() {
    const inputs = await fetchYieldInputs(db, [STOCK_A]);
    const overlay = new Map<number, number | null>([[1001, 5000]]);
    return {
      yieldPlan: computeYieldEntries([STOCK_A], inputs, overlay),
      preimages: snapshotStockPreimages(inputs, [STOCK_A]),
    };
  }

  const stockOfA = (id: number) => (id === 1001 ? STOCK_A : undefined);

  it("一致すれば全更新が通る", async () => {
    const { yieldPlan, preimages } = await planA();
    const batches = planAtomicBatches({
      updates: [UPDATE_A],
      yieldPlan,
      stockOfBenefit: stockOfA,
      preimages,
    });
    expect(batches).toHaveLength(1);
    expect(batches[0].statements).toHaveLength(4); // preflight + 要約・利回り・スコア
    const { sender } = makeAtomicSender();
    await applyAtomicBatches(sender, batches);
    expect(benefitOf(1001)).toMatchObject({ short_summary: "新要約A", estimated_value: 5000 });
    expect(finOf(STOCK_A).yutai_yield).toBeCloseTo(5.0352467, 6);
  });

  const drifts: [string, () => void][] = [
    ["推定値の書き換え", () => sqlite.prepare("UPDATE yutai_benefits SET estimated_value = 9999 WHERE id = 1001").run()],
    ["要約の書き換え", () => sqlite.prepare("UPDATE yutai_benefits SET short_summary = '別要約' WHERE id = 1001").run()],
    ["掲載文の書き換え", () => sqlite.prepare("UPDATE yutai_benefits SET description = '架空書換' WHERE id = 1001").run()],
    ["株数条件の書き換え", () => sqlite.prepare("UPDATE yutai_benefits SET min_shares = 200 WHERE id = 1001").run()],
    ["権利月の書き換え", () => sqlite.prepare("UPDATE yutai_benefits SET record_month = 9 WHERE id = 1001").run()],
    ["出典の書き換え", () => sqlite.prepare("UPDATE yutai_benefits SET estimate_value_source = 'company' WHERE id = 1001").run()],
    ["更新時刻の書き換え", () => sqlite.prepare("UPDATE yutai_benefits SET updated_at = 2 WHERE id = 1001").run()],
    ["優待行の追加", () => sqlite.prepare("INSERT INTO yutai_benefits (stock_id, genre_id, description, min_shares, record_month) VALUES (101, 1, '架空追加', 100, 3)").run()],
    ["優待行の削除", () => sqlite.prepare("DELETE FROM yutai_benefits WHERE id = 1001").run()],
    ["利回りの書き換え", () => sqlite.prepare("UPDATE otakara_stock_financials SET yutai_yield = 9.9 WHERE stock_id = 101").run()],
    ["data_date の差し替え", () => sqlite.prepare("UPDATE otakara_stock_financials SET data_date = '2026-09-14' WHERE stock_id = 101").run()],
    ["株価の書き換え", () => sqlite.prepare("UPDATE otakara_stock_financials SET price = 1 WHERE stock_id = 101").run()],
    ["per の書き換え", () => sqlite.prepare("UPDATE otakara_stock_financials SET per = 11 WHERE stock_id = 101").run()],
    ["pbr の書き換え", () => sqlite.prepare("UPDATE otakara_stock_financials SET pbr = 2.0 WHERE stock_id = 101").run()],
    ["配当利回りの書き換え", () => sqlite.prepare("UPDATE otakara_stock_financials SET dividend_yield = 3.0 WHERE stock_id = 101").run()],
    ["roe の書き換え", () => sqlite.prepare("UPDATE otakara_stock_financials SET roe = 9.0 WHERE stock_id = 101").run()],
    ["ma25 の出現 (NULL→値)", () => sqlite.prepare("UPDATE otakara_stock_financials SET ma_25 = 100 WHERE stock_id = 101").run()],
    ["rsi14 の出現 (NULL→値)", () => sqlite.prepare("UPDATE otakara_stock_financials SET rsi_14 = 50 WHERE stock_id = 101").run()],
    ["macd の出現 (NULL→値)", () => sqlite.prepare("UPDATE otakara_stock_financials SET macd = 1 WHERE stock_id = 101").run()],
    ["macd_signal の出現 (NULL→値)", () => sqlite.prepare("UPDATE otakara_stock_financials SET macd_signal = 2 WHERE stock_id = 101").run()],
    ["per の消失 (値→NULL)", () => sqlite.prepare("UPDATE otakara_stock_financials SET per = NULL WHERE stock_id = 101").run()],
    ["スコアの書き換え", () => sqlite.prepare("UPDATE otakara_stock_scores SET total_score = 0 WHERE stock_id = 101").run()],
    ["財務行の削除", () => sqlite.prepare("DELETE FROM otakara_stock_financials WHERE stock_id = 101").run()],
    ["スコア行の削除", () => sqlite.prepare("DELETE FROM otakara_stock_scores WHERE stock_id = 101").run()],
  ];

  it.each(drifts)("preimage の不一致 (%s) は batch 全体を落とし、書きかけを残さない", async (_name, mutate) => {
    const { yieldPlan, preimages } = await planA();
    const batches = planAtomicBatches({
      updates: [UPDATE_A],
      yieldPlan,
      stockOfBenefit: stockOfA,
      preimages,
    });
    mutate();
    const stateOf = () => ({
      benefit:
        (sqlite
          .prepare("SELECT short_summary, estimated_value, estimate_value_source, updated_at FROM yutai_benefits WHERE id = ?")
          .get(1001) as unknown) ?? null,
      fin:
        (sqlite
          .prepare("SELECT yutai_yield, data_date FROM otakara_stock_financials WHERE stock_id = ?")
          .get(101) as unknown) ?? null,
      score:
        (sqlite
          .prepare("SELECT fundamental_score, technical_score, total_score FROM otakara_stock_scores WHERE stock_id = ?")
          .get(101) as unknown) ?? null,
      count: (sqlite.prepare("SELECT count(*) AS n FROM yutai_benefits WHERE stock_id = 101").get() as { n: number }).n,
    });
    const before = stateOf();
    const { sender } = makeAtomicSender();
    await expect(applyAtomicBatches(sender, batches)).rejects.toThrow();
    // batch の書き込みは 1 文も残らない (drift 自体は batch 外のため残る)。
    expect(stateOf()).toEqual(before);
    expect(before).not.toMatchObject({ benefit: { short_summary: "新要約A" } });
  });

  it("財務・スコア行が無い銘柄は行の不在を preimage にする", async () => {
    const inputs = await fetchYieldInputs(db, [STOCK_N]);
    const yieldPlan = computeYieldEntries([STOCK_N], inputs, new Map([[1005, 2000]]));
    expect(yieldPlan.entries).toEqual([]);
    expect(yieldPlan.skippedNoRow).toEqual([STOCK_N]);
    const preimages = snapshotStockPreimages(inputs, [STOCK_N]);
    expect(preimages.get(STOCK_N)).toMatchObject({ financial: null, scores: null });
    const batches = planAtomicBatches({
      updates: [UPDATE_N],
      yieldPlan,
      stockOfBenefit: (id) => (id === 1005 ? STOCK_N : undefined),
      preimages,
    });
    expect(batches[0].statements).toHaveLength(2); // preflight + 要約
    const { sender } = makeAtomicSender();
    await applyAtomicBatches(sender, batches);
    expect(benefitOf(1005)).toMatchObject({ short_summary: "新要約N" });
  });

  it.each([
    ["財務行", "INSERT INTO otakara_stock_financials (stock_id, price, yutai_yield, data_date) VALUES (105, 1000, 1.0, '2026-09-13')"],
    ["スコア行", "INSERT INTO otakara_stock_scores (stock_id, fundamental_score, technical_score, total_score) VALUES (105, 50, 50, 50)"],
  ])("行の不在 preimage に対する%sの出現は drift として落とす", async (_name, insert) => {
    const inputs = await fetchYieldInputs(db, [STOCK_N]);
    const yieldPlan = computeYieldEntries([STOCK_N], inputs, new Map([[1005, 2000]]));
    const preimages = snapshotStockPreimages(inputs, [STOCK_N]);
    const batches = planAtomicBatches({
      updates: [UPDATE_N],
      yieldPlan,
      stockOfBenefit: (id) => (id === 1005 ? STOCK_N : undefined),
      preimages,
    });
    sqlite.prepare(insert).run();
    const { sender } = makeAtomicSender();
    await expect(applyAtomicBatches(sender, batches)).rejects.toThrow();
    expect(benefitOf(1005)).toMatchObject({ short_summary: "旧要約N" });
  });

  it("ABC 形式の統合更新 (null 化 + 要約更新) も同一 planner + ガードで扱える", async () => {
    // A-null 相当: 値と出典を null にする更新 (要約は据え置き)。
    const nullUpdate: PlannedUpdate = {
      taskId: "aaaaaaaaaaaaaaaa",
      ids: [1001],
      shortSummary: "旧要約A",
      estimatedValue: null,
      estimateValueSource: null,
    };
    const inputs = await fetchYieldInputs(db, [STOCK_A]);
    const yieldPlan = computeYieldEntries([STOCK_A], inputs, new Map([[1001, null]]));
    expect(yieldPlan.entries.map((e) => [e.prev, e.next, e.changed])).toEqual([
      [1.0070493454179255, null, true],
    ]);
    const preimages = snapshotStockPreimages(inputs, [STOCK_A]);
    const batches = planAtomicBatches({
      updates: [nullUpdate],
      yieldPlan,
      stockOfBenefit: stockOfA,
      preimages,
    });
    expect(batches[0].statements).toHaveLength(4);
    const { sender } = makeAtomicSender();
    await applyAtomicBatches(sender, batches);
    expect(benefitOf(1001)).toMatchObject({
      short_summary: "旧要約A",
      estimated_value: null,
      estimate_value_source: null,
    });
    expect(finOf(STOCK_A).yutai_yield).toBeNull();
    // 同一 batch の再送は preflight が落とす (再実行は再計画が正)。
    const { sender: sender2 } = makeAtomicSender();
    await expect(applyAtomicBatches(sender2, batches)).rejects.toThrow();
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

describe("applyAtomicBatches の StockBatch.key (再開キーの取り違え防止)", () => {
  it("重複・付け忘れは送らず投げ、同一銘柄の別種別キーは通る", async () => {
    const sent: D1BatchStatement[][] = [];
    const sender: AtomicBatchSender = async (statements) => {
      sent.push([...statements]);
    };
    const one = (key?: string) => ({
      stockId: 291,
      statements: [{ sql: "SELECT 1", params: [] }],
      ...(key === undefined ? {} : { key }),
    });
    // 市場36復元で実検出: 銘柄 ID だけを完了キーにすると同一銘柄の
    // 別種別 batch (例: annual:291) が落ちる。重複送信は 0 で修正済み。
    await expect(applyAtomicBatches(sender, [one("annual:291"), one("annual:291")])).rejects.toThrow("重複");
    expect(sent).toEqual([]);
    await expect(applyAtomicBatches(sender, [one("atr:291"), one()])).rejects.toThrow("付け忘れ");
    expect(sent).toEqual([]);
    await applyAtomicBatches(sender, [one("atr:291"), one("annual:291")]);
    expect(sent).toHaveLength(2);
    // キーなし (従来呼び出し) はそのまま通る
    await applyAtomicBatches(sender, [one(), one()]);
    expect(sent).toHaveLength(4);
  });
});
