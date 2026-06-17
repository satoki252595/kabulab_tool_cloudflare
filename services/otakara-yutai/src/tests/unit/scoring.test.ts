import { describe, it, expect } from "vitest";
import {
  calculateFundamentalScore,
  calculateTechnicalScore,
  calculateTotalScore,
  scoreStock,
} from "../../../../../src/shared/scoring.js";
import type { ScoringInput } from "../../../../../src/shared/scoring.js";

/** テスト用デフォルトデータ */
function makeInput(overrides: Record<string, number | null> = {}): ScoringInput {
  return {
    price: 1000,
    per: 12,
    pbr: 0.8,
    dividendYield: 3.5,
    roe: null,
    ma5: 1010,
    ma25: 1050,
    ma75: 1100,
    rsi14: 45,
    macd: null,
    macdSignal: null,
    yutaiYield: null,
    ...overrides,
  } as ScoringInput;
}

// =============================================================
// ファンダメンタルズスコア算出
// =============================================================
describe("calculateFundamentalScore", () => {
  // --- PER 境界値テスト ---
  describe("PERスコア", () => {
    it("PER < 10 → 100点", () => {
      const result = calculateFundamentalScore(makeInput({ per: 9.9 }));
      expect(result.details.perScore).toBe(100);
    });

    it("PER = 10 → 80点", () => {
      const result = calculateFundamentalScore(makeInput({ per: 10 }));
      expect(result.details.perScore).toBe(80);
    });

    it("PER = 14.9 → 80点", () => {
      const result = calculateFundamentalScore(makeInput({ per: 14.9 }));
      expect(result.details.perScore).toBe(80);
    });

    it("PER = 15 → 60点", () => {
      const result = calculateFundamentalScore(makeInput({ per: 15 }));
      expect(result.details.perScore).toBe(60);
    });

    it("PER = 19.9 → 60点", () => {
      const result = calculateFundamentalScore(makeInput({ per: 19.9 }));
      expect(result.details.perScore).toBe(60);
    });

    it("PER = 20 → 40点", () => {
      const result = calculateFundamentalScore(makeInput({ per: 20 }));
      expect(result.details.perScore).toBe(40);
    });

    it("PER = 29.9 → 40点", () => {
      const result = calculateFundamentalScore(makeInput({ per: 29.9 }));
      expect(result.details.perScore).toBe(40);
    });

    it("PER = 30 → 20点", () => {
      const result = calculateFundamentalScore(makeInput({ per: 30 }));
      expect(result.details.perScore).toBe(20);
    });

    it("PER = 50 → 20点", () => {
      const result = calculateFundamentalScore(makeInput({ per: 50 }));
      expect(result.details.perScore).toBe(20);
    });

    it("PER = null → 0点", () => {
      const result = calculateFundamentalScore(makeInput({ per: null }));
      expect(result.details.perScore).toBe(0);
    });
  });

  // --- PBR 境界値テスト ---
  describe("PBRスコア", () => {
    it("PBR < 0.5 → 100点", () => {
      const result = calculateFundamentalScore(makeInput({ pbr: 0.49 }));
      expect(result.details.pbrScore).toBe(100);
    });

    it("PBR = 0.5 → 80点", () => {
      const result = calculateFundamentalScore(makeInput({ pbr: 0.5 }));
      expect(result.details.pbrScore).toBe(80);
    });

    it("PBR = 0.99 → 80点", () => {
      const result = calculateFundamentalScore(makeInput({ pbr: 0.99 }));
      expect(result.details.pbrScore).toBe(80);
    });

    it("PBR = 1.0 → 60点", () => {
      const result = calculateFundamentalScore(makeInput({ pbr: 1.0 }));
      expect(result.details.pbrScore).toBe(60);
    });

    it("PBR = 1.49 → 60点", () => {
      const result = calculateFundamentalScore(makeInput({ pbr: 1.49 }));
      expect(result.details.pbrScore).toBe(60);
    });

    it("PBR = 1.5 → 40点", () => {
      const result = calculateFundamentalScore(makeInput({ pbr: 1.5 }));
      expect(result.details.pbrScore).toBe(40);
    });

    it("PBR = 1.99 → 40点", () => {
      const result = calculateFundamentalScore(makeInput({ pbr: 1.99 }));
      expect(result.details.pbrScore).toBe(40);
    });

    it("PBR = 2.0 → 20点", () => {
      const result = calculateFundamentalScore(makeInput({ pbr: 2.0 }));
      expect(result.details.pbrScore).toBe(20);
    });

    it("PBR = 5.0 → 20点", () => {
      const result = calculateFundamentalScore(makeInput({ pbr: 5.0 }));
      expect(result.details.pbrScore).toBe(20);
    });

    it("PBR = null → 0点", () => {
      const result = calculateFundamentalScore(makeInput({ pbr: null }));
      expect(result.details.pbrScore).toBe(0);
    });
  });

  // --- 配当利回り 境界値テスト ---
  describe("配当利回りスコア", () => {
    it("利回り > 5% → 100点", () => {
      const result = calculateFundamentalScore(
        makeInput({ dividendYield: 5.1 })
      );
      expect(result.details.dividendYieldScore).toBe(100);
    });

    it("利回り = 5% → 80点 (4-5%の範囲)", () => {
      const result = calculateFundamentalScore(
        makeInput({ dividendYield: 5.0 })
      );
      expect(result.details.dividendYieldScore).toBe(80);
    });

    it("利回り = 4% → 80点", () => {
      const result = calculateFundamentalScore(
        makeInput({ dividendYield: 4.0 })
      );
      expect(result.details.dividendYieldScore).toBe(80);
    });

    it("利回り = 4.9 → 80点", () => {
      const result = calculateFundamentalScore(
        makeInput({ dividendYield: 4.9 })
      );
      expect(result.details.dividendYieldScore).toBe(80);
    });

    it("利回り = 3% → 60点", () => {
      const result = calculateFundamentalScore(
        makeInput({ dividendYield: 3.0 })
      );
      expect(result.details.dividendYieldScore).toBe(60);
    });

    it("利回り = 3.9 → 60点", () => {
      const result = calculateFundamentalScore(
        makeInput({ dividendYield: 3.9 })
      );
      expect(result.details.dividendYieldScore).toBe(60);
    });

    it("利回り = 2% → 40点", () => {
      const result = calculateFundamentalScore(
        makeInput({ dividendYield: 2.0 })
      );
      expect(result.details.dividendYieldScore).toBe(40);
    });

    it("利回り = 1% → 20点", () => {
      const result = calculateFundamentalScore(
        makeInput({ dividendYield: 1.0 })
      );
      expect(result.details.dividendYieldScore).toBe(20);
    });

    it("利回り = 0.5% → 10点", () => {
      const result = calculateFundamentalScore(
        makeInput({ dividendYield: 0.5 })
      );
      expect(result.details.dividendYieldScore).toBe(10);
    });

    it("利回り = 0% → 10点", () => {
      const result = calculateFundamentalScore(
        makeInput({ dividendYield: 0 })
      );
      expect(result.details.dividendYieldScore).toBe(10);
    });

    it("利回り = null → 0点", () => {
      const result = calculateFundamentalScore(
        makeInput({ dividendYield: null })
      );
      expect(result.details.dividendYieldScore).toBe(0);
    });
  });

  // --- 加重平均スコア ---
  describe("加重平均スコア", () => {
    it("PER=5(100), PBR=0.3(100), 利回り=6%(100), ROE=20%(100), 優待=6%(100) → スコア100", () => {
      const result = calculateFundamentalScore(
        makeInput({ per: 5, pbr: 0.3, dividendYield: 6, roe: 0.20, yutaiYield: 6 })
      );
      expect(result.score).toBe(100);
    });

    it("PER=50(20), PBR=5(20), 利回り=0.5%(10), ROE/優待null → nullの重みを按分して16.43", () => {
      const result = calculateFundamentalScore(
        makeInput({ per: 50, pbr: 5, dividendYield: 0.5 })
      );
      // 有効重み=0.25+0.2+0.25=0.7, 按分: 20*(0.25/0.7)+20*(0.2/0.7)+10*(0.25/0.7)=16.43
      expect(result.score).toBeCloseTo(16.43, 1);
    });

    it("全てnull → スコア0", () => {
      const result = calculateFundamentalScore(
        makeInput({ per: null, pbr: null, dividendYield: null, roe: null, yutaiYield: null })
      );
      expect(result.score).toBe(0);
    });
  });
});

