import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotionUnknownResultError, notionRequest } from "./client.js";
import { NotionConfigError } from "./env.js";
import { queryUniqueRow } from "./archive.js";
import { NotionFileTooLargeError, uploadFile } from "./file-upload.js";
import { verifyArchivedAttachments } from "./readback.js";

vi.mock("./client.js", async (original) => ({ ...await original<typeof import("./client.js")>(), notionRequest: vi.fn() }));
vi.mock("./env.js", async (original) => ({ ...await original<typeof import("./env.js")>(), notionEnv: { NOTION_ARCHIVE_PAGE_ID: () => "a".repeat(32) } }));
vi.mock("./archive.js", () => ({ findBackupChildByTitle: vi.fn(async () => "parent"), queryUniqueRow: vi.fn() }));
vi.mock("./file-upload.js", async (original) => ({ ...await original<typeof import("./file-upload.js")>(), uploadFile: vi.fn() }));
vi.mock("./readback.js", () => ({ verifyArchivedAttachments: vi.fn() }));

const propertyNames = ["開示表題", "タグ", "代表タグ", "IR発表日", "市場", "資料", "IR資料", "IR資料状態", "PDF判定", "TDnet ID"];
const row = { key: "T1", ticker: "1001", companyName: "試験", companyUrl: "https://example.test", tags: [], primaryTag: null, pubdate: new Date().toISOString(), title: "試験開示", documentUrl: "https://example.test/1.pdf", markets: null };

