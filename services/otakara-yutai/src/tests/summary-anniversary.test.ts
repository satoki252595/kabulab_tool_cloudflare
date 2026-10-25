import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import { isSummaryNumbersGrounded, SUMMARY_CONTRACT_VERSION } from "../../data-scripts/summary-contract.js";
import { planSummaryImport, type SummaryResult } from "../../data-scripts/summary-import.js";
import { selectSummaryTasks, type BenefitRow, type SummaryTask } from "../../data-scripts/summary-tasks.js";
import { carryKey, planCarry } from "../../data-scripts/yutai-full-import.js";

const context = { minShares: [100], recordMonths: [2] };
const description = "合成優待:創業50周年の記念券2枚、2027年2月末対象、5月下旬発送予定";
const shortSummary = "創業50周年券2枚(2027年2月末対象/5月下旬発送予定)";
const row = (source = description): BenefitRow => ({ id: 1, stockId: 1, stockCode: "9001", stockName: "合成テスト社",
  description: source, shortSummary: null, estimatedValue: null, estimateValueSource: null,
  minShares: 100, recordMonth: 2, recordDate: null, updatedAt: 1 });

it("周年は原文の同じ正準整数literalだけを認め、別単位・部分一致・不正数値へ転用しない", () => {
  expect(isSummaryNumbersGrounded(description, shortSummary, context)).toBe(true);
  expect(isSummaryNumbersGrounded(description.replace("50", "５０"), shortSummary, context)).toBe(true);
  expect(isSummaryNumbersGrounded(description.replace("50", "40"), shortSummary.replace("50", "40"), context)).toBe(true);
  for (const changed of ["40周年", "150周年", "A50周年", "50円", "50株", "50年"]) {
    expect(isSummaryNumbersGrounded(description, shortSummary.replace("50周年", changed), context)).toBe(false);
  }
  for (const malformed of ["周年", "150周年", "A50周年", "050周年", "0周年", "1.50周年", "1,050周年", "-50周年", "+50周年", "1万50周年"]) {
    expect(isSummaryNumbersGrounded(description.replace("50周年", malformed), shortSummary, context)).toBe(false);
    if (malformed !== "周年" && malformed !== "150周年")
      expect(isSummaryNumbersGrounded(malformed, malformed, context)).toBe(false);
  }
  expect(isSummaryNumbersGrounded("150周年", "150周年", context)).toBe(true);
  expect(isSummaryNumbersGrounded("9007199254740992周年", "9007199254740992周年", context)).toBe(false);
  for (const [before, after] of [["2枚", "3枚"], ["2027年", "2028年"], ["5月", "6月"]])
    expect(isSummaryNumbersGrounded(description, shortSummary.replace(before, after), context)).toBe(false);
});

it("共有取込・既存要約選定・月次carryが同じ周年資格を使い、旧.3結果は拒否する", () => {
  const current = row(), tasks = selectSummaryTasks([current]);
  expect(tasks[0].contractVersion).toBe(SUMMARY_CONTRACT_VERSION);
  const result = { taskId: tasks[0].taskId, contractVersion: SUMMARY_CONTRACT_VERSION, shortSummary, estimatedValue: null };
  const plan = planSummaryImport({ tasks, currentRows: [current], resultsText: JSON.stringify(result) });
  expect(plan.rejections).toEqual([]); expect(plan.updates).toHaveLength(1);
  expect(planSummaryImport({ tasks, currentRows: [current], resultsText: JSON.stringify({ ...result, contractVersion: "2026-10-25.3" }) })
    .rejections.map(r => r.reason)).toEqual(["contract_version"]);
  const after = { ...current, shortSummary };
  expect(selectSummaryTasks([after])).toEqual([]);
  const carriedRow = { ...after, code: after.stockCode }, key = carryKey(after.stockCode, description, 100, 2);
  expect(planCarry([carriedRow], new Map(), new Map()).carried.get(key)?.shortSummary).toBe(shortSummary);
  expect(planCarry([{ ...carriedRow, shortSummary: shortSummary.replace("50周年", "40周年") }], new Map(), new Map()).nulledKeys.has(key)).toBe(true);
});

const privatePath = join(ROOT, "tmp/yutai-anniversary-proof-v1/saved8.private.json");
it.skipIf(!existsSync(privatePath))("保存8群はfresh task選定で旧版以外の入力を保持し、周年数を省かず通常planを通す", () => {
  const bytes = readFileSync(privatePath), digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("b0997b11f652e3f5180ed75cd3fea5a6dddcc73234a7da4402aaef83a8e0ba13");
  const saved = JSON.parse(bytes.toString()) as { tasks: SummaryTask[]; rows: BenefitRow[]; candidates: SummaryResult[] };
  const tasks = selectSummaryTasks(saved.rows), withoutVersion = ({ contractVersion: _version, ...rest }: SummaryTask | SummaryResult) => rest;
  expect(tasks.length).toBe(8); expect(saved.rows.length).toBe(8);
  expect(digest(tasks.map(withoutVersion))).toBe(digest(saved.tasks.map(withoutVersion)));
  expect(saved.tasks.every(t => t.contractVersion === "2026-10-25.3")).toBe(true);
  const results = tasks.map(task => {
    const previous = saved.candidates.find(r => r.taskId === task.taskId);
    if (previous === undefined) throw new Error("anniversary_candidate_missing");
    return { ...previous, contractVersion: task.contractVersion };
  });
  expect(digest(results.map(withoutVersion))).toBe(digest(saved.candidates.map(withoutVersion)));
  const old = planSummaryImport({ tasks: saved.tasks, currentRows: saved.rows, resultsText: saved.candidates.map(r => JSON.stringify(r)).join("\n") });
  expect(old.rejections.map(r => r.reason)).toEqual(Array(8).fill("contract_version"));
  const plan = planSummaryImport({ tasks, currentRows: saved.rows, resultsText: results.map(r => JSON.stringify(r)).join("\n") });
  expect(plan.rejections.map(r => r.reason)).toEqual([]); expect(plan.updates.length).toBe(8);
  expect(plan.updates.every(u => u.estimatedValue === null && u.estimateValueSource === null)).toBe(true);
  for (const task of tasks) {
    const candidate = results.find(r => r.taskId === task.taskId)!;
    for (const changed of ["40周年", "50円", "50株", "50年"]) {
      const text = JSON.stringify({ ...candidate, shortSummary: candidate.shortSummary.replace("50周年", changed) });
      expect(planSummaryImport({ tasks: [task], currentRows: saved.rows, resultsText: text }).rejections.map(r => r.reason)).toEqual(["summary_ungrounded"]);
    }
  }
});
