/**
 * scripts/vwap/ingest-margin.ts の純関数のテスト。
 *
 * トップレベル実行は `process.argv[1] === fileURLToPath(import.meta.url)` で
 * ガードされているため (import だけでは main() が走らない)、このテストは
 * 安全にモジュールを import できる (scripts/moneyflow/ingest.ts と同方式)。
 */
import { describe, expect, it } from "vitest";
import { parseWeekArg } from "./ingest-margin.js";

describe("parseWeekArg", () => {
  it("--week 未指定なら undefined (最新週)", () => {
    expect(parseWeekArg([])).toBeUndefined();
    expect(parseWeekArg(["node", "ingest-margin.js"])).toBeUndefined();
  });

  it("--week=YYYYMMDD をそのまま返す", () => {
    expect(parseWeekArg(["--week=20260904"])).toBe("20260904");
  });

  it("形式が違えば throw する (推測でその場をしのがない)", () => {
    expect(() => parseWeekArg(["--week=2026-09-04"])).toThrow(/形式が不正/);
    expect(() => parseWeekArg(["--week=2026090"])).toThrow(/形式が不正/);
    expect(() => parseWeekArg(["--week="])).toThrow(/形式が不正/);
  });
});
