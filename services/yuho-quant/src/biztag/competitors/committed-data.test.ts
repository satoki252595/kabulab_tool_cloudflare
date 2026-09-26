/**
 * リポジトリに同梱した運用データ (評価セット v1・較正値) が読めることの固定テスト。
 * どちらも実在の有報の原文と評価セットの実測から作った値
 * (docs/005-yuho-quant-business-tags.md「競合他社」節 §12.4)。
 * biztag 本体の committed-data.test.ts と同じ精神。
 */
import { loadCompetitorCalibration } from "./calibration.js";
import { loadCompetitorEvalSet } from "./evalset.js";

describe("同梱データ (競合他社)", () => {
  it("評価セット v1 が形・不変条件の検査を通る", () => {
    const evalSet = loadCompetitorEvalSet();
    expect(evalSet.version).toBe("v1");
    expect(Object.keys(evalSet.companies).length).toBeGreaterThanOrEqual(70);
    expect(evalSet.pairs.length).toBeGreaterThanOrEqual(100);
    // 依頼にあった代表的な組が含まれる
    const keys = new Set(evalSet.pairs.map((p) => [p.a, p.b].sort().join(":")));
    expect(keys.has(["7203", "7267"].sort().join(":"))).toBe(true); // トヨタ⇔本田技研 (自動車)
    expect(keys.has(["5108", "5101"].sort().join(":"))).toBe(true); // ブリヂストン⇔横浜ゴム (タイヤ)
  });

  it("較正値は版を固定したモデル名と 0 < noMax < yesMin < 1", () => {
    const c = loadCompetitorCalibration();
    expect(c.model).toMatch(/^jev-\d+\.\d+\.\d+$/);
    expect(c.model).not.toBe("jev-latest");
    expect(c.thresholds.noMax).toBeGreaterThan(0);
    expect(c.thresholds.noMax).toBeLessThan(c.thresholds.yesMin);
    expect(c.thresholds.yesMin).toBeLessThan(1);
    expect(c.candidateTopK).toBeGreaterThan(0);
    expect(c.candidateVersion).toMatch(/^cand-v\d+$/);
  });
});
