/** Actual source projections; full descriptions remain in the ignored private proof. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import { parseBenefitHoldingStructure } from "../../data-scripts/holding-structure.js";
import { buildPublicBenefitFacts } from "../../data-scripts/public-facts.js";
import { compileSimpleSummary } from "../../data-scripts/summary-local.js";
import { selectSummaryTasks, type BenefitRow } from "../../data-scripts/summary-tasks.js";
import { planSummaryImport } from "../../data-scripts/summary-import.js";
import { parsePublicBenefitFacts } from "../public-facts.js";
import { renderBenefitFacts } from "../../app.js";
import { headedDescription } from "../../data-scripts/estimated-value-guard.js";
import saved from "./fixtures/holding-period-saved4.json";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
// 文法の境界用入力。実制度・実掲載文として扱わない。
const description = headedDescription("オンラインショップ・クーポン（長期保有者向け）", ["【半年以上保有】", "1,000円相当"].join("\n"));
const build = (text: string) => buildPublicBenefitFacts({ code: "2282", description: text,
  context: { minShares: [300], recordMonths: [3] }, fetchedAt: null, batchFetchedAt: null });
const privatePath = join(ROOT, "tmp/yutai-holding-audit-v1/saved4.private.json");
const privateGroups = (): { stockCode: string; sourceGroup: string; sourceDescription: string; sourceSha256: string; rows: (BenefitRow & { publicFacts: string })[] }[] => {
  const bytes = readFileSync(privatePath);
  expect(hash(bytes.toString())).toBe(saved.provenance.privateFixtureSha256);
  return JSON.parse(bytes.toString()).groups;
};
describe("保存全文の単一保有期間と掲載特典", () => {
  it("実4群の公開投影は掲載額・枚数だけをstrict再読し、原文を含めない", () => {
    expect(saved.groups.map(group => group.code)).toEqual(["2282", "2282", "2282", "9048"]);
    for (const group of saved.groups) {
      const facts = { ...group.oldFacts, version: 3, conditionStructure: { status: "literal_parsed", rule: "single-holding-period-v1", sourceSha256: group.sourceSha256, applicability: "unverified", ast: group.ast } };
      expect(parsePublicBenefitFacts(facts, group.code)).toEqual(facts);
      expect(renderBenefitFacts(parsePublicBenefitFacts(facts)!, null)).toContain("本人・株数・同じ株主番号での継続条件は未確認");
    }
    expect(JSON.stringify(saved)).not.toContain("sourceDescription");
    expect(JSON.stringify(saved)).not.toContain("リトルワールド");
  });

  it.skipIf(!existsSync(privatePath))("実4全文を資格化し、旧1回額・理由・掲載時計・条件を保持する", () => {
    for (const group of privateGroups()) {
      expect(hash(group.sourceDescription)).toBe(group.sourceSha256);
      const old = parsePublicBenefitFacts(group.rows[0].publicFacts, group.stockCode)!;
      const facts = buildPublicBenefitFacts({ code: group.stockCode, description: group.sourceDescription,
        context: { minShares: group.rows.map(row => row.minShares), recordMonths: group.rows.map(row => row.recordMonth) },
        fetchedAt: old.source.fetchedAt, batchFetchedAt: old.source.batchFetchedAt });
      expect(facts.version).toBe(3);
      expect(parsePublicBenefitFacts(JSON.stringify(facts), group.stockCode)).toEqual(facts);
      const { version: _version, conditionStructure: _structure, ...unchanged } = facts as Extract<typeof facts, { version: 3 }>;
      const { version: _oldVersion, ...oldFields } = old;
      expect(unchanged).toEqual(oldFields);
      expect(facts).toMatchObject({ conditionStructure: { status: "literal_parsed", applicability: "unverified", sourceSha256: group.sourceSha256 } });
      const html = renderBenefitFacts(facts, null);
      expect(html).toContain("本人・株数・同じ株主番号での継続条件は未確認");
      if (group.stockCode === "2282") {
        expect(facts).toMatchObject({ qualifiedAmount: old.qualifiedAmount, valueStatus: "source_amount_qualified",
          conditionStructure: { ast: { holdingPeriod: "半年以上", benefit: { kind: "coupon", listedYen: old.qualifiedAmount, notation: "相当" } } } });
      } else {
        expect(facts).toMatchObject({ qualifiedAmount: null, valueStatus: "unresolved",
          conditionStructure: { ast: { holdingPeriod: "1年以上", benefit: { kind: "admission_tickets", quantity: 6, unit: "枚" } } } });
        expect(html).not.toContain("リトルワールド");
      }
    }
  });

  it.skipIf(!existsSync(privatePath))("実全文を通常compiler/importへ渡し、原文のない期間・金額を補完しない", () => {
    for (const group of privateGroups()) {
      const rows = group.rows as BenefitRow[];
      const tasks = selectSummaryTasks(rows, { retaskKeys: new Set([group.sourceGroup]) });
      expect(tasks).toHaveLength(1);
      const compiled = compileSimpleSummary(tasks[0]);
      expect(compiled).not.toBeNull();
      expect(compiled!.shortSummary).toContain(group.stockCode === "2282" ? "半年以上保有" : "1年以上保有");
      expect(compiled!.estimatedValue).toBe(parsePublicBenefitFacts(group.rows[0].publicFacts)!.qualifiedAmount);
      const plan = planSummaryImport({ tasks, currentRows: rows, resultsText: JSON.stringify(compiled) });
      expect(plan.rejections).toEqual([]);
      expect(plan.updates).toHaveLength(1);
      expect(plan.updates[0].estimatedValue).toBe(compiled!.estimatedValue);
    }
  });

  it("同株主番号・記録回数・別期間・tier・追加・併用・未知注記は部分抽出せず未解析にする", () => {
    expect(build(description)).toMatchObject({ version: 3, qualifiedAmount: 1000, conditionStructure: { ast: { holdingPeriod: "半年以上" } } });
    for (const text of [description, ...(existsSync(privatePath) ? privateGroups().map(group => group.sourceDescription) : [])]) {
      for (const changed of [
        text + "\n※同じ株主番号での継続が必要",
        text + "\n※3回連続の株主名簿記載が必要",
        text + "\n3年以上保有の場合は追加",
        text + "\n併用可",
        text + "\n300株以上 1,000円相当",
        text.replace("長期保有者向け", "未確認の対象"),
        text.replace("以上保有】", "未満保有】"),
        text.replace(/([0-9]),([0-9]{3})円相当/u, "$1,$2ポイント"),
      ]) {
        if (changed === text) continue;
        expect(parseBenefitHoldingStructure(changed)).toBeNull();
      }
    }
  });

  it("strict DTOは適用済み・未知構造・条件の不一致・金額昇格を拒否する", () => {
    const facts = build(description);
    if (facts.version !== 3) throw new Error("saved holding literal required");
    for (const changed of [
      { ...facts, conditionStructure: { ...facts.conditionStructure, applicability: "verified" } },
      { ...facts, conditionStructure: { ...facts.conditionStructure, sourceSha256: "unknown" } },
      { ...facts, conditionStructure: { ...facts.conditionStructure, extra: "unqualified" } },
      { ...facts, holdingPeriods: ["1年以上"] },
      { ...facts, combination: "allowed" },
      { ...facts, choice: true },
      { ...facts, qualifiedAmount: 9999 },
      { ...facts, conditionStructure: { ...facts.conditionStructure, ast: { holdingPeriod: "半年以上", benefit: { kind: "coupon", listedYen: 0, notation: "相当" } } } },
    ]) expect(() => parsePublicBenefitFacts(changed)).toThrow();
  });
});
