/**
 * EDINET type1 (XBRL) ZIP の再取得非決定性への対処テスト。
 *
 * 実測 (2026-11-08, S100ASBR): EDINET の type1 ZIP は同一書類でも
 * ダウンロード毎に全エントリの ZIP タイムスタンプが変わり、バイト列
 * SHA256 が一致しない (中身の全エントリはバイト一致)。type5 は決定的。
 * そのため「初回保管成功後に後段で中断 → 再実行」が notion-archive の
 * fingerprint 不一致 (同一 key 保全停止) で恒久デッドロックした。
 *
 * 契約: 保全停止時は保管済み原本を厳密資格確認つきで読み戻し
 * (readSavedEdinetZip)、ZIP コンテナでなく中身 (エントリ名+展開後
 * バイト列) が完全一致するときだけ skipped_existing として再開する。
 * 中身が違う・読めない・資格不適格なら元の保全停止をそのまま投げる。
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zipContentsEqual } from "../services/edinet/zip.js";
import { recordEdinetZip } from "../services/edinet/archive.js";
import {
  recordPrimaryData,
  verifyArchivedAttachments,
} from "../../../../src/shared/notion-archive/index.js";

const io = vi.hoisted(() => ({
  db: vi.fn(),
  row: vi.fn(),
  files: vi.fn(),
  download: vi.fn(),
}));
vi.mock("../../../../src/shared/notion-archive/index.js", () => ({
  recordPrimaryData: vi.fn(),
  findBackupRowsByKeys: vi.fn(),
  verifyArchivedAttachments: vi.fn(),
}));
vi.mock("../../../../src/shared/notion-archive/archive.js", async (original) => ({
  ...(await original<typeof import("../../../../src/shared/notion-archive/archive.js")>()),
  findUniqueBackupChildByTitle: io.db,
  queryUniqueRow: io.row,
}));
vi.mock("../../../../src/shared/notion-archive/page-file.js", () => ({
  listPageFiles: io.files,
}));
vi.mock("../../../../src/shared/notion-archive/archived-download.js", async (original) => ({
  ...(await original<typeof import("../../../../src/shared/notion-archive/archived-download.js")>()),
  downloadArchivedFile: io.download,
}));

const type1 = readFileSync(
  new URL("./fixtures/ingest-csv-reingest-6963/S100YF41.zip", import.meta.url)
);
const type5 = readFileSync(
  new URL("./fixtures/ingest-csv-reingest-6963/S100YF41-csv.zip", import.meta.url)
);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** LFH/CD の更新時刻フィールドだけを書き換えた複製 (EDINET 再取得の再現)。 */
function patchZipTimestamps(src: Buffer, time: number, date: number): Buffer {
  const buf = Buffer.from(src);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("fixture is not a zip");
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("fixture CD broken");
    buf.writeUInt16LE(time, p + 12);
    buf.writeUInt16LE(date, p + 14);
    const lfh = buf.readUInt32LE(p + 42);
    buf.writeUInt16LE(time, lfh + 10);
    buf.writeUInt16LE(date, lfh + 12);
    p +=
      46 +
      buf.readUInt16LE(p + 28) +
      buf.readUInt16LE(p + 30) +
      buf.readUInt16LE(p + 32);
  }
  return buf;
}

describe("zipContentsEqual", () => {
  it("同一バイト列は一致", () => {
    expect(zipContentsEqual(type1, Buffer.from(type1))).toBe(true);
  });

  it("タイムスタンプだけ違う再取得ZIPは中身一致 (生SHAは不一致)", () => {
    const reFetched = patchZipTimestamps(type1, 0x7def, 0x5b21);
    expect(sha(reFetched)).not.toBe(sha(type1));
    expect(zipContentsEqual(type1, reFetched)).toBe(true);
  });

  it("別ZIP (同通のtype5) は中身不一致", () => {
    expect(zipContentsEqual(type1, type5)).toBe(false);
  });

  it("ZIPでない入力は throw (黙って false/true にしない)", () => {
    expect(() => zipContentsEqual(Buffer.from("not a zip"), type1)).toThrow();
  });
});

const PAGE_ID = "3e1d74ff84cd812ebc79f7aff3f2d7ca";
const rich = (content: string) => [
  { type: "text", plain_text: content, text: { content } },
];
function savedPage() {
  return {
    id: PAGE_ID,
    archived: false,
    in_trash: false,
    parent: { type: "database_id", database_id: PAGE_ID },
    properties: {
      Key: { title: rich("S100YF41:type1") },
      Metadata: {
        rich_text: rich(JSON.stringify({ docID: "S100YF41", edinetDocType: 1 })),
      },
    },
  };
}
const INPUT_CHANGED = new Error(
  "Notion archive: 同一 key の入力が変更されているため保全停止 (書込0) key=S100YF41:type1"
);
const call = (zip: Buffer) =>
  recordEdinetZip({
    service: "yuho-quant",
    docID: "S100YF41",
    type: 1,
    zip,
    source: "EDINET API v2 /documents/S100YF41?type=1",
    fetchedAt: "2026-11-08T00:00:00.000Z",
    metadata: {},
  });

describe("recordEdinetZip の中身等価な既存原本の再開", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NOTION_ARCHIVE_PAGE_ID", PAGE_ID);
    vi.mocked(recordPrimaryData).mockRejectedValue(INPUT_CHANGED);
    io.db.mockResolvedValue(PAGE_ID);
    io.row.mockResolvedValue(savedPage());
    io.files.mockResolvedValue([
      { name: "S100YF41_xbrl.zip", kind: "file", url: "offline" },
    ]);
    io.download.mockResolvedValue(type1);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("保管済みと中身が完全一致する再取得ZIPは skipped_existing で再開する", async () => {
    const out = await call(patchZipTimestamps(type1, 0x1111, 0x2222));
    expect(out).toEqual({
      pageId: PAGE_ID,
      outcome: "skipped_existing",
      fileTooLarge: false,
      manifestMatch: "unknown",
    });
    expect(verifyArchivedAttachments).not.toHaveBeenCalled();
  });

  it("保管済みと中身が違う場合は元の保全停止をそのまま投げる", async () => {
    await expect(call(type5)).rejects.toBe(INPUT_CHANGED);
  });

  it("保管済み原本が資格不適格 (行なし) なら元の保全停止をそのまま投げる", async () => {
    io.row.mockResolvedValue(null);
    await expect(call(patchZipTimestamps(type1, 0x1111, 0x2222))).rejects.toBe(
      INPUT_CHANGED
    );
  });

  it("別のエラーは原本照合をせずそのまま投げる", async () => {
    const other = new Error("network timeout");
    vi.mocked(recordPrimaryData).mockRejectedValue(other);
    await expect(call(type1)).rejects.toBe(other);
    expect(io.download).not.toHaveBeenCalled();
  });

  it("force 時は保全停止でも原本照合で握り潰さない", async () => {
    await expect(
      recordEdinetZip({
        service: "yuho-quant",
        docID: "S100YF41",
        type: 1,
        zip: patchZipTimestamps(type1, 0x1111, 0x2222),
        source: "EDINET API v2 /documents/S100YF41?type=1",
        fetchedAt: "2026-11-08T00:00:00.000Z",
        metadata: {},
        force: true,
      })
    ).rejects.toBe(INPUT_CHANGED);
    expect(io.download).not.toHaveBeenCalled();
  });
});
