import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import { splitHeadedDescription, trustedCompanyYieldValue } from "../../data-scripts/estimated-value-guard.js";
import { compileHotelHoldingLiteral } from "../../data-scripts/holding-structure.js";
import { checkSummary, isSummaryNumbersGrounded, missingSummaryConditions } from "../../data-scripts/summary-contract.js";
import { planSummaryImport } from "../../data-scripts/summary-import.js";
import { companyValue, compileSimpleSummary, runLocalSummary } from "../../data-scripts/summary-local.js";
import { selectSummaryTasks, type BenefitRow } from "../../data-scripts/summary-tasks.js";
import { benefitRowsOf, carryKey, planCarry } from "../../data-scripts/yutai-full-import.js";
import metadata from "./fixtures/hotel-holding-saved2.json";

const privatePath = join(ROOT, "tmp/yutai-hotel-holding-proof-v1/saved2.private.json");
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

it("未資格のホテル全文・継続scopeを現在100株で代替しない", () => {
  expect(compileHotelHoldingLiteral("")).toBeNull();
  expect(isSummaryNumbersGrounded("", "継続条件:毎年", { minShares: [100], recordMonths: [8], recordDates: [null] })).toBe(false);
});

it.skipIf(!existsSync(privatePath))("保存2全文の全期間・加算・倍率・歴史保有を通常生成/取込/selector/carryで保持し未知の変更を拒否する", async () => {
  const bytes = readFileSync(privatePath);
  expect(digest(bytes)).toBe(metadata.privateFixtureSha256);
  const saved = JSON.parse(bytes.toString()) as { rows: BenefitRow[]; expectedResults: { minShares: number; shortSummary: string; estimatedValue: null }[] };
  const tasks = selectSummaryTasks(saved.rows);
  expect(tasks.length).toBe(2); expect(saved.rows.length).toBe(2);
  const results = tasks.map(task => {
    const expected = metadata.groups.find(group => group.sourceSha256 === digest(task.description));
    expect(expected).toBeDefined(); expect(task.rowCount).toBe(1); expect(task.recipients).toEqual(expected!.recipients);
    expect(companyValue(task).value).toBeNull();
    const result = compileSimpleSummary(task);
    if (result === null) throw new Error("hotel_holding_literal_missing");
    expect(result.shortSummary).toBe(saved.expectedResults.find(row => row.minShares === task.recipients[0].minShares)!.shortSummary);
    expect(digest(result.shortSummary)).toBe(expected!.expectedSummarySha256);
    expect(result.shortSummary.length).toBe(expected!.summaryCharacters); expect(result.estimatedValue).toBeNull();
    expect(checkSummary(result.shortSummary)).toEqual([]); expect(missingSummaryConditions(task.description, result.shortSummary)).toEqual([]);
    const context = { minShares: task.recipients.map(r => r.minShares), recordMonths: task.recipients.map(r => r.recordMonth), recordDates: task.recipients.map(r => r.recordDate) };
    expect(isSummaryNumbersGrounded(task.description, result.shortSummary, context)).toBe(true);
    const lines = task.description.split("\n");
    for (const description of [task.description + "\n追加条件", ...lines.map((_, index) => lines.filter((_, i) => i !== index).join("\n")),
      task.description.replace("100株以上", "200株以上"), task.description.replace("2026", "2027"),
      task.description.replaceAll("1年以上", "2年以上"), task.description.replace(/([0-9,]+)円相当分/u, "$10円相当分")]) {
      expect(description !== task.description).toBe(true);
      expect(compileSimpleSummary({ ...task, description })).toBeNull();
      expect(isSummaryNumbersGrounded(description, result.shortSummary, context)).toBe(false);
    }
    // 数値の追加・削除・改変、scopeの省略も一般guardへ降格させない。
    for (const shortSummary of [result.shortSummary + "・100株", result.shortSummary.replace("100株以上", "200株以上"),
      result.shortSummary.replace("1年以上", "1年未満"), result.shortSummary.replace("2026", "2027"),
      result.shortSummary.replace("継続条件:", ""), result.shortSummary.replace("初年度比", "当年比"),
      result.shortSummary.replace("1.1倍", "1.2倍"), result.shortSummary.replace("100株毎", "200株毎"),
      result.shortSummary.replace("44万", "45万")]) {
      if (shortSummary !== result.shortSummary) expect(isSummaryNumbersGrounded(task.description, shortSummary, context)).toBe(false);
    }
    for (const recipient of [{ ...task.recipients[0], minShares: 100 }, { ...task.recipients[0], minShares: task.recipients[0].minShares + 1 },
      { ...task.recipients[0], recordMonth: 9 }, { ...task.recipients[0], recordDate: "2026-08-31" }])
      expect(compileSimpleSummary({ ...task, recipients: [recipient] })).toBeNull();
    expect(compileSimpleSummary({ ...task, rowCount: 2 })).toBeNull();
    expect(compileSimpleSummary({ ...task, recipients: [...task.recipients, ...task.recipients], rowCount: 2 })).toBeNull();
    for (const minShares of [[], [100], [task.recipients[0].minShares, task.recipients[0].minShares]])
      expect(isSummaryNumbersGrounded(task.description, result.shortSummary, { ...context, minShares })).toBe(false);
    for (const recordDates of [undefined, [], [null, null], ["2026-08-31"]])
      expect(isSummaryNumbersGrounded(task.description, result.shortSummary, { ...context, recordDates })).toBe(false);
    return result;
  });
  const resultsText = results.map(result => JSON.stringify(result)).join("\n");
  const plan = planSummaryImport({ tasks, currentRows: saved.rows, resultsText });
  expect(plan.rejections).toEqual([]); expect(plan.updates.length).toBe(2); expect(plan.valueChanges).toEqual({ toNull: 0, fromNull: 0, changed: 0 });
  const after = saved.rows.map(row => ({ ...row, ...plan.updates.find(update => update.ids.includes(row.id))! }));
  expect(selectSummaryTasks(after)).toEqual([]);
  for (const row of after) {
    expect(row.estimatedValue).toBeNull(); expect(row.estimateValueSource).toBeNull();
    expect(trustedCompanyYieldValue(row, { minShares: [row.minShares], recordMonths: [row.recordMonth] })).toBeNull();
    const source = splitHeadedDescription(row.description);
    if (source.heading === null) throw new Error("hotel_holding_heading_missing");
    const planned = benefitRowsOf({ code: row.stockCode, name: null, market: null, category: null,
      benefits: [{ minShares: row.minShares, localRecordMonths: [row.recordMonth], heading: source.heading, description: source.body, notes: "" }] });
    expect(planned.heldBenefits).toBe(0); expect(planned.rows.length).toBe(1); expect(planned.rows[0].description).toBe(row.description);
    const key = carryKey(row.stockCode, source.body, row.minShares, row.recordMonth);
    const context = { minShares: [row.minShares], recordMonths: [row.recordMonth] };
    const groups = new Map([[row.stockCode, new Map([[source.body, context]])]]);
    const carry = (headings: string[]) => planCarry([{ ...row, code: row.stockCode }], new Map([[key, headings]]), groups).carried.get(key);
    expect(carry([planned.rows[0].heading])?.shortSummary).toBe(row.shortSummary);
    expect(carry([planned.rows[0].heading])?.estimatedValue).toBeNull();
    for (const headings of [[], ["別見出し"], [source.heading, "別見出し"], ["別見出し", source.heading]]) expect(carry(headings)?.shortSummary).toBeNull();
  }
  for (const result of results) {
    const invalid = planSummaryImport({ tasks, currentRows: saved.rows, resultsText: JSON.stringify({ ...result, estimatedValue: 20000 }) });
    expect(invalid.updates).toEqual([]);
    expect(planSummaryImport({ tasks, currentRows: saved.rows, resultsText: JSON.stringify({ ...result, contractVersion: "2026-10-26.1" }) }).rejections.map(row => row.reason)).toEqual(["contract_version"]);
  }
  for (const currentRows of [saved.rows.map(row => ({ ...row, minShares: row.minShares + 1 })), saved.rows.map(row => ({ ...row, description: row.description + "\n追加条件" }))])
    expect(planSummaryImport({ tasks, currentRows, resultsText }).rejections.map(row => row.reason)).toEqual(["stale", "stale"]);
  const duplicateRows = saved.rows.flatMap(row => [row, { ...row, id: row.id + 100000 }]);
  const duplicates = selectSummaryTasks(duplicateRows);
  expect(duplicates.map(compileSimpleSummary)).toEqual([null, null]);
  expect(planSummaryImport({ tasks: duplicates, currentRows: duplicateRows, resultsText }).rejections.map(row => row.reason)).toEqual(["summary_ungrounded", "summary_ungrounded"]);

  const stateDir = mkdtempSync(join(ROOT, "tmp/hotel-holding-test-"));
  let current = structuredClone(saved.rows);
  const phases: string[] = [];
  try {
    const report = await runLocalSummary({ limit: 60, stateDir }, {
      loadRows: async () => structuredClone(current),
      generate: async () => { throw new Error("model_must_not_run"); },
      archive: async (_bytes, _clock, phase) => { phases.push(phase); },
      apply: async (_rows, offlinePlan) => { current = current.map(row => {
        const update = offlinePlan.updates.find(value => value.ids.includes(row.id));
        if (update === undefined) throw new Error("expected_hotel_update_missing");
        return { ...row, shortSummary: update.shortSummary, estimatedValue: update.estimatedValue, estimateValueSource: update.estimateValueSource, updatedAt: row.updatedAt + 1 };
      }); },
    });
    expect(phases).toEqual(["pre", "post"]);
    expect(report).toMatchObject({ selected: 2, accepted: 2, rejected: 0, held: 0, pendingBefore: 2, pendingAfter: 0, modelCalls: 0, modelResidents: 0, deterministic: 2, toNull: 0 });
    expect(selectSummaryTasks(current)).toEqual([]);
  } finally { rmSync(stateDir, { recursive: true }); }
});
