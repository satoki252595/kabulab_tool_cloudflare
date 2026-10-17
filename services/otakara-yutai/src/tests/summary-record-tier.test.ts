import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import { headedDescription } from "../../data-scripts/estimated-value-guard.js";
import { buildPublicBenefitFacts } from "../../data-scripts/public-facts.js";
import { compileSimpleSummary, companyValue } from "../../data-scripts/summary-local.js";
import { planSummaryImport } from "../../data-scripts/summary-import.js";
import { selectSummaryTasks, type BenefitRow } from "../../data-scripts/summary-tasks.js";
import saved from "./fixtures/record-tier-saved1.json";

const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const privatePath = join(ROOT, "tmp/yutai-record-tier-proof-v1/saved1.private.json");
// 文法の境界用入力。実制度・実掲載文や本番データではない。
const body = ["【1年未満保有株主】", "2,000円相当", "【1年以上保有株主】", "5,000円相当",
  "■継続保有期間について", "1年以上継続保有:株主名簿に3回以上記載または記録", "",
  "■贈呈時期", "毎年3月下旬発送予定"].join("\n");
const description = headedDescription("オリジナルQUOカード", body);
const row = (text: string): BenefitRow => ({ id: 49050, stockId: 1, stockCode: "1899", stockName: "",
  description: text, shortSummary: null, estimatedValue: null, estimateValueSource: null,
  minShares: 200, recordMonth: 12, recordDate: null, updatedAt: 1791162691 });
const compile = (text: string) => compileSimpleSummary(selectSummaryTasks([row(text)])[0]);

describe("全文で対応した保有2tierと名簿記録条件の定型要約", () => {
  it("両期間・両額面と名簿回数を保持し、単一評価額を選ばず正常取込を通す", () => {
    const rows = [row(description)];
    const tasks = selectSummaryTasks(rows);
    const result = compileSimpleSummary(tasks[0]);
    expect(result).toMatchObject({ shortSummary: saved.expectedSummary, estimatedValue: null });
    expect(companyValue(tasks[0])).toEqual({ value: null, reason: "ambiguous_condition_tiers" });
    const plan = planSummaryImport({ tasks, currentRows: rows, resultsText: JSON.stringify(result) });
    expect(plan.rejections).toEqual([]);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].estimatedValue).toBeNull();
    expect(rows[0]).toEqual(row(description));
  });

  it("コードや原文SHAへ固定せず、全文の期間と回数をcaptureする", () => {
    const changed = description.replaceAll("1年", "2年").replace("3回", "5回");
    const task = selectSummaryTasks([{ ...row(changed), stockCode: "1301" }])[0];
    const result = compileSimpleSummary(task);
    expect(result?.shortSummary).toBe("保有2年未満はQUOカード2,000円相当、2年以上は5,000円相当（継続・株主名簿5回以上）");
    expect(result?.shortSummary).not.toContain("同一");
    expect(result?.shortSummary).not.toContain("連続");
    expect(result?.estimatedValue).toBeNull();
  });

  it("株数・本人資格・同一名義・併用・別tier・未知注記を部分抽出で成功化しない", () => {
    for (const suffix of ["\n同一名義に限る", "\n同一株主番号で連続3回", "\n併用可", "\n300株以上",
      "\n【3年以上保有株主】\n10,000円相当", "\n申込が必要", "\n※その他の条件あり"]) {
      expect(compile(description + suffix)).toBeNull();
    }
    for (const changed of [description.replace("【1年以上", "【2年以上"), description.replace("1年以上継続", "2年以上継続"),
      description.replace("未満", "以下"), description.replace("3回以上", "3回以下"), description.replace("記載または記録", "連続記録"),
      description.replace("毎年3月", "毎年13月"), description.replace("下旬発送予定", "下旬又は4月予定"),
      description.replace("QUOカード", "未知の商品"), description.replace("2,000円", "2,00円"),
      description.replace("2,000円", "約2,000円"), description.replace("2,000円", "2,000ポイント"),
      description.replace("3回", "0回"), description.replace("2,000円", "0円"), description.replaceAll("1年", "01年"),
      description.replaceAll("1年", "9007199254740992年")]) {
      expect(compile(changed)).toBeNull();
    }
  });

  it("同額・安全整数外・60字を超える額面は既存金額guardや要約契約を迂回しない", () => {
    expect(compile(description.replace("2,000円", "5,000円"))).toBeNull();
    expect(compile(description.replace("2,000円", "9,007,199,254,740,992円"))).toBeNull();
    expect(compile(description.replace("2,000円", "999,999,999,999,999円").replace("5,000円", "888,888,888,888,888円"))).toBeNull();
  });

  it("掲載2期間と名簿定義は構造化し、本人適用と評価額は未資格のまま保つ", () => {
    const facts = buildPublicBenefitFacts({ code: "1899", description, context: { minShares: [200], recordMonths: [12] },
      fetchedAt: null, batchFetchedAt: null });
    expect(facts).toMatchObject({ version: 4, qualifiedAmount: null, valueReasons: ["ambiguous_condition_tiers"],
      holdingPeriods: ["1年未満", "1年以上"], combination: "unverified", conditionStructure: { status: "literal_parsed", applicability: "unverified",
        ast: { registryDefinition: { continuousHoldingPeriod: "1年以上", minimumEntries: 3, entryMeaning: "listed_or_recorded" }, shipment: { month: 3, part: "下旬", status: "planned" } } } });
  });

  it.skipIf(!existsSync(privatePath))("保存実1899全文・1行を通常compilerと原子取込plannerへ通す", () => {
    const bytes = readFileSync(privatePath);
    expect(hash(bytes)).toBe(saved.provenance.privateFixtureSha256);
    const original = JSON.parse(bytes.toString()) as { key: string; description: string; rows: BenefitRow[] };
    expect(hash(original.description)).toBe(saved.provenance.sourceSha256);
    expect(original.key).toBe(saved.provenance.sourceGroup);
    const tasks = selectSummaryTasks(original.rows, { retaskKeys: new Set([original.key]) });
    expect(tasks).toHaveLength(1);
    const result = compileSimpleSummary(tasks[0]);
    expect(result).toMatchObject({ shortSummary: saved.expectedSummary, estimatedValue: null });
    const plan = planSummaryImport({ tasks, currentRows: original.rows, resultsText: JSON.stringify(result) });
    expect(plan.rejections).toEqual([]);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].estimatedValue).toBeNull();
    expect(tasks[0].recipients).toEqual(saved.recipients);
  });
});
