import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import { checkSummary, isSummaryNumbersGrounded, missingSummaryConditions, SUMMARY_CONTRACT_VERSION, SUMMARY_MAX_CHARS } from "../../data-scripts/summary-contract.js";
import { companyValue, compileSimpleSummary } from "../../data-scripts/summary-local.js";
import { planSummaryImport, type SummaryResult } from "../../data-scripts/summary-import.js";
import { selectSummaryTasks, type BenefitRow, type SummaryTask } from "../../data-scripts/summary-tasks.js";
import saved from "./fixtures/premium-club-saved4.json";
import carrySaved from "./fixtures/premium-club-carry-saved5.json";
import holdingCarrySaved from "./fixtures/holding-point-carry-saved6.json";
import { compileHoldingPointCarryLiteral } from "../../data-scripts/holding-structure.js";
import { carryKey, planCarry } from "../../data-scripts/yutai-full-import.js";
import { splitHeadedDescription } from "../../data-scripts/estimated-value-guard.js";

const privatePath = join(ROOT, "tmp/yutai-premium-club-proof-v1/saved4.private.json");
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function carryWithCurrentHeadings(row: BenefitRow, rows: readonly BenefitRow[]) {
  const source = splitHeadedDescription(row.description);
  if (source.heading === null) throw new Error("carry_fixture_heading_missing");
  const key = carryKey(row.stockCode, source.body, row.minShares, row.recordMonth);
  const siblings = rows.filter(r => r.stockCode === row.stockCode && splitHeadedDescription(r.description).body === source.body);
  const groups = new Map([[row.stockCode, new Map([[source.body, {
    minShares: siblings.map(r => r.minShares), recordMonths: siblings.map(r => r.recordMonth),
  }]])]]);
  return planCarry([{ ...row, code: row.stockCode }], new Map([[key, [source.heading]]]), groups).carried.get(key);
}
function fixture() {
  const bytes = readFileSync(privatePath);
  expect(sha(bytes)).toBe(saved.provenance.privateFixtureSha256);
  return JSON.parse(bytes.toString()) as { tasks: SummaryTask[]; rows: BenefitRow[]; expectedResults: SummaryResult[] };
}

it.each(saved.groups)("数量が既知でも条件全文が未資格なら機械HOLD: $points", group => {
  // 合成の不完全入力。実原文はGitへ置かず、下の私有黒箱回帰で照合する。
  const task = { description: `【種別："プレミアム優待倶楽部ポイント"】\n${group.points}ポイント\n合成の未資格条件`,
    stockCode: "9001", stockName: "合成テスト社", contractVersion: SUMMARY_CONTRACT_VERSION, taskId: "0".repeat(16),
    reason: "missing", violations: [], rowCount: 1, recipients: group.recipients } satisfies SummaryTask;
  expect(compileSimpleSummary(task)).toBeNull();
});

it.skipIf(!existsSync(privatePath))("保存4原文を独立意味レビュー済み結果と照合し、通常planで金額nullを保つ", () => {
  const source = fixture();
  expect(source.tasks.length).toBe(4); expect(source.rows.length).toBe(4);
  const tasks = selectSummaryTasks(source.rows);
  const withoutVersion = ({ contractVersion: _version, ...value }: SummaryTask | SummaryResult) => value;
  expect(sha(JSON.stringify(tasks.map(withoutVersion)))).toBe(sha(JSON.stringify(source.tasks.map(withoutVersion))));
  const results = tasks.map(task => {
    const metadata = saved.groups.find(group => group.taskId === task.taskId);
    expect(metadata !== undefined).toBe(true);
    expect(sha(task.description)).toBe(metadata?.sourceSha256);
    expect(companyValue(task)).toEqual({ value: null, reason: "approx" });
    const result = compileSimpleSummary(task);
    expect(result !== null).toBe(true);
    // テスト失敗時にも原文・候補本文をstdoutへ出さず、SHA同士を比較する。
    const expected = source.expectedResults.find(value => value.taskId === task.taskId);
    if (result === null || expected === undefined) throw new Error("premium_expected_result_missing");
    expect(sha(JSON.stringify(withoutVersion(result)))).toBe(sha(JSON.stringify(withoutVersion(expected))));
    return result!;
  });
  const plan = planSummaryImport({ tasks, currentRows: source.rows, resultsText: results.map(result => JSON.stringify(result)).join("\n") });
  expect(plan.rejections.map(rejection => rejection.reason)).toEqual([]);
  expect(plan.updates.length).toBe(4);
  expect(plan.updates.every(update => update.estimatedValue === null && update.estimateValueSource === null)).toBe(true);
  const after = source.rows.map(row => {
    const update = plan.updates.find(value => value.ids.includes(row.id));
    if (update === undefined) throw new Error("premium_fixture_update_missing");
    return { ...row, shortSummary: update.shortSummary, estimatedValue: update.estimatedValue, estimateValueSource: update.estimateValueSource };
  });
  expect(selectSummaryTasks(after).length).toBe(0);
});

