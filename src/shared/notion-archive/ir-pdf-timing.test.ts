/**
 * INC-ir-pdf-502 計測。経過時間のログが出ることと、間隔・件数・失敗の伝播が
 * 変わらないことを固定する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractPdfText } from "../../../services/ir-catalog/src/services/pdf-sentiment/extract-text.js";
import {
  IR_PDF_TIMING_TAG,
  beginIrPdfItemTiming,
  endIrPdfItemTiming,
  formatIrPdfItemTimingLine,
  notionTimingKind,
  readIrPdfItemTiming,
} from "./ir-pdf-timing.js";

const ARCHIVE_PAGE = "a".repeat(32);
const MINIMAL_PDF = [
  "%PDF-1.4",
  "1 0 obj << /Type /Catalog /Pages 2 0 R >>",
  "endobj",
  "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "endobj",
  "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  "endobj",
  "4 0 obj << /Length 44 >>",
  "stream",
  "BT /F1 12 Tf 10 10 Td (Hello test) Tj ET",
  "endstream",
  "endobj",
  "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  "endobj",
  "trailer << /Root 1 0 R >>",
].join("\n");
const PDF = new TextEncoder().encode(MINIMAL_PDF);

type Call = { url: string; init: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installHarness(delayMs: number) {
  const calls: Call[] = [];
  const routes = new Map<string, Response[]>();
  const route = (method: string, path: string, bodies: Array<Response | unknown>) => {
    const key = `${method} ${path}`;
    const prev = routes.get(key) ?? [];
    routes.set(key, prev.concat(bodies.map((body) => (body instanceof Response ? body : jsonResponse(body)))));
  };
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let t = 1_000_000;
  // 時計の参照だけでdeadlineを進めず、通信stubごとに経過させる。
  Date.now = (() => t) as typeof Date.now;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    t += 10_000;
    const href = String(url);
    if (delayMs > 0 && (href.includes("tdnet.example.test") || href.includes("file.notion.so"))) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
    calls.push({ url: href, init: init ?? {} });
    const u = new URL(href);
    const key = `${init?.method ?? "GET"} ${u.hostname}${u.pathname}`;
    const q = routes.get(key);
    if (!q || q.length === 0) throw new Error(`テスト: 未定義ルートへの fetch: ${key}`);
    const next = q.shift();
    if (!next) throw new Error(`テスト: 応答が空: ${key}`);
    return next;
  }) as typeof fetch;
  return {
    calls,
    route,
    restore() {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
    },
  };
}

function infoLines(info: { mock: { calls: unknown[][] } }): string[] {
  return info.mock.calls.map((call) => String(call[0]));
}

const row = {
  key: "T1",
  ticker: "1001",
  companyName: "試験",
  companyUrl: "https://example.test",
  tags: [] as string[],
  primaryTag: null,
  pubdate: "2026-01-15T01:02:03.000Z",
  title: "試験開示",
  documentUrl: "https://tdnet.example.test/1.pdf",
  markets: null,
};

describe("ir-pdf timing labels", () => {
  it("呼び出し種別は upload / send 以外を method と path で分ける", () => {
    expect(notionTimingKind("POST", "/file_uploads")).toBe("upload");
    expect(notionTimingKind("POST", "/file_uploads/abc/complete")).toBe("complete");
    expect(notionTimingKind("POST", "/search")).toBe("search");
    expect(notionTimingKind("POST", "/databases/db/query?x=1")).toBe("query");
    expect(notionTimingKind("GET", "/pages/p")).toBe("GET");
    expect(notionTimingKind("PATCH", "/pages/p")).toBe("PATCH");
    expect(notionTimingKind("POST", "/pages")).toBe("POST");
    expect(notionTimingKind("DELETE", "/blocks/b")).toBe("DELETE");
  });
});

describe("380ms queue の計測", () => {
  const tokenBefore = process.env.NOTION_TOKEN;
  const originalFetch = globalThis.fetch;
  let starts: number[];

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(1_000_000);
    process.env.NOTION_TOKEN = "protocol-test-token";
    starts = [];
    globalThis.fetch = async () => {
      starts.push(performance.now());
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    endIrPdfItemTiming();
  });

  afterEach(() => {
    endIrPdfItemTiming();
    globalThis.fetch = originalFetch;
    if (tokenBefore === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = tokenBefore;
    vi.useRealTimers();
    vi.resetModules();
  });

  it("計測中も間隔は380ms・件数は2のまま、待ちと各GETが1行になる", async () => {
    const { notionRequest, notionStats } = await import("./client.js");
    const { beginIrPdfItemTiming: begin, readIrPdfItemTiming: read, formatIrPdfItemTimingLine: format } = await import("./ir-pdf-timing.js");
    begin();
    const pending = Promise.all([notionRequest("GET", "/a"), notionRequest("GET", "/b")]);
    await vi.runAllTimersAsync();
    await pending;
    expect(starts).toEqual([0, 380]);
    expect(notionStats()).toEqual({ requests: 2, rateLimited: 0, transientRetries: 0 });
    const timing = read();
    if (timing === null) throw new Error("item timing was not started");
    expect(timing.queueWaitMs).toBe(380);
    expect(timing.calls.map((call) => call.kind)).toEqual(["GET", "GET"]);
    expect(format({
      tdnetId: "T1",
      totalMs: 380,
      timing,
      stockCache: "hit",
    })).toBe(
      `${IR_PDF_TIMING_TAG} tdnetId=T1 totalMs=380 pdfFetchMs=0 pdfParseMs=0 readbackMs=0 stockResolveMs=0 queueWaitMs=380 stockCache=hit calls=GET:0,GET:0`
    );
  });

  it("恒久400は再送せず、計測行を残して同じエラーを返す", async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ object: "error", code: "validation_error", message: "bad" }),
      { status: 400 }
    );
    const { notionRequest, notionStats } = await import("./client.js");
    const { beginIrPdfItemTiming: begin, readIrPdfItemTiming: read } = await import("./ir-pdf-timing.js");
    begin();
    await expect(notionRequest("GET", "/a")).rejects.toThrow(/status=400/);
    expect(notionStats()).toEqual({ requests: 1, rateLimited: 0, transientRetries: 0 });
    expect(read()?.calls.map((call) => call.kind)).toEqual(["GET"]);
  });
});

describe("pdf.js parse と readback の計測", () => {
  afterEach(() => endIrPdfItemTiming());

  it("項目の外では解析時間を足さず、中では同じテキストのまま足す", async () => {
    const outside = await extractPdfText(PDF);
    expect(outside).toContain("Hello test");
    expect(readIrPdfItemTiming()).toBeNull();
    beginIrPdfItemTiming();
    const inside = await extractPdfText(PDF);
    const timing = readIrPdfItemTiming();
    expect(inside).toBe(outside);
    expect(timing?.pdfParseMs).toBeGreaterThan(0);
    expect(await extractPdfText(new TextEncoder().encode("not a pdf"))).toBeNull();
    expect(readIrPdfItemTiming()?.pdfParseMs).toBe(timing?.pdfParseMs);
  });

  it("SHA不一致は停止したまま、再取得とSHAの時間を残す", async () => {
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    let t = 1_000_000;
    // 時計の参照だけでdeadlineを進めず、通信stubごとに経過させる。
    Date.now = (() => t) as typeof Date.now;
    process.env.NOTION_TOKEN = "protocol-test-token";
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      t += 10_000;
      const href = String(url);
      const method = init?.method ?? "GET";
      if (method === "GET" && href.includes("/v1/pages/page-1")) {
        return jsonResponse({
          properties: {
            IR資料: {
              type: "files",
              files: [{ name: "a.pdf", type: "file", file: { url: "https://file.notion.so/a.pdf" } }],
            },
          },
        });
      }
      if (href.includes("file.notion.so/a.pdf")) {
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
        return new Response(PDF, { status: 200 });
      }
      throw new Error(`テスト: 未定義ルートへの fetch: ${method} ${href}`);
    }) as typeof fetch;
    try {
      vi.resetModules();
      const { verifyArchivedAttachments } = await import("./readback.js");
      const { beginIrPdfItemTiming: begin, readIrPdfItemTiming: read } = await import("./ir-pdf-timing.js");
      begin();
      const different = new Uint8Array(PDF.byteLength);
      different.set(PDF);
      different[different.length - 1] = different[different.length - 1] === 0 ? 1 : 0;
      await expect(verifyArchivedAttachments(
        "page-1",
        [{ filename: "a.pdf", bytes: different }],
        "TDnet 開示 PDF",
        "IR資料"
      )).rejects.toThrow(/SHA256/);
      expect(read()?.readbackMs).toBeGreaterThanOrEqual(30);
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
      endIrPdfItemTiming();
    }
  });
});

describe("適時開示1件の計測ログ", () => {
  const ORIG_ENV = { ...process.env };
  let harness: ReturnType<typeof installHarness>;

  beforeEach(() => {
    process.env.NOTION_TOKEN = "dummy-token";
    process.env.NOTION_ARCHIVE_PAGE_ID = ARCHIVE_PAGE;
    vi.resetModules();
    endIrPdfItemTiming();
    harness = installHarness(40);
  });

  afterEach(() => {
    harness.restore();
    process.env = { ...ORIG_ENV };
    endIrPdfItemTiming();
    vi.resetModules();
  });

  function routeArchive(pageStatus: Response | { id: string }) {
    const service = "ir-timing";
    const parentDb = "parent-db";
    const stockPage = "stock-page";
    const childDb = "child-db";
    harness.route("POST", "api.notion.com/v1/search", [{
      results: [{
        id: parentDb,
        object: "database",
        created_time: "2026-01-01T00:00:00.000Z",
        parent: { type: "page_id", page_id: ARCHIVE_PAGE },
        title: [{ plain_text: `銘柄一覧｜${service}` }],
      }],
      has_more: false,
      next_cursor: null,
    }]);
    harness.route("GET", `api.notion.com/v1/databases/${childDb}`, [{
      parent: { type: "page_id", page_id: stockPage },
      archived: false,
      in_trash: false,
    }]);
    harness.route("POST", `api.notion.com/v1/databases/${childDb}/query`, [
      { results: [], has_more: false, next_cursor: null },
    ]);
    harness.route("GET", "tdnet.example.test/1.pdf", [
      new Response(PDF.slice(), { status: 200, headers: { "content-type": "application/pdf" } }),
    ]);
    harness.route("GET", "api.notion.com/v1/users/me", [
      { bot: { workspace_limits: { max_file_upload_size_in_bytes: 5_368_709_120 } } },
    ]);
    harness.route("POST", "api.notion.com/v1/file_uploads", [
      { id: "upload-1", status: "pending" },
    ]);
    harness.route("POST", "api.notion.com/v1/file_uploads/upload-1/send", [
      { object: "file_upload", id: "upload-1", status: "uploaded" },
    ]);
    harness.route("POST", "api.notion.com/v1/pages", [pageStatus]);
    harness.route("GET", "api.notion.com/v1/pages/written-page", [{
      properties: {
        IR資料: {
          type: "files",
          files: [{ name: "1001_2026-01-15_T1.pdf", type: "file", file: { url: "https://file.notion.so/hosted.pdf" } }],
        },
      },
    }]);
    harness.route("GET", "file.notion.so/hosted.pdf", [
      new Response(PDF.slice(), { status: 200, headers: { "content-type": "application/pdf" } }),
    ]);
    return { service, stockPage, childDb };
  }

  it("1行に各工程と呼び出しが出て、確認GETは0・notion-callsの件数は変わらない", async () => {
    const { service, stockPage, childDb } = routeArchive({ id: "written-page" });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const persisted = vi.fn();
    const classified = vi.fn();
    let d1Ms = 0;
    const cache = {
      get: vi.fn(async () => {
        const started = performance.now();
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
        d1Ms = performance.now() - started;
        return { stockPageId: stockPage, childDbId: childDb, schemaVersion: 1 };
      }),
      put: vi.fn(async () => undefined),
      invalidate: vi.fn(async () => undefined),
    };
    try {
      const { upsertDisclosuresByStock } = await import("./dataset.js");
      const { classifyPdfSentimentWithText } = await import("../../../services/ir-catalog/src/services/pdf-sentiment/index.js");
      const direct = await classifyPdfSentimentWithText(PDF, null);
      const result = await upsertDisclosuresByStock({
        service,
        tagOptions: [],
        rows: [row],
        stockPageCache: cache,
        onPagePersisted: persisted,
        classifyPdf: async (bytes, primaryTag) => {
          const { result: sentiment, text } = await classifyPdfSentimentWithText(bytes, primaryTag);
          return { ...sentiment, text };
        },
        onPdfClassified: classified,
      });
      expect(result.created).toBe(1);
      expect(result.skippedExisting).toBe(0);
      expect(persisted).toHaveBeenCalledTimes(1);
      expect(persisted).toHaveBeenCalledWith("T1", "written-page");
      expect(classified).toHaveBeenCalledTimes(1);
      expect(classified.mock.calls[0]?.[1]).toMatchObject({ sentiment: direct.result.sentiment, text: direct.text });
      expect(cache.put).not.toHaveBeenCalled();
      expect(cache.invalidate).not.toHaveBeenCalled();
      expect(cache.get).toHaveBeenCalledTimes(1);
      const hosted = harness.calls.filter((call) => call.url.includes("file.notion.so/hosted.pdf"));
      expect(hosted).toHaveLength(1);
      const confirm = harness.calls.filter((call) => call.url.includes("/v1/file_uploads/upload-1") && (call.init.method ?? "GET") === "GET");
      expect(confirm).toHaveLength(0);
      const blocks = harness.calls.filter((call) => call.url.includes("/v1/blocks/"));
      expect(blocks).toHaveLength(0);
      const pdfAt = harness.calls.findIndex((call) => call.url.includes("tdnet.example.test/1.pdf"));
      const notionAfterPdf = harness.calls.slice(pdfAt + 1).filter((call) => new URL(call.url).hostname === "api.notion.com");
      expect(notionAfterPdf).toHaveLength(5);
      const lines = infoLines(info);
      const notionCalls = lines.find((line) => line.includes("notion-calls") && line.includes("tdnetId=T1"));
      expect(notionCalls).toContain("requests=5");
      expect(notionCalls).toContain("outcome=ok");
      expect(notionCalls).toContain("stockCache=hit");
      const timing = lines.find((line) => line.startsWith(IR_PDF_TIMING_TAG) && line.includes("tdnetId=T1"));
      expect(timing).toMatch(
        /^\[INC-ir-pdf-502-timing\] tdnetId=T1 totalMs=\d+ pdfFetchMs=\d+ pdfParseMs=\d+ readbackMs=\d+ stockResolveMs=\d+ queueWaitMs=0 stockCache=hit calls=D1:\d+,GET:\d+,query:\d+,GET:\d+,upload:\d+,send:\d+,POST:\d+,GET:\d+$/
      );
      if (timing === undefined) throw new Error("timing line missing");
      const fields = new Map<string, number>();
      for (const match of timing.matchAll(/([A-Za-z]+)=(\d+)/g)) {
        const key = match[1];
        const value = match[2];
        if (key === undefined || value === undefined) throw new Error("timing field missing");
        fields.set(key, Number(value));
      }
      const pdfFetchMs = fields.get("pdfFetchMs");
      const pdfParseMs = fields.get("pdfParseMs");
      const readbackMs = fields.get("readbackMs");
      const stockResolveMs = fields.get("stockResolveMs");
      const totalMs = fields.get("totalMs");
      if (pdfFetchMs === undefined || pdfParseMs === undefined || readbackMs === undefined || stockResolveMs === undefined || totalMs === undefined) {
        throw new Error("timing field missing");
      }
      expect(pdfFetchMs).toBeGreaterThanOrEqual(30);
      expect(pdfParseMs).toBeGreaterThan(0);
      expect(readbackMs).toBeGreaterThanOrEqual(30);
      expect(stockResolveMs).toBeGreaterThanOrEqual(30);
      expect(totalMs).toBeGreaterThanOrEqual(pdfFetchMs);
      expect(totalMs).toBeGreaterThanOrEqual(readbackMs);
      expect(totalMs).toBeGreaterThanOrEqual(stockResolveMs);
      const d1Text = timing.match(/calls=D1:(\d+)/)?.[1];
      if (d1Text === undefined) throw new Error("D1 timing missing");
      const d1 = Number(d1Text);
      expect(d1).toBeGreaterThanOrEqual(30);
      expect(d1).toBeGreaterThanOrEqual(Math.round(d1Ms) - 5);
      const notion = harness.calls.filter((call) => new URL(call.url).hostname === "api.notion.com");
      const phase = lines.find((line) => line.startsWith(`${IR_PDF_TIMING_TAG} phase=end`));
      expect(phase).toBe(
        `${IR_PDF_TIMING_TAG} phase=end requests=${notion.length} rateLimited=0 transientRetries=0 phaseRequests=${notion.length} phaseRateLimited=0 phaseTransientRetries=0`
      );
      expect(lines.filter((line) => line.startsWith(IR_PDF_TIMING_TAG) && line.includes("tdnetId="))).toHaveLength(1);
    } finally {
      info.mockRestore();
    }
  });

  it("ページ作成の恒久エラーは握りつぶさず、計測とphase集計は残る", async () => {
    const { service, stockPage, childDb } = routeArchive(jsonResponse(
      { object: "error", code: "validation_error", message: "bad" },
      400
    ));
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const persisted = vi.fn();
    const cache = {
      get: vi.fn(async () => ({ stockPageId: stockPage, childDbId: childDb, schemaVersion: 1 })),
      put: vi.fn(async () => undefined),
      invalidate: vi.fn(async () => undefined),
    };
    try {
      const { upsertDisclosuresByStock } = await import("./dataset.js");
      await expect(upsertDisclosuresByStock({
        service,
        tagOptions: [],
        rows: [row],
        stockPageCache: cache,
        onPagePersisted: persisted,
      })).rejects.toThrow(/status=400/);
      expect(persisted).not.toHaveBeenCalled();
      expect(cache.put).not.toHaveBeenCalled();
      const pagePosts = harness.calls.filter((call) => call.url.endsWith("/v1/pages") && call.init.method === "POST");
      expect(pagePosts).toHaveLength(1);
      expect(harness.calls.filter((call) => call.url.includes("file.notion.so"))).toHaveLength(0);
      const lines = infoLines(info);
      const timing = lines.find((line) => line.includes("tdnetId=T1"));
      expect(timing).toMatch(/stockCache=hit calls=D1:\d+,GET:\d+,query:\d+,GET:\d+,upload:\d+,send:\d+,POST:\d+$/);
      expect(lines.some((line) => line.startsWith(`${IR_PDF_TIMING_TAG} phase=end`) && line.includes("rateLimited=0"))).toBe(true);
    } finally {
      info.mockRestore();
    }
  });

  it("予算切れの行は取得せず、phase集計だけ出す", async () => {
    routeArchive({ id: "written-page" });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { upsertDisclosuresByStock } = await import("./dataset.js");
      const result = await upsertDisclosuresByStock({
        service: "ir-timing",
        tagOptions: [],
        deadlineMs: 0,
        rows: [row],
      });
      expect(result.reachedDeadline).toBe(true);
      expect(result.created).toBe(0);
      expect(result.deadlineRemainderKeys).toEqual(["T1"]);
      expect(harness.calls.filter((call) => call.url.includes("tdnet.example.test"))).toHaveLength(0);
      const lines = infoLines(info);
      expect(lines.some((line) => line.includes("tdnetId=T1"))).toBe(false);
      expect(lines.some((line) => line.startsWith(`${IR_PDF_TIMING_TAG} phase=end`))).toBe(true);
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("deadline-remainder");
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });
});

describe("format", () => {
  it("呼び出しが無い項目は calls=- で出す", () => {
    expect(formatIrPdfItemTimingLine({
      tdnetId: "T9",
      totalMs: 3,
      timing: { pdfFetchMs: 0, pdfParseMs: 0, readbackMs: 0, stockResolveMs: 0, queueWaitMs: 0, calls: [] },
      stockCache: "unresolved",
    })).toBe(
      `${IR_PDF_TIMING_TAG} tdnetId=T9 totalMs=3 pdfFetchMs=0 pdfParseMs=0 readbackMs=0 stockResolveMs=0 queueWaitMs=0 stockCache=unresolved calls=-`
    );
  });
});
