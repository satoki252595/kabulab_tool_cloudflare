/**
 * notionStats() / resetNotionStats() のテスト (挙動は変えず計測だけ追加した
 * ことの回帰テスト)。429/529 の再試行と 5xx/ネットワーク例外の再試行を
 * 区別して数えることを確認する。待ち時間は Date.now を進めて無効化する
 * (client-retry.test.ts と同じ方式)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("notion-archive client notionStats", () => {
  const ORIG_ENV = { ...process.env };
  let originalFetch: typeof globalThis.fetch;
  let originalNow: typeof Date.now;
  let fetchCount: number;
  let script: Array<{ status: number; retryAfter?: string; body?: unknown; networkError?: boolean }>;

  const mockResponse = (entry: { status: number; retryAfter?: string; body?: unknown }): Response => {
    const headers = new Headers();
    if (entry.retryAfter !== undefined) headers.set("Retry-After", entry.retryAfter);
    const text = entry.body === undefined ? "" : JSON.stringify(entry.body);
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      headers,
      json: async () => (entry.body === undefined ? {} : entry.body),
      text: async () => text,
    } as Response;
  };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalNow = Date.now;
    fetchCount = 0;
    script = [];
    process.env.NOTION_TOKEN = "dummy-token";
    let t = 1_000_000;
    Date.now = (() => (t += 10_000)) as typeof Date.now;
    globalThis.fetch = (async () => {
      fetchCount++;
      const entry = script.shift();
      if (!entry) throw new Error("テスト: 応答スクリプト枯渇");
      if (entry.networkError) throw new Error("network down");
      return mockResponse(entry);
    }) as typeof fetch;
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    process.env = { ...ORIG_ENV };
    vi.clearAllMocks();
    vi.resetModules();
  });

  const load = () => import("./client.js");

  it("初期値は全て 0", async () => {
    const { notionStats } = await load();
    expect(notionStats()).toEqual({ requests: 0, rateLimited: 0, transientRetries: 0 });
  });

  it("成功 1 回だけなら requests=1・他は 0", async () => {
    script = [{ status: 200, body: { ok: true } }];
    const { notionRequest, notionStats } = await load();
    await notionRequest("GET", "/v1/test");
    expect(notionStats()).toEqual({ requests: 1, rateLimited: 0, transientRetries: 0 });
  });

  it("429 → 成功: requests=2・rateLimited=1・transientRetries=0", async () => {
    script = [
      { status: 429, retryAfter: "0" },
      { status: 200, body: { ok: true } },
    ];
    const { notionRequest, notionStats } = await load();
    await notionRequest("GET", "/v1/test");
    expect(notionStats()).toEqual({ requests: 2, rateLimited: 1, transientRetries: 0 });
  });

  it("529 が 2 回続いて成功: rateLimited=2 (429 とは別カウントではなく合算)", async () => {
    script = [
      { status: 529, retryAfter: "0" },
      { status: 529, retryAfter: "0" },
      { status: 200, body: { ok: true } },
    ];
    const { notionRequest, notionStats } = await load();
    await notionRequest("GET", "/v1/test");
    expect(notionStats()).toEqual({ requests: 3, rateLimited: 2, transientRetries: 0 });
  });

  it("5xx → 成功: transientRetries=1・rateLimited=0", async () => {
    script = [{ status: 503 }, { status: 200, body: { ok: true } }];
    const { notionRequest, notionStats } = await load();
    await notionRequest("GET", "/v1/test");
    expect(notionStats()).toEqual({ requests: 2, rateLimited: 0, transientRetries: 1 });
  });

  it("ネットワーク例外 → 成功: transientRetries=1", async () => {
    script = [{ status: 0, networkError: true }, { status: 200, body: { ok: true } }];
    const { notionRequest, notionStats } = await load();
    await notionRequest("GET", "/v1/test");
    expect(notionStats()).toEqual({ requests: 2, rateLimited: 0, transientRetries: 1 });
  });

  it("恒久エラー (真正 JSON 4xx) は再試行せず requests=1 のみでカウンタも増えない", async () => {
    script = [{ status: 400, body: { object: "error", code: "validation_error", message: "bad" } }];
    const { notionRequest, notionStats } = await load();
    await expect(notionRequest("GET", "/v1/test")).rejects.toThrow("validation_error");
    expect(notionStats()).toEqual({ requests: 1, rateLimited: 0, transientRetries: 0 });
  });

  it("resetNotionStats で 0 に戻る", async () => {
    script = [{ status: 200, body: { ok: true } }];
    const { notionRequest, notionStats, resetNotionStats } = await load();
    await notionRequest("GET", "/v1/test");
    expect(notionStats().requests).toBe(1);
    resetNotionStats();
    expect(notionStats()).toEqual({ requests: 0, rateLimited: 0, transientRetries: 0 });
  });

  it("NotionConfigError (env 未設定) は fetch を呼ばずカウンタも増えない", async () => {
    delete process.env.NOTION_TOKEN;
    vi.resetModules();
    const { notionRequest, notionStats } = await load();
    await expect(notionRequest("GET", "/v1/test")).rejects.toThrow();
    expect(fetchCount).toBe(0);
    expect(notionStats()).toEqual({ requests: 0, rateLimited: 0, transientRetries: 0 });
  });
});
