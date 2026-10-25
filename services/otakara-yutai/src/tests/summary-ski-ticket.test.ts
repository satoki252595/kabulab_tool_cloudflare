import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import { clipSummary, publicSummary } from "../../app.js";
import { splitHeadedDescription } from "../../data-scripts/estimated-value-guard.js";
import { compileSkiTicketBundleLiteral } from "../../data-scripts/holding-structure.js";
import { checkSummary, isSummaryNumbersGrounded } from "../../data-scripts/summary-contract.js";
import { planSummaryImport } from "../../data-scripts/summary-import.js";
import { companyValue, compileSimpleSummary } from "../../data-scripts/summary-local.js";
import { selectSummaryTasks, type BenefitRow } from "../../data-scripts/summary-tasks.js";
import { benefitRowsOf, carryKey, planCarry } from "../../data-scripts/yutai-full-import.js";
import metadata from "./fixtures/ski-ticket-saved1.json";

const privatePath = join(ROOT, "tmp/yutai-ski-ticket-proof-v1/saved1.private.json");
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

it("未資格の9券種scopeを一般数値照合へ降格させない", () => {
  expect(compileSkiTicketBundleLiteral("")).toBeNull();
  expect(isSummaryNumbersGrounded("", "割引券:日本スキー場開発グループ", { minShares: [100], recordMonths: [7], recordDates: [null] })).toBe(false);
});

it.skipIf(!existsSync(privatePath))("保存1全文の全9券種・人数・季節・割引対象と単一recipientを通常経路で保持する", () => {
  const bytes = readFileSync(privatePath);
  expect(digest(bytes)).toBe(metadata.privateFixtureSha256);
  const saved = JSON.parse(bytes.toString()) as { rows: BenefitRow[] };
  const tasks = selectSummaryTasks(saved.rows), task = tasks[0];
  expect(tasks.length).toBe(1); expect(task.recipients).toEqual(metadata.recipients);
  expect(digest(task.description)).toBe(metadata.sourceSha256);
  const result = compileSimpleSummary(task);
  if (result === null) throw new Error("ski_ticket_literal_missing");
  expect(digest(result.shortSummary)).toBe(metadata.expectedSummarySha256);
  expect(result.shortSummary.length).toBe(227); expect(checkSummary(result.shortSummary)).toEqual([]);
  expect(companyValue(task)).toEqual({ value: null, reason: "no_source_yen_amount" }); expect(result.estimatedValue).toBeNull();
  const context = { minShares: [100], recordMonths: [7], recordDates: [null] };
  const lines = task.description.split("\n");
  const changes = ["", task.description + "\n追加条件", ...lines.map((_, index) => lines.filter((_, i) => i !== index).join("\n")),
    ...[...task.description.matchAll(/[0-9]+/g)].map(m => task.description.slice(0, m.index) + String(Number(m[0]) + 1) + task.description.slice(m.index + m[0].length)),
    ...["通年", "冬期", "1日料金", "朝食付きプラン", "時間貸", "アライアンスパートナーリゾート"].map(word => task.description.replace(word, "別条件"))];
  for (const description of changes) {
    expect(description !== task.description).toBe(true);
    expect(compileSimpleSummary({ ...task, description })).toBeNull();
    expect(isSummaryNumbersGrounded(description, result.shortSummary, context)).toBe(false);
  }
  for (const summary of [result.shortSummary + "追加", ...["通年", "冬期", "5名", "4名まで", "30%", "50%", "朝食付きプラン", "1日料金", "7枚"].map(word => result.shortSummary.replace(word, "別条件"))])
    expect(isSummaryNumbersGrounded(task.description, summary, context)).toBe(false);
  for (const recipient of [{ minShares: 200, recordMonth: 7, recordDate: null }, { minShares: 100, recordMonth: 1, recordDate: null }, { minShares: 100, recordMonth: 7, recordDate: "2026-07-31" }])
    expect(compileSimpleSummary({ ...task, recipients: [recipient] })).toBeNull();
  for (const altered of [{ ...task, rowCount: 2 }, { ...task, recipients: [] }, { ...task, recipients: [...task.recipients, ...task.recipients] }]) expect(compileSimpleSummary(altered)).toBeNull();
  for (const recordDates of [undefined, [], [null, null], ["2026-07-31"]]) expect(isSummaryNumbersGrounded(task.description, result.shortSummary, { ...context, recordDates })).toBe(false);
  const resultsText = JSON.stringify(result), plan = planSummaryImport({ tasks, currentRows: saved.rows, resultsText });
  expect(plan.rejections).toEqual([]); expect(plan.updates.length).toBe(1); expect(plan.valueChanges).toEqual({ toNull: 0, fromNull: 0, changed: 0 });
  const after = saved.rows.map(row => ({ ...row, ...plan.updates[0] }));
  expect(selectSummaryTasks(after)).toEqual([]); expect(publicSummary(after[0])).toBe(result.shortSummary);
  expect(clipSummary(result.shortSummary)).toBe(result.shortSummary.slice(0, 80) + "…");
  const source = splitHeadedDescription(task.description);
  if (source.heading === null) throw new Error("ski_ticket_heading_missing");
  const planned = benefitRowsOf({ code: task.stockCode, name: null, market: null, category: null, benefits: [{ minShares: 100, localRecordMonths: [7], heading: source.heading, description: source.body, notes: "" }] });
  expect(planned.rows[0].description).toBe(task.description);
  const key = carryKey(task.stockCode, source.body, 100, 7), groups = new Map([[task.stockCode, new Map([[source.body, { minShares: [100], recordMonths: [7] }]])]]);
  const carry = (headings: string[]) => planCarry([{ ...after[0], code: task.stockCode }], new Map([[key, headings]]), groups).carried.get(key);
  expect(carry([planned.rows[0].heading])).toEqual({ shortSummary: result.shortSummary, estimatedValue: null, estimateValueSource: null });
  for (const headings of [[], ["別見出し"], [source.heading, "別見出し"], ["別見出し", source.heading]]) expect(carry(headings)?.shortSummary).toBeNull();
  expect(planSummaryImport({ tasks, currentRows: saved.rows, resultsText: resultsText + "\n" + resultsText }).rejections.map(r => r.reason)).toEqual(["duplicate", "duplicate"]);
  expect(planSummaryImport({ tasks, currentRows: saved.rows, resultsText: JSON.stringify({ ...result, contractVersion: "2026-10-26.2" }) }).rejections.map(r => r.reason)).toEqual(["contract_version"]);
  const duplicateRows = [saved.rows[0], { ...saved.rows[0], id: saved.rows[0].id + 100000 }], duplicateTasks = selectSummaryTasks(duplicateRows);
  expect(duplicateTasks.map(compileSimpleSummary)).toEqual([null]);
  expect(planSummaryImport({ tasks: duplicateTasks, currentRows: duplicateRows, resultsText }).rejections.map(r => r.reason)).toEqual(["summary_ungrounded"]);
});
