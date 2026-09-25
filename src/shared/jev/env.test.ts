/**
 * jevEnv (CLAUDE.md ルール3 の型付きアクセサ) のテスト。
 * 未設定は黙ってフォールバックせず throw する。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("jevEnv.TYPESAFE_API_KEY", () => {
  const ORIG_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.TYPESAFE_API_KEY;
  });

  afterEach(() => {
    process.env = { ...ORIG_ENV };
  });

  it("未設定なら throw する", async () => {
    const { jevEnv } = await import("./env.js");
    expect(() => jevEnv.TYPESAFE_API_KEY()).toThrow(
      "環境変数 TYPESAFE_API_KEY が設定されていません"
    );
  });

  it("空文字なら throw する (未設定と同じ扱い)", async () => {
    process.env.TYPESAFE_API_KEY = "   ";
    const { jevEnv } = await import("./env.js");
    expect(() => jevEnv.TYPESAFE_API_KEY()).toThrow();
  });

  it("設定済みならその値を返す", async () => {
    process.env.TYPESAFE_API_KEY = "sk-test-123";
    const { jevEnv } = await import("./env.js");
    expect(jevEnv.TYPESAFE_API_KEY()).toBe("sk-test-123");
  });
});
