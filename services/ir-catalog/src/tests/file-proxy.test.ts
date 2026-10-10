import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../db/client.js";
import { listPageFiles } from "../../../../src/shared/notion-archive/index.js";
import { notionRequest } from "../../../../src/shared/notion-archive/client.js";
import { pagesRoute } from "../routes/pages.js";
import { downloadPdf, IR_PDF_LIMIT, jpxPdfUrl } from "../services/official-pdf.js";

vi.mock("../db/client.js", () => ({ createDb: vi.fn() }));
vi.mock("../../../../src/shared/notion-archive/index.js", () => ({ listPageFiles: vi.fn() }));
vi.mock("../../../../src/shared/notion-archive/client.js", () => ({ notionRequest: vi.fn() }));

const catalog = "https://webapi.yanoshin.jp/webapi/tdnet/redirect/document/1274696";
const tdnet = "https://release.tdnet.info/inbs/140120260810517386.pdf";
const jpx = "https://www2.jpx.co.jp/disc/55990/140120260810517386.pdf";
const body = "%PDF-contract-fixture-only";
function response(url: string, status: number, text = "") {
  return Object.defineProperty(new Response(text, { status }), "url", { value: url });
}
function headerText(headers: Headers) {
  const entries: [string, string][] = [];
  headers.forEach((value, key) => entries.push([key, value]));
  return JSON.stringify(entries);
}

