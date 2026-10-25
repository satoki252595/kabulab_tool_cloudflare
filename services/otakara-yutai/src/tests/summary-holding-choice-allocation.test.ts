/** 保存実全文の正例と、その原文・受取条件を故意に改変した限定負例。原文はGitへ置かない。 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import { splitHeadedDescription, trustedCompanyYieldValue } from "../../data-scripts/estimated-value-guard.js";
import { compileEqualAllocationHoldingLiteral, compileHoldingGiftChoiceLiteral } from "../../data-scripts/holding-structure.js";
import { checkSummary, isSummaryNumbersGrounded, missingSummaryConditions } from "../../data-scripts/summary-contract.js";
import { planSummaryImport } from "../../data-scripts/summary-import.js";
import { companyValue, compileSimpleSummary, runLocalSummary } from "../../data-scripts/summary-local.js";
import { selectSummaryTasks, type BenefitRow } from "../../data-scripts/summary-tasks.js";
import { benefitRowsOf, carryKey, planCarry } from "../../data-scripts/yutai-full-import.js";
import metadata from "./fixtures/holding-choice-allocation-saved2.json";

const privatePath = join(ROOT, metadata.privateFixtureDir, "saved6.private.json");
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const savedRows = () => {
  const bytes = readFileSync(privatePath);
  expect(digest(bytes)).toBe(metadata.privateFixtureSha256);
  return (JSON.parse(bytes.toString()) as { groups: { rows: BenefitRow[] }[] }).groups.flatMap(group => group.rows);
};

it("未知の将来条件・均等割scopeを一般数値照合へ降格しない", () => {
  expect(compileHoldingGiftChoiceLiteral("")).toBeNull();
  expect(compileEqualAllocationHoldingLiteral("")).toBeNull();
  for (const summary of ["2026年10月末の優待:", "QUOカードPay:基本枠"])
    expect(isSummaryNumbersGrounded("", summary, { minShares: [], recordMonths: [], recordDates: [] })).toBe(false);
});

it.skipIf(!existsSync(privatePath))("保存実2全文を通常生成/取込/selector/carryで保持し、既存1000株行・9842全行を変えない", async () => {
  const rows = savedRows(); expect(rows.length).toBe(9);
  const tasks = selectSummaryTasks(rows); expect(tasks.length).toBe(4);
  const results = tasks.flatMap(task => { const result = compileSimpleSummary(task); return result === null ? [] : [result]; });
  expect(results.length).toBe(2);
  for (const result of results) {
    const task = tasks.find(task => task.taskId === result.taskId)!;
    const expected = metadata.groups.find(group => group.taskId === result.taskId)!;
    expect(digest(task.description)).toBe(expected.sourceSha256); expect(task.recipients).toEqual(expected.recipients);
    expect(companyValue(task)).toEqual({ value: null, reason: "ambiguous_condition_tiers" });
    expect(digest(result.shortSummary)).toBe(expected.summarySha256); expect(result.shortSummary.length).toBe(expected.summaryCharacters);
    expect(checkSummary(result.shortSummary)).toEqual([]); expect(missingSummaryConditions(task.description, result.shortSummary)).toEqual([]);
    expect(result.estimatedValue).toBeNull();
  }
  const resultsText = results.map(result => JSON.stringify(result)).join("\n");
  const plan = planSummaryImport({ tasks, currentRows: rows, resultsText });
  expect(plan.rejections).toEqual([]); expect(plan.updates.length).toBe(2);
  expect(plan.updates.flatMap(update => update.ids).sort()).toEqual([57455, 61316]);
  expect(plan.valueChanges).toEqual({ toNull: 0, fromNull: 0, changed: 0 });
  const after = rows.map(row => {
    const update = plan.updates.find(update => update.ids.includes(row.id));
    return update === undefined ? row : { ...row, shortSummary: update.shortSummary, estimatedValue: update.estimatedValue, estimateValueSource: update.estimateValueSource };
  });
  expect(after.filter(row => ![57455, 61316].includes(row.id))).toEqual(rows.filter(row => ![57455, 61316].includes(row.id)));
  expect(selectSummaryTasks(after).map(task => task.stockCode)).toEqual(["9842", "9842"]);
  const repeat = planSummaryImport({ tasks, currentRows: after, resultsText });
  expect(repeat.updates).toEqual([]); expect(repeat.skippedEquivalent).toBe(2);
  for (const row of after.filter(row => [57455, 61316].includes(row.id))) {
    expect(trustedCompanyYieldValue(row, { minShares: [row.minShares], recordMonths: [row.recordMonth] })).toBeNull();
    const source = splitHeadedDescription(row.description);
    if (source.heading === null) throw new Error("holding_choice_heading_missing");
    const planned = benefitRowsOf({ code: row.stockCode, name: null, market: null, category: null,
      benefits: [{ minShares: row.minShares, localRecordMonths: [row.recordMonth], heading: source.heading, description: source.body, notes: "" }] });
    expect(planned.heldBenefits).toBe(0); expect(planned.rows.length).toBe(1); expect(planned.rows[0].description).toBe(row.description);
    const key = carryKey(row.stockCode, source.body, row.minShares, row.recordMonth);
    const groups = new Map([[row.stockCode, new Map([[source.body, { minShares: [row.minShares], recordMonths: [row.recordMonth] }]])]]);
    const carry = (heading: string) => planCarry([{ ...row, code: row.stockCode }], new Map([[key, [heading]]]), groups);
    expect(carry(source.heading).carried.get(key)).toEqual({ shortSummary: row.shortSummary, estimatedValue: null, estimateValueSource: null });
    expect(carry("別見出し").nulledKeys.has(key)).toBe(true);
  }
  const stateDir = mkdtempSync(join(ROOT, "tmp/holding-choice-test-"));
  let current = structuredClone(rows); const phases: string[] = [];
  try {
    const report = await runLocalSummary({ limit: 60, stateDir }, {
      loadRows: async () => structuredClone(current),
      generate: async () => { throw new Error("model_must_not_run"); },
      archive: async (_bytes, _clock, phase) => { phases.push(phase); },
      apply: async (_fresh, offlinePlan) => { current = current.map(row => {
        const update = offlinePlan.updates.find(update => update.ids.includes(row.id));
        return update === undefined ? row : { ...row, shortSummary: update.shortSummary, estimatedValue: update.estimatedValue, estimateValueSource: update.estimateValueSource, updatedAt: row.updatedAt + 1 };
      }); },
    });
    expect(phases).toEqual(["pre", "post"]);
    expect(report).toMatchObject({ selected: 4, accepted: 2, rejected: 2, held: 2, pendingBefore: 4, pendingAfter: 2, modelCalls: 0, modelResidents: 0, deterministic: 2, toNull: 0 });
    expect(current.filter(row => ![57455, 61316].includes(row.id))).toEqual(rows.filter(row => ![57455, 61316].includes(row.id)));
  } finally { rmSync(stateDir, { recursive: true }); }
});

it.skipIf(!existsSync(privatePath))("実原文の条件・数値・年月日、phase/recipient/issuerの変化を生成・共有取込で拒否する", () => {
  const rows = savedRows(); const tasks = selectSummaryTasks(rows);
  for (const expected of metadata.groups) {
    const task = tasks.find(task => task.taskId === expected.taskId)!;
    const result = compileSimpleSummary(task); if (result === null) throw new Error("holding_choice_missing");
    const context = { minShares: task.recipients.map(r => r.minShares), recordMonths: task.recipients.map(r => r.recordMonth), recordDates: task.recipients.map(r => r.recordDate) };
    const alterations = ["前置き\n" + task.description, task.description + "\n追加条件",
      ...task.description.split("\n").map((_, index, lines) => lines.filter((_, i) => i !== index).join("\n")),
      ...[...task.description.matchAll(/[0-9０-９]+/g)].map(m => task.description.slice(0, m.index) + String(Number(m[0].normalize("NFKC")) + 1) + task.description.slice(m.index + m[0].length)),
      ...["上限", "基本", "初回", "記念", "長期", "均等", "加算", "対象株主", "最低株数", "同一株主番号", "連続", "複数選択", "寄付"].filter(word => task.description.includes(word)).map(word => task.description.replace(word, "別条件"))];
    for (const description of alterations) {
      expect(description).not.toBe(task.description); expect(compileSimpleSummary({ ...task, description })).toBeNull();
      expect(isSummaryNumbersGrounded(description, result.shortSummary, context)).toBe(false);
    }
    for (const summary of [result.shortSummary + "追加条件", ...result.shortSummary.split("。").map((_, index, parts) => parts.filter((_, i) => i !== index).join("。")),
      ...[...result.shortSummary.matchAll(/[0-9]+/g)].map(m => result.shortSummary.slice(0, m.index) + String(Number(m[0]) + 1) + result.shortSummary.slice(m.index + m[0].length)),
      ...["上限なし", "加算額の2倍", "最低株数以上", "枠内複数可", "寄付"].filter(word => result.shortSummary.includes(word)).map(word => result.shortSummary.replace(word, "別条件"))]) {
      if (summary === result.shortSummary) continue;
      expect(isSummaryNumbersGrounded(task.description, summary, context)).toBe(false);
      expect(planSummaryImport({ tasks, currentRows: rows, resultsText: JSON.stringify({ ...result, shortSummary: summary }) }).updates).toEqual([]);
    }
    for (const recipient of [{ ...task.recipients[0], minShares: task.recipients[0].minShares + 1 }, { ...task.recipients[0], recordMonth: 9 }, { ...task.recipients[0], recordDate: "2027-01-31" }]) {
      expect(compileSimpleSummary({ ...task, recipients: [recipient] })).toBeNull();
      const currentRows = rows.map(row => expected.ids.includes(row.id) ? { ...row, ...recipient } : row);
      const alteredTasks = selectSummaryTasks(currentRows);
      expect(planSummaryImport({ tasks: alteredTasks, currentRows, resultsText: JSON.stringify(result) }).updates).toEqual([]);
    }
    for (const altered of [{ ...task, stockCode: "9842" }, { ...task, rowCount: 2 }, { ...task, recipients: [] }, { ...task, recipients: [...task.recipients, ...task.recipients] }]) expect(compileSimpleSummary(altered)).toBeNull();
    for (const recordDates of [undefined, [], [null, null], ["2027-01-31"]]) expect(isSummaryNumbersGrounded(task.description, result.shortSummary, { ...context, recordDates })).toBe(false);
    for (const bad of [{ ...result, estimatedValue: 5000 }, { ...result, shortSummary: "" }, { ...result, contractVersion: "2026-10-26.6" }])
      expect(planSummaryImport({ tasks, currentRows: rows, resultsText: JSON.stringify(bad) }).updates).toEqual([]);
    const duplicates = rows.flatMap(row => expected.ids.includes(row.id) ? [row, { ...row, id: row.id + 100000 }] : [row]);
    expect(compileSimpleSummary(selectSummaryTasks(duplicates).find(t => t.taskId === task.taskId)!)).toBeNull();
    expect(planSummaryImport({ tasks: selectSummaryTasks(duplicates), currentRows: duplicates, resultsText: JSON.stringify(result) }).updates).toEqual([]);
  }
});
