import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertCanonicalRawMetadata, findCanonicalRawFileAttachments, findCanonicalRawFiles, listCanonicalRawFiles, parseCanonicalRawFile } from "./raw-files.js";
import { notionRequest } from "./client.js";
vi.mock("./client.js", () => ({ notionRequest: vi.fn(), assertCursorProgress: (seen: Set<string>, cursor: string) => {
  if (seen.has(cursor)) throw new Error("cursor repeated"); seen.add(cursor);
} }));
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
  it("明示singleAttempt/native guardを追加queryなしで共通clientへ透過する", async () => {
    vi.mocked(notionRequest).mockResolvedValue({ results: [page()], has_more: false });
    const options = { singleAttempt: true, beforeRequest: vi.fn() };
    await findCanonicalRawFileAttachments([digest], options);
    expect(notionRequest).toHaveBeenCalledOnce(); expect(vi.mocked(notionRequest).mock.calls[0]?.[3]).toBe(options);
  });
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

describe("⑤canonical全集合の固定cutoff/strict partition", () => {
  const cutoff = "2026-10-14T00:00:00.000Z";
  it("16個のhexで全域を照合し、同SHAを複数行採用しない", async () => {
    vi.mocked(notionRequest).mockImplementation(async (_method, _url, body) => {
      const b = body as { filter: { and: Array<{ rich_text?: { starts_with: string } }> } };
      return { results: b.filter.and[0]?.rich_text?.starts_with === "c" ? [page()] : [], has_more: false, next_cursor: null };
    });
    const progress: object[] = [];
    const result = await listCanonicalRawFiles(cutoff, () => {}, event => { progress.push(event); });
    expect(progress).toContainEqual({ phase: "inventory_partition_complete", prefix: "c", queries: 13, partitionRows: 1, acceptedRows: 1, responseRows: 0 });
    expect(JSON.stringify(progress)).not.toMatch(/signature|sourceUrl|filename|pageId/);
    expect(result).toHaveLength(1); expect(result[0]?.sha256).toBe(digest);
    expect(notionRequest).toHaveBeenCalledTimes(16);
    expect(JSON.stringify(result)).not.toContain("signature");
    for (const call of vi.mocked(notionRequest).mock.calls) expect(call[2]).toMatchObject({ filter: { and: [{}, { timestamp: "created_time", created_time: { on_or_before: cutoff } }] } });
  });
  it("has_more=falseでも10,000件に達したpartitionは捨てて再分割する", async () => {
    const records = Array.from({ length: 10_000 }, (_, n) => {
      const p = page(); p.id = n.toString(16).padStart(32, "0");
      p.properties.SHA256.rich_text[0]!.plain_text = `0${(n % 16).toString(16)}${n.toString(16).padStart(62, "0")}`;
      return p;
    });
    vi.mocked(notionRequest).mockImplementation(async (_method, _url, body) => {
      const b = body as { filter: { and: Array<{ rich_text?: { starts_with: string } }> }; start_cursor?: string };
      const prefix = b.filter.and[0]!.rich_text!.starts_with, selected = records.filter((p) => p.properties.SHA256.rich_text[0]!.plain_text.startsWith(prefix));
      const offset = b.start_cursor === undefined ? 0 : Number(b.start_cursor), next = offset + 100;
      return { results: selected.slice(offset, next), has_more: next < selected.length, next_cursor: next < selected.length ? String(next) : null };
    });
    const result = await listCanonicalRawFiles(cutoff, () => {});
    expect(result).toHaveLength(10_000);
    expect(new Set(result.map((r) => r.sha256)).size).toBe(10_000);
    expect(vi.mocked(notionRequest).mock.calls.some((call) => JSON.stringify(call[2]).includes('"starts_with":"00"'))).toBe(true);
  });
  it("cursor反復は追加query前に停止する", async () => {
    vi.mocked(notionRequest).mockResolvedValue({ results: [], has_more: true, next_cursor: "same" });
    await expect(listCanonicalRawFiles(cutoff, () => {})).rejects.toThrow("cursor repeated");
    expect(notionRequest).toHaveBeenCalledTimes(2);
  });
  it("budget guardの停止を握り潰さない", async () => {
    await expect(listCanonicalRawFiles(cutoff, () => { throw new Error("deadline"); })).rejects.toThrow("deadline");
    expect(notionRequest).not.toHaveBeenCalled();
  });
  it("原本＋tidy/parquetの3添付でも原本名だけを一意選択する", async () => {
    const p = page();
    p.properties["ファイル"].files.push(
      { type: "file", name: "derived.tidy.csv", file: { url: "https://hosted.example/tidy" } },
      { type: "file", name: "derived.parquet.zip", file: { url: "https://hosted.example/parquet" } }
    );
    vi.mocked(notionRequest).mockResolvedValue({ results: [p], has_more: false });
    const result = await findCanonicalRawFileAttachments([digest]);
    expect(result.get(digest)?.raw.hostedAttachments).toBe(3);
    expect(result.get(digest)?.file).toEqual({ name: "edinet_csv_1001_20261013.zip", url: "https://hosted.example/raw?signature=do-not-return" });
    p.properties["ファイル"].files.push({ type: "file", name: "edinet_csv_1001_20261013.zip.zip", file: { url: "https://hosted.example/ambiguous" } });
    await expect(findCanonicalRawFileAttachments([digest])).rejects.toThrow("一意に確定できません");
  });
  it("hostedURLはSHA batchのメモリ内で更新し、immutable metadata差分を検出する", async () => {
    const p = page(), { sourceUrl: _url, ...expected } = parseCanonicalRawFile(p, "a".repeat(32));
    vi.mocked(notionRequest).mockResolvedValue({ results: [p], has_more: false, next_cursor: null });
    const result = await findCanonicalRawFileAttachments([digest]);
    expect(result.get(digest)?.file.name).toBe(expected.filename);
    expect(result.get(digest)?.file.url).toContain("signature");
    expect(() => assertCanonicalRawMetadata(expected, result.get(digest)!.raw)).not.toThrow();
    expect(vi.mocked(notionRequest).mock.calls[0]?.[1]).toContain("/query");
    p.properties["サイズ"].number++;
    expect(() => assertCanonicalRawMetadata(expected, parseCanonicalRawFile(p, "a".repeat(32)))).toThrow("metadataがmanifestから変化");
  });
});
