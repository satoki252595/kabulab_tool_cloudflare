/**
 * Notion クライアントのリトライ方針のテスト (公式 /reference/request-limits 準拠)。
 *
 * - 429 (rate_limited) と 529 (service_overload) は Retry-After を尊重して再試行
 * - 真正 Notion エラー JSON の 4xx は恒久扱いで即 throw (1 コールのみ)
 * - 再試行の待ち時間そのものは測らない (Retry-After: 0 で即時化)。
 *   ペーシング待ちは Date.now を進めて消す。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("notion-archive client retry", () => {
  const ORIG_ENV = { ...process.env };
  let originalFetch: typeof globalThis.fetch;
  let originalNow: typeof Date.now;
  let fetchCount: number;
  let script: Array<{ status: number; retryAfter?: string; body?: unknown }>;

  const mockResponse = (entry: {
    status: number;
    retryAfter?: string;
    body?: unknown;
  }): Response => {
    const headers = new Headers();
    if (entry.retryAfter !== undefined) {
      headers.set("Retry-After", entry.retryAfter);
    }
    const text =
      entry.body === undefined ? "" : JSON.stringify(entry.body);
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

  it("529 は Retry-After を尊重して再試行し成功する", async () => {
    script = [
      { status: 529, retryAfter: "0" },
      { status: 529, retryAfter: "0" },
      { status: 200, body: { ok: true } },
    ];
    const { notionRequest } = await load();
    const got = await notionRequest<{ ok: boolean }>("GET", "/v1/test");
    expect(got).toEqual({ ok: true });
    expect(fetchCount).toBe(3);
  });

  it("529 が続くと 7 回投げて 529 を明記して throw", async () => {
    script = Array.from({ length: 7 }, () => ({
      status: 529,
      retryAfter: "0",
    }));
    const { notionRequest } = await load();
    await expect(notionRequest("GET", "/v1/test")).rejects.toThrow(
      "再試行後も 529"
    );
    expect(fetchCount).toBe(7);
  });

  it("429 は従来通り再試行する", async () => {
    script = [
      { status: 429, retryAfter: "0" },
      { status: 200, body: { ok: true } },
    ];
    const { notionRequest } = await load();
    const got = await notionRequest<{ ok: boolean }>("GET", "/v1/test");
    expect(got).toEqual({ ok: true });
    expect(fetchCount).toBe(2);
  });

  it("真正 Notion エラー JSON の 4xx は即 throw (再試行しない)", async () => {
    script = [
      {
        status: 400,
        body: { object: "error", code: "validation_error", message: "bad" },
      },
    ];
    const { notionRequest } = await load();
    await expect(notionRequest("GET", "/v1/test")).rejects.toThrow(
      "validation_error"
    );
    expect(fetchCount).toBe(1);
  });
});
