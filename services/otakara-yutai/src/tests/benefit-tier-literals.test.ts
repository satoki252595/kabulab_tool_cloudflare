import { describe, expect, it } from "vitest";
import { headedDescription } from "../../data-scripts/estimated-value-guard.js";
import { buildPublicBenefitFacts } from "../../data-scripts/public-facts.js";
import { extractBenefitTierLiterals } from "../../data-scripts/record-tier-structure.js";
import { parsePublicBenefitFacts } from "../public-facts.js";
import { renderBenefitFacts } from "../../app.js";

// 文法境界の入力。掲載事実・実銘柄の優待額としては使用しない。
describe("期間直後の独立した円額行", () => {
  it("重なる3期間を独立に保持し、同一名義等の残条件や受取額を推定しない", () => {
    const text = headedDescription("QUOカード", "【半年以上保有】\n1,000円相当\n【1年以上保有株主】\n2,000円分\n【3年以上保有株主】\n3,000円相当\n※同一株主番号で継続保有が必要");
    const facts = buildPublicBenefitFacts({ code: "1899", description: text, context: { minShares: [100], recordMonths: [3] }, fetchedAt: null, batchFetchedAt: null });
    expect(facts.version).toBe(5);
    if (facts.version !== 5) throw new Error("tier literals required");
    expect(facts.conditionStructure.ast).toEqual({ tiers: [
      { ordinal: 1, holdingPeriod: "半年以上", listedYen: 1000, notation: "相当" },
      { ordinal: 2, holdingPeriod: "1年以上", listedYen: 2000, notation: "分" },
      { ordinal: 3, holdingPeriod: "3年以上", listedYen: 3000, notation: "相当" },
    ], combinationClauses: [], remainingConditionLines: 1 });
    expect(facts.qualifiedAmount).toBeNull();
    expect(parsePublicBenefitFacts(JSON.stringify(facts), "1899")).toEqual(facts);
    expect(renderBenefitFacts(facts, null)).toContain("追加条件は1行が未解析");
    expect(() => parsePublicBenefitFacts({ ...facts, conditionStructure: { ...facts.conditionStructure, applicability: "verified" } })).toThrow();
    expect(() => parsePublicBenefitFacts({ ...facts, conditionStructure: { ...facts.conditionStructure, ast: { ...facts.conditionStructure.ast, remainingConditionLines: -1 } } })).toThrow();
  });

  it("年間額・選択額・割引額・注記・離れた額を直結しない", () => {
    for (const body of ["【1年以上保有】\n1,000円相当（年間2,000円）", "【1年以上保有】\n1,000円分または2,000円分", "【1年以上保有】\n1,000円割引", "【1年以上保有】\n※条件あり\n1,000円分", "【1年以上保有】\n0円分"]) {
      expect(extractBenefitTierLiterals(headedDescription("QUOカード", body))).toBeNull();
    }
  });

  it("券の利用と複数特典の受取を区別し、条件付き・否定の含意を推定しない", () => {
    const text = headedDescription("割引券", "※他の割引サービスとの併用可。\n※3、他の優待券等との併用はできない。\n※併用できない場合がある");
    expect(extractBenefitTierLiterals(text)?.ast).toEqual({ tiers: [], combinationClauses: [
      { scope: "coupon_use", counterpart: "other_discount", allowed: true },
      { scope: "coupon_use", counterpart: "other_coupon", allowed: false },
    ], remainingConditionLines: 1 });
    for (const line of ["他の割引との併用可能ではない", "他の割引との併用できない場合がある", "他の特典との併用可", "併用型を採用"]) {
      expect(extractBenefitTierLiterals(headedDescription("割引券", line))).toBeNull();
    }
    const facts = buildPublicBenefitFacts({ code: "1899", description: text, context: { minShares: [100], recordMonths: [3] }, fetchedAt: null, batchFetchedAt: null });
    expect(facts).toMatchObject({ version: 5, holding: false, combination: "unverified" });
    expect(parsePublicBenefitFacts(facts)).toEqual(facts);
  });
});
