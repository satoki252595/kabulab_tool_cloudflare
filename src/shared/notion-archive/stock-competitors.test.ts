/**
 * 「銘柄マスタ（補足）」への競合他社 relation (自己参照) のテスト。
 * fetch モックの方式は biztag-ledger.test.ts と同じ (route ベース)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

const DB_ID = "d".repeat(32);

describe("notion-archive stock-competitors", () => {
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
  });

  const load = () => import("./stock-competitors.js");

  describe("ensureCompetitorColumns", () => {
    it("列が無ければ自己参照 relation + 3 メタ列を追加する", async () => {
      route("GET", `/v1/databases/${DB_ID}`, [{ id: DB_ID, properties: { 銘柄名: { id: "title", type: "title" } } }]);
      route("PATCH", `/v1/databases/${DB_ID}`, [
        {
          id: DB_ID,
          properties: {
            銘柄名: { id: "title", type: "title" },
            競合他社: { id: "rel", type: "relation" },
            競合判定日: { id: "date", type: "date" },
            競合判定の版: { id: "ver", type: "rich_text" },
            競合判定書類ID: { id: "doc", type: "rich_text" },
          },
        },
      ]);
      const { ensureCompetitorColumns } = await load();
      const ids = await ensureCompetitorColumns(DB_ID);
      expect(ids["競合他社"]).toBe("rel");

      const patchBody = JSON.parse(String(calls[1]?.init.body)) as { properties: Record<string, unknown> };
      expect(Object.keys(patchBody.properties).sort()).toEqual(
        ["競合他社", "競合判定の版", "競合判定日", "競合判定書類ID"].sort()
      );
      const relationDef = patchBody.properties["競合他社"] as { relation: { database_id: string } };
      expect(relationDef.relation.database_id).toBe(DB_ID); // 自己参照
    });

    it("列が既にあれば PATCH しない", async () => {
      route("GET", `/v1/databases/${DB_ID}`, [
        {
          id: DB_ID,
          properties: {
            競合他社: { id: "rel", type: "relation" },
            競合判定日: { id: "date", type: "date" },
            競合判定の版: { id: "ver", type: "rich_text" },
            競合判定書類ID: { id: "doc", type: "rich_text" },
          },
        },
      ]);
      const { ensureCompetitorColumns } = await load();
      const ids = await ensureCompetitorColumns(DB_ID);
      expect(ids["競合他社"]).toBe("rel");
      expect(calls).toHaveLength(1); // GET のみ
    });
  });

  describe("writeCompetitorRelation", () => {
    it("relation とメタ列をまとめてPATCHする", async () => {
      route("PATCH", "/v1/pages/page-a", [{}]);
      const { writeCompetitorRelation } = await load();
      await writeCompetitorRelation("page-a", {
        competitorPageIds: ["page-b", "page-c"],
        judgedAt: "2026-09-26",
        version: "cand-v1|jev-1.13.0",
        judgedDocId: "S100XXXX",
      });
      const body = JSON.parse(String(calls[0]?.init.body)) as { properties: Record<string, unknown> };
      expect(body.properties["競合他社"]).toEqual({ relation: [{ id: "page-b" }, { id: "page-c" }] });
      expect(body.properties["競合判定日"]).toEqual({ date: { start: "2026-09-26" } });
    });

    it("上限を超える件数は throw する", async () => {
      const { writeCompetitorRelation } = await load();
      const many = Array.from({ length: 101 }, (_, i) => `page-${i}`);
      await expect(
        writeCompetitorRelation("page-a", { competitorPageIds: many, judgedAt: "2026-09-26", version: "v", judgedDocId: "d" })
      ).rejects.toThrow(/上限/);
    });
  });

  describe("loadCompetitorMeta", () => {
    it("メタ列を読む", async () => {
      route("POST", `/v1/databases/${DB_ID}/query`, [
        {
          results: [
            {
              id: "page-a",
              properties: {
                銘柄コード: { rich_text: [{ plain_text: "7203" }] },
                競合他社: { relation: [{ id: "page-b" }] },
                競合判定日: { date: { start: "2026-09-26" } },
                競合判定の版: { rich_text: [{ plain_text: "cand-v1|jev-1.13.0" }] },
                競合判定書類ID: { rich_text: [{ plain_text: "S100XXXX" }] },
              },
            },
          ],
          has_more: false,
          next_cursor: null,
        },
      ]);
      const { loadCompetitorMeta } = await load();
      const rows = await loadCompetitorMeta(
        DB_ID,
        { 銘柄コード: "code-id", 競合他社: "rel-id", 競合判定日: "date-id", 競合判定の版: "ver-id", 競合判定書類ID: "doc-id" },
        "銘柄コード"
      );
      expect(rows).toEqual([
        {
          pageId: "page-a",
          stockCode: "7203",
          competitorPageIds: ["page-b"],
          judgedAt: "2026-09-26",
          version: "cand-v1|jev-1.13.0",
          judgedDocId: "S100XXXX",
        },
      ]);
    });
  });
});
