import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import { splitHeadedDescription } from "../../data-scripts/estimated-value-guard.js";
import { compileMealTicketSplitLiteral } from "../../data-scripts/holding-structure.js";
import { checkSummary, isSummaryNumbersGrounded, missingSummaryConditions } from "../../data-scripts/summary-contract.js";
import { planSummaryImport } from "../../data-scripts/summary-import.js";
import { companyValue, compileSimpleSummary } from "../../data-scripts/summary-local.js";
import { selectSummaryTasks, type BenefitRow } from "../../data-scripts/summary-tasks.js";
import { benefitRowsOf, carryKey, planCarry } from "../../data-scripts/yutai-full-import.js";
import metadata from "./fixtures/meal-ticket-split-saved3.json";

const privatePath = join(ROOT, metadata.privateFixtureDir, "saved3.private.json");
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

it("未知の分割scopeを一般数値照合へ降格しない", () => {
  expect(compileMealTicketSplitLiteral("")).toBeNull();
  expect(isSummaryNumbersGrounded("", "分割前表示", { minShares: [], recordMonths: [], recordDates: [] })).toBe(false);
});

it.skipIf(!existsSync(privatePath))("保存実3全文/6行の分割前株数・比率・予定日・全掲載額・歴史100株と両贈呈月を保持する", () => {
  const bytes = readFileSync(privatePath);
  expect(digest(bytes)).toBe(metadata.privateFixtureSha256);
  const saved = JSON.parse(bytes.toString()) as { rows: BenefitRow[] };
  const tasks = selectSummaryTasks(saved.rows);
  expect(tasks.length).toBe(3); expect(saved.rows.length).toBe(6);
  const results = tasks.map(task => {
    const expected = metadata.groups.find(group => group.taskId === task.taskId);
    expect(expected).toBeDefined(); expect(digest(task.description)).toBe(expected!.sourceSha256);
    expect(task.rowCount).toBe(2); expect(task.recipients).toEqual(expected!.recipients);
    expect(companyValue(task)).toEqual({ value: null, reason: "multi_month_amounts" });
    const result = compileSimpleSummary(task);
    if (result === null) throw new Error("meal_ticket_split_missing");
    expect(digest(result.shortSummary)).toBe(expected!.summarySha256);
    expect(result.shortSummary.length).toBe(expected!.summaryCharacters); expect(result.estimatedValue).toBeNull();
    expect(checkSummary(result.shortSummary)).toEqual([]); expect(missingSummaryConditions(task.description, result.shortSummary)).toEqual([]);
    const context = { minShares: task.recipients.map(r => r.minShares), recordMonths: task.recipients.map(r => r.recordMonth), recordDates: task.recipients.map(r => r.recordDate) };
    expect(isSummaryNumbersGrounded(task.description, result.shortSummary, context)).toBe(true);
    // 保存実原文を故意に改変した負例。分割後の株数・枚数・資格日を生成しない。
    for (const description of ["", "前置き\n" + task.description, task.description + "\n追加条件",
      ...task.description.split("\n").map((_, index, lines) => lines.filter((_, i) => i !== index).join("\n")),
      ...[...task.description.matchAll(/[0-9０-９]+/g)].map(m => task.description.slice(0, m.index) + String(Number(m[0].normalize("NFKC")) + 1) + task.description.slice(m.index + m[0].length)),
      ...["分割前", "予定", "同一株主番号", "連続", "居酒屋"].map(word => task.description.replace(word, "別条件")),
    ]) {
      expect(description !== task.description).toBe(true);
      expect(compileSimpleSummary({ ...task, description })).toBeNull();
      expect(isSummaryNumbersGrounded(description, result.shortSummary, context)).toBe(false);
    }
    for (const summary of [result.shortSummary + "追加", ...["1:2", "2026年12月1日", "分割前", "100株以上", "3回以上", "同一株主番号", "1枚5,000円", "翌年2月", "居酒屋"].map(word => result.shortSummary.replace(word, "別条件"))])
      expect(isSummaryNumbersGrounded(task.description, summary, context)).toBe(false);
    for (const recipient of [{ ...task.recipients[0], minShares: task.recipients[0].minShares + 1 }, { ...task.recipients[0], recordMonth: 3 }, { ...task.recipients[0], recordDate: "2026-05-31" }])
      expect(compileSimpleSummary({ ...task, recipients: [recipient, task.recipients[1]] })).toBeNull();
    for (const altered of [{ ...task, rowCount: 1 }, { ...task, stockCode: "3045" }, { ...task, recipients: [] }, { ...task, recipients: [task.recipients[0]] }, { ...task, recipients: [task.recipients[0], task.recipients[0]] }]) expect(compileSimpleSummary(altered)).toBeNull();
    for (const recordDates of [undefined, [], [null], [null, "2026-11-30"]]) expect(isSummaryNumbersGrounded(task.description, result.shortSummary, { ...context, recordDates })).toBe(false);
    return result;
  });
  const resultsText = results.map(result => JSON.stringify(result)).join("\n");
  const plan = planSummaryImport({ tasks, currentRows: saved.rows, resultsText });
  expect(plan.rejections).toEqual([]); expect(plan.updates.length).toBe(3);
  expect(plan.updates.flatMap(update => update.ids).sort()).toEqual(metadata.groups.flatMap(group => group.ids).sort());
  expect(plan.valueChanges).toEqual({ toNull: 0, fromNull: 0, changed: 0 });
  const after = saved.rows.map(row => ({ ...row, shortSummary: plan.updates.find(update => update.ids.includes(row.id))!.shortSummary }));
  expect(selectSummaryTasks(after)).toEqual([]);
  expect(after.every(row => row.estimatedValue === null && row.estimateValueSource === null)).toBe(true);
  for (const task of tasks) {
    const source = splitHeadedDescription(task.description);
    if (source.heading === null) throw new Error("meal_ticket_heading_missing");
    const own = after.filter(row => row.description === task.description);
    const planned = benefitRowsOf({ code: task.stockCode, name: null, market: null, category: null, benefits: [{ minShares: own[0].minShares, localRecordMonths: [5, 11], heading: source.heading, description: source.body, notes: "" }] });
    expect(planned.rows.length).toBe(2); expect(planned.rows.every(row => row.description === task.description)).toBe(true);
    const groups = new Map([[task.stockCode, new Map([[source.body, { minShares: own.map(r => r.minShares), recordMonths: own.map(r => r.recordMonth) }]])]]);
    const headings = new Map(own.map(row => [carryKey(row.stockCode, source.body, row.minShares, row.recordMonth), [source.heading!]]));
    const carry = planCarry(own.map(row => ({ ...row, code: row.stockCode })), headings, groups);
    expect(carry.carried.size).toBe(2); expect(carry.nulledKeys.size).toBe(0);
    for (const value of carry.carried.values()) expect(value).toEqual({ shortSummary: own[0].shortSummary, estimatedValue: null, estimateValueSource: null });
    const wrongHeadings = new Map([...headings].map(([key]) => [key, ["別見出し"]]));
    expect(planCarry(own.map(row => ({ ...row, code: row.stockCode })), wrongHeadings, groups).nulledKeys.size).toBe(2);
  }
  for (const result of results) {
    expect(planSummaryImport({ tasks, currentRows: saved.rows, resultsText: JSON.stringify({ ...result, estimatedValue: 5000 }) }).updates.length).toBe(0);
    expect(planSummaryImport({ tasks, currentRows: saved.rows, resultsText: JSON.stringify({ ...result, contractVersion: "2026-10-26.4" }) }).rejections.map(r => r.reason)).toEqual(["contract_version"]);
  }
  const duplicate = saved.rows.flatMap(row => [row, { ...row, id: row.id + 100000 }]);
  expect(selectSummaryTasks(duplicate).map(compileSimpleSummary)).toEqual([null, null, null]);
});