// =============================================================
// テクニカルスコア算出
// =============================================================
describe("calculateTechnicalScore", () => {
  // --- MA乖離率 境界値テスト ---
  describe("MA乖離率スコア", () => {
    it("乖離率 < -10% → 100点", () => {
      // price=880, ma25=1000 → deviation = -12%
      const result = calculateTechnicalScore(
        makeInput({ price: 880, ma25: 1000 })
      );
      expect(result.details.maDeviationScore).toBe(100);
    });

    it("乖離率 = -10% → 80点", () => {
      // price=900, ma25=1000 → deviation = -10%
      const result = calculateTechnicalScore(
        makeInput({ price: 900, ma25: 1000 })
      );
      expect(result.details.maDeviationScore).toBe(80);
    });

    it("乖離率 = -5% → 60点", () => {
      // price=950, ma25=1000 → deviation = -5%
      const result = calculateTechnicalScore(
        makeInput({ price: 950, ma25: 1000 })
      );
      expect(result.details.maDeviationScore).toBe(60);
    });

    it("乖離率 = -7% → 80点", () => {
      // price=930, ma25=1000 → deviation = -7%
      const result = calculateTechnicalScore(
        makeInput({ price: 930, ma25: 1000 })
      );
      expect(result.details.maDeviationScore).toBe(80);
    });

    it("乖離率 = 0% → 40点", () => {
      const result = calculateTechnicalScore(
        makeInput({ price: 1000, ma25: 1000 })
      );
      expect(result.details.maDeviationScore).toBe(40);
    });

    it("乖離率 = 3% → 40点", () => {
      const result = calculateTechnicalScore(
        makeInput({ price: 1030, ma25: 1000 })
      );
      expect(result.details.maDeviationScore).toBe(40);
    });

    it("乖離率 = 5% → 20点", () => {
      const result = calculateTechnicalScore(
        makeInput({ price: 1050, ma25: 1000 })
      );
      expect(result.details.maDeviationScore).toBe(20);
    });

    it("乖離率 = 10% → 20点", () => {
      const result = calculateTechnicalScore(
        makeInput({ price: 1100, ma25: 1000 })
      );
      expect(result.details.maDeviationScore).toBe(20);
    });

    it("price = null → 0点", () => {
      const result = calculateTechnicalScore(
        makeInput({ price: null, ma25: 1000 })
      );
      expect(result.details.maDeviationScore).toBe(0);
    });

    it("ma25 = null → 0点", () => {
      const result = calculateTechnicalScore(
        makeInput({ price: 1000, ma25: null })
      );
      expect(result.details.maDeviationScore).toBe(0);
    });

    it("ma25 = 0 → 0点 (ゼロ除算回避)", () => {
      const result = calculateTechnicalScore(
        makeInput({ price: 1000, ma25: 0 })
      );
      expect(result.details.maDeviationScore).toBe(0);
    });
  });

  // --- RSI 境界値テスト ---
  describe("RSIスコア", () => {
    it("RSI < 30 → 100点", () => {
      const result = calculateTechnicalScore(makeInput({ rsi14: 25 }));
      expect(result.details.rsiScore).toBe(100);
    });

    it("RSI = 30 → 80点", () => {
      const result = calculateTechnicalScore(makeInput({ rsi14: 30 }));
      expect(result.details.rsiScore).toBe(80);
    });

    it("RSI = 39.9 → 80点", () => {
      const result = calculateTechnicalScore(makeInput({ rsi14: 39.9 }));
      expect(result.details.rsiScore).toBe(80);
    });

    it("RSI = 40 → 60点", () => {
      const result = calculateTechnicalScore(makeInput({ rsi14: 40 }));
      expect(result.details.rsiScore).toBe(60);
    });

    it("RSI = 50 → 40点", () => {
      const result = calculateTechnicalScore(makeInput({ rsi14: 50 }));
      expect(result.details.rsiScore).toBe(40);
    });

    it("RSI = 60 → 20点", () => {
      const result = calculateTechnicalScore(makeInput({ rsi14: 60 }));
      expect(result.details.rsiScore).toBe(20);
    });

    it("RSI = 70 → 10点", () => {
      const result = calculateTechnicalScore(makeInput({ rsi14: 70 }));
      expect(result.details.rsiScore).toBe(10);
    });

    it("RSI = 85 → 10点", () => {
      const result = calculateTechnicalScore(makeInput({ rsi14: 85 }));
      expect(result.details.rsiScore).toBe(10);
    });

    it("RSI = null → 0点", () => {
      const result = calculateTechnicalScore(makeInput({ rsi14: null }));
      expect(result.details.rsiScore).toBe(0);
    });
  });

  // --- 加重平均スコア ---
  describe("加重平均スコア", () => {
    it("MA乖離率=100, RSI=100, MACD=100 → スコア100", () => {
      // price=850, ma25=1000 → deviation=-15% (100pts), rsi14=20 (100pts)
      // macd=-5 > macdSignal=-10 かつ両方<0 → 100pts
      const result = calculateTechnicalScore(
        makeInput({ price: 850, ma25: 1000, rsi14: 20, macd: -5, macdSignal: -10 })
      );
      expect(result.score).toBe(100);
    });

    it("全てnull → スコア0", () => {
      const result = calculateTechnicalScore(
        makeInput({ price: null, ma25: null, rsi14: null, macd: null, macdSignal: null })
      );
      expect(result.score).toBe(0);
    });
  });
});

