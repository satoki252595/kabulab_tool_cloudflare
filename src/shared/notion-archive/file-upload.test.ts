/**
 * INC-20261008-kabulab_tool_cloudflare-ir-pdf-502
 *
 * send（multi_part は complete）の status が "uploaded" のときだけ、
 * 確定確認の GET /file_uploads/{id} を省く。判定を緩めてはいけない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ARCHIVE_PAGE = "a".repeat(32);
const PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4

type Call = { url: string; init: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installHarness() {
  const calls: Call[] = [];
  const routes = new Map<string, Response[]>();
  const route = (method: string, path: string, bodies: Array<Response | unknown>) => {
    const key = `${method} ${path}`;
    const prev = routes.get(key) ?? [];
    routes.set(
      key,
      prev.concat(
        bodies.map((body) => (body instanceof Response ? body : jsonResponse(body)))
      )
    );
  };
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let t = 1_000_000;
  Date.now = (() => (t += 10_000)) as typeof Date.now;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, init: init ?? {} });
    const u = new URL(href);
    const key = `${init?.method ?? "GET"} ${u.hostname}${u.pathname}`;
    const q = routes.get(key);
    if (!q || q.length === 0) {
      throw new Error(`テスト: 未定義ルートへの fetch: ${key}`);
    }
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

function confirmGets(calls: Call[], id = "upload-1"): Call[] {
  return calls.filter((c) => {
    const u = new URL(c.url);
    return (c.init.method ?? "GET") === "GET" && u.pathname === `/v1/file_uploads/${id}`;
  });
}

describe("file_upload の確定確認 GET", () => {
  const ORIG_ENV = { ...process.env };
  let harness: ReturnType<typeof installHarness>;

  beforeEach(() => {
    process.env.NOTION_TOKEN = "dummy-token";
    process.env.NOTION_ARCHIVE_PAGE_ID = ARCHIVE_PAGE;
    vi.resetModules();
    harness = installHarness();
  });

  afterEach(() => {
    harness.restore();
    process.env = { ...ORIG_ENV };
    vi.resetModules();
  });

  async function loadUpload() {
    const upload = await import("./file-upload.js");
    const client = await import("./client.js");
    client.resetNotionStats();
    return { ...upload, notionStats: client.notionStats };
  }

  function routeSingle(send: Response | unknown, confirm?: unknown) {
    harness.route("GET", "api.notion.com/v1/users/me", [
      { bot: { workspace_limits: { max_file_upload_size_in_bytes: 5_368_709_120 } } },
    ]);
    harness.route("POST", "api.notion.com/v1/file_uploads", [
      { id: "upload-1", status: "pending" },
    ]);
    harness.route("POST", "api.notion.com/v1/file_uploads/upload-1/send", [send]);
    if (confirm !== undefined) {
      harness.route("GET", "api.notion.com/v1/file_uploads/upload-1", [confirm]);
    }
  }

  const pdf = {
    bytes: PDF,
    filename: "1001_2026-01-15_T1.pdf",
    contentType: "application/pdf",
  };

  it("uploaded なら確認 GET は 0 回で、pending よりリクエストが 1 少ない", async () => {
    routeSingle(
      { object: "file_upload", id: "upload-1", status: "uploaded" },
      { id: "upload-1", status: "uploaded" }
    );
    const { uploadFile, notionStats } = await loadUpload();
    await expect(uploadFile(pdf)).resolves.toBe("upload-1");
    const uploadedRequests = notionStats().requests;
    expect(confirmGets(harness.calls)).toHaveLength(0);

    harness.restore();
    vi.resetModules();
    harness = installHarness();
    routeSingle(
      { object: "file_upload", id: "upload-1", status: "pending" },
      { id: "upload-1", status: "uploaded" }
    );
    const pending = await loadUpload();
    await expect(pending.uploadFile(pdf)).resolves.toBe("upload-1");
    expect(confirmGets(harness.calls)).toHaveLength(1);
    expect(pending.notionStats().requests - uploadedRequests).toBe(1);
  });

  it("pending なら確認 GET を呼ぶ", async () => {
    routeSingle(
      { object: "file_upload", status: "pending" },
      { id: "upload-1", status: "uploaded" }
    );
    const { uploadFile } = await loadUpload();
    await expect(uploadFile(pdf)).resolves.toBe("upload-1");
    expect(confirmGets(harness.calls)).toHaveLength(1);
  });

  it("status が無い応答は確認 GET に回す", async () => {
    routeSingle({}, { id: "upload-1", status: "uploaded" });
    const { uploadFile } = await loadUpload();
    await expect(uploadFile(pdf)).resolves.toBe("upload-1");
    expect(confirmGets(harness.calls)).toHaveLength(1);
  });

  it("JSON でない send 応答は確認 GET に回す", async () => {
    routeSingle(
      new Response("<html>edge</html>", { status: 200, headers: { "content-type": "text/html" } }),
      { id: "upload-1", status: "uploaded" }
    );
    const { uploadFile } = await loadUpload();
    await expect(uploadFile(pdf)).resolves.toBe("upload-1");
    expect(confirmGets(harness.calls)).toHaveLength(1);
  });

  it("uploaded 以外の大文字小文字は確認 GET に回す", async () => {
    routeSingle(
      { status: "Uploaded" },
      { id: "upload-1", status: "uploaded" }
    );
    const { uploadFile } = await loadUpload();
    await expect(uploadFile(pdf)).resolves.toBe("upload-1");
    expect(confirmGets(harness.calls)).toHaveLength(1);
  });

  it("failed は throw して添付せず、後続 GET が uploaded でも採用しない", async () => {
    routeSingle(
      { object: "file_upload", status: "failed" },
      { id: "upload-1", status: "uploaded" }
    );
    const { uploadFile } = await loadUpload();
    await expect(uploadFile(pdf)).rejects.toThrow(/status=failed≠uploaded[\s\S]*添付しない/);
    expect(confirmGets(harness.calls)).toHaveLength(0);
  });

  it("expired は throw して添付しない", async () => {
    routeSingle(
      { status: "expired" },
      { id: "upload-1", status: "uploaded" }
    );
    const { uploadFile } = await loadUpload();
    await expect(uploadFile(pdf)).rejects.toThrow(/status=expired≠uploaded/);
    expect(confirmGets(harness.calls)).toHaveLength(0);
  });

  it("send の HTTP 400 は確認 GET に落とさず throw する", async () => {
    routeSingle(
      new Response(
        JSON.stringify({ object: "error", code: "validation_error", message: "rejected" }),
        { status: 400, headers: { "content-type": "application/json" } }
      )
    );
    const { uploadFile } = await loadUpload();
    await expect(uploadFile(pdf)).rejects.toThrow(/Notion API エラー/);
    expect(confirmGets(harness.calls)).toHaveLength(0);
  });

  it("multi_part は complete が uploaded なら確認 GET を省く", async () => {
    const bytes = new Uint8Array(20 * 1024 * 1024 + 1);
    bytes[0] = 1;
    const parts = Math.ceil(bytes.length / (10 * 1024 * 1024));
    harness.route("GET", "api.notion.com/v1/users/me", [
      { bot: { workspace_limits: { max_file_upload_size_in_bytes: 5_368_709_120 } } },
    ]);
    harness.route("POST", "api.notion.com/v1/file_uploads", [
      { id: "upload-1", status: "pending" },
    ]);
    harness.route(
      "POST",
      "api.notion.com/v1/file_uploads/upload-1/send",
      Array.from({ length: parts }, () => ({ status: "pending" }))
    );
    harness.route("POST", "api.notion.com/v1/file_uploads/upload-1/complete", [
      { object: "file_upload", id: "upload-1", status: "uploaded" },
    ]);
    harness.route("GET", "api.notion.com/v1/file_uploads/upload-1", [
      { id: "upload-1", status: "uploaded" },
    ]);
    const { uploadFile, notionStats } = await loadUpload();
    const before = notionStats().requests;
    await expect(
      uploadFile({ bytes, filename: "big.pdf", contentType: "application/pdf" })
    ).resolves.toBe("upload-1");
    expect(confirmGets(harness.calls)).toHaveLength(0);
    // users/me + create + send*parts + complete。確認 GET は含まない。
    expect(notionStats().requests - before).toBe(3 + parts);
  });

  it("multi_part の complete が pending なら確認 GET を呼ぶ", async () => {
    const bytes = new Uint8Array(20 * 1024 * 1024 + 1);
    bytes[0] = 1;
    const parts = Math.ceil(bytes.length / (10 * 1024 * 1024));
    harness.route("GET", "api.notion.com/v1/users/me", [
      { bot: { workspace_limits: { max_file_upload_size_in_bytes: 5_368_709_120 } } },
    ]);
    harness.route("POST", "api.notion.com/v1/file_uploads", [
      { id: "upload-1", status: "pending" },
    ]);
    harness.route(
      "POST",
      "api.notion.com/v1/file_uploads/upload-1/send",
      Array.from({ length: parts }, () => ({ status: "pending" }))
    );
    harness.route("POST", "api.notion.com/v1/file_uploads/upload-1/complete", [
      { status: "pending" },
    ]);
    harness.route("GET", "api.notion.com/v1/file_uploads/upload-1", [
      { id: "upload-1", status: "uploaded" },
    ]);
    const { uploadFile } = await loadUpload();
    await expect(
      uploadFile({ bytes, filename: "big.pdf", contentType: "application/pdf" })
    ).resolves.toBe("upload-1");
    expect(confirmGets(harness.calls)).toHaveLength(1);
  });

  it("multi_part の complete が JSON でなければ確認 GET に回す", async () => {
    const bytes = new Uint8Array(20 * 1024 * 1024 + 1);
    bytes[0] = 1;
    const parts = Math.ceil(bytes.length / (10 * 1024 * 1024));
    harness.route("GET", "api.notion.com/v1/users/me", [
      { bot: { workspace_limits: { max_file_upload_size_in_bytes: 5_368_709_120 } } },
    ]);
    harness.route("POST", "api.notion.com/v1/file_uploads", [
      { id: "upload-1", status: "pending" },
    ]);
    harness.route(
      "POST",
      "api.notion.com/v1/file_uploads/upload-1/send",
      Array.from({ length: parts }, () => ({ status: "pending" }))
    );
    harness.route("POST", "api.notion.com/v1/file_uploads/upload-1/complete", [
      new Response("not-json", { status: 200, headers: { "content-type": "text/plain" } }),
    ]);
    harness.route("GET", "api.notion.com/v1/file_uploads/upload-1", [
      { id: "upload-1", status: "uploaded" },
    ]);
    const { uploadFile } = await loadUpload();
    await expect(
      uploadFile({ bytes, filename: "big.pdf", contentType: "application/pdf" })
    ).resolves.toBe("upload-1");
    expect(confirmGets(harness.calls)).toHaveLength(1);
  });

  it("multi_part の complete が failed なら throw して添付しない", async () => {
    const bytes = new Uint8Array(20 * 1024 * 1024 + 1);
    bytes[0] = 1;
    const parts = Math.ceil(bytes.length / (10 * 1024 * 1024));
    harness.route("GET", "api.notion.com/v1/users/me", [
      { bot: { workspace_limits: { max_file_upload_size_in_bytes: 5_368_709_120 } } },
    ]);
    harness.route("POST", "api.notion.com/v1/file_uploads", [
      { id: "upload-1", status: "pending" },
    ]);
    harness.route(
      "POST",
      "api.notion.com/v1/file_uploads/upload-1/send",
      Array.from({ length: parts }, () => ({ status: "pending" }))
    );
    harness.route("POST", "api.notion.com/v1/file_uploads/upload-1/complete", [
      { status: "failed" },
    ]);
    harness.route("GET", "api.notion.com/v1/file_uploads/upload-1", [
      { id: "upload-1", status: "uploaded" },
    ]);
    const { uploadFile } = await loadUpload();
    await expect(
      uploadFile({ bytes, filename: "big.pdf", contentType: "application/pdf" })
    ).rejects.toThrow(/status=failed≠uploaded/);
    expect(confirmGets(harness.calls)).toHaveLength(0);
  });
});

describe("適時開示 1 件の Notion 呼び出し", () => {
  const ORIG_ENV = { ...process.env };
  let harness: ReturnType<typeof installHarness>;

  beforeEach(() => {
    process.env.NOTION_TOKEN = "dummy-token";
    process.env.NOTION_ARCHIVE_PAGE_ID = ARCHIVE_PAGE;
    vi.resetModules();
    harness = installHarness();
  });

  afterEach(() => {
    harness.restore();
    process.env = { ...ORIG_ENV };
    vi.resetModules();
  });

  it("uploaded でも readback は呼ばれ、確認 GET は 0 回、ログに件数が出る", async () => {
    const service = "ir-confirm";
    const parentDb = "parent-db";
    const stockPage = "stock-page";
    const childDb = "child-db";
    const pageId = "written-page";
    const filename = "1001_2026-01-15_T1.pdf";
    harness.route("POST", "api.notion.com/v1/search", [
      {
        results: [
          {
            id: parentDb,
            object: "database",
            created_time: "2026-01-01T00:00:00.000Z",
            parent: { type: "page_id", page_id: ARCHIVE_PAGE },
            title: [{ plain_text: `銘柄一覧｜${service}` }],
          },
        ],
        has_more: false,
        next_cursor: null,
      },
    ]);
    harness.route("POST", `api.notion.com/v1/databases/${parentDb}/query`, [
      { results: [{ id: stockPage }], has_more: false, next_cursor: null },
    ]);
    harness.route("GET", `api.notion.com/v1/blocks/${stockPage}/children`, [
      {
        results: [
          {
            id: childDb,
            type: "child_database",
            child_database: { title: "適時開示｜1001" },
          },
        ],
        has_more: false,
        next_cursor: null,
      },
    ]);
    harness.route("GET", `api.notion.com/v1/databases/${childDb}`, [
      {
        is_inline: true,
        properties: {
          開示表題: { type: "title" },
          タグ: { type: "multi_select" },
          代表タグ: { type: "select" },
          IR発表日: { type: "date" },
          市場: { type: "rich_text" },
          資料: { type: "url" },
          IR資料: { type: "files" },
          IR資料状態: { type: "select" },
          PDF判定: { type: "select" },
          "TDnet ID": { type: "rich_text" },
        },
      },
    ]);
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
    harness.route("GET", "api.notion.com/v1/file_uploads/upload-1", [
      { id: "upload-1", status: "uploaded" },
    ]);
    harness.route("POST", "api.notion.com/v1/pages", [{ id: pageId }]);
    harness.route("GET", `api.notion.com/v1/pages/${pageId}`, [
      {
        properties: {
          IR資料: {
            type: "files",
            files: [
              {
                name: filename,
                type: "file",
                file: { url: "https://files.example.test/hosted.pdf" },
              },
            ],
          },
        },
      },
    ]);
    harness.route("GET", "files.example.test/hosted.pdf", [
      new Response(PDF.slice(), { status: 200, headers: { "content-type": "application/pdf" } }),
    ]);

    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const { upsertDisclosuresByStock } = await import("./dataset.js");
      const persisted = vi.fn();
      const result = await upsertDisclosuresByStock({
        service,
        tagOptions: [],
        rows: [
          {
            key: "T1",
            ticker: "1001",
            companyName: "試験",
            companyUrl: "https://example.test",
            tags: [],
            primaryTag: null,
            pubdate: "2026-01-15T01:02:03.000Z",
            title: "試験開示",
            documentUrl: "https://tdnet.example.test/1.pdf",
            markets: null,
          },
        ],
        onPagePersisted: persisted,
      });
      expect(result.created).toBe(1);
      expect(persisted).toHaveBeenCalledWith("T1", pageId);
      const hosted = harness.calls.filter((c) => c.url.includes("files.example.test/hosted.pdf"));
      expect(hosted).toHaveLength(1);
      expect(confirmGets(harness.calls)).toHaveLength(0);
      const pdfAt = harness.calls.findIndex((c) => c.url.includes("tdnet.example.test/1.pdf"));
      const notionAfterPdf = harness.calls.slice(pdfAt + 1).filter((c) => {
        return new URL(c.url).hostname === "api.notion.com";
      });
      const line = info.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes("notion-calls") && l.includes("tdnetId=T1"));
      expect(line).toBeDefined();
      expect(line).toContain(`requests=${notionAfterPdf.length}`);
      expect(line).toContain("outcome=ok");
      expect(notionAfterPdf.length).toBe(5);
    } finally {
      info.mockRestore();
    }
  });
});
