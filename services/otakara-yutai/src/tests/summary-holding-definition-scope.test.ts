import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import { headedDescription, splitHeadedDescription, trustedCompanyYieldValue } from "../../data-scripts/estimated-value-guard.js";
import { checkSummary, isSummaryNumbersGrounded, missingSummaryConditions, SUMMARY_CONTRACT_VERSION } from "../../data-scripts/summary-contract.js";
import { planSummaryImport, type SummaryResult } from "../../data-scripts/summary-import.js";
import { selectSummaryTasks, type BenefitRow, type SummaryTask } from "../../data-scripts/summary-tasks.js";
import { benefitRowsOf, carryKey, planCarry } from "../../data-scripts/yutai-full-import.js";
import { extractBenefitRegistryStructure } from "../../data-scripts/registry-structure.js";
import { companyValue, compileSimpleSummary } from "../../data-scripts/summary-local.js";
import { compileAnnualGiftHistoryLiteral, compileBankHoldingHistoryLiteral } from "../../data-scripts/holding-structure.js";
import annualGiftSaved from "./fixtures/annual-gift-history-saved2.json";

const context = { minShares: [300], recordMonths: [12] };
const privatePath = join(ROOT, "tmp/yutai-holding-definition-scope-proof-v1/saved2932.private.json");
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const bankHistoryPrivatePath = join(ROOT, "tmp/yutai-bank-history-8370-proof-v1/saved1.private.json");
it("未資格の銀行履歴scopeを一般株数へ降格せず、通常の現在tier照合を維持する", () => {
  const source = headedDescription("合成文法試験", "商品5000円相当、1年以上保有、1000株以上3回以上記録");
  expect(compileBankHoldingHistoryLiteral(source)).toBeNull();
  expect(isSummaryNumbersGrounded(source, "継続条件:通常1年以上保有・1000株以上3回以上記録", {
    minShares: [1000], recordMonths: [3], recordDates: [null],
  })).toBe(false);
  expect(isSummaryNumbersGrounded("合成商品5000円相当", "3000株:合成商品5000円相当", { minShares: [3000], recordMonths: [3] })).toBe(true);
  expect(isSummaryNumbersGrounded("合成商品5000円相当", "1000株:合成商品5000円相当", { minShares: [3000], recordMonths: [3] })).toBe(false);
});

