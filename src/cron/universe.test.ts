import { describe, expect, it } from "vitest";
import {
  assertUniverseCoverage,
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
