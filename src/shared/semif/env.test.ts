/**
 * semifEnv (CLAUDE.md ルール3 の型付きアクセサ) のテスト。
 * 未設定は黙ってフォールバックせず throw する。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("semifEnv.SEMIF_PYTHON", () => {
  const ORIG_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.SEMIF_PYTHON;
  });

  afterEach(() => {
    process.env = { ...ORIG_ENV };
  });

  it("未設定なら throw する", async () => {
    const { semifEnv } = await import("./env.js");
    expect(() => semifEnv.SEMIF_PYTHON()).toThrow(
      "環境変数 SEMIF_PYTHON が設定されていません"
    );
  });

  it("空文字なら throw する (未設定と同じ扱い)", async () => {
    process.env.SEMIF_PYTHON = "   ";
    const { semifEnv } = await import("./env.js");
    expect(() => semifEnv.SEMIF_PYTHON()).toThrow();
  });

  it("設定済みならその値を返す", async () => {
    process.env.SEMIF_PYTHON = "/Users/example/.local/share/semif/.venv/bin/python";
    const { semifEnv } = await import("./env.js");
    expect(semifEnv.SEMIF_PYTHON()).toBe("/Users/example/.local/share/semif/.venv/bin/python");
  });
});
