import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { onError, onNotFound } from "../../middleware/error-handler";

/**
 * エラーハンドラーのユニットテスト
 */

/** テスト用Honoアプリを作成 */
function createTestApp() {
  const app = new Hono();
  app.onError(onError);
  app.notFound(onNotFound);
  return app;
}

describe("onError", () => {
  it("Zodバリデーションエラーで400を返すこと", async () => {
    const app = createTestApp();
    app.get("/test", () => {
      const err = new Error("Validation failed") as any;
      err.issues = [
        { path: ["name"], message: "必須項目です" },
        { path: ["age"], message: "数値である必要があります" },
      ];
      throw err;
    });

    const res = await app.request("/test");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Validation Error");
    expect(body.message).toContain("name: 必須項目です");
    expect(body.message).toContain("age: 数値である必要があります");
  });

  it("HTTPExceptionで適切なステータスコードを返すこと", async () => {
    const app = createTestApp();
    app.get("/test", () => {
      throw new HTTPException(403, { message: "Forbidden" });
    });

    const res = await app.request("/test");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("HTTP Error");
    expect(body.message).toBe("Forbidden");
  });

  it("予期しないエラーで500を返すこと", async () => {
    const app = createTestApp();
    app.get("/test", () => {
      throw new Error("Unexpected error");
    });

    // console.errorを抑制
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await app.request("/test");
    consoleSpy.mockRestore();

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal Server Error");
    expect(body.message).toBe("予期しないエラーが発生しました");
  });

  it("エラーメッセージに内部情報が含まれないこと", async () => {
    const app = createTestApp();
    app.get("/test", () => {
      throw new Error("database connection failed at 192.168.1.1");
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await app.request("/test");
    consoleSpy.mockRestore();

    const body = await res.json();
    expect(body.message).not.toContain("192.168.1.1");
    expect(body.message).not.toContain("database connection");
  });
});

describe("onNotFound", () => {
  it("404レスポンスを返すこと", async () => {
    const app = createTestApp();

    const res = await app.request("/nonexistent");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not Found");
    expect(body.message).toContain("GET");
    expect(body.message).toContain("/nonexistent");
  });

  it("リクエストメソッドとパスが含まれること", async () => {
    const app = createTestApp();

    const res = await app.request("/api/unknown", { method: "POST" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.message).toContain("POST");
    expect(body.message).toContain("/api/unknown");
  });
});
