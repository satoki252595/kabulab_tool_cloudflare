import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {readFileSync} from "node:fs";
import {gunzipSync} from "node:zlib";
import {observeDocuments} from "../services/edinet/client.js";
import {captureListSnapshot, readListSnapshot, EdinetListQualificationError} from "../services/edinet/list-snapshot.js";
import {recordPrimaryData, listPageFiles, verifyArchivedAttachments} from "../../../../src/shared/notion-archive/index.js";

vi.mock("../services/edinet/client.js", () => ({observeDocuments: vi.fn()}));
vi.mock("../../../../src/shared/notion-archive/index.js", () => ({
  recordPrimaryData: vi.fn(), listPageFiles: vi.fn(), verifyArchivedAttachments: vi.fn(),
}));
const fixture = JSON.parse(readFileSync(new URL("../../../../tests/fixtures/edinet-null-sec-code-476A.json", import.meta.url), "utf8"));
const pageId = "00000000-0000-4000-8000-000000000001";
let raw: Uint8Array<ArrayBuffer>;
beforeEach(() => {
  vi.resetAllMocks();
  // 文書は公式実測fixture。envelope/添付通信だけを構造テスト用に差し替える。
  raw = new TextEncoder().encode(JSON.stringify({metadata: {parameter: {date: fixture.sourceDate, type: "2"},
    status: "200", message: "OK", resultset: {count: 1}}, results: [fixture.primary]}, null, 2));
  vi.mocked(observeDocuments).mockResolvedValue({date: fixture.sourceDate,
    fetchedAt: "2026-10-04T00:00:00.000Z", bytes: raw,
    httpStatus: 200});
  vi.mocked(recordPrimaryData).mockResolvedValue({pageId, outcome: "recorded", manifestMatch: "match"} as never);
  vi.mocked(verifyArchivedAttachments).mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe("EDINET original list snapshot", () => {
  it("型付けで落ちるenvelopeと空白も含め原HTTP全bytesをgzip物理保管し、同snapshotから復元", async () => {
    const {snapshot, list} = await captureListSnapshot(fixture.sourceDate);
    const file = vi.mocked(recordPrimaryData).mock.calls[0][0].files![0];
    expect(new Uint8Array(gunzipSync(file.bytes))).toEqual(raw);
    expect(verifyArchivedAttachments).toHaveBeenCalledWith(pageId, [file], "EDINET日付一覧");
    vi.mocked(listPageFiles).mockResolvedValue([{kind: "file", name: file.filename, url: "https://www.notion.so/"}] as never);
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(file.bytes)));
    vi.stubGlobal("fetch", fetchMock);
    expect(await readListSnapshot(snapshot)).toEqual(list);
    expect(observeDocuments).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("https://www.notion.so/", expect.objectContaining({redirect: "manual"}));
    const corrupted = {...snapshot, rawSha256: "0".repeat(64)};
    await expect(readListSnapshot(corrupted)).rejects.toThrow("bytes/SHA");
  });
  it("実取得dateと原metadataが異なっても原応答全bytesを保管後に資格拒否", async () => {
    await expect(captureListSnapshot("2026-10-04")).rejects.toThrow("資格未成立");
    expect(recordPrimaryData).toHaveBeenCalledTimes(1);
    expect(verifyArchivedAttachments).toHaveBeenCalledTimes(1);
  });
  it("全文readback未完はsnapshotを返さない", async () => {
    vi.mocked(verifyArchivedAttachments).mockRejectedValue(new Error("unknown readback"));
    await expect(captureListSnapshot(fixture.sourceDate)).rejects.toThrow("unknown readback");
  });
  it.each([403, 200])("HTTP/API/JSON資格未成立も受信済原bytesを物理保管する (%i)", async (httpStatus) => {
    const invalidRaw = new TextEncoder().encode("{");
    vi.mocked(observeDocuments).mockResolvedValue({date: fixture.sourceDate, httpStatus,
      fetchedAt: "2026-10-04T00:00:00.000Z", bytes: invalidRaw});
    let failure: unknown;
    try {await captureListSnapshot(fixture.sourceDate);} catch (error) {failure = error;}
    expect(failure).toBeInstanceOf(EdinetListQualificationError);
    expect((failure as EdinetListQualificationError).snapshot).toMatchObject({qualified: false, httpStatus});
    const file = vi.mocked(recordPrimaryData).mock.calls[0][0].files![0];
    expect(new Uint8Array(gunzipSync(file.bytes))).toEqual(invalidRaw);
    expect(verifyArchivedAttachments).toHaveBeenCalledTimes(1);
  });
});