// =============================================================
// 総合スコア算出
// =============================================================
describe("calculateTotalScore", () => {
  it("ファンダメンタル100, テクニカル100 → 100", () => {
    expect(calculateTotalScore(100, 100)).toBe(100);
  });

  it("ファンダメンタル0, テクニカル0 → 0", () => {
    expect(calculateTotalScore(0, 0)).toBe(0);
  });

  it("ファンダメンタル80, テクニカル60 → 80*0.6+60*0.4=72", () => {
    expect(calculateTotalScore(80, 60)).toBe(72);
  });

  it("ファンダメンタル50, テクニカル50 → 50", () => {
    expect(calculateTotalScore(50, 50)).toBe(50);
  });

  it("ファンダメンタル100, テクニカル0 → 60", () => {
    expect(calculateTotalScore(100, 0)).toBe(60);
  });

  it("ファンダメンタル0, テクニカル100 → 40", () => {
    expect(calculateTotalScore(0, 100)).toBe(40);
  });
});

// =============================================================
// scoreStock — 統合テスト
// =============================================================
describe("scoreStock", () => {
  it("全データ揃っている場合、ScoreBreakdownを返す", () => {
    const input = makeInput({
      per: 12,
      pbr: 0.8,
      dividendYield: 3.5,
      roe: 0.12,
      price: 950,
      ma25: 1000,
      rsi14: 35,
      macd: -5,
      macdSignal: -10,
      yutaiYield: 3.0,
    });
    const result = scoreStock(input);

    expect(result.fundamentalScore).toBeGreaterThan(0);
    expect(result.technicalScore).toBeGreaterThan(0);
    expect(result.totalScore).toBeGreaterThan(0);
    expect(result.details).toHaveProperty("perScore");
    expect(result.details).toHaveProperty("pbrScore");
    expect(result.details).toHaveProperty("dividendYieldScore");
    expect(result.details).toHaveProperty("roeScore");
    expect(result.details).toHaveProperty("yutaiYieldScore");
    expect(result.details).toHaveProperty("maDeviationScore");
    expect(result.details).toHaveProperty("rsiScore");
    expect(result.details).toHaveProperty("macdScore");
  });

  it("具体的なスコア計算が正しい（null指標の重みは按分）", () => {
    // PER=12 → 80, PBR=0.8 → 80, Dividend=3.5 → 60, ROE=null, 優待=null
    // 有効重み=0.25+0.2+0.25=0.7, fundamental=80*(0.25/0.7)+80*(0.2/0.7)+60*(0.25/0.7)=72.86
    // price=950, ma25=1000 → deviation=-5% → 60, RSI=35 → 80, MACD=null
    // 有効重み=0.45+0.35=0.8, technical=60*(0.45/0.8)+80*(0.35/0.8)=68.75
    // total = 72.86*0.6 + 68.75*0.4 = 71.22
    const input = makeInput({
      per: 12,
      pbr: 0.8,
      dividendYield: 3.5,
      price: 950,
      ma25: 1000,
      rsi14: 35,
    });
    const result = scoreStock(input);

    expect(result.fundamentalScore).toBeCloseTo(72.86, 1);
    expect(result.technicalScore).toBe(68.75);
    expect(result.totalScore).toBeCloseTo(71.22, 0);
    expect(result.details.perScore).toBe(80);
    expect(result.details.pbrScore).toBe(80);
    expect(result.details.dividendYieldScore).toBe(60);
    expect(result.details.roeScore).toBe(0);
    expect(result.details.yutaiYieldScore).toBe(0);
    expect(result.details.maDeviationScore).toBe(60);
    expect(result.details.rsiScore).toBe(80);
    expect(result.details.macdScore).toBe(0);
  });

  it("全てnullの場合、スコアは全て0", () => {
    const input: ScoringInput = {
      price: null,
      per: null,
      pbr: null,
      dividendYield: null,
      roe: null,
      ma5: null,
      ma25: null,
      ma75: null,
      rsi14: null,
      macd: null,
      macdSignal: null,
      yutaiYield: null,
    };
    const result = scoreStock(input);

    expect(result.fundamentalScore).toBe(0);
    expect(result.technicalScore).toBe(0);
    expect(result.totalScore).toBe(0);
    expect(result.details.perScore).toBe(0);
    expect(result.details.pbrScore).toBe(0);
    expect(result.details.dividendYieldScore).toBe(0);
    expect(result.details.roeScore).toBe(0);
    expect(result.details.yutaiYieldScore).toBe(0);
    expect(result.details.maDeviationScore).toBe(0);
    expect(result.details.rsiScore).toBe(0);
    expect(result.details.macdScore).toBe(0);
  });
});

