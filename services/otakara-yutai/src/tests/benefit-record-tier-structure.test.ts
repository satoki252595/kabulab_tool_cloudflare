import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import { renderBenefitFacts } from "../../app.js";
import { headedDescription } from "../../data-scripts/estimated-value-guard.js";
import { buildPublicBenefitFacts } from "../../data-scripts/public-facts.js";
import { parseBenefitRecordTierStructure } from "../../data-scripts/record-tier-structure.js";
import { parsePublicBenefitFacts } from "../public-facts.js";
import saved from "./fixtures/record-tier-saved1.json";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
// 文法境界用。実掲載文はprivateの保存原本だけを使う。
const body = ["【1年未満保有株主】", "2,000円相当", "【1年以上保有株主】", "5,000円相当",
  "■継続保有期間について", "1年以上継続保有:株主名簿に3回以上記載または記録", "", "■贈呈時期", "毎年3月下旬発送予定"].join("\n");
const description = headedDescription("オリジナルQUOカード", body);
const build = (text: string) => buildPublicBenefitFacts({ code: "1899", description: text,
  context: { minShares: [200], recordMonths: [12] }, fetchedAt: null, batchFetchedAt: null });
const ast = saved.expectedStructure.ast;
const privatePath = join(ROOT, "tmp/yutai-record-tier-proof-v1/saved1.private.json");

describe("全文対応した掲載2期間と名簿定義のv4", () => {
  it("両額面・定義・発送予定を保持し、評価額・本人適用・権利日へ昇格しない", () => {
    const projected = { ...saved.oldFacts, version: 4, conditionStructure: saved.expectedStructure };
    expect(parsePublicBenefitFacts(projected, saved.code)).toEqual(projected);
    expect(JSON.stringify(projected)).not.toContain("description");
    const facts = build(description);
    expect(facts).toMatchObject({ version: 4, sourceGroup: expect.any(String), holdingPeriods: ["1年未満", "1年以上"],
      qualifiedAmount: null, valueStatus: "unresolved", valueReasons: ["ambiguous_condition_tiers"],
      conditionStructure: { status: "literal_parsed", rule: "holding-record-tiers-v1", sourceSha256: hash(description), applicability: "unverified", ast } });
    expect(parsePublicBenefitFacts(JSON.stringify(facts), "1899")).toEqual(facts);
    const html = renderBenefitFacts(facts, null);
    expect(html).toContain("1年未満はQUOカード2,000円相当、1年以上はQUOカード5,000円相当");
    expect(html).toContain("毎年3月下旬発送予定");
    expect(html).toContain("本人・株数・同じ名義や連続記録の条件は未確認");
    expect(html).toContain("株主名簿は会社が株主の氏名や保有株数等を登録する名簿");
    expect(html).toContain("名義は登録された名前、連続記録は記録が途切れないこと");
    expect(html).toContain("会社の公式情報との照合は未実施");
    expect(html).not.toContain("適用済み");
  });

  it("不完全・逆順・閾値不一致・余分な条件から対応を推測しない", () => {
    for (const changed of [
      description.replace("【1年未満保有株主】\n2,000円相当\n【1年以上保有株主】\n5,000円相当", "【1年以上保有株主】\n5,000円相当\n【1年未満保有株主】\n2,000円相当"),
      description.replace("■継続保有期間について\n1年以上継続保有:株主名簿に3回以上記載または記録\n\n", ""),
      description.replace("【1年以上", "【2年以上"),
      description.replace("1年以上継続", "2年以上継続"),
      description.replace("記載または記録", "同一株主番号で連続記録"),
      description.replace("5,000円相当", "5,000円分"),
      description + "\n申込が必要", description + "\n併用可", description + "\n300株以上", description + "\n※その他条件あり",
    ]) {
      expect(parseBenefitRecordTierStructure(changed)).toBeNull();
      expect(build(changed).version).not.toBe(4);
    }
  });

  it("公開DTOの逆順・定義先・名簿回数・発送月・本人資格・単一金額の改変を拒否する", () => {
    const facts = build(description);
    if (facts.version !== 4) throw new Error("two-period literal required");
    const structure = facts.conditionStructure;
    for (const changed of [
      { ...facts, conditionStructure: { ...structure, applicability: "verified" } },
      { ...facts, conditionStructure: { ...structure, sourceSha256: "unknown" } },
      { ...facts, holdingPeriods: ["1年以上", "1年未満"] },
      { ...facts, qualifiedAmount: 5000, valueStatus: "source_amount_qualified", valueReasons: ["qualified_company_per_grant"] },
      { ...facts, combination: "allowed" },
      ...[
        { ...ast, tiers: [...ast.tiers].reverse() },
        { ...ast, tiers: [ast.tiers[0]] },
        { ...ast, tiers: [ast.tiers[0], { ...ast.tiers[1], holdingPeriod: "2年以上" }] },
        { ...ast, tiers: [ast.tiers[0], { ...ast.tiers[1], listedYen: 2000 }] },
        { ...ast, registryDefinition: { ...ast.registryDefinition, continuousHoldingPeriod: "1年未満" } },
        { ...ast, registryDefinition: { ...ast.registryDefinition, minimumEntries: 0 } },
        { ...ast, registryDefinition: { ...ast.registryDefinition, consecutive: true } },
        { ...ast, shipment: { ...ast.shipment, month: 13 } },
        { ...ast, shipment: { ...ast.shipment, status: "confirmed" } },
      ].map(ast => ({ ...facts, conditionStructure: { ...structure, ast } })),
    ]) expect(() => parsePublicBenefitFacts(changed)).toThrow();
  });

  it.skipIf(!existsSync(privatePath))("保存実1899全文の1行だけ構造化し、旧全値・時計・要約を保持する", () => {
    const bytes = readFileSync(privatePath);
    expect(hash(bytes)).toBe(saved.provenance.privateFixtureSha256);
    const original = JSON.parse(bytes.toString());
    expect(hash(original.description)).toBe(saved.provenance.sourceSha256);
    expect(original.key).toBe(saved.provenance.sourceGroup);
    const row = original.rows[0];
    const old = parsePublicBenefitFacts(row.publicFacts, "1899")!;
    const before = JSON.stringify(original);
    const facts = buildPublicBenefitFacts({ code: "1899", description: original.description,
      context: { minShares: [row.minShares], recordMonths: [row.recordMonth] }, fetchedAt: old.source.fetchedAt, batchFetchedAt: old.source.batchFetchedAt });
    expect(facts.version).toBe(4);
    if (facts.version !== 4) throw new Error("saved two-period literal required");
    expect(facts.conditionStructure.ast).toEqual(ast);
    const { conditionStructure: _structure, ...fields } = facts;
    expect({ ...fields, version: 1 }).toEqual(old);
    expect(JSON.stringify(original)).toBe(before);
  });
});
