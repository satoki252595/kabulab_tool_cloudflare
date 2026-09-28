/**
 * 要約取り込み後の優待利回り・スコアの再計算。
 *
 * 背景: `import-summary-results.ts --apply` は `yutai_benefits.estimated_value`
 * を書き換えるが、`otakara_stock_financials.yutai_yield` を更新しないため、
 * 取り込んだ銘柄の利回りが古い入力のまま残る (2026-09-28 監査 F3 の fresh 7 行)。
 * 月次 rebuild まで放置すると画面の利回りとランキングが誤表示になるので、
 * 取り込みと同じ実行で、書いた銘柄だけ利回りを再計算する。スコア
 * (`otakara_stock_scores`) も優待利回りを 15% の重みで使うため、一緒に
 * 追随させる (利回りだけ直すとスコアが置き去りになる)。
 *
 * 計算式は月次 rebuild (`src/cron/monthly.ts` の `calcYutaiYield` と
 * `src/shared/scoring.ts` の `scoreStock`) と同一関数で、株価などの入力は
 * 行の現値 (月次で写した core 値) のまま使う。`data_date` は月次で作り
 * 直した日に据え置く (この再計算は利回り・スコア列だけを現入力に合わせる
 * もので、行全体の作り直しではないため、日付を進めると株価の鮮度を偽る)。
 * 値が変わらない銘柄には UPDATE を打たない (再実行で 0 件・冪等)。
 */
import { inArray } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { D1BatchStatement } from "../../../src/shared/db/d1-http-client.js";
import { calcYutaiYield } from "../../../src/cron/monthly.js";
import { scoreStock, type ScoringInput } from "../../../src/shared/scoring.js";
import { stocks as coreStocks } from "../../../src/shared/db/core-schema.js";
import { stockFinancials, stockScores, yutaiBenefits } from "../src/db/schema.js";
// NOTE: atomic-apply.ts と相互 import (関数本体でのみ使い合うため ESM live binding で成立)。
import { buildStockPreflightStatement, type StockPreimage } from "./atomic-apply.js";

/**
 * 利回りの読み書きができれば足りる drizzle db 型。Node の D1 HTTP 版
 * (sqlite-proxy) もテストのローカル SQLite も渡せる。
 */
export type RecomputeYieldsDb = BaseSQLiteDatabase<"async", unknown, Record<string, unknown>>;

/** D1 の bind 上限 (100/文) に収める IN リストの長さ。 */
const ID_CHUNK = 80;

export type ScoreTriple = {
  fundamentalScore: number;
  technicalScore: number;
  totalScore: number;
};

export type YieldRecomputeEntry = {
  stockId: number;
  /** 再計算前の保存値 (行が無い銘柄は計画に含めない)。 */
  prev: number | null;
  /** 現入力での再計算値。 */
  next: number | null;
  /** 値が変わり、書き込み対象になるか。 */
  changed: boolean;
  /** スコアの再計算 (財務行の現値 + 新しい利回り)。スコア行が無ければ null。 */
  scorePrev: ScoreTriple | null;
  scoreNext: ScoreTriple | null;
  scoreChanged: boolean;
};

export type YieldRecomputePlan = {
  entries: YieldRecomputeEntry[];
  /** 財務行が無く、再計算の対象外になった銘柄 (core 未取得の skip と同じ扱い)。 */
  skippedNoRow: number[];
  /** 財務行はあるがスコア行が無く、スコアだけ対象外になった銘柄。 */
  skippedNoScore: number[];
};

export type YieldInputs = {
  prices: Map<
    number,
    { price: number | null; yutaiYield: number | null; dataDate: string; fetchedAt: number }
  >;
  benefits: Map<
    number,
    {
      rowId: number;
      minShares: number;
      recordMonth: number;
      description: string;
      shortSummary: string | null;
      estimatedValue: number | null;
      estimateValueSource: string | null;
      updatedAt: number;
    }[]
  >;
  /** スコア入力 (財務行の現値。月次 rebuild が写した core 値)。 */
  scoreInputs: Map<number, ScoringInput>;
  scores: Map<number, ScoreTriple>;
  /**
   * 親銘柄の同一性 (同一読取で取得)。preflight が銘柄の付け替え・凍結破り・
   * 区分違いを止める。行が無い銘柄は snapshot で STOP する (縮めない)。
   */
  parents: Map<number, { code: string; isActive: boolean; instrumentType: string | null } | null>;
};

