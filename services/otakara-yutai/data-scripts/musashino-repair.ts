/** 8336の保存原本採用だけ。全量importを単一銘柄へ流用しない。 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { toD1BatchStatements, type D1BatchStatement } from "../../../src/shared/db/d1-http-client.js";
import { yutaiBenefits } from "../src/db/schema.js";
import { benefitRowsOf, type StockYutaiData, type YutaiFullImportDb } from "./yutai-full-import.js";
import { buildPublicBenefitFacts } from "./public-facts.js";
import { selectSummaryTasks, SummaryTask, type BenefitRow } from "./summary-tasks.js";
import { compileSimpleSummary } from "./summary-local.js";
import { planSummaryImport } from "./summary-import.js";
import { buildStockPreflightStatement, snapshotStockPreimages, type StockBatch } from "./atomic-apply.js";
import { computeYieldEntries, type YieldInputs } from "./recompute-yields.js";
import { assertMonthScopePreimage, assertMonthScopeRowsEqual, fullCas, type MonthScopePreimage } from "./saved-month-scope.js";
import { compileMusashinoOfficialLiteral, MUSASHINO_OFFICIAL_URL } from "./musashino-source.js";
import { compileNoteOfficialLiteral, NOTE_OFFICIAL_URL } from "./note-source.js";
import { compileKawasakiOfficialLiteral, KAWASAKI_OFFICIAL_URL } from "./kawasaki-source.js";
import { benefitKey } from "./benefit-key.js";
import { SUMMARY_CONTRACT_VERSION } from "./summary-contract.js";
import { parsePublicBenefitFacts } from "../src/public-facts.js";

const oldHashes = ["254833a3cbe834255b7999d7508e33afe24f7b2cb9f41b17784c9bfa89d6394e", "9002f33a9730b8e991674129e226a168c4db0ecd820ee6e1978f4b91c833567e", "03d8d3329093dbe232c44fc28baabc02ba70577d3cd3e3c873a03dfc09d38ead"];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

/** 保存済み8336/5243/3045の全段階だけ。既存全4表CASと通常compiler/取込を共用する。 */
export function planMusashinoSourceAdoption(db: YutaiFullImportDb, pre: MonthScopePreimage, data: StockYutaiData, batchFetchedAt: string, inputs: YieldInputs, now = Date.now()) {
  assertMonthScopePreimage(pre);
  const note = data.code === "5243", kawasaki = data.code === "3045", code = note ? "5243" : kawasaki ? "3045" : "8336";
  const ids = kawasaki ? [57774, 57775, 57776, 57777] : note ? [59703, 59704] : [62011, 62012, 62013];
  const shares = kawasaki ? [100, 100, 300, 300] : note ? [100, 200] : [200, 600, 2000];
  const months = kawasaki ? [2, 8, 2, 8] : ids.map(() => note ? 11 : 3);
  const stockId = Number(pre.parent.id), current = [...pre.benefits].sort((a, b) => Number(a.minShares) - Number(b.minShares) || Number(a.recordMonth) - Number(b.recordMonth));
  assert(pre.parent.code === code && data.code === code && (!note || stockId === 871) && (!kawasaki || stockId === 244) &&
    data.official?.url === (note ? NOTE_OFFICIAL_URL : kawasaki ? KAWASAKI_OFFICIAL_URL : MUSASHINO_OFFICIAL_URL) && data.sourceFetchedAt !== undefined &&
    current.length === ids.length && current.every((row, i) => row.id === ids[i] && row.minShares === shares[i] && row.recordMonth === months[i] && row.recordDate === null), "musashino_current_recipient_changed");
  assert(Number.isSafeInteger(now) && now > 0, "musashino_execution_clock_invalid");
  const source = benefitRowsOf(data);
  assert(source.heldBenefits === 0 && source.rows.length === ids.length && source.rows.every((row, i) => row.minShares === current[i].minShares && row.recordMonth === months[i]), "musashino_adopted_source_incomplete");
  assert(!note || source.rows.every(row => compileNoteOfficialLiteral(row.description)?.minShares === row.minShares), "note_full_source_changed");
  assert(!kawasaki || source.rows.every(row => compileKawasakiOfficialLiteral(row.description)?.minShares === row.minShares), "kawasaki_full_source_changed");
  const rows: BenefitRow[] = current.map((row, i) => ({ id: Number(row.id), stockId, stockCode: code, stockName: String(pre.parent.name),
    description: source.rows[i].description, shortSummary: null, estimatedValue: null, estimateValueSource: null,
    minShares: Number(row.minShares), recordMonth: months[i], recordDate: null, updatedAt: Number(row.updatedAt) }));
  const tasks = selectSummaryTasks(rows), results = tasks.map(compileSimpleSummary);
  assert(tasks.length === (kawasaki ? 2 : ids.length) && results.every(result => result !== null), "musashino_normal_compiler_held");
  const summaryPlan = planSummaryImport({ tasks, currentRows: rows, resultsText: results.map(result => JSON.stringify(result)).join("\n") });
  assert(summaryPlan.rejections.length === 0 && summaryPlan.updates.length === tasks.length, "musashino_normal_import_held");
  const expected = structuredClone(pre), executionSecond = Math.floor(now / 1000);
  const changes = source.rows.map((sourceRow, i) => {
    const update = summaryPlan.updates.find(value => value.ids.includes(Number(current[i].id)));
    assert(update !== undefined && update.estimatedValue === null && update.estimateValueSource === null, "musashino_value_not_qualified");
    const publicFacts = buildPublicBenefitFacts({ code, description: sourceRow.description, context: { minShares: [sourceRow.minShares], recordMonths: [sourceRow.recordMonth] },
      fetchedAt: data.sourceFetchedAt!, batchFetchedAt, official: data.official });
    const values = { description: sourceRow.description, publicFacts: JSON.stringify(publicFacts), shortSummary: update.shortSummary, estimatedValue: null, estimateValueSource: null };
    const target = expected.benefits.find(row => row.id === current[i].id)!;
    Object.assign(target, values, { updatedAt: executionSecond });
    return { id: Number(target.id), values, publicFacts };
  });
  const equivalent = changes.every(change => Object.entries(change.values).every(([key, value]) => current.find(row => row.id === change.id)![key] === value));
  const snapshot = snapshotStockPreimages(inputs, [stockId]).get(stockId);
  assert(snapshot !== undefined && snapshot.parent.code === code && snapshot.benefits.length === ids.length, "musashino_recompute_scope_changed");
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
  const originalHashes = kawasaki ? ["879b2f6c67d219daf6329ffb277c6ff7aeca6ceb595ff9ffe844e496a94672b2", "879b2f6c67d219daf6329ffb277c6ff7aeca6ceb595ff9ffe844e496a94672b2", "d90abf29e50bf52e40ae87887ded76a98157e092929be8b99e892a120c8a8908", "d90abf29e50bf52e40ae87887ded76a98157e092929be8b99e892a120c8a8908"]
    : note ? ["b689b61ef9d3d573625a92cf429a17ec10e5520bce32e87929cf4036681bf612", "84c97aabda01c7054f9f4548f342ecbdb053757a2c55454957587439bef1e85d"] : oldHashes;
  assert(current.every((row, i) => digest(String(row.description)) === originalHashes[i] &&
    (note && i === 0 ? typeof row.shortSummary === "string" && digest(row.shortSummary) === "3bc4d332cb0fd46f5330cedaea789935eb54cc90093ba6252f450eb67a389a0b" : row.shortSummary === null) &&
    row.estimatedValue === null && row.estimateValueSource === null), "musashino_original_three_sources_changed");
  const statements: D1BatchStatement[] = [buildStockPreflightStatement(snapshot), fullCas(pre)];
  for (const change of changes) {
    statements.push(...toD1BatchStatements([db.update(yutaiBenefits).set({ ...change.values, publicFacts: change.publicFacts, updatedAt: new Date(executionSecond * 1000) })
      .where(and(eq(yutaiBenefits.id, change.id), eq(yutaiBenefits.stockId, stockId)))]),
    { sql: "SELECT json(CASE WHEN changes() = 1 THEN 'null' ELSE '' END)", params: [] });
  }
  statements.push(fullCas(expected));
  const batch: StockBatch = { stockId, key: `${note ? "note" : kawasaki ? "kawasaki" : "musashino"}-source-adoption:${stockId}`, statements };
  return { batch, expected, clock: undefined, yieldPlan, updatedRows: ids.length };
}

