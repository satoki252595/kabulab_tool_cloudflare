/**
 * `import-summary-results.ts` の CLI 引数の配線を固定する。
 *
 * このファイルを import しても `main()` は走らない (D1 アクセス・`process.exit`
 * が無い) — `import-summary-results.ts` 側の実行ガードが対象。走ってしまうと
 * このテスト自体が CI で D1 に触ろうとしたり、`process.exit` でテストプロセスを
 * 落としたりする。
 */
import { describe, expect, it } from "vitest";
import { parseImportArgs } from "../../data-scripts/import-summary-results.js";

describe("parseImportArgs", () => {
  it("--show-text / --apply を付けなければ既定で false", () => {
    const args = parseImportArgs(["--tasks", "t.jsonl", "--results", "r.jsonl"]);
    expect(args).toEqual({ tasks: "t.jsonl", results: "r.jsonl", apply: false, showText: false });
  });

  it("--show-text を付けると showText だけ true になる", () => {
    const args = parseImportArgs(["--tasks", "t.jsonl", "--results", "r.jsonl", "--show-text"]);
    expect(args.showText).toBe(true);
    expect(args.apply).toBe(false);
  });

  it("--apply を付けると apply だけ true になる", () => {
    const args = parseImportArgs(["--tasks", "t.jsonl", "--results", "r.jsonl", "--apply"]);
    expect(args.apply).toBe(true);
    expect(args.showText).toBe(false);
  });

  it("--tasks / --results を欠くとエラー", () => {
    expect(() => parseImportArgs(["--tasks", "t.jsonl"])).toThrow(/--tasks .* --results/);
    expect(() => parseImportArgs([])).toThrow(/--tasks .* --results/);
  });

  it("未知のオプションは strict:true ではじかれる (ERR_PARSE_ARGS_UNKNOWN_OPTION)", () => {
    expect(() => parseImportArgs(["--tasks", "t.jsonl", "--results", "r.jsonl", "--show-txt"])).toThrow();
  });
});