it.skipIf(!existsSync(privatePath))("条件段落の各行省略・値/種類変更・不正数量・長すぎる数量はHOLD", () => {
  const { tasks } = fixture();
  for (const task of tasks) {
    const lines = task.description.split("\n");
    for (let line = 2; line < lines.length; line++) {
      if (lines[line] === "") continue;
      const description = lines.filter((_, index) => index !== line).join("\n");
      expect(compileSimpleSummary({ ...task, description }) === null).toBe(true);
    }
    for (const description of [task.description + "\n追加条件", task.description.replace("12月", "11月"),
      task.description.replace("2回", "3回"), task.description.replace("≒", "="), task.description.replace("WILLsCoin", "別コイン"),
      task.description.replace(lines[0], "【種別：\"別のポイント\"】")]) {
      expect(description !== task.description).toBe(true);
      expect(compileSimpleSummary({ ...task, description }) === null).toBe(true);
    }
    for (const count of ["0", "-1", "1.5", "5,00", "9007199254740992", "12345678", "1e4"]) {
      const description = [lines[0], `${count}ポイント`, ...lines.slice(2)].join("\n");
      expect(compileSimpleSummary({ ...task, description }) === null).toBe(true);
    }
    // 数量だけ違う合成対照も原典の条件全文を保ち、円へ換算しない。
    const description = [lines[0], "9000ポイント", ...lines.slice(2)].join("\n");
    const control = compileSimpleSummary({ ...task, description });
    expect(control?.shortSummary.startsWith("9000ポイント(")).toBe(true);
    expect(control?.estimatedValue).toBeNull();
  }
});

const carryPrivatePath = join(ROOT, "tmp/yutai-premium-club-carry-proof-v1/saved5.private.json");
function carryFixture() {
  const bytes = readFileSync(carryPrivatePath);
  expect(sha(bytes)).toBe(carrySaved.provenance.privateFixtureSha256);
  return JSON.parse(bytes.toString()) as { tasks: SummaryTask[]; rows: BenefitRow[]; expectedResults: SummaryResult[] };
}

it("未資格の繰越scopeを一般株数照合へ降格させず、現在tierの株数guardは維持する", () => {
  const description = '【種別："プレミアム優待倶楽部ポイント"】\n750ポイント(年間1500ポイント)\n合成の未資格条件:1000株以上・2回以上';
  const context = { minShares: [1000], recordMonths: [2] };
  expect(isSummaryNumbersGrounded(description, "750ポイント(繰越:1000株以上・2回以上)", context)).toBe(false);
  expect(isSummaryNumbersGrounded("合成商品券1000円", "1000株:1000円", context)).toBe(true);
  expect(isSummaryNumbersGrounded("合成商品券1000円", "1000株:1000円", { ...context, minShares: [4000] })).toBe(false);
});

