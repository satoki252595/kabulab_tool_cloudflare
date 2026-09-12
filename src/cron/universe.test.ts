import { describe, expect, it } from "vitest";
import {
  assertUniverseCoverage,
  coverageDenominator,
  instrumentTypeBackfilled,
  shouldDeactivateUniverseCode,
} from "./universe.js";

describe("assertUniverseCoverage", () => {
  it("2026-06-30 JPX実件数と直近D1 active件数を受理する", () => {
    expect(() =>
      assertUniverseCoverage(4_437, 3_709, 3_718, 0)
    ).not.toThrow();
  });

  it("raw・対象株の部分取得と既存母集団からの異常縮小をmutation前に拒否する", () => {
    expect(() => assertUniverseCoverage(3_900, 3_709, 3_718, 0)).toThrow(
      "JPX listing"
    );
    expect(() => assertUniverseCoverage(4_437, 200, 3_718, 0)).toThrow(
      "安全下限"
    );
    expect(() => assertUniverseCoverage(4_437, 3_600, 3_718, 0)).toThrow(
      "98% 未満"
    );
  });

  it("195銘柄規模の対象外化候補をupsert前に拒否する", () => {
    expect(() => assertUniverseCoverage(4_437, 3_709, 3_718, 195)).toThrow(
      "対象外化候補"
    );
  });
});

/**
 * 移行 P4b (ETF/ETN/PRO/外国株 +725 行) 後の母集団を想定した回帰。
 * 実際に月次で throw するのはこちら (kabulab-cf) 側なので、stockStock 側
 * (`universe_guards.py`) と同じ分母・同じ縮退でなければ母集団同期が止まる。
 */
describe("assertUniverseCoverage: instrument_type の分母 (移行 P4b 対向)", () => {
  /** P4b 後の実測見込み: active 4,440 (= 内国普通株 3,700 + 非株式 740)。 */
  const P4B_ACTIVE = 4_440;
  const P4B_EQUITY_ACTIVE = 3_700;

  it("P4b 後の母集団を equity の分母で受理する (分母が active 全体なら 0.833 で落ちていた)", () => {
    expect(() =>
      assertUniverseCoverage(4_437, 3_700, P4B_ACTIVE, 0, {
        existingEquityActiveCount: P4B_EQUITY_ACTIVE,
        pendingDeactivationEquityCount: 0,
      })
    ).not.toThrow();
    // 分母を渡さない = 従来どおり active 全体。P4b では必ず throw する
    // (= 揃えないと毎月止まる、を固定しておく)。
    expect(() =>
      assertUniverseCoverage(4_437, 3_700, P4B_ACTIVE, 0)
    ).toThrow("98% 未満");
  });

  it("instrument_type が全 NULL の遷移期は従来の分母へ縮退する (fail-closed)", () => {
    // 充填前の active 3,715 は集合として内国普通株とほぼ一致するので通る。
    expect(() =>
      assertUniverseCoverage(4_437, 3_709, 3_718, 0, {
        existingEquityActiveCount: 0,
        pendingDeactivationEquityCount: 0,
      })
    ).not.toThrow();
    // 未充填のまま P4b を実行すると 0.833 で止まる。これが fail-closed の実体。
    expect(() =>
      assertUniverseCoverage(4_437, 3_700, P4B_ACTIVE, 0, {
        existingEquityActiveCount: 0,
        pendingDeactivationEquityCount: 0,
      })
    ).toThrow("未充填");
  });

  it("部分充填の equity 件数を分母にして fail-open しない", () => {
    // 充填が 500 件で止まった状態。equity を分母にすると 3,100/500 = 6.2 で
    // 0.98 を割らず、実際は 3,100/4,440 = 0.698 の部分取得を素通ししてしまう。
    expect(() =>
      assertUniverseCoverage(4_437, 3_100, P4B_ACTIVE, 0, {
        existingEquityActiveCount: 500,
        pendingDeactivationEquityCount: 0,
      })
    ).toThrow("部分充填");
  });

  it("部分充填の equity 件数を分母にした (d2) の誤発火もさせない", () => {
    // 11/500 = 2.2% で止まるが、実母集団に対しては 11/3,700 = 0.3%。
    // 被覆率側が通る入力 (equityCount=3,700) で (d2) だけを見る。
    expect(() =>
      assertUniverseCoverage(4_437, 3_700, P4B_ACTIVE, 11, {
        existingEquityActiveCount: 500,
        pendingDeactivationEquityCount: 11,
      })
    ).toThrow("部分充填");
    // 充填済みなら同じ 11 件は 0.3% なので当然通る。
    expect(() =>
      assertUniverseCoverage(4_437, 3_700, P4B_ACTIVE, 11, {
        existingEquityActiveCount: P4B_EQUITY_ACTIVE,
        pendingDeactivationEquityCount: 11,
      })
    ).not.toThrow();
  });

  it("(d1) を通り抜ける内国普通株の大量対象外化を (d2) が止める", () => {
    // 75 件は active 全体 4,440 の 1.69% なので (d1) は通る。P4b で実効上限が
    // 74 → 88 件へ緩んだ分がここ。equity 3,700 に対しては 2.02% で (d2) が止める。
    expect(() =>
      assertUniverseCoverage(4_437, 3_700, P4B_ACTIVE, 75, {
        existingEquityActiveCount: P4B_EQUITY_ACTIVE,
        pendingDeactivationEquityCount: 75,
      })
    ).toThrow("内国普通株の対象外化候補");
    // 境界 (74/3,700 = ちょうど 2%) は通す。比較の向きを移植元と揃える。
    expect(() =>
      assertUniverseCoverage(4_437, 3_700, P4B_ACTIVE, 74, {
        existingEquityActiveCount: P4B_EQUITY_ACTIVE,
        pendingDeactivationEquityCount: 74,
      })
    ).not.toThrow();
  });

  it("equity が active 全体を超える入力は部分集合違反として先に止める", () => {
    expect(() =>
      assertUniverseCoverage(4_437, 3_709, 3_718, 0, {
        existingEquityActiveCount: 3_719,
      })
    ).toThrow("部分集合");
  });

  it("初回 seed (existing=0) は移植元どおり (c)(d) を丸ごとスキップする", () => {
    expect(() =>
      assertUniverseCoverage(4_437, 3_709, 0, 0, {
        existingEquityActiveCount: 0,
        pendingDeactivationEquityCount: 0,
      })
    ).not.toThrow();
  });
});

