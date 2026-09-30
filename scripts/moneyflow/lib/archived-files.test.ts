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
    // 署名付き URL のバイト取得用。文字列ボディは raw バイトとして返す。
    arrayBuffer: async () =>
      new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)).buffer as ArrayBuffer,
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
      route("POST", `/v1/databases/${dbId}/query`, [{ results: [] , has_more: false, next_cursor: null }]);
      const { findArchivedRecordByKey } = await load();
      await expect(findArchivedRecordByKey(dbId, "k1")).resolves.toBeNull();
    });

    it("1件ならキーとファイルを取り出す", async () => {
      route("POST", `/v1/databases/${dbId}/query`, [{ results: [row("page-1", "k1")] , has_more: false, next_cursor: null }]);
      const { findArchivedRecordByKey } = await load();
      await expect(findArchivedRecordByKey(dbId, "k1")).resolves.toEqual({
        pageId: "page-1",
        key: "k1",
        files: [{ name: "a.json", url: "https://files.example.test/a.json" }],
      });
    });

    it("同一キーが2件ならどれも選ばず throw する (再解析の取り違え防止)", async () => {
      route("POST", `/v1/databases/${dbId}/query`, [
        { results: [row("page-1", "k1"), row("page-2", "k1")] , has_more: false, next_cursor: null },
      ]);
      const { findArchivedRecordByKey } = await load();
      await expect(findArchivedRecordByKey(dbId, "k1")).rejects.toThrow(
        /保管済みレコードの重複 key=k1 を選ばず保全停止/
      );
      expect(calls).toHaveLength(1);
    });
  });

  describe("verifyArchivedAttachments", () => {
    const pageId = "primary-1";
    const pageWith = (files: unknown[]) => ({
      properties: { Files: { type: "files", files } },
    });
    const hosted = (name: string) => ({
      name,
      type: "file",
      file: { url: `https://files.example.test/${name}` },
    });
    const want = (filename: string, text: string) => ({
      filename,
      bytes: new TextEncoder().encode(text),
    });

    it("件数・名前・バイト長・SHA256 が一致すれば resolve する", async () => {
      route("GET", `/v1/pages/${pageId}`, [pageWith([hosted("data.csv")])]);
      route("GET", "/data.csv", ["fresh!"]);
      const { verifyArchivedAttachments } = await load();
      await expect(verifyArchivedAttachments(pageId, "[test-src]", "k1", [want("data.csv", "fresh!")])).resolves
        .toBeUndefined();
      expect(calls).toHaveLength(2);
    });

    it("添付件数の不一致は書込前の保全停止にする", async () => {
      route("GET", `/v1/pages/${pageId}`, [pageWith([])]);
      const { verifyArchivedAttachments } = await load();
      await expect(verifyArchivedAttachments(pageId, "[test-src]", "k1", [want("data.csv", "fresh!")])).rejects.toThrow(
        /保管検証に失敗 key=k1 \(添付 0 件 ≠ 取得 1 件\)/
      );
    });

    it("同長でもバイト内容が違えば SHA256 不一致で停止する", async () => {
      route("GET", `/v1/pages/${pageId}`, [pageWith([hosted("data.csv")])]);
      route("GET", "/data.csv", ["fresh?"]);
      const { verifyArchivedAttachments } = await load();
      await expect(
        verifyArchivedAttachments(pageId, "[test-src]", "k1", [want("data.csv", "fresh!")])
      ).rejects.toThrow(/「data\.csv」の SHA256 不一致/);
    });

    it("外部リンク添付は hosted 要求で停止する", async () => {
      route("GET", `/v1/pages/${pageId}`, [
        pageWith([{ name: "data.csv", type: "external", external: { url: "https://example.jp/data.csv" } }]),
      ]);
      const { verifyArchivedAttachments } = await load();
      await expect(
        verifyArchivedAttachments(pageId, "[test-src]", "k1", [want("data.csv", "fresh!")])
      ).rejects.toThrow(/Notion-hosted 添付ではありません/);
    });
  });
});
