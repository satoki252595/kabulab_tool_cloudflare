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
    has_more: false,
    next_cursor: null,
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
        "抽出テキスト全文 (2項目) [json-escaped-v2]"
      );
      expect(blocks[1]?.heading_3?.rich_text[0]?.text.content).toBe(
        '["事業の内容","business"]'
      );
      expect(blocks[2]?.code?.rich_text[0]?.text.content).toBe('"本文A"');
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
        JSON.parse(codes.map((b) => b.code?.rich_text[0]?.text.content).join(""))
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

    it.each(["itemName", "sectionKey", "text"])("非string %s は保存前に拒否する", async (field) => {
      const { buildTextBodyBlocks } = await load();
      const section = { itemName: "事業の内容", sectionKey: "business", text: "本文A", [field]: 0 };
      expect(() => buildTextBodyBlocks([section] as never)).toThrow("入力型");
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

    it("force の入力不正は旧 archive・新 create の前に停止する", async () => {
      route("POST", "/v1/databases/db-7203/query", [dbQuery(["row-old"])]);
      const { upsertStockTextRow } = await load();
      await expect(upsertStockTextRow({
        dbId: "db-7203", doc, sections: [sections[0]!, sections[0]!], force: true,
      })).rejects.toThrow("キー重複");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://api.notion.com/v1/databases/db-7203/query");
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

    it("v2 は既知 U+200B 除去後も、分割した JSON と補助文字を原文へ復元する", async () => {
      const { buildTextBodyBlocks, readStockTextRow } = await load();
      // 原本で再現した消失条件を文法境界として固定する。報告書データではない。
      const sections = [{
        itemName: "事業\u200bの内容",
        sectionKey: "business",
        text: "あ".repeat(1995) + "\u200b😀\u{E0001}\\u200b\n\t\"",
      }, { itemName: "空", sectionKey: "empty", text: "" }];
      const blocks = buildTextBodyBlocks(sections) as Array<{
        type: "heading_2" | "heading_3" | "code";
        heading_2?: { rich_text: Array<{ text: { content: string } }> };
        heading_3?: { rich_text: Array<{ text: { content: string } }> };
        code?: { rich_text: Array<{ text: { content: string } }> };
      }>;
      const returned = blocks.map((block, i) => {
        const body = block[block.type]!;
        for (const rich of body.rich_text) {
          expect(rich.text.content.length).toBeLessThanOrEqual(2000);
          expect(rich.text.content).not.toMatch(/\p{Cf}/u);
          expect(rich.text.content).not.toMatch(/[\uD800-\uDFFF]/);
        }
        return {
          id: `b${i}`, type: block.type,
          [block.type]: { rich_text: body.rich_text.map((rich) => ({
            plain_text: rich.text.content.replaceAll("\u200b", ""),
          })) },
        };
      });
      route("GET", "/v1/blocks/row-1/children", [childrenPage(returned)]);
      expect(await readStockTextRow("row-1")).toEqual(sections);
    });

    it.each([
      { marker: "抽出テキスト全文 (1項目) [json-escaped-v3]", heading: '["A","a"]', text: '"本文"' },
      { marker: "抽出テキスト全文 (2項目) [json-escaped-v2]", heading: '["A","a"]', text: '"本文"' },
      { marker: "抽出テキスト全文 (1項目) [json-escaped-v2]", heading: '["A"]', text: '"本文"' },
      { marker: "抽出テキスト全文 (1項目) [json-escaped-v2]", heading: '["A","a"]', text: "0" },
      { marker: "抽出テキスト全文 (1項目) [json-escaped-v2]", heading: '["A","a"]', text: '"未終端' },
      { marker: "抽出テキスト全文 (1項目) [json-escaped-v2]", heading: '["A","a"]', text: '"\\u200B"' },
    ])("v2 の未知版・件数矛盾・不正 payload は停止する: $marker / $text", async ({ marker, heading, text }) => {
      route("GET", "/v1/blocks/row-1/children", [
        childrenPage([h2(marker), h3("b1", heading), code("b2", text)]),
      ]);
      const { readStockTextRow } = await load();
      await expect(readStockTextRow("row-1")).rejects.toThrow();
    });

    it("v2 の重複 sectionKey は部分成功にしない", async () => {
      route("GET", "/v1/blocks/row-1/children", [childrenPage([
        h2("抽出テキスト全文 (2項目) [json-escaped-v2]"),
        h3("b1", '["A","a"]'), code("b2", '"前半"'),
        h3("b3", '["B","a"]'), code("b4", '"後半"'),
      ])]);
      const { readStockTextRow } = await load();
      await expect(readStockTextRow("row-1")).rejects.toThrow("キー重複");
    });

    it.each([undefined, [], [{}], [{ plain_text: "" }], [{ plain_text: "省略", text: { content: "原文" } }]])(
      "v2 の途中 fragment 欠落/不一致を空文字で埋めない: %j", async (rich_text) => {
        route("GET", "/v1/blocks/row-1/children", [childrenPage([
          h2("抽出テキスト全文 (1項目) [json-escaped-v2]"),
          h3("b1", '["A","a"]'), code("b2", '"前'),
          { id: "b3", type: "code", code: { rich_text } }, code("b4", '後"'),
        ])]);
        const { readStockTextRow } = await load();
        await expect(readStockTextRow("row-1")).rejects.toThrow();
      }
    );

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

    it("旧 plain-v1 の JSON 風文字列は decode せず保持する", async () => {
      const text = '"\\u200b"';
      route("GET", "/v1/blocks/row-1/children", [childrenPage([
        h2("抽出テキスト全文 (1項目)"),
        h3("b1", "A (a)"), code("b2", text),
      ])]);
      const { readStockTextRow } = await load();
      expect(await readStockTextRow("row-1")).toEqual([
        { itemName: "A", sectionKey: "a", text },
      ]);
    });

    it("backup専用strict nativeはlegacy原文を保持し、欠落fragment/不正childを空本文へ変換しない", async () => {
      const text = ' "\\u200b" \u200b𠮷';
      const native = [h2("抽出テキスト全文 (1項目)"), h3("b1", "A (a)"), code("b2", text)]
        .map((block, i) => ({ ...block, object: "block", has_children: false,
          id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          [block.type]: { rich_text: [{ type: "text", plain_text: i === 0 ? "抽出テキスト全文 (1項目)" : i === 1 ? "A (a)" : text,
            text: { content: i === 0 ? "抽出テキスト全文 (1項目)" : i === 1 ? "A (a)" : text } }] },
        }));
      route("GET", "/v1/blocks/row-strict/children", [childrenPage(native)]);
      const { readStockTextRow } = await load();
      expect(await readStockTextRow("row-strict", true)).toEqual([{ itemName: "A", sectionKey: "a", text }]);
      const malformed = { ...native[2], code: { rich_text: [{}] } };
      route("GET", "/v1/blocks/row-legacy/children", [childrenPage([native[0], native[1], malformed])]);
      expect(await readStockTextRow("row-legacy")).toEqual([{ itemName: "A", sectionKey: "a", text: "" }]);
      for (const [i, bad] of [malformed, { ...native[2], object: "page" },
        { ...native[2], id: "invalid" }, { ...native[2], has_children: true }].entries()) {
        route("GET", `/v1/blocks/row-bad-${i}/children`, [
          childrenPage([native[0], native[1]], true, "next"), childrenPage([bad]),
        ]);
        const before = calls.length;
        await expect(readStockTextRow(`row-bad-${i}`, true)).rejects.toThrow("native");
        expect(calls.length - before).toBe(2); // 全終端を既読したshape不正。再送なし。
      }
      const rich = (content: string) => [{ type: "text", plain_text: content, text: { content } }];
      route("GET", "/v1/blocks/row-bad-heading/children", [childrenPage([
        native[0], { ...native[1], heading_3: { rich_text: rich("キーのない見出し") } }, native[2],
      ])]);
      await expect(readStockTextRow("row-bad-heading", true)).rejects.toThrow("native 見出し");
      route("GET", "/v1/blocks/row-bad-count/children", [childrenPage([
        { ...native[0], heading_2: { rich_text: rich("抽出テキスト全文 (2項目)") } }, native[1], native[2],
      ])]);
      await expect(readStockTextRow("row-bad-count", true)).rejects.toThrow("件数またはキー重複");
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

    it("不正 envelope は共通 guard で部分成功にせず throw", async () => {
      route("GET", "/v1/blocks/row-1/children", [
        childrenPage(
          [h2("抽出テキスト全文 (1項目)"), h3("b1", "A (a)")],
          true,
          null
        ),
      ]);
      const { readStockTextRow } = await load();
      await expect(readStockTextRow("row-1")).rejects.toThrow(
        "Notion list 応答が不正 (endpoint=block-children)"
      );
    });

    it("反復カーソルは追加 GET 前に throw (2 GET で停止)", async () => {
      route("GET", "/v1/blocks/row-1/children", [
        childrenPage(
          [h2("抽出テキスト全文 (1項目)"), h3("b1", "A (a)")],
          true,
          "c"
        ),
        childrenPage([code("b2", "続き")], true, "c"),
        childrenPage([code("b3", "到達しない")]),
      ]);
      const { readStockTextRow } = await load();
      await expect(readStockTextRow("row-1")).rejects.toThrow(
        "next_cursor の反復"
      );
      expect(calls).toHaveLength(2);
    });

    it("正常 3 ページは頁をまたいだ節も全文復元する", async () => {
      route("GET", "/v1/blocks/row-1/children", [
        childrenPage(
          [h2("抽出テキスト全文 (2項目)"), h3("b1", "A (a)")],
          true,
          "c1"
        ),
        childrenPage([code("b2", "前半")], true, "c2"),
        childrenPage([
          code("b3", "後半"),
          h3("b4", "B (b)"),
          code("b5", "全文B"),
        ]),
      ]);
      const { readStockTextRow } = await load();
      expect(await readStockTextRow("row-1")).toEqual([
        { itemName: "A", sectionKey: "a", text: "前半後半" },
        { itemName: "B", sectionKey: "b", text: "全文B" },
      ]);
      expect(calls).toHaveLength(3);
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
