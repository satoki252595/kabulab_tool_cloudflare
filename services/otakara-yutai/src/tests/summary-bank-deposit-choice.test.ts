import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import { splitHeadedDescription, trustedCompanyYieldValue } from "../../data-scripts/estimated-value-guard.js";
import { compileBankDepositChoiceLiteral } from "../../data-scripts/holding-structure.js";
import { checkSummary, isSummaryNumbersGrounded, missingSummaryConditions } from "../../data-scripts/summary-contract.js";
import { planSummaryImport } from "../../data-scripts/summary-import.js";
import { companyValue, compileSimpleSummary } from "../../data-scripts/summary-local.js";
import { selectSummaryTasks, type BenefitRow } from "../../data-scripts/summary-tasks.js";
import { benefitRowsOf, carryKey, planCarry } from "../../data-scripts/yutai-full-import.js";
import metadata from "./fixtures/bank-deposit-choice-saved3.json";

const privatePath = join(ROOT, "tmp/yutai-bank-deposit-8551-proof-v1/saved3.private.json");
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

it("未資格の預金除外scopeを一般数値照合へ降格せず、ステップを回へ正規化しない", () => {
  expect(compileBankDepositChoiceLiteral("")).toBeNull();
  expect(isSummaryNumbersGrounded("", "ひまわりポイントサービス3ステップ", { minShares: [300], recordMonths: [3], recordDates: [null] })).toBe(false);
  expect(isSummaryNumbersGrounded("3ステップ", "3ステップ", { minShares: [300], recordMonths: [3] })).toBe(false);
});

