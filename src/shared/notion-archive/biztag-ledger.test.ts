/**
 * 「事業タグ単語帳（台帳）」Notion 保管のテスト。
 * router+queue+Date.now fast-forward の方式は stock-text.test.ts と同じ。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../sha256.js";

type FetchCalls = Array<{ url: string; init: RequestInit }>;

/**
 * 外部読者 (kabulabAgents) が契約 (docs/005-yuho-quant-business-tags-contract.md
 * §8) 通りに独自実装するであろう正規化 JSON 化。「種別 = 版」の行のハッシュだけが
 * この式に従うことをテストで固定する (biztag-ledger.ts の内部実装から独立して
 * 同じ規則をここでも定義する)。
 */
function canonicalJsonForTest(value: unknown): string {
  const canonicalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonicalize);
    if (v !== null && typeof v === "object") {
      const record = v as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) sorted[key] = canonicalize(record[key]);
      return sorted;
    }
    return v;
  };
  return JSON.stringify(canonicalize(value));
}

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

describe("notion-archive biztag-ledger", () => {
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
    delete process.env.NOTION_BIZTAG_LEDGER_DB_ID;
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

  const load = () => import("./biztag-ledger.js");

  const childrenPage = (results: unknown[], has_more = false, next_cursor: string | null = null) => ({
    results,
    has_more,
    next_cursor,
  });

  describe("ensureLedgerDb", () => {
    it("固定 DB ID があれば Search せず不足列だけ PATCH する", async () => {
      process.env.NOTION_BIZTAG_LEDGER_DB_ID = "d".repeat(32);
      route("GET", `/v1/databases/${"d".repeat(32)}`, [
        { id: "d".repeat(32), properties: { 名前: { id: "n" } } },
      ]);
      route("PATCH", `/v1/databases/${"d".repeat(32)}`, [{}]);
      const { ensureLedgerDb } = await load();
      const dbId = await ensureLedgerDb();
      expect(dbId).toBe("d".repeat(32));
      expect(calls.filter((c) => new URL(c.url).pathname === "/v1/search")).toHaveLength(0);
      const patchBody = JSON.parse(String(calls[1]?.init.body)) as { properties: Record<string, unknown> };
      // 「名前」以外の全列が不足分として PATCH される
      expect(Object.keys(patchBody.properties).sort()).toEqual(
        ["種別", "状態", "版", "ハッシュ", "記録日", "理由", "差分", "巻き戻し元"].sort()
      );
    });

    it("Search 未ヒットなら新規作成する", async () => {
      route("POST", "/v1/search", [{ results: [], has_more: false, next_cursor: null }]);
      route("GET", `/v1/blocks/${STOCK_INFO}/children`, [childrenPage([])]);
      route("POST", "/v1/databases", [{ id: "ledger-new" }]);
      const { ensureLedgerDb } = await load();
      const dbId = await ensureLedgerDb();
      expect(dbId).toBe("ledger-new");
      const created = JSON.parse(String(calls[2]?.init.body)) as {
        title: Array<{ text: { content: string } }>;
      };
      expect(created.title[0]?.text.content).toBe("事業タグ単語帳（台帳）");
    });
  });

  describe("createLedgerEntry / listLedgerEntries / readLedgerJson", () => {
    const json = { version: "v1", business: [{ id: "B.SEMI.TEST" }] };

    it("作成した内容をハッシュ照合込みで読み戻せる (種別=版は正規化JSONでハッシュを取る・契約§8)", async () => {
      route("POST", "/v1/pages", [{ id: "entry-1" }]);
      const { createLedgerEntry, readLedgerJson } = await load();
      const entry = await createLedgerEntry("db-1", {
        name: "v1",
        kind: "版",
        state: "有効",
        version: "v1",
        reason: "初回投入",
        diff: "",
        rollbackFrom: null,
        json,
        recordedAt: "2026-09-25",
      });
      // json = { version, business } はキー順が既にアルファベット順と異なるため、
      // 素の JSON.stringify と正規化JSONは別の文字列になる (この差が本テストの主眼)。
      expect(entry.hash).not.toBe(await sha256Hex(JSON.stringify(json)));
      expect(entry.hash).toBe(await sha256Hex(canonicalJsonForTest(json)));

      const body = JSON.parse(String(calls[0]?.init.body)) as {
        properties: Record<string, unknown>;
        children: Array<{ type: string; heading_2?: { rich_text: Array<{ text: { content: string } }> } }>;
      };
      expect(body.properties["名前"]).toEqual({
        title: [{ type: "text", text: { content: "v1" } }],
      });
      expect(body.properties["種別"]).toEqual({ select: { name: "版" } });
      expect(body.children[0]?.type).toBe("heading_2");
      expect(body.children[0]?.heading_2?.rich_text[0]?.text.content).toBe("記録本文（JSON）");

      // 読み戻し: children を GET で返す (作成時と同じ内容)
      route("GET", "/v1/blocks/entry-1/children", [childrenPage(body.children)]);
      const got = await readLedgerJson(entry);
      expect(got).toEqual(json);
    });

    it("ハッシュ不一致は LedgerIntegrityError", async () => {
      const { LedgerIntegrityError, readLedgerJson } = await load();
      route("GET", "/v1/blocks/entry-2/children", [
        childrenPage([
          {
            id: "b0",
            type: "heading_2",
            heading_2: { rich_text: [{ plain_text: "記録本文（JSON）" }] },
          },
          { id: "b1", type: "code", code: { rich_text: [{ plain_text: '{"改ざん":true}' }] } },
        ]),
      ]);
      await expect(
        readLedgerJson({
          pageId: "entry-2",
          name: "x",
          kind: "版",
          state: "有効",
          version: "v1",
          hash: "0".repeat(64),
          recordedAt: "2026-09-25",
          reason: "",
          diff: "",
          rollbackFrom: null,
        })
      ).rejects.toBeInstanceOf(LedgerIntegrityError);
    });

    it("マーカー見出しが無ければ LedgerIntegrityError", async () => {
      const { LedgerIntegrityError, readLedgerJson } = await load();
      route("GET", "/v1/blocks/entry-3/children", [
        childrenPage([{ id: "b0", type: "paragraph" }]),
      ]);
      await expect(
        readLedgerJson({
          pageId: "entry-3",
          name: "x",
          kind: "版",
          state: "有効",
          version: "v1",
          hash: "0".repeat(64),
          recordedAt: "2026-09-25",
          reason: "",
          diff: "",
          rollbackFrom: null,
        })
      ).rejects.toBeInstanceOf(LedgerIntegrityError);
    });

    it("100 ブロック超の本文は追記に分割する", async () => {
      route("POST", "/v1/pages", [{ id: "entry-big" }]);
      route("PATCH", "/v1/blocks/entry-big/children", [{}]);
      const { createLedgerEntry } = await load();
      const bigJson = { text: "x".repeat(2000 * 150) }; // 150 code block 相当
      await createLedgerEntry("db-1", {
        name: "big",
        kind: "見直し材料",
        state: "最新",
        version: null,
        reason: "",
        diff: "",
        rollbackFrom: null,
        json: bigJson,
        recordedAt: "2026-09-25",
      });
      const created = JSON.parse(String(calls[0]?.init.body)) as { children: unknown[] };
      const appended = JSON.parse(String(calls[1]?.init.body)) as { children: unknown[] };
      expect(created.children).toHaveLength(100);
      expect(appended.children.length).toBeGreaterThan(0);
    });

    it("listLedgerEntries: 種別・状態でフィルタし記録日昇順で返す", async () => {
      const page = (id: string, name: string, recordedAt: string) => ({
        id,
        properties: {
          名前: { title: [{ plain_text: name }] },
          種別: { select: { name: "版" } },
          状態: { select: { name: "有効" } },
          版: { rich_text: [{ plain_text: "v1" }] },
          ハッシュ: { rich_text: [{ plain_text: "a".repeat(64) }] },
          記録日: { date: { start: recordedAt } },
          理由: { rich_text: [] },
          差分: { rich_text: [] },
          巻き戻し元: { rich_text: [] },
        },
      });
      route("POST", "/v1/databases/ledger-db/query", [
        {
          results: [page("p1", "v1", "2026-01-01"), page("p2", "v2", "2026-06-01")],
          has_more: false,
          next_cursor: null,
        },
      ]);
      const { listLedgerEntries } = await load();
      const entries = await listLedgerEntries("ledger-db", { kind: "版", state: "有効" });
      expect(entries.map((e) => e.name)).toEqual(["v1", "v2"]);
      expect(entries[0]?.version).toBe("v1");
      const body = JSON.parse(String(calls[0]?.init.body)) as { filter: unknown };
      expect(body.filter).toEqual({
        and: [
          { property: "種別", select: { equals: "版" } },
          { property: "状態", select: { equals: "有効" } },
        ],
      });
    });

    it("listLedgerEntries: 想定外の種別は throw する", async () => {
      route("POST", "/v1/databases/ledger-db/query", [
        {
          results: [
            {
              id: "p1",
              properties: {
                名前: { title: [{ plain_text: "x" }] },
                種別: { select: { name: "謎" } },
                状態: { select: { name: "有効" } },
                ハッシュ: { rich_text: [{ plain_text: "a".repeat(64) }] },
                記録日: { date: { start: "2026-01-01" } },
              },
            },
          ],
          has_more: false,
          next_cursor: null,
        },
      ]);
      const { listLedgerEntries } = await load();
      await expect(listLedgerEntries("ledger-db")).rejects.toThrow("種別");
    });
  });

  describe("updateLedgerEntry / replaceLedgerJson", () => {
    it("updateLedgerEntry: 指定したフィールドだけ PATCH する", async () => {
      route("PATCH", "/v1/pages/entry-1", [{}]);
      const { updateLedgerEntry } = await load();
      await updateLedgerEntry("entry-1", { state: "不採用", reason: "精度低下" });
      const body = JSON.parse(String(calls[0]?.init.body)) as { properties: Record<string, unknown> };
      expect(body.properties).toEqual({
        状態: { select: { name: "不採用" } },
        理由: { rich_text: [{ type: "text", text: { content: "精度低下" } }] },
      });
    });

    const packetEntry = {
      pageId: "entry-1",
      name: "見直し材料",
      kind: "見直し材料" as const,
      state: "最新" as const,
      version: "v1",
      hash: "old-hash",
      recordedAt: "2026-01-01",
      reason: "自動生成",
      diff: "",
      rollbackFrom: null,
    };

    it("replaceLedgerJson: 同じ属性で新しい行を作ってから古い行をアーカイブする (ブロックを 1 つずつ消さない)", async () => {
      route("GET", "/v1/pages/entry-1", [{ id: "entry-1", parent: { type: "database_id", database_id: "ledger-db" } }]);
      route("POST", "/v1/pages", [{ id: "entry-2" }]);
      route("PATCH", "/v1/pages/entry-1", [{}]);
      const { replaceLedgerJson } = await load();
      const newJson = { version: "v2" };
      const updated = await replaceLedgerJson(packetEntry, newJson, "2026-09-25");
      expect(updated.pageId).toBe("entry-2");
      expect(updated.hash).toBe(await sha256Hex(JSON.stringify(newJson)));
      expect(updated.recordedAt).toBe("2026-09-25");
      expect(updated.state).toBe("最新");
      const methods = calls.map((c) => `${c.init.method} ${new URL(c.url).pathname}`);
      expect(methods).toEqual(["GET /v1/pages/entry-1", "POST /v1/pages", "PATCH /v1/pages/entry-1"]);
      // 新しい行は同じ DB・同じ種別/状態で作り、古い行は archived にする (作ってから消す順)
      const created = JSON.parse(String(calls[1]?.init.body)) as { parent: { database_id: string } };
      expect(created.parent.database_id).toBe("ledger-db");
      expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ archived: true });
    });

    it("replaceLedgerJson: 親が DB でない行は throw する (黙ってどこかに作らない)", async () => {
      route("GET", "/v1/pages/entry-1", [{ id: "entry-1", parent: { type: "page_id", page_id: "x" } }]);
      const { replaceLedgerJson } = await load();
      await expect(replaceLedgerJson(packetEntry, { version: "v2" }, "2026-09-25")).rejects.toThrow("親 DB");
    });

    it("replaceLedgerJson: 種別=版なら正規化JSONでハッシュを取る (createLedgerEntry と同じ規則)", async () => {
      route("GET", "/v1/pages/entry-ver", [{ id: "entry-ver", parent: { type: "database_id", database_id: "ledger-db" } }]);
      route("POST", "/v1/pages", [{ id: "entry-ver-2" }]);
      route("PATCH", "/v1/pages/entry-ver", [{}]);
      const { replaceLedgerJson } = await load();
      const newVocabJson = { version: "v2", business: [{ id: "B.SEMI.TEST" }] };
      const updated = await replaceLedgerJson(
        { ...packetEntry, pageId: "entry-ver", name: "版", kind: "版", state: "有効" },
        newVocabJson,
        "2026-09-25"
      );
      expect(updated.hash).not.toBe(await sha256Hex(JSON.stringify(newVocabJson)));
      expect(updated.hash).toBe(await sha256Hex(canonicalJsonForTest(newVocabJson)));
    });
  });
});
