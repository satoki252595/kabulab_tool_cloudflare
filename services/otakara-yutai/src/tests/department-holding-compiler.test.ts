import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import { compileDepartmentHoldingLiteral } from "../../data-scripts/holding-structure.js";
import { checkSummary, isSummaryNumbersGrounded, SUMMARY_CONTRACT_VERSION, SUMMARY_MAX_CHARS } from "../../data-scripts/summary-contract.js";
import { companyValue, compileSimpleSummary } from "../../data-scripts/summary-local.js";
import { planSummaryImport, type SummaryResult } from "../../data-scripts/summary-import.js";
import { selectSummaryTasks, type BenefitRow, type SummaryTask } from "../../data-scripts/summary-tasks.js";
import { carryKey, planCarry } from "../../data-scripts/yutai-full-import.js";
import { splitHeadedDescription } from "../../data-scripts/estimated-value-guard.js";
import saved from "./fixtures/department-holding-saved6.json";

const privatePath = join(ROOT, "tmp/yutai-department-holding-proof-v1/saved6-v2.private.json");
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const bytes = readFileSync(privatePath);
  expect(sha(bytes)).toBe(saved.provenance.privateFixtureSha256);
  return JSON.parse(bytes.toString()) as { tasks: SummaryTask[]; rows: BenefitRow[]; expectedResults: SummaryResult[] };
}

it("不完全な百貨店の保有判定scopeを一般株数へ降格させず、現在tierの照合も維持する", () => {
  const description = '【種別："大丸・松坂屋 買物優待カード 10%割引"】\n合成の不完全条件:100株・7回以上';
  expect(compileDepartmentHoldingLiteral(description)).toBeNull();
  expect(isSummaryNumbersGrounded(description, "3年判定:100株・7回以上", { minShares: [100], recordMonths: [2] })).toBe(false);
  expect(isSummaryNumbersGrounded("合成商品券1000円", "500株:1000円", { minShares: [500], recordMonths: [2] })).toBe(true);
  expect(isSummaryNumbersGrounded("合成商品券1000円", "100株:1000円", { minShares: [500], recordMonths: [2] })).toBe(false);
  expect(SUMMARY_MAX_CHARS).toBe(120);
});

it.skipIf(!existsSync(privatePath))("保存6tier/12行の全文・両利用枠と歴史100株を通常compiler/import/selector/carryで保持する", () => {
  const source = fixture(), tasks = selectSummaryTasks(source.rows);
  expect(tasks.length).toBe(6); expect(source.rows.length).toBe(12);
  expect(tasks.every(task => task.contractVersion === SUMMARY_CONTRACT_VERSION)).toBe(true);
  const results = tasks.map(task => {
    const metadata = saved.groups.find(g => g.taskId === task.taskId);
    expect(sha(task.description)).toBe(metadata?.sourceSha256);
    expect(companyValue(task)).toEqual({ value: null, reason: "multi_month_amounts" });
    const result = compileSimpleSummary(task);
    if (result === null) throw new Error("department_literal_missing");
    expect(sha(result.shortSummary)).toBe(metadata?.expectedSummarySha256);
    expect(result.shortSummary.length <= SUMMARY_MAX_CHARS).toBe(true);
    expect(result.estimatedValue).toBeNull();
    expect(checkSummary(result.shortSummary)).toEqual([]);
    return result;
  });
  const plan = planSummaryImport({ tasks, currentRows: source.rows, resultsText: results.map(r => JSON.stringify(r)).join("\n") });
  expect(plan.rejections.map(r => r.reason)).toEqual([]); expect(plan.updates.length).toBe(6);
  expect(plan.updates.flatMap(u => u.ids).length).toBe(12);
  const after = source.rows.map(row => {
    const update = plan.updates.find(u => u.ids.includes(row.id));
    if (update === undefined) throw new Error("department_update_missing");
    expect(update.estimatedValue === null && update.estimateValueSource === null).toBe(true);
    return { ...row, shortSummary: update.shortSummary, estimatedValue: null, estimateValueSource: null };
  });
  expect(selectSummaryTasks(after).length).toBe(0);
  for (const row of after) {
    const source = splitHeadedDescription(row.description);
    if (source.heading === null) throw new Error("department_heading_missing");
    const key = carryKey(row.stockCode, source.body, row.minShares, row.recordMonth);
    const groups = new Map([[row.stockCode, new Map([[source.body, {
      minShares: after.filter(r => r.description === row.description).map(r => r.minShares),
      recordMonths: after.filter(r => r.description === row.description).map(r => r.recordMonth),
    }]])]]);
    const carried = planCarry([{ ...row, code: row.stockCode }], new Map([[key, [source.heading]]]), groups).carried.get(key);
    expect(typeof carried?.shortSummary === "string").toBe(true); expect(sha(carried!.shortSummary!)).toBe(sha(row.shortSummary));
    for (const headings of [["別の買物カード"], [source.heading, "別の買物カード"], ["別の買物カード", source.heading], []]) {
      const rejected = planCarry([{ ...row, code: row.stockCode }], new Map([[key, headings]]), groups);
      expect(rejected.carried.get(key)?.shortSummary === null).toBe(true);
      expect(rejected.nulledKeys.has(key)).toBe(true);
    }
  }
  const old = results.map(r => JSON.stringify({ ...r, contractVersion: "2026-10-25.7" })).join("\n");
  expect(planSummaryImport({ tasks, currentRows: source.rows, resultsText: old }).rejections.map(r => r.reason)).toEqual(Array(6).fill("contract_version"));
  expect(planSummaryImport({ tasks, currentRows: source.rows, resultsText: JSON.stringify({ ...results[0], estimatedValue: 1000000 }) }).updates.length).toBe(0);
});

