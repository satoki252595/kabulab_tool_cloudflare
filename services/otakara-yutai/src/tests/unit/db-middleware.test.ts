import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";

/**
 * DBミドルウェアのユニットテスト
 */

// createDbをモック化
vi.mock("../../db/client", () => ({
  createDb: vi.fn((url: string) => ({
    _mockDbUrl: url,
    query: {},
  })),
}));

import { dbMiddleware } from "../../middleware/db";
import { createDb } from "../../db/client";

describe("dbMiddleware", () => {
  it("コンテキストにdbを設定すること", async () => {
    const app = new Hono<{
      Bindings: { DATABASE_URL: string };
      Variables: { db: unknown };
    }>();

    app.use("*", dbMiddleware);
    app.get("/test", (c) => {
      const db = c.get("db");
      return c.json({ hasDb: !!db });
    });

    const res = await app.request("/test", undefined, {
      DATABASE_URL: "postgresql://test:test@localhost/testdb",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasDb).toBe(true);
  });

  it("c.get('db')でDBクライアントにアクセスできること", async () => {
    const app = new Hono<{
      Bindings: { DATABASE_URL: string };
      Variables: { db: unknown };
    }>();

    app.use("*", dbMiddleware);
    app.get("/test", (c) => {
      const db = c.get("db") as { _mockDbUrl: string };
      return c.json({ url: db._mockDbUrl });
    });

    const res = await app.request("/test", undefined, {
      DATABASE_URL: "postgresql://test:test@localhost/testdb",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe("postgresql://test:test@localhost/testdb");
  });

  it("環境変数のDATABASE_URLを使用してcreateDbを呼ぶこと", async () => {
    const app = new Hono<{
      Bindings: { DATABASE_URL: string };
      Variables: { db: unknown };
    }>();

    app.use("*", dbMiddleware);
    app.get("/test", (c) => {
      return c.json({ ok: true });
    });

    const dbUrl = "postgresql://user:pass@neon.tech/mydb";
    await app.request("/test", undefined, {
      DATABASE_URL: dbUrl,
    });

    expect(createDb).toHaveBeenCalledWith(dbUrl);
  });
});
