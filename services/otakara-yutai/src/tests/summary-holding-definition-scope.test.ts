import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import { headedDescription, splitHeadedDescription } from "../../data-scripts/estimated-value-guard.js";
import { isSummaryNumbersGrounded, SUMMARY_CONTRACT_VERSION } from "../../data-scripts/summary-contract.js";
import { planSummaryImport, type SummaryResult } from "../../data-scripts/summary-import.js";
import { selectSummaryTasks, type BenefitRow, type SummaryTask } from "../../data-scripts/summary-tasks.js";
import { carryKey, planCarry } from "../../data-scripts/yutai-full-import.js";
import { extractBenefitRegistryStructure } from "../../data-scripts/registry-structure.js";

const context = { minShares: [300], recordMonths: [12] };
const privatePath = join(ROOT, "tmp/yutai-holding-definition-scope-proof-v1/saved2932.private.json");
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const bytes = readFileSync(privatePath);
  expect(digest(bytes)).toBe("a7676d5ec0692275aa51c999e516b1bec89cb5ca08eefc6b4af38009ec2c834f");
  return JSON.parse(bytes.toString()) as { task: SummaryTask; rows: BenefitRow[]; oldCandidate: SummaryResult; proposedShortSummary: string };
}

it("明示scopeの未資格・不完全な原文は、current100が数値一致しても一般guardへ降格しない", () => {
  // 未資格の合成文。実原文の定義文・候補は公開fixtureに置かない。
  const source = headedDescription("合成文法試験", "商品3000円相当、1年以上保有、6月末・12月末同一株主番号1000株以上3回連続記録");
  const scope = "継続条件:1年以上・6月末/12月末同一株主番号100株以上3回連続記録";
  for (const summary of [scope, `商品3000円相当(${scope})`, scope.replace(":", "="), `${scope}、${scope}`]) {
    expect(isSummaryNumbersGrounded(source, summary, { minShares: [100], recordMonths: [12] })).toBe(false);
  }
  expect(isSummaryNumbersGrounded("合成商品3000円相当", "300株:合成商品3000円相当", context)).toBe(true);
  expect(isSummaryNumbersGrounded("合成商品3000円相当", "100株:合成商品3000円相当", context)).toBe(false);
});

it.skipIf(!existsSync(privatePath))("保存定義句を現tierとは別scopeに束縛し、取込・selector・carryへ同じ資格を使う", () => {
  const saved = fixture(), tasks = selectSummaryTasks(saved.rows), summary = saved.proposedShortSummary;
  expect(tasks.length).toBe(1); expect(tasks[0].contractVersion).toBe("2026-10-25.5");
  const withoutVersion = ({ contractVersion: _version, ...task }: SummaryTask) => task;
  expect(digest(JSON.stringify(tasks.map(withoutVersion)))).toBe(digest(JSON.stringify([withoutVersion(saved.task)])));
  expect(isSummaryNumbersGrounded(saved.task.description, summary, context)).toBe(true);
  expect(isSummaryNumbersGrounded(saved.task.description, saved.oldCandidate.shortSummary, context)).toBe(false);
  expect(isSummaryNumbersGrounded(saved.task.description, "100株", context)).toBe(false);
  expect(isSummaryNumbersGrounded(saved.task.description, summary.replace("、翌年", "、300株、翌年"), context)).toBe(true);
  expect(isSummaryNumbersGrounded(saved.task.description, summary.replace("、翌年", "、100株、翌年"), context)).toBe(false);
  const result = { taskId: tasks[0].taskId, contractVersion: SUMMARY_CONTRACT_VERSION, shortSummary: summary, estimatedValue: null };
  const plan = planSummaryImport({ tasks, currentRows: saved.rows, resultsText: JSON.stringify(result) });
  expect(plan.rejections.map(r => r.reason)).toEqual([]); expect(plan.updates.length).toBe(1);
  expect(plan.updates[0].estimatedValue).toBeNull(); expect(summary.length).toBe(58);
  expect(planSummaryImport({ tasks, currentRows: saved.rows, resultsText: JSON.stringify(saved.oldCandidate) }).rejections.map(r => r.reason)).toEqual(["contract_version"]);
  expect(planSummaryImport({ tasks: [saved.task], currentRows: saved.rows, resultsText: JSON.stringify(result) }).rejections.map(r => r.reason)).toEqual(["contract_version"]);
  const after = { ...saved.rows[0], shortSummary: summary };
  expect(selectSummaryTasks([after]).length).toBe(0);
  const key = carryKey(after.stockCode, splitHeadedDescription(after.description).body, after.minShares, after.recordMonth);
  const carried = planCarry([{ ...after, code: after.stockCode }], new Map(), new Map()).carried.get(key);
  expect(carried !== undefined).toBe(true); expect(digest(carried!.shortSummary!)).toBe(digest(summary));
  expect(extractBenefitRegistryStructure(saved.task.description)).toBeNull();
});

