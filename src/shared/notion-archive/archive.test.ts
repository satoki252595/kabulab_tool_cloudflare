/**
 * `archive.ts` の単体テスト (2026-09-27 新規)。
 *
 * `recordPrimaryData` / `moveToTrash` / `isArchived` へ `parentPageId` を
 * 追加する変更に先立って書いた (計画: Phase 0 共通ライブラリの変更)。
 * 目的は2つ:
 *   1. `parentPageId` を省略した既存呼び出し元 7 ファイルの挙動が変わらない
 *      ことを担保する (既定 = `NOTION_ARCHIVE_PAGE_ID()`)。
 *   2. `parentPageId` を明示すると、その親ページ配下の
 *      「一次データ｜<service>」/「ごみ｜<service>」を見る (dbCache が
 *      親ページ ID ごとに分かれ、既定と取り違えない)。
 *
 * fetch のモック方式は price-sync-log.test.ts / biztag-ledger.test.ts と同じ
 * (route map + vi.resetModules() でモジュール内キャッシュを毎回リセット)。
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

const ARCHIVE_PAGE = "a".repeat(32);
const OTHER_PAGE = "b".repeat(32);

describe("notion-archive archive (parentPageId)", () => {
  const ORIG_ENV = { ...process.env };
  let originalFetch: typeof globalThis.fetch;
  let calls: FetchCalls;
  let routes: Map<string, unknown[]>;

  const route = (method: string, path: string, bodies: unknown[]) => {
    routes.set(`${method} ${path}`, [...bodies]);
  };

  const emptyChildren = () => ({ results: [], has_more: false, next_cursor: null });
  const emptySearch = () => ({ results: [], has_more: false, next_cursor: null });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
    routes = new Map();
    process.env.NOTION_TOKEN = "dummy-token";
    process.env.NOTION_ARCHIVE_PAGE_ID = ARCHIVE_PAGE;
    vi.resetModules();
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const u = new URL(String(url));
      const key = `${init?.method ?? "GET"} ${u.pathname}`;
      const q = routes.get(key);
      if (!q || q.length === 0) throw new Error(`テスト: 未定義ルートへの fetch: ${key}`);
      return jsonResponse(q.shift());
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...ORIG_ENV };
    vi.resetModules();
  });

  const load = () => import("./archive.js");

  describe("recordPrimaryData", () => {
    it("parentPageId 省略時は NOTION_ARCHIVE_PAGE_ID 配下の「一次データ｜<service>」を使う (既存挙動)", async () => {
      route("POST", "/v1/search", [emptySearch()]);
      route("GET", `/v1/blocks/${ARCHIVE_PAGE}/children`, [emptyChildren()]);
      route("POST", "/v1/databases", [{ id: "db-default" }]);
      route("POST", `/v1/databases/db-default/query`, [{ results: [] }]);
      route("POST", "/v1/pages", [{ id: "page-1" }]);

      const { recordPrimaryData } = await load();
      const result = await recordPrimaryData({
        service: "moneyflow",
        key: "k1",
        source: "https://example.test/a",
        metadata: { a: 1 },
      });

      expect(result).toEqual({ pageId: "page-1", outcome: "recorded", fileTooLarge: false });
      const createCall = calls.find((c) => new URL(c.url).pathname === "/v1/databases");
      const createBody = JSON.parse(String(createCall?.init.body)) as {
        parent: { page_id: string };
        title: Array<{ text: { content: string } }>;
      };
      expect(createBody.parent.page_id).toBe(ARCHIVE_PAGE);
      expect(createBody.title[0]?.text.content).toBe("一次データ｜moneyflow");
    });

    it("parentPageId を明示すると、その親ページ配下の DB を探す/作る", async () => {
      route("POST", "/v1/search", [emptySearch()]);
      route("GET", `/v1/blocks/${OTHER_PAGE}/children`, [emptyChildren()]);
      route("POST", "/v1/databases", [{ id: "db-custom" }]);
      route("POST", `/v1/databases/db-custom/query`, [{ results: [] }]);
      route("POST", "/v1/pages", [{ id: "page-2" }]);

      const { recordPrimaryData } = await load();
      const result = await recordPrimaryData({
        service: "moneyflow",
        key: "k1",
        source: "https://example.test/a",
        metadata: { a: 1 },
        parentPageId: OTHER_PAGE,
      });

      expect(result.pageId).toBe("page-2");
      const createCall = calls.find((c) => new URL(c.url).pathname === "/v1/databases");
      const createBody = JSON.parse(String(createCall?.init.body)) as {
        parent: { page_id: string };
      };
      // NOTION_ARCHIVE_PAGE_ID (既定) ではなく、明示した OTHER_PAGE 配下に作る。
      expect(createBody.parent.page_id).toBe(OTHER_PAGE);
      expect(createBody.parent.page_id).not.toBe(ARCHIVE_PAGE);
    });

    it("dbCache は親ページ ID ごとに分かれる (同じ service 名でも取り違えない)", async () => {
      route("POST", "/v1/search", [emptySearch(), emptySearch()]);
      route("GET", `/v1/blocks/${ARCHIVE_PAGE}/children`, [emptyChildren()]);
      route("GET", `/v1/blocks/${OTHER_PAGE}/children`, [emptyChildren()]);
      route("POST", "/v1/databases", [{ id: "db-default" }, { id: "db-custom" }]);
      route("POST", `/v1/databases/db-default/query`, [{ results: [] }]);
      route("POST", `/v1/databases/db-custom/query`, [{ results: [] }]);
      route("POST", "/v1/pages", [{ id: "page-a" }, { id: "page-b" }]);

      const { recordPrimaryData } = await load();
      const r1 = await recordPrimaryData({
        service: "moneyflow",
        key: "k1",
        source: "s",
        metadata: {},
      });
      const r2 = await recordPrimaryData({
        service: "moneyflow",
        key: "k1",
        source: "s",
        metadata: {},
        parentPageId: OTHER_PAGE,
      });

      expect(r1.pageId).toBe("page-a");
      expect(r2.pageId).toBe("page-b");
      // 2 回とも DB 作成 (Search) が走った = キャッシュを共有していない
      expect(calls.filter((c) => new URL(c.url).pathname === "/v1/search")).toHaveLength(2);
    });

    it("同一 parentPageId・同一 service の 2 回目はキャッシュを再利用し Search しない", async () => {
      route("POST", "/v1/search", [emptySearch()]);
      route("GET", `/v1/blocks/${ARCHIVE_PAGE}/children`, [emptyChildren()]);
      route("POST", "/v1/databases", [{ id: "db-default" }]);
      route("POST", `/v1/databases/db-default/query`, [{ results: [] }, { results: [] }]);
      route("POST", "/v1/pages", [{ id: "page-a" }, { id: "page-b" }]);

      const { recordPrimaryData } = await load();
      await recordPrimaryData({ service: "moneyflow", key: "k1", source: "s", metadata: {} });
      await recordPrimaryData({ service: "moneyflow", key: "k2", source: "s", metadata: {} });

      expect(calls.filter((c) => new URL(c.url).pathname === "/v1/search")).toHaveLength(1);
    });

    it("既存 key があれば冪等スキップする (parentPageId 指定時も同じ)", async () => {
      route("POST", "/v1/search", [emptySearch()]);
      route("GET", `/v1/blocks/${OTHER_PAGE}/children`, [emptyChildren()]);
      route("POST", "/v1/databases", [{ id: "db-custom" }]);
      route("POST", `/v1/databases/db-custom/query`, [{ results: [{ id: "existing-page" }] }]);

      const { recordPrimaryData } = await load();
      const result = await recordPrimaryData({
        service: "moneyflow",
        key: "k1",
        source: "s",
        metadata: {},
        parentPageId: OTHER_PAGE,
      });

      expect(result).toEqual({ pageId: "existing-page", outcome: "skipped_existing", fileTooLarge: false });
      expect(calls.filter((c) => new URL(c.url).pathname === "/v1/pages")).toHaveLength(0);
    });
  });

  describe("isArchived", () => {
    it("parentPageId 省略時は既定ページ配下を見る", async () => {
      route("POST", "/v1/search", [emptySearch()]);
      route("GET", `/v1/blocks/${ARCHIVE_PAGE}/children`, [emptyChildren()]);
      route("POST", "/v1/databases", [{ id: "db-default" }]);
      route("POST", `/v1/databases/db-default/query`, [{ results: [{ id: "p" }] }]);

      const { isArchived } = await load();
      const result = await isArchived("moneyflow", "k1");
      expect(result).toBe(true);
      const createBody = JSON.parse(
        String(calls.find((c) => new URL(c.url).pathname === "/v1/databases")?.init.body)
      ) as { parent: { page_id: string } };
      expect(createBody.parent.page_id).toBe(ARCHIVE_PAGE);
    });

    it("parentPageId 指定時はそのページ配下を見る", async () => {
      route("POST", "/v1/search", [emptySearch()]);
      route("GET", `/v1/blocks/${OTHER_PAGE}/children`, [emptyChildren()]);
      route("POST", "/v1/databases", [{ id: "db-custom" }]);
      route("POST", `/v1/databases/db-custom/query`, [{ results: [] }]);

      const { isArchived } = await load();
      const result = await isArchived("moneyflow", "k1", OTHER_PAGE);
      expect(result).toBe(false);
      const createBody = JSON.parse(
        String(calls.find((c) => new URL(c.url).pathname === "/v1/databases")?.init.body)
      ) as { parent: { page_id: string } };
      expect(createBody.parent.page_id).toBe(OTHER_PAGE);
    });
  });

  describe("moveToTrash", () => {
    const originPageProps = {
      id: "origin-1",
      url: "https://notion.so/origin-1",
      properties: {
        Key: { title: [{ plain_text: "k1" }] },
        Source: { rich_text: [{ plain_text: "s" }] },
        Metadata: { rich_text: [{ plain_text: "{}" }] },
        Files: { files: [] },
      },
    };

    it("parentPageId 省略時は既定ページ配下の「ごみ｜<service>」へ退避する", async () => {
      route("GET", "/v1/pages/origin-1", [originPageProps]);
      route("POST", "/v1/search", [emptySearch()]);
      route("GET", `/v1/blocks/${ARCHIVE_PAGE}/children`, [emptyChildren()]);
      route("POST", "/v1/databases", [{ id: "trash-default" }]);
      route("POST", "/v1/pages", [{ id: "trash-page-1" }]);
      route("PATCH", "/v1/pages/origin-1", [{ id: "origin-1" }]);

      const { moveToTrash } = await load();
      const result = await moveToTrash({
        service: "moneyflow",
        originPageId: "origin-1",
        reason: "テスト",
      });

      expect(result).toEqual({ trashPageId: "trash-page-1" });
      const createBody = JSON.parse(
        String(calls.find((c) => new URL(c.url).pathname === "/v1/databases")?.init.body)
      ) as { parent: { page_id: string }; title: Array<{ text: { content: string } }> };
      expect(createBody.parent.page_id).toBe(ARCHIVE_PAGE);
      expect(createBody.title[0]?.text.content).toBe("ごみ｜moneyflow");
    });

    it("parentPageId 指定時はそのページ配下の「ごみ｜<service>」へ退避する", async () => {
      route("GET", "/v1/pages/origin-1", [originPageProps]);
      route("POST", "/v1/search", [emptySearch()]);
      route("GET", `/v1/blocks/${OTHER_PAGE}/children`, [emptyChildren()]);
      route("POST", "/v1/databases", [{ id: "trash-custom" }]);
      route("POST", "/v1/pages", [{ id: "trash-page-2" }]);
      route("PATCH", "/v1/pages/origin-1", [{ id: "origin-1" }]);

      const { moveToTrash } = await load();
      const result = await moveToTrash({
        service: "moneyflow",
        originPageId: "origin-1",
        reason: "テスト",
        parentPageId: OTHER_PAGE,
      });

      expect(result).toEqual({ trashPageId: "trash-page-2" });
      const createBody = JSON.parse(
        String(calls.find((c) => new URL(c.url).pathname === "/v1/databases")?.init.body)
      ) as { parent: { page_id: string } };
      expect(createBody.parent.page_id).toBe(OTHER_PAGE);
    });
  });
});
