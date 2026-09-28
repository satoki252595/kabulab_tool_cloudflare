/**
 * scripts/moneyflow/lib/archived-files.ts のテスト。
 * fetch のモック方式は src/shared/notion-archive/archive.test.ts と同じ
 * (route map + vi.resetModules())。
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

describe("moneyflow archived-files", () => {
  const ORIG_ENV = { ...process.env };
  let originalFetch: typeof globalThis.fetch;
  let calls: FetchCalls;
  let routes: Map<string, unknown[]>;

  const route = (method: string, path: string, bodies: unknown[]) => {
    routes.set(`${method} ${path}`, [...bodies]);
  };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
    routes = new Map();
    process.env.NOTION_TOKEN = "dummy-token";
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

  const load = () => import("./archived-files.js");

  describe("findArchivedRecordByKey", () => {
    const dbId = "primary-db";
    const row = (id: string, key: string) => ({
      id,
      properties: {
        Key: { title: [{ plain_text: key }] },
        Files: { files: [{ name: "a.json", file: { url: "https://files.example.test/a.json" } }] },
      },
    });

    it("無ければ null を返す", async () => {
      route("POST", `/v1/databases/${dbId}/query`, [{ results: [] }]);
      const { findArchivedRecordByKey } = await load();
      await expect(findArchivedRecordByKey(dbId, "k1")).resolves.toBeNull();
    });

    it("1件ならキーとファイルを取り出す", async () => {
      route("POST", `/v1/databases/${dbId}/query`, [{ results: [row("page-1", "k1")] }]);
      const { findArchivedRecordByKey } = await load();
      await expect(findArchivedRecordByKey(dbId, "k1")).resolves.toEqual({
        pageId: "page-1",
        key: "k1",
        files: [{ name: "a.json", url: "https://files.example.test/a.json" }],
      });
    });

    it("同一キーが2件ならどれも選ばず throw する (再解析の取り違え防止)", async () => {
      route("POST", `/v1/databases/${dbId}/query`, [
        { results: [row("page-1", "k1"), row("page-2", "k1")] },
      ]);
      const { findArchivedRecordByKey } = await load();
      await expect(findArchivedRecordByKey(dbId, "k1")).rejects.toThrow(
        /保管済みレコードの重複 key=k1 を選ばず保全停止/
      );
      expect(calls).toHaveLength(1);
    });
  });
});
