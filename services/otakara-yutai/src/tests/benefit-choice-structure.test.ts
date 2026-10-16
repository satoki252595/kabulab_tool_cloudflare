/** Actual source projection + labelled grammar mutations; no network/model/production writes. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import { parseBenefitChoiceStructure } from "../../data-scripts/choice-structure.js";
import { buildPublicBenefitFacts } from "../../data-scripts/public-facts.js";
import { headedDescription } from "../../data-scripts/estimated-value-guard.js";
import { compileSimpleSummary } from "../../data-scripts/summary-local.js";
import { selectSummaryTasks, type BenefitRow } from "../../data-scripts/summary-tasks.js";
import { planSummaryImport } from "../../data-scripts/summary-import.js";
import { parsePublicBenefitFacts } from "../public-facts.js";
import { renderBenefitFacts } from "../../app.js";
import saved from "./fixtures/choice-list-saved15.json";

// 文法の境界用入力であり、実制度・実掲載文として扱わない。
const body = "◆以下より1点を選択\n1、カタログギフト 1,000円相当\n2、食事券 2,000円分";
const description = headedDescription("カタログギフトまたは食事券", body);
const build = (text: string) => buildPublicBenefitFacts({ code: "7203", description: text,
  context: { minShares: [100], recordMonths: [3] }, fetchedAt: null, batchFetchedAt: null });

describe("全文に束縛した1点選択の構造", () => {
  it("記載額・単位を選択肢に保ち、評価額や合計額にしない", () => {
    const facts = build(description);
    expect(facts).toMatchObject({ version: 2, qualifiedAmount: null, valueStatus: "unresolved",
      conditionStructure: { status: "literal_parsed", sourceSha256: createHash("sha256").update(description).digest("hex"),
        ast: { take: 1, options: [{ ordinal: 1, listedYen: 1000, notation: "相当" }, { ordinal: 2, listedYen: 2000, notation: "分" }] } } });
    expect(parsePublicBenefitFacts(JSON.stringify(facts), "7203")).toEqual(facts);
    const html = renderBenefitFacts(facts, null);
    expect(html).toContain("2選択肢から1点を選択");
    expect(html).toContain("保有期間別・併用の構造は未解析");
    expect(html).not.toContain("カタログギフト");
    expect(html).not.toContain("2,000円");
  });

  it("旧v1を改変せず読み、未知構造・番号・単位・額の昇格を拒否する", () => {
    const { conditionStructure: structure, ...legacyFields } = build(description) as Extract<ReturnType<typeof build>, { version: 2 }>;
    const legacy = { ...legacyFields, version: 1 };
    expect(parsePublicBenefitFacts(legacy)).toEqual(legacy);
    if (structure.status !== "literal_parsed") throw new Error("literal grammar required");
    const facts = build(description);
    for (const invalid of [
      { ...facts, version: 3 }, { ...facts, version: 1 },
      { ...facts, qualifiedAmount: 1000, valueStatus: "source_amount_qualified", valueReasons: ["qualified_company_per_grant"] },
      { ...facts, conditionStructure: { ...structure, sourceSha256: "invalid" } },
      { ...facts, conditionStructure: { ...structure, label: "原文を持ち込まない" } },
      { ...facts, conditionStructure: { ...structure, ast: { ...structure.ast, take: 2 } } },
      { ...facts, conditionStructure: { ...structure, ast: { ...structure.ast, options: [{ ...structure.ast.options[0], ordinal: 2 }, structure.ast.options[1]] } } },
      { ...facts, conditionStructure: { ...structure, ast: { ...structure.ast, options: [{ ...structure.ast.options[0], notation: "ポイント" }, structure.ast.options[1]] } } },
      { ...facts, conditionStructure: { status: "unparsed", rule: "one-of-list-v1", sourceSha256: structure.sourceSha256, ast: structure.ast, reason: "unsupported_grammar" } },
    ]) expect(() => parsePublicBenefitFacts(invalid)).toThrow();
  });

  it("番号欠け/重複/範囲/注記/非円額/余分な行/未知見出しを全文不一致として保留する", () => {
    for (const text of [
      body.replace("2、", "3、"), body.replace("2、", "1、"), body.replace("1点", "2点"),
      body.replace("1,000円", "1,000〜2,000円"), body.replace("1,000円", "1,00円"),
      body.replace("1,000円", "0円"), body.replace("1,000円", "9007199254740992円"),
      body.replace("2,000円分", "2,000ポイント"), `${body}\n※利用条件あり`, `${body}\n`,
      body.replace("食事券", "未知の商品"), body.replace("食事券", "条件付きネットショップポイント"), body.replace("2、食事券", "2、食事券\n"),
    ]) {
      // 末尾空白だけは同じ全文の表記正規化。他の内容は削除しない。
      if (text === `${body}\n`) expect(parseBenefitChoiceStructure(headedDescription("カタログギフトまたは食事券", text)).status).toBe("literal_parsed");
      else expect(parseBenefitChoiceStructure(headedDescription("カタログギフトまたは食事券", text)).status).toBe("unparsed");
    }
    for (const text of [description + "\n1年以上保有", description + "\n併用可", description + "\n抽選", description + "\n申込必要",
      headedDescription("保有期間別の選択", body), headedDescription("カタログギフトまたは株主優待券", body),
      headedDescription("カタログギフトまたは食事券", body + "\n3、株主優待券 3,000円分"), body, '【種別：壊れた値】\n' + body]) {
      expect(parseBenefitChoiceStructure(text).status).toBe("unparsed");
    }
  });

  it("実3issuer15群の公開投影は原文を含まず、全ordinal/掲載額/単位をstrict再読できる", () => {
    expect(saved.groups).toHaveLength(15);
    expect([...new Set(saved.groups.map(row => row.code))]).toEqual(["3148", "7585", "8278"]);
    expect(saved.groups.reduce((n, row) => n + row.rows, 0)).toBe(19);
    for (const row of saved.groups) {
      const base = build(description);
      const facts = { ...base, source: { ...base.source, listingUrl: `https://minkabu.jp/stock/${row.code}/yutai` }, sourceGroup: row.taskId, conditionStructure: { status: "literal_parsed", rule: "one-of-list-v1", sourceSha256: row.sourceSha256, ast: row.ast } };
      expect(parsePublicBenefitFacts(facts, row.code)?.version).toBe(2);
    }
    expect(JSON.stringify(saved)).not.toContain("sourceDescription");
  });

  const privateProof = join(ROOT, "tmp/choice-grammar-proof-v1/result.private.json");
  it.skipIf(!existsSync(privateProof))("保存実15群を同producer/parser/normalimportへ通し、額NULLと有効summaryのskipを維持する", () => {
    const bytes = readFileSync(privateProof);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(saved.provenance.qualificationProofSha256);
    const proof = JSON.parse(bytes.toString()) as { candidates: { taskId: string; sourceDescription: string }[] };
    for (const row of saved.groups) {
      const raw = proof.candidates.find(v => v.taskId === row.taskId);
      if (raw === undefined) throw new Error("saved source missing");
      expect(parseBenefitChoiceStructure(raw.sourceDescription)).toEqual({ status: "literal_parsed", rule: "one-of-list-v1", sourceSha256: row.sourceSha256, ast: row.ast });
      const sourceRows: BenefitRow[] = row.recipients.map((recipient, index) => ({ ...recipient, id: index + 1, stockId: 1,
        stockCode: row.code, stockName: "", description: raw.sourceDescription, shortSummary: null, estimatedValue: null, estimateValueSource: null, updatedAt: 0 }));
      const tasks = selectSummaryTasks(sourceRows);
      expect(tasks).toHaveLength(1);
      const result = compileSimpleSummary(tasks[0]);
      expect(result).toMatchObject({ shortSummary: "優待を1点選択", estimatedValue: null });
      const plan = planSummaryImport({ tasks, currentRows: sourceRows, resultsText: JSON.stringify(result) });
      expect(plan.rejections).toEqual([]);
      expect(plan.updates).toHaveLength(1);
      expect(plan.updates[0].estimatedValue).toBeNull();
      expect(selectSummaryTasks(sourceRows.map(value => ({ ...value, shortSummary: "優待を1点選択" })))).toEqual([]);
    }
  });
});
