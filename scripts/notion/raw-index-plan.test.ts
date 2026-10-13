import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalRawKey, localRawSamples, planRawIndex, readD1RawIndexes, type RawPlanDeps } from "./raw-index-plan.js";
import type { CanonicalRawFile } from "../../src/shared/notion-archive/raw-files.js";
const body = new Uint8Array([0, 255, 128, 42]), digest = createHash("sha256").update(body).digest("hex");
const raw: CanonicalRawFile = { pageId: "b".repeat(32), filename: "edinet_csv_1001_20261013.zip", sha256: digest, sizeBytes: 4, source: "EDINET", datatype: "csv", scope: "1001", dataDate: "2026-10-13", fetchedAt: "2026-10-13T18:00:00+09:00", sourceUrl: "https://api.edinet-fsa.go.jp/api/v2/documents/S100TEST?type=5", licenseTag: "commercial-ok", convertStatus: "完了", hostedAttachments: 2 };
const sample = { filename: raw.filename, sha256: digest, sizeBytes: 4 };
function deps(): RawPlanDeps {
  return { bucket: "raw-bucket", find: vi.fn(async () => new Map([[digest, raw]])), index: vi.fn(async () => []), get: vi.fn(async () => null) };
}
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("D1 RESTのobject行契約（proxy tupleを誤castしない）", () => {
  it.each(["object", "tuple"])("%s行を厳密に検査する", async (kind) => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "a".repeat(32));
    vi.stubEnv("D1_DATABASE_ID", "b".repeat(32));
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");
    const row = { sha256: digest, r2_bucket: "raw-bucket", r2_key: "raw/retained.zip", size_bytes: 4, source: raw.source, datatype: raw.datatype, scope: raw.scope, data_date: raw.dataDate, license_tag: raw.licenseTag };
    const fetch = vi.fn(async () => new Response(JSON.stringify({ success: true, result: [{ success: true, results: [kind === "object" ? row : Object.values(row)] }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    if (kind === "object") await expect(readD1RawIndexes([digest])).resolves.toEqual([row]);
    else await expect(readD1RawIndexes([digest])).rejects.toThrow("object");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
describe("T-RAW標本はmutationなしで欠測/未知を保全停止する", () => {
  it("未保存ならcurrent/legacyを読むだけで条件付き作成計画を返す", async () => {
    const d = deps(), emit = vi.fn(async (_record: object) => {});
    expect(await planRawIndex([sample], d, emit)).toMatchObject({ counts: { would_put_and_index: 1 }, mutations: 0, upstreamDownloads: 0, notionBodyDownloads: 0, wouldPutBytes: 4 });
    expect(d.get).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "would_put_and_index", localShaVerified: true, r2BodyVerified: false, docId: "S100TEST" }));
  });
  it("旧キーの実bytesが同値なら上書きせず索引だけを計画する", async () => {
    const d = deps(), emit = vi.fn(async (_record: object) => {});
    vi.mocked(d.get).mockResolvedValueOnce(null).mockResolvedValueOnce({ body, etag: '"native"' });
    expect(await planRawIndex([sample], d, emit)).toMatchObject({ counts: { would_index_existing: 1 }, r2BodyBytesDownloaded: 4, wouldPutBytes: 0 });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ key: canonicalRawKey(raw, null), r2BodyVerified: true }));
  });
  it("D1とR2実bytesが一致したものだけ保存済同値skipになる", async () => {
    const d = deps(), emit = vi.fn(async (_record: object) => {});
    vi.mocked(d.index).mockResolvedValue([{ sha256: digest, r2_bucket: "raw-bucket", r2_key: "raw/retained-key.zip", size_bytes: 4, source: raw.source, datatype: raw.datatype, scope: raw.scope, data_date: raw.dataDate, license_tag: raw.licenseTag }]);
    vi.mocked(d.get).mockResolvedValue({ body, etag: '"native"' });
    expect(await planRawIndex([sample], d, emit)).toMatchObject({ counts: { already_complete: 1 } });
    expect(d.get).toHaveBeenCalledWith("raw/retained-key.zip", "raw-bucket");
  });
  it.each(["unknown", "mismatch", "missing-indexed-body", "metadata"])("%sなら次の原本へ進まず成功を返さない", async (phase) => {
    const d = deps(), emit = vi.fn(async (_record: object) => {});
    if (phase === "unknown") vi.mocked(d.get).mockRejectedValue(new Error("unknown R2 read"));
    if (phase === "mismatch") vi.mocked(d.get).mockResolvedValue({ body: new Uint8Array([1, 2, 3, 4]), etag: '"native"' });
    if (phase === "missing-indexed-body") vi.mocked(d.index).mockResolvedValue([{ sha256: digest, r2_bucket: "raw-bucket", r2_key: "raw/retained-key.zip", size_bytes: 4, source: raw.source, datatype: raw.datatype, scope: raw.scope, data_date: raw.dataDate, license_tag: raw.licenseTag }]);
    if (phase === "metadata") vi.mocked(d.find).mockResolvedValue(new Map([[digest, { ...raw, sizeBytes: 3 }]]));
    await expect(planRawIndex([sample], d, emit)).rejects.toThrow();
    expect(emit.mock.calls.some(([value]) => (value as { phase: string }).phase === "sample")).toBe(false);
    expect(d.get).toHaveBeenCalledTimes(phase === "metadata" ? 0 : 1);
  });
  it("基準日不明の原本をnodate/nodateへ分け、取得日を基準日に使わない", () => {
    const missingDate = { ...raw, dataDate: null };
    expect(canonicalRawKey(missingDate, null)).toBe(`raw/edinet/csv/nodate/nodate/1001/_/${digest.slice(0, 16)}.zip`);
    expect(missingDate.dataDate).toBeNull();
  });
  it("primaryを一度読み、tidy/parquetとsymlinkを選ばない", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "raw-plan-test-"));
    try {
      await fs.writeFile(path.join(dir, raw.filename), body);
      await fs.writeFile(path.join(dir, "a_converted.parquet"), body);
      await fs.symlink(path.join(dir, raw.filename), path.join(dir, "a-symlink.zip"));
      expect(await localRawSamples(dir, 1, 4)).toEqual([sample]);
      await expect(localRawSamples(dir, 1, 3)).rejects.toThrow("指定数");
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
