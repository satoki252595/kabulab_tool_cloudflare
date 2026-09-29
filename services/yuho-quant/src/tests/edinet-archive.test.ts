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
import { recordPrimaryData } from "../../../../src/shared/notion-archive/index.js";
import {
  archiveTallyFailed,
  edinetArchiveFilename,
  edinetArchiveKey,
  planArchiveUploads,
  recordEdinetZip,
} from "../services/edinet/archive.js";

vi.mock("../../../../src/shared/notion-archive/index.js", () => ({
  recordPrimaryData: vi.fn(),
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
    });
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
    });
    expect(vi.mocked(recordPrimaryData).mock.calls[0][0].force).toBe(true);
    expect(vi.mocked(recordPrimaryData).mock.calls[0][0].key).toBe(
      "S100J2E7:type5"
    );
  });
});
