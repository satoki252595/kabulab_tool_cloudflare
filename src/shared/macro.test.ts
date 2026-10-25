import { describe, expect, it } from "vitest";
import { judgeMacro, type MacroInput } from "./macro.js";

describe("macro missing inputs and observed conditions", () => {
  it.each([
    [null, null, "HOLD"],
    [null, 200, "HOLD"],
    [1.2, null, "HOLD"],
    [1.2, 200, "A"],
    [0, null, "B"],
    [1.19, null, "B"],
    [null, 201, "B"],
    [null, -201, "B"],
  ] as const)("turnover=%s gap=%s returns %s", (topixTurnoverRatio, futuresGap, judgment) => {
    const result = judgeMacro({ nikkeiVi: 20, topixTurnoverRatio, futuresGap, vix: null, sp500Pct: null });
    expect(result.judgment).toBe(judgment);
    if (judgment === "HOLD") {
      expect(result.reason).toContain("未取得");
      expect(result.reason).not.toContain("条件未達");
      if (topixTurnoverRatio === null) expect(result.reason).toContain("東証プライム売買代金の20日平均比");
      if (futuresGap === null) expect(result.reason).toContain("先物ギャップ");
    }
  });

  it.each([
    [{ nikkeiVi: 36 }, "D"],
    [{ nikkeiVi: 20, vix: 21, sp500Pct: -1 }, "D"],
    [{ nikkeiVi: 30 }, "C"],
    [{ nikkeiVi: 26 }, "B"],
    [{ nikkeiVi: 19 }, "B"],
    [{ nikkeiVi: null }, "HOLD"],
  ] satisfies [Partial<MacroInput>, string][])("preserves independently determined %j", (input, judgment) => {
    expect(judgeMacro({ topixTurnoverRatio: null, futuresGap: null,
      vix: null, sp500Pct: null, ...input }).judgment).toBe(judgment);
  });
});
