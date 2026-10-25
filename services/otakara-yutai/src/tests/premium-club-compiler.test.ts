import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import { SUMMARY_CONTRACT_VERSION } from "../../data-scripts/summary-contract.js";
import { companyValue, compileSimpleSummary } from "../../data-scripts/summary-local.js";
import { planSummaryImport, type SummaryResult } from "../../data-scripts/summary-import.js";
import { selectSummaryTasks, type BenefitRow, type SummaryTask } from "../../data-scripts/summary-tasks.js";
import saved from "./fixtures/premium-club-saved4.json";

const privatePath = join(ROOT, "tmp/yutai-premium-club-proof-v1/saved4.private.json");
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
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