/** D1 から利回り・スコア入力を読む。 */
export async function fetchYieldInputs(
  db: RecomputeYieldsDb,
  stockIds: readonly number[]
): Promise<YieldInputs> {
  const ids = [...new Set(stockIds)].sort((a, b) => a - b);
  const prices: YieldInputs["prices"] = new Map();
  const benefits: YieldInputs["benefits"] = new Map();
  const scoreInputs: YieldInputs["scoreInputs"] = new Map();
  const scores: YieldInputs["scores"] = new Map();
  const parents: YieldInputs["parents"] = new Map();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const parentRows = await db
      .select({
        stockId: coreStocks.id,
        code: coreStocks.code,
        isActive: coreStocks.isActive,
        instrumentType: coreStocks.instrumentType,
      })
      .from(coreStocks)
      .where(inArray(coreStocks.id, chunk));
    for (const id of chunk) {
      const p = parentRows.find((r) => r.stockId === id);
      parents.set(id, p ? { code: p.code, isActive: p.isActive, instrumentType: p.instrumentType } : null);
    }
    const finRows = await db
      .select({
        stockId: stockFinancials.stockId,
        price: stockFinancials.price,
        per: stockFinancials.per,
        pbr: stockFinancials.pbr,
        dividendYield: stockFinancials.dividendYield,
        roe: stockFinancials.roe,
        ma25: stockFinancials.ma25,
        rsi14: stockFinancials.rsi14,
        macd: stockFinancials.macd,
        macdSignal: stockFinancials.macdSignal,
        yutaiYield: stockFinancials.yutaiYield,
        dataDate: stockFinancials.dataDate,
        fetchedAt: stockFinancials.fetchedAt,
      })
      .from(stockFinancials)
      .where(inArray(stockFinancials.stockId, chunk));
    for (const f of finRows) {
      prices.set(f.stockId, {
        price: f.price,
        yutaiYield: f.yutaiYield,
        dataDate: f.dataDate,
        fetchedAt: Math.floor(f.fetchedAt.getTime() / 1000),
      });
      // yutaiYield だけ後で差し替える (他は行の現値のまま)
      scoreInputs.set(f.stockId, { ...f, yutaiYield: f.yutaiYield });
    }
    const scoreRows = await db
      .select({
        stockId: stockScores.stockId,
        fundamentalScore: stockScores.fundamentalScore,
        technicalScore: stockScores.technicalScore,
        totalScore: stockScores.totalScore,
      })
      .from(stockScores)
      .where(inArray(stockScores.stockId, chunk));
    for (const s of scoreRows) scores.set(s.stockId, s);
    const benRows = await db
      .select({
        rowId: yutaiBenefits.id,
        stockId: yutaiBenefits.stockId,
        minShares: yutaiBenefits.minShares,
        recordMonth: yutaiBenefits.recordMonth,
        description: yutaiBenefits.description,
        shortSummary: yutaiBenefits.shortSummary,
        estimatedValue: yutaiBenefits.estimatedValue,
        estimateValueSource: yutaiBenefits.estimateValueSource,
        updatedAt: yutaiBenefits.updatedAt,
      })
      .from(yutaiBenefits)
      .where(inArray(yutaiBenefits.stockId, chunk));
    for (const b of benRows) {
      const row = { ...b, updatedAt: Math.floor(b.updatedAt.getTime() / 1000) };
      const list = benefits.get(b.stockId);
      if (list) list.push(row);
      else benefits.set(b.stockId, [row]);
    }
  }
  return { prices, benefits, scoreInputs, scores, parents };
}

/**
 * 利回り・スコア再計算の純計算。`overlay` は dry-run 用の仮適用
 * (優待行 id → 書き込み予定の推定値。null は利回り入力から外す)。
 */
export function computeYieldEntries(
  stockIds: readonly number[],
  inputs: YieldInputs,
  overlay: ReadonlyMap<number, number | null> = new Map()
): YieldRecomputePlan {
  const entries: YieldRecomputeEntry[] = [];
  const skippedNoRow: number[] = [];
  const skippedNoScore: number[] = [];
  for (const stockId of [...new Set(stockIds)].sort((a, b) => a - b)) {
    const fin = inputs.prices.get(stockId);
    if (!fin) {
      skippedNoRow.push(stockId);
      continue;
    }
    // 月次 rebuild と同じく金額換算できた行だけが利回りの入力
    const rows = (inputs.benefits.get(stockId) ?? [])
      .map((b) => ({
        minShares: b.minShares,
        estimatedValue: overlay.has(b.rowId) ? overlay.get(b.rowId)! : b.estimatedValue,
      }))
      .filter(
        (b): b is { minShares: number; estimatedValue: number } => b.estimatedValue !== null
      );
    const next = calcYutaiYield(fin.price, rows);
    const scorePrev = inputs.scores.get(stockId) ?? null;
    const scoreInput = inputs.scoreInputs.get(stockId);
    let scoreNext: ScoreTriple | null = null;
    if (scoreInput) {
      const s = scoreStock({ ...scoreInput, yutaiYield: next });
      scoreNext = {
        fundamentalScore: s.fundamentalScore,
        technicalScore: s.technicalScore,
        totalScore: s.totalScore,
      };
    }
    if (!scorePrev) skippedNoScore.push(stockId);
    const scoreChanged =
      scorePrev !== null &&
      scoreNext !== null &&
      (scorePrev.fundamentalScore !== scoreNext.fundamentalScore ||
        scorePrev.technicalScore !== scoreNext.technicalScore ||
        scorePrev.totalScore !== scoreNext.totalScore);
    entries.push({
      stockId,
      prev: fin.yutaiYield,
      next,
      changed: fin.yutaiYield !== next,
      scorePrev,
      scoreNext,
      scoreChanged,
    });
  }
  return { entries, skippedNoRow, skippedNoScore };
}