describe("same-disclosure PDF source and unavailable provenance", () => {
  beforeEach(() => {
    const query = { select: vi.fn(), from: vi.fn(), where: vi.fn(), limit: vi.fn() };
    query.select.mockReturnValue(query); query.from.mockReturnValue(query); query.where.mockReturnValue(query);
    query.limit.mockResolvedValue([{ documentUrl: catalog, notionPageId: "archived-page", companyCode: "55990",
      pubdate: new Date("2026-08-12T06:00:00Z") }]);
    vi.mocked(createDb).mockReturnValue(query as unknown as ReturnType<typeof createDb>);
    vi.mocked(listPageFiles).mockReset().mockResolvedValue([]);
    vi.mocked(notionRequest).mockReset().mockResolvedValue({ properties: {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uses the observed official filename at the same issuer and retains catalog failure", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(tdnet, 404)).mockResolvedValueOnce(response(jpx, 200, body));
    vi.stubGlobal("fetch", fetcher);
    const result = await pagesRoute.request("https://kabulab-cf.satoki252595.workers.dev/file/1274696", {}, { DB: {} as D1Database });
    expect(result.status).toBe(200);
    expect(await result.text()).toBe(body);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([catalog, jpx]);
    expect(fetcher.mock.calls[1][1].redirect).toBe("manual");
    expect(result.headers.get("X-IR-Catalog-ID")).toBe("1274696");
    expect(result.headers.get("X-IR-Official-Document-ID")).toBe("140120260810517386");
    expect(result.headers.get("X-IR-Source-URL")).toBe(jpx);
    expect(result.headers.get("X-IR-Source")).toBe("jpx");
    expect(result.headers.get("X-IR-Published-At")).toBe("2026-08-12T06:00:00.000Z");
    expect(result.headers.get("X-IR-PDF-Bytes")).toBe(String(new TextEncoder().encode(body).length));
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))),
      (value) => value.toString(16).padStart(2, "0")).join("");
    expect(result.headers.get("X-IR-PDF-SHA256")).toBe(sha);
    expect(JSON.parse(result.headers.get("X-IR-Attempts")!)).toEqual([
      { source: "notion_archive", code: "attachment_unavailable" },
      { source: "catalog", code: "http_error", httpStatus: 404 }]);
  });

  it("keeps the archive primary and never exposes its signed URL", async () => {
    vi.mocked(listPageFiles).mockResolvedValue([{ url: "https://archive.example.test/file?signature=secret", name: "saved.pdf", kind: "file" }]);
    vi.stubGlobal("fetch", vi.fn(async () => response("https://archive.example.test/file?signature=secret", 200, body)));
    const result = await pagesRoute.request("https://kabulab-cf.satoki252595.workers.dev/file/1274696", {}, { DB: {} as D1Database });
    expect(result.headers.get("X-IR-Source")).toBe("notion_archive");
    expect(result.headers.get("X-IR-Source-URL")).toBe("https://kabulab-cf.satoki252595.workers.dev/ir-catalog/file/1274696");
    expect(headerText(result.headers)).not.toContain("signature");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["external", "multiple"])("%s is never promoted to a hosted archive", async (failure) => {
    const file = { url: "https://archive.example.test/file?signature=secret", name: "saved.pdf", kind: "file" as const };
    vi.mocked(listPageFiles).mockResolvedValue(failure === "external" ? [{ ...file, kind: "external" }] : [file, file]);
    const fetcher = vi.fn().mockResolvedValueOnce(response(tdnet, 404)).mockResolvedValueOnce(response(jpx, 200, body));
    vi.stubGlobal("fetch", fetcher);
    const result = await pagesRoute.request("https://kabulab-cf.satoki252595.workers.dev/file/1274696", {}, { DB: {} as D1Database });
    expect(result.headers.get("X-IR-Source")).toBe("jpx");
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([catalog, jpx]);
    expect(JSON.parse(result.headers.get("X-IR-Attempts")!)[0].code).toBe("archive_not_hosted_single");
  });

  it.each(["valid", "hash", "alias"])("reads back the saved JPX origin without promoting a changed hash or catalog alias (%s)", async (failure) => {
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))),
      (value) => value.toString(16).padStart(2, "0")).join("");
    const origin = { schema: "ir-pdf-archive-provenance-v1", catalogId: failure === "alias" ? "1274695" : "1274696", companyCode: "55990",
      publishedAt: "2026-08-12T06:00:00.000Z", source: "jpx", sourceUrl: jpx,
      officialDocumentId: "140120260810517386", retrievedAt: "2026-08-13T06:00:00.000Z",
      pdfSha256: failure === "hash" ? "0".repeat(64) : sha, pdfBytes: new TextEncoder().encode(body).byteLength };
    vi.mocked(listPageFiles).mockResolvedValue([{ url: "https://archive.example.test/file?signature=secret", name: "saved.pdf", kind: "file" }]);
    vi.mocked(notionRequest).mockResolvedValue({ properties: { IR取得来歴: {
      type: "rich_text", rich_text: [{ plain_text: JSON.stringify(origin) }] } } });
    vi.stubGlobal("fetch", vi.fn(async () => response("https://archive.example.test/file?signature=secret", 200, body)));
    const result = await pagesRoute.request("https://kabulab-cf.satoki252595.workers.dev/file/1274696", {}, { DB: {} as D1Database });
    expect(result.status).toBe(failure === "valid" ? 200 : 502);
    if (failure === "hash") expect(JSON.parse(result.headers.get("X-IR-Attempts")!)[0].code).toBe("archive_provenance_invalid");
    else if (failure === "alias") {
      expect(result.headers.get("X-IR-Archive-Catalog-ID")).toBe("1274695");
      expect(JSON.parse(result.headers.get("X-IR-Attempts")!)[0].code).toBe("archive_catalog_alias");
    }
    else expect(JSON.parse(result.headers.get("X-IR-Archive-Provenance")!)).toEqual(origin);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([jpx.replace("/55990/", "/43980/"), jpx + "?signature=private"])("refuses unsafe catalog source %s without exposing it", async (url) => {
    vi.stubGlobal("fetch", vi.fn(async () => response(url, 200, body)));
    const result = await pagesRoute.request("https://kabulab-cf.satoki252595.workers.dev/file/1274696", {}, { DB: {} as D1Database });
    expect(result.status).toBe(502);
    const failed = await result.json();
    expect(failed).toMatchObject({ status: "unavailable", error: "ir_pdf_source_invalid", tdnetId: "1274696" });
    expect(JSON.stringify(failed)).not.toContain("signature");
    expect(headerText(result.headers)).not.toContain("signature");
  });

  it("retains a transient archive lookup failure in the safe failure headers", async () => {
    vi.mocked(listPageFiles).mockRejectedValue(new Error("private failure details"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(tdnet, 404)).mockResolvedValueOnce(response(jpx, 404)));
    const result = await pagesRoute.request("https://kabulab-cf.satoki252595.workers.dev/file/1274696", {}, { DB: {} as D1Database });
    expect(result.status).toBe(502);
    expect(result.headers.get("X-IR-Status")).toBe("transient");
    expect(JSON.parse(result.headers.get("X-IR-Attempts")!)).toEqual([
      { source: "notion_archive", code: "archive_lookup_failed" },
      { source: "catalog", code: "http_error", httpStatus: 404 },
      { source: "jpx", code: "http_error", httpStatus: 404 }]);
    expect(await result.text()).not.toContain("private failure details");
  });

  it.each(["missing_id", "wrong_issuer", "both_absent", "not_pdf", "jpx_redirect"])("%s stays unavailable without invented IDs or old results", async (failure) => {
    const firstUrl = failure === "missing_id" ? catalog : failure === "wrong_issuer"
      ? "https://www2.jpx.co.jp/disc/43980/140120260810517386.pdf" : tdnet;
    const fetcher = vi.fn().mockResolvedValueOnce(response(firstUrl, 404)).mockResolvedValueOnce(
      response(jpx, failure === "not_pdf" ? 200 : failure === "jpx_redirect" ? 302 : 404, "html"));
    vi.stubGlobal("fetch", fetcher);
    const result = await pagesRoute.request("https://kabulab-cf.satoki252595.workers.dev/file/1274696", {}, { DB: {} as D1Database });
    expect(result.status).toBe(502);
    expect(await result.json()).toMatchObject({ schema: "ir-pdf-provenance-v1", status: "unavailable", tdnetId: "1274696" });
    expect(result.headers.get("X-IR-Status")).toBe("unavailable");
    expect(result.headers.get("X-IR-Catalog-ID")).toBe("1274696");
    expect(JSON.parse(result.headers.get("X-IR-Attempts")!).some((item: {source: string}) => item.source === "catalog")).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(["missing_id", "wrong_issuer"].includes(failure) ? 1 : 2);
  });

  it("rejects oversized bodies and credential-bearing or unrelated official paths", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(IR_PDF_LIMIT + 1))));
    expect(await downloadPdf(tdnet, 1000)).toMatchObject({ status: "unavailable", code: "pdf_too_large" });
    for (const url of [catalog, tdnet + "?signature=secret", tdnet + "#part", tdnet.replace("https://", "https://user@"),
      "https://other.example.org/inbs/140120260810517386.pdf"])
      expect(jpxPdfUrl("55990", url)).toBeNull();
  });
});
