/**
 * 索引ページ確保・更新のテスト。
 *
 * fetch を差し替えて Notion 応答を定型で固定し、作成/更新/固定ID/
 * 再試行/重複整理の分岐を検証する (stock-text.test.ts と同じ形式)。
 * 待ち時間は opts で 0〜1ms に潰す (待ちのテストではないため)。
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

const BACKUP = "b".repeat(32);
const PINNED = "d".repeat(32);
const FIXED_AT = "2026-09-24T00:00:00.000Z";
const NO_WAIT = { findWaitsMs: [], settleWaitMs: 0 };

describe("notion-archive index-page", () => {
  const ORIG_ENV = { ...process.env };
  let originalFetch: typeof globalThis.fetch;
  let originalNow: typeof Date.now;
  let calls: FetchCalls;
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
    process.env.NOTION_ARCHIVE_PAGE_ID = BACKUP;
    delete process.env.NOTION_INDEX_PAGE_ID;
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

  const load = () => import("./index-page.js");

  const hit = (id: string, createdTime: string) => ({
    id,
    created_time: createdTime,
    parent: { type: "page_id", page_id: BACKUP },
    properties: {
      title: { type: "title", title: [{ plain_text: "アーカイブ索引" }] },
    },
  });
  const searchRes = (hits: unknown[]) => ({
    results: hits,
    has_more: false,
    next_cursor: null,
  });
  const childrenPage = (
    results: unknown[],
    has_more = false,
    next_cursor: string | null = null
  ) => ({ results, has_more, next_cursor });

  /** 発見フェーズの未ヒット (Search 空 + 保険走査空) */
  const routeFindEmpty = () => {
    route("POST", "/v1/search", [searchRes([])]);
    route("GET", `/v1/blocks/${BACKUP}/children`, [childrenPage([])]);
  };

  describe("ensureIndexPage", () => {
    it("無ければ作成し outcome=created (本文済みのため置換しない)", async () => {
      routeFindEmpty();
      route("POST", "/v1/pages", [{ id: "new-page", url: "https://x/new" }]);
      // 重複整理パス: 索引化前で空
      routes.get("POST /v1/search")?.push(searchRes([]));
      route("GET", "/v1/pages/new-page", [{ url: "https://notion.so/new" }]);
      const { ensureIndexPage } = await load();
      const r = await ensureIndexPage(FIXED_AT, NO_WAIT);
      expect(r).toEqual({
        pageId: "new-page",
        url: "https://notion.so/new",
        outcome: "created",
        archivedDuplicates: [],
      });
      expect(
        calls.some((c) => c.init.method === "DELETE")
      ).toBe(false);
    });

    it("あれば本文置換で outcome=updated (URL 維持)", async () => {
      route("POST", "/v1/search", [
        searchRes([hit("oldest", "2026-09-24T00:00:00.000Z")]),
        searchRes([hit("oldest", "2026-09-24T00:00:00.000Z")]),
      ]);
      route("GET", "/v1/blocks/oldest/children", [
        childrenPage([{ id: "b1", type: "paragraph" }], true, "cur1"),
        childrenPage([{ id: "b2", type: "heading_2" }]),
      ]);
      route("DELETE", "/v1/blocks/b1", [{}]);
      route("DELETE", "/v1/blocks/b2", [{}]);
      route("PATCH", "/v1/blocks/oldest/children", [{}]);
      route("GET", "/v1/pages/oldest", [{ url: "https://notion.so/oldest" }]);
      const { ensureIndexPage } = await load();
      const r = await ensureIndexPage(FIXED_AT, NO_WAIT);
      expect(r).toEqual({
        pageId: "oldest",
        url: "https://notion.so/oldest",
        outcome: "updated",
        archivedDuplicates: [],
      });
      expect(
        calls.filter((c) => c.init.method === "DELETE")
      ).toHaveLength(2);
    });

    it("NOTION_INDEX_PAGE_ID 設定時は Search せず直接更新する", async () => {
      process.env.NOTION_INDEX_PAGE_ID = PINNED;
      route("GET", `/v1/blocks/${PINNED}/children`, [childrenPage([])]);
      route("PATCH", `/v1/blocks/${PINNED}/children`, [{}]);
      route("GET", `/v1/pages/${PINNED}`, [{ url: "https://notion.so/pinned" }]);
      const { ensureIndexPage } = await load();
      const r = await ensureIndexPage(FIXED_AT, NO_WAIT);
      expect(r.pageId).toBe(PINNED);
      expect(r.outcome).toBe("updated");
      expect(calls.some((c) => c.url.endsWith("/v1/search"))).toBe(false);
    });

    it("再試行で見つかれば作成しない", async () => {
      route("POST", "/v1/search", [
        searchRes([]),
        searchRes([hit("late", "2026-09-24T00:00:00.000Z")]),
        searchRes([hit("late", "2026-09-24T00:00:00.000Z")]),
      ]);
      route("GET", `/v1/blocks/${BACKUP}/children`, [childrenPage([])]);
      route("GET", "/v1/blocks/late/children", [childrenPage([])]);
      route("PATCH", "/v1/blocks/late/children", [{}]);
      route("GET", "/v1/pages/late", [{ url: "https://notion.so/late" }]);
      const { ensureIndexPage } = await load();
      const r = await ensureIndexPage(FIXED_AT, {
        findWaitsMs: [1],
        settleWaitMs: 0,
      });
      expect(r.pageId).toBe("late");
      expect(r.outcome).toBe("updated");
      expect(calls.some((c) => c.url.endsWith("/v1/pages"))).toBe(false);
    });

    it("重複があれば最古を残して新参をアーカイブする", async () => {
      route("POST", "/v1/search", [
        searchRes([hit("oldest", "2026-09-24T00:00:00.000Z")]),
        searchRes([
          hit("newer", "2026-09-24T01:00:00.000Z"),
          hit("oldest", "2026-09-24T00:00:00.000Z"),
        ]),
      ]);
      route("PATCH", "/v1/pages/newer", [{}]);
      route("GET", "/v1/blocks/oldest/children", [childrenPage([])]);
      route("PATCH", "/v1/blocks/oldest/children", [{}]);
      route("GET", "/v1/pages/oldest", [{ url: "https://notion.so/oldest" }]);
      const { ensureIndexPage } = await load();
      const r = await ensureIndexPage(FIXED_AT, NO_WAIT);
      expect(r.pageId).toBe("oldest");
      expect(r.archivedDuplicates).toEqual(["newer"]);
      const patch = calls.find((c) => c.url.endsWith("/v1/pages/newer"));
      expect(JSON.parse(String(patch?.init.body))).toEqual({ archived: true });
    });

    it("作成後に旧正本が見つかればそちらへ収束する", async () => {
      routeFindEmpty();
      route("POST", "/v1/pages", [{ id: "just-created", url: "https://x/new" }]);
      routes.get("POST /v1/search")?.push(
        searchRes([
          hit("just-created", "2026-09-24T02:00:00.000Z"),
          hit("older", "2026-09-24T00:00:00.000Z"),
        ])
      );
      route("PATCH", "/v1/pages/just-created", [{}]);
      route("GET", "/v1/blocks/older/children", [childrenPage([])]);
      route("PATCH", "/v1/blocks/older/children", [{}]);
      route("GET", "/v1/pages/older", [{ url: "https://notion.so/older" }]);
      const { ensureIndexPage } = await load();
      const r = await ensureIndexPage(FIXED_AT, NO_WAIT);
      expect(r).toEqual({
        pageId: "older",
        url: "https://notion.so/older",
        outcome: "created",
        archivedDuplicates: ["just-created"],
      });
    });
  });

  describe("replacePageChildren", () => {
    it("追記は 100 件ずつ分割する", async () => {
      const pageId = "p1";
      route("GET", `/v1/blocks/${pageId}/children`, [childrenPage([])]);
      route("PATCH", `/v1/blocks/${pageId}/children`, [{}, {}, {}]);
      const { replacePageChildren } = await load();
      await replacePageChildren(
        pageId,
        Array.from({ length: 250 }, (_, i) => ({ n: i }))
      );
      const appends = calls.filter(
        (c) =>
          c.url.endsWith(`/v1/blocks/${pageId}/children`) &&
          c.init.method === "PATCH"
      );
      expect(appends).toHaveLength(3);
      const sizes = appends.map(
        (c) =>
          (JSON.parse(String(c.init.body)) as { children: unknown[] }).children
            .length
      );
      expect(sizes).toEqual([100, 100, 50]);
    });
  });
});
