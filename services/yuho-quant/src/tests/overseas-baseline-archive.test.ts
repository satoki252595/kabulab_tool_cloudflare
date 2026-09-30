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
  createNotionGateFetch,
  HoldError,
  loadFreeze,
  requireGrant,
  type GateCounters,
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

describe("notion gate (native 前・送信 0)", () => {
  const NURL = "https://api.notion.com/v1/databases/x/query";
  const HURL = "https://files.example.invalid/presigned-blob";

  it("notion GET/POST を数えて通し hosted GET は 3 まで", async () => {
    const dir = mkdtempSync(join(tmpdir(), "archive-test-"));
    const counters: GateCounters = { notion: 0, hosted: 0, rejected: 0 };
    let innerCalls = 0;
    const inner = (async () => {
      innerCalls += 1;
      return new Response("{}");
    }) as typeof fetch;
    const gate = createNotionGateFetch(inner, dir, counters, 96, 3);
    await gate(NURL, { method: "POST", body: "{}" });
    await gate(NURL, { method: "GET" });
    await gate(HURL, { method: "GET" });
    await gate(HURL, { method: "GET" });
    await gate(HURL, { method: "GET" });
    expect(counters).toEqual({ notion: 2, hosted: 3, rejected: 0 });
    expect(innerCalls).toBe(5);
  });

  it("4 件目 hosted・非 GET・非 GET/POST・budget 超過を native 到達前に拒否", async () => {
    const dir = mkdtempSync(join(tmpdir(), "archive-test-"));
    const counters: GateCounters = { notion: 0, hosted: 0, rejected: 0 };
    let innerCalls = 0;
    const inner = (async () => {
      innerCalls += 1;
      return new Response("{}");
    }) as typeof fetch;
    const gate = createNotionGateFetch(inner, dir, counters, 1, 1);
    await gate(HURL, { method: "GET" });
    await expect(gate(HURL, { method: "GET" })).rejects.toThrow("hosted");
    await expect(gate(HURL, { method: "POST", body: "{}" })).rejects.toThrow("hosted");
    await expect(gate(NURL, { method: "PATCH", body: "{}" })).rejects.toThrow("mutation");
    await gate(NURL, { method: "GET" });
    await expect(gate(NURL, { method: "GET" })).rejects.toThrow("budget");
    expect(innerCalls).toBe(2);
    expect(counters).toEqual({ notion: 1, hosted: 1, rejected: 4 });
  });
});
