/**
 * 信用残週スナップショット行の選択・重複検査 (margin-select.ts) のテスト。
 * 値は合成 (実 PDF の行の形だけ真似る)。実測の知見 (2026-09-04 の R2 読取で
 * 2593/5076/7550/9201/9202/9434 に同一コードの複数行) を規則化したもの。
 */
import { describe, expect, it } from "vitest";
import { assertDistinctMarginCodes, selectMarginRows } from "./margin-select.js";
import type { MarginRow } from "./margin.js";

const row = (code: string, sell = 100, buy = 200): MarginRow => ({
  code,
  sell,
  sell_chg: 1,
  buy,
  buy_chg: 2,
});

describe("selectMarginRows (公開 API の行選択)", () => {
  it("1 行だけなら ok でその行を返す (正常系は従来どおり)", () => {
    const rows = [row("9434", 100, 200), row("130A", 7, 8)];
    expect(selectMarginRows(rows, "9434")).toEqual({ status: "ok", row: row("9434", 100, 200) });
    expect(selectMarginRows(rows, "130A")).toEqual({ status: "ok", row: row("130A", 7, 8) });
  });

  it("無ければ missing (憶測で埋めない)", () => {
    expect(selectMarginRows([row("9434")], "9999")).toEqual({ status: "missing" });
    expect(selectMarginRows([], "9434")).toEqual({ status: "missing" });
  });

  it("同一コードの複数行は ambiguous で件数を明示し、先頭行を黙って採用しない", () => {
    // 実測の崩壊形: 普通株の大値 + 種類株の小値が同じ 4 桁コードで並ぶ。
    const rows = [row("2593", 77200, 244500), row("130A", 7, 8), row("2593", 100, 17500)];
    const sel = selectMarginRows(rows, "2593");
    expect(sel).toEqual({ status: "ambiguous", count: 2 });
    // 同じ週の正常な銘柄は影響を受けない
    expect(selectMarginRows(rows, "130A")).toEqual({ status: "ok", row: row("130A", 7, 8) });
  });

  it("3 行の崩壊 (9434 の実測形) も ambiguous", () => {
    const rows = [row("9434", 3176300, 27413900), row("9434", 0, 3500), row("9434", 0, 0)];
    expect(selectMarginRows(rows, "9434")).toEqual({ status: "ambiguous", count: 3 });
  });
});

describe("assertDistinctMarginCodes (保存前の重複検査)", () => {
  it("全コード distinct なら通す (正常な取込は止めない)", () => {
    expect(() => assertDistinctMarginCodes([row("2593"), row("25935"), row("9434")])).not.toThrow();
    expect(() => assertDistinctMarginCodes([])).not.toThrow();
  });

  it("同一コードの複数行があれば重複コードを列挙して throw する", () => {
    expect(() => assertDistinctMarginCodes([row("2593"), row("2593")])).toThrow(/2593/);
    expect(() =>
      assertDistinctMarginCodes([row("9434"), row("2593"), row("9434"), row("2593"), row("130A")])
    ).toThrow(/2593.*9434|9434.*2593/);
  });
});
