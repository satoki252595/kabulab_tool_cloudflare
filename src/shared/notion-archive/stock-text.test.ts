/**
 * 銘柄別・有報テキスト Notion 保管のテスト。
 *
 * fetch を差し替えて Notion 応答を捏造…ではなく定型応答で固定し、
 * リクエスト形状 (URL・children 分割・プロパティ鏡像) と冪等分岐を検証する。
 * client.ts の 380ms ペーシングは Date.now を進めて無効化する
 * (待ち時間のテストではないため)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FetchCalls = Array<{ url: string; init: RequestInit }>;

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("notion-archive stock-text", () => {
  const ORIG_ENV = { ...process.env };
  let originalFetch: typeof globalThis.fetch;
  let originalNow: typeof Date.now;
  let calls: FetchCalls;
  /** method+path → 応答キュー */
  let routes: Map<string, unknown[]>;

  const route = (method: string, path: string, bodies: unknown[]) => {
    routes.set(`${method} ${path}`, [...bodies]);
  };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalNow = Date.now;
    calls = [];
    routes = new Map();
    process.env.NOTION_TOKEN = "dummy-token";
    process.env.NOTION_ARCHIVE_PAGE_ID = "b".repeat(32);
    process.env.NOTION_YUHO_TEXT_DB_ID = "d".repeat(32);
    // ペーシング待ちを消す (単調増加時刻)
    let t = 1_000_000;
    Date.now = (() => (t += 10_000)) as typeof Date.now;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const u = new URL(String(url));
      const key = `${init?.method ?? "GET"} ${u.pathname}`;
      const q = routes.get(key);
      if (!q || q.length === 0) {
        throw new Error(`テスト: 未定義ルートへの fetch: ${key}`);
      }
      return jsonResponse(q.shift());
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

  const load = () => import("./stock-text.js");

  const childrenPage = (
    results: unknown[],
    has_more = false,
    next_cursor: string | null = null
  ) => ({ results, has_more, next_cursor });

  const dbQuery = (ids: string[]) => ({
    results: ids.map((id) => ({ id })),
  });

  describe("buildTextBodyBlocks", () => {
    it("目印 + セクション毎に見出しと本文を置く", async () => {
      const { buildTextBodyBlocks } = await load();
      const blocks = buildTextBodyBlocks([
        { itemName: "事業の内容", sectionKey: "business", text: "本文A" },
        { itemName: "リスク", sectionKey: "risks", text: "本文B" },
      ]) as Array<{ type: string; heading_2?: { rich_text: Array<{ text: { content: string } }> }; heading_3?: { rich_text: Array<{ text: { content: string } }> }; code?: { rich_text: Array<{ text: { content: string } }> } }>;
      expect(blocks.map((b) => b.type)).toEqual([
        "heading_2",
        "heading_3",
        "code",
        "heading_3",
        "code",
      ]);
      expect(blocks[0]?.heading_2?.rich_text[0]?.text.content).toBe(
        "抽出テキスト全文 (2項目)"
      );
      expect(blocks[1]?.heading_3?.rich_text[0]?.text.content).toBe(
        "事業の内容 (business)"
      );
      expect(blocks[2]?.code?.rich_text[0]?.text.content).toBe("本文A");
    });

    it("2000 文字超は code block に分割し欠落させない", async () => {
      const { buildTextBodyBlocks } = await load();
      const text = "あ".repeat(2001) + "い".repeat(2000);
      const blocks = buildTextBodyBlocks([
        { itemName: "長文", sectionKey: "long", text },
      ]) as Array<{ type: string; code?: { rich_text: Array<{ text: { content: string } }> } }>;
      const codes = blocks.filter((b) => b.type === "code");
      expect(codes).toHaveLength(3);
      expect(
        codes.map((b) => b.code?.rich_text[0]?.text.content).join("")
      ).toBe(text);
      for (const b of codes) {
        expect(
          [...(b.code?.rich_text[0]?.text.content ?? "")].length
        ).toBeLessThanOrEqual(2000);
      }
    });

    it("空本文でも空ブロックを 1 つ置く", async () => {
      const { buildTextBodyBlocks } = await load();
      const blocks = buildTextBodyBlocks([
        { itemName: "空", sectionKey: "empty", text: "" },
      ]) as Array<{ type: string }>;
      expect(blocks.map((b) => b.type)).toEqual([
        "heading_2",
        "heading_3",
        "code",
      ]);
    });
  });

  describe("ensureStockTextDb", () => {
    it("既存 DB のスキーマが揃っていれば PATCH しない。2 回目は 0 コール", async () => {
      route("GET", `/v1/databases/${"d".repeat(32)}`, [
        {
          properties: {
            文書: { type: "title" },
            D1文書ID: { type: "number" },
            銘柄コード: { type: "rich_text" },
            会計期末: { type: "date" },
            セクション件数: { type: "number" },
            文字数合計: { type: "number" },
            抽出状態: { type: "select" },
          },
        },
      ]);
      const { ensureStockTextDb } = await load();
      const first = await ensureStockTextDb();
      expect(first).toEqual({ dbId: "d".repeat(32) });
      expect(calls).toHaveLength(1);
      const second = await ensureStockTextDb();
      expect(second).toEqual(first);
      expect(calls).toHaveLength(1);
    });

    it("列が足りなければ非破壊 PATCH で足す", async () => {
      route("GET", `/v1/databases/${"d".repeat(32)}`, [
        { properties: { 文書: { type: "title" } } },
      ]);
      route("PATCH", `/v1/databases/${"d".repeat(32)}`, [{}]);
      const { ensureStockTextDb } = await load();
      const got = await ensureStockTextDb();
      expect(got).toEqual({ dbId: "d".repeat(32) });
      expect(calls).toHaveLength(2);
      const patchBody = JSON.parse(String(calls[1]?.init.body)) as {
        properties: Record<string, unknown>;
      };
      expect(Object.keys(patchBody.properties).sort()).toEqual(
        [
          "D1文書ID",
          "セクション件数",
          "抽出状態",
          "会計期末",
          "文字数合計",
          "銘柄コード",
        ].sort()
      );
    });
  });

  describe("upsertStockTextRow", () => {
    const doc = {
      docId: "S100TEST",
      stockCode: "7203",
      fiscalYearEnd: "2026-03-31",
      d1DocumentId: 42,
      textParseStatus: "ok",
    };
    const sections = [
      { itemName: "事業の内容", sectionKey: "business", text: "本文A" },
    ];

    it("既存行はスキップして作らない", async () => {
      route("POST", "/v1/databases/db-7203/query", [dbQuery(["row-exists"])]);
      const { upsertStockTextRow } = await load();
      const got = await upsertStockTextRow({
        dbId: "db-7203",
        doc,
        sections,
      });
      expect(got).toEqual({
        rowPageId: "row-exists",
        outcome: "skipped_existing",
      });
      expect(calls).toHaveLength(1);
    });

    it("新規行はプロパティ鏡像 + 本文直付けで作る", async () => {
      route("POST", "/v1/databases/db-7203/query", [dbQuery([])]);
      route("POST", "/v1/pages", [{ id: "row-new" }]);
      const { upsertStockTextRow } = await load();
      const got = await upsertStockTextRow({
        dbId: "db-7203",
        doc,
        sections,
      });
      expect(got).toEqual({ rowPageId: "row-new", outcome: "recorded" });
      const body = JSON.parse(String(calls[1]?.init.body)) as {
        properties: Record<string, unknown>;
        children: unknown[];
      };
      expect(body.properties).toMatchObject({
        文書: { title: [{ type: "text", text: { content: "S100TEST" } }] },
        D1文書ID: { number: 42 },
        会計期末: { date: { start: "2026-03-31" } },
        セクション件数: { number: 1 },
        抽出状態: { select: { name: "ok" } },
      });
      expect(body.children).toHaveLength(3);
    });

    it("100 ブロック超は追記に分割する", async () => {
      const many = Array.from({ length: 60 }, (_, i) => ({
        itemName: `項目${i}`,
        sectionKey: `k${i}`,
        text: "x".repeat(2100),
      }));
      // 1 + 60×(1+2) = 181 ブロック → 作成 100 + 追記 81
      route("POST", "/v1/databases/db-7203/query", [dbQuery([])]);
      route("POST", "/v1/pages", [{ id: "row-big" }]);
      route("PATCH", "/v1/blocks/row-big/children", [{}]);
      const { upsertStockTextRow } = await load();
      const got = await upsertStockTextRow({
        dbId: "db-7203",
        doc,
        sections: many,
      });
      expect(got.outcome).toBe("recorded");
      const created = JSON.parse(String(calls[1]?.init.body)) as {
        children: unknown[];
      };
      const appended = JSON.parse(String(calls[2]?.init.body)) as {
        children: unknown[];
      };
      expect(created.children).toHaveLength(100);
      expect(appended.children).toHaveLength(81);
    });

    it("force は旧行を archived して作り直す", async () => {
      route("POST", "/v1/databases/db-7203/query", [dbQuery(["row-old"])]);
      route("PATCH", "/v1/pages/row-old", [{}]);
      route("POST", "/v1/pages", [{ id: "row-new" }]);
      const { upsertStockTextRow } = await load();
      const got = await upsertStockTextRow({
        dbId: "db-7203",
        doc,
        sections,
        force: true,
      });
      expect(got).toEqual({ rowPageId: "row-new", outcome: "recorded" });
      const archived = JSON.parse(String(calls[1]?.init.body)) as {
        archived: boolean;
      };
      expect(archived).toEqual({ archived: true });
    });
  });

  describe("readStockTextRow", () => {
    const h2 = (text: string) => ({
      id: "b0",
      type: "heading_2",
      heading_2: { rich_text: [{ plain_text: text }] },
    });
    const h3 = (id: string, text: string) => ({
      id,
      type: "heading_3",
      heading_3: { rich_text: [{ plain_text: text }] },
    });
    const code = (id: string, text: string) => ({
      id,
      type: "code",
      code: { rich_text: [{ plain_text: text }] },
    });

    it("本文を見出しで区切って復元する (複数ブロック連結)", async () => {
      route("GET", "/v1/blocks/row-1/children", [
        childrenPage([
          h2("抽出テキスト全文 (2項目)"),
          h3("b1", "事業の内容 (business)"),
          code("b2", "前半"),
          code("b3", "後半"),
          h3("b4", "リスク (risks)"),
          code("b5", "本文B"),
        ]),
      ]);
      const { readStockTextRow } = await load();
      const got = await readStockTextRow("row-1");
      expect(got).toEqual([
        { itemName: "事業の内容", sectionKey: "business", text: "前半後半" },
        { itemName: "リスク", sectionKey: "risks", text: "本文B" },
      ]);
    });

    it("ページネーションを辿る", async () => {
      route("GET", "/v1/blocks/row-1/children", [
        childrenPage([h2("抽出テキスト全文 (1項目)"), h3("b1", "A (a)")], true, "c"),
        childrenPage([code("b2", "続き")]),
      ]);
      const { readStockTextRow } = await load();
      expect(await readStockTextRow("row-1")).toEqual([
        { itemName: "A", sectionKey: "a", text: "続き" },
      ]);
    });

    it("先頭が目印でなければ throw (黙って解釈しない)", async () => {
      route("GET", "/v1/blocks/row-1/children", [
        childrenPage([h3("b1", "A (a)"), code("b2", "x")]),
      ]);
      const { readStockTextRow } = await load();
      await expect(readStockTextRow("row-1")).rejects.toThrow("目印ではない");
    });

    it("見出しの無い本文・想定外ブロックは throw", async () => {
      route("GET", "/v1/blocks/row-1/children", [
        childrenPage([h2("抽出テキスト全文 (1項目)"), code("b9", "浮遊")]),
      ]);
      const { readStockTextRow: read1 } = await load();
      await expect(read1("row-1")).rejects.toThrow("見出しの無い本文");

      vi.resetModules();
      routes.set("GET /v1/blocks/row-2/children", [
        childrenPage([
          h2("抽出テキスト全文 (1項目)"),
          { id: "bx", type: "table" },
        ]),
      ]);
      const { readStockTextRow: read2 } = await load();
      await expect(read2("row-2")).rejects.toThrow("想定外ブロック");
    });
  });
});