describe("instrumentTypeBackfilled / coverageDenominator", () => {
  it("未観測・未充填・部分充填を 1 つの述語で束ねる", () => {
    expect(instrumentTypeBackfilled(null)).toBe(false);
    expect(instrumentTypeBackfilled(undefined)).toBe(false);
    expect(instrumentTypeBackfilled(0)).toBe(false);
    expect(instrumentTypeBackfilled(2_999)).toBe(false);
    // 下限は MIN_EQUITY_ROWS と同じ 3,000 (新しい数字を発明していない)
    expect(instrumentTypeBackfilled(3_000)).toBe(true);
  });

  it("分母を選んだ理由をラベルで返す (0.833 の原因が読めるように)", () => {
    expect(coverageDenominator(4_440, null)).toEqual({
      value: 4_440,
      label: expect.stringContaining("未観測"),
    });
    expect(coverageDenominator(4_440, 0).value).toBe(4_440);
    expect(coverageDenominator(4_440, 500).label).toContain("部分充填");
    expect(coverageDenominator(4_440, 3_700)).toEqual({
      value: 3_700,
      label: "active かつ equity",
    });
  });
});

describe("shouldDeactivateUniverseCode", () => {
  const currentJpxCodes = new Set(["9432", "25935"]);

  it("JPXに存在する通常株をactiveのまま保持する", () => {
    expect(shouldDeactivateUniverseCode("9432", currentJpxCodes)).toBe(false);
  });

  it("JPX不在銘柄と共有コード契約外の5桁種類株を対象外化する", () => {
    expect(shouldDeactivateUniverseCode("1449", currentJpxCodes)).toBe(true);
    expect(shouldDeactivateUniverseCode("25935", currentJpxCodes)).toBe(true);
  });
});