it.skipIf(!existsSync(privatePath))("定義文全体の時点・期間・同株主番号・株数・回数・比較語・例外の改変を拒否する", () => {
  const { task, proposedShortSummary: summary } = fixture(), source = task.description;
  for (const changed of [
    source.replace("100株以上", "1000株以上"), source.replace("100株以上", "0100株以上"),
    source.replace("100株以上", "1,000株以上"), source.replace("100株以上", "-100株以上"),
    source.replace("100株以上", "9007199254740992株以上"), source.replace("100株以上", "100株以下"),
    source.replaceAll("1年以上", "2年以上").replace("１年以上", "２年以上"),
    source.replace("【1年以上保有】", "【2年以上保有】"), source.replace("６月末", "５月末"),
    source.replace("12月末", "13月末"), source.replace("12月末", "６月末"),
    source.replace("３回連続", "４回連続"), source.replace("３回連続", "３回以上連続"),
    source.replace("同一株主番号", "同一名義"), source.replace("同一株主番号", "同一の株主番号"),
    source.replace("■継続保有期間について", "■その他"), source + "\n■継続保有期間について\n例外",
    source.replace("■継続保有期間について\n", "■継続保有期間について\n例外あり\n"),
    source.replace("\n■贈呈時期", "\nただし別条件あり\n■贈呈時期"),
    source.replace("【1年以上保有】", "【1年以上保有】\n【2年以上保有】"),
    source.replace("【1年以上保有】\n", "") + "\n【1年以上保有】",
  ]) {
    expect(changed !== source).toBe(true);
    expect(isSummaryNumbersGrounded(changed, summary, context)).toBe(false);
    expect(isSummaryNumbersGrounded(changed, summary, { minShares: [100], recordMonths: [12] })).toBe(false);
  }
  for (const [before, after] of [["1年以上", "2年以上"], ["1年以上", "1年未満"], ["6月末", "5月末"],
    ["12月末", "12月"], ["同一株主番号", "同一名義"], ["同一株主番号", "同番号"],
    ["100株以上", "1000株以上"], ["100株以上", "100株以下"], ["3回連続", "3回以上連続"],
    ["3回連続", "4回連続"], ["継続条件:", "継続条件="], ["継続条件:", "現在継続条件:"]]) {
    expect(isSummaryNumbersGrounded(source, summary.replace(before, after), context)).toBe(false);
  }
  expect(isSummaryNumbersGrounded(source, summary.replace("、翌年", "済み、翌年"), context)).toBe(false);
});

it.skipIf(!existsSync(privatePath))("空context・定義閾値未満・非定義月をHOLDし、同じ定義内の正準contextだけを使う", () => {
  const { task, proposedShortSummary: summary } = fixture();
  for (const minShares of [[], [50], [100, 50], [0], [100.5], [Number.NaN], [Number.MAX_SAFE_INTEGER + 1]])
    expect(isSummaryNumbersGrounded(task.description, summary, { ...context, minShares })).toBe(false);
  for (const recordMonths of [[], [0], [3], [6, 12, 3], [12.5]])
    expect(isSummaryNumbersGrounded(task.description, summary, { ...context, recordMonths })).toBe(false);
  expect(isSummaryNumbersGrounded(task.description, summary, { minShares: [100], recordMonths: [6, 12] })).toBe(true);
  expect(isSummaryNumbersGrounded(task.description, summary, { minShares: [300, 500], recordMonths: [12] })).toBe(true);
});
