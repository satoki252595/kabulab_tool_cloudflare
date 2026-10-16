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
import * as codeLists from "./holdings-code-list.js";
import * as issuerNames from "./holdings-issuer-names.js";
vi.mock("../vwap/lib/holdings-price-registry.js", () => ({ readActivatedPriceSnapshot: vi.fn() }));
vi.mock("../moneyflow/lib/archived-files.js", () => ({ downloadArchivedFile: vi.fn() }));
vi.mock("../../src/shared/notion-archive/client.js", async original => ({ ...await original<typeof import("../../src/shared/notion-archive/client.js")>(), notionRequest: vi.fn() }));
const hash = (body: Buffer) => createHash("sha256").update(body).digest("hex");
const zip = readFileSync(new URL("../../pipeline/tests/fixtures/edinet/Edinetcode.zip", import.meta.url));
// 構造検証専用chart。実価格原本はprivateの純local再現で別に全SHAを検証する。
const raw = Buffer.from(JSON.stringify({ chart: { result: [{ meta: { symbol: "7203.T", range: "10y", currency: "JPY", exchangeTimezoneName: "Asia/Tokyo",
  longName: "TOYOTA MOTOR CORPORATION", regularMarketPrice: 100, regularMarketTime: Date.parse("2026-10-02T00:00:00Z") / 1000 },
  timestamp: [Date.parse("2026-10-01T00:00:00Z") / 1000, Date.parse("2026-10-02T00:00:00Z") / 1000],
  indicators: { quote: [{ open: [100, 100], high: [100, 100], low: [100, 100], close: [100, 100], volume: [1, 1] }] } }], error: null } }));
const member = { api: "daily", symbol: "7203.T", status: 200, receivedAt: "2026-10-04T10:00:00Z", byteLength: raw.length,
  sha256: hash(raw), bodyBase64: raw.toString("base64"), url: "https://query1.finance.yahoo.com/v8/finance/chart/7203.T?range=10y&interval=1d&events=split,div" };
