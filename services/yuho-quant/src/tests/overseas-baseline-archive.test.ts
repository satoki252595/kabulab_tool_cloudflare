/**
 * Baseline-archive runner の offline 検証 (hermetic・送信 0)。
 * /tmp pins・env・network を使わない。loadFreeze の成功系は
 * preflight (実ファイル) が検証する。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertBudget,
  assertFreshOutDir,
  buildMetadata,
  HoldError,
  loadFreeze,
  requireGrant,
} from "../../data-scripts/overseas-baseline-archive.js";

describe("grant-first / OUT-freshness", () => {
  it("grant なしは HOLD", () => {
    expect(() => requireGrant(["node", "x.js"])).toThrow(HoldError);
    expect(requireGrant(["node", "x.js", "--grant=g"])).toBe("g");
  });

  it("既存 OUT は拒否・不存在は通過", () => {
    const dir = mkdtempSync(join(tmpdir(), "archive-test-"));
    expect(() => assertFreshOutDir(dir)).toThrow(HoldError);
    expect(() => assertFreshOutDir(join(dir, "fresh"))).not.toThrow();
  });
});

describe("budget 断言 (純粋)", () => {
  it("96 以内・raw 3 のみ通過", () => {
    expect(() => assertBudget({ requests: 17 }, 3)).not.toThrow();
    expect(() => assertBudget({ requests: 97 }, 3)).toThrow(HoldError);
    expect(() => assertBudget({ requests: 17 }, 4)).toThrow(HoldError);
  });
});

describe("metadata (counts/SHA のみ)", () => {
  it("IDs/values を含まない", () => {
    const m = buildMetadata();
    const text = JSON.stringify(m);
    expect(text).not.toContain("S100");
    expect(m).toMatchObject({
      baseline: "freshread-baseline-20260930",
      fetchedAt: "2026-09-30T08:40:31.050Z",
    });
  });
});

describe("loadFreeze (失敗系のみ)", () => {
  it("不在 dir は HOLD", () => {
    expect(() => loadFreeze(join(tmpdir(), "archive-test-absent-xyz"))).toThrow(HoldError);
  });
});
