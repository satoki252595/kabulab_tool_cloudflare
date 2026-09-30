import { describe, expect, it } from "vitest";

import { trustedEstimateValue } from "./trusted-value.js";

describe("trustedEstimateValue (推定値の共有 trust 境界)", () => {
  it("company の値は通す (0 も 0 のまま)", () => {
    expect(trustedEstimateValue({ estimatedValue: 1000, estimateValueSource: "company" })).toBe(1000);
    expect(trustedEstimateValue({ estimatedValue: 0, estimateValueSource: "company" })).toBe(0);
  });

  it("source NULL の非 null 値は落とす", () => {
    expect(trustedEstimateValue({ estimatedValue: 1000, estimateValueSource: null })).toBeNull();
  });

  it("値 NULL は source によらず null", () => {
    expect(trustedEstimateValue({ estimatedValue: null, estimateValueSource: "company" })).toBeNull();
    expect(trustedEstimateValue({ estimatedValue: null, estimateValueSource: null })).toBeNull();
  });

  it("未知の source は落とす (扱いを発明しない)", () => {
    expect(trustedEstimateValue({ estimatedValue: 1000, estimateValueSource: "web" })).toBeNull();
  });
});