const gzip = gzipSync(Buffer.from(JSON.stringify({ version: 1, members: [member] })));
const file = (page: string, filename: string, body: Buffer): PriceFile => ({ archivePageId: page.repeat(32), filename, sha256: hash(body), byteLength: body.length });
const codeFile = file("a", "Edinetcode.zip", zip), priceFile = file("b", "raw.json.gz", gzip);
const catalog = parseHoldingsCodeList({ ...codeFile, bytes: zip });
const name = [...catalog.byLegalName.values()].flat().find(row => row.code === "7203")!.legalName;
const holding = { name, shares: 1 } as Shareholding;
const active: PriceSnapshot = { version: 1, snapshotId: "run.1", sessionDate: "2026-10-02", createdAt: "2026-10-04T12:00:00Z", codeList: codeFile,
  members: { "7203.T": { file: priceFile, symbol: "7203.T", receivedAt: "2026-10-04T10:00:00Z", bodySha256: hash(raw), bodyBytes: raw.length } } };
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
    expect(second).toMatchObject({ status: "ready", prices: first.status === "ready" ? first.prices : [] }); expect(first).toMatchObject({ status: "ready", snapshotId: "run.1", evidenceScope: "snapshot run.1 内。その他保存観測の存在は未判定",
      prices: [{ sha256: priceFile.sha256, priceMembers: { "7203.T": { bodySha256: hash(raw), bodyBytes: raw.length, receivedAt: active.members["7203.T"].receivedAt } } }] });
    expect(vi.mocked(readActivatedPriceSnapshot)).toHaveBeenCalledTimes(1); expect(notionRequest).toHaveBeenCalledTimes(2);
    expect(downloadArchivedFile).toHaveBeenCalledTimes(2); expect(limit.remainingChunks).toBe(115);
    expect(limit.remainingBytes).toBe(budget().remainingBytes - zip.length - gzip.length);
    expect(downloadArchivedFile).toHaveBeenLastCalledWith(expect.objectContaining({ name: priceFile.filename }), "保有価格保存原本", { maxBytes: gzip.length });
  });
  it("商号集合の構築は原本/chart資格後・writer前だけ行い、同じindexとfresh gateを渡す", async () => {
    const changed = JSON.parse(raw.toString()); changed.chart.result[0].meta.longName = "OFFICIAL ALIAS STRUCTURE";
    const body = Buffer.from(JSON.stringify(changed)), observed = { ...member, bodyBase64: body.toString("base64"), sha256: hash(body), byteLength: body.length };
    const compressed = gzipSync(Buffer.from(JSON.stringify({ version: 1, members: [observed] }))), savedFile = file("b", "raw.json.gz", compressed);
    vi.mocked(readActivatedPriceSnapshot).mockResolvedValue({ ...active, members: { "7203.T": { ...active.members["7203.T"], file: savedFile, bodySha256: observed.sha256, bodyBytes: body.length } } });
    vi.mocked(notionRequest).mockImplementation(async (_method,path) => page(path.endsWith(codeFile.archivePageId) ? codeFile : savedFile) as never);
    vi.mocked(downloadArchivedFile).mockImplementation(async saved => saved.name === codeFile.filename ? zip : compressed);
    const checkCurrent = vi.fn(async () => ({ status: "verified" as const }));
    const readNames = vi.fn(async () => ({ status: "ready" as const, names: new Map(), checkCurrent }));
    const factory = vi.spyOn(issuerNames,"createHoldingOfficialNamesLoader").mockReturnValue(readNames);
    try {
      const limit = budget(), shouldStop = () => false, result = await createHoldingPriceSourceLoader()([holding],limit,shouldStop);
      expect(result.status).toBe("ready"); if (result.status !== "ready") throw new Error(result.reason);
      expect(readNames).toHaveBeenCalledWith([{ identity: expect.objectContaining({ code: "7203" }), priceCapturedAt: member.receivedAt }],limit,shouldStop);
      result.priceIndex.assertSources(result.prices); expect(result.checkOfficialIssuerNames).toBe(checkCurrent);
      expect(downloadArchivedFile).toHaveBeenCalledTimes(2);
      readNames.mockResolvedValueOnce({ status: "held", reasonCode: "issuer_source_unavailable", reason: "公式根拠なし" } as never);
      expect(await createHoldingPriceSourceLoader()([holding],budget())).toMatchObject({ status: "held", reasonCode: "issuer_source_unavailable" });
    } finally { factory.mockRestore(); }
  });
  it("canonical一致でもsplit観測だけ既存issuer loaderを使い、期末後splitの既知保留には追加issuer GET0", async () => {
    const changed = JSON.parse(raw.toString());
    changed.chart.result[0].events = { splits: { split: { date: Date.parse("2026-10-01T00:00:00Z") / 1000, numerator: 5, denominator: 1 } } };
    const body = Buffer.from(JSON.stringify(changed)), observed = { ...member, bodyBase64: body.toString("base64"), sha256: hash(body), byteLength: body.length };
    const compressed = gzipSync(Buffer.from(JSON.stringify({ version: 1, members: [observed] }))), savedFile = file("b", "raw.json.gz", compressed);
    vi.mocked(readActivatedPriceSnapshot).mockResolvedValue({ ...active, members: { "7203.T": { ...active.members["7203.T"], file: savedFile, bodySha256: observed.sha256, bodyBytes: body.length } } });
    vi.mocked(notionRequest).mockImplementation(async (_method, path) => page(path.endsWith(codeFile.archivePageId) ? codeFile : savedFile) as never);
    vi.mocked(downloadArchivedFile).mockImplementation(async saved => saved.name === codeFile.filename ? zip : compressed);
    const checkCurrent = vi.fn(async () => ({ status: "verified" as const }));
    const readNames = vi.fn(async () => ({ status: "ready" as const, names: new Map(), checkCurrent }));
    const factory = vi.spyOn(issuerNames, "createHoldingOfficialNamesLoader").mockReturnValue(readNames);
    try {
      const loader = createHoldingPriceSourceLoader(), limit = budget(), shouldStop = () => false;
      expect((await loader([holding], limit, shouldStop, "2026-10-01")).status).toBe("ready");
      expect(readNames).toHaveBeenLastCalledWith([{ identity: expect.objectContaining({ code: "7203" }), priceCapturedAt: member.receivedAt }], limit, shouldStop);
      expect((await loader([holding], limit, shouldStop, "2026-09-30")).status).toBe("ready");
      expect(readNames).toHaveBeenLastCalledWith([], limit, shouldStop);
      expect(downloadArchivedFile).toHaveBeenCalledTimes(2);
    } finally { factory.mockRestore(); }
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
  it("codeListのcapture bytesもrun予算へ数え、known budgetだけ再開しunknownは再送しない", async () => {
    const read = vi.spyOn(codeLists, "readVerifiedHoldingsCodeList");
    read.mockRejectedValueOnce(new codeLists.HoldingsCodeListBudgetError("capture budget"));
    const loader = createHoldingPriceSourceLoader(), limit = budget();
    expect(await loader([holding], limit)).toMatchObject({ status: "held", reasonCode: "budget_exhausted" });
    expect(limit.remainingBytes).toBe(budget().remainingBytes);
    read.mockResolvedValue({ source: { ...codeFile, bytes: zip }, asOf: catalog.asOf, readBytes: zip.length + 100 });
    expect(await loader([holding], limit)).toMatchObject({ status: "ready" });
    expect(limit.remainingBytes).toBe(budget().remainingBytes - zip.length - 100 - gzip.length);
    read.mockRestore();
  });
  it("価格gzipの単一物理添付guardは2fileを許容しない", async () => {
    vi.mocked(notionRequest).mockImplementation(async (_method, path) => {
      if (path.endsWith(codeFile.archivePageId)) return page(codeFile) as never;
      const invalid = page(priceFile); invalid.properties.Files.files.push({ ...invalid.properties.Files.files[0], name: "extra.json" });
      return invalid as never;
    });
    await expect(createHoldingPriceSourceLoader()([holding], budget())).rejects.toThrow();
    expect(downloadArchivedFile).toHaveBeenCalledTimes(1);
  });
});
