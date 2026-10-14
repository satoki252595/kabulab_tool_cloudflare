import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHoldingPriceSourceLoader } from "./holdings-price-sources.js";
import { readActivatedPriceSnapshot } from "../vwap/lib/holdings-price-registry.js";
import { downloadArchivedFile } from "../moneyflow/lib/archived-files.js";
import { notionRequest } from "../../src/shared/notion-archive/client.js";
import { parseHoldingsCodeList } from "../../services/yuho-quant/src/services/edinet/shareholdings-valuation.js";
import type { Shareholding } from "../../services/yuho-quant/src/services/edinet/shareholdings.js";
import type { PriceFile, PriceSnapshot } from "../../src/shared/holdings/price-registry.js";
vi.mock("../vwap/lib/holdings-price-registry.js", () => ({ readActivatedPriceSnapshot: vi.fn() }));
vi.mock("../moneyflow/lib/archived-files.js", () => ({ downloadArchivedFile: vi.fn() }));
vi.mock("../../src/shared/notion-archive/client.js", () => ({ notionRequest: vi.fn() }));
const hash = (body: Buffer) => createHash("sha256").update(body).digest("hex");
const zip = readFileSync(new URL("../../pipeline/tests/fixtures/edinet/Edinetcode.zip", import.meta.url));
const gzip = gzipSync(Buffer.from(JSON.stringify({ version: 1, members: [] })));
const file = (page: string, filename: string, body: Buffer): PriceFile => ({ archivePageId: page.repeat(32), filename, sha256: hash(body), byteLength: body.length });
const codeFile = file("a", "Edinetcode.zip", zip), priceFile = file("b", "raw.json.gz", gzip);
const catalog = parseHoldingsCodeList({ ...codeFile, bytes: zip });
const name = [...catalog.byLegalName.values()].flat().find(row => row.code === "7203")!.legalName;
const holding = { name, shares: 1 } as Shareholding;
const active: PriceSnapshot = { version: 1, snapshotId: "run.1", sessionDate: "2026-10-02", createdAt: "2026-10-04T12:00:00Z", codeList: codeFile,
  members: { "7203.T": { file: priceFile, symbol: "7203.T", receivedAt: "2026-10-04T10:00:00Z", bodySha256: "1".repeat(64), bodyBytes: 100 } } };
