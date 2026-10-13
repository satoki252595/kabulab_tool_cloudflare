import { beforeEach, describe, expect, it, vi } from "vitest";
import { findCanonicalRawFiles, parseCanonicalRawFile } from "./raw-files.js";
import { notionRequest } from "./client.js";
vi.mock("./client.js", () => ({ notionRequest: vi.fn() }));
vi.mock("./env.js", () => ({ notionEnv: { NOTION_DB_RAW_FILES: () => "a".repeat(32) } }));
const digest = "c".repeat(64);
function page() {
  const rich = (value: string) => [{ plain_text: value }];
  return { object: "page", id: "b".repeat(32), parent: { type: "database_id", database_id: "a".repeat(32) }, archived: false, in_trash: false,
    properties: { "SHA256": { type: "rich_text", rich_text: rich(digest) }, "ファイル名": { type: "title", title: rich("edinet_csv_1001_20261013.zip") },
      "サイズ": { type: "number", number: 4 }, "データ基準日": { type: "date", date: { start: "2026-10-13" } },
      "取得日時": { type: "date", date: { start: "2026-10-13T18:00:00+09:00" } }, "取得URL": { type: "url", url: "https://api.edinet-fsa.go.jp/api/v2/documents/S100TEST" },
      "ファイル": { type: "files", files: [{ type: "file", name: "edinet_csv_1001_20261013.zip", file: { url: "https://hosted.example/raw?signature=do-not-return" } }] },
      "ソース": { type: "select", select: { name: "EDINET" } }, "データ種別": { type: "rich_text", rich_text: rich("csv") }, "対象銘柄コード": { type: "rich_text", rich_text: rich("1001") },
      "ライセンスタグ": { type: "select", select: { name: "commercial-ok" } }, "変換状態": { type: "select", select: { name: "完了" } } } };
}
beforeEach(() => vi.resetAllMocks());
describe("⑤原本のread-only照合", () => {
  it("SHA限定queryだけ行い、hosted存在とphysical検証を混同せずURLを返さない", async () => {
    vi.mocked(notionRequest).mockResolvedValue({ results: [page()], has_more: false });
    const found = await findCanonicalRawFiles([digest]);
    expect(found.get(digest)).toMatchObject({ sha256: digest, sizeBytes: 4, hostedAttachments: 1 });
    expect(JSON.stringify([...found.values()])).not.toContain("signature");
    expect(vi.mocked(notionRequest).mock.calls[0]?.slice(0, 2)).toEqual(["POST", `/databases/${"a".repeat(32)}/query`]);
    expect(notionRequest).toHaveBeenCalledTimes(1);
  });
  it.each(["duplicate", "truncated"])("%s結果を成功計画にしない", async (kind) => {
    vi.mocked(notionRequest).mockResolvedValue({ results: kind === "duplicate" ? [page(), page()] : [page()], has_more: kind === "truncated" });
    await expect(findCanonicalRawFiles([digest])).rejects.toThrow();
    expect(notionRequest).toHaveBeenCalledTimes(1);
  });
  it.each(["external", "missing", "name", "trash", "date"])("%sの契約不一致は停止", (kind) => {
    const value = page();
    if (kind === "external") value.properties["ファイル"].files[0]!.type = "external";
    if (kind === "missing") value.properties["ファイル"].files = [];
    if (kind === "name") value.properties["ファイル"].files[0]!.name = "different.zip";
    if (kind === "trash") value.in_trash = true;
    if (kind === "date") value.properties["データ基準日"].date.start = "2026-02-31";
    expect(() => parseCanonicalRawFile(value, "a".repeat(32))).toThrow();
  });
});