it.skipIf(!existsSync(privatePath))("限度額・全文条件・歴史株数・月と定型句の矛盾を拒否し、上限を受取額にしない", () => {
  const { rows } = fixture(), task = selectSummaryTasks(rows)[0], result = compileSimpleSummary(task);
  if (result === null) throw new Error("department_literal_missing");
  const context = { minShares: task.recipients.map(r => r.minShares), recordMonths: task.recipients.map(r => r.recordMonth) };
  const lines = task.description.split("\n");
  const changed = [task.description + "\n追加条件", task.description.replace("100株", "500株"),
    task.description.replace("同一", "別の"), task.description.replace("７回以上", "７回"),
    task.description.replace("８月末日", "９月末日"), task.description.replace("半額", "同額"),
    task.description.replace("10%", "20%"), task.description.replace(lines[0], '【種別："別の買物カード"】')];
  for (let line = 1; line < lines.length; line++) if (lines[line] !== "") changed.push(lines.filter((_, i) => i !== line).join("\n"));
  for (const description of changed) {
    expect(description !== task.description).toBe(true);
    expect(compileSimpleSummary({ ...task, description }) === null).toBe(true);
    expect(isSummaryNumbersGrounded(description, result.shortSummary, context)).toBe(false);
  }
  for (const slot of [2, 4]) for (const count of ["0", "-1", "1.5", "050", "5,00", "1e4", "9007199254740992"]) {
    const description = lines.map((line, i) => i === slot ? `利用限度額 ${count}万円` : line).join("\n");
    expect(compileSimpleSummary({ ...task, description }) === null).toBe(true);
  }
  for (const minShares of [[], [99], [100, 99], [100.5], [Number.MAX_SAFE_INTEGER + 1]])
    expect(isSummaryNumbersGrounded(task.description, result.shortSummary, { ...context, minShares })).toBe(false);
  for (const recordMonths of [[], [0], [9], [2, 9], [2.5]])
    expect(isSummaryNumbersGrounded(task.description, result.shortSummary, { ...context, recordMonths })).toBe(false);
  for (const recordMonth of [0, 9])
    expect(compileSimpleSummary({ ...task, recipients: [{ minShares: 100, recordMonth, recordDate: null }] })).toBeNull();
  expect(compileSimpleSummary({ ...task, recipients: [{ minShares: 100, recordMonth: 2, recordDate: "2026-02-28" }] })).toBeNull();
  for (const shortSummary of [result.shortSummary.replace("100株", "500株"), result.shortSummary.replace("7回以上", "7回"),
    result.shortSummary.replace("3年未満", "3年以下"), result.shortSummary.replace("半額", "同額"),
    result.shortSummary.replace("指定カード等", "カード"), result.shortSummary.replace("入場無料", "無料"), `${result.shortSummary}・500株`])
    expect(isSummaryNumbersGrounded(task.description, shortSummary, context)).toBe(false);
});