const text = (value: string) => ({ type: "rich_text", rich_text: [{ type: "text", plain_text: value, text: { content: value } }] });
function page(file: PriceFile) {
  return { object: "page", id: file.archivePageId, archived: false, in_trash: false,
    parent: { type: "database_id", database_id: "c".repeat(32) }, properties: { Status: { type: "select", select: { name: "recorded" } },
      Metadata: text(JSON.stringify({ _fileManifest: { version: 1, inputFingerprint: "3".repeat(64), files: [{ originalFilename: file.filename,
        uploadFilename: file.filename, byteLength: file.byteLength, sha256: file.sha256, upload: "uploaded" }] } })),
      Files: { type: "files", files: [{ name: file.filename, type: "file", file: { url: `https://file.notion.so/${file.filename}?signature=PRIVATE` } }] } } };
}
const budget = () => ({ remainingChunks: 116, remainingBytes: 256 * 1024 * 1024 });
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readActivatedPriceSnapshot).mockResolvedValue(active);
  vi.mocked(notionRequest).mockImplementation(async (_method, path) => page(path.endsWith(codeFile.archivePageId) ? codeFile : priceFile) as never);
  vi.mocked(downloadArchivedFile).mockImplementation(async file => file.name === codeFile.filename ? zip : gzip);
});
describe("通常Nodeの保存価格loader", () => {
  it("native manifest/fullSHAを照合し同じrunのchunkは一度だけ取得、明示memberとsnapshot範囲を返す", async () => {
    const loader = createHoldingPriceSourceLoader(), limit = budget();
    const first = await loader([holding], limit), second = await loader([holding], limit);
    expect(first).toEqual(second); expect(first).toMatchObject({ status: "ready", snapshotId: "run.1", evidenceScope: "snapshot run.1 内。その他保存観測の存在は未判定",
      prices: [{ sha256: priceFile.sha256, priceMembers: { "7203.T": { bodySha256: "1".repeat(64), bodyBytes: 100, receivedAt: active.members["7203.T"].receivedAt } } }] });
    expect(vi.mocked(readActivatedPriceSnapshot)).toHaveBeenCalledTimes(1); expect(notionRequest).toHaveBeenCalledTimes(2);
    expect(downloadArchivedFile).toHaveBeenCalledTimes(2); expect(limit.remainingChunks).toBe(115);
    expect(limit.remainingBytes).toBe(budget().remainingBytes - zip.length - gzip.length);
    expect(downloadArchivedFile).toHaveBeenLastCalledWith(expect.objectContaining({ name: priceFile.filename }), "保有価格保存原本", { maxBytes: gzip.length });
  });
  it("active無し・予算不足はheld、必要setを部分取得して価格原本不在へ変換しない", async () => {
    vi.mocked(readActivatedPriceSnapshot).mockResolvedValueOnce(null);
    expect(await createHoldingPriceSourceLoader()([holding], budget())).toMatchObject({ status: "held", reasonCode: "snapshot_unavailable" });
    expect(notionRequest).not.toHaveBeenCalled();
    const loader = createHoldingPriceSourceLoader(), limit = { remainingChunks: 0, remainingBytes: zip.length + gzip.length };
    expect(await loader([holding], limit)).toMatchObject({ status: "held", reasonCode: "budget_exhausted", reason: expect.stringContaining("全必要価格chunk") });
    expect(notionRequest).toHaveBeenCalledTimes(1); expect(downloadArchivedFile).toHaveBeenCalledTimes(1);
    limit.remainingChunks = 1;
    expect(await loader([holding], limit)).toMatchObject({ status: "ready" }); expect(downloadArchivedFile).toHaveBeenCalledTimes(2);
  });
  it("同定不可・株数NULL・snapshotに無いsymbolでは価格chunk GET0", async () => {
    const loader = createHoldingPriceSourceLoader();
    const result = await loader([{ ...holding, name: `${name}別主体` }, { ...holding, shares: null }], budget());
    expect(result).toMatchObject({ status: "ready", prices: [] }); expect(downloadArchivedFile).toHaveBeenCalledTimes(1);
    vi.mocked(readActivatedPriceSnapshot).mockResolvedValue({ ...active, members: {} });
    expect(await createHoldingPriceSourceLoader()([holding], budget())).toMatchObject({ status: "ready", prices: [] });
    expect(downloadArchivedFile).toHaveBeenCalledTimes(2);
  });
  it.each(["transport", "SHA"])("%s unknownは例外のまま同runで再送しない", async mode => {
    vi.mocked(downloadArchivedFile).mockImplementation(async file => {
      if (file.name === codeFile.filename) return zip;
      if (mode === "transport") throw new Error("transport unknown");
      return Buffer.from(gzip).fill(0);
    });
    const loader = createHoldingPriceSourceLoader(), limit = budget();
    await expect(loader([holding], limit)).rejects.toThrow();
    await expect(loader([holding], limit)).rejects.toThrow();
    expect(downloadArchivedFile).toHaveBeenCalledTimes(2); expect(limit.remainingChunks).toBe(115);
  });
  it.each(["external", "manifest", "trash", "truncated"])("native %sはhosted読取前にSTOP", async mode => {
    const invalid = page(codeFile);
    if (mode === "external") invalid.properties.Files.files[0].type = "external";
    if (mode === "manifest") invalid.properties.Metadata = text(JSON.stringify({ _fileManifest: { version: 1, inputFingerprint: "3".repeat(64), files: [] } }));
    if (mode === "trash") invalid.in_trash = true;
    if (mode === "truncated") Object.assign(invalid.properties.Metadata, { has_more: true });
    vi.mocked(notionRequest).mockResolvedValue(invalid);
    await expect(createHoldingPriceSourceLoader()([holding], budget())).rejects.toThrow();
    expect(downloadArchivedFile).not.toHaveBeenCalled();
  });
});
