/**
 * moneyflow (「お金の流れ」) の Notion 保管のテスト。
 * fetch のモック方式は price-sync-log.test.ts と同じ (route map + vi.resetModules())。
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
const STOCK_INFO_PAGE = "b".repeat(32);

describe("notion-archive moneyflow", () => {
  const ORIG_ENV = { ...process.env };
  let originalFetch: typeof globalThis.fetch;
  let calls: FetchCalls;
  let routes: Map<string, unknown[]>;

  const route = (method: string, path: string, bodies: unknown[]) => {
    routes.set(`${method} ${path}`, [...bodies]);
  };
  const childrenPage = (results: unknown[] = []) => ({ results, has_more: false, next_cursor: null });
  const searchEmpty = () => ({ results: [], has_more: false, next_cursor: null });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
    routes = new Map();
    process.env.NOTION_TOKEN = "dummy-token";
    process.env.NOTION_ARCHIVE_PAGE_ID = ARCHIVE_PAGE;
    process.env.NOTION_STOCK_INFO_PAGE_ID = STOCK_INFO_PAGE;
    delete process.env.NOTION_MONEYFLOW_DEFS_DB_ID;
    delete process.env.NOTION_MONEYFLOW_OBS_DB_ID;
    delete process.env.NOTION_MONEYFLOW_RUNLOG_DB_ID;
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

  const load = () => import("./moneyflow.js");

  describe("ensureIndicatorDefsDb", () => {
    it("固定 DB ID があれば Search せず不足列だけ PATCH する", async () => {
      const dbId = "d".repeat(32);
      process.env.NOTION_MONEYFLOW_DEFS_DB_ID = dbId;
      route("GET", `/v1/databases/${dbId}`, [{ id: dbId, properties: {} }]);
      route("PATCH", `/v1/databases/${dbId}`, [{}]);
      const { ensureIndicatorDefsDb } = await load();
      const result = await ensureIndicatorDefsDb();
      expect(result.dbId).toBe(dbId);
      expect(calls.filter((c) => new URL(c.url).pathname === "/v1/search")).toHaveLength(0);
      const patchBody = JSON.parse(String(calls[1]?.init.body)) as { properties: Record<string, unknown> };
      expect(Object.keys(patchBody.properties)).toContain("指標キー");
      expect(Object.keys(patchBody.properties)).toContain("何を測るか");
    });

    it("固定 DB ID が無ければ Search (親一致) → 新規作成し、親ページは「株式情報」(NOTION_STOCK_INFO_PAGE_ID)", async () => {
      route("GET", `/v1/blocks/${STOCK_INFO_PAGE}/children`, [childrenPage()]);
      route("POST", "/v1/search", [searchEmpty()]);
      route("POST", "/v1/databases", [{ id: "defs-new" }]);
      const { ensureIndicatorDefsDb } = await load();
      const result = await ensureIndicatorDefsDb();
      expect(result.dbId).toBe("defs-new");
      const created = JSON.parse(
        String(calls.find((c) => new URL(c.url).pathname === "/v1/databases")?.init.body)
      ) as { title: Array<{ text: { content: string } }>; parent: { page_id: string } };
      expect(created.title[0]?.text.content).toBe("資金フロー｜指標定義");
      expect(created.parent.page_id).toBe(STOCK_INFO_PAGE);
    });
  });

  describe("upsertIndicatorDef", () => {
    const dbId = "defs-db";

    it("指標キーが新規なら作成する", async () => {
      route("POST", `/v1/databases/${dbId}/query`, [{ results: [] }]);
      route("POST", "/v1/pages", [{ id: "def-row-1" }]);
      const { upsertIndicatorDef } = await load();
      const result = await upsertIndicatorDef(dbId, {
        key: "sector_turnover",
        displayName: "業種別売買代金",
        requirement: "R1",
        flowType: "売買代金",
        description: "業種ごとの売買代金の合計。買い越し/売り越し(純流入)ではない。",
        sourceUrl: "https://example.test/source",
        license: "personal-only",
        frequency: "週次",
        limitations: "二次市場のため業種全体の純流入はゼロ。",
      });
      expect(result).toEqual({ pageId: "def-row-1", outcome: "created" });
      const body = JSON.parse(
        String(calls.find((c) => new URL(c.url).pathname === "/v1/pages")?.init.body)
      ) as { properties: Record<string, unknown> };
      expect(body.properties["指標キー"]).toEqual({
        title: [{ text: { content: "sector_turnover" } }],
      });
      expect(body.properties["何を測るか"]).toEqual({ select: { name: "売買代金" } });
      expect(body.properties["利用条件"]).toEqual({ select: { name: "personal-only" } });
    });

    it("既存の指標キーがあれば更新する", async () => {
      route("POST", `/v1/databases/${dbId}/query`, [{ results: [{ id: "def-existing" }] }]);
      route("PATCH", "/v1/pages/def-existing", [{ id: "def-existing" }]);
      const { upsertIndicatorDef } = await load();
      const result = await upsertIndicatorDef(dbId, {
        key: "sector_turnover",
        displayName: "業種別売買代金 (改)",
        requirement: "R1",
        flowType: "売買代金",
        description: "説明",
        sourceUrl: "https://example.test/source",
        license: "personal-only",
        frequency: "週次",
        limitations: "限界",
      });
      expect(result).toEqual({ pageId: "def-existing", outcome: "updated" });
    });
  });

  describe("upsertIndicatorDef (同値スキップ)", () => {
    const def = {
      key: "sector_turnover",
      displayName: "業種別売買代金",
      requirement: "R1" as const,
      flowType: "売買代金" as const,
      description: "説明文",
      sourceUrl: "https://example.jp/",
      license: "personal-only" as const,
      frequency: "週次" as const,
      limitations: "限界の文",
    };
    const props = (over: Record<string, unknown> = {}) => ({
      指標キー: { type: "title", title: [{ plain_text: "sector_turnover" }] },
      表示名: { type: "rich_text", rich_text: [{ plain_text: "業種別売買代金" }] },
      要件: { type: "select", select: { name: "R1" } },
      何を測るか: { type: "select", select: { name: "売買代金" } },
      説明: { type: "rich_text", rich_text: [{ plain_text: "説明" }, { plain_text: "文" }] },
      出典URL: { type: "url", url: "https://example.jp/" },
      利用条件: { type: "select", select: { name: "personal-only" } },
      頻度: { type: "select", select: { name: "週次" } },
      限界: { type: "rich_text", rich_text: [{ plain_text: "限界の文" }] },
      ...over,
    });

    it("既存定義と完全一致なら PATCH しない (分割された rich_text も連結して比較)", async () => {
      route("POST", "/v1/databases/defs/query", [{ results: [{ id: "def-1", properties: props() }] }]);
      const { upsertIndicatorDef } = await load();
      expect(await upsertIndicatorDef("defs", def)).toEqual({ pageId: "def-1", outcome: "unchanged" });
      expect(calls.filter((c) => c.init.method === "PATCH")).toHaveLength(0);
    });

    it("説明文が変われば上書きする", async () => {
      route("POST", "/v1/databases/defs/query", [
        { results: [{ id: "def-1", properties: props({ 説明: { type: "rich_text", rich_text: [{ plain_text: "旧" }] } }) }] },
      ]);
      route("PATCH", "/v1/pages/def-1", [{ id: "def-1" }]);
      const { upsertIndicatorDef } = await load();
      expect(await upsertIndicatorDef("defs", def)).toEqual({ pageId: "def-1", outcome: "updated" });
    });
  });

  describe("ensureObservationsDb", () => {
    it("「一次データ｜moneyflow」DB が無ければ throw する (relation 先が無いまま作らない)", async () => {
      const dbId = "d".repeat(32);
      process.env.NOTION_MONEYFLOW_DEFS_DB_ID = dbId;
      route("GET", `/v1/databases/${dbId}`, [{ id: dbId, properties: {} }]);
      route("PATCH", `/v1/databases/${dbId}`, [{}]);
      route("POST", "/v1/search", [searchEmpty()]);
      route("GET", `/v1/blocks/${ARCHIVE_PAGE}/children`, [childrenPage()]);
      const { ensureObservationsDb } = await load();
      await expect(ensureObservationsDb()).rejects.toThrow(/一次データ｜moneyflow/);
    });

    it("指標定義 DB・一次データ DB が揃っていれば作成し、区分は rich_text 列にする", async () => {
      const defsDbId = "d".repeat(32);
      process.env.NOTION_MONEYFLOW_DEFS_DB_ID = defsDbId;
      route("GET", `/v1/databases/${defsDbId}`, [{ id: defsDbId, properties: {} }]);
      route("PATCH", `/v1/databases/${defsDbId}`, [{}]);
      // 1回目: findBackupChildByTitle("一次データ｜moneyflow") → Search 完全一致でヒット
      // 2回目: findBackupChildByTitle("資金フロー｜観測ログ") → Search はミス → children 走査もミス → 新規作成
      route("POST", "/v1/search", [
        {
          results: [
            {
              id: "primary-db-1",
              object: "database",
              created_time: "2026-01-01T00:00:00.000Z",
              parent: { type: "page_id", page_id: ARCHIVE_PAGE },
              title: [{ plain_text: "一次データ｜moneyflow" }],
            },
          ],
          has_more: false,
          next_cursor: null,
        },
        searchEmpty(),
      ]);
      route("GET", `/v1/blocks/${STOCK_INFO_PAGE}/children`, [childrenPage()]);
      route("POST", "/v1/databases", [{ id: "obs-new" }]);

      const { ensureObservationsDb } = await load();
      const result = await ensureObservationsDb();
      expect(result.dbId).toBe("obs-new");
      const created = JSON.parse(
        String(calls.find((c) => new URL(c.url).pathname === "/v1/databases")?.init.body)
      ) as {
        title: Array<{ text: { content: string } }>;
        properties: Record<string, { rich_text?: object; relation?: { database_id: string } }>;
      };
      expect(created.title[0]?.text.content).toBe("資金フロー｜観測ログ");
      expect(created.properties["指標"]?.relation?.database_id).toBe(defsDbId);
      expect(created.properties["一次データ"]?.relation?.database_id).toBe("primary-db-1");
      // 区分値は国・商品・通貨まで含めると 100 種を超えるため select にしない
      expect(created.properties["区分"]).toEqual({ rich_text: {} });
    });

    it("既存 DB の列の型が期待と違えば (旧スキーマの select 区分など) throw し、黙って書き込まない", async () => {
      const defsDbId = "d".repeat(32);
      const obsDbId = "e".repeat(32);
      process.env.NOTION_MONEYFLOW_DEFS_DB_ID = defsDbId;
      process.env.NOTION_MONEYFLOW_OBS_DB_ID = obsDbId;
      route("GET", `/v1/databases/${defsDbId}`, [{ id: defsDbId, properties: {} }]);
      route("PATCH", `/v1/databases/${defsDbId}`, [{}]);
      route("POST", "/v1/search", [
        {
          results: [
            {
              id: "primary-db-1",
              object: "database",
              created_time: "2026-01-01T00:00:00.000Z",
              parent: { type: "page_id", page_id: ARCHIVE_PAGE },
              title: [{ plain_text: "一次データ｜moneyflow" }],
            },
          ],
          has_more: false,
          next_cursor: null,
        },
      ]);
      route("GET", `/v1/databases/${obsDbId}`, [
        { id: obsDbId, properties: { 区分: { id: "x", type: "select", select: { options: [] } } } },
      ]);
      const { ensureObservationsDb } = await load();
      await expect(ensureObservationsDb()).rejects.toThrow(/列「区分」の型が select/);
      expect(calls.filter((c) => c.init.method === "PATCH" && c.url.includes(obsDbId))).toHaveLength(0);
    });
  });

  describe("upsertObservation", () => {
    const dbId = "obs-db";

    it("観測キー (期間|指標|区分) が新規なら作成する", async () => {
      route("POST", `/v1/databases/${dbId}/query`, [{ results: [] }]);
      route("POST", "/v1/pages", [{ id: "obs-row-1" }]);
      const { upsertObservation, observationKey } = await load();
      const input = {
        period: "2026-W38",
        periodStart: "2026-09-14",
        periodEnd: "2026-09-18",
        indicatorKey: "sector_turnover",
        indicatorPageId: "def-page-1",
        category: "電気機器",
        categoryKind: "業種" as const,
        value: 12345,
        unit: "円" as const,
        changeFromPrev: null,
        approximate: true,
        measureKind: "実測" as const,
        primaryDataPageId: "primary-page-1",
      };
      const result = await upsertObservation(dbId, input);
      expect(result).toEqual({ pageId: "obs-row-1", outcome: "created" });
      expect(observationKey(input)).toBe("2026-W38|sector_turnover|電気機器");
      const body = JSON.parse(
        String(calls.find((c) => new URL(c.url).pathname === "/v1/pages")?.init.body)
      ) as { properties: Record<string, unknown> };
      expect(body.properties["キー"]).toEqual({
        title: [{ text: { content: "2026-W38|sector_turnover|電気機器" } }],
      });
      expect(body.properties["指標"]).toEqual({ relation: [{ id: "def-page-1" }] });
      expect(body.properties["一次データ"]).toEqual({ relation: [{ id: "primary-page-1" }] });
      expect(body.properties["値"]).toEqual({ number: 12345 });
      expect(body.properties["前期比"]).toEqual({ number: null });
    });

    it("primaryDataPageId が null なら一次データ relation は空にする", async () => {
      route("POST", `/v1/databases/${dbId}/query`, [{ results: [] }]);
      route("POST", "/v1/pages", [{ id: "obs-row-2" }]);
      const { upsertObservation } = await load();
      await upsertObservation(dbId, {
        period: "2026-W38",
        periodStart: "2026-09-14",
        periodEnd: "2026-09-18",
        indicatorKey: "sector_turnover_share",
        indicatorPageId: "def-page-2",
        category: "電気機器",
        categoryKind: "業種",
        value: 0.1234,
        unit: "比率",
        changeFromPrev: 0.01,
        approximate: true,
        measureKind: "実測",
        primaryDataPageId: null,
      });
      const body = JSON.parse(
        String(calls.find((c) => new URL(c.url).pathname === "/v1/pages")?.init.body)
      ) as { properties: Record<string, unknown> };
      expect(body.properties["一次データ"]).toEqual({ relation: [] });
    });

    it("既存キーがあれば更新する", async () => {
      route("POST", `/v1/databases/${dbId}/query`, [{ results: [{ id: "obs-existing" }] }]);
      route("PATCH", "/v1/pages/obs-existing", [{ id: "obs-existing" }]);
      const { upsertObservation } = await load();
      const result = await upsertObservation(dbId, {
        period: "2026-W38",
        periodStart: "2026-09-14",
        periodEnd: "2026-09-18",
        indicatorKey: "sector_turnover",
        indicatorPageId: "def-page-1",
        category: "電気機器",
        categoryKind: "業種",
        value: 99999,
        unit: "円",
        changeFromPrev: 100,
        approximate: true,
        measureKind: "実測",
        primaryDataPageId: null,
      });
      expect(result).toEqual({ pageId: "obs-existing", outcome: "updated" });
    });

    const sameInput = {
      period: "2026-08",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      indicatorKey: "sector_market_cap",
      indicatorPageId: "0000aaaa-1111-2222-3333-444455556666",
      category: "電気機器",
      categoryKind: "業種" as const,
      value: 123_000_000,
      unit: "円" as const,
      changeFromPrev: null,
      approximate: true,
      measureKind: "実測" as const,
      primaryDataPageId: "9999bbbb888877776666555544443333",
    };
    const existingProps = (overrides: Record<string, unknown> = {}) => ({
      キー: { type: "title", title: [{ plain_text: "2026-08|sector_market_cap|電気機器" }] },
      指標: { type: "relation", relation: [{ id: "0000aaaa111122223333444455556666" }] },
      対象期間: { type: "rich_text", rich_text: [{ plain_text: "2026-08" }] },
      期間開始: { type: "date", date: { start: "2026-08-01" } },
      期間終了: { type: "date", date: { start: "2026-08-31" } },
      区分: { type: "rich_text", rich_text: [{ plain_text: "電気機器" }] },
      区分種別: { type: "select", select: { name: "業種" } },
      値: { type: "number", number: 123_000_000 },
      単位: { type: "select", select: { name: "円" } },
      前期比: { type: "number", number: null },
      近似フラグ: { type: "checkbox", checkbox: true },
      実測推定: { type: "select", select: { name: "実測" } },
      一次データ: { type: "relation", relation: [{ id: "9999bbbb-8888-7777-6666-555544443333" }] },
      ...overrides,
    });

    it("既存行と値が完全一致なら PATCH せず unchanged を返す (ID のハイフン有無は同一視)", async () => {
      route("POST", `/v1/databases/${dbId}/query`, [{ results: [{ id: "obs-same", properties: existingProps() }] }]);
      const { upsertObservation } = await load();
      const result = await upsertObservation(dbId, sameInput);
      expect(result).toEqual({ pageId: "obs-same", outcome: "unchanged" });
      expect(calls.filter((c) => c.init.method === "PATCH")).toHaveLength(0);
    });

    it("値が 1 つでも違えば上書きする", async () => {
      route("POST", `/v1/databases/${dbId}/query`, [
        { results: [{ id: "obs-diff", properties: existingProps({ 値: { type: "number", number: 1 } }) }] },
      ]);
      route("PATCH", "/v1/pages/obs-diff", [{ id: "obs-diff" }]);
      const { upsertObservation } = await load();
      const result = await upsertObservation(dbId, sameInput);
      expect(result).toEqual({ pageId: "obs-diff", outcome: "updated" });
    });

    it("observationRowMatches: プロパティが読めない行は一致扱いにしない (古い値を黙って残さない)", async () => {
      const { observationRowMatches } = await load();
      expect(observationRowMatches(undefined, sameInput)).toBe(false);
      expect(observationRowMatches({}, sameInput)).toBe(false);
      expect(observationRowMatches(existingProps(), sameInput)).toBe(true);
      expect(
        observationRowMatches(existingProps({ 一次データ: { type: "relation", relation: [] } }), sameInput)
      ).toBe(false);
    });

    it("observationExists はキー完全一致の行の有無を返す", async () => {
      route("POST", `/v1/databases/${dbId}/query`, [{ results: [{ id: "x" }] }, { results: [] }]);
      const { observationExists } = await load();
      expect(await observationExists(dbId, "2026-08|k|c")).toBe(true);
      expect(await observationExists(dbId, "2026-08|k|d")).toBe(false);
    });
  });

  describe("ensureRunLogDb / recordRunLog", () => {
    it("固定 DB ID が無ければ新規作成し、実行ごとに新規行を作る (upsert しない)", async () => {
      route("GET", `/v1/blocks/${STOCK_INFO_PAGE}/children`, [childrenPage()]);
      route("POST", "/v1/search", [searchEmpty()]);
      route("POST", "/v1/databases", [{ id: "runlog-new" }]);
      route("POST", "/v1/pages", [{ id: "run-1" }, { id: "run-2" }]);

      const { ensureRunLogDb, recordRunLog } = await load();
      const { dbId } = await ensureRunLogDb();
      expect(dbId).toBe("runlog-new");

      const r1 = await recordRunLog(dbId, {
        runAt: "2026-09-27T08:35:00.000Z",
        status: "完了",
        sources: "jpx-sector-marketcap,jpx-short-selling",
        successCount: 2,
        failedCount: 0,
        runUrl: "https://github.com/o/r/actions/runs/1",
        reason: null,
      });
      const r2 = await recordRunLog(dbId, {
        runAt: "2026-09-27T08:36:00.000Z",
        status: "完了",
        sources: "jpx-sector-marketcap,jpx-short-selling",
        successCount: 2,
        failedCount: 0,
        runUrl: "https://github.com/o/r/actions/runs/1",
        reason: null,
      });
      expect(r1.pageId).toBe("run-1");
      expect(r2.pageId).toBe("run-2");
      // upsert キーが無いので query は一切叩かない (常に新規作成)
      expect(calls.filter((c) => new URL(c.url).pathname.includes("/query"))).toHaveLength(0);
      expect(calls.filter((c) => new URL(c.url).pathname === "/v1/pages")).toHaveLength(2);
    });
  });
});