it.skipIf(!existsSync(carryPrivatePath))("保存5群10行の繰越両条件を各回ポイントと保持し、compiler/取込/selector/carryで同じliteralを使う", () => {
  const source = carryFixture(), tasks = selectSummaryTasks(source.rows);
  const withoutVersion = ({ contractVersion: _version, ...value }: SummaryTask | SummaryResult) => value;
  expect(tasks.length).toBe(5); expect(source.rows.length).toBe(10);
  expect(sha(JSON.stringify(tasks.map(withoutVersion)))).toBe(sha(JSON.stringify(source.tasks.map(withoutVersion))));
  expect(tasks.every(t => t.contractVersion === SUMMARY_CONTRACT_VERSION)).toBe(true);
  const results = tasks.map(task => {
    const metadata = carrySaved.groups.find(group => group.taskId === task.taskId);
    expect(sha(task.description)).toBe(metadata?.sourceSha256);
    expect(companyValue(task)).toEqual({ value: null, reason: "approx" });
    const result = compileSimpleSummary(task);
    if (result === null) throw new Error("carry_literal_missing");
    expect(sha(result.shortSummary)).toBe(metadata?.expectedSummarySha256);
    expect(result.shortSummary.length <= SUMMARY_MAX_CHARS && result.estimatedValue === null).toBe(true);
    expect(isSummaryNumbersGrounded(task.description, result.shortSummary, { minShares: task.recipients.map(r => r.minShares), recordMonths: task.recipients.map(r => r.recordMonth) })).toBe(true);
    return result;
  });
  const plan = planSummaryImport({ tasks, currentRows: source.rows, resultsText: results.map(r => JSON.stringify(r)).join("\n") });
  expect(plan.rejections.map(r => r.reason)).toEqual([]); expect(plan.updates.length).toBe(5);
  expect(plan.updates.flatMap(u => u.ids).length).toBe(10);
  const after = source.rows.map(row => {
    const update = plan.updates.find(u => u.ids.includes(row.id));
    if (update === undefined) throw new Error("carry_update_missing");
    expect(update.estimatedValue === null && update.estimateValueSource === null).toBe(true);
    return { ...row, shortSummary: update.shortSummary, estimatedValue: null, estimateValueSource: null };
  });
  expect(selectSummaryTasks(after).length).toBe(0);
  for (const row of after) {
    const carried = carryWithCurrentHeadings(row, after);
    expect(carried !== undefined).toBe(true); expect(sha(carried!.shortSummary!)).toBe(sha(row.shortSummary));
  }
  const old = results.map(r => JSON.stringify({ ...r, contractVersion: "2026-10-25.5" })).join("\n");
  expect(planSummaryImport({ tasks, currentRows: source.rows, resultsText: old }).rejections.map(r => r.reason)).toEqual(Array(5).fill("contract_version"));
});

it.skipIf(!existsSync(carryPrivatePath))("繰越全文・各回/年額・対象・canonicalの改変を拒否し、円換算や現在tierへの転用をしない", () => {
  const source = carryFixture(), tasks = selectSummaryTasks(source.rows), task = tasks[0];
  const result = compileSimpleSummary(task);
  if (result === null) throw new Error("carry_literal_missing");
  const context = { minShares: task.recipients.map(r => r.minShares), recordMonths: task.recipients.map(r => r.recordMonth) };
  const lines = task.description.split("\n");
  const changedSources = [task.description + "\n追加条件", task.description.replace("1,000株", "2,000株"),
    task.description.replace("２回以上", "３回以上"), task.description.replace("同一", "別の"),
    task.description.replace("かつ", "または"), task.description.replace("WILLsCoin", "別コイン"),
    task.description.replace("≒", "="), task.description.replace(lines[0], '【種別："別ポイント"】')];
  for (let line = 2; line < lines.length; line++) if (lines[line] !== "") changedSources.push(lines.filter((_, i) => i !== line).join("\n"));
  for (const description of changedSources) {
    expect(description !== task.description).toBe(true);
    expect(compileSimpleSummary({ ...task, description }) === null).toBe(true);
    expect(isSummaryNumbersGrounded(description, result.shortSummary, context)).toBe(false);
  }
  for (const first of ["0ポイント(年間0ポイント)", "0750ポイント(年間1500ポイント)", "7,50ポイント(年間1500ポイント)",
    "-750ポイント(年間1500ポイント)", "750.5ポイント(年間1501ポイント)", "750ポイント(年間1501ポイント)",
    "9007199254740992ポイント(年間18014398509481984ポイント)"])
    expect(compileSimpleSummary({ ...task, description: [lines[0], first, ...lines.slice(2)].join("\n") }) === null).toBe(true);
  for (const minShares of [[], [999], [4000, 999], [1000.5], [Number.MAX_SAFE_INTEGER + 1]])
    expect(isSummaryNumbersGrounded(task.description, result.shortSummary, { ...context, minShares })).toBe(false);
  for (const recordMonths of [[], [0], [13], [2.5]])
    expect(isSummaryNumbersGrounded(task.description, result.shortSummary, { ...context, recordMonths })).toBe(false);
  for (const shortSummary of [result.shortSummary.replace("1000株以上", "4000株以上"), result.shortSummary.replace("2回以上", "2回"),
    result.shortSummary.replace("WILLsCoin", "別コイン"), `${result.shortSummary}・4000株`, result.shortSummary.replace("ポイント", "円")])
    expect(isSummaryNumbersGrounded(task.description, shortSummary, context)).toBe(false);
  const plan = planSummaryImport({ tasks: [task], currentRows: source.rows, resultsText: JSON.stringify({ ...result, estimatedValue: carrySaved.groups[0].pointsPerGrant }) });
  expect(plan.updates.length).toBe(0); expect(plan.rejections.length).toBe(1);
});