it.skipIf(!existsSync(bankHistoryPrivatePath))("保存1群1行の歴史1000株・現在3000株・2027年特例を通常生成/取込/再取込で保持する", () => {
  const bytes = readFileSync(bankHistoryPrivatePath);
  expect(digest(bytes)).toBe("1fd40e9dceff443de1c3f818a4f515e8b9decd644f32a0504a3f40cc5f8217ac");
  const saved = JSON.parse(bytes.toString()) as { rows: BenefitRow[] };
  const tasks = selectSummaryTasks(saved.rows);
  expect(tasks.length).toBe(1); expect(saved.rows.length).toBe(1);
  const task = tasks[0], context = { minShares: [3000], recordMonths: [3], recordDates: [null] };
  expect(digest(task.description)).toBe("4482e903938f82100c0e98e972f9da38c00858e4ff2544b3456de6d5970c67d4");
  expect(digest(JSON.stringify(task.recipients))).toBe("840275444893fdcb2d674c439863f15088f3c7f44d98867ba615e3be50c895c3");
  expect(companyValue(task)).toEqual({ value: 5000, reason: "qualified_company_per_grant" });
  const result = compileSimpleSummary(task);
  if (result === null) throw new Error("bank_history_literal_missing");
  expect(digest(result.shortSummary)).toBe("c1d7b5b2ac47092d301ed514a593739d633a742fcc6c45c43c02778d40c35880");
  expect(checkSummary(result.shortSummary)).toEqual([]);
  expect(isSummaryNumbersGrounded(task.description, result.shortSummary, context)).toBe(true);
  expect(missingSummaryConditions(task.description, result.shortSummary)).toEqual([]);
  expect(result.estimatedValue).toBe(5000);
  const plan = planSummaryImport({ tasks, currentRows: saved.rows, resultsText: JSON.stringify(result) });
  expect(plan.rejections.map(r => r.reason)).toEqual([]); expect(plan.updates.length).toBe(1);
  const row = { ...saved.rows[0], ...plan.updates[0] };
  expect(selectSummaryTasks([row]).length).toBe(0);
  expect(trustedCompanyYieldValue(row, context)).toBe(5000);
  const source = splitHeadedDescription(task.description);
  if (source.heading === null) throw new Error("bank_history_heading_missing");
  const planned = benefitRowsOf({ code: task.stockCode, name: null, market: null, category: null,
    benefits: [{ minShares: row.minShares, localRecordMonths: [row.recordMonth], heading: source.heading, description: source.body, notes: "" }] });
  expect(planned.heldBenefits).toBe(0); expect(planned.rows.length).toBe(1);
  expect(digest(planned.rows[0].description)).toBe(digest(task.description));
  const key = carryKey(row.stockCode, source.body, row.minShares, row.recordMonth);
  const groups = new Map([[row.stockCode, new Map([[source.body, context]])]]);
  const carry = (headings: string[]) => planCarry([{ ...row, code: row.stockCode }], new Map([[key, headings]]), groups).carried.get(key);
  expect(digest(carry([planned.rows[0].heading])!.shortSummary!)).toBe(digest(result.shortSummary));
  expect(carry([planned.rows[0].heading])?.estimatedValue).toBe(5000);
  expect(carry([planned.rows[0].heading])?.estimateValueSource).toBe("company");
  for (const headings of [["別見出し"], [source.heading, "別見出し"], ["別見出し", source.heading], []])
    expect(carry(headings)?.shortSummary === null).toBe(true);
  const lines = task.description.split("\n");
  const changed = [task.description + "\n追加条件", task.description.replace("1,000", "3,000"),
    task.description.replace("2027", "2028"), task.description.replace("３回以上", "３回")];
  for (let line = 0; line < lines.length; line++) changed.push(lines.filter((_, i) => i !== line).join("\n"));
  for (const description of changed) {
    expect(description !== task.description).toBe(true);
    expect(compileSimpleSummary({ ...task, description }) === null).toBe(true);
    expect(isSummaryNumbersGrounded(description, result.shortSummary, context)).toBe(false);
  }
  for (const minShares of [[], [1000], [2999], [4000], [3000, 1000], [3000.5], [Number.NaN]])
    expect(isSummaryNumbersGrounded(task.description, result.shortSummary, { ...context, minShares })).toBe(false);
  for (const recordMonths of [[], [0], [9], [3, 9], [3.5]])
    expect(isSummaryNumbersGrounded(task.description, result.shortSummary, { ...context, recordMonths })).toBe(false);
  for (const recordDates of [undefined, [], ["2027-03-31"], [null, null]])
    expect(isSummaryNumbersGrounded(task.description, result.shortSummary, { ...context, recordDates })).toBe(false);
  for (const recipient of [{ minShares: 1000, recordMonth: 3, recordDate: null }, { minShares: 3000, recordMonth: 9, recordDate: null },
    { minShares: 3000, recordMonth: 3, recordDate: "2027-03-31" }])
    expect(compileSimpleSummary({ ...task, recipients: [recipient] }) === null).toBe(true);
  for (const shortSummary of [result.shortSummary + "・3000株", result.shortSummary.replace("1000株", "3000株"),
    result.shortSummary.replace("3回以上", "3回"), result.shortSummary.replace("2027", "2028"),
    result.shortSummary.replace("半年以上", "1年以上"), result.shortSummary.replace("5000円", "5001円"),
    result.shortSummary.replace("継続条件:通常", "通常"), result.shortSummary.replace("円相当", "%")])
    expect(isSummaryNumbersGrounded(task.description, shortSummary, context)).toBe(false);
  for (const estimatedValue of [5001, 10000])
    expect(planSummaryImport({ tasks, currentRows: saved.rows, resultsText: JSON.stringify({ ...result, estimatedValue }) }).updates.length).toBe(0);
  expect(planSummaryImport({ tasks, currentRows: saved.rows, resultsText: JSON.stringify({ ...result, contractVersion: "2026-10-25.9" }) }).rejections.map(r => r.reason)).toEqual(["contract_version"]);
  const dated = saved.rows.map(r => ({ ...r, recordDate: "2027-03-31" }));
  expect(planSummaryImport({ tasks: selectSummaryTasks(dated), currentRows: dated, resultsText: JSON.stringify(result) }).rejections.map(r => r.reason)).toEqual(["summary_ungrounded"]);
});

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
  expect(tasks.length).toBe(1); expect(tasks[0].contractVersion).toBe(SUMMARY_CONTRACT_VERSION);
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

