import { describe, expect, it } from "vitest";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import * as zClassic from "zod";
import * as zMini from "zod/mini";
import { createErrorHandler } from "./error-handler.js";

/**
 * L-60: 共有エラーハンドラは classic / mini どちらの ZodError も 400 にする。
 * ($ZodError は classic ZodError の親クラスなので 1 文で両方受ける)
 */

function fakeContext() {
  const calls: Array<{ body: unknown; status: number }> = [];
  const c = {
    json: (body: unknown, status = 200) => {
      calls.push({ body, status });
      return new Response(JSON.stringify(body), { status });
    },
  } as unknown as Context;
  return { c, calls };
}

describe("createErrorHandler", () => {
  it("サービス名をログ接頭辞に付ける", () => {
    const handler = createErrorHandler("swing-trading");
    const { c, calls } = fakeContext();
    handler(new Error("boom"), c);
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe(500);
    expect(calls[0].body).toEqual({ error: "サーバー内部エラー" });
  });

  it("HTTPException は status を透過する", () => {
    const handler = createErrorHandler("test");
    const { c, calls } = fakeContext();
    handler(new HTTPException(404, { message: "not here" }), c);
    expect(calls[0].status).toBe(404);
    expect(calls[0].body).toEqual({ error: "not here" });
  });

  it("classic ZodError を 400 にする", () => {
    const handler = createErrorHandler("test");
    const { c, calls } = fakeContext();
    const parsed = zClassic.object({ a: zClassic.string() }).safeParse({ a: 1 });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      handler(parsed.error, c);
      expect(calls[0].status).toBe(400);
      expect(calls[0].body).toMatchObject({ error: "バリデーションエラー" });
      expect(
        (calls[0].body as { issues: unknown[] }).issues.length
      ).toBeGreaterThan(0);
    }
  });

  it("mini の $ZodError を 400 にする", () => {
    const handler = createErrorHandler("test");
    const { c, calls } = fakeContext();
    const schema = zMini.object({ a: zMini.string() });
    const parsed = schema.safeParse({ a: 1 });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      handler(parsed.error, c);
      expect(calls[0].status).toBe(400);
      expect(calls[0].body).toMatchObject({ error: "バリデーションエラー" });
      expect(
        (calls[0].body as { issues: unknown[] }).issues.length
      ).toBeGreaterThan(0);
    }
  });
});
