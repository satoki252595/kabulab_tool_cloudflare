/**
 * 月次スコア再構築の純関数テスト。
 *
 * 優待利回りは「保有しているだけで確実に受け取れる価値 / 最低投資額」を
 * 意図しているが、実際には**条件付きの優待**（住宅購入時のキャッシュバック、
 * 車リース契約時のキャッシュバック、抽選の商品券）が確定価値として合算され、
 * 本番のスクリーニング上位が実在しない利回りで占められていた。
 */
import { describe, expect, it } from "vitest";

import { YUTAI_YIELD_MAX_PCT, calcYutaiYield } from "./monthly.js";

describe("calcYutaiYield", () => {
  it("最低単元での年間価値を利回りにする", () => {
    // 1,000円 × 100株 = 100,000円 に対し年 2,000円 → 2%
    expect(
      calcYutaiYield(1000, [
        { minShares: 100, estimatedValue: 1000 },
        { minShares: 100, estimatedValue: 1000 },
      ]),
    ).toBeCloseTo(2, 10);
  });

  it("最低単元を超える段階の優待は分子に入れない", () => {
    expect(
      calcYutaiYield(1000, [
        { minShares: 100, estimatedValue: 1000 },
        { minShares: 1000, estimatedValue: 90000 },
      ]),
    ).toBeCloseTo(1, 10);
  });

  it("価値が算定できる最小の保有段階で計算する", () => {
    // 呼び出し側が estimated_value NULL の行を除いて渡す前提。
    // 100株の優待が金額換算不能なら 500株段階での利回りになる
    expect(
      calcYutaiYield(100, [{ minShares: 500, estimatedValue: 5000 }]),
    ).toBeCloseTo(10, 10);
  });

  describe("実在しない利回りを出さない", () => {
    // 本番で実際にスクリーニング上位に出ていた値
    it.each([
      // 7578: 65円 × 100株 に「50万円相当の商品券贈呈(抽選)」等を年2回合算 → 16,676.9%
      ["7578 抽選の商品券", 65, [{ minShares: 100, estimatedValue: 1084000 }], 16676.9],
      // 3477: 「新築分譲住宅のキャッシュバック20万円」を年2回合算 → 455.3%
      ["3477 住宅購入キャッシュバック", 883, [{ minShares: 100, estimatedValue: 402000 }], 455.3],
      // 5618: 「定額カルモくん申込みで100,000円キャッシュバック」 → 694.2%
      ["5618 リース契約キャッシュバック", 291, [{ minShares: 100, estimatedValue: 202000 }], 694.2],
    ])("%s は値を出さない", (_label, price, benefits, naive) => {
      // 素朴に計算すると桁外れになることを確認してから、null になることを確認する
      const raw =
        benefits.reduce((s, b) => s + (b.estimatedValue ?? 0), 0) /
        (price * Math.min(...benefits.map((b) => b.minShares))) *
        100;
      expect(raw).toBeGreaterThan(YUTAI_YIELD_MAX_PCT);
      expect(Math.round(raw * 10) / 10).toBeCloseTo(naive, 0);
      expect(calcYutaiYield(price, benefits)).toBeNull();
    });

    it("上限ちょうどは通す", () => {
      // 1,000円 × 100株 に対し 50,000円 = ちょうど 50%
      expect(calcYutaiYield(1000, [{ minShares: 100, estimatedValue: 50000 }])).toBeCloseTo(
        YUTAI_YIELD_MAX_PCT,
        10,
      );
    });

    it("上限をわずかに超えたら出さない", () => {
      expect(calcYutaiYield(1000, [{ minShares: 100, estimatedValue: 50001 }])).toBeNull();
    });

    it("本番分布の 98.6% は上限内に収まる", () => {
      // ≤5% が 86.8% / ≤10% が 94.9% / ≤30% が 98.3% / ≤50% が 98.6%（1,261銘柄の実測）
      expect(YUTAI_YIELD_MAX_PCT).toBe(50);
    });
  });

  describe("値を出せない入力", () => {
    it.each([
      ["株価が無い", null, [{ minShares: 100, estimatedValue: 1000 }]],
      ["株価が 0", 0, [{ minShares: 100, estimatedValue: 1000 }]],
      ["株価が負", -1, [{ minShares: 100, estimatedValue: 1000 }]],
      ["優待が無い", 1000, []],
      ["価値が全て NULL", 1000, [{ minShares: 100, estimatedValue: null }]],
      ["価値が 0", 1000, [{ minShares: 100, estimatedValue: 0 }]],
    ])("%s なら null", (_label, price, benefits) => {
      expect(calcYutaiYield(price, benefits)).toBeNull();
    });
  });
});
