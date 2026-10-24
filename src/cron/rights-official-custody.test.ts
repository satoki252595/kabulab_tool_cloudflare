/** One actual index row projection + actual same-date XLS; no source/Notion requests. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { collectOfficialRightsCustody } from "./rights-official-custody.js";
import { recordPrimaryData, verifyArchivedAttachments } from "../shared/notion-archive/index.js";
import { NotionUnknownResultError } from "../shared/notion-archive/client.js";
import { ScheduledSourceDeadlineError } from "../shared/scheduled-admission.js";
vi.mock("../shared/notion-archive/index.js", async original => ({ ...await original<typeof import("../shared/notion-archive/index.js")>(), recordPrimaryData: vi.fn(), verifyArchivedAttachments: vi.fn() }));
const indexUrl = "https://www.jpx.co.jp/listing/others/ex-rights/index.html";
const html = gunzipSync(readFileSync(new URL("../shared/jpx/__fixtures__/ex-rights-20261016/index.html.gz", import.meta.url))).toString("utf8");
const xls = readFileSync(new URL("../shared/jpx/__fixtures__/ex-rights-20261016/20261016.xls", import.meta.url));
// Exact first attachment row, declared subset for a 2-source transport test.
const firstTableRow = html.match(/<div class="component-file">[\s\S]*?<tr>([\s\S]*?)<\/tr>/)![1];
const oneVersion = html.replace(/<div class="component-file">[\s\S]*?<\/div>/, `<div class="component-file"><table><tr>${firstTableRow}</tr></table></div>`);
let send: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetAllMocks();
  // Transport-only env values; the actual archive functions are replaced, not called.
  vi.stubEnv("NOTION_TOKEN", "transport-only-test"); vi.stubEnv("NOTION_ARCHIVE_PAGE_ID", "364d74ff84cd81a1838bd973ac329270"); vi.stubEnv("JPX_EX_RIGHTS_URL", indexUrl);
  send = vi.fn(async (url: string) => url === indexUrl ? new Response(oneVersion, { headers: { "content-type": "text/html" } }) : new Response(xls, { headers: { "content-type": "application/vnd.ms-excel" } }));
  vi.stubGlobal("fetch", send);
  vi.mocked(recordPrimaryData).mockResolvedValue({ pageId: "3fcd74ff-84cd-819a-9f7a-f168e6f599b6", outcome: "recorded", fileTooLarge: false, manifestMatch: "written" });
  vi.mocked(verifyArchivedAttachments).mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("同日訂正は新SHA、元HTML/XLS/manifestをcommon archiveで物理照合するだけ", async () => {
  const first = await collectOfficialRightsCustody("2026-10-17");
  expect(first).toMatchObject({ status: "retained", reason: "custody-only", financialQualification: "unqualified", sourceCount: 2, physicalVerified: true });
  expect(send).toHaveBeenCalledTimes(2);
  const archived = vi.mocked(recordPrimaryData).mock.calls[0][0];
  expect(archived).toMatchObject({ service: "universe", source: indexUrl, requireExistingDatabase: true, force: false });
  const files = archived.files!; expect(files).toHaveLength(3);
  expect(Buffer.from(files[1].bytes)).toEqual(xls);
  expect(verifyArchivedAttachments).toHaveBeenCalledWith(first.archivePageId, files, expect.any(String));
  const manifest = JSON.parse(new TextDecoder().decode(files[2].bytes));
  expect(manifest).toMatchObject({ financialQualification: "unqualified", eventParsing: "not-performed", shareClass: "unqualified", ratio: null, legalEffectiveDate: null });
  expect((await collectOfficialRightsCustody("2026-10-17")).archiveKey).toBe(first.archiveKey);
  send.mockImplementationOnce(async () => new Response(oneVersion + "\n", { headers: { "content-type": "text/html" } }));
  const corrected = await collectOfficialRightsCustody("2026-10-17");
  expect(corrected.archiveKey).not.toBe(first.archiveKey);
});

it("取得失敗の実bodyもlossless保管しsource incompleteのまま、次XLSを送らない", async () => {
  send.mockImplementationOnce(async () => new Response(oneVersion, { status: 429, headers: { "content-type": "text/html" } }));
  const result = await collectOfficialRightsCustody("2026-10-17");
  expect(result).toMatchObject({ status: "incomplete", reason: "source", sourceCount: 1, completeSources: 0, physicalVerified: true });
  const files = vi.mocked(recordPrimaryData).mock.calls[0][0].files!;
  expect(gunzipSync(files[0].bytes).toString()).toBe(oneVersion); expect(send).toHaveBeenCalledTimes(1);
});

it("新source期限で次XLSを送らず、取得済みindexを不完全原本として物理保管する", async () => {
  let count = 0;
  const guard = () => { if (++count > 1) throw new ScheduledSourceDeadlineError("source deadline"); };
  const result = await collectOfficialRightsCustody("2026-10-17", guard);
  expect(result).toMatchObject({ status: "incomplete", reason: "source", physicalVerified: true });
  expect(send).toHaveBeenCalledTimes(1); expect(recordPrimaryData).toHaveBeenCalledTimes(1);
  const files = vi.mocked(recordPrimaryData).mock.calls[0][0].files!;
  expect(Buffer.from(files[0].bytes).toString()).toBe(oneVersion);
  expect(JSON.parse(new TextDecoder().decode(files.at(-1)!.bytes))).toMatchObject({ complete: false,
    sources: [expect.objectContaining({ complete: true }), expect.objectContaining({ failure: "not-started", retainedBytes: null })] });
});

it("config欠測は取得0、index不明は原本保持、archive unknownは同run再送0", async () => {
  vi.stubEnv("JPX_EX_RIGHTS_URL", ""); expect(await collectOfficialRightsCustody("2026-10-17")).toMatchObject({ status: "incomplete", reason: "configuration", sourceCount: 0 }); expect(send).not.toHaveBeenCalled();
  vi.stubEnv("JPX_EX_RIGHTS_URL", indexUrl);
  send.mockImplementationOnce(async () => new Response(oneVersion.replace("component-file", "other-file"), { headers: { "content-type": "text/html" } }));
  expect(await collectOfficialRightsCustody("2026-10-17")).toMatchObject({ status: "incomplete", reason: "index-shape", physicalVerified: true });
  vi.mocked(recordPrimaryData).mockRejectedValueOnce(new NotionUnknownResultError("POST /pages transport test"));
  expect(await collectOfficialRightsCustody("2026-10-17")).toMatchObject({ status: "incomplete", reason: "archive-unknown", physicalVerified: false }); expect(recordPrimaryData).toHaveBeenCalledTimes(2);
});
