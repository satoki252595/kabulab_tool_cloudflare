/** 文法試験＋保存実3群の私有回帰。モデル・本番I/Oは行わない。 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import {
  SEMIF_HF_MODEL,
  SEMIF_HF_REVISION,
  SEMIF_SOURCE_REVISION,
  SEMIF_MLX_VERSION,
  SEMIF_MLX_LM_REVISION,
} from "../../../../src/shared/semif/client.js";
import {
  buildLocalResults,
  companyValue,
  compileSimpleSummary,
  parseLocalArgs,
  runLocalSummary,
  selectFairBatch,
  type LocalDependencies,
} from "../../data-scripts/summary-local.js";
import { isSummaryNumbersGrounded, missingSummaryConditions, SUMMARY_CONTRACT_VERSION, SUMMARY_MAX_CHARS } from "../../data-scripts/summary-contract.js";
import { planCarry } from "../../data-scripts/yutai-full-import.js";
import {
  parseTaskFile,
  selectSummaryTasks,
  type BenefitRow,
  type SummaryTask,
} from "../../data-scripts/summary-tasks.js";
import { planSummaryImport, type ImportPlan, type SummaryResult } from "../../data-scripts/summary-import.js";
import shippingSaved from "./fixtures/shipping-saved3.json";
import admissionSaved from "./fixtures/admission-saved3.json";
import pointExchangeSaved from "./fixtures/point-exchange-saved3.json";

const shippingPrivatePath = join(ROOT, "tmp/yutai-shipping-proof-v1/saved3.private.json");
const pointExchangePrivatePath = join(ROOT, "tmp/yutai-point-exchange-proof-v1/saved3.private.json");
const pointExchangeDescription = (amount: number) =>
  "【種別：\"電子ギフト\"】\n" + amount.toLocaleString("en-US") + "円相当\n※電子ギフトは1ポイント1円相当の各種電子マネーやポイントと交換することが可能です。\n■贈呈時期\n基準日から3カ月以内";
const admissionPrivatePath = join(ROOT, "tmp/yutai-admission-proof-v1/saved3.private.json");
const cinemaPrivatePath = join(ROOT, "tmp/yutai-monthly-cinema-proof-v1/saved3.private.json");
const heldCatalogPrivatePath = join(ROOT, "tmp/yutai-held-catalog-proof-v1/saved3.private.json");
const withoutContractVersion = ({ contractVersion: _version, ...value }: SummaryTask | SummaryResult) => value;
const admissionDescription = (first: number, second: number) =>
  `【種別："温浴施設「テルマー湯」優待券"】\n新宿店 ${first}枚\n六本木・西麻布店 ${second}枚\n※1枚につき1名が入場できる。\n※土日、祝日および特定日は\n\u3000利用できない。`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function state(): string {
  const dir = mkdtempSync(join(tmpdir(), "yutai-summary-unit-"));
  dirs.push(dir);
  return dir;
}
function row(id = 1, over: Partial<BenefitRow> = {}): BenefitRow {
  return {
    id,
    stockId: id,
    stockCode: String(9000 + id),
    stockName: "合成テスト社",
    description: "合成商品券 3,000円分",
    shortSummary: null,
    estimatedValue: null,
    estimateValueSource: null,
    minShares: 100,
    recordMonth: 3,
    recordDate: null,
    updatedAt: 1,
    ...over,
  };
}
const ready = {
  ready: true,
  model: SEMIF_HF_MODEL,
  revision: SEMIF_HF_REVISION,
  sourceRevision: SEMIF_SOURCE_REVISION,
  mlxVersion: SEMIF_MLX_VERSION,
  mlxLmRevision: SEMIF_MLX_LM_REVISION,
  maxInputTokens: 16000,
  maxOutputTokens: 512,
  promptSHA256: "a".repeat(64),
  artifacts: { "config.json": "b".repeat(64) },
};
function protocol(tasks: readonly SummaryTask[], text = '{"shortSummary":"商品券 3,000円分"}'): string {
  return (
    [
      ready,
      ...tasks.map((task) => ({
        taskId: task.taskId,
        text,
        finishReason: "stop",
        inputTokens: 100,
        outputTokens: 20,
        elapsedMs: 5,
      })),
    ]
      .map((v) => JSON.stringify(v))
      .join("\n") + "\n"
  );
}
function dependencies(initial: BenefitRow[]): {
  deps: LocalDependencies;
  events: string[];
  rows: () => BenefitRow[];
} {
  let current = structuredClone(initial);
  const events: string[] = [];
  return {
    events,
    rows: () => current,
    deps: {
      loadRows: vi.fn(async () => structuredClone(current)),
      generate: vi.fn(async (path) => {
        events.push("generate");
        return protocol(parseTaskFile(readFileSync(path, "utf8")));
      }),
      archive: vi.fn(async (bytes, _clock, phase) => {
        events.push(`archive-${phase}`);
        expect(JSON.parse(gunzipSync(bytes).toString())).toBeTruthy();
      }),
      apply: vi.fn(async (_rows: readonly BenefitRow[], plan: ImportPlan) => {
        events.push("apply");
        current = current.map((r) => {
          const update = plan.updates.find((u) => u.ids.includes(r.id));
          return update
            ? {
                ...r,
                shortSummary: update.shortSummary,
                estimatedValue: update.estimatedValue,
                estimateValueSource: update.estimateValueSource,
                updatedAt: r.updatedAt + 1,
              }
            : r;
        });
      }),
    },
  };
}

describe("local summary generation/import boundary", () => {
  it("長期保有商品の金額だけで未資格の選択・名簿条件を採用しない", () => {
    const description = '【種別："株主優待商品（長期保有者向け）"】\n【1年以上保有株主】\n1,000円相当\n合成の未資格条件';
    expect(compileSimpleSummary(selectSummaryTasks([row(1, { description, recordMonth: 12 })])[0])).toBeNull();
  });
  it.skipIf(!existsSync(heldCatalogPrivatePath))("保存実4820の3全文を保有・選択・名簿・時期とnull額保持のまま通常取込し、条件変化はHOLD", async () => {
    const bytes = readFileSync(heldCatalogPrivatePath);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("6adee57001f20028f738aa38108d964d06627d24fa79c51f2f3cb7c38a766925");
    const saved = JSON.parse(bytes.toString()) as { tasks: SummaryTask[]; rows: BenefitRow[]; results: SummaryResult[] };
    const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const tasks = selectSummaryTasks(saved.rows), results = tasks.map(task => compileSimpleSummary(task));
    expect(digest(tasks.map(withoutContractVersion))).toBe(digest(saved.tasks.map(withoutContractVersion)));
    expect(tasks).toHaveLength(3); expect(saved.rows).toHaveLength(3);
    expect(digest(results.map(result => result === null ? null : withoutContractVersion(result))))
      .toBe(digest(saved.results.map(withoutContractVersion)));
    expect(tasks.every(task => companyValue(task).reason === "choice" && task.contractVersion === SUMMARY_CONTRACT_VERSION)).toBe(true);
    const plan = planSummaryImport({ tasks, currentRows: saved.rows, resultsText: results.map(result => JSON.stringify(result)).join("\n") });
    expect(plan.rejections).toEqual([]); expect(plan.updates).toHaveLength(3);
    expect(plan.updates.every(update => update.estimatedValue === null && update.estimateValueSource === null)).toBe(true);
    const original = tasks[0].description, lines = original.split("\n");
    for (const amount of ["1", "10", "100", "1,000", "10,000"]) {
      // 実全文の掲載額slotだけを変更する対照。価格推計や受取額の認定はしない。
      const description = original.replace(lines[2], `${amount}円相当`), scopedRows = saved.rows.slice(0, 1).map(row => ({ ...row, description }));
      const scopedTasks = selectSummaryTasks(scopedRows), result = compileSimpleSummary(scopedTasks[0]);
      expect(result !== null && result.estimatedValue === null && result.shortSummary.length <= SUMMARY_MAX_CHARS).toBe(true);
      expect(planSummaryImport({ tasks: scopedTasks, currentRows: scopedRows, resultsText: JSON.stringify(result) }).rejections).toEqual([]);
    }
    for (const amount of ["0", "-1", "1.5", "01", "1,00", "9007199254740992", "100000"]) {
      expect(compileSimpleSummary({ ...tasks[0], description: original.replace(lines[2], `${amount}円相当`) })).toBeNull();
    }
    for (const description of [
      ...lines.map((line, index) => line === "" ? original : lines.filter((_, at) => at !== index).join("\n")).filter(value => value !== original),
      original.replace("1年以上", "2年以上"), original.replace("2月下旬", "3月下旬"), original.replace("12月31日", "6月30日"),
      original.replace("同一の株主番号", "異なる株主番号"), original.replace("1点選択", "2点選択"), original.replace("寄付", "抽選"),
      ...["追加条件", "申込必要", "併用不可", "別途1,000円"].map(note => `${original}\n${note}`),
    ]) {
      expect(description !== original).toBe(true);
      expect(compileSimpleSummary({ ...tasks[0], description })).toBeNull();
    }
    for (const recipient of [{ ...tasks[0].recipients[0], recordMonth: 3 }, { ...tasks[0].recipients[0], recordDate: "2027-12-31" }]) {
      expect(compileSimpleSummary({ ...tasks[0], recipients: [recipient] })).toBeNull();
    }
    const { deps, events, rows } = dependencies(saved.rows);
    expect(await runLocalSummary({ stateDir: state(), limit: 3 }, deps)).toMatchObject({ accepted: 3, rejected: 0,
      deterministic: 3, pendingAfter: 0, modelCalls: 0, modelResidents: 0 });
    expect(events).toEqual(["archive-pre", "apply", "archive-post"]); expect(deps.generate).not.toHaveBeenCalled();
    expect(digest(rows().map(({ shortSummary: _summary, updatedAt: _clock, ...row }) => row)))
      .toBe(digest(saved.rows.map(({ shortSummary: _summary, updatedAt: _clock, ...row }) => row)));
  });
  it("映画の未知本文・注記欠落を月間回数だけで機械採用しない", () => {
    for (const description of [
      '【種別："あべのアポロシネマ映画鑑賞無料ご招待"】\n毎月6回',
      '【種別："あべのアポロシネマ映画鑑賞無料ご招待"】\n毎月6回\n未対応の座席指定方法',
    ]) expect(compileSimpleSummary(selectSummaryTasks([row(1, { description })])[0])).toBeNull();
  });
  it.skipIf(!existsSync(cinemaPrivatePath))("保存実9636の3全文/6行を条件とnull額保持のまま通常取込し、同型の正整数だけ読む", async () => {
    const bytes = readFileSync(cinemaPrivatePath);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("c9c4a1a053c00c9a122f7921b27d763adea329ee90c4922c4a04f0f47e7eefa6");
    const saved = JSON.parse(bytes.toString()) as { tasks: SummaryTask[]; rows: BenefitRow[]; results: Array<{
      taskId: string; contractVersion: string; shortSummary: string; estimatedValue: null;
    }> };
    const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const tasks = selectSummaryTasks(saved.rows);
    expect(digest(tasks.map(withoutContractVersion))).toBe(digest(saved.tasks.map(withoutContractVersion)));
    expect(tasks).toHaveLength(3); expect(saved.rows).toHaveLength(6);
    expect(tasks.every(task => task.contractVersion === SUMMARY_CONTRACT_VERSION)).toBe(true);
    const results = tasks.map(task => compileSimpleSummary(task));
    expect(digest(results.map(result => result === null ? null : withoutContractVersion(result))))
      .toBe(digest(saved.results.map(withoutContractVersion)));
    const plan = planSummaryImport({ tasks, currentRows: saved.rows, resultsText: results.map(result => JSON.stringify(result)).join("\n") });
    expect(plan.rejections).toEqual([]); expect(plan.updates).toHaveLength(3);
    expect(plan.updates.flatMap(update => update.ids)).toHaveLength(6);
    for (const result of results) expect(result!.shortSummary.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);

    const original = tasks[0].description;
    for (const count of [1, 2, 4, 20, Number.MAX_SAFE_INTEGER]) {
      // 同じ実原文の数量slotだけを変える対照入力。年額やrecipientは生成しない。
      const description = original.replace(/毎月[0-9]+回/, `毎月${count}回`);
      const rows = saved.rows.filter(row => row.description === original).map(row => ({ ...row, description }));
      const scopedTasks = selectSummaryTasks(rows), result = compileSimpleSummary(scopedTasks[0]);
      expect(result !== null && result.estimatedValue === null).toBe(true);
      expect(result!.shortSummary.includes(`毎月${count}回`)).toBe(true);
      expect(result!.shortSummary.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
      expect(planSummaryImport({ tasks: scopedTasks, currentRows: rows, resultsText: JSON.stringify(result) }).rejections).toEqual([]);
    }
    for (const description of [
      ...["0", "-1", "1.5", "01", "1,0", "9007199254740992"].map(value => original.replace(/毎月[0-9]+回/, `毎月${value}回`)),
      original.replace("毎月", "毎年"), original.replace("あべのアポロシネマ", "別会場"),
      original.replace("インターネット", "電話"), original.replace("または", "および"),
      original.replace("自動券売機", "別窓口"), original.replace("チケットカウンター", "別窓口"),
      original.replace("ご招待カード", "購入カード"), original.split("\n").slice(0, -1).join("\n"),
      ...["1年以上保有", "抽選", "申込必要", "併用不可", "別途1,000円", "別条件あり"].map(note => `${original}\n${note}`),
    ]) {
      expect(description === original).toBe(false);
      expect(compileSimpleSummary({ ...tasks[0], description })).toBeNull();
    }
    const { deps, rows } = dependencies(saved.rows);
    expect(await runLocalSummary({ stateDir: state(), limit: 3 }, deps)).toMatchObject({
      accepted: 3, rejected: 0, deterministic: 3, pendingAfter: 0, modelCalls: 0, modelResidents: 0,
    });
    expect(deps.generate).not.toHaveBeenCalled();
    expect(digest(rows().map(({ shortSummary: _summary, updatedAt: _clock, ...row }) => row)))
      .toBe(digest(saved.rows.map(({ shortSummary: _summary, updatedAt: _clock, ...row }) => row)));
  });
  it.each(pointExchangeSaved.groups)("電子ギフトの掲載額・換算・両交換先・贈呈期限を全callerで保つ: $taskId", group => {
    // 全文文法の対照入力。元の表記・全bytes/SHAは保存実原文の私有回帰で照合する。
    const description = pointExchangeDescription(group.expectedValue);
    const recipient = group.recipients[0];
    const currentRows = [row(1, { description, stockCode: group.stockCode, ...recipient })];
    const tasks = selectSummaryTasks(currentRows), result = compileSimpleSummary(tasks[0]);
    expect(result).toMatchObject({ shortSummary: group.expectedSummary, estimatedValue: group.expectedValue,
      contractVersion: SUMMARY_CONTRACT_VERSION });
    expect(companyValue(tasks[0])).toEqual({ value: group.expectedValue, reason: "qualified_company_per_grant" });
    expect(isSummaryNumbersGrounded(description, group.expectedSummary, {
      minShares: [recipient.minShares], recordMonths: [recipient.recordMonth],
    })).toBe(true);
    const plan = planSummaryImport({ tasks, currentRows, resultsText: JSON.stringify(result) });
    expect(plan.rejections).toEqual([]); expect(plan.updates).toHaveLength(1);
    expect(selectSummaryTasks([{ ...currentRows[0], shortSummary: group.expectedSummary,
      estimatedValue: group.expectedValue, estimateValueSource: "company" }])).toEqual([]);
    const carry = planCarry([{ code: group.stockCode, description, ...recipient, shortSummary: group.expectedSummary,
      estimatedValue: group.expectedValue, estimateValueSource: "company" }], new Map(), new Map());
    expect([...carry.carried.values()]).toEqual([{ shortSummary: group.expectedSummary,
      estimatedValue: group.expectedValue, estimateValueSource: "company" }]);
    expect(carry.nulledKeys.size).toBe(0);
  });
  it("電子ギフト全文の改変と、換算・交換先・期限を落とす要約を拒否する", () => {
    const description = pointExchangeDescription(10000), summary = pointExchangeSaved.groups[0].expectedSummary;
    const currentRows = [row(1, { description })], tasks = selectSummaryTasks(currentRows);
    for (const changed of [description + "\n別条件あり", description + "\n1年以上保有", description + "\n抽選",
      description + "\n申込必要", description + "\n2回", description + "\n別途1,000円分",
      description.replace("電子ギフト", "商品券"), description.split("\n").slice(1).join("\n"),
      description.replace("10,000円", "0円"), description.replace("10,000円", "10,00円"),
      description.replace("10,000円", "9,007,199,254,740,992円"), description.replace("1ポイント", "2ポイント"),
      description.replace("電子マネー", "ギフト"), description.replace("ポイントと交換", "ギフトと交換"),
      description.replace("基準日", "確定日"), description.replace("3カ月", "6カ月"),
      description.split("\n").slice(0, -1).join("\n")]) {
      expect(changed).not.toBe(description);
      expect(compileSimpleSummary(selectSummaryTasks([row(1, { description: changed })])[0])).toBeNull();
    }
    for (const changed of [summary.replace("10,000円", "20,000円"), summary.replace("1ポイント", "2ポイント"),
      summary.replace("1円相当", "2円相当"), summary.replace("1円相当", "1円"),
      summary.replace("電子マネー・ポイント", "電子マネー"), summary.replace("電子マネー・ポイント", "ギフト・電子マネー"),
      summary.replace("基準日", "確定日"), summary.replace("3か月以内", "3か月以降"),
      summary.replace("、基準日から3か月以内贈呈", ""), summary.replace("贈呈", "利用可"), summary + "・1回追加"]) {
      expect(changed).not.toBe(summary);
      const result = { taskId: tasks[0].taskId, contractVersion: SUMMARY_CONTRACT_VERSION,
        shortSummary: changed, estimatedValue: 10000 };
      expect(isSummaryNumbersGrounded(description, changed, { minShares: [100], recordMonths: [3] })).toBe(false);
      expect(planSummaryImport({ tasks, currentRows, resultsText: JSON.stringify(result) }).updates).toEqual([]);
      expect(selectSummaryTasks([{ ...currentRows[0], shortSummary: changed }])[0].reason).toBe("rework");
      const carry = planCarry([{ code: currentRows[0].stockCode, description, minShares: 100, recordMonth: 3, recordDate: null,
        shortSummary: changed, estimatedValue: 10000, estimateValueSource: "company" }], new Map(), new Map());
      expect([...carry.carried.values()][0].shortSummary).toBeNull();
    }
    // 既存取込契約は明示nullを認める。機械compilerは資格済み掲載額を出す。
    expect(planSummaryImport({ tasks, currentRows, resultsText: JSON.stringify({ taskId: tasks[0].taskId,
      contractVersion: SUMMARY_CONTRACT_VERSION, shortSummary: summary, estimatedValue: null }) }).updates).toHaveLength(1);
    for (const estimatedValue of [0, 20000]) {
      const result = { taskId: tasks[0].taskId, contractVersion: SUMMARY_CONTRACT_VERSION, shortSummary: summary, estimatedValue };
      expect(planSummaryImport({ tasks, currentRows, resultsText: JSON.stringify(result) }).updates).toEqual([]);
    }
  });
  it.skipIf(!existsSync(pointExchangePrivatePath))("保存実7360の3原文を新版taskから通常PRE/取込/全POSTへモデル0で通す", async () => {
    const bytes = readFileSync(pointExchangePrivatePath);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(pointExchangeSaved.provenance.privateFixtureSha256);
    const saved = JSON.parse(bytes.toString()) as { tasks: SummaryTask[]; rows: BenefitRow[] }, tasks = selectSummaryTasks(saved.rows);
    expect(tasks).toHaveLength(3);
    expect(saved.tasks.every(task => task.contractVersion === pointExchangeSaved.provenance.originalContractVersion)).toBe(true);
    expect(tasks.every(task => task.contractVersion === SUMMARY_CONTRACT_VERSION)).toBe(true);
    const withoutVersion = ({ contractVersion: _version, ...task }: SummaryTask) => task;
    expect(tasks.map(withoutVersion)).toEqual(saved.tasks.map(withoutVersion));
    const oldResults = saved.tasks.map(task => ({ ...compileSimpleSummary(task)!, contractVersion: task.contractVersion }));
    expect(planSummaryImport({ tasks, currentRows: saved.rows, resultsText: oldResults.map(result => JSON.stringify(result)).join("\n") }).rejections
      .map(rejection => rejection.reason)).toEqual(["contract_version", "contract_version", "contract_version"]);
    for (const task of tasks) {
      const group = pointExchangeSaved.groups.find(item => item.taskId === task.taskId)!;
      expect(createHash("sha256").update(task.description).digest("hex")).toBe(group.sourceSha256);
      expect(task.recipients).toEqual(group.recipients);
    }
    const { deps, events, rows } = dependencies(saved.rows);
    expect(await runLocalSummary({ stateDir: state(), limit: 60 }, deps)).toMatchObject({ selected: 3, accepted: 3,
      deterministic: 3, pendingAfter: 0, modelCalls: 0, modelResidents: 0 });
    expect(deps.generate).not.toHaveBeenCalled(); expect(events).toEqual(["archive-pre", "apply", "archive-post"]);
    for (const task of tasks) {
      const result = rows().find(item => item.description === task.description)!, group = pointExchangeSaved.groups.find(item => item.taskId === task.taskId)!;
      expect(result).toMatchObject({ shortSummary: group.expectedSummary, estimatedValue: group.expectedValue, estimateValueSource: "company" });
    }
  });
  it.each(admissionSaved.groups)("保存2施設形式の施設名・各枚数・人数・利用制限を全callerで保つ: $taskId", group => {
    const description = admissionDescription(group.quantities[0], group.quantities[1]);
    expect(createHash("sha256").update(description).digest("hex")).toBe(group.sourceSha256);
    const recipient = group.recipients[0];
    const currentRows = [row(1, { description, stockCode: group.stockCode, ...recipient })];
    const tasks = selectSummaryTasks(currentRows), result = compileSimpleSummary(tasks[0]);
    expect(result).toMatchObject({ shortSummary: group.expectedSummary, estimatedValue: null, contractVersion: SUMMARY_CONTRACT_VERSION });
    expect(companyValue(tasks[0])).toEqual({ value: null, reason: "no_source_yen_amount" });
    const plan = planSummaryImport({ tasks, currentRows, resultsText: JSON.stringify(result) });
    expect(plan.rejections).toEqual([]); expect(plan.updates).toHaveLength(1);
    expect(selectSummaryTasks([{ ...currentRows[0], shortSummary: group.expectedSummary }])).toEqual([]);
    const carry = planCarry([{ code: group.stockCode, description, ...recipient, shortSummary: group.expectedSummary,
      estimatedValue: null, estimateValueSource: null }], new Map(), new Map());
    expect([...carry.carried.values()]).toEqual([{ shortSummary: group.expectedSummary, estimatedValue: null, estimateValueSource: null }]);
    expect(carry.nulledKeys.size).toBe(0);
  });
  it("2施設の全文文法と共有guardは追加/変更/省略した数量・条件・施設名を拒否する", () => {
    const description = admissionDescription(1, 1), summary = admissionSaved.groups[0].expectedSummary;
    const currentRows = [row(1, { description })], tasks = selectSummaryTasks(currentRows);
    for (const changed of [description + "\n61枚", description + "\n1回追加", description + "\n1年以上保有",
      description + "\n抽選", description + "\n1,000円分", description.replace("六本木・西麻布店", "六本木店"),
      description.replace("土日、祝日および特定日", "土日および祝日"), description.split("\n").slice(0, 3).join("\n"),
      description.replace("新宿店 1枚", "新宿店 0枚"), description.replace("新宿店 1枚", "新宿店 9007199254740992枚")]) {
      expect(compileSimpleSummary(selectSummaryTasks([row(1, { description: changed })])[0])).toBeNull();
    }
    for (const changed of [summary.replace("新宿店1枚", "新宿店61枚"), summary + "・1回追加", summary + "・1株",
      summary + "・1,000円", summary + "・1年以上保有", summary.replace("新宿店", "別施設店"),
      summary.replace("六本木・西麻布店", "六本木店"), summary.replace("、六本木・西麻布店1枚", ""),
      summary.replace("、土日祝・特定日利用不可", ""), summary.replace("1枚1名", "1枚2名"), summary.replace("新宿店1枚", "新宿店三枚")]) {
      const result = { taskId: tasks[0].taskId, contractVersion: SUMMARY_CONTRACT_VERSION, shortSummary: changed, estimatedValue: null };
      expect(isSummaryNumbersGrounded(description, changed, { minShares: [100], recordMonths: [3] })).toBe(false);
      expect(planSummaryImport({ tasks, currentRows, resultsText: JSON.stringify(result) }).updates).toEqual([]);
      expect(selectSummaryTasks([{ ...currentRows[0], shortSummary: changed }])[0].reason).toBe("rework");
      const carry = planCarry([{ code: currentRows[0].stockCode, description, minShares: 100, recordMonth: 3, recordDate: null,
        shortSummary: changed, estimatedValue: null, estimateValueSource: null }], new Map(), new Map());
      expect([...carry.carried.values()][0].shortSummary).toBeNull();
    }
    expect(isSummaryNumbersGrounded("入場優待券1枚", summary, { minShares: [100], recordMonths: [3] })).toBe(false);
    for (const estimatedValue of [0, 1000]) {
      const result = { taskId: tasks[0].taskId, contractVersion: SUMMARY_CONTRACT_VERSION, shortSummary: summary, estimatedValue };
      expect(planSummaryImport({ tasks, currentRows, resultsText: JSON.stringify(result) }).updates).toEqual([]);
    }
  });
  it.skipIf(!existsSync(admissionPrivatePath))("保存実3521の3原文を新版taskから通常PRE/取込/全POSTへ通し、旧結果は再採用しない", async () => {
    const bytes = readFileSync(admissionPrivatePath);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(admissionSaved.provenance.privateFixtureSha256);
    const saved = JSON.parse(bytes.toString()) as { tasks: SummaryTask[]; rows: BenefitRow[] }, tasks = selectSummaryTasks(saved.rows);
    expect(tasks).toHaveLength(3);
    expect(saved.tasks.every(task => task.contractVersion === admissionSaved.provenance.originalContractVersion)).toBe(true);
    expect(tasks.every(task => task.contractVersion === SUMMARY_CONTRACT_VERSION)).toBe(true);
    const rawTaskSha = ({ contractVersion: _version, ...task }: SummaryTask) => createHash("sha256").update(JSON.stringify(task)).digest("hex");
    expect(tasks.map(rawTaskSha)).toEqual(saved.tasks.map(rawTaskSha));
    const oldResults = saved.tasks.map(task => ({ ...compileSimpleSummary(task)!, contractVersion: task.contractVersion }));
    expect(planSummaryImport({ tasks, currentRows: saved.rows, resultsText: oldResults.map(result => JSON.stringify(result)).join("\n") }).rejections
      .map(rejection => rejection.reason)).toEqual(["contract_version", "contract_version", "contract_version"]);
    for (const task of tasks) {
      const group = admissionSaved.groups.find(item => item.taskId === task.taskId)!;
      expect(createHash("sha256").update(task.description).digest("hex")).toBe(group.sourceSha256);
      expect(task.recipients).toEqual(group.recipients);
    }
    const { deps, events, rows } = dependencies(saved.rows);
    expect(await runLocalSummary({ stateDir: state(), limit: 60 }, deps)).toMatchObject({ selected: 3, accepted: 3,
      deterministic: 3, pendingAfter: 0, modelCalls: 0, modelResidents: 0 });
    expect(deps.generate).not.toHaveBeenCalled(); expect(events).toEqual(["archive-pre", "apply", "archive-post"]);
    for (const task of tasks) {
      const result = rows().find(item => item.description === task.description)!, group = admissionSaved.groups.find(item => item.taskId === task.taskId)!;
      expect(result).toMatchObject({ shortSummary: group.expectedSummary, estimatedValue: null, estimateValueSource: null });
    }
  });
  it("種類・額面の全文が一意な入力だけを定型化し、未知の条件や見出しを落とさない", () => {
    const task = (description: string) => selectSummaryTasks([row(1, { description })])[0];
    for (const description of ["QUOカード 3,000円分", '【種別："QUOカード"】\nQUOカード ３０００円分を贈呈。',
      '【種別："QUOカード"】\n3,000円分']) {
      expect(compileSimpleSummary(task(description))).toMatchObject({ shortSummary: "QUOカード 3,000円分", estimatedValue: 3000 });
    }
    expect(compileSimpleSummary(task("自社商品 3,000円相当"))).toMatchObject({ shortSummary: "自社商品 3,000円相当", estimatedValue: 3000 });
    for (const description of ["QUOカード 3,000円分\n※1年以上保有", "QUOカード 3,000円分から選択",
      "QUOカード 3,000円分 抽選", "QUOカード 3,000円分 申込必要", "QUOカード 3,000円引き",
      "QUOカード 3,00円分", "QUOカード 0円分", "QUOカード 3,000円分と商品券 2,000円分",
      '【種別："1年以上保有"】\nQUOカード 3,000円分', '【種別：壊れた見出し】\nQUOカード 3,000円分']) {
      expect(compileSimpleSummary(task(description))).toBeNull();
    }
  });
  it.each(shippingSaved.groups)("送付2か月の全文文法は掲載額と両月を保持する: $taskId", group => {
    // 全文文法の対照入力。実task/rowの原bytesは私有回帰で別途照合する。
    const description = `【種別："自社製品詰合せ（アイス等）"】\n${group.expectedValue.toLocaleString("en-US")}円相当\n【送付時期】\n5月~6月`;
    const currentRows = [row(1, { description })];
    const tasks = selectSummaryTasks(currentRows);
    const result = compileSimpleSummary(tasks[0]);
    expect(result).toMatchObject({ shortSummary: group.expectedSummary, estimatedValue: group.expectedValue });
    expect(companyValue(tasks[0])).toEqual({ value: group.expectedValue, reason: "qualified_company_per_grant" });
    const plan = planSummaryImport({ tasks, currentRows, resultsText: JSON.stringify(result) });
    expect(plan.rejections).toEqual([]);
    expect(plan.updates).toHaveLength(1);
  });
  it("送付文法は余分な注記・数量・保有条件・別見出し・不正額/月を部分採用しない", () => {
    const original = '【種別："自社製品詰合せ（アイス等）"】\n2,000円相当\n【送付時期】\n5月~6月';
    const compile = (description: string) => compileSimpleSummary(selectSummaryTasks([row(1, { description })])[0]);
    for (const suffix of ["\n※別条件あり", "\n2個", "\n×2", "\n1年以上保有", "\n抽選", "\n申込必要", "\n別途1,000円分"]) {
      expect(compile(original + suffix)).toBeNull();
    }
    for (const changed of [original.replace("アイス等", "別商品"), original.split("\n").slice(1).join("\n"),
      original.replace("2,000円", "約2,000円"), original.replace("2,000円", "0円"), original.replace("2,000円", "2,00円"),
      original.replace("2,000円", "9,007,199,254,740,992円"), original.replace("5月", "0月"), original.replace("6月", "13月"),
      original.replace("5月~6月", "5~6月"), original.replace("【送付時期】", "【申込時期】")]) {
      expect(compile(changed)).toBeNull();
    }
  });
  it.skipIf(!existsSync(shippingPrivatePath))("保存実2872の3task/3行を通常PRE/原子取込/全POSTへモデル0で通す", async () => {
    const bytes = readFileSync(shippingPrivatePath);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(shippingSaved.provenance.privateFixtureSha256);
    const saved = JSON.parse(bytes.toString()) as { tasks: SummaryTask[]; rows: BenefitRow[] };
    const tasks = selectSummaryTasks(saved.rows);
    const archived = parseTaskFile(saved.tasks.map(task => JSON.stringify(task)).join("\n"));
    const rawTaskSha = ({ contractVersion: _version, ...task }: SummaryTask) => createHash("sha256").update(JSON.stringify(task)).digest("hex");
    expect(tasks.map(rawTaskSha)).toEqual(archived.map(rawTaskSha));
    expect(tasks).toHaveLength(3);
    for (const task of tasks) {
      const group = shippingSaved.groups.find(item => item.taskId === task.taskId)!;
      expect(createHash("sha256").update(task.description).digest("hex")).toBe(group.sourceSha256);
      expect(task.recipients).toEqual(group.recipients);
      expect(compileSimpleSummary(task)).toMatchObject({ shortSummary: group.expectedSummary, estimatedValue: group.expectedValue });
    }
    const { deps, events, rows } = dependencies(saved.rows);
    expect(await runLocalSummary({ stateDir: state(), limit: 60 }, deps)).toMatchObject({ selected: 3, accepted: 3,
      deterministic: 3, pendingAfter: 0, modelCalls: 0, modelResidents: 0 });
    expect(deps.generate).not.toHaveBeenCalled();
    expect(events).toEqual(["archive-pre", "apply", "archive-post"]);
    for (const task of tasks) {
      const result = rows().find(item => item.description === task.description)!;
      const group = shippingSaved.groups.find(item => item.taskId === task.taskId)!;
      expect(result).toMatchObject({ shortSummary: group.expectedSummary, estimatedValue: group.expectedValue, estimateValueSource: "company" });
    }
  });
  it("定型だけのbatchはモデルを起動せず、通常の物理PRE/原子取込/全POSTを通す", async () => {
    const { deps, events, rows } = dependencies([row(1, { description: "QUOカード 3,000円分" })]);
    const dir = state();
    expect(await runLocalSummary({ stateDir: dir, limit: 60 }, deps)).toMatchObject({ accepted: 1, pendingAfter: 0,
      modelCalls: 0, modelResidents: 0, deterministic: 1 });
    expect(deps.generate).not.toHaveBeenCalled();
    expect(events).toEqual(["archive-pre", "apply", "archive-post"]);
    expect(rows()[0]).toMatchObject({ shortSummary: "QUOカード 3,000円分", estimatedValue: 3000 });
    const run = readdirSync(dir).find(name => name !== "progress.json")!;
    const pre = JSON.parse(gunzipSync(readFileSync(join(dir, run, "pre-import.json.gz"))).toString());
    expect(pre).toMatchObject({ model: null, revision: null, protocol: "", deterministicRule: "simple-face-value-one-of-holding-record-tier-shipping-admission-point-exchange-v21" });
    expect(parseTaskFile(readFileSync(join(dir, run, "model-tasks.jsonl"), "utf8"))).toEqual([]);
  });
  it("全文1点選択はモデル0で通常PRE/原子取込/POSTへ通し、選択肢の掲載額を評価しない", async () => {
    // 文法試験専用。実掲載値として出力しない。
    const description = '【種別："カタログギフトまたは食事券"】\n◆以下より1点を選択\n1、カタログギフト 1,000円相当\n2、食事券 2,000円分';
    const { deps, events, rows } = dependencies([row(1, { description })]);
    const options = { stateDir: state(), limit: 60 };
    expect(await runLocalSummary(options, deps)).toMatchObject({ accepted: 1, pendingAfter: 0,
      modelCalls: 0, modelResidents: 0, deterministic: 1 });
    expect(events).toEqual(["archive-pre", "apply", "archive-post"]);
    expect(deps.generate).not.toHaveBeenCalled();
    expect(rows()[0]).toMatchObject({ shortSummary: "優待を1点選択", estimatedValue: null, estimateValueSource: null });
    expect(await runLocalSummary(options, deps)).toMatchObject({ selected: 0, modelCalls: 0 });
    expect(events).toEqual(["archive-pre", "apply", "archive-post"]);
  });
  it("混在batchは未対応の群だけをモデルに渡し、全タスク共通の取込契約を守る", async () => {
    const { deps, rows } = dependencies([row(1, { description: "QUOカード 3,000円分" }), row(2)]);
    const generate = deps.generate;
    deps.generate = vi.fn(async (path, run) => {
      expect(parseTaskFile(readFileSync(path, "utf8")).map(task => task.stockCode)).toEqual(["9002"]);
      return generate(path, run);
    });
    expect(await runLocalSummary({ stateDir: state(), limit: 60, allowModel: true }, deps)).toMatchObject({ accepted: 2, pendingAfter: 0,
      modelCalls: 1, modelResidents: 1, deterministic: 1 });
    expect(deps.generate).toHaveBeenCalledOnce();
    expect(rows().map(r => r.estimatedValue)).toEqual([3000, 3000]);
  });
  it("標準の混在batchは機械判定だけ採用し、未対応の旧値・時計を理由付きHOLDで保持する", async () => {
    const old = row(2, { shortSummary: "※旧値", estimatedValue: 5000, estimateValueSource: "company" });
    const { deps, events, rows } = dependencies([row(1, { description: "QUOカード 3,000円分" }), old]);
    deps.generate = vi.fn(async () => { throw new Error("model_must_not_start"); });
    const dir = state();
    expect(await runLocalSummary({ stateDir: dir, limit: 60 }, deps)).toMatchObject({ selected: 2, accepted: 1,
      rejected: 1, held: 1, pendingAfter: 1, outcome: "partial_rejection", modelCalls: 0, modelResidents: 0, deterministic: 1 });
    expect(deps.generate).not.toHaveBeenCalled(); expect(rows()[1]).toEqual(old);
    expect(events).toEqual(["archive-pre", "apply", "archive-post"]);
    const run = readdirSync(dir).find(name => name !== "progress.json")!;
    const pre = JSON.parse(gunzipSync(readFileSync(join(dir, run, "pre-import.json.gz"))).toString());
    expect(pre).toMatchObject({ modelAllowed: false, model: null, revision: null, protocol: "", modelCalls: 0,
      generationRejections: [{ taskId: selectSummaryTasks([old])[0].taskId, reason: "mechanical_rule_unavailable_model_disabled" }] });
    expect(parseTaskFile(readFileSync(join(dir, run, "model-tasks.jsonl"), "utf8"))).toEqual([]);
    for (const call of vi.mocked(deps.archive).mock.calls) expect(call[3]).toEqual({ deterministic: 1, modelTasks: 0 });
    expect(readdirSync(dir)).not.toContain("pending-write.json");
  });
  it("未対応だけでも成功扱いせず、機械HOLD群のcursorを公平に進める", async () => {
    const original = [row(1), row(2)]; const { deps, rows, events } = dependencies(original); const dir = state();
    for (let i = 0; i < 2; i++) expect(await runLocalSummary({ stateDir: dir, limit: 1 }, deps)).toMatchObject({
      selected: 1, accepted: 0, rejected: 1, held: 1, pendingBefore: 2, pendingAfter: 2,
      outcome: "partial_rejection", modelCalls: 0, modelResidents: 0 });
    expect(deps.generate).not.toHaveBeenCalled(); expect(deps.apply).not.toHaveBeenCalled(); expect(rows()).toEqual(original);
    expect(events).toEqual([]);
    const attempts = readdirSync(dir).filter(name => name !== "progress.json").map(name =>
      parseTaskFile(readFileSync(join(dir, name, "tasks.jsonl"), "utf8"))[0].taskId);
    expect(new Set(attempts).size).toBe(2);
  });
  it("keeps choice/holding/lottery qualifications instead of silently taking a representative benefit", () => {
    expect(missingSummaryConditions("合成商品から選択、1年以上保有、抽選で当選者に贈呈", "商品")).toEqual([
      "choice_condition_missing",
      "holding_condition_missing",
      "lottery_condition_missing",
    ]);
    expect(
      missingSummaryConditions("合成商品から選択、1年以上保有、抽選で当選者に贈呈", "1年以上保有者の抽選、商品を選択"),
    ).toEqual([]);
    expect(missingSummaryConditions("応募者向け合成商品", "商品")).toEqual(["application_condition_missing"]);
    expect(missingSummaryConditions("合成商品から選択", "合成商品から選ぶ")).toEqual([]);
    expect(missingSummaryConditions("合成商品から選択", "合成商品を選び受取")).toEqual([]);
  });
  it("omitted conditions remain unanswered with their previous amount/summary untouched", async () => {
    const old = row(1, {
      description: "合成商品を選択、1年以上継続保有",
      shortSummary: "※旧値",
      estimatedValue: 5000,
      estimateValueSource: "company",
    });
    const { deps, events, rows } = dependencies([old]);
    const dir = state();
    const report = await runLocalSummary({ stateDir: dir, limit: 60, allowModel: true }, deps);
    expect(report).toMatchObject({ accepted: 0, rejected: 1, pendingAfter: 1, outcome: "partial_rejection" });
    expect(deps.apply).not.toHaveBeenCalled();
    expect(rows()[0]).toEqual(old);
    expect(events).toEqual(["generate", "archive-pre"]);
    expect(readdirSync(dir)).not.toContain("pending-write.json");
  });
  it("caps the CLI at60, requires private state, and rejects unknown flags", () => {
    expect(parseLocalArgs(["--state-dir", "/private/unit"])).toMatchObject({
      limit: 60,
      allowModel: false,
    });
    expect(parseLocalArgs(["--state-dir", "/private/unit", "--allow-model"])).toMatchObject({ allowModel: true });
    expect(() => parseLocalArgs(["--state-dir", "/private/unit", "--allow-model=false"])).toThrow();
    for (const limit of ["0", "61", "1.5", "-1", "01"])
      expect(() => parseLocalArgs(["--limit", limit, "--state-dir", "/private/unit"])).toThrow();
    expect(() => parseLocalArgs([])).toThrow();
    expect(() => parseLocalArgs(["--state-dir", "/private/unit", "--show-text"])).toThrow();
  });
  it("rotates rejected first60 so later pending tasks are attempted", () => {
    const tasks = selectSummaryTasks(Array.from({ length: 65 }, (_, i) => row(i + 1)));
    const first = selectFairBatch(tasks, null, 60, tasks);
    const second = selectFairBatch(tasks, first.at(-1)!.taskId, 60, tasks);
    expect(new Set([...first, ...second].map((t) => t.taskId)).size).toBe(65);
    expect(second.slice(0, 5)).toEqual(tasks.slice(60));
  });
  it("continues after an accepted cursor disappears from pending instead of repeating an earlier rejection", async () => {
    const { deps, rows } = dependencies([row(1), row(2), row(3)]);
    const batches: string[][] = [];
    deps.generate = async (path) => {
      const tasks = parseTaskFile(readFileSync(path, "utf8"));
      batches.push(tasks.map(task => task.stockCode));
      const lines = protocol(tasks).trim().split("\n").map(line => JSON.parse(line));
      for (let i = 0; i < tasks.length; i++) {
        if (tasks[i].stockCode === "9001") lines[i + 1].text = '{"shortSummary":"※注記を残す合成商品"}';
      }
      return lines.map(line => JSON.stringify(line)).join("\n");
    };
    const dir = state();
    expect(await runLocalSummary({ stateDir: dir, limit: 2, allowModel: true }, deps)).toMatchObject({ accepted: 1, rejected: 1, pendingAfter: 2 });
    expect(selectSummaryTasks(rows()).map(task => task.stockCode)).toEqual(["9001", "9003"]);
    expect(await runLocalSummary({ stateDir: dir, limit: 2, allowModel: true }, deps)).toMatchObject({ accepted: 1, rejected: 1, pendingAfter: 1 });
    expect(batches).toEqual([["9001", "9002"], ["9003", "9001"]]);
    expect(rows()[0]).toEqual(row(1));
  });
  it("does not permit the generator to supply any amount or a substituted task", () => {
    const tasks = selectSummaryTasks([row()]);
    expect(
      buildLocalResults(tasks, protocol(tasks, '{"shortSummary":"商品券","estimatedValue":99999}'))
        .generationRejections,
    ).toEqual([{ taskId: tasks[0].taskId, reason: "generated_schema" }]);
    expect(() => buildLocalResults(tasks, protocol(tasks).replace(tasks[0].taskId, "f".repeat(16)))).toThrow("binding");
    expect(() => buildLocalResults(tasks, protocol(tasks).replace(SEMIF_HF_REVISION, "f".repeat(40)))).toThrow(
      "binding",
    );
  });
  it("takes only uniquely qualified company amounts; discount/tier/missing remain explicitNULL", () => {
    const task = selectSummaryTasks([row()])[0];
    expect(companyValue(task)).toEqual({
      value: 3000,
      reason: "qualified_company_per_grant",
    });
    const discount = { ...task, description: "合成レストラン 20%割引券 2枚" };
    expect(companyValue(discount)).toEqual({
      value: null,
      reason: "no_source_yen_amount",
    });
    expect(
      companyValue({
        ...task,
        recipients: [...task.recipients, { minShares: 200, recordMonth: 3, recordDate: null }],
      }),
    ).toEqual({ value: null, reason: "mixed_share_context" });
  });
  it("reports input/output limits as unanswered instead of truncating or fabricating a result", () => {
    const tasks = selectSummaryTasks([row()]);
    const input = [
      ready,
      {
        taskId: tasks[0].taskId,
        error: "input_token_limit",
        inputTokens: 16001,
      },
    ]
      .map((v) => JSON.stringify(v))
      .join("\n");
    expect(buildLocalResults(tasks, input)).toMatchObject({
      resultsText: "",
      modelCalls: 0,
      generationRejections: [{ reason: "input_token_limit" }],
    });
    expect(buildLocalResults(tasks, protocol(tasks).replace('"stop"', '"length"'))).toMatchObject({
      resultsText: "",
      modelCalls: 1,
    });
  });
  it("empty pending work never starts a generator, archive, or writer", async () => {
    const { deps } = dependencies([row(1, { shortSummary: "商品券 3,000円分" })]);
    expect(await runLocalSummary({ stateDir: state(), limit: 60 }, deps)).toMatchObject({
      outcome: "empty",
      modelCalls: 0,
    });
    expect(deps.generate).not.toHaveBeenCalled();
    expect(deps.archive).not.toHaveBeenCalled();
    expect(deps.apply).not.toHaveBeenCalled();
  });
  it("physical pre readback precedes atomic import, and post readback precedes completion", async () => {
    const { deps, events } = dependencies([row(1, { description: "QUOカード 3,000円分" })]);
    const dir = state();
    expect(await runLocalSummary({ stateDir: dir, limit: 60 }, deps)).toMatchObject({
      accepted: 1,
      rejected: 0,
      pendingAfter: 0,
    });
    expect(events).toEqual(["archive-pre", "apply", "archive-post"]);
    expect(readdirSync(dir)).not.toContain("pending-write.json");
    const run = readdirSync(dir).find((name) => name !== "progress.json")!;
    expect(statSync(join(dir, run)).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, run, "generation.jsonl")).mode & 0o777).toBe(0o600);
  });
  it("unknown pre archive retains the latch; next execution performs no read, generation, archive, or mutation", async () => {
    const { deps } = dependencies([row(1, { description: "QUOカード 3,000円分" })]);
    const dir = state();
    deps.archive = vi.fn(async () => {
      expect(statSync(join(dir, "pending-write.json")).mode & 0o777).toBe(0o600);
      throw new Error("unknown_archive");
    });
    await expect(runLocalSummary({ stateDir: dir, limit: 60 }, deps)).rejects.toThrow("unknown_archive");
    expect(deps.apply).not.toHaveBeenCalled();
    expect(readdirSync(dir)).not.toContain("progress.json");
    expect(readdirSync(dir)).toContain("pending-write.json");
    vi.mocked(deps.loadRows).mockClear();
    vi.mocked(deps.generate).mockClear();
    vi.mocked(deps.archive).mockClear();
    await expect(runLocalSummary({ stateDir: dir, limit: 60 }, deps)).rejects.toThrow("previous_write_unresolved");
    expect(deps.loadRows).not.toHaveBeenCalled();
    expect(deps.generate).not.toHaveBeenCalled();
    expect(deps.archive).not.toHaveBeenCalled();
    expect(deps.apply).not.toHaveBeenCalled();
  });
  it("partial rejection retains the previous row and records remaining work", async () => {
    const old = row(2, {
      shortSummary: "※旧値",
      estimatedValue: 5000,
      estimateValueSource: "company",
    });
    const { deps, rows } = dependencies([row(), old]);
    deps.generate = async (path) => {
      const tasks = parseTaskFile(readFileSync(path, "utf8"));
      const lines = protocol(tasks)
        .trim()
        .split("\n")
        .map((v) => JSON.parse(v));
      lines[2].text = '{"shortSummary":"架空の追加10%割引"}';
      return lines.map((v) => JSON.stringify(v)).join("\n");
    };
    expect(await runLocalSummary({ stateDir: state(), limit: 60, allowModel: true }, deps)).toMatchObject({
      outcome: "partial_rejection",
      accepted: 1,
      rejected: 1,
      pendingAfter: 1,
    });
    expect(rows()[1]).toEqual(old);
  });
  it("stale recipient context is rejected before writing", async () => {
    const { deps } = dependencies([row()]);
    let reads = 0;
    deps.loadRows = async () => [row(1, { minShares: ++reads === 1 ? 100 : 200 })];
    expect(await runLocalSummary({ stateDir: state(), limit: 60, allowModel: true }, deps)).toMatchObject({ rejected: 1, accepted: 0 });
    expect(deps.apply).not.toHaveBeenCalled();
  });
  it("unknown apply keeps a durable latch; later automatic execution has no D1/model call", async () => {
    const { deps } = dependencies([row(1, { description: "QUOカード 3,000円分" })]);
    deps.apply = vi.fn(async () => {
      throw new Error("unknown_write");
    });
    const dir = state();
    await expect(runLocalSummary({ stateDir: dir, limit: 60 }, deps)).rejects.toThrow("unknown_write");
    vi.mocked(deps.loadRows).mockClear();
    vi.mocked(deps.generate).mockClear();
    await expect(runLocalSummary({ stateDir: dir, limit: 60 }, deps)).rejects.toThrow("previous_write_unresolved");
    expect(deps.loadRows).not.toHaveBeenCalled();
    expect(deps.generate).not.toHaveBeenCalled();
  });
  it("a known but mismatched POST cannot release the latch or declare success", async () => {
    const { deps } = dependencies([row(1, { description: "QUOカード 3,000円分" })]);
    deps.apply = vi.fn(async () => {});
    const dir = state();
    await expect(runLocalSummary({ stateDir: dir, limit: 60 }, deps)).rejects.toThrow("summary_post_mismatch");
    expect(readdirSync(dir)).toContain("pending-write.json");
    expect(deps.archive).toHaveBeenCalledTimes(1);
  });
});
