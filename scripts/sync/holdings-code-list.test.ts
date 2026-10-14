import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HoldingsCodeListBudgetError, readVerifiedHoldingsCodeList, resolveLatestHoldingsCodeList } from "./holdings-code-list.js";
import { findUniqueBackupChildByTitle } from "../../src/shared/notion-archive/archive.js";
import { notionRequest } from "../../src/shared/notion-archive/client.js";
import { downloadArchivedFile } from "../moneyflow/lib/archived-files.js";
import * as valuation from "../../services/yuho-quant/src/services/edinet/shareholdings-valuation.js";
import type { PriceFile } from "../../src/shared/holdings/price-registry.js";
vi.mock("../../src/shared/notion-archive/archive.js", () => ({ findUniqueBackupChildByTitle: vi.fn() }));
vi.mock("../../src/shared/notion-archive/client.js", () => ({ notionRequest: vi.fn() }));
vi.mock("../moneyflow/lib/archived-files.js", () => ({ downloadArchivedFile: vi.fn() }));
const hash = (body: Buffer | string) => createHash("sha256").update(body).digest("hex");
const zip = readFileSync(new URL("../../pipeline/tests/fixtures/edinet/Edinetcode.zip", import.meta.url));
const previous: PriceFile = { archivePageId: "a".repeat(32), filename: "old.zip", sha256: hash(zip), byteLength: zip.length };
const asOf = valuation.parseHoldingsCodeList({ ...previous, bytes: zip }).asOf;
const at = `${asOf}T12:00:00.000Z`, fetched = `${asOf}T11:00:00.000Z`;
const sourceUrl = "https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip";
const text = (value: string, type = "rich_text") => ({ type, [type]: [{ type: "text", plain_text: value, text: { content: value } }] });
const file = (filename: string, body: Buffer) => ({ originalFilename: filename, uploadFilename: filename, byteLength: body.length, sha256: hash(body), upload: "uploaded" });
const link = (name: string) => ({ name, type: "file", file: { url: `https://file.notion.so/${name}?signature=PRIVATE` } });
function generation() {
  // A structural capture manifest around the repository's unchanged actual FSA ZIP.
  const capture = { asOf, completedAt: `${asOf}T10:00:00+00:00`, listedRecords: 1, requestedAt: `${asOf}T09:59:00+00:00`,
    response: { finalUrl: sourceUrl, headers: {}, status: 200 }, sourceUrl, zipBytes: zip.length, zipSha256: hash(zip) };
  const key = `edinet-codelist-${asOf}-${hash(JSON.stringify(capture)).slice(0, 12)}`;
  const captureBytes = Buffer.from(JSON.stringify({ ...capture, key }));
  const code: PriceFile = { ...previous, archivePageId: "b".repeat(32), filename: "new.zip" };
  const metadata = { asOf, sha256: hash(zip), bytes: zip.length, completedAt: capture.completedAt,
    _fileManifest: { version: 1, inputFingerprint: "c".repeat(64), files: [file(code.filename, zip), file("capture-sector33-manifest.json", captureBytes)] } };
  const page = { object: "page", id: code.archivePageId, archived: false, in_trash: false, parent: { type: "database_id", database_id: "d".repeat(32) },
    properties: { Key: text(key, "title"), "Fetched At": { type: "date", date: { start: fetched } }, Status: { type: "select", select: { name: "recorded" } },
      Metadata: text(JSON.stringify(metadata)), Files: { type: "files", files: [link(code.filename), link("capture-sector33-manifest.json")] } } };
  return { code, page, metadata, capture, captureBytes };
}
function oldPage() {
  return { object: "page", id: previous.archivePageId, archived: false, in_trash: false, parent: { type: "database_id", database_id: "d".repeat(32) },
    properties: { Status: { type: "select", select: { name: "recorded" } },
      Metadata: text(JSON.stringify({ _fileManifest: { version: 1, inputFingerprint: "c".repeat(64), files: [file(previous.filename, zip)] } })),
      Files: { type: "files", files: [link(previous.filename)] } } };
}
let current: ReturnType<typeof generation>;
let queryRows: unknown[];
beforeEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks(); vi.stubEnv("NOTION_ARCHIVE_PAGE_ID", "1".repeat(32));
  current = generation(); queryRows = [current.page];
  vi.mocked(findUniqueBackupChildByTitle).mockResolvedValue("d".repeat(32));
  vi.mocked(notionRequest).mockImplementation(async (method, path) => method === "POST" ? { results: queryRows, has_more: false, next_cursor: null } :
    path.endsWith(previous.archivePageId) ? oldPage() : current.page as never);
  vi.mocked(downloadArchivedFile).mockImplementation(async input => input.name.endsWith(".zip") ? zip : current.captureBytes);
});
describe("通常保管済み公式銘柄表の更新", () => {
  it("latest ZIP+capture全文SHA・元key・実時計・CSV基準日を資格化し、旧原本もfresh確認する", async () => {
    expect(await resolveLatestHoldingsCodeList(previous, at)).toEqual({ status: "ready", file: current.code });
    expect(notionRequest).toHaveBeenCalledTimes(3); expect(downloadArchivedFile).toHaveBeenCalledTimes(3);
    expect(vi.mocked(notionRequest).mock.calls[0]).toEqual(["POST", `/databases/${"d".repeat(32)}/query`, {
      filter: { property: "Key", title: { starts_with: "edinet-codelist-" } }, sorts: [{ property: "Fetched At", direction: "descending" }], page_size: 2,
    }, { singleAttempt: true }]);
  });
  it("既snapshotと同じ原本ならfresh1回を両世代の同値証明として再利用する", async () => {
    expect(await resolveLatestHoldingsCodeList(current.code, at)).toMatchObject({ status: "ready" });
    expect(notionRequest).toHaveBeenCalledTimes(2); expect(downloadArchivedFile).toHaveBeenCalledTimes(2);
  });
  it("候補不在だけ明示HOLD、最新不完全を除外して古いrecordedへ戻さない", async () => {
    queryRows = []; expect(await resolveLatestHoldingsCodeList(previous, at)).toMatchObject({ status: "held" });
    const older = structuredClone(current.page); older.properties["Fetched At"].date.start = `${asOf}T08:00:00Z`;
    current.page.properties.Status.select.name = "file_too_large";
    queryRows = [current.page, older];
    await expect(resolveLatestHoldingsCodeList(previous, at)).rejects.toThrow("未完了");
    expect(downloadArchivedFile).not.toHaveBeenCalled();
  });
  it.each(["tie", "future", "wrong-page", "duplicate-files"])("%sは原本取得/送信前に停止する", async mode => {
    if (mode === "tie") queryRows = [current.page, structuredClone(current.page)];
    if (mode === "future") current.page.properties["Fetched At"].date.start = `${asOf}T13:00:00Z`;
    if (mode === "wrong-page") vi.mocked(notionRequest).mockImplementation(async method => method === "POST" ? { results: queryRows, has_more: false, next_cursor: null } : { ...current.page, id: "f".repeat(32) } as never);
    if (mode === "duplicate-files") current.page.properties.Files.files[1] = current.page.properties.Files.files[0];
    await expect(resolveLatestHoldingsCodeList(previous, at)).rejects.toThrow();
    expect(downloadArchivedFile).not.toHaveBeenCalled();
  });
  it.each(["capture-sha", "zip-sha", "source-url", "capture-key"])("%sを全文読戻しから検出し旧候補へ進まない", async mode => {
    if (mode === "capture-sha") vi.mocked(downloadArchivedFile).mockImplementation(async input => input.name.endsWith(".zip") ? zip : Buffer.from("bad capture"));
    if (mode === "zip-sha") vi.mocked(downloadArchivedFile).mockResolvedValue(Buffer.from("bad ZIP"));
    if (mode === "source-url" || mode === "capture-key") {
      const body = JSON.parse(current.captureBytes.toString("utf8"));
      if (mode === "source-url") body.sourceUrl += "/different"; else body.listedRecords++;
      current.captureBytes = Buffer.from(JSON.stringify(body));
      current.metadata._fileManifest.files[1] = file("capture-sector33-manifest.json", current.captureBytes);
      current.page.properties.Metadata = text(JSON.stringify(current.metadata));
    }
    await expect(resolveLatestHoldingsCodeList(previous, at)).rejects.toThrow();
    expect(vi.mocked(notionRequest).mock.calls.some(([, path]) => path.endsWith(previous.archivePageId))).toBe(false);
  });
  it("基準日後退は選定停止（原ZIP parserの出力境界を故障注入）", async () => {
    const parse = valuation.parseHoldingsCodeList;
    vi.spyOn(valuation, "parseHoldingsCodeList").mockImplementation(source => ({ ...parse(source), asOf: source.filename === previous.filename ? "2099-01-01" : asOf }));
    await expect(resolveLatestHoldingsCodeList(previous, at)).rejects.toThrow("後退");
  });
  it("原本基準日が未来ならactivationへ進まない（parser/manifest同値の故障注入）", async () => {
    const parse = valuation.parseHoldingsCodeList;
    vi.spyOn(valuation, "parseHoldingsCodeList").mockImplementation(source => ({ ...parse(source), asOf: "2099-01-01" }));
    current.capture.asOf = "2099-01-01";
    const key = `edinet-codelist-2099-01-01-${hash(JSON.stringify(current.capture)).slice(0, 12)}`;
    current.captureBytes = Buffer.from(JSON.stringify({ ...current.capture, key }));
    current.metadata.asOf = "2099-01-01";
    current.metadata._fileManifest.files[1] = file("capture-sector33-manifest.json", current.captureBytes);
    current.page.properties.Metadata = text(JSON.stringify(current.metadata)); current.page.properties.Key = text(key, "title");
    await expect(resolveLatestHoldingsCodeList(previous, at)).rejects.toThrow("基準日が未来");
  });
  it("ZIP+capture合計予算を先に検査し不足ならhosted0、既単一ZIPは同じbytesを返す", async () => {
    await expect(readVerifiedHoldingsCodeList(current.code, zip.length)).rejects.toBeInstanceOf(HoldingsCodeListBudgetError);
    expect(downloadArchivedFile).not.toHaveBeenCalled();
    expect(await readVerifiedHoldingsCodeList(current.code, zip.length + current.captureBytes.length)).toMatchObject({ source: { bytes: zip }, readBytes: zip.length + current.captureBytes.length });
    expect(await readVerifiedHoldingsCodeList(previous, zip.length)).toMatchObject({ source: { bytes: zip }, asOf, readBytes: zip.length });
  }, 15_000); // Parse the full actual FSA ZIP twice even under parallel CI CPU load.
});