describe("適時開示の未知送信は次行の取得を停止", () => {
  let pageError: Error | null;
  beforeEach(() => {
    vi.resetModules();
    pageError = new NotionUnknownResultError("page outcome unknown");
    vi.mocked(queryUniqueRow).mockReset().mockResolvedValue({ id: "stock" } as never);
    vi.mocked(uploadFile).mockReset().mockResolvedValue("upload");
    vi.mocked(verifyArchivedAttachments).mockReset().mockResolvedValue(undefined);
    vi.mocked(notionRequest).mockReset().mockImplementation(async (method, path) => {
      if (method === "GET" && path.startsWith("/blocks/")) return { results: [{ id: "child", type: "child_database", child_database: { title: "適時開示｜1001" } }], has_more: false } as never;
      if (method === "GET") return { properties: Object.fromEntries(propertyNames.map((n) => [n, {}])), is_inline: true } as never;
      if (path.endsWith("/query")) return { results: [], has_more: false } as never;
      if (pageError !== null) throw pageError;
      return { id: "written" } as never;
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("%PDF-test", { headers: { "content-type": "application/pdf" } })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(["resolve", "upload", "page", "config", "resolve_generic", "upload_generic", "page_generic", "readback"])("%s の UNKNOWN/config は rowErrors に変換せず即伝播", async (phase) => {
    const failure = phase === "config" ? new NotionConfigError("invalid schema") : phase.endsWith("_generic") ? new Error("unknown transport failure") : new NotionUnknownResultError("result unknown");
    if (phase.startsWith("resolve") || phase === "config") vi.mocked(queryUniqueRow).mockRejectedValueOnce(failure);
    if (phase.startsWith("upload")) vi.mocked(uploadFile).mockRejectedValueOnce(failure);
    if (phase.startsWith("page")) pageError = failure;
    if (phase === "readback") {
      pageError = null;
      vi.mocked(verifyArchivedAttachments).mockRejectedValueOnce(failure);
    }
    const persisted = vi.fn();
    const { upsertDisclosuresByStock } = await import("./dataset.js");
    await expect(upsertDisclosuresByStock({ service: "test", tagOptions: [], rows: [row, { ...row, key: "T2", title: "試験開示2" }], onPagePersisted: persisted })).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledTimes(phase.startsWith("resolve") || phase === "config" ? 0 : 1);
    expect(queryUniqueRow).toHaveBeenCalledTimes(1);
    expect(persisted).not.toHaveBeenCalled();
  });

  it("ACK の後に同じ PDF 全 bytes を IR資料から読戻してから D1 callback を許可", async () => {
    pageError = null;
    const persisted = vi.fn();
    vi.mocked(verifyArchivedAttachments).mockImplementationOnce(async (page, files, _label, property) => {
      expect(page).toBe("written");
      expect(property).toBe("IR資料");
      expect(new TextDecoder().decode(files[0].bytes)).toBe("%PDF-test");
      expect(persisted).not.toHaveBeenCalled();
    });
    const { upsertDisclosuresByStock } = await import("./dataset.js");
    const result = await upsertDisclosuresByStock({ service: "test", tagOptions: [], rows: [row], onPagePersisted: persisted });
    expect(result.created).toBe(1);
    expect(persisted).toHaveBeenCalledWith("T1", "written");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("既存終端の page ID を源GETなしで呼出元へ返し、再開の参照欠けを解消する", async () => {
    const base = vi.mocked(notionRequest).getMockImplementation()!;
    vi.mocked(notionRequest).mockImplementation(async (method, path, body) => {
      if (path.endsWith("/query")) return {results: [{id: "existing", properties: {
        "TDnet ID": {rich_text: [{plain_text: row.key}]},
        "IR資料状態": {select: {name: "uploaded"}}, "IR資料": {files: [{name: "real.pdf"}]},
      }}], has_more: false} as never;
      return base(method, path, body);
    });
    const persisted = vi.fn();
    const { upsertDisclosuresByStock } = await import("./dataset.js");
    const result = await upsertDisclosuresByStock({service: "test", tagOptions: [], rows: [row], onPagePersisted: persisted});
    expect(result.skippedExisting).toBe(1);
    expect(persisted).toHaveBeenCalledWith("T1", "existing");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["recover", "rejudge"])("%s は単一の保管済み PDF を使い、発行元再取得・再添付をしない", async (mode) => {
    pageError = null;
    const base = vi.mocked(notionRequest).getMockImplementation()!;
    vi.mocked(notionRequest).mockImplementation(async (method, path, body) => {
      if (path.endsWith("/query")) return {results: [{id: "existing", properties: {
        "TDnet ID": {rich_text: [{plain_text: row.key}]},
        "IR資料状態": {select: {name: "uploaded"}}, "IR資料": {files: [{name: "real.pdf"}]},
      }}], has_more: false} as never;
      if (method === "GET" && path === "/pages/existing") return {properties: {"IR資料": {type: "files", files: [
        {name: "real.pdf", type: "file", file: {url: "https://archive.test/real.pdf"}},
      ]}}} as never;
      return base(method, path, body);
    });
    const classification = {sentiment: "unknown" as const, method: null, score: null, text: "保存済み本文"};
    const classified = vi.fn();
    const classifier = vi.fn(async (bytes: Uint8Array) => {
      expect(new TextDecoder().decode(bytes)).toBe("%PDF-test");
      return classification;
    });
    const { upsertDisclosuresByStock } = await import("./dataset.js");
    await upsertDisclosuresByStock({service: "test", tagOptions: [], rows: [row],
      classifyPdf: classifier, onPdfClassified: classified,
      rejudgePdf: mode === "rejudge", recoverPdfTextKeys: new Set([row.key])});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe("https://archive.test/real.pdf");
    expect(uploadFile).not.toHaveBeenCalled();
    expect(classified).toHaveBeenCalledWith(row.key, classification);
    expect(vi.mocked(notionRequest).mock.calls.filter(([m, p]) => m === "PATCH" && p === "/pages/existing")).toHaveLength(mode === "rejudge" ? 1 : 0);
  });

  it.each(["multiple", "external", "http", "non_pdf", "http_error", "redirect"])("保管済み PDF の %s は発行元へ切り替えず停止", async (failure) => {
    const base = vi.mocked(notionRequest).getMockImplementation()!;
    vi.mocked(notionRequest).mockImplementation(async (method, path, body) => {
      if (path.endsWith("/query")) return {results: [{id: "existing", properties: {
        "TDnet ID": {rich_text: [{plain_text: row.key}]},
        "IR資料状態": {select: {name: "uploaded"}}, "IR資料": {files: [{name: "real.pdf"}]},
      }}], has_more: false} as never;
      if (method === "GET" && path === "/pages/existing") {
        const file = failure === "external"
          ? {name: "real.pdf", type: "external", external: {url: "https://archive.test/real.pdf"}}
          : {name: "real.pdf", type: "file", file: {url: failure === "http" ? "http://archive.test/real.pdf" : "https://archive.test/real.pdf"}};
        return {properties: {"IR資料": {type: "files", files: failure === "multiple" ? [file, file] : [file]}}} as never;
      }
      return base(method, path, body);
    });
    if (failure === "non_pdf") vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid")));
    if (failure === "http_error") vi.stubGlobal("fetch", vi.fn(async () => new Response("", {status: 500})));
    if (failure === "redirect") vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {status: 302, headers: {location: row.documentUrl}})));
    const classified = vi.fn();
    const { upsertDisclosuresByStock } = await import("./dataset.js");
    await expect(upsertDisclosuresByStock({service: "test", tagOptions: [], rows: [row],
      classifyPdf: vi.fn(), onPdfClassified: classified, recoverPdfTextKeys: new Set([row.key])})).rejects.toThrow();
    expect(classified).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).startsWith("https://archive.test/"))).toBe(true);
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => options?.redirect === "manual")).toBe(true);
  });

  it("既知の PDF 不在は明示 skippedNoFile で保持する", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    const { upsertDisclosuresByStock } = await import("./dataset.js");
    const result = await upsertDisclosuresByStock({ service: "test", tagOptions: [], rows: [row] });
    expect(result.skippedNoFile).toBe(1);
    expect(result.created).toBe(0);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("既知の容量上限は未添付として保持する", async () => {
    vi.mocked(uploadFile).mockRejectedValueOnce(new NotionFileTooLargeError("test.pdf", 2, 1));
    const { upsertDisclosuresByStock } = await import("./dataset.js");
    const result = await upsertDisclosuresByStock({ service: "test", tagOptions: [], rows: [row] });
    expect(result.skippedNoFile).toBe(1);
    expect(result.created).toBe(0);
  });

  it("入力が新しくても、公開が古い開示から取得する", async () => {
    pageError = null;
    const older = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const newer = new Date(Date.now() - 86_400_000).toISOString();
    const base = vi.mocked(notionRequest).getMockImplementation()!;
    vi.mocked(notionRequest).mockImplementation(async (method, path, body) => {
      if (method === "GET" && path.startsWith("/blocks/")) {
        return {
          results: [
            { id: "child-a", type: "child_database", child_database: { title: "適時開示｜1001" } },
            { id: "child-b", type: "child_database", child_database: { title: "適時開示｜1002" } },
          ],
          has_more: false,
        } as never;
      }
      return base(method, path, body);
    });
    const { upsertDisclosuresByStock } = await import("./dataset.js");
    await upsertDisclosuresByStock({
      service: "order-test",
      tagOptions: [],
      rows: [
        { ...row, key: "NEW", ticker: "1001", pubdate: newer, title: "新しい開示", documentUrl: "https://example.test/new.pdf" },
        { ...row, key: "OLD", ticker: "1002", pubdate: older, title: "古い開示", documentUrl: "https://example.test/old.pdf" },
      ],
    });
    expect(vi.mocked(fetch).mock.calls.map((call) => String(call[0]))).toEqual([
      "https://example.test/old.pdf",
      "https://example.test/new.pdf",
    ]);
  });

  it("予算切れの残りは件数と tdnetId を残し、未取得の行を unavailable にしない", async () => {
    const older = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const newer = new Date(Date.now() - 86_400_000).toISOString();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { upsertDisclosuresByStock } = await import("./dataset.js");
      const result = await upsertDisclosuresByStock({
        service: "deadline-test",
        tagOptions: [],
        deadlineMs: 0,
        rows: [
          { ...row, key: "NEW", pubdate: newer, title: "新しい開示" },
          { ...row, key: "OLD", pubdate: older, title: "古い開示" },
        ],
      });
      expect(result.reachedDeadline).toBe(true);
      expect(result.deadlineRemainderKeys).toEqual(["OLD", "NEW"]);
      expect(result.created).toBe(0);
      expect(result.skippedNoFile).toBe(0);
      expect(fetch).not.toHaveBeenCalled();
      expect(queryUniqueRow).not.toHaveBeenCalled();
      const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain("[INC-20261008-kabulab_tool_cloudflare-ir-pdf-502] deadline-remainder count=2");
      expect(logged).toContain("tdnetIds=OLD,NEW");
    } finally {
      warn.mockRestore();
    }
  });

  it("31日を超えても取得を試み、404 の tdnetId を記録する", async () => {
    const pubdate = new Date(Date.now() - 32 * 86_400_000).toISOString();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { upsertDisclosuresByStock } = await import("./dataset.js");
      const result = await upsertDisclosuresByStock({
        service: "purge-test",
        tagOptions: [],
        rows: [{ ...row, key: "OLD404", pubdate, title: "32日前の開示" }],
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(result.skippedNoFile).toBe(1);
      expect(result.skippedNoFileKeys).toEqual(["OLD404"]);
      expect(result.created).toBe(0);
      const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain("[INC-20261008-kabulab_tool_cloudflare-ir-pdf-502] skippedNoFile count=1");
      expect(logged).toContain("tdnetIds=OLD404");
    } finally {
      warn.mockRestore();
    }
  });
});
