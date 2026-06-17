import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createRateLimiter } from "../../middleware/rate-limiter";

/**
 * レートリミッターのユニットテスト
 */

describe("createRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("制限以下のリクエストを許可すること", async () => {
    const app = new Hono();
    app.use("*", createRateLimiter({ windowMs: 60_000, maxRequests: 5 }));
    app.get("/test", (c) => c.json({ ok: true }));

    for (let i = 0; i < 5; i++) {
      const res = await app.request("/test", {
        headers: { "x-forwarded-for": "192.168.1.1" },
      });
      expect(res.status).toBe(200);
    }
  });

  it("制限を超えたリクエストに429を返すこと", async () => {
    const app = new Hono();
    app.use("*", createRateLimiter({ windowMs: 60_000, maxRequests: 3 }));
    app.get("/test", (c) => c.json({ ok: true }));

    // 3リクエスト分を消費
    for (let i = 0; i < 3; i++) {
      const res = await app.request("/test", {
        headers: { "x-forwarded-for": "10.0.0.1" },
      });
      expect(res.status).toBe(200);
    }

    // 4つ目のリクエストは拒否される
    const res = await app.request("/test", {
      headers: { "x-forwarded-for": "10.0.0.1" },
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("Too Many Requests");
  });

  it("ウィンドウ経過後にリセットされること", async () => {
    const app = new Hono();
    app.use("*", createRateLimiter({ windowMs: 10_000, maxRequests: 2 }));
    app.get("/test", (c) => c.json({ ok: true }));

    // 2リクエスト消費
    for (let i = 0; i < 2; i++) {
      await app.request("/test", {
        headers: { "x-forwarded-for": "10.0.0.2" },
      });
    }

    // 制限超過
    const blockedRes = await app.request("/test", {
      headers: { "x-forwarded-for": "10.0.0.2" },
    });
    expect(blockedRes.status).toBe(429);

    // ウィンドウ期間経過
    vi.advanceTimersByTime(10_001);

    // リセットされているのでリクエスト成功
    const res = await app.request("/test", {
      headers: { "x-forwarded-for": "10.0.0.2" },
    });
    expect(res.status).toBe(200);
  });

  it("x-forwarded-forヘッダーでクライアントを識別すること", async () => {
    const app = new Hono();
    app.use("*", createRateLimiter({ windowMs: 60_000, maxRequests: 1 }));
    app.get("/test", (c) => c.json({ ok: true }));

    // IP Aのリクエスト
    const res1 = await app.request("/test", {
      headers: { "x-forwarded-for": "1.1.1.1" },
    });
    expect(res1.status).toBe(200);

    // IP Aの2つ目は拒否
    const res2 = await app.request("/test", {
      headers: { "x-forwarded-for": "1.1.1.1" },
    });
    expect(res2.status).toBe(429);

    // IP Bは別カウントなので成功
    const res3 = await app.request("/test", {
      headers: { "x-forwarded-for": "2.2.2.2" },
    });
    expect(res3.status).toBe(200);
  });

  it("異なるIPアドレスが別々の制限を持つこと", async () => {
    const app = new Hono();
    app.use("*", createRateLimiter({ windowMs: 60_000, maxRequests: 2 }));
    app.get("/test", (c) => c.json({ ok: true }));

    // IP A: 2リクエスト消費
    for (let i = 0; i < 2; i++) {
      const res = await app.request("/test", {
        headers: { "x-forwarded-for": "10.0.0.1" },
      });
      expect(res.status).toBe(200);
    }

    // IP A: 制限超過
    const blockedA = await app.request("/test", {
      headers: { "x-forwarded-for": "10.0.0.1" },
    });
    expect(blockedA.status).toBe(429);

    // IP B: まだ余裕あり
    for (let i = 0; i < 2; i++) {
      const res = await app.request("/test", {
        headers: { "x-forwarded-for": "10.0.0.2" },
      });
      expect(res.status).toBe(200);
    }

    // IP B: 制限超過
    const blockedB = await app.request("/test", {
      headers: { "x-forwarded-for": "10.0.0.2" },
    });
    expect(blockedB.status).toBe(429);
  });
});