/**
 * 指定銘柄の利回り・スコア再計算の計画を作る (副作用なし)。
 * dry-run では `overlay` に書き込み予定値を渡し、適用後の利回りを先に見せる。
 */
export async function planYieldRecompute(
  db: RecomputeYieldsDb,
  stockIds: readonly number[],
  overlay: ReadonlyMap<number, number | null> = new Map()
): Promise<YieldRecomputePlan> {
  return computeYieldEntries(stockIds, await fetchYieldInputs(db, stockIds), overlay);
}

/**
 * 計画のうち変わる行だけ `yutai_yield` (+ `fetched_at`) とスコア 3 列を書く。
 * `data_date` には触らない (月次の作り直し日を保つ)。
 * 1 銘柄の利回り・スコアは 1 送信 (`{batch}` 1 リクエスト) で送る原子単位。
 * 先頭に必ず preflight 文を置く (preimage 不一致は SQL エラー → rollback)。
 * 送信口は呼び出し側が渡す (本番は `createD1HttpBatchSender`)。
 */
export async function applyYieldRecomputeAtomically(
  sender: (statements: readonly D1BatchStatement[]) => Promise<void>,
  plan: YieldRecomputePlan,
  preimages: ReadonlyMap<number, StockPreimage>
): Promise<{ updated: number; scoresUpdated: number }> {
  let updated = 0;
  let scoresUpdated = 0;
  for (const e of plan.entries) {
    const statements = buildYieldScoreStatements(e);
    if (statements.length === 0) continue;
    const snap = preimages.get(e.stockId);
    if (!snap) {
      throw new Error(`銘柄 ${e.stockId} の preimage がありません (ガード無しでは書かない)`);
    }
    await sender([buildStockPreflightStatement(snap), ...statements]);
    if (e.changed) updated++;
    if (e.scoreChanged) scoresUpdated++;
  }
  return { updated, scoresUpdated };
}

/**
 * 1 銘柄の再計算結果を D1 REST batch 用の UPDATE 文にする (純関数・副作用なし)。
 * 変わる列だけ書く (`yutai_yield` + `fetched_at`、スコア 3 列)。
 * `data_date` には触らない。`applyYieldRecomputeAtomically` と
 * 原子適用 (`atomic-apply.ts`) が使う。
 */
export function buildYieldScoreStatements(entry: YieldRecomputeEntry): D1BatchStatement[] {
  const out: D1BatchStatement[] = [];
  if (entry.changed) {
    out.push({
      sql: "UPDATE otakara_stock_financials SET yutai_yield = ?, fetched_at = (unixepoch()) WHERE stock_id = ?",
      params: [entry.next, entry.stockId],
    });
  }
  if (entry.scoreChanged && entry.scoreNext) {
    out.push({
      sql: "UPDATE otakara_stock_scores SET fundamental_score = ?, technical_score = ?, total_score = ? WHERE stock_id = ?",
      params: [
        entry.scoreNext.fundamentalScore,
        entry.scoreNext.technicalScore,
        entry.scoreNext.totalScore,
        entry.stockId,
      ],
    });
  }
  return out;
}

/** 計画をログ用の行にする。銘柄コードの解決は呼び出し側で行う。 */
export function formatRecomputeReport(
  plan: YieldRecomputePlan,
  codeOf: (stockId: number) => string
): string[] {
  const out: string[] = [];
  const changed = plan.entries.filter((e) => e.changed);
  const scoreChanged = plan.entries.filter((e) => e.scoreChanged);
  out.push(
    `利回り再計算の対象: ${plan.entries.length} 銘柄 ` +
      `(利回りが変わる: ${changed.length} 銘柄, スコアが変わる: ${scoreChanged.length} 銘柄)`
  );
  const fmt = (v: number | null): string => (v === null ? "null" : v.toFixed(4));
  for (const e of changed.slice(0, 30)) {
    out.push(`  ${codeOf(e.stockId)}: ${fmt(e.prev)} → ${fmt(e.next)}`);
  }
  if (changed.length > 30) out.push(`  … 他 ${changed.length - 30} 銘柄`);
  if (plan.skippedNoRow.length > 0) {
    out.push(`  財務行が無く対象外: ${plan.skippedNoRow.map(codeOf).slice(0, 10).join(", ")}`);
  }
  if (plan.skippedNoScore.length > 0) {
    out.push(
      `  スコア行が無くスコアだけ対象外: ${plan.skippedNoScore.map(codeOf).slice(0, 10).join(", ")}`
    );
  }
  return out;
}
