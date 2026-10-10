/**
 * INC-20261008-kabulab_tool_cloudflare-ir-pdf-502 恒久策 A(a)
 *
 * 銘柄 → Notion 会社ページ（銘柄ページ + 適時開示 DB）を D1 に残し、
 * 実行をまたいで銘柄解決の Notion 検索/取得を省く。未ヒットと、
 * ページが無い/アーカイブ済みの不整合だけ Notion へ戻す。
 * readback・古い順・予算の判定は変えない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notionRequest } from "./client.js";
import { queryUniqueRow } from "./archive.js";
import { uploadFile } from "./file-upload.js";
import { verifyArchivedAttachments } from "./readback.js";

vi.mock("./client.js", async (original) => ({
  ...await original<typeof import("./client.js")>(),
  notionRequest: vi.fn(),
}));
vi.mock("./env.js", async (original) => ({
  ...await original<typeof import("./env.js")>(),
  notionEnv: { NOTION_ARCHIVE_PAGE_ID: () => "a".repeat(32) },
}));
vi.mock("./archive.js", () => ({
  findBackupChildByTitle: vi.fn(async () => "parent"),
  queryUniqueRow: vi.fn(),
}));
vi.mock("./file-upload.js", async (original) => ({
  ...await original<typeof import("./file-upload.js")>(),
  uploadFile: vi.fn(),
}));
vi.mock("./readback.js", () => ({ verifyArchivedAttachments: vi.fn() }));

const SCHEMA_VERSION = 1;
const propertyNames = ["開示表題", "タグ", "代表タグ", "IR発表日", "市場", "資料", "IR資料", "IR資料状態", "PDF判定", "TDnet ID"];
const row = {
  key: "T1",
  ticker: "1001",
  companyName: "試験",
  companyUrl: "https://example.test",
  tags: [] as string[],
  primaryTag: null,
  pubdate: "2026-10-08T06:00:00.000Z",
  title: "試験開示",
  documentUrl: "https://example.test/1.pdf",
  markets: null,
};

interface Ref {
  stockPageId: string;
  childDbId: string;
  schemaVersion: number;
}

function cacheDouble(initial: Ref | undefined) {
  const store = new Map<string, Ref>();
  if (initial) store.set("ir-catalog\t1001", initial);
  return {
    store,
    get: vi.fn(async (service: string, ticker: string) => store.get(`${service}\t${ticker}`)),
    put: vi.fn(async (service: string, ticker: string, ref: Ref) => {
      store.set(`${service}\t${ticker}`, ref);
    }),
    invalidate: vi.fn(async (service: string, ticker: string) => {
      store.delete(`${service}\t${ticker}`);
    }),
  };
}

function resolutionCalls(): { stockQuery: number; blocks: number; databaseGet: number } {
  const calls = vi.mocked(notionRequest).mock.calls;
  return {
    stockQuery: vi.mocked(queryUniqueRow).mock.calls.length,
    blocks: calls.filter(([method, path]) => method === "GET" && String(path).startsWith("/blocks/")).length,
    databaseGet: calls.filter(([method, path]) => method === "GET" && String(path).startsWith("/databases/")).length,
  };
}

function notionCallCount(): number {
  return vi.mocked(notionRequest).mock.calls.length + vi.mocked(queryUniqueRow).mock.calls.length;
}

describe("銘柄ページの D1 キャッシュ", () => {
  let queryError: Error | null;

  beforeEach(() => {
    vi.resetModules();
    queryError = null;
    vi.mocked(queryUniqueRow).mockReset().mockResolvedValue({ id: "stock-live" } as never);
    vi.mocked(uploadFile).mockReset().mockResolvedValue("upload");
    vi.mocked(verifyArchivedAttachments).mockReset().mockResolvedValue(undefined);
    vi.mocked(notionRequest).mockReset().mockImplementation(async (method, path) => {
      const p = String(path);
      if (queryError && method === "POST" && p === "/databases/stale-db/query") throw queryError;
      if (method === "GET" && p.startsWith("/blocks/")) {
        return {
          results: [{ id: "child-live", type: "child_database", child_database: { title: "適時開示｜1001" } }],
          has_more: false,
          next_cursor: null,
        } as never;
      }
      if (method === "GET" && p.startsWith("/databases/")) {
        return { properties: Object.fromEntries(propertyNames.map((name) => [name, {}])), is_inline: true } as never;
      }
      if (p.endsWith("/query")) return { results: [], has_more: false, next_cursor: null } as never;
      if (method === "POST" && p === "/pages") return { id: "written" } as never;
      return { id: "other" } as never;
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("%PDF-test", { headers: { "content-type": "application/pdf" } })));
  });
  afterEach(() => vi.unstubAllGlobals());

  async function run(cache: ReturnType<typeof cacheDouble>, rows = [row]) {
    const { upsertDisclosuresByStock } = await import("./dataset.js");
    return upsertDisclosuresByStock({
      service: "ir-catalog",
      tagOptions: [],
      rows,
      stockPageCache: cache,
    });
  }

  it("キャッシュヒットは銘柄解決の Notion 検索と取得を省き、readback は残す", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const cache = cacheDouble({ stockPageId: "stock-cached", childDbId: "child-cached", schemaVersion: SCHEMA_VERSION });
    try {
      const result = await run(cache);
      expect(result.created).toBe(1);
      const calls = resolutionCalls();
      expect(calls).toEqual({ stockQuery: 0, blocks: 0, databaseGet: 0 });
      const created = vi.mocked(notionRequest).mock.calls.find(([method, path]) => method === "POST" && path === "/pages");
      expect(created?.[2]).toMatchObject({ parent: { database_id: "child-cached" } });
      expect(verifyArchivedAttachments).toHaveBeenCalledTimes(1);
      expect(cache.put).not.toHaveBeenCalled();
      expect(cache.invalidate).not.toHaveBeenCalled();
      const line = info.mock.calls.map((call) => String(call[0])).find((text) => text.includes("notion-calls") && text.includes("tdnetId=T1"));
      expect(line).toContain("outcome=ok");
      expect(line).toContain("requests=");
      expect(line).toContain("stockCache=hit");
    } finally {
      info.mockRestore();
    }
  });

  it("キャッシュヒットの Notion 呼び出しは未ヒットより少ない", async () => {
    const hit = cacheDouble({ stockPageId: "stock-cached", childDbId: "child-cached", schemaVersion: SCHEMA_VERSION });
    await run(hit);
    const hitCount = notionCallCount();

    vi.clearAllMocks();
    vi.resetModules();
    vi.mocked(queryUniqueRow).mockResolvedValue({ id: "stock-live" } as never);
    vi.mocked(uploadFile).mockResolvedValue("upload");
    vi.mocked(verifyArchivedAttachments).mockResolvedValue(undefined);
    const miss = cacheDouble(undefined);
    await run(miss);
    expect(hitCount).toBeLessThan(notionCallCount());
    expect(resolutionCalls().stockQuery).toBe(1);
  });

  it("未ヒットは Notion から解決してキャッシュを書く", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const cache = cacheDouble(undefined);
    try {
      const result = await run(cache);
      expect(result.created).toBe(1);
      expect(resolutionCalls().stockQuery).toBe(1);
      expect(resolutionCalls().blocks).toBeGreaterThan(0);
      expect(cache.put).toHaveBeenCalledWith("ir-catalog", "1001", {
        stockPageId: "stock-live",
        childDbId: "child-live",
        schemaVersion: SCHEMA_VERSION,
      });
      const line = info.mock.calls.map((call) => String(call[0])).join("\n");
      expect(line).toContain("tdnetId=T1");
      expect(line).toContain("outcome=ok");
      expect(line).toContain("stockCache=miss");
    } finally {
      info.mockRestore();
    }
  });

  it("スキーマ版が違う写しは使わず、再解決して更新する", async () => {
    const cache = cacheDouble({ stockPageId: "stock-old", childDbId: "child-old", schemaVersion: SCHEMA_VERSION - 1 });
    await run(cache);
    const queried = vi.mocked(notionRequest).mock.calls.map(([, path]) => String(path));
    expect(queried.some((path) => path.includes("child-old"))).toBe(false);
    expect(cache.put).toHaveBeenCalledWith("ir-catalog", "1001", {
      stockPageId: "stock-live",
      childDbId: "child-live",
      schemaVersion: SCHEMA_VERSION,
    });
  });

  it.each([
    ["404", "Notion API エラー (POST /databases/stale-db/query) status=404 code=object_not_found message=Could not find database"],
    ["archived", "Notion API エラー (POST /databases/stale-db/query) status=400 code=validation_error message=Can't edit block that is archived."],
  ])("%s の不整合はキャッシュを捨て、Notion から引き直して更新する", async (_label, message) => {
    queryError = new Error(message);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const cache = cacheDouble({ stockPageId: "stock-stale", childDbId: "stale-db", schemaVersion: SCHEMA_VERSION });
    try {
      const result = await run(cache);
      expect(result.created).toBe(1);
      expect(cache.invalidate).toHaveBeenCalledWith("ir-catalog", "1001");
      expect(cache.put).toHaveBeenCalledWith("ir-catalog", "1001", {
        stockPageId: "stock-live",
        childDbId: "child-live",
        schemaVersion: SCHEMA_VERSION,
      });
      const created = vi.mocked(notionRequest).mock.calls.find(([method, path]) => method === "POST" && path === "/pages");
      expect(created?.[2]).toMatchObject({ parent: { database_id: "child-live" } });
      expect(verifyArchivedAttachments).toHaveBeenCalledTimes(1);
      const line = info.mock.calls.map((call) => String(call[0])).join("\n");
      expect(line).toContain("outcome=ok");
      expect(line).toContain("stockCache=fallback");
    } finally {
      info.mockRestore();
    }
  });

  it("404 でもアーカイブでもない失敗は握りつぶさず、キャッシュを更新しない", async () => {
    queryError = new Error("Notion API エラー (POST /databases/stale-db/query) status=500 code=? message=internal");
    const cache = cacheDouble({ stockPageId: "stock-stale", childDbId: "stale-db", schemaVersion: SCHEMA_VERSION });
    await expect(run(cache)).rejects.toThrow(/status=500/);
    expect(cache.invalidate).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(verifyArchivedAttachments).not.toHaveBeenCalled();
  });

  it("空の page id は未ヒット扱いにせず停止する", async () => {
    const cache = cacheDouble({ stockPageId: "", childDbId: "child-cached", schemaVersion: SCHEMA_VERSION });
    await expect(run(cache)).rejects.toThrow(/空/);
    expect(queryUniqueRow).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("予算切れの行ではキャッシュも Notion も引かない", async () => {
    const cache = cacheDouble({ stockPageId: "stock-cached", childDbId: "child-cached", schemaVersion: SCHEMA_VERSION });
    const { upsertDisclosuresByStock } = await import("./dataset.js");
    const result = await upsertDisclosuresByStock({
      service: "ir-catalog",
      tagOptions: [],
      deadlineMs: 0,
      rows: [row],
      stockPageCache: cache,
    });
    expect(result.reachedDeadline).toBe(true);
    expect(result.created).toBe(0);
    expect(cache.get).not.toHaveBeenCalled();
    expect(queryUniqueRow).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
