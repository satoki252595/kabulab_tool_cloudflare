/**
 * cron 認証 (verifyCronSecret) の回帰テスト。
 *
 * - CRON_SECRET 未設定 → 常に false (fail-closed。throw で 500 にしない)
 * - 正しい Bearer token → true
 * - 形式不正 / token 不一致 / ヘッダ無し → false
 *
 * sharedEnv (src/shared/env.ts) 経由の参照に移行した際の挙動保証。
 */
import { afterEach, describe, expect, it } from "vitest";
import { verifyCronSecret } from "./auth.js";

const ORIG_SECRET = process.env.CRON_SECRET;

function req(authorization?: string): Request {
  return new Request("https://example.com/api/cron/sync-daily", {
    headers: authorization ? { Authorization: authorization } : {},
  });
}

describe("verifyCronSecret", () => {
  afterEach(() => {
    if (ORIG_SECRET === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = ORIG_SECRET;
  });

  it("CRON_SECRET 未設定なら token が何であれ false (fail-closed)", () => {
    delete process.env.CRON_SECRET;
    expect(verifyCronSecret(req("Bearer anything"))).toBe(false);
    expect(verifyCronSecret(req())).toBe(false);
  });

  it("CRON_SECRET が空白のみでも false (optional() が undefined 扱い)", () => {
    process.env.CRON_SECRET = "   ";
    expect(verifyCronSecret(req("Bearer    "))).toBe(false);
  });

  it("正しい Bearer token なら true", () => {
    process.env.CRON_SECRET = "s3cret-token";
    expect(verifyCronSecret(req("Bearer s3cret-token"))).toBe(true);
  });

  it("token 不一致なら false", () => {
    process.env.CRON_SECRET = "s3cret-token";
    expect(verifyCronSecret(req("Bearer wrong-token"))).toBe(false);
  });

  it("ヘッダ形式不正 (Bearer 以外 / 部品数不正 / 空 token) なら false", () => {
    process.env.CRON_SECRET = "s3cret-token";
    expect(verifyCronSecret(req("Basic s3cret-token"))).toBe(false);
    expect(verifyCronSecret(req("Bearer"))).toBe(false);
    expect(verifyCronSecret(req("Bearer a b"))).toBe(false);
    expect(verifyCronSecret(req())).toBe(false);
  });
});