/** 初回追加後の実採番IDだけを回収し、他の全列は計画どおりか照合する。 */
export function assertMusashinoInitialPost(expected: MonthScopePreimage, actual: MonthScopePreimage): void {
  assertMonthScopePreimage(actual);
  const resolved = structuredClone(expected);
  for (const row of resolved.benefits.filter(value => value.id === null)) {
    const matches = actual.benefits.filter(value => value.minShares === row.minShares && value.recordMonth === 9 && value.recordDate === "2026-09-30");
    assert(matches.length === 1 && !expected.benefits.some(value => value.id === matches[0].id), "musashino_initial_post_identity_changed");
    row.id = matches[0].id;
  }
  assertMonthScopeRowsEqual(resolved, actual);
}

/** .4年次3行の受入後だけ、初回実日付の3INSERTを同じ銘柄batchへ載せる。 */
export function planMusashinoInitialEvent(db: YutaiFullImportDb, pre: MonthScopePreimage, annual: StockYutaiData, initial: StockYutaiData, batchFetchedAt: string, inputs: YieldInputs, now = Date.now()) {
  assertMonthScopePreimage(pre);
  const stockId = Number(pre.parent.id), historical = pre.benefits.filter(row => row.recordDate !== null);
  assert(Number.isSafeInteger(now) && now > 0 && (historical.length === 0 || historical.length === 3) &&
    pre.benefits.length === 3 + historical.length && historical.every(row => row.recordMonth === 9 && row.recordDate === "2026-09-30"), "musashino_initial_current_scope_changed");
  // 年次の既存資格を再実装せず、同じ限定plannerのSQL0を要求する。
  const annualPre = { ...pre, benefits: pre.benefits.filter(row => row.recordDate === null) };
  const annualInputs = { ...inputs, benefits: new Map(inputs.benefits) };
  const currentBenefits = inputs.benefits.get(stockId);
  assert(currentBenefits !== undefined, "musashino_initial_yield_benefits_missing");
  annualInputs.benefits.set(stockId, currentBenefits.filter(row => row.recordDate === null));
  assert(planMusashinoSourceAdoption(db, annualPre, annual, batchFetchedAt, annualInputs, now).batch === null, "musashino_annual_adoption_must_be_complete");
  assert(initial.code === "8336" && initial.sourceFetchedAt === annual.sourceFetchedAt && initial.official?.url === MUSASHINO_OFFICIAL_URL &&
    initial.official.verifiedAt === annual.official?.verifiedAt, "musashino_initial_source_provenance_changed");
  const source = benefitRowsOf(initial);
  assert(source.heldBenefits === 0 && source.rows.length === 3 && source.rows.every((row, i) => row.minShares === [200, 600, 2000][i] && row.recordMonth === 9), "musashino_initial_source_incomplete");
  const executionSecond = historical.length === 0 ? Math.floor(now / 1000) : Number(historical[0].createdAt);
  assert(Number.isSafeInteger(executionSecond) && executionSecond >= Math.floor(Date.parse(initial.official.verifiedAt) / 1000) && executionSecond <= Math.floor(now / 1000), "musashino_initial_clock_invalid");
  const added = source.rows.map(row => {
    const literal = compileMusashinoOfficialLiteral(row.description);
    assert(literal !== null && literal.minShares === row.minShares && literal.recordMonth === 9 && literal.recordDate === "2026-09-30", "musashino_initial_full_source_changed");
    const task = SummaryTask.parse({ taskId: benefitKey("8336", row.description), contractVersion: SUMMARY_CONTRACT_VERSION, reason: "missing", violations: [],
      stockCode: "8336", stockName: String(pre.parent.name), description: row.description, rowCount: 1,
      recipients: [{ minShares: row.minShares, recordMonth: 9, recordDate: "2026-09-30" }] });
    const result = compileSimpleSummary(task);
    assert(result !== null && result.estimatedValue === null, "musashino_initial_normal_compiler_held");
    const publicFacts = buildPublicBenefitFacts({ code: "8336", description: row.description, context: { minShares: [row.minShares], recordMonths: [9] },
      fetchedAt: initial.sourceFetchedAt!, batchFetchedAt, official: initial.official });
    assert(publicFacts.version === 6 && publicFacts.conditionStructure.ast.recordDate === "2026-09-30" && publicFacts.qualifiedAmount === null, "musashino_initial_value_not_qualified");
    const genre = annualPre.benefits.find(value => value.minShares === row.minShares);
    assert(genre !== undefined, "musashino_initial_genre_missing");
    return { id: null, stockId, genreId: genre.genreId, description: row.description, shortSummary: result.shortSummary, publicFacts: JSON.stringify(publicFacts),
      minShares: row.minShares, recordMonth: 9, recordDate: "2026-09-30", estimatedValue: null, estimateValueSource: null, createdAt: executionSecond, updatedAt: executionSecond };
  });
  const expected: MonthScopePreimage = { ...pre, benefits: [...annualPre.benefits, ...added] };
  const snapshot = snapshotStockPreimages(inputs, [stockId]).get(stockId);
  assert(snapshot !== undefined && snapshot.parent.code === "8336" && snapshot.benefits.length === pre.benefits.length &&
    isDeepStrictEqual(snapshot.benefits, pre.benefits.map(row => Object.fromEntries(Object.keys(snapshot.benefits[0]).map(key => [key, row[key]])))), "musashino_initial_recompute_preimage_changed");
  if (historical.length === 3) {
    assertMusashinoInitialPost(expected, pre);
    return { batch: null, expected: pre, clock: undefined, insertedRows: 0 };
  }
  const statements: D1BatchStatement[] = [buildStockPreflightStatement(snapshot), fullCas(pre)];
  for (const row of added) {
    const { id: omittedId, ...values } = row; void omittedId;
    const publicFacts = parsePublicBenefitFacts(values.publicFacts, initial.code);
    assert(publicFacts !== null, "musashino_initial_public_facts_missing");
    statements.push(...toD1BatchStatements([db.insert(yutaiBenefits).values({ ...values, genreId: Number(values.genreId), publicFacts,
      createdAt: new Date(executionSecond * 1000), updatedAt: new Date(executionSecond * 1000) })]),
      { sql: "SELECT json(CASE WHEN changes() = 1 THEN 'null' ELSE '' END)", params: [] });
  }
  // 全列CASの期待値のIDだけをDB実値で埋める。連番/MAX+1を予測せず、他列は一切読替えない。
  const postCas = fullCas(expected), prefix = "WITH snap(j) AS (VALUES (?)) ";
  assert(postCas.sql.startsWith(prefix), "musashino_initial_full_cas_contract_changed");
  const params: (string | number)[] = [JSON.stringify(expected)];
  const ids = added.map((row, i) => {
    params.push(stockId, row.minShares);
    return `'$.benefits[${annualPre.benefits.length + i}].id', (SELECT id FROM yutai_benefits WHERE stock_id=? AND min_shares=? AND record_month=9 AND record_date='2026-09-30')`;
  });
  statements.push({ sql: `WITH snap(j) AS (SELECT json_set(?, ${ids.join(", ")})) ${postCas.sql.slice(prefix.length)}`, params: [...params, ...postCas.params.slice(1)] });
  const batch: StockBatch = { stockId, key: `musashino-initial-event:${stockId}`, statements };
  return { batch, expected, clock: undefined, insertedRows: 3 };
}