// =============================================================
// エッジケース
// =============================================================
describe("エッジケース", () => {
  it("負のPER値でも正しくスコアリングされる", () => {
    const result = calculateFundamentalScore(makeInput({ per: -5 }));
    // 負のPER → PER < 10 に該当 → 100点
    expect(result.details.perScore).toBe(100);
  });

  it("負のPBR値でも正しくスコアリングされる", () => {
    const result = calculateFundamentalScore(makeInput({ pbr: -0.5 }));
    // 負のPBR → PBR < 0.5 に該当 → 100点
    expect(result.details.pbrScore).toBe(100);
  });

  it("負の配当利回りでも正しくスコアリングされる", () => {
    const result = calculateFundamentalScore(
      makeInput({ dividendYield: -1 })
    );
    // 負 → < 1% に該当 → 10点
    expect(result.details.dividendYieldScore).toBe(10);
  });

  it("負のRSI値でも正しくスコアリングされる", () => {
    const result = calculateTechnicalScore(makeInput({ rsi14: -5 }));
    // 負のRSI → RSI < 30 に該当 → 100点
    expect(result.details.rsiScore).toBe(100);
  });

  it("price=0, ma25=1000でも正しく計算される", () => {
    // deviation = (0 - 1000) / 1000 = -100% → 100点
    const result = calculateTechnicalScore(
      makeInput({ price: 0, ma25: 1000 })
    );
    expect(result.details.maDeviationScore).toBe(100);
  });

  it("非常に大きなPER値でも正しくスコアリングされる", () => {
    const result = calculateFundamentalScore(makeInput({ per: 10000 }));
    expect(result.details.perScore).toBe(20);
  });

  it("スコアは常に0〜100の範囲内", () => {
    const extremeInput = makeInput({
      per: -100,
      pbr: -50,
      dividendYield: 100,
      price: 1,
      ma25: 10000,
      rsi14: 0,
    });
    const result = scoreStock(extremeInput);
    expect(result.fundamentalScore).toBeGreaterThanOrEqual(0);
    expect(result.fundamentalScore).toBeLessThanOrEqual(100);
    expect(result.technicalScore).toBeGreaterThanOrEqual(0);
    expect(result.technicalScore).toBeLessThanOrEqual(100);
    expect(result.totalScore).toBeGreaterThanOrEqual(0);
    expect(result.totalScore).toBeLessThanOrEqual(100);
  });
});

// scoreAllStocks の DB 連携テストは Drizzle のクエリビルダ全体をモックする
// 必要があり、CLAUDE.md の "no mocks / 必ず実データを使う" ルールに反する。
// 実 DB を使う integration test として再実装するまで削除する。
// scoring の純粋関数 (calculateFundamentalScore / calculateTechnicalScore /
// scoreStock) は上の describe ブロックで十分にカバーされている。
