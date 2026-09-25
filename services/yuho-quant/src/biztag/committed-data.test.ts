/**
 * リポジトリに同梱した運用データ (ゴールデンセット v1・較正値) が読めることの固定テスト。
 * どちらも実在の有報の原文とゴールデンセットの実測から作った値 (docs/005-yuho-quant-business-tags.md §10・§11.4)。
 */
import { loadGoldenSet } from "./golden.js";
import { loadCalibration } from "./thresholds.js";

describe("同梱データ", () => {
  it("ゴールデンセット v1 が形・不変条件の検査を通る", () => {
    const g = loadGoldenSet();
    expect(g.version).toBe("v1");
    expect(g.vocabVersion).toBe("v1");
    const pairs = g.items.flatMap((i) => i.expect);
    expect(pairs.length).toBe(858);
    // 依頼文の「当てたい例」の代表 (味の素の ABF・日本製鋼所の防衛) が含まれる
    const mustHit = new Set(
      g.items.flatMap((i) => i.expect.filter((e) => e.mustHit).map((e) => `${i.code}:${e.termId}`))
    );
    expect(mustHit.has("2802:B.SEMI.PACKAGE_MATERIAL")).toBe(true);
    expect(mustHit.has("5631:B.DEF.DEFENSE_EQUIPMENT")).toBe(true);
  });

  it("較正値は版を固定したモデル名と 0 < noMax < yesMin < 1", () => {
    const c = loadCalibration();
    expect(c.model).toMatch(/^jev-\d+\.\d+\.\d+$/);
    expect(c.model).not.toBe("jev-latest");
    expect(c.thresholds.noMax).toBeGreaterThan(0);
    expect(c.thresholds.noMax).toBeLessThan(c.thresholds.yesMin);
    expect(c.thresholds.yesMin).toBeLessThan(1);
  });
});