const holdingCarryPrivatePath = join(ROOT, "tmp/yutai-holding-point-carry-proof-v1/saved6.private.json");
function holdingCarryFixture() {
  const bytes = readFileSync(holdingCarryPrivatePath);
  expect(sha(bytes)).toBe(holdingCarrySaved.provenance.privateFixtureSha256);
  return JSON.parse(bytes.toString()) as { tasks: SummaryTask[]; rows: BenefitRow[]; expectedResults: SummaryResult[] };
}

it("未資格の保有/繰越条件namespaceを通常株数へ降格させず、120字でも数値・率・条件guardを維持する", () => {
  const description = '【種別："プレミアム優待倶楽部ポイント"】\n【1年未満保有】\n100ポイント\n【1年以上保有】\n200ポイント\n合成の未資格条件';
  const context = { minShares: [600], recordMonths: [12] };
  expect(compileHoldingPointCarryLiteral(description)).toBeNull();
  expect(isSummaryNumbersGrounded(description, "100ポイント(繰越条件:600株)", context)).toBe(false);
  expect(isSummaryNumbersGrounded("合成商品券1000円", "600株:1000円", context)).toBe(true);
  expect(isSummaryNumbersGrounded("合成商品券1000円", "600株:1000円", { ...context, minShares: [900] })).toBe(false);
  expect(checkSummary("あ".repeat(120))).toEqual([]);
  expect(checkSummary("あ".repeat(121)).map(v => v.rule)).toEqual(["too_long"]);
  expect(missingSummaryConditions("1年以上保有で商品を選択", "商品")).toEqual(["choice_condition_missing", "holding_condition_missing"]);
});

