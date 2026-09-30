/**
 * Notion クライアントの read-list envelope guard のテスト (#199 共通根因対策)。
 *
 * POST /search・POST /databases/{id}/query・GET /blocks/{id}/children・
 * GET /pages/{id}/properties/{propId} の成功 JSON を入口 1 箇所で厳密検証
 * し、不正は NotionConfigError で即 STOP (fetch 1 回・retry なし) する。
 * 非 list (GET 単体・create・PATCH) の不干渉は既存 retry/create cases が担保。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("notion-archive client list guard", () => {
  const ORIG_ENV = { ...process.env };
  let originalFetch: typeof globalThis.fetch;
  let originalNow: typeof Date.now;
  let fetchCount: number;
  let script: Array<{
    status: number;
    body?: unknown;
    jsonThrow?: boolean;
  }>;

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
      return {
        ok: entry.status >= 200 && entry.status < 300,
        status: entry.status,
        headers: new Headers(),
        json: async () => {
          if (entry.jsonThrow) throw new SyntaxError("Unexpected token");
          return entry.body;
        },
        text: async () => JSON.stringify(entry.body ?? null),
      } as Response;
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

  // resetModules 後の同一インスタンスから動的 import (class identity 維持)
  const load = async () => {
    const { NotionConfigError } = await import("./env.js");
    const { NotionUnknownResultError, notionRequest } = await import(
      "./client.js"
    );
    return { NotionConfigError, NotionUnknownResultError, notionRequest };
  };

  const listEndpoints: Array<{
    name: string;
    method: "GET" | "POST";
    path: string;
    body?: unknown;
  }> = [
    { name: "search", method: "POST", path: "/search", body: {} },
    {
      name: "database-query",
      method: "POST",
      path: "/databases/dddddddddddddddddddddddddddddddddd/query",
      body: { filter: {}, page_size: 2 },
    },
    {
      name: "block-children",
      method: "GET",
      path: "/blocks/row-1/children?page_size=100",
    },
    {
      name: "block-children-cursor",
      method: "GET",
      path: "/blocks/row-1/children?start_cursor=c&page_size=100",
    },
  ];

  const valid = { results: [], has_more: false, next_cursor: null };
  const validMore = { results: [], has_more: true, next_cursor: "c1" };

  it.each(listEndpoints.map((e) => [e.name, e] as const))(
    "%s: 正常 envelope は通過する",
    async (_name, ep) => {
      script = [
        { status: 200, body: valid },
        { status: 200, body: validMore },
      ];
      const { notionRequest } = await load();
      expect(await notionRequest(ep.method, ep.path, ep.body)).toEqual(valid);
      expect(await notionRequest(ep.method, ep.path, ep.body)).toEqual(
        validMore
      );
      expect(fetchCount).toBe(2);
    }
  );

  const malformed: Array<{
    name: string;
    body: unknown;
    field: string;
  }> = [
    { name: "null応答", body: null, field: "field=response" },
    { name: "配列応答", body: [], field: "field=response" },
    {
      name: "results欠落",
      body: { has_more: false, next_cursor: null },
      field: "field=results",
    },
    {
      name: "results非配列",
      body: { results: "x", has_more: false, next_cursor: null },
      field: "field=results",
    },
    {
      name: "has_more欠落",
      body: { results: [], next_cursor: null },
      field: "field=has_more",
    },
    {
      name: "has_more型不正",
      body: { results: [], has_more: "false", next_cursor: null },
      field: "field=has_more",
    },
    {
      name: "next_cursor欠落",
      body: { results: [], has_more: false },
      field: "field=next_cursor",
    },
    {
      name: "next_cursor数値",
      body: { results: [], has_more: true, next_cursor: 123 },
      field: "field=next_cursor",
    },
    {
      name: "next_cursor空文字",
      body: { results: [], has_more: true, next_cursor: "" },
      field: "field=next_cursor",
    },
    {
      name: "next_cursor空白のみ",
      body: { results: [], has_more: true, next_cursor: "   " },
      field: "field=next_cursor",
    },
    {
      name: "true+null pairing",
      body: { results: [], has_more: true, next_cursor: null },
      field: "field=next_cursor",
    },
    {
      name: "false+非null pairing",
      body: { results: [], has_more: false, next_cursor: "x" },
      field: "field=next_cursor",
    },
  ];

  it.each(malformed.map((m) => [m.name, m] as const))(
    "database-query %s は NotionConfigError で fetch1 STOP",
    async (_name, m) => {
      script = [{ status: 200, body: m.body }];
      const { NotionConfigError, NotionUnknownResultError, notionRequest } =
        await load();
      const err = await notionRequest(
        "POST",
        "/databases/dddddddddddddddddddddddddddddddddd/query",
        {}
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotionConfigError);
      expect(err).not.toBeInstanceOf(NotionUnknownResultError);
      expect((err as Error).message).toContain(m.field);
      expect((err as Error).message).toContain("endpoint=database-query");
      expect(fetchCount).toBe(1);
    }
  );

  it.each([
    ["search", "POST", "/search"],
    ["block-children", "GET", "/blocks/row-1/children?page_size=100"],
  ] as const)(
    "%s: malformed は endpoint family 付きで reject",
    async (family, method, path) => {
      script = [{ status: 200, body: { results: [], has_more: true } }];
      const { NotionConfigError, notionRequest } = await load();
      const err = await notionRequest(method, path, {}).catch(
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(NotionConfigError);
      expect((err as Error).message).toContain(`endpoint=${family}`);
      expect(fetchCount).toBe(1);
    }
  );

  it("JSON decode 失敗は NotionConfigError で fetch1 STOP", async () => {
    script = [{ status: 200, jsonThrow: true }];
    const { NotionConfigError, NotionUnknownResultError, notionRequest } =
      await load();
    const err = await notionRequest(
      "GET",
      "/blocks/row-1/children?page_size=100"
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotionConfigError);
    expect(err).not.toBeInstanceOf(NotionUnknownResultError);
    expect((err as Error).message).toContain("JSON decode 失敗");
    expect(fetchCount).toBe(1);
  });

  it("不正でも ID/cursor 値をエラー文に出さない", async () => {
    script = [
      { status: 200, body: { results: [], has_more: true, next_cursor: null } },
    ];
    const { NotionConfigError, notionRequest } = await load();
    const err = await notionRequest(
      "GET",
      "/blocks/row-SECRETID/children?start_cursor=CURSORSECRET&page_size=100"
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotionConfigError);
    expect((err as Error).message).not.toContain("SECRETID");
    expect((err as Error).message).not.toContain("CURSORSECRET");
  });

  describe("page-property union", () => {
    const propPath =
      "/pages/pppppppppppppppppppppppppppppppp/properties/ttitle";
    it("object=list は envelope guard を適用する", async () => {
      script = [
        { status: 200, body: { object: "list", ...valid } },
        {
          status: 200,
          body: { object: "list", results: [], has_more: true },
        },
      ];
      const { NotionConfigError, notionRequest } = await load();
      expect(await notionRequest("GET", propPath)).toEqual({
        object: "list",
        ...valid,
      });
      const err = await notionRequest("GET", propPath).catch(
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(NotionConfigError);
      expect((err as Error).message).toContain("endpoint=page-property");
    });

    it("object=property_item は singular 許容する", async () => {
      const singular = { object: "property_item", type: "title", id: "t" };
      script = [{ status: 200, body: singular }];
      const { notionRequest } = await load();
      expect(await notionRequest("GET", propPath)).toEqual(singular);
    });

    it("object 判別子の欠落・不正は reject する", async () => {
      script = [
        { status: 200, body: { results: [] } },
        { status: 200, body: { object: "page", id: "p" } },
      ];
      const { NotionConfigError, notionRequest } = await load();
      const missing = await notionRequest("GET", propPath).catch(
        (e: unknown) => e
      );
      expect(missing).toBeInstanceOf(NotionConfigError);
      expect((missing as Error).message).toContain("field=object");
      const wrong = await notionRequest("GET", propPath).catch(
        (e: unknown) => e
      );
      expect(wrong).toBeInstanceOf(NotionConfigError);
      expect((wrong as Error).message).toContain("field=object");
      expect(fetchCount).toBe(2);
    });
  });
});
