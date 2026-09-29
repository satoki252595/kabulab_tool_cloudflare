/**
 * EDINET archive 共通契約のテスト (type 別 key + 実 ZIP bytes)。
 *
 * notion-archive 層はモックし (実体は stock-text.test.ts が保証)、ここでは
 * type 別 key の一意性・実 bytes の同一添付・記録計画 (Type5 先在でも
 * Type1 未記録なら保存) の契約を固定する。全 caller (ingest /
 * backfill-missing-docs / backfill-overseas / manual59 repair) が同一
 * helper を使うことが契約。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findBackupRowsByKeys,
  recordPrimaryData,
} from "../../../../src/shared/notion-archive/index.js";
import {
  archiveTallyFailed,
  assertNoMetadataOnly,
  checkDocCustody,
  checkDocsCustody,
  edinetArchiveFilename,
  edinetArchiveKey,
  planArchiveUploads,
  recordEdinetZip,
} from "../services/edinet/archive.js";

vi.mock("../../../../src/shared/notion-archive/index.js", () => ({
  recordPrimaryData: vi.fn(),
  findBackupRowsByKeys: vi.fn(),
}));

// 実 bytes は既存の実原本 fixture を不透明バイト列として読む。helper は
// bytes の同一添付だけを保証し、内容の解釈はしない。
const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const realBytes = () =>
  new Uint8Array(
    readFileSync(join(FX, "georows-single-col-sen-S100W16I.html"))
  );

describe("edinet archive 共通契約", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("type 別 key は type 毎に一意で旧来の素 docID と衝突しない", () => {
    expect(edinetArchiveKey("S100J2E7", 1)).toBe("S100J2E7:type1");
    expect(edinetArchiveKey("S100J2E7", 5)).toBe("S100J2E7:type5");
    expect(edinetArchiveKey("S100J2E7", 1)).not.toBe("S100J2E7");
    expect(edinetArchiveKey("S100J2E7", 5)).not.toBe("S100J2E7");
  });

  it("添付名は既存の xbrl/csv 命名を踏襲する", () => {
    expect(edinetArchiveFilename("S100J2E7", 1)).toBe("S100J2E7_xbrl.zip");
    expect(edinetArchiveFilename("S100J2E7", 5)).toBe("S100J2E7_csv.zip");
  });

  it("Type5 先在でも Type1 未記録なら type1 を計画する (抑止の根因修正)", () => {
    expect(
      planArchiveUploads({ t1Present: false, t5Present: true, xbrlAvailable: true })
    ).toEqual([1]);
    expect(
      planArchiveUploads({ t1Present: true, t5Present: false, xbrlAvailable: true })
    ).toEqual([5]);
    expect(
      planArchiveUploads({ t1Present: false, t5Present: false, xbrlAvailable: true })
    ).toEqual([5, 1]);
    expect(
      planArchiveUploads({ t1Present: true, t5Present: true, xbrlAvailable: true })
    ).toEqual([]);
  });

  it("XBRL 未取得なら type1 を計画しない・force は取得済み全 type を再記録する", () => {
    expect(
      planArchiveUploads({ t1Present: false, t5Present: false, xbrlAvailable: false })
    ).toEqual([5]);
    expect(
      planArchiveUploads({
        t1Present: true,
        t5Present: true,
        xbrlAvailable: true,
        force: true,
      })
    ).toEqual([5, 1]);
    expect(
      planArchiveUploads({
        t1Present: true,
        t5Present: true,
        xbrlAvailable: false,
        force: true,
      })
    ).toEqual([5]);
  });

  it("recordEdinetZip は type 別 key・実 bytes・種別メタで1件記録する", async () => {
    vi.mocked(recordPrimaryData).mockResolvedValue({
      pageId: "p1",
      outcome: "recorded",
      fileTooLarge: false,
      manifestMatch: "written",
    });
    const bytes = realBytes();
    const out = await recordEdinetZip({
      service: "yuho-quant",
      docID: "S100J2E7",
      type: 1,
      zip: bytes,
      source: "EDINET API v2 /documents/S100J2E7?type=1",
      fetchedAt: "2026-09-28T00:00:00.000Z",
      metadata: { docID: "S100J2E7" },
    });
    expect(out.outcome).toBe("recorded");
    expect(recordPrimaryData).toHaveBeenCalledTimes(1);
    const got = vi.mocked(recordPrimaryData).mock.calls[0][0];
    expect(got.service).toBe("yuho-quant");
    expect(got.key).toBe("S100J2E7:type1");
    expect(got.files).toHaveLength(1);
    expect(got.files![0].filename).toBe("S100J2E7_xbrl.zip");
    expect(got.files![0].contentType).toBe("application/zip");
    expect(
      Buffer.from(got.files![0].bytes as Uint8Array).equals(Buffer.from(bytes))
    ).toBe(true);
    expect((got.metadata as Record<string, unknown>).edinetDocType).toBe(1);
    expect((got.metadata as Record<string, unknown>).docID).toBe("S100J2E7");
  });

  it("保管失敗は失敗扱い: error > 0 だけ非0終了する (missing-docs tail 契約)", () => {
    // backfill-missing-docs の最終 catch は保管失敗も tally.error へ加算
    // する。tail はこの判定で exitCode=1 にし、job green にしない。
    expect(archiveTallyFailed(0)).toBe(false);
    expect(archiveTallyFailed(1)).toBe(true);
    expect(archiveTallyFailed(7)).toBe(true);
  });

  it("fileTooLarge は metadata のみ成功にせず throw する (全 caller で未完了扱い)", async () => {
    vi.mocked(recordPrimaryData).mockResolvedValue({
      pageId: "p-large",
      outcome: "recorded",
      fileTooLarge: true,
      manifestMatch: "written",
    });
    await expect(
      recordEdinetZip({
        service: "yuho-quant",
        docID: "S100J2E7",
        type: 1,
        zip: realBytes(),
        source: "EDINET API v2 /documents/S100J2E7?type=1",
        fetchedAt: "2026-09-28T00:00:00.000Z",
        metadata: { docID: "S100J2E7" },
      })
    ).rejects.toThrow("S100J2E7:type1");
  });

  it("force は透過し、戻り値をそのまま返す", async () => {
    vi.mocked(recordPrimaryData).mockResolvedValue({
      pageId: "p9",
      outcome: "skipped_existing",
      fileTooLarge: false,
      manifestMatch: "unknown",
    });
    vi.mocked(findBackupRowsByKeys).mockResolvedValue([
      { key: "S100J2E7:type5", fileCount: 1, status: "recorded", metadata: {} },
    ]);
    const out = await recordEdinetZip({
      service: "yuho-quant",
      docID: "S100J2E7",
      type: 5,
      zip: realBytes(),
      source: "EDINET API v2 /documents/S100J2E7?type=5",
      fetchedAt: "2026-09-28T00:00:00.000Z",
      metadata: {},
      force: true,
    });
    expect(out).toEqual({
      pageId: "p9",
      outcome: "skipped_existing",
      fileTooLarge: false,
      manifestMatch: "unknown",
    });
    expect(vi.mocked(recordPrimaryData).mock.calls[0][0].force).toBe(true);
    expect(vi.mocked(recordPrimaryData).mock.calls[0][0].key).toBe(
      "S100J2E7:type5"
    );
  });

  it("完成判定は実 Files 添付を見る (key 存在だけでは完成にしない)", async () => {
    vi.mocked(findBackupRowsByKeys).mockResolvedValue([
      { key: "D1:type1", fileCount: 1, status: "recorded", metadata: {} },
      { key: "D1:type5", fileCount: 0, status: "file_too_large", metadata: {} },
    ]);
    const c = await checkDocCustody("yuho-quant", "D1");
    expect(c).toEqual({ t1: "complete", t5: "metadata-only" });
  });

  it("files なし + 公式 xbrlUnavailable の t1 は not-applicable (架空要求しない)", async () => {
    vi.mocked(findBackupRowsByKeys).mockResolvedValue([
      { key: "D2:type1", fileCount: 0, status: "recorded", metadata: { xbrlUnavailable: true } },
    ]);
    const c = await checkDocCustody("yuho-quant", "D2");
    expect(c).toEqual({ t1: "not-applicable", t5: "missing" });
  });

  it("行なしは missing で埋める", async () => {
    vi.mocked(findBackupRowsByKeys).mockResolvedValue([]);
    const c = await checkDocCustody("yuho-quant", "D3");
    expect(c).toEqual({ t1: "missing", t5: "missing" });
  });

  it("41 通は 20+20+1 で 3 照会に chunk する (40 key/回・上限 41 内)", async () => {
    vi.mocked(findBackupRowsByKeys).mockResolvedValue([]);
    const ids = Array.from({ length: 41 }, (_, i) => `D${i}`);
    const m = await checkDocsCustody("yuho-quant", ids);
    expect(vi.mocked(findBackupRowsByKeys).mock.calls.length).toBe(3);
    expect(vi.mocked(findBackupRowsByKeys).mock.calls[0][1].length).toBe(40);
    expect(vi.mocked(findBackupRowsByKeys).mock.calls[1][1].length).toBe(40);
    expect(vi.mocked(findBackupRowsByKeys).mock.calls[2][1].length).toBe(2);
    expect(m.size).toBe(41);
  });

  it("metadata-only 混じりは明示修復 STOP を投げる", () => {
    expect(() =>
      assertNoMetadataOnly({ t1: "complete", t5: "metadata-only" }, "D9")
    ).toThrow("D9");
    expect(() =>
      assertNoMetadataOnly({ t1: "complete", t5: "complete" }, "D9")
    ).not.toThrow();
  });

  it("skipped_existing + 既存行が実 Files なし → 保全停止 (無断再作成しない)", async () => {
    vi.mocked(recordPrimaryData).mockResolvedValue({
      pageId: "pM",
      outcome: "skipped_existing",
      fileTooLarge: false,
      manifestMatch: "unknown",
    });
    vi.mocked(findBackupRowsByKeys).mockResolvedValue([
      { key: "D4:type5", fileCount: 0, status: "file_too_large", metadata: {} },
    ]);
    await expect(
      recordEdinetZip({
        service: "yuho-quant",
        docID: "D4",
        type: 5,
        zip: realBytes(),
        source: "EDINET API v2 /documents/D4?type=5",
        fetchedAt: "2026-09-28T00:00:00.000Z",
        metadata: {},
      })
    ).rejects.toThrow("既存行に実ファイルなし");
  });

  it("skipped_existing + 同一 key 重複行 → 保全停止", async () => {
    vi.mocked(recordPrimaryData).mockResolvedValue({
      pageId: "pD",
      outcome: "skipped_existing",
      fileTooLarge: false,
      manifestMatch: "unknown",
    });
    vi.mocked(findBackupRowsByKeys).mockResolvedValue([
      { key: "D5:type1", fileCount: 1, status: "recorded", metadata: {} },
      { key: "D5:type1", fileCount: 1, status: "recorded", metadata: {} },
    ]);
    await expect(
      recordEdinetZip({
        service: "yuho-quant",
        docID: "D5",
        type: 1,
        zip: realBytes(),
        source: "EDINET API v2 /documents/D5?type=1",
        fetchedAt: "2026-09-28T00:00:00.000Z",
        metadata: {},
      })
    ).rejects.toThrow("重複行");
  });

  it("T1 行不在 + T5 実体あり + T5 行 xbrlUnavailable → t1 not-applicable (T5 由来)", async () => {
    vi.mocked(findBackupRowsByKeys).mockResolvedValue([
      { key: "D6:type5", fileCount: 1, status: "recorded", metadata: { xbrlUnavailable: true } },
    ]);
    const c = await checkDocCustody("yuho-quant", "D6");
    expect(c).toEqual({ t1: "not-applicable", t5: "complete" });
  });

  it("T1 行不在 + T5 実体あり + flag なし → t1 missing のまま (捏造しない)", async () => {
    vi.mocked(findBackupRowsByKeys).mockResolvedValue([
      { key: "D7:type5", fileCount: 1, status: "recorded", metadata: {} },
    ]);
    const c = await checkDocCustody("yuho-quant", "D7");
    expect(c).toEqual({ t1: "missing", t5: "complete" });
  });

  it("custody 照会の同一 key 重複行 → 保全停止 (後勝ちで黙殺しない)", async () => {
    vi.mocked(findBackupRowsByKeys).mockResolvedValue([
      { key: "D8:type5", fileCount: 1, status: "recorded", metadata: {} },
      { key: "D8:type5", fileCount: 0, status: "file_too_large", metadata: {} },
    ]);
    await expect(checkDocCustody("yuho-quant", "D8")).rejects.toThrow("重複行");
  });
});
