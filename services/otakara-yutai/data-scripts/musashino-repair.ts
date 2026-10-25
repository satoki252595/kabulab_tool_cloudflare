/** 8336の保存原本採用だけ。全量importを単一銘柄へ流用しない。 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { toD1BatchStatements, type D1BatchStatement } from "../../../src/shared/db/d1-http-client.js";
import { yutaiBenefits } from "../src/db/schema.js";
import { benefitRowsOf, type StockYutaiData, type YutaiFullImportDb } from "./yutai-full-import.js";
import { buildPublicBenefitFacts } from "./public-facts.js";
import { selectSummaryTasks, type BenefitRow } from "./summary-tasks.js";
import { compileSimpleSummary } from "./summary-local.js";
import { planSummaryImport } from "./summary-import.js";
import { buildStockPreflightStatement, snapshotStockPreimages, type StockBatch } from "./atomic-apply.js";
import { computeYieldEntries, type YieldInputs } from "./recompute-yields.js";
import { assertMonthScopePreimage, fullCas, type MonthScopePreimage } from "./saved-month-scope.js";
import { MUSASHINO_OFFICIAL_URL } from "./musashino-source.js";

const oldHashes = ["254833a3cbe834255b7999d7508e33afe24f7b2cb9f41b17784c9bfa89d6394e", "9002f33a9730b8e991674129e226a168c4db0ecd820ee6e1978f4b91c833567e", "03d8d3329093dbe232c44fc28baabc02ba70577d3cd3e3c873a03dfc09d38ead"];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

/** 全3段階・全4表を束縛し、同じ通常compiler/取込/利回り計算で3UPDATEだけを計画する。 */
export function planMusashinoSourceAdoption(db: YutaiFullImportDb, pre: MonthScopePreimage, data: StockYutaiData, batchFetchedAt: string, inputs: YieldInputs, now = Date.now()) {
  assertMonthScopePreimage(pre);
  const stockId = Number(pre.parent.id), current = [...pre.benefits].sort((a, b) => Number(a.minShares) - Number(b.minShares));
  assert(pre.parent.code === "8336" && data.code === "8336" && data.official?.url === MUSASHINO_OFFICIAL_URL && data.sourceFetchedAt !== undefined &&
    current.length === 3 && current.every((row, i) => row.id === [62011, 62012, 62013][i] && row.minShares === [200, 600, 2000][i] && row.recordMonth === 3 && row.recordDate === null), "musashino_current_recipient_changed");
  assert(Number.isSafeInteger(now) && now > 0, "musashino_execution_clock_invalid");
  const source = benefitRowsOf(data);
  assert(source.heldBenefits === 0 && source.rows.length === 3 && source.rows.every((row, i) => row.minShares === current[i].minShares && row.recordMonth === 3), "musashino_adopted_source_incomplete");
  const rows: BenefitRow[] = current.map((row, i) => ({ id: Number(row.id), stockId, stockCode: "8336", stockName: String(pre.parent.name),
    description: source.rows[i].description, shortSummary: null, estimatedValue: null, estimateValueSource: null,
    minShares: Number(row.minShares), recordMonth: 3, recordDate: null, updatedAt: Number(row.updatedAt) }));
  const tasks = selectSummaryTasks(rows), results = tasks.map(compileSimpleSummary);
  assert(tasks.length === 3 && results.every(result => result !== null), "musashino_normal_compiler_held");
  const summaryPlan = planSummaryImport({ tasks, currentRows: rows, resultsText: results.map(result => JSON.stringify(result)).join("\n") });
  assert(summaryPlan.rejections.length === 0 && summaryPlan.updates.length === 3, "musashino_normal_import_held");
  const expected = structuredClone(pre), executionSecond = Math.floor(now / 1000);
  const changes = source.rows.map((sourceRow, i) => {
    const update = summaryPlan.updates.find(value => value.ids.length === 1 && value.ids[0] === current[i].id);
    assert(update !== undefined && update.estimatedValue === null && update.estimateValueSource === null, "musashino_value_not_qualified");
    const publicFacts = buildPublicBenefitFacts({ code: "8336", description: sourceRow.description, context: { minShares: [sourceRow.minShares], recordMonths: [3] },
      fetchedAt: data.sourceFetchedAt!, batchFetchedAt, official: data.official });
    const values = { description: sourceRow.description, publicFacts: JSON.stringify(publicFacts), shortSummary: update.shortSummary, estimatedValue: null, estimateValueSource: null };
    const target = expected.benefits.find(row => row.id === current[i].id)!;
    Object.assign(target, values, { updatedAt: executionSecond });
    return { id: Number(target.id), values, publicFacts };
  });
  const equivalent = changes.every(change => Object.entries(change.values).every(([key, value]) => current.find(row => row.id === change.id)![key] === value));
  const snapshot = snapshotStockPreimages(inputs, [stockId]).get(stockId);
  assert(snapshot !== undefined && snapshot.parent.code === "8336" && snapshot.benefits.length === 3, "musashino_recompute_scope_changed");
  const project = (row: Record<string, string | number | null> | null, shape: object | null) => shape === null ? row : row === null ? null : Object.fromEntries(Object.keys(shape).map(key => [key, row[key]]));
  assert(isDeepStrictEqual(current.map(row => project(row, snapshot.benefits[0])), snapshot.benefits) &&
    isDeepStrictEqual(project(pre.financial, snapshot.financial), snapshot.financial) &&
    isDeepStrictEqual(project(pre.scores, snapshot.scores), snapshot.scores), "musashino_recompute_preimage_changed");
  const nextInputs = { ...inputs, benefits: new Map(inputs.benefits) };
  nextInputs.benefits.set(stockId, expected.benefits.map(row => ({ rowId: Number(row.id), minShares: Number(row.minShares), recordMonth: Number(row.recordMonth), recordDate: row.recordDate as string | null,
    description: String(row.description), shortSummary: row.shortSummary as string | null, estimatedValue: row.estimatedValue as number | null, estimateValueSource: row.estimateValueSource as string | null, updatedAt: Number(row.updatedAt) })));
  const yieldPlan = computeYieldEntries([stockId], nextInputs), entry = yieldPlan.entries[0];
  assert(entry === undefined || (!entry.changed && !entry.scoreChanged), "musashino_recompute_requires_other_updates");
  if (equivalent) {
    return { batch: null, expected: pre, clock: undefined, yieldPlan, updatedRows: 0 };
  }
  assert(current.every((row, i) => digest(String(row.description)) === oldHashes[i] && row.shortSummary === null && row.estimatedValue === null && row.estimateValueSource === null), "musashino_original_three_sources_changed");
  const statements: D1BatchStatement[] = [buildStockPreflightStatement(snapshot), fullCas(pre)];
  for (const change of changes) {
    statements.push(...toD1BatchStatements([db.update(yutaiBenefits).set({ ...change.values, publicFacts: change.publicFacts, updatedAt: new Date(executionSecond * 1000) })
      .where(and(eq(yutaiBenefits.id, change.id), eq(yutaiBenefits.stockId, stockId)))]),
    { sql: "SELECT json(CASE WHEN changes() = 1 THEN 'null' ELSE '' END)", params: [] });
  }
  statements.push(fullCas(expected));
  const batch: StockBatch = { stockId, key: `musashino-source-adoption:${stockId}`, statements };
  return { batch, expected, clock: undefined, yieldPlan, updatedRows: 3 };
}
