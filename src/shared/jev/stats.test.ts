import { describe, expect, it } from "vitest";
import { estimateCostUsd } from "./stats.js";

describe("estimateCostUsd", () => {
  it("100万トークンあたり $0.042 として計算する", () => {
    expect(estimateCostUsd(1_000_000)).toBeCloseTo(0.042);
  });

  it("0トークンなら $0", () => {
    expect(estimateCostUsd(0)).toBe(0);
  });

  it("比例計算 (10万トークンなら 1/10)", () => {
    expect(estimateCostUsd(100_000)).toBeCloseTo(0.0042);
  });
});
