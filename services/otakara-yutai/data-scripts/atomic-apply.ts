/**
 * 要約取込の原子適用: 同一銘柄の要約・推定値・利回り・スコアの全 UPDATE を
 * D1 REST `{batch}` 1 リクエストに束ねる (銘柄単位の原子単位)。
 *
 * 背景: 従来の `--apply` は要約書き込み→利回り再計算→スコア更新を逐次リクエストで
 * 送っていたため、途中で中断すると銘柄内に部分状態が残った (再実行の冪等で回復は
 * するが、通常呼び出し自体が原子ではなかった)。sqlite-proxy は `db.batch()` 非対応
 * のため、D1 REST の `{batch}` envelope を直接送る (`createD1HttpBatchSender`)。
 * BEGIN/COMMIT は送らない (D1 REST が受け付けないため)。
 *
 * 原子性の単位は銘柄: 1 銘柄の全 UPDATE が 1 リクエスト。銘柄間の失敗は止めて
 * 同引数の再実行で回復する (適用済み銘柄は無変更・冪等)。
 */
import type { D1BatchStatement } from "../../../src/shared/db/d1-http-client.js";
import { buildBenefitUpdateStatements, type PlannedUpdate } from "./summary-import.js";
import { buildYieldScoreStatements, type YieldRecomputePlan } from "./recompute-yields.js";

/** batch 1 件分の送信口。本番は `createD1HttpBatchSender()`、テストでは差し替える。 */
export type AtomicBatchSender = (
  statements: readonly D1BatchStatement[]
) => Promise<void>;

/** 1 銘柄分の batch (1 リクエストで送る文の束)。 */
export type StockBatch = {
  stockId: number;
  statements: D1BatchStatement[];
};

/**
 * 銘柄単位の batch 計画 (副作用なし・決定的な順序)。
 * 要約の文を先に、利回り・スコアの文を後に並べる (従来の逐次順序と同じ)。
 * `stockOfBenefit` で解決できない優待行があれば書く前に throw する
 * (黙って落とさない。並行する再取得で ID が振り直された疑い)。
 * 文が 0 件の銘柄は含めない (再実行で 0 件・冪等)。
 */
export function planAtomicBatches(input: {
  updates: readonly PlannedUpdate[];
  yieldPlan: YieldRecomputePlan;
  stockOfBenefit: (benefitId: number) => number | undefined;
}): StockBatch[] {
  const benefitByStock = new Map<number, D1BatchStatement[]>();
  for (const u of input.updates) {
    const idsByStock = new Map<number, number[]>();
    for (const id of u.ids) {
      const stockId = input.stockOfBenefit(id);
      if (stockId === undefined) {
        throw new Error(
          `優待行 ${id} の銘柄が今の D1 から引けません (taskId=${u.taskId}。再取得と並行した疑い)`
        );
      }
      const list = idsByStock.get(stockId);
      if (list) list.push(id);
      else idsByStock.set(stockId, [id]);
    }
    for (const [stockId, ids] of [...idsByStock].sort((a, b) => a[0] - b[0])) {
      const list = benefitByStock.get(stockId);
      const stmts = buildBenefitUpdateStatements(ids, u);
      if (list) list.push(...stmts);
      else benefitByStock.set(stockId, stmts);
    }
  }
  const yieldByStock = new Map<number, D1BatchStatement[]>();
  for (const e of input.yieldPlan.entries) {
    const stmts = buildYieldScoreStatements(e);
    if (stmts.length > 0) yieldByStock.set(e.stockId, stmts);
  }
  const stockIds = new Set([...benefitByStock.keys(), ...yieldByStock.keys()]);
  return [...stockIds]
    .sort((a, b) => a - b)
    .map((stockId) => ({
      stockId,
      statements: [...(benefitByStock.get(stockId) ?? []), ...(yieldByStock.get(stockId) ?? [])],
    }))
    .filter((b) => b.statements.length > 0);
}

/**
 * 銘柄単位の batch を 1 銘柄 1 リクエストで送る。失敗時は throw をそのまま返し、
 * 後続の銘柄には触らない (適用済み・未適用の境界は同引数の再実行で回復する)。
 */
export async function applyAtomicBatches(
  sender: AtomicBatchSender,
  batches: readonly StockBatch[]
): Promise<{ stocks: number; statements: number }> {
  let statements = 0;
  for (const b of batches) {
    await sender(b.statements);
    statements += b.statements.length;
  }
  return { stocks: batches.length, statements };
}
