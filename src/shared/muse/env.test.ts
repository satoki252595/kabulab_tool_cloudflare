/**
 * museEnv (CLAUDE.md ルール3 の型付きアクセサ) のテスト。
 * 未設定は黙ってフォールバックせず throw する。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("museEnv.MUSE_BIN", () => {
  const ORIG_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.MUSE_BIN;
  });

  afterEach(() => {
    process.env = { ...ORIG_ENV };
  });

  it("未設定なら throw する", async () => {
    const { museEnv } = await import("./env.js");
    expect(() => museEnv.MUSE_BIN()).toThrow(
      "環境変数 MUSE_BIN が設定されていません"
    );
  });

  it("空文字なら throw する (未設定と同じ扱い)", async () => {
    process.env.MUSE_BIN = "   ";
    const { museEnv } = await import("./env.js");
    expect(() => museEnv.MUSE_BIN()).toThrow();
  });

  it("設定済みならその値を返す", async () => {
    process.env.MUSE_BIN = "/usr/local/bin/muse";
    const { museEnv } = await import("./env.js");
    expect(museEnv.MUSE_BIN()).toBe("/usr/local/bin/muse");
  });
});
