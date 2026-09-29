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
import { sha256Hex, sha256HexBytes } from "../sha256.js";

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
      const body = q.shift();
      return body instanceof Response ? body : jsonResponse(body);
    }) as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

      expect(result).toEqual({ pageId: "page-1", outcome: "recorded", fileTooLarge: false, manifestMatch: "written" });
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

      expect(result).toEqual({ pageId: "existing-page", outcome: "skipped_existing", fileTooLarge: false, manifestMatch: "unknown" });
      expect(calls.filter((c) => new URL(c.url).pathname === "/v1/pages")).toHaveLength(0);
    });
  });

  describe("recordPrimaryData fileManifest", () => {
    const routeNewDb = (dbId: string) => {
      route("POST", "/v1/search", [emptySearch()]);
      route("GET", `/v1/blocks/${ARCHIVE_PAGE}/children`, [emptyChildren()]);
      route("POST", "/v1/databases", [{ id: dbId }]);
    };
    const routeUploadOk = (uploadId: string, wsMax = 5242880) => {
      route("GET", "/v1/users/me", [{ bot: { workspace_limits: { max_file_upload_size_in_bytes: wsMax } } }]);
      route("POST", "/v1/file_uploads", [{ id: uploadId, status: "pending" }]);
      route("POST", `/v1/file_uploads/${uploadId}/send`, [{}]);
      route("GET", `/v1/file_uploads/${uploadId}`, [{ id: uploadId, status: "uploaded" }]);
    };
    const lastPageBody = () => {
      const pageCalls = calls.filter((c) => new URL(c.url).pathname === "/v1/pages");
      return JSON.parse(String(pageCalls[pageCalls.length - 1]?.init.body)) as {
        properties: {
          Metadata: { rich_text: Array<{ text: { content: string } }> };
          Status: { select: { name: string } };
        };
      };
    };
    const manifestOfLastPage = () => {
      const metaText = lastPageBody().properties.Metadata.rich_text.map((t) => t.text.content).join("");
      return (JSON.parse(metaText) as Record<string, unknown>)["_fileManifest"] as {
        version: number;
        files: Array<Record<string, unknown>>;
        inputFingerprint: string;
      };
    };

    it("caller metadata の偽 _fileManifest は fetch 前に拒否する", async () => {
      const { recordPrimaryData } = await load();
      await expect(
        recordPrimaryData({
          service: "moneyflow",
          key: "k1",
          source: "s",
          metadata: { _fileManifest: { version: 1 } },
        })
      ).rejects.toThrow(/予約キー _fileManifest/);
      expect(calls).toHaveLength(0);
    });

    it("入力 bytes の事後書換えは sha と upload の両方に影響しない (freeze)", async () => {
      routeNewDb("db-1");
      route("POST", "/v1/databases/db-1/query", [{ results: [] }]);
      routeUploadOk("upload-1");
      route("POST", "/v1/pages", [{ id: "page-1" }]);

      const original = new TextEncoder().encode("original-data");
      const expectSha = await sha256HexBytes(original);
      const bytes = new Uint8Array(original);
      const { recordPrimaryData } = await load();
      const p = recordPrimaryData({
        service: "moneyflow",
        key: "k1",
        source: "s",
        metadata: {},
        files: [{ bytes, filename: "a.txt", contentType: "text/plain" }],
      });
      bytes.fill(0);
      const result = await p;
      expect(result.outcome).toBe("recorded");
      const manifest = manifestOfLastPage();
      expect(manifest.files).toHaveLength(1);
      expect(manifest.files[0]?.sha256).toBe(expectSha);
      const sendCall = calls.find((c) => new URL(c.url).pathname.endsWith("/send"));
      const sentFile = (sendCall?.init.body as FormData).get("file") as Blob;
      expect([...new Uint8Array(await sentFile.arrayBuffer())]).toEqual([...original]);
    });

    it("同一 key・同一 manifest なら skipped_existing + same で書込0", async () => {
      routeNewDb("db-1");
      route("POST", "/v1/databases/db-1/query", [{ results: [] }]);
      routeUploadOk("upload-1");
      route("POST", "/v1/pages", [{ id: "page-1" }]);
      const { recordPrimaryData } = await load();
      const input = {
        service: "moneyflow",
        key: "k1",
        source: "s",
        metadata: {},
        files: [{ bytes: new TextEncoder().encode("v1"), filename: "a.txt", contentType: "text/plain" }],
      };
      await recordPrimaryData(input);
      const written = manifestOfLastPage();
      expect(written.version).toBe(1);

      // 2 回目: 保管済み行に manifest あり・同一入力 → skip + same。
      calls.length = 0;
      routes.clear();
      routeNewDb("db-1");
      route("POST", "/v1/databases/db-1/query", [
        {
          results: [
            {
              id: "page-1",
              properties: {
                Metadata: { rich_text: [{ plain_text: JSON.stringify({ _fileManifest: written }) }] },
              },
            },
          ],
        },
      ]);
      const r2 = await recordPrimaryData({ ...input, files: [{ bytes: new TextEncoder().encode("v1"), filename: "a.txt", contentType: "text/plain" }] });
      expect(r2).toEqual({ pageId: "page-1", outcome: "skipped_existing", fileTooLarge: false, manifestMatch: "same" });
      expect(calls.filter((c) => new URL(c.url).pathname === "/v1/pages")).toHaveLength(0);
      expect(calls.filter((c) => new URL(c.url).pathname.includes("file_uploads"))).toHaveLength(0);
    });

    it("同一 key・入力変更なら STOP し、書込0", async () => {
      routeNewDb("db-1");
      route("POST", "/v1/databases/db-1/query", [{ results: [] }]);
      routeUploadOk("upload-1");
      route("POST", "/v1/pages", [{ id: "page-1" }]);
      const { recordPrimaryData } = await load();
      await recordPrimaryData({
        service: "moneyflow",
        key: "k1",
        source: "s",
        metadata: {},
        files: [{ bytes: new TextEncoder().encode("v1"), filename: "a.txt", contentType: "text/plain" }],
      });
      const written = manifestOfLastPage();

      calls.length = 0;
      routes.clear();
      routeNewDb("db-1");
      route("POST", "/v1/databases/db-1/query", [
        {
          results: [
            {
              id: "page-1",
              properties: {
                Metadata: { rich_text: [{ plain_text: JSON.stringify({ _fileManifest: written }) }] },
              },
            },
          ],
        },
      ]);
      await expect(
        recordPrimaryData({
          service: "moneyflow",
          key: "k1",
          source: "s",
          metadata: {},
          files: [{ bytes: new TextEncoder().encode("v2-changed"), filename: "a.txt", contentType: "text/plain" }],
        })
      ).rejects.toThrow(/入力が変更されているため保全停止/);
      expect(calls.filter((c) => new URL(c.url).pathname === "/v1/pages")).toHaveLength(0);
      expect(calls.filter((c) => new URL(c.url).pathname.includes("file_uploads"))).toHaveLength(0);
    });

    it("旧行 (manifest 無し) は既存 skip を維持し、一致 UNKNOWN を明示する", async () => {
      routeNewDb("db-1");
      route("POST", "/v1/databases/db-1/query", [
        { results: [{ id: "old-page", properties: { Metadata: { rich_text: [{ plain_text: "{}" }] } } }] },
      ]);
      const { recordPrimaryData } = await load();
      const result = await recordPrimaryData({
        service: "moneyflow",
        key: "k-old",
        source: "s",
        metadata: {},
        files: [{ bytes: new TextEncoder().encode("v1"), filename: "a.txt", contentType: "text/plain" }],
      });
      expect(result).toEqual({ pageId: "old-page", outcome: "skipped_existing", fileTooLarge: false, manifestMatch: "unknown" });
    });

    it("壊れた manifest は UNKNOWN へ黙殺せず STOP する", async () => {
      routeNewDb("db-1");
      route("POST", "/v1/databases/db-1/query", [
        {
          results: [
            {
              id: "bad-page",
              properties: {
                Metadata: { rich_text: [{ plain_text: JSON.stringify({ _fileManifest: { version: 99 } }) }] },
              },
            },
          ],
        },
      ]);
      const { recordPrimaryData } = await load();
      await expect(
        recordPrimaryData({ service: "moneyflow", key: "k-bad", source: "s", metadata: {} })
      ).rejects.toThrow(/manifest が壊れているため保全停止/);
    });

    it("正規化 (.jsonl→.txt) は manifest に原本と upload の両方を残す", async () => {
      routeNewDb("db-1");
      route("POST", "/v1/databases/db-1/query", [{ results: [] }]);
      routeUploadOk("upload-1");
      route("POST", "/v1/pages", [{ id: "page-1" }]);
      const { recordPrimaryData } = await load();
      const result = await recordPrimaryData({
        service: "moneyflow",
        key: "k1",
        source: "s",
        metadata: {},
        files: [{ bytes: new TextEncoder().encode("{}"), filename: "data.jsonl", contentType: "application/x-ndjson" }],
      });
      expect(result.outcome).toBe("recorded");
      const manifest = manifestOfLastPage();
      expect(manifest.files[0]?.originalFilename).toBe("data.jsonl");
      expect(manifest.files[0]?.uploadFilename).toBe("data.jsonl.txt");
      expect(manifest.files[0]?.originalMime).toBe("application/x-ndjson");
      expect(manifest.files[0]?.uploadMime).toBe("text/plain");
      expect(manifest.files[0]?.upload).toBe("uploaded");
      const createFu = JSON.parse(
        String(calls.find((c) => new URL(c.url).pathname === "/v1/file_uploads")?.init.body)
      ) as { filename: string; content_type: string };
      expect(createFu.filename).toBe("data.jsonl.txt");
      expect(createFu.content_type).toBe("text/plain");
    });

    it("上限超過は manifest に too_large を残し、既存 Status/fileTooLarge 境界を維持する", async () => {
      routeNewDb("db-1");
      route("POST", "/v1/databases/db-1/query", [{ results: [] }]);
      routeUploadOk("upload-unused", 5);
      route("POST", "/v1/pages", [{ id: "page-1" }]);
      const { recordPrimaryData } = await load();
      const result = await recordPrimaryData({
        service: "moneyflow",
        key: "k1",
        source: "s",
        metadata: {},
        files: [{ bytes: new TextEncoder().encode("0123456789"), filename: "big.txt", contentType: "text/plain" }],
      });
      expect(result).toEqual({ pageId: "page-1", outcome: "recorded", fileTooLarge: true, manifestMatch: "written" });
      const manifest = manifestOfLastPage();
      expect(manifest.files[0]?.upload).toBe("too_large");
      expect(manifest.files[0]?.byteLength).toBe(10);
      expect(lastPageBody().properties.Status.select.name).toBe("file_too_large");
      expect(calls.filter((c) => new URL(c.url).pathname === "/v1/file_uploads")).toHaveLength(0);
    });

    it("0 ファイルは空 manifest + 安定 fingerprint で記録する (物理成功と称さない)", async () => {
      routeNewDb("db-1");
      route("POST", "/v1/databases/db-1/query", [{ results: [] }]);
      route("POST", "/v1/pages", [{ id: "page-1" }]);
      const { recordPrimaryData } = await load();
      const result = await recordPrimaryData({ service: "moneyflow", key: "k1", source: "s", metadata: {} });
      expect(result).toEqual({ pageId: "page-1", outcome: "recorded", fileTooLarge: false, manifestMatch: "written" });
      const manifest = manifestOfLastPage();
      expect(manifest.files).toEqual([]);
      expect(manifest.inputFingerprint).toBe(await sha256Hex("[]"));
    });

    it("upload の恒久失敗は成功にせず throw し、ページを作らない", async () => {
      routeNewDb("db-1");
      route("POST", "/v1/databases/db-1/query", [{ results: [] }]);
      route("GET", "/v1/users/me", [{ bot: { workspace_limits: { max_file_upload_size_in_bytes: 5242880 } } }]);
      route("POST", "/v1/file_uploads", [
        new Response(JSON.stringify({ object: "error", code: "validation_error", message: "bad" }), { status: 400 }),
      ]);
      const { recordPrimaryData } = await load();
      await expect(
        recordPrimaryData({
          service: "moneyflow",
          key: "k1",
          source: "s",
          metadata: {},
          files: [{ bytes: new TextEncoder().encode("x"), filename: "a.txt", contentType: "text/plain" }],
        })
      ).rejects.toThrow();
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
    beforeEach(() => {
      // 再開までの多数API呼出を検証する。本番の380ms pacing実装は変更しない。
      // 送信開始の時刻だけ進め、5秒のテスト期限を延長せずsleep待ちを除く。
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => (now += 1000));
    });
    const ORIGIN_ID = "11111111-1111-1111-1111-111111111111";
    const TRASH_ID = "22222222-2222-2222-2222-222222222222";
    const OTHER_TRASH_ID = "33333333-3333-3333-3333-333333333333";
    const originPageProps = {
      id: ORIGIN_ID,
      url: `https://notion.so/${ORIGIN_ID.replace(/-/g, "")}`,
      archived: false,
      properties: {
        Key: { title: [{ plain_text: "k1" }] },
        Service: { select: { name: "moneyflow" } },
        Source: { rich_text: [{ plain_text: "s" }] },
        Metadata: { rich_text: [{ plain_text: "{}" }] },
        Files: { files: [] },
      },
    };
    const trashPageProps = {
      id: TRASH_ID,
      url: `https://notion.so/${TRASH_ID.replace(/-/g, "")}`,
      archived: false,
      properties: {
        ...originPageProps.properties,
        Service: { select: { name: "moneyflow" } },
        "Origin Page": { url: originPageProps.url },
        Status: { select: { name: "obsoleted" } },
      },
    };

    it("parentPageId 省略時は既定ページ配下の「ごみ｜<service>」へ退避する", async () => {
      route("GET", `/v1/pages/${ORIGIN_ID}`, [originPageProps, { ...originPageProps, archived: true }]);
      route("POST", "/v1/search", [emptySearch()]);
      route("GET", `/v1/blocks/${ARCHIVE_PAGE}/children`, [emptyChildren()]);
      route("POST", "/v1/databases", [{ id: "trash-default" }]);
      route("POST", "/v1/databases/trash-default/query", [{ results: [] }]);
      route("POST", "/v1/pages", [{ id: TRASH_ID }]);
      route("GET", `/v1/pages/${TRASH_ID}`, [trashPageProps]);
      route("PATCH", `/v1/pages/${ORIGIN_ID}`, [{ id: ORIGIN_ID }]);

      const { moveToTrash } = await load();
      const result = await moveToTrash({
        service: "moneyflow",
        originPageId: ORIGIN_ID,
        reason: "テスト",
      });

      expect(result).toEqual({ trashPageId: TRASH_ID });
      const createBody = JSON.parse(
        String(calls.find((c) => new URL(c.url).pathname === "/v1/databases")?.init.body)
      ) as { parent: { page_id: string }; title: Array<{ text: { content: string } }> };
      expect(createBody.parent.page_id).toBe(ARCHIVE_PAGE);
      expect(createBody.title[0]?.text.content).toBe("ごみ｜moneyflow");
    });

    it("parentPageId 指定時はそのページ配下の「ごみ｜<service>」へ退避する", async () => {
      route("GET", `/v1/pages/${ORIGIN_ID}`, [originPageProps, { ...originPageProps, archived: true }]);
      route("POST", "/v1/search", [emptySearch()]);
      route("GET", `/v1/blocks/${OTHER_PAGE}/children`, [emptyChildren()]);
      route("POST", "/v1/databases", [{ id: "trash-custom" }]);
      route("POST", "/v1/databases/trash-custom/query", [{ results: [] }]);
      route("POST", "/v1/pages", [{ id: OTHER_TRASH_ID }]);
      route("GET", `/v1/pages/${OTHER_TRASH_ID}`, [{ ...trashPageProps, id: OTHER_TRASH_ID }]);
      route("PATCH", `/v1/pages/${ORIGIN_ID}`, [{ id: ORIGIN_ID }]);

      const { moveToTrash } = await load();
      const result = await moveToTrash({
        service: "moneyflow",
        originPageId: ORIGIN_ID,
        reason: "テスト",
        parentPageId: OTHER_PAGE,
      });

      expect(result).toEqual({ trashPageId: OTHER_TRASH_ID });
      const createBody = JSON.parse(
        String(calls.find((c) => new URL(c.url).pathname === "/v1/databases")?.init.body)
      ) as { parent: { page_id: string } };
      expect(createBody.parent.page_id).toBe(OTHER_PAGE);
    });

    it("退避POST成功→元PATCH失敗は既存実体を再利用して元のtrashだけ完了する", async () => {
      const files = [{ name: "snapshot.json", type: "file", file: { url: "https://files.example.test/original.json" } }];
      const origin = { ...originPageProps, properties: { ...originPageProps.properties, Files: { files } } };
      const trash = { ...trashPageProps, properties: { ...trashPageProps.properties, Files: { files: [
        { ...files[0], file: { url: "https://files.example.test/copied.json" } },
      ] } } };
      route("GET", `/v1/pages/${ORIGIN_ID}`, [origin, origin, { ...origin, archived: true }]);
      route("POST", "/v1/search", [emptySearch()]);
      route("GET", `/v1/blocks/${ARCHIVE_PAGE}/children`, [emptyChildren()]);
      route("POST", "/v1/databases", [{ id: "trash-default" }]);
      route("POST", "/v1/databases/trash-default/query", [
        { results: [] }, { results: [{ id: TRASH_ID }] },
      ]);
      route("GET", "/original.json", [new Response('{"snapshot":true}', { headers: { "content-type": "application/json" } }), new Response('{"snapshot":true}')]);
      route("GET", "/copied.json", [new Response('{"snapshot":true}'), new Response('{"snapshot":true}')]);
      route("GET", "/v1/users/me", [{ bot: { workspace_limits: { max_file_upload_size_in_bytes: 5242880 } } }]);
      route("POST", "/v1/file_uploads", [{ id: "upload-1", status: "pending" }]);
      route("POST", "/v1/file_uploads/upload-1/send", [{}]);
      route("GET", "/v1/file_uploads/upload-1", [{ id: "upload-1", status: "uploaded" }]);
      route("POST", "/v1/pages", [{ id: TRASH_ID }]);
      route("GET", `/v1/pages/${TRASH_ID}`, [trash, trash]);
      route("PATCH", `/v1/pages/${ORIGIN_ID}`, [
        new Response(JSON.stringify({ object: "error", code: "validation_error", message: "controlled PATCH failure" }), { status: 400 }),
        { id: ORIGIN_ID, archived: true },
      ]);
      const { moveToTrash } = await load();
      const args = { service: "moneyflow", originPageId: ORIGIN_ID, reason: "テスト" };
      await expect(moveToTrash(args)).rejects.toThrow(/status=400/);
      const resumeStart = calls.length;
      expect(await moveToTrash(args)).toEqual({ trashPageId: TRASH_ID });
      const resumed = calls.slice(resumeStart);
      expect(resumed.filter((c) => c.init.method === "POST" && new URL(c.url).pathname === "/v1/pages")).toHaveLength(0);
      expect(resumed.filter((c) => new URL(c.url).pathname.includes("file_uploads"))).toHaveLength(0);
      expect(resumed.filter((c) => new URL(c.url).hostname === "files.example.test").map((c) => new URL(c.url).pathname)).toEqual(["/original.json", "/copied.json"]);
      expect(calls.filter((c) => c.init.method === "POST" && new URL(c.url).pathname === "/v1/pages")).toHaveLength(1);
      expect(calls.filter((c) => c.init.method === "POST" && new URL(c.url).pathname === "/v1/file_uploads")).toHaveLength(1);
      const patches = calls.filter((c) => c.init.method === "PATCH");
      expect(patches).toHaveLength(2);
      expect(JSON.parse(String(patches[1].init.body))).toEqual({ archived: true });
      expect((patches[1].init.headers as Record<string, string>)["Notion-Version"]).toBe("2022-06-28");
      expect(resumed.at(-1)?.init.method).toBe("GET");
      expect(new URL(resumed.at(-1)!.url).pathname).toBe(`/v1/pages/${ORIGIN_ID}`);
    });

    it("既存退避の実bytesが違えば元PATCH前に停止し、元原本を保持する", async () => {
      const files = [{ name: "snapshot.json", type: "file", file: { url: "https://files.example.test/original.json" } }];
      const origin = { ...originPageProps, properties: { ...originPageProps.properties, Files: { files } } };
      route("GET", `/v1/pages/${ORIGIN_ID}`, [origin, { ...origin, archived: true }]);
      route("POST", "/v1/search", [emptySearch()]);
      route("GET", `/v1/blocks/${ARCHIVE_PAGE}/children`, [emptyChildren()]);
      route("POST", "/v1/databases", [{ id: "trash-default" }]);
      route("POST", "/v1/databases/trash-default/query", [{ results: [{ id: TRASH_ID }] }]);
      route("GET", `/v1/pages/${TRASH_ID}`, [{ ...trashPageProps, properties: { ...trashPageProps.properties, Files: { files: [
        { ...files[0], file: { url: "https://files.example.test/copied.json" } },
      ] } } }]);
      route("GET", "/original.json", [new Response('{"snapshot":true}')]);
      route("GET", "/copied.json", [new Response('{"snapshot":false}')]);
      route("PATCH", `/v1/pages/${ORIGIN_ID}`, [{ id: ORIGIN_ID, archived: true }]);
      const { moveToTrash } = await load();
      await expect(moveToTrash({ service: "moneyflow", originPageId: ORIGIN_ID, reason: "再開" })).rejects.toThrow(/SHA/);
      expect(calls.filter((c) => c.init.method === "PATCH" || new URL(c.url).pathname === "/v1/pages" || new URL(c.url).pathname.includes("file_uploads"))).toHaveLength(0);
    });

    it("元が既にtrashなら既存退避をfresh確認し、POST・upload・PATCHを行わない", async () => {
      const files = [{ name: "snapshot.json", type: "file", file: { url: "https://files.example.test/original.json" } }];
      route("GET", `/v1/pages/${ORIGIN_ID}`, [{ ...originPageProps, in_trash: true, properties: { ...originPageProps.properties, Files: { files } } }]);
      route("POST", "/v1/search", [emptySearch()]);
      route("GET", `/v1/blocks/${ARCHIVE_PAGE}/children`, [emptyChildren()]);
      route("POST", "/v1/databases", [{ id: "trash-default" }]);
      route("POST", "/v1/databases/trash-default/query", [{ results: [{ id: TRASH_ID }] }]);
      route("GET", `/v1/pages/${TRASH_ID}`, [{ ...trashPageProps, properties: { ...trashPageProps.properties, Files: { files } } }]);
      const { moveToTrash } = await load();
      expect(await moveToTrash({ service: "moneyflow", originPageId: ORIGIN_ID, reason: "再開" })).toEqual({ trashPageId: TRASH_ID });
      expect(calls.filter((c) => c.init.method === "PATCH" || new URL(c.url).pathname === "/v1/pages" || new URL(c.url).pathname.includes("file_uploads") || new URL(c.url).hostname === "files.example.test")).toHaveLength(0);
    });

    it.each(["Origin Page", "Service", "Files", "Metadata", "duplicate", "missing", "missingService", "wrongOriginId", "missingState", "invalidState", "missingFiles"])(
      "%sが不一致・欠損なら新規退避や元trashを行わず保全停止する",
      async (kind) => {
        const { archived: _archived, ...withoutState } = originPageProps;
        const { Service: _service, ...withoutService } = originPageProps.properties;
        const { Files: _files, ...withoutFiles } = originPageProps.properties;
        const origin = {
          ...(kind === "missingState" ? withoutState : originPageProps),
          ...(kind === "missing" ? { archived: true } : {}),
          ...(kind === "invalidState" ? { archived: "false" } : {}),
          ...(kind === "wrongOriginId" ? { id: OTHER_TRASH_ID } : {}),
          properties: kind === "missingService" ? withoutService : kind === "missingFiles" ? withoutFiles : originPageProps.properties,
        };
        route("GET", `/v1/pages/${ORIGIN_ID}`, [origin, { ...origin, archived: true }]);
        if (kind === "missingFiles") route("PATCH", `/v1/pages/${ORIGIN_ID}`, [{ id: ORIGIN_ID, archived: true }]);
        route("POST", "/v1/search", [emptySearch()]);
        route("GET", `/v1/blocks/${ARCHIVE_PAGE}/children`, [emptyChildren()]);
        route("POST", "/v1/databases", [{ id: "trash-default" }]);
        route("POST", "/v1/databases/trash-default/query", [{ results: kind === "missing" ? [] : kind === "duplicate" ? [{ id: TRASH_ID }, { id: OTHER_TRASH_ID }] : [{ id: TRASH_ID }] }]);
        route("GET", `/v1/pages/${TRASH_ID}`, [{
          ...trashPageProps,
          properties: {
            ...trashPageProps.properties,
            ...(kind === "Origin Page" ? { "Origin Page": { url: `https://notion.so/${OTHER_PAGE}` } } : {}),
            ...(kind === "Service" ? { Service: { select: { name: "other-service" } } } : {}),
            ...(kind === "Files" ? { Files: { files: [{ name: "unowned.json", type: "file", file: { url: "https://files.example.test/unowned.json" } }] } } : {}),
            ...(kind === "Metadata" ? { Metadata: { rich_text: [{ plain_text: '{"changed":true}' }] } } : {}),
          },
        }]);
        const { moveToTrash } = await load();
        await expect(moveToTrash({ service: "moneyflow", originPageId: ORIGIN_ID, reason: "再開" })).rejects.toThrow(/保全|重複/);
        expect(calls.filter((c) => c.init.method === "PATCH" || new URL(c.url).pathname === "/v1/pages" || new URL(c.url).pathname.includes("file_uploads"))).toHaveLength(0);
        if (kind === "missingFiles") expect(calls.filter((c) => c.init.method === "POST")).toHaveLength(0);
      }
    );
  });

  describe("queryUniqueRow", () => {
    const DB = "db-unique";
    const FILTER = { property: "Key", title: { equals: "k1" } };
    const CTX = "moneyflow 観測ログの重複 key=k1 を選ばず保全停止";

    it("0件なら null を返す", async () => {
      route("POST", `/v1/databases/${DB}/query`, [{ results: [] }]);
      const { queryUniqueRow } = await load();
      await expect(queryUniqueRow(DB, FILTER, CTX)).resolves.toBeNull();
      // 重複検出のため 2 件で問い合わせる (page_size: 1 + 先頭選択は禁止)。
      const body = JSON.parse(String(calls[0]!.init.body));
      expect(body.page_size).toBe(2);
      expect(body.filter).toEqual(FILTER);
    });

    it("1件ならその行を返す", async () => {
      route("POST", `/v1/databases/${DB}/query`, [{ results: [{ id: "row-1" }] }]);
      const { queryUniqueRow } = await load();
      await expect(queryUniqueRow(DB, FILTER, CTX)).resolves.toEqual({ id: "row-1" });
    });

    it("2件ならどれも選ばず throw する", async () => {
      route("POST", `/v1/databases/${DB}/query`, [{ results: [{ id: "row-1" }, { id: "row-2" }] }]);
      const { queryUniqueRow } = await load();
      const err = (await queryUniqueRow(DB, FILTER, CTX).catch((e: Error) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/moneyflow 観測ログの重複 key=k1 を選ばず保全停止/);
      // private な databaseId は通常ログに出さない (公開 key・context のみ)。
      expect(err.message).not.toContain(DB);
    });

    it("has_more なら 1件表示でも throw する (3件目以降の見落とし防止)", async () => {
      route("POST", `/v1/databases/${DB}/query`, [
        { results: [{ id: "row-1" }], has_more: true, next_cursor: "c" },
      ]);
      const { queryUniqueRow } = await load();
      const err = (await queryUniqueRow(DB, FILTER, CTX).catch((e: Error) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/保全停止/);
      expect(err.message).not.toContain(DB);
    });
  });

  describe("createDatabaseOrAdopt", () => {
    const BODY = { parent: { type: "page_id", page_id: "parent-1" }, title: [], properties: {} };

    it("作成成功ならそのまま返す (refind しない)", async () => {
      route("POST", "/v1/databases", [{ id: "db-new" }]);
      const refind = vi.fn(async () => "db-other");
      const { createDatabaseOrAdopt } = await load();
      await expect(createDatabaseOrAdopt(BODY, refind)).resolves.toEqual({
        id: "db-new",
        created: true,
        response: { id: "db-new" },
      });
      expect(refind).not.toHaveBeenCalled();
    });

    it("結果不明で refind が見つかれば回収する (再 create しない)", async () => {
      // POST /databases の route を登録しない = fetch が throw (network 不明を模擬)。
      const refind = vi.fn(async () => "db-found");
      const { createDatabaseOrAdopt } = await load();
      await expect(createDatabaseOrAdopt(BODY, refind)).resolves.toEqual({
        id: "db-found",
        created: false,
      });
      expect(refind).toHaveBeenCalledTimes(1);
      // POST /databases は 1 回きり (内部再送なし)。
      expect(calls.filter((c) => new URL(c.url).pathname === "/v1/databases")).toHaveLength(1);
    });

    it("結果不明で refind も空なら元のエラーを投げる (自動再 create しない)", async () => {
      const refind = vi.fn(async () => null);
      const { createDatabaseOrAdopt } = await load();
      await expect(createDatabaseOrAdopt(BODY, refind)).rejects.toThrow(/結果不明のため再送しません/);
      expect(refind).toHaveBeenCalledTimes(1);
      expect(calls.filter((c) => new URL(c.url).pathname === "/v1/databases")).toHaveLength(1);
    });

    it("結果不明で refind が複数検出なら保全停止を伝え POST は 1 回きり", async () => {
      const refind = vi.fn(async () => {
        throw new Error("Notion DB作成の結果不明回収: 同名が2件あり特定できず保全停止 title=一次データ｜x");
      });
      const { createDatabaseOrAdopt } = await load();
      const err = (await createDatabaseOrAdopt(BODY, refind).catch((e: Error) => e)) as Error;
      expect(err.message).toMatch(/同名が2件あり特定できず保全停止/);
      expect(refind).toHaveBeenCalledTimes(1);
      expect(calls.filter((c) => new URL(c.url).pathname === "/v1/databases")).toHaveLength(1);
    });
  });

  describe("findUniqueBackupChildByTitle (回収専用 0/1/複数)", () => {
    const TITLE = "一次データ｜moneyflow";
    const dbHit = (id: string, created: string) => ({
      id,
      created_time: created,
      parent: { type: "page_id", page_id: ARCHIVE_PAGE },
      title: [{ plain_text: TITLE }],
    });

    it("1件なら回収する (保険走査しない)", async () => {
      route("POST", "/v1/search", [
        { results: [dbHit("db-1", "2026-09-28T00:00:00.000Z")], has_more: false, next_cursor: null },
      ]);
      const { findUniqueBackupChildByTitle } = await load();
      const got = await findUniqueBackupChildByTitle({
        parentPageId: ARCHIVE_PAGE,
        title: TITLE,
        kind: "database",
      });
      expect(got).toBe("db-1");
      expect(calls.filter((c) => c.init.method === "GET")).toHaveLength(0);
    });

    it("複数なら最古を選ばず保全停止する (通常探索の最古収束と分離)", async () => {
      route("POST", "/v1/search", [
        {
          results: [
            dbHit("db-new", "2026-09-28T00:00:00.000Z"),
            dbHit("db-old", "2026-09-27T00:00:00.000Z"),
          ],
          has_more: false,
          next_cursor: null,
        },
      ]);
      const { findUniqueBackupChildByTitle } = await load();
      const err = (await findUniqueBackupChildByTitle({
        parentPageId: ARCHIVE_PAGE,
        title: TITLE,
        kind: "database",
      }).catch((e: Error) => e)) as Error;
      expect(err.message).toMatch(/同名が2件あり特定できず保全停止/);
      expect(err.message).toContain(TITLE);
      expect(err.message).not.toContain("db-old");
      expect(err.message).not.toContain("db-new");
    });

    it("0件なら null を返し保険走査しない (bounded 先頭採用に戻らない)", async () => {
      route("POST", "/v1/search", [emptySearch()]);
      const { findUniqueBackupChildByTitle } = await load();
      const got = await findUniqueBackupChildByTitle({
        parentPageId: ARCHIVE_PAGE,
        title: TITLE,
        kind: "database",
      });
      expect(got).toBeNull();
      // Search のみ。children 保険走査はしない (呼出側が元の結果不明で停止し、
      // 次回の通常探索で収束する)。
      expect(calls.filter((c) => c.init.method === "GET")).toHaveLength(0);
    });
  });

  describe("findUniqueChildDatabaseForAdopt (子DB回収 0/1/複数)", () => {
    const TITLE = "適時開示｜7203";
    const STOCK = "s".repeat(32);
    const childDb = (id: string) => ({ id, type: "child_database", child_database: { title: TITLE } });

    it("1件なら回収する", async () => {
      route("GET", `/v1/blocks/${STOCK}/children`, [
        { results: [childDb("cdb-1")], has_more: false, next_cursor: null },
      ]);
      const { findUniqueChildDatabaseForAdopt } = await load();
      await expect(findUniqueChildDatabaseForAdopt(STOCK, TITLE)).resolves.toBe("cdb-1");
    });

    it("複数 (次ページ含む全走査) なら保全停止する", async () => {
      route("GET", `/v1/blocks/${STOCK}/children`, [
        { results: [childDb("cdb-1")], has_more: true, next_cursor: "cur1" },
        { results: [childDb("cdb-2")], has_more: false, next_cursor: null },
      ]);
      const { findUniqueChildDatabaseForAdopt } = await load();
      const err = (await findUniqueChildDatabaseForAdopt(STOCK, TITLE).catch((e: Error) => e)) as Error;
      expect(err.message).toMatch(/同名が2件あり特定できず保全停止/);
      expect(err.message).not.toContain("cdb-1");
    });

    it("0件なら null", async () => {
      route("GET", `/v1/blocks/${STOCK}/children`, [emptyChildren()]);
      const { findUniqueChildDatabaseForAdopt } = await load();
      await expect(findUniqueChildDatabaseForAdopt(STOCK, TITLE)).resolves.toBeNull();
    });
  });

  describe("assertAdoptedDatabaseSchema (回収前の型検証)", () => {
    const WANT = { Key: { title: {} }, Status: { select: {} } };

    it("必須列が揃い型一致なら何もしない", async () => {
      const { assertAdoptedDatabaseSchema } = await load();
      expect(() =>
        assertAdoptedDatabaseSchema(
          { Key: { type: "title" }, Status: { type: "select" } },
          WANT,
          "回収テスト"
        )
      ).not.toThrow();
    });

    it("型違いは保全停止する (置換しない)", async () => {
      const { assertAdoptedDatabaseSchema } = await load();
      expect(() =>
        assertAdoptedDatabaseSchema(
          { Key: { type: "rich_text" }, Status: { type: "select" } },
          WANT,
          "回収テスト"
        )
      ).toThrow(/列「Key」の型が rich_text ですが title を期待.*置換せず保全停止/);
    });

    it("必須列の不足も保全停止する", async () => {
      const { assertAdoptedDatabaseSchema } = await load();
      expect(() =>
        assertAdoptedDatabaseSchema({ Key: { type: "title" } }, WANT, "回収テスト")
      ).toThrow(/必須列「Status」が無いため保全停止/);
    });
  });

  describe("ensureDatabase の回収 schema 検証 (cache 前)", () => {
    beforeEach(() => {
      // 10 要求前後の pacing を無効化 (moveToTrash と同じ方式)。
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => (now += 1000));
    });
    const TITLE = "一次データ｜moneyflow";
    const ADOPTED = "adopted-db-id";
    const dbHit = (id: string) => ({
      id,
      created_time: "2026-09-28T00:00:00.000Z",
      parent: { type: "page_id", page_id: ARCHIVE_PAGE },
      title: [{ plain_text: TITLE }],
    });
    const goodSchema = () => ({
      id: ADOPTED,
      properties: {
        Key: { type: "title" },
        Service: { type: "select" },
        Source: { type: "rich_text" },
        "Fetched At": { type: "date" },
        Status: { type: "select" },
        Metadata: { type: "rich_text" },
        Files: { type: "files" },
        "Obsoleted At": { type: "date" },
        "Obsoleted Reason": { type: "rich_text" },
        "Origin Page": { type: "url" },
      },
    });
    const recordInput = { service: "moneyflow", key: "k1", source: "s", metadata: {} };

    it("回収DBの型違いは記録せず保全停止し cache しない (次回は再探索)", async () => {
      route("POST", "/v1/search", [
        emptySearch(),
        { results: [dbHit(ADOPTED)], has_more: false, next_cursor: null },
        emptySearch(),
      ]);
      route("GET", `/v1/blocks/${ARCHIVE_PAGE}/children`, [emptyChildren(), emptyChildren()]);
      route("POST", "/v1/databases", [
        new Response("overload", { status: 500 }),
        { id: "db-new" },
      ]);
      route("GET", `/v1/databases/${ADOPTED}`, [
        { ...goodSchema(), properties: { ...goodSchema().properties, Key: { type: "rich_text" } } },
      ]);
      route("POST", "/v1/databases/db-new/query", [{ results: [] }]);
      route("POST", "/v1/pages", [{ id: "page-ok" }]);

      const { recordPrimaryData } = await load();
      const err = (await recordPrimaryData(recordInput).catch((e: Error) => e)) as Error;
      expect(err.message).toMatch(/列「Key」の型が rich_text ですが title を期待/);
      expect(err.message).not.toContain(ADOPTED);
      expect(calls.filter((c) => new URL(c.url).pathname === "/v1/pages")).toHaveLength(0);

      // cache していない → 2 回目は Search から再探索し正常に記録できる。
      const ok = await recordPrimaryData(recordInput);
      expect(ok).toEqual({ pageId: "page-ok", outcome: "recorded", fileTooLarge: false, manifestMatch: "written" });
      expect(calls.filter((c) => new URL(c.url).pathname === "/v1/search")).toHaveLength(3);
    });

    it("回収DBの型一致なら記録できる (正当な回収を壊さない)", async () => {
      route("POST", "/v1/search", [
        emptySearch(),
        { results: [dbHit(ADOPTED)], has_more: false, next_cursor: null },
      ]);
      route("GET", `/v1/blocks/${ARCHIVE_PAGE}/children`, [emptyChildren()]);
      route("POST", "/v1/databases", [new Response("overload", { status: 500 })]);
      route("GET", `/v1/databases/${ADOPTED}`, [goodSchema()]);
      route("POST", `/v1/databases/${ADOPTED}/query`, [{ results: [] }]);
      route("POST", "/v1/pages", [{ id: "page-adopted" }]);

      const { recordPrimaryData } = await load();
      const ok = await recordPrimaryData(recordInput);
      expect(ok).toEqual({ pageId: "page-adopted", outcome: "recorded", fileTooLarge: false, manifestMatch: "written" });
      expect(calls.filter((c) => new URL(c.url).pathname === "/v1/databases")).toHaveLength(1);
    });
  });

  describe("findBackupRowsByKeys (完成判定用 OR 照会)", () => {
    const dbHit = (id: string) => ({
      id,
      created_time: "2026-09-28T00:00:00.000Z",
      parent: { type: "page_id", page_id: ARCHIVE_PAGE },
      title: [{ plain_text: "一次データ｜moneyflow" }],
    });
    const rowPage = (key: string, files: unknown[]) => ({
      properties: {
        Key: { title: [{ plain_text: key }] },
        Files: { files },
        Status: { select: { name: "recorded" } },
        Metadata: { rich_text: [{ plain_text: "{}" }] },
      },
    });

    it("has_more 真は次照会せず保全停止する (cursor 追跡しない)", async () => {
      route("POST", "/v1/search", [
        { results: [dbHit("db-x")], has_more: false, next_cursor: null },
      ]);
      route("POST", "/v1/databases/db-x/query", [
        { results: [], has_more: true, next_cursor: null },
      ]);
      const { findBackupRowsByKeys } = await load();
      await expect(findBackupRowsByKeys("moneyflow", ["k1"])).rejects.toThrow(
        "保全停止"
      );
      expect(
        calls.filter(
          (c) => new URL(c.url).pathname === "/v1/databases/db-x/query"
        )
      ).toHaveLength(1);
    });

    it("外部参照は数えず実ホスト添付だけ fileCount にする", async () => {
      route("POST", "/v1/search", [
        { results: [dbHit("db-x")], has_more: false, next_cursor: null },
      ]);
      route("POST", "/v1/databases/db-x/query", [
        {
          results: [
            rowPage("k-ext", [
              { type: "external", name: "x", external: { url: "https://example.test/x" } },
            ]),
            rowPage("k-host", [
              {
                type: "file",
                name: "k-host.zip",
                file: { url: "https://example.test/signed", expiry_time: "2026-09-28T01:00:00.000Z" },
              },
            ]),
          ],
          has_more: false,
          next_cursor: null,
        },
      ]);
      const { findBackupRowsByKeys } = await load();
      const rows = await findBackupRowsByKeys("moneyflow", ["k-ext", "k-host"]);
      expect(rows).toEqual([
        { key: "k-ext", fileCount: 0, status: "recorded", metadata: {} },
        { key: "k-host", fileCount: 1, status: "recorded", metadata: {} },
      ]);
    });
  });
});
