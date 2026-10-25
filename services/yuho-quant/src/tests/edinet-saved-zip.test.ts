/** Real6963 CSV bytes; archive pages/manifest below are explicit offline protocol projections. */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { readSavedEdinetZip, SavedEdinetZipQualificationError, SavedEdinetZipMissingError } from "../services/edinet/archive.js";
import { inputFingerprint } from "../../../../src/shared/notion-archive/archive.js";
const io = vi.hoisted(() => ({ db: vi.fn(), row: vi.fn(), files: vi.fn(), download: vi.fn() }));
vi.mock("../../../../src/shared/notion-archive/archive.js", async original => ({
  ...await original<typeof import("../../../../src/shared/notion-archive/archive.js")>(),
  findUniqueBackupChildByTitle: io.db, queryUniqueRow: io.row,
}));
vi.mock("../../../../src/shared/notion-archive/page-file.js", () => ({ listPageFiles: io.files }));
vi.mock("../../../../src/shared/notion-archive/archived-download.js", async original => ({
  ...await original<typeof import("../../../../src/shared/notion-archive/archived-download.js")>(), downloadArchivedFile: io.download,
}));
const bytes = readFileSync(new URL("./fixtures/ingest-csv-reingest-6963/S100YF41-csv.zip", import.meta.url));
const sha = createHash("sha256").update(bytes).digest("hex"), name = "S100YF41_csv.zip", key = "S100YF41:type5";
const rich = (content: string) => [{ type: "text", plain_text: content, text: { content } }];
function page(metadata: unknown, sourceKey = key) {
  return { id: "3e1d74ff84cd812ebc79f7aff3f2d7ca", archived: false, in_trash: false,
    parent: { type: "database_id", database_id: "3e1d74ff84cd812ebc79f7aff3f2d7ca" },
    properties: { Key: { title: rich(sourceKey) }, Metadata: { rich_text: rich(JSON.stringify(metadata)) } } };
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("NOTION_ARCHIVE_PAGE_ID", "3e1d74ff84cd812ebc79f7aff3f2d7ca");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); }));
  io.db.mockResolvedValue("3e1d74ff84cd812ebc79f7aff3f2d7ca");
  io.row.mockResolvedValue(page({ docID: "S100YF41", edinetDocType: 5 }));
  io.files.mockResolvedValue([{ name, kind: "file", url: "offline-file-transport-control" }]);
  io.download.mockResolvedValue(bytes);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("preserves wrapped raw metadata after normal physical verification; conflicts stop before file reads", async () => {
  const primary = JSON.parse(readFileSync(new URL("./fixtures/information-edit-basis-3776/native-entry.json", import.meta.url), "utf8")).doc;
  const raw = { docID: primary.docID, edinetDocType: 5, primary, originalPublisherClockVerified: "UNKNOWN" };
  const actual = readFileSync(new URL("./fixtures/information-edit-basis-3776/current-type5.zip", import.meta.url));
  io.row.mockResolvedValue(page(raw, `${primary.docID}:type5`));
  io.files.mockResolvedValue([{ name: `${primary.docID}_csv.zip`, kind: "file", url: "offline-file-transport-control" }]);
  io.download.mockResolvedValue(actual);
  const saved = await readSavedEdinetZip(primary.docID, 5);
  expect(saved.metadata).toEqual(raw); expect(saved.metadata.secCode).toBeUndefined();
  expect(saved.originalManifest).toBe("unknown");
  io.files.mockClear(); io.download.mockClear();
  io.row.mockResolvedValue(page({ ...raw, secCode: null }, `${primary.docID}:type5`));
  await expect(readSavedEdinetZip(primary.docID, 5)).rejects.toBeInstanceOf(SavedEdinetZipQualificationError);
  expect(io.files).not.toHaveBeenCalled(); expect(io.download).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
it("reads only the selected existing type5 physical bytes and retains absent-manifest unknown", async () => {
  expect(await readSavedEdinetZip("S100YF41", 5)).toMatchObject({ bytes, sha256: sha, originalManifest: "unknown" });
  expect(io.row.mock.calls[0][1]).toEqual({ property: "Key", title: { equals: key } });
  expect(io.download).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
});
it("uses the same shared manifest self-fingerprint and rejects corrupted known custody", async () => {
  const files = [{ originalFilename: name, uploadFilename: name, originalMime: "application/zip", uploadMime: "application/zip",
    byteLength: bytes.length, sha256: sha, upload: "uploaded" }];
  const fingerprint = await inputFingerprint([{ filename: name, contentType: "application/zip", byteLength: bytes.length, sha256: sha }]);
  io.row.mockResolvedValue(page({ docID: "S100YF41", edinetDocType: 5, _fileManifest: { version: 1, files, inputFingerprint: fingerprint } }));
  expect((await readSavedEdinetZip("S100YF41", 5)).originalManifest).toBe("known");
  io.row.mockResolvedValue(page({ docID: "S100YF41", edinetDocType: 5, _fileManifest: { version: 1, files, inputFingerprint: "0".repeat(64) } }));
  await expect(readSavedEdinetZip("S100YF41", 5)).rejects.toBeInstanceOf(SavedEdinetZipQualificationError);
});
it.each(["wrong-key", "wrong-type", "missing-row"])("%s never falls back to a different source", async fault => {
  io.row.mockResolvedValue(fault === "missing-row" ? null : page({ docID: "S100YF41", edinetDocType: fault === "wrong-type" ? 1 : 5 }, fault === "wrong-key" ? "S100YF41:type1" : key));
  await expect(readSavedEdinetZip("S100YF41", 5)).rejects.toBeInstanceOf(SavedEdinetZipQualificationError);
  expect(io.download).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it("only an exact typed-key0 row in an existing canonical DB is missing", async () => {
  io.row.mockResolvedValue(null);
  await expect(readSavedEdinetZip("S100YF41", 5)).rejects.toBeInstanceOf(SavedEdinetZipMissingError);
  expect(io.download).not.toHaveBeenCalled();
  io.db.mockResolvedValue(null);
  const error = await readSavedEdinetZip("S100YF41", 5).then(() => null, error => error);
  expect(error).toBeInstanceOf(SavedEdinetZipQualificationError); expect(error).not.toBeInstanceOf(SavedEdinetZipMissingError);
});
it.each(["archived", "parent", "metadata-only"])("%s is never classified as a missing typed key", async fault => {
  const saved = page({ docID: "S100YF41", edinetDocType: 5 });
  if (fault === "archived") saved.archived = true;
  if (fault === "parent") saved.parent.database_id = "403d74ff84cd8120be71e7ec5a5f66f5";
  if (fault === "metadata-only") io.files.mockResolvedValue([]);
  io.row.mockResolvedValue(saved);
  const error = await readSavedEdinetZip("S100YF41", 5).then(() => null, error => error);
  expect(error).toBeInstanceOf(SavedEdinetZipQualificationError); expect(error).not.toBeInstanceOf(SavedEdinetZipMissingError);
  expect(io.download).not.toHaveBeenCalled();
});
