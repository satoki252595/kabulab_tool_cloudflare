/**
 * 「株価の日次同期」Notion 保管のテスト。
 * router+queue+Date.now fast-forward の方式は biztag-ledger.test.ts と同じ。
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

const STOCK_INFO = "e".repeat(32);

describe("notion-archive price-sync-log", () => {
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
    process.env.NOTION_STOCK_INFO_PAGE_ID = STOCK_INFO;
    delete process.env.NOTION_PRICE_SYNC_DB_ID;
    let t = 1_000_000;
    Date.now = (() => (t += 10_000)) as typeof Date.now;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const u = new URL(String(url));
      const key = `${init?.method ?? "GET"} ${u.pathname}`;
      const q = routes.get(key);
      if (!q || q.length === 0) throw new Error(`テスト: 未定義ルートへの fetch: ${key}`);
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

  const load = () => import("./price-sync-log.js");
  const childrenPage = (results: unknown[], has_more = false, next_cursor: string | null = null) => ({
    results,
    has_more,
    next_cursor,
  });

  describe("ensurePriceSyncDb", () => {
    it("固定 DB ID があれば Search せず不足列だけ PATCH する", async () => {
      const dbId = "d".repeat(32);
      process.env.NOTION_PRICE_SYNC_DB_ID = dbId;
      route("GET", `/v1/databases/${dbId}`, [{ id: dbId, properties: { 取引日: { id: "t" } } }]);
      route("PATCH", `/v1/databases/${dbId}`, [{}]);
      const { ensurePriceSyncDb } = await load();
      const result = await ensurePriceSyncDb();
      expect(result.dbId).toBe(dbId);
      expect(calls.filter((c) => new URL(c.url).pathname === "/v1/search")).toHaveLength(0);
      const patchBody = JSON.parse(String(calls[1]?.init.body)) as { properties: Record<string, unknown> };
      expect(Object.keys(patchBody.properties).sort()).toEqual(
        [
          "取引日（日付）",
          "状態",
          "完了日時",
          "対象銘柄数",
          "更新銘柄数",
          "失敗銘柄数",
          "実行URL",
          "失敗理由",
        ].sort()
      );
    });

    it("固定 DB ID が無ければ Search (親一致) → 新規作成する", async () => {
      route("GET", `/v1/blocks/${STOCK_INFO}/children`, [childrenPage([])]);
      route("POST", "/v1/search", [{ results: [], has_more: false, next_cursor: null }]);
      route("POST", "/v1/databases", [{ id: "price-sync-new", properties: {} }]);
      const { ensurePriceSyncDb } = await load();
      const result = await ensurePriceSyncDb();
      expect(result.dbId).toBe("price-sync-new");
      const created = JSON.parse(
        String(calls.find((c) => new URL(c.url).pathname === "/v1/databases")?.init.body)
      ) as { title: Array<{ text: { content: string } }>; parent: { page_id: string } };
      expect(created.title[0]?.text.content).toBe("株価の日次同期");
      expect(created.parent.page_id).toBe(STOCK_INFO);
    });
  });

  describe("recordPriceSyncLog", () => {
    const dbId = "db-price-sync";

    it("取引日が新規なら作成する (完了)", async () => {
      route("POST", `/v1/databases/${dbId}/query`, [{ results: [], has_more: false, next_cursor: null }]);
      route("POST", "/v1/pages", [{ id: "row-1" }]);
      const { recordPriceSyncLog } = await load();
      const result = await recordPriceSyncLog(dbId, {
        tradingDate: "2026-09-25",
        status: "完了",
        completedAt: "2026-09-26T06:10:00.000Z",
        targetStocks: 3700,
        updatedStocks: 3700,
        failedStocks: 0,
        runUrl: "https://github.com/o/r/actions/runs/1",
        reason: null,
      });
      expect(result).toEqual({ pageId: "row-1", outcome: "created" });
      const body = JSON.parse(
        String(calls.find((c) => new URL(c.url).pathname === "/v1/pages" && c.init.method === "POST")?.init.body)
      ) as { properties: Record<string, unknown> };
      expect(body.properties["取引日"]).toEqual({
        title: [{ type: "text", text: { content: "2026-09-25" } }],
      });
      expect(body.properties["取引日（日付）"]).toEqual({ date: { start: "2026-09-25" } });
      expect(body.properties["状態"]).toEqual({ select: { name: "完了" } });
      expect(body.properties["対象銘柄数"]).toEqual({ number: 3700 });
      expect(body.properties["失敗理由"]).toEqual({ rich_text: [] });
    });

    it("同じ取引日の既存行があれば upsert (更新) する", async () => {
      route("POST", `/v1/databases/${dbId}/query`, [{ results: [{ id: "row-existing" }], has_more: false, next_cursor: null }]);
      route("PATCH", "/v1/pages/row-existing", [{ id: "row-existing" }]);
      const { recordPriceSyncLog } = await load();
      const result = await recordPriceSyncLog(dbId, {
        tradingDate: "2026-09-25",
        status: "一部失敗",
        completedAt: "2026-09-26T06:10:00.000Z",
        targetStocks: 3700,
        updatedStocks: 3690,
        failedStocks: 10,
        runUrl: "https://github.com/o/r/actions/runs/2",
        reason: null,
      });
      expect(result).toEqual({ pageId: "row-existing", outcome: "updated" });
    });

    it("取引日が導出できないのに status!=失敗 なら throw する (推測しない・ルール2)", async () => {
      const { recordPriceSyncLog } = await load();
      await expect(
        recordPriceSyncLog(dbId, {
          tradingDate: null,
          status: "完了",
          completedAt: "2026-09-26T06:10:00.000Z",
          targetStocks: 3700,
          updatedStocks: 0,
          failedStocks: 3700,
          runUrl: null,
          reason: "取引日が導出できなかった",
        })
      ).rejects.toThrow(/推測/);
    });

    it("取引日が導出できない失敗行は upsert キーを持たず、実行のたびに新規作成する", async () => {
      route("POST", "/v1/pages", [{ id: "row-fail-1" }]);
      const { recordPriceSyncLog } = await load();
      const result = await recordPriceSyncLog(dbId, {
        tradingDate: null,
        status: "失敗",
        completedAt: "2026-09-26T06:10:00.000Z",
        targetStocks: 3700,
        updatedStocks: 0,
        failedStocks: 3700,
        runUrl: null,
        reason: "swing_daily_ohlcv の MAX(date) が導出できませんでした",
      });
      expect(result).toEqual({ pageId: "row-fail-1", outcome: "created" });
      // クエリ (query) を叩かず即作成 (取引日不明は冪等キーが無いため)
      expect(calls.filter((c) => new URL(c.url).pathname === `/v1/databases/${dbId}/query`)).toHaveLength(0);
      const body = JSON.parse(
        String(calls.find((c) => new URL(c.url).pathname === "/v1/pages")?.init.body)
      ) as { properties: Record<string, unknown> };
      const title = (body.properties["取引日"] as { title: Array<{ text: { content: string } }> }).title[0]
        ?.text.content;
      expect(title).toContain("失敗（取引日不明）");
      expect(body.properties["取引日（日付）"]).toEqual({ date: null });
    });
  });
});