it.skipIf(!existsSync(holdingCarryPrivatePath))("保存6群6行の両数量と継続/繰越条件を保持し、通常plan/selector/carryを通す", () => {
  const source = holdingCarryFixture(), tasks = selectSummaryTasks(source.rows);
  expect(tasks.length).toBe(6); expect(source.rows.length).toBe(6);
  const results = tasks.map(task => {
    const metadata = holdingCarrySaved.groups.find(g => g.taskId === task.taskId);
    expect(sha(task.description)).toBe(metadata?.sourceSha256);
    expect(companyValue(task)).toEqual({ value: null, reason: "choice" });
    const result = compileSimpleSummary(task);
    if (result === null) throw new Error("holding_point_carry_missing");
    expect(sha(result.shortSummary)).toBe(metadata?.expectedSummarySha256);
    expect(result.shortSummary.length > 60 && result.shortSummary.length <= SUMMARY_MAX_CHARS).toBe(true);
    expect(result.estimatedValue).toBeNull();
    expect(missingSummaryConditions(task.description, result.shortSummary)).toEqual([]);
    return result;
  });
  const plan = planSummaryImport({ tasks, currentRows: source.rows, resultsText: results.map(r => JSON.stringify(r)).join("\n") });
  expect(plan.rejections.map(r => r.reason)).toEqual([]); expect(plan.updates.length).toBe(6);
  expect(plan.updates.flatMap(u => u.ids).length).toBe(6);
  const after = source.rows.map(row => {
    const update = plan.updates.find(u => u.ids.includes(row.id));
    if (update === undefined) throw new Error("holding_point_carry_update_missing");
    expect(update.estimatedValue === null && update.estimateValueSource === null).toBe(true);
    return { ...row, shortSummary: update.shortSummary, estimatedValue: null, estimateValueSource: null };
  });
  expect(selectSummaryTasks(after).length).toBe(0);
  for (const row of after) {
    const carried = carryWithCurrentHeadings(row, after);
    expect(carried !== undefined).toBe(true); expect(sha(carried!.shortSummary!)).toBe(sha(row.shortSummary));
  }
  const old = results.map(r => JSON.stringify({ ...r, contractVersion: "2026-10-25.6" })).join("\n");
  expect(planSummaryImport({ tasks, currentRows: source.rows, resultsText: old }).rejections.map(r => r.reason)).toEqual(Array(6).fill("contract_version"));
});

it.skipIf(!existsSync(holdingCarryPrivatePath))("両数量・定義全文・定型句・600株/12月の対象矛盾は成功化しない", () => {
  const { rows } = holdingCarryFixture(), task = selectSummaryTasks(rows)[0], result = compileSimpleSummary(task);
  if (result === null) throw new Error("holding_point_carry_missing");
  const context = { minShares: task.recipients.map(r => r.minShares), recordMonths: [12] }, lines = task.description.split("\n");
  const changed = [task.description + "\n追加条件", task.description.replace("600株", "900株"),
    task.description.replace("同一", "別の"), task.description.replace("１回", "２回"), task.description.replace("12月", "11月"),
    task.description.replace("3月上旬", "3月下旬"), task.description.replace("WILLsCoin", "別コイン"),
    task.description.replace("1年以上保有", "2年以上保有"), task.description.replace(lines[0], '【種別："別ポイント"】')];
  for (let line = 1; line < lines.length; line++) if (lines[line] !== "") changed.push(lines.filter((_, i) => i !== line).join("\n"));
  for (const description of changed) {
    expect(description !== task.description).toBe(true);
    expect(compileSimpleSummary({ ...task, description }) === null).toBe(true);
    expect(isSummaryNumbersGrounded(description, result.shortSummary, context)).toBe(false);
  }
  for (const count of ["0", "-1", "1.5", "05000", "5,00", "01,000", "1e4", "9007199254740992"]) {
    for (const slot of [2, 4]) {
      const description = lines.map((l, i) => i === slot ? `${count}ポイント` : l).join("\n");
      expect(compileSimpleSummary({ ...task, description }) === null).toBe(true);
    }
  }
  for (const minShares of [[], [599], [600, 599], [600.5], [Number.MAX_SAFE_INTEGER + 1]])
    expect(isSummaryNumbersGrounded(task.description, result.shortSummary, { ...context, minShares })).toBe(false);
  for (const recordMonths of [[], [0], [11], [12, 11], [12.5]])
    expect(isSummaryNumbersGrounded(task.description, result.shortSummary, { ...context, recordMonths })).toBe(false);
  for (const shortSummary of [result.shortSummary.replace("600株", "900株"), result.shortSummary.replace("1年未満", "1年以下"),
    result.shortSummary.replace("WILLsCoin", "別コイン"), result.shortSummary.replace("翌3月", "3月"),
    result.shortSummary.replace("ポイント", "円"), result.shortSummary.replace("継続保有・記載", "継続保有"), `${result.shortSummary}・600株`])
    expect(isSummaryNumbersGrounded(task.description, shortSummary, context)).toBe(false);
  const plan = planSummaryImport({ tasks: [task], currentRows: rows, resultsText: JSON.stringify({ ...result, estimatedValue: 10000 }) });
  expect(plan.updates.length).toBe(0); expect(plan.rejections.length).toBe(1);
});
