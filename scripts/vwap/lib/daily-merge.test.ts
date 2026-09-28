import { describe, expect, it } from "vitest";
import { mergeDailySplits } from "./daily-merge.js";
import { jstDate } from "../../../src/shared/yahoo/client.js";

/**
 * R2 daily splits の窓マージ (F-09)。
 *
 * 実原本: 2026-09-28 観測の Yahoo chart 5y 応答 (私的 capture) に
 * 7203 の 5:1 分割イベント (ts=1632873600) が含まれる。一方 R2 の
 * `daily/7203.json` は 1mo 差分更新の全置換で `splits: []` まで縮退した。
 * 窓外の実履歴は保持し、窓内は fresh を正とする。
 */

// 7203 の実分割 (Yahoo events.splits の原本値)。日付変換は本番と同じ jstDate。
const REAL_SPLIT_TS = 1632873600;
const REAL_SPLIT = { date: jstDate(REAL_SPLIT_TS), ratio: 5 };

describe("mergeDailySplits", () => {
  it("実分割の前提: 7203 の 5:1 は 2021-09-29 (JST) に変換される", () => {
    expect(REAL_SPLIT).toEqual({ date: "2021-09-29", ratio: 5 });
  });

  it("1mo 更新 (fresh splits 空) でも窓外の実履歴を保持する (F-09)", () => {
    const merged = mergeDailySplits(
      [REAL_SPLIT],
      [],
      "2026-08-28",
      "2026-09-25"
    );
    expect(merged).toEqual([REAL_SPLIT]);
  });

  it("窓内の新規分割は fresh から取り込む", () => {
    const fresh = [{ date: "2026-09-10", ratio: 2 }];
    const merged = mergeDailySplits(
      [REAL_SPLIT],
      fresh,
      "2026-08-28",
      "2026-09-25"
    );
    expect(merged).toEqual([REAL_SPLIT, ...fresh]);
  });

  it("窓内の訂正は fresh が正 (同日は fresh 優先)", () => {
    const merged = mergeDailySplits(
      [{ date: "2026-09-10", ratio: 10 }],
      [{ date: "2026-09-10", ratio: 2 }],
      "2026-08-28",
      "2026-09-25"
    );
    expect(merged).toEqual([{ date: "2026-09-10", ratio: 2 }]);
  });

  it("窓内の陳腐イベントは fresh が空なら落ちる (bars ありの正の空)", () => {
    const merged = mergeDailySplits(
      [REAL_SPLIT, { date: "2026-09-10", ratio: 4400000 }],
      [],
      "2026-08-28",
      "2026-09-25"
    );
    // 窓外の実履歴だけ残る。窓内の偽イベントは fresh に従い消える。
    expect(merged).toEqual([REAL_SPLIT]);
  });

  it("冪等: マージ結果への再マージは不変 (2nd run 0)", () => {
    const once = mergeDailySplits([REAL_SPLIT], [], "2026-08-28", "2026-09-25");
    const twice = mergeDailySplits(once, [], "2026-08-28", "2026-09-25");
    expect(twice).toEqual(once);
  });

  it("日付昇順・日付一意に整える", () => {
    const merged = mergeDailySplits(
      [
        { date: "2026-09-10", ratio: 2 },
        { date: "2021-09-29", ratio: 5 },
        { date: "2021-09-29", ratio: 5 },
      ],
      [],
      "2026-01-01",
      "2026-01-31"
    );
    // 両方とも窓外 (2026-01 の窓) のため保持され、整列・重複除去される。
    expect(merged).toEqual([
      { date: "2021-09-29", ratio: 5 },
      { date: "2026-09-10", ratio: 2 },
    ]);
  });
});
