/**
 * BACKUP/TRASH 直下の Search 完全一致探索のテスト (P6 重複事件の再発防止)。
 *
 * fetch を差し替えて /search・children の定型応答で固定し、完全一致絞り
 * (親一致・タイトル一致・非trash) と最古優先、Search 未ヒット時の保険走査、
 * 全ミス時の null を検証する。client.ts のペーシングは Date.now を進めて
 * 無効化する (stock-text.test.ts と同じ方式)。
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

const searchPage = (
  results: unknown[],
  has_more = false,
  next_cursor: string | null = null
) => ({ results, has_more, next_cursor });

const pageHit = (id: string, title: string, created: string, parent = BACKUP) => ({
  id,
  archived: false,
  in_trash: false,
  created_time: created,
  parent: { type: "page_id", page_id: parent },
  properties: { title: { type: "title", title: [{ plain_text: title }] } },
});

const dbHit = (id: string, title: string, created: string, parent = BACKUP) => ({
  id,
  created_time: created,
  parent: { type: "page_id", page_id: parent },
  title: [{ plain_text: title }],
});

const childrenPage = (
  results: unknown[],
  has_more = false,
  next_cursor: string | null = null
) => ({ results, has_more, next_cursor });

describe("notion-archive lookup", () => {
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
    process.env.NOTION_BACKUP_PAGE_ID = BACKUP;
    process.env.NOTION_TRASH_PAGE_ID = "c".repeat(32);
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

  const load = () => import("./archive.js");

  describe("selectOldestPageId", () => {
    it("空は null", async () => {
      const { selectOldestPageId } = await load();
      expect(selectOldestPageId([])).toBeNull();
    });

    it("複数ヒットは最古を返す", async () => {
      const { selectOldestPageId } = await load();
      expect(
        selectOldestPageId([
          { id: "new", createdTime: "2026-09-22T00:00:00.000Z" },
          { id: "old", createdTime: "2026-09-21T00:00:00.000Z" },
          { id: "mid", createdTime: "2026-09-21T12:00:00.000Z" },
        ])
      ).toBe("old");
    });
  });

  describe("findBackupChildByTitle", () => {
    it("完全一致の1件を返す (曖昧・他親・trash は除外)", async () => {
      route("POST", "/v1/search", [
        searchPage([
          pageHit("p-fuzzy", "720", "2026-09-20T00:00:00.000Z"),
          pageHit("p-other", "7203", "2026-09-20T00:00:00.000Z", "d".repeat(32)),
          {
            ...pageHit("p-trash", "7203", "2026-09-20T00:00:00.000Z"),
            in_trash: true,
          },
          pageHit("p-good", "7203", "2026-09-21T00:00:00.000Z"),
        ]),
      ]);
      const { findBackupChildByTitle } = await load();
      const got = await findBackupChildByTitle({
        parentPageId: BACKUP,
        title: "7203",
        kind: "page",
      });
      expect(got).toBe("p-good");
      expect(calls).toHaveLength(1);
      const body = JSON.parse(String(calls[0]?.init.body)) as {
        query: string;
        filter: { property: string; value: string };
      };
      expect(body.query).toBe("7203");
      expect(body.filter).toEqual({ property: "object", value: "page" });
    });

    it("重複時は最古を返す", async () => {
      route("POST", "/v1/search", [
        searchPage([
          pageHit("p-new", "7203", "2026-09-22T00:00:00.000Z"),
          pageHit("p-old", "7203", "2026-09-21T00:00:00.000Z"),
        ]),
      ]);
      const { findBackupChildByTitle } = await load();
      const got = await findBackupChildByTitle({
        parentPageId: BACKUP,
        title: "7203",
        kind: "page",
      });
      expect(got).toBe("p-old");
    });

    it("Search はページネーションを辿る", async () => {
      route("POST", "/v1/search", [
        searchPage(
          [pageHit("p-x", "0000", "2026-09-20T00:00:00.000Z")],
          true,
          "cur1"
        ),
        searchPage([pageHit("p-late", "7203", "2026-09-21T00:00:00.000Z")]),
      ]);
      const { findBackupChildByTitle } = await load();
      const got = await findBackupChildByTitle({
        parentPageId: BACKUP,
        title: "7203",
        kind: "page",
      });
      expect(got).toBe("p-late");
      expect(calls).toHaveLength(2);
    });

    it("Search 未ヒット時は children 先頭を保険走査する", async () => {
      route("POST", "/v1/search", [searchPage([])]);
      route("GET", `/v1/blocks/${BACKUP}/children`, [
        childrenPage([
          { id: "p-fallback", type: "child_page", child_page: { title: "7203" } },
        ]),
      ]);
      const { findBackupChildByTitle } = await load();
      const got = await findBackupChildByTitle({
        parentPageId: BACKUP,
        title: "7203",
        kind: "page",
      });
      expect(got).toBe("p-fallback");
      expect(calls).toHaveLength(2);
    });

    it("両方ミスは null (children は全走査しない)", async () => {
      route("POST", "/v1/search", [searchPage([])]);
      route("GET", `/v1/blocks/${BACKUP}/children`, [
        childrenPage(
          [{ id: "p1", type: "child_page", child_page: { title: "0000" } }],
          true,
          "c1"
        ),
        childrenPage(
          [{ id: "p2", type: "child_page", child_page: { title: "0001" } }],
          true,
          "c2"
        ),
        childrenPage(
          [{ id: "p3", type: "child_page", child_page: { title: "0002" } }],
          true,
          "c3"
        ),
        childrenPage(
          [{ id: "p4", type: "child_page", child_page: { title: "0003" } }],
          true,
          "c4"
        ),
        childrenPage(
          [{ id: "p5", type: "child_page", child_page: { title: "0004" } }],
          true,
          "c5"
        ),
      ]);
      const { findBackupChildByTitle } = await load();
      const got = await findBackupChildByTitle({
        parentPageId: BACKUP,
        title: "7203",
        kind: "page",
      });
      expect(got).toBeNull();
      // search 1 + 保険走査 5 で打ち切り (全走査しない)
      expect(calls).toHaveLength(6);
    });

    it("database 種別はトップレベル title で判定する", async () => {
      route("POST", "/v1/search", [
        searchPage([
          dbHit("db-old", "一次データ｜x", "2026-09-20T00:00:00.000Z"),
          dbHit("db-new", "一次データ｜x", "2026-09-21T00:00:00.000Z"),
        ]),
      ]);
      const { findBackupChildByTitle } = await load();
      const got = await findBackupChildByTitle({
        parentPageId: BACKUP,
        title: "一次データ｜x",
        kind: "database",
      });
      expect(got).toBe("db-old");
      const body = JSON.parse(String(calls[0]?.init.body)) as {
        filter: { property: string; value: string };
      };
      expect(body.filter).toEqual({ property: "object", value: "database" });
    });
  });
});
