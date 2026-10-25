/** 原本はprivate保存。実14群の通常バッチと、条件の改変・別tier転用を確認する。 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import { splitHeadedDescription, trustedCompanyYieldValue } from "../../data-scripts/estimated-value-guard.js";
import { compileRegistryTierLiteral } from "../../data-scripts/holding-structure.js";
import { checkSummary, isSummaryNumbersGrounded, missingSummaryConditions } from "../../data-scripts/summary-contract.js";
import { planSummaryImport } from "../../data-scripts/summary-import.js";
import { companyValue, compileSimpleSummary, runLocalSummary } from "../../data-scripts/summary-local.js";
import { selectSummaryTasks, type BenefitRow } from "../../data-scripts/summary-tasks.js";
import { benefitRowsOf, carryKey, planCarry } from "../../data-scripts/yutai-full-import.js";
import metadata from "./fixtures/registry-tiers-saved14.json";

const privatePath = join(ROOT, metadata.privateFixtureDir, metadata.privateFixtureFile);
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function savedRows(): BenefitRow[] {
  const bytes = readFileSync(privatePath);
  expect(digest(bytes)).toBe(metadata.privateFixtureSha256);
  return (JSON.parse(bytes.toString()) as { rows: BenefitRow[] }).rows;
}

it("未知の移転条件・参考画像・観劇枠を一般の株数や金額へ降格しない", () => {
  expect(compileRegistryTierLiteral("")).toBeNull();
  for (const summary of ["カタログ1点選択:3,000円相当", "OSK先着観劇券:30枚", "ASNOVA×monotomoiギフト:500株", "三越伊勢丹カード:10%引"])
    expect(isSummaryNumbersGrounded("", summary, { minShares: [500], recordMonths: [3], recordDates: [null] })).toBe(false);
});

it.skipIf(!existsSync(privatePath))("保存14群24行を通常生成/取込/再取込/selector/carryで閉じ、モデルを起動しない", async () => {
  const rows = savedRows(), tasks = selectSummaryTasks(rows);
  expect(rows.length).toBe(metadata.sourceRows); expect(tasks.length).toBe(metadata.groups.length);
  const results = tasks.map(task => {
    const result = compileSimpleSummary(task), expected = metadata.groups.find(group => group.taskId === task.taskId)!;
    if (result === null) throw new Error("registry_tier_compile_missing");
    expect(digest(task.description)).toBe(expected.sourceSha256); expect(task.recipients).toEqual(expected.recipients);
    expect(companyValue(task)).toEqual({ value: expected.listedYen, reason: expected.valueReason });
    expect(digest(result.shortSummary)).toBe(expected.summarySha256); expect(result.shortSummary.length).toBeLessThanOrEqual(256);
    expect(checkSummary(result.shortSummary)).toEqual([]); expect(missingSummaryConditions(task.description, result.shortSummary)).toEqual([]);
    expect(result.estimatedValue).toBe(expected.listedYen);
    return result;
  });
  const resultsText = results.map(result => JSON.stringify(result)).join("\n");
  const plan = planSummaryImport({ tasks, currentRows: rows, resultsText });
  expect(plan.rejections).toEqual([]); expect(plan.updates.length).toBe(metadata.groups.length);
  const ids = metadata.groups.flatMap(group => group.ids).sort((a, b) => a - b);
  expect(plan.updates.flatMap(update => update.ids).sort((a, b) => a - b)).toEqual(ids);
  expect(plan.valueChanges).toEqual({ toNull: 0, fromNull: 2, changed: 0 });
  const after = rows.map(row => {
    const update = plan.updates.find(update => update.ids.includes(row.id));
    return update === undefined ? row : { ...row, shortSummary: update.shortSummary, estimatedValue: update.estimatedValue, estimateValueSource: update.estimateValueSource };
  });
  expect(after.filter(row => !ids.includes(row.id))).toEqual(rows.filter(row => !ids.includes(row.id)));
  expect(selectSummaryTasks(after)).toEqual([]);
  expect(planSummaryImport({ tasks, currentRows: after, resultsText })).toMatchObject({ updates: [], skippedEquivalent: metadata.groups.length });
  for (const row of after.filter(row => ids.includes(row.id))) {
    const source = splitHeadedDescription(row.description);
    if (source.heading === null) throw new Error("registry_tier_heading_missing");
    const planned = benefitRowsOf({ code: row.stockCode, name: null, market: null, category: null,
      benefits: [{ minShares: row.minShares, localRecordMonths: [row.recordMonth], heading: source.heading, description: source.body, notes: "" }] });
    expect(planned.heldBenefits).toBe(0); expect(planned.rows[0].description).toBe(row.description);
    const key = carryKey(row.stockCode, source.body, row.minShares, row.recordMonth);
    const groups = new Map([[row.stockCode, new Map([[source.body, { minShares: [row.minShares], recordMonths: [row.recordMonth] }]])]]);
    const carry = (heading: string) => planCarry([{ ...row, code: row.stockCode }], new Map([[key, [heading]]]), groups);
    expect(carry(source.heading).carried.get(key)).toEqual({ shortSummary: row.shortSummary, estimatedValue: row.estimatedValue, estimateValueSource: row.estimateValueSource });
    expect(carry("別見出し").nulledKeys.has(key)).toBe(true);
    expect(trustedCompanyYieldValue(row, { minShares: [row.minShares], recordMonths: [row.recordMonth] })).toBe(row.estimatedValue);
  }
  const stateDir = mkdtempSync(join(ROOT, "tmp/registry-tier-test-")); let current = structuredClone(rows);
  try {
    const report = await runLocalSummary({ limit: 60, stateDir }, {
      loadRows: async () => structuredClone(current), generate: async () => { throw new Error("model_must_not_run"); }, archive: async () => {},
      apply: async (_fresh, imported) => { current = current.map(row => {
        const update = imported.updates.find(update => update.ids.includes(row.id));
        return update === undefined ? row : { ...row, shortSummary: update.shortSummary, estimatedValue: update.estimatedValue, estimateValueSource: update.estimateValueSource, updatedAt: row.updatedAt + 1 };
      }); },
    });
    expect(report).toMatchObject({ selected: metadata.groups.length, accepted: metadata.groups.length, rejected: 0, pendingAfter: 0, modelCalls: 0, deterministic: metadata.groups.length });
    expect(current.filter(row => !ids.includes(row.id))).toEqual(rows.filter(row => !ids.includes(row.id)));
  } finally { rmSync(stateDir, { recursive: true }); }
});

it.skipIf(!existsSync(privatePath))("実原文/数値/条件/recipient/旧版の改変と重複行を共有取込で拒否する", () => {
  const rows = savedRows(), tasks = selectSummaryTasks(rows);
  for (const task of tasks) {
    const result = compileSimpleSummary(task); if (result === null) throw new Error("registry_tier_compile_missing");
    const context = { minShares: task.recipients.map(r => r.minShares), recordMonths: task.recipients.map(r => r.recordMonth), recordDates: task.recipients.map(r => r.recordDate) };
    const alteredSources = [task.description + "\n追加条件", ...task.description.split("\n").map((_, index, lines) => lines.filter((_, i) => i !== index).join("\n")),
      ...[...task.description.matchAll(/[0-9０-９]+/g)].map(m => task.description.slice(0, m.index) + String(Number(m[0].normalize("NFKC")) + 1) + task.description.slice(m.index + m[0].length)),
      ...["同一", "連続", "移転", "予定", "参考", "以上", "先着順", "顔認証", "寄付", "保有開始"].filter(word => task.description.includes(word)).map(word => task.description.replace(word, "別条件"))];
    for (const description of alteredSources) {
      expect(compileRegistryTierLiteral(description)).toBeNull();
      expect(isSummaryNumbersGrounded(description, result.shortSummary, context)).toBe(false);
    }
    for (const summary of [result.shortSummary + "追加条件", ...result.shortSummary.split("。").map((_, index, parts) => parts.filter((_, i) => i !== index).join("。")),
      ...[...result.shortSummary.matchAll(/[0-9]+/g)].map(m => result.shortSummary.slice(0, m.index) + String(Number(m[0]) + 1) + result.shortSummary.slice(m.index + m[0].length))]) {
      if (summary === result.shortSummary) continue;
      expect(planSummaryImport({ tasks, currentRows: rows, resultsText: JSON.stringify({ ...result, shortSummary: summary }) }).updates).toEqual([]);
    }
    for (const recipients of [[], [...task.recipients, ...task.recipients], task.recipients.map(r => ({ ...r, minShares: r.minShares + 1 })),
      task.recipients.map(r => ({ ...r, recordMonth: 1 })), task.recipients.map(r => ({ ...r, recordDate: "2027-03-31" }))])
      expect(compileSimpleSummary({ ...task, recipients })).toBeNull();
    expect(compileSimpleSummary({ ...task, stockCode: "9842" })).toBeNull();
    for (const bad of [{ ...result, contractVersion: "2026-10-26.7" }, { ...result, estimatedValue: 12345 }])
      expect(planSummaryImport({ tasks, currentRows: rows, resultsText: JSON.stringify(bad) }).updates).toEqual([]);
    const duplicates = rows.flatMap(row => row.stockCode === task.stockCode && row.description === task.description ? [row, { ...row, id: row.id + 100000 }] : [row]);
    expect(planSummaryImport({ tasks: selectSummaryTasks(duplicates), currentRows: duplicates, resultsText: JSON.stringify(result) }).updates).toEqual([]);
  }
});