const annualGiftPrivatePath = join(ROOT, "tmp/yutai-annual-gift-history-proof-v1/saved2-v3.private.json");
it("未資格の終了付きデジタルギフトを歴史100株一致だけで許可しない", () => {
  // 不完全な合成入力。実原文段落は私有黒箱回帰だけで照合する。
  const source = headedDescription("合成デジタルギフト", "1年以上保有、100株以上3回以上記載、1000円相当");
  expect(compileAnnualGiftHistoryLiteral(source)).toBeNull();
  expect(isSummaryNumbersGrounded(source, "デジタルギフト1000円相当、継続条件:1年以上・2月末/8月末同一株主番号100株以上3回以上連続記録、現制度2027年8月末限り", { minShares: [100], recordMonths: [2] })).toBe(false);
});

it.skipIf(!existsSync(annualGiftPrivatePath))("保存2群4行の各回/年額と終了・歴史定義を全経路で保持し、未知の改変を拒否する", () => {
  const bytes = readFileSync(annualGiftPrivatePath);
  expect(digest(bytes)).toBe(annualGiftSaved.provenance.privateFixtureSha256);
  const source = JSON.parse(bytes.toString()) as { rows: BenefitRow[]; expectedResults: SummaryResult[] };
  const tasks = selectSummaryTasks(source.rows);
  expect(tasks.length).toBe(2); expect(source.rows.length).toBe(4);
  const results = tasks.map(task => {
    const metadata = annualGiftSaved.groups.find(g => g.taskId === task.taskId);
    expect(digest(task.description)).toBe(metadata?.sourceSha256);
    expect(companyValue(task).reason).toBe("qualified_company_per_grant");
    const result = compileSimpleSummary(task);
    if (result === null) throw new Error("annual_gift_expected_result_missing");
    expect(digest(result.shortSummary)).toBe(metadata?.expectedSummarySha256);
    expect(result.shortSummary.length).toBe(98); expect(checkSummary(result.shortSummary)).toEqual([]);
    expect(result.estimatedValue).toBe(metadata?.listedPerGrantYen);
    const context = { minShares: task.recipients.map(r => r.minShares), recordMonths: task.recipients.map(r => r.recordMonth) };
    // scopeを持たない従来の100株contextは一般照合のまま。実tierの代替には使わない。
    const ordinary = result.shortSummary.replace("継続条件:1年以上・", "1年以上保有:");
    expect(isSummaryNumbersGrounded(task.description, ordinary, { ...context, minShares: [100] })).toBe(true);
    expect(isSummaryNumbersGrounded(task.description, ordinary, context)).toBe(false);
    const lines = task.description.split("\n");
    const changed = [task.description + "\n追加条件", task.description.replaceAll("2027年", "2028年"),
      task.description.replace("8月末限り", "9月末限り"), task.description.replace("3カ月以内", "6カ月以内"),
      task.description.replace("100 株以上", "500 株以上"), task.description.replace("3 回以上", "3 回"),
      task.description.replace("同一株主番号", "別の株主番号"), task.description.replace("PayPay", "別の交換先"),
      task.description.replace("1年以上保有", "2年以上保有")];
    for (let line = 1; line < lines.length; line++) if (lines[line] !== "") changed.push(lines.filter((_, i) => i !== line).join("\n"));
    for (const description of changed) {
      expect(description !== task.description).toBe(true);
      expect(compileSimpleSummary({ ...task, description }) === null).toBe(true);
      expect(isSummaryNumbersGrounded(description, result.shortSummary, context)).toBe(false);
      expect(isSummaryNumbersGrounded(description, result.shortSummary, { ...context, minShares: [100] })).toBe(false);
    }
    for (const value of ["0", "-1", "1.5", "01,000", "1e4", "9007199254740992"]) {
      const description = lines.map((line, index) => index === 2 ? `${value}円相当（年間\u300027,000円相当）` : line).join("\n");
      expect(compileSimpleSummary({ ...task, description }) === null).toBe(true);
    }
    expect(compileSimpleSummary({ ...task, description: lines.map((line, i) => i === 2 ? "100円相当（年間\u3000201円相当）" : line).join("\n") }) === null).toBe(true);
    for (const minShares of [[], [99], [100, 99], [100.5], [Number.MAX_SAFE_INTEGER + 1]])
      expect(isSummaryNumbersGrounded(task.description, result.shortSummary, { ...context, minShares })).toBe(false);
    for (const recordMonths of [[], [0], [9], [2, 9], [2.5]])
      expect(isSummaryNumbersGrounded(task.description, result.shortSummary, { ...context, recordMonths })).toBe(false);
    expect(compileSimpleSummary({ ...task, recipients: [{ minShares: 500, recordMonth: 9, recordDate: null }] })).toBeNull();
    expect(compileSimpleSummary({ ...task, recipients: [{ minShares: 500, recordMonth: 2, recordDate: "2026-02-28" }] })).toBeNull();
    for (const summary of [result.shortSummary.replace("3回以上", "3回"), result.shortSummary.replace("13500", "13501"),
      result.shortSummary.replace("27000", "27001"), result.shortSummary.replace("100株", "500株"), result.shortSummary.replace("2027年", "2028年"),
      result.shortSummary.replace("継続条件:", "継続条件="), result.shortSummary.replace("1年以上・", "1年以上:")]) {
      if (summary === result.shortSummary) continue;
      expect(isSummaryNumbersGrounded(task.description, summary, context)).toBe(false);
    }
    return result;
  });
  const plan = planSummaryImport({ tasks, currentRows: source.rows, resultsText: results.map(r => JSON.stringify(r)).join("\n") });
  expect(plan.rejections.map(r => r.reason)).toEqual([]); expect(plan.updates.length).toBe(2);
  expect(plan.updates.flatMap(u => u.ids).length).toBe(4);
  expect(plan.valueChanges).toEqual({ toNull: 0, fromNull: 4, changed: 0 });
  for (const result of results) {
    const annual = annualGiftSaved.groups.find(g => g.taskId === result.taskId)!.listedAnnualYen;
    const rejected = planSummaryImport({ tasks, currentRows: source.rows, resultsText: JSON.stringify({ ...result, estimatedValue: annual }) });
    expect(rejected.updates.length).toBe(0); expect(rejected.rejections.map(r => r.reason)).toEqual(["value_ungrounded"]);
  }
  const stale = source.rows.map(row => ({ ...row, minShares: row.minShares + 1 }));
  expect(planSummaryImport({ tasks, currentRows: stale, resultsText: results.map(r => JSON.stringify(r)).join("\n") }).rejections.map(r => r.reason)).toEqual(["stale", "stale"]);
  const changedSource = source.rows.map(row => ({ ...row, description: `${row.description}\n追加条件` }));
  expect(planSummaryImport({ tasks, currentRows: changedSource, resultsText: results.map(r => JSON.stringify(r)).join("\n") }).rejections.map(r => r.reason)).toEqual(["stale", "stale"]);
  const after = source.rows.map(row => {
    const update = plan.updates.find(u => u.ids.includes(row.id));
    if (update === undefined) throw new Error("annual_gift_update_missing");
    return { ...row, shortSummary: update.shortSummary, estimatedValue: update.estimatedValue, estimateValueSource: update.estimateValueSource };
  });
  expect(selectSummaryTasks(after).length).toBe(0);
  for (const row of after) {
    const split = splitHeadedDescription(row.description);
    if (split.heading === null) throw new Error("annual_gift_heading_missing");
    const key = carryKey(row.stockCode, split.body, row.minShares, row.recordMonth);
    const siblings = after.filter(r => r.description === row.description);
    const groups = new Map([[row.stockCode, new Map([[split.body, { minShares: siblings.map(r => r.minShares), recordMonths: siblings.map(r => r.recordMonth) }]])]]);
    const carry = (headings: string[]) => planCarry([{ ...row, code: row.stockCode }], new Map([[key, headings]]), groups).carried.get(key);
    expect(digest(carry([split.heading])!.shortSummary!)).toBe(digest(row.shortSummary));
    expect(carry([split.heading])?.estimatedValue).toBe(row.estimatedValue);
    expect(carry([split.heading])?.estimateValueSource).toBe("company");
    const context = { minShares: siblings.map(r => r.minShares), recordMonths: siblings.map(r => r.recordMonth) };
    expect(trustedCompanyYieldValue(row, context)).toBe(row.estimatedValue);
    expect(trustedCompanyYieldValue({ ...row, estimateValueSource: "web" }, context)).toBeNull();
    for (const headings of [["別のギフト"], [split.heading, "別のギフト"], ["別のギフト", split.heading], []])
      expect(carry(headings)?.shortSummary).toBeNull();
  }
  const old = results.map(r => JSON.stringify({ ...r, contractVersion: "2026-10-25.8" })).join("\n");
  expect(planSummaryImport({ tasks, currentRows: source.rows, resultsText: old }).rejections.map(r => r.reason)).toEqual(["contract_version", "contract_version"]);
});
