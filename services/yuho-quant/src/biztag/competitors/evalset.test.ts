import { describe, expect, it } from "vitest";
import { assertEvalSetInvariants, evalPairKey, loadCompetitorEvalSet, type CompetitorEvalSet } from "./evalset.js";

function baseSet(): CompetitorEvalSet {
  return {
    version: "v1",
    createdAt: "2026-09-26",
    companies: {
      "0001": { name: "会社A", sector33: null, docId: "d1", periodEnd: "2026-03-31", group: "g", quote: "実在の引用文" },
      "0002": { name: "会社B", sector33: null, docId: "d2", periodEnd: "2026-03-31", group: "g", quote: "実在の引用文2" },
    },
    pairs: [{ a: "0001", b: "0002", label: true, category: "same_market_substitute", reason: "同じ市場の競合" }],
  };
}

describe("evalPairKey", () => {
  it("向きに依らず同じキー", () => {
    expect(evalPairKey({ a: "0001", b: "0002" })).toBe(evalPairKey({ a: "0002", b: "0001" }));
  });
});

describe("assertEvalSetInvariants", () => {
  it("正常なセットは通す", () => {
    expect(() => assertEvalSetInvariants(baseSet())).not.toThrow();
  });

  it("自己参照の組は throw", () => {
    const s = baseSet();
    s.pairs.push({ a: "0001", b: "0001", label: true, category: "same_market_substitute", reason: "x" });
    expect(() => assertEvalSetInvariants(s)).toThrow(/自己参照/);
  });

  it("companies に無いコードを参照したら throw", () => {
    const s = baseSet();
    s.pairs.push({ a: "0001", b: "9999", label: true, category: "same_market_substitute", reason: "x" });
    expect(() => assertEvalSetInvariants(s)).toThrow(/companies に無い/);
  });

  it("重複した組は throw", () => {
    const s = baseSet();
    s.pairs.push({ a: "0002", b: "0001", label: true, category: "same_market_substitute", reason: "x" });
    expect(() => assertEvalSetInvariants(s)).toThrow(/重複/);
  });

  it("same_market_substitute は label=true でなければ throw", () => {
    const s = baseSet();
    s.pairs[0].label = false;
    expect(() => assertEvalSetInvariants(s)).toThrow(/same_market_substitute/);
  });

  it("same_market_substitute 以外は label=false でなければ throw", () => {
    const s = baseSet();
    s.pairs[0].category = "unrelated";
    expect(() => assertEvalSetInvariants(s)).toThrow(/unrelated/);
  });
});

describe("loadCompetitorEvalSet", () => {
  it("同梱の v1.json を読み込める (形・不変条件を通る)", () => {
    const evalSet = loadCompetitorEvalSet();
    expect(evalSet.version).toBe("v1");
    expect(evalSet.pairs.length).toBeGreaterThan(0);
    expect(Object.keys(evalSet.companies).length).toBeGreaterThan(0);
  });
});
