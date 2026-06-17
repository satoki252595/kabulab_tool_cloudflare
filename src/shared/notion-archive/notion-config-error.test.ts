/**
 * `NotionConfigError` を retry 対象から除外することの回帰テスト。
 *
 * 過去事例: Vercel `kabulab` プロジェクトに `NOTION_TOKEN` 未設定のまま
 * /ir-catalog/file/<id> が呼ばれた際、`client.ts` の doFetch が env throw を
 * 一過性失敗と誤判定し 6 回指数バックオフ ≒ 61 秒固まった (TTFB ~63 秒)。
 * 本テストは「NotionConfigError は 1 度目で即 surface する」ことを保証する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("notion-archive NotionConfigError", () => {
  const ORIG_TOKEN = process.env.NOTION_TOKEN;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (ORIG_TOKEN === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = ORIG_TOKEN;
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("env.required は NotionConfigError を投げる (plain Error ではない)", async () => {
    delete process.env.NOTION_TOKEN;
    vi.resetModules();
    const { notionEnv: env, NotionConfigError: ErrClass } = await import("./env.js");
    expect(() => env.NOTION_TOKEN()).toThrow(ErrClass);
  });

  it("notionRequest は NOTION_TOKEN 未設定で fetch を呼ばず即 throw する", async () => {
    delete process.env.NOTION_TOKEN;
    vi.resetModules();
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    // resetModules 後は class identity が変わるため、同じモジュール
    // インスタンスから動的 import して instanceof 判定する
    const { NotionConfigError: ErrClass } = await import("./env.js");
    const { notionRequest } = await import("./client.js");
    const t0 = Date.now();
    await expect(notionRequest("GET", "/pages/anything")).rejects.toBeInstanceOf(
      ErrClass
    );
    const elapsed = Date.now() - t0;

    // fetch は 1 度も呼ばれない (makeInit 内の env 参照で throw)
    expect(fetchSpy).not.toHaveBeenCalled();
    // backoff せず即 throw されている (本来 6 retry なら最低 ~31s だが、
    // ここでは sub-second で完了するはず。CI ゆらぎを考慮して 2s でゆるく上限)
    expect(elapsed).toBeLessThan(2000);
  });
});