it.skipIf(!existsSync(privatePath))("保存3全文の選択・掲載額・預金上限・除外・取扱日・名簿条件を単一recipientで保持する", () => {
  const bytes = readFileSync(privatePath);
  expect(digest(bytes)).toBe(metadata.privateFixtureSha256);
  const saved = JSON.parse(bytes.toString()) as { rows: BenefitRow[] };
  const tasks = selectSummaryTasks(saved.rows);
  expect(tasks.length).toBe(3); expect(saved.rows.length).toBe(3);
  const results = tasks.map(task => {
    const expected = metadata.groups.find(group => group.taskId === task.taskId);
    expect(expected).toBeDefined(); expect(digest(task.description)).toBe(expected!.sourceSha256);
    expect(task.rowCount).toBe(1); expect(task.recipients).toEqual(expected!.recipients);
    expect(companyValue(task)).toEqual({ value: null, reason: "choice" });
    const result = compileSimpleSummary(task);
    if (result === null) throw new Error("bank_deposit_choice_missing");
    expect(digest(result.shortSummary)).toBe(expected!.summarySha256);
    expect(result.shortSummary.length).toBe(expected!.summaryCharacters); expect(result.estimatedValue).toBeNull();
    expect(checkSummary(result.shortSummary)).toEqual([]); expect(missingSummaryConditions(task.description, result.shortSummary)).toEqual([]);
    const context = { minShares: [task.recipients[0].minShares], recordMonths: [3], recordDates: [null] };
    expect(isSummaryNumbersGrounded(task.description, result.shortSummary, context)).toBe(true);
    const lines = task.description.split("\n");
    const changes = ["", "前置き\n" + task.description, task.description + "\n追加条件",
      ...lines.map((_, index) => lines.filter((_, i) => i !== index).join("\n")),
      ...[...task.description.matchAll(/[0-9]+/g)].map(m => task.description.slice(0, m.index) + String(Number(m[0]) + 1) + task.description.slice(m.index + m[0].length)),
      ...["証書式", "から1年間", "3ステップ以上", "対象外", "寄付", "同一株主番号", "連続3回以上"].map(word => task.description.replace(word, "別条件"))];
    for (const description of changes) {
      expect(description !== task.description).toBe(true);
      expect(compileSimpleSummary({ ...task, description })).toBeNull();
      expect(isSummaryNumbersGrounded(description, result.shortSummary, context)).toBe(false);
    }
    for (const summary of [result.shortSummary + "追加", ...["または", "寄付", "証書式", "0.2%", "万円まで", "2026年7月1日", "から1年間", "3ステップ以上", "対象外", "同一株主番号", "3回以上", "9月30日"].map(word => result.shortSummary.replace(word, "別条件"))])
      expect(isSummaryNumbersGrounded(task.description, summary, context)).toBe(false);
    for (const recipient of [{ ...task.recipients[0], minShares: task.recipients[0].minShares + 1 }, { ...task.recipients[0], recordMonth: 9 }, { ...task.recipients[0], recordDate: "2026-03-31" }])
      expect(compileSimpleSummary({ ...task, recipients: [recipient] })).toBeNull();
    for (const altered of [{ ...task, rowCount: 2 }, { ...task, stockCode: "8370" }, { ...task, recipients: [] }, { ...task, recipients: [...task.recipients, ...task.recipients] }]) expect(compileSimpleSummary(altered)).toBeNull();
    for (const recordDates of [undefined, [], [null, null], ["2026-03-31"]]) expect(isSummaryNumbersGrounded(task.description, result.shortSummary, { ...context, recordDates })).toBe(false);
    return result;
  });
  const resultsText = results.map(result => JSON.stringify(result)).join("\n");
  const plan = planSummaryImport({ tasks, currentRows: saved.rows, resultsText });
  expect(plan.rejections).toEqual([]); expect(plan.updates.length).toBe(3); expect(plan.valueChanges).toEqual({ toNull: 0, fromNull: 0, changed: 0 });
  const after = saved.rows.map(row => ({ ...row, ...plan.updates.find(update => update.ids.includes(row.id))! }));
  expect(selectSummaryTasks(after)).toEqual([]);
  for (const row of after) {
    expect(row.estimatedValue).toBeNull(); expect(row.estimateValueSource).toBeNull();
    expect(trustedCompanyYieldValue(row, { minShares: [row.minShares], recordMonths: [3] })).toBeNull();
    const source = splitHeadedDescription(row.description);
    if (source.heading === null) throw new Error("bank_deposit_heading_missing");
    const planned = benefitRowsOf({ code: row.stockCode, name: null, market: null, category: null, benefits: [{ minShares: row.minShares, localRecordMonths: [3], heading: source.heading, description: source.body, notes: "" }] });
    expect(planned.rows[0].description).toBe(row.description);
    const key = carryKey(row.stockCode, source.body, row.minShares, 3), groups = new Map([[row.stockCode, new Map([[source.body, { minShares: [row.minShares], recordMonths: [3] }]])]]);
    const carry = (headings: string[]) => planCarry([{ ...row, code: row.stockCode }], new Map([[key, headings]]), groups).carried.get(key);
    expect(carry([planned.rows[0].heading])).toEqual({ shortSummary: row.shortSummary, estimatedValue: null, estimateValueSource: null });
    for (const headings of [[], ["別見出し"], [source.heading, "別見出し"]]) expect(carry(headings)?.shortSummary).toBeNull();
  }
  for (const result of results) {
    expect(planSummaryImport({ tasks, currentRows: saved.rows, resultsText: JSON.stringify({ ...result, estimatedValue: 3000 }) }).updates.length).toBe(0);
    expect(planSummaryImport({ tasks, currentRows: saved.rows, resultsText: JSON.stringify({ ...result, contractVersion: "2026-10-26.3" }) }).rejections.map(r => r.reason)).toEqual(["contract_version"]);
  }
  const duplicates = saved.rows.flatMap(row => [row, { ...row, id: row.id + 100000 }]), duplicateTasks = selectSummaryTasks(duplicates);
  expect(duplicateTasks.map(compileSimpleSummary)).toEqual([null, null, null]);
  expect(planSummaryImport({ tasks: duplicateTasks, currentRows: duplicates, resultsText }).updates.length).toBe(0);
});
