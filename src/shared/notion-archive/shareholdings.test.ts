/** schema移行の保全と原表資格後の書込境界。原文をfixtureへ複製しない。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { ShareholdingsExtraction } from "../../../services/yuho-quant/src/services/edinet/shareholdings.js";
import { parseShareholdingsData, verifySavedHoldingsSource } from "../../../services/yuho-quant/src/services/edinet/shareholdings.js";
import { HoldingsPriceIndex, qualifyHoldingValuation } from "../../../services/yuho-quant/src/services/edinet/shareholdings-valuation.js";
import { queryUniqueRow } from "./archive.js";
import { notionRequest } from "./client.js";
import { verifyArchivedAttachments } from "./readback.js";
import { listPageFiles } from "./page-file.js";
import { applyHoldingsSchema, buildHoldingsSchemaPatch, HOLDINGS_DESCRIPTION, LEGACY_HOLDINGS_COLUMNS, publishSavedShareholdings, publishVerifiedShareholdings, resumePendingShareholdings, readSavedHoldingsZip, holdingProperties, type HoldingsSchema } from "./shareholdings.js";

vi.mock("../../../services/yuho-quant/src/services/edinet/shareholdings.js", () => ({ parseShareholdingsData: vi.fn(), verifySavedHoldingsSource: vi.fn(() => ({ status: "verified", filename: "structural.xbrl" })) }));
vi.mock("../../../services/yuho-quant/src/services/edinet/shareholdings-valuation.js", () => ({
  HoldingsPriceIndex: vi.fn(function () {}),
  parseHoldingsCodeList: vi.fn(() => ({ asOf: "2026-06-30", byLegalName: new Map() })), qualifyHoldingValuation: vi.fn(),
}));
vi.mock("./archive.js", () => ({ queryUniqueRow: vi.fn(), findUniqueBackupChildByTitle: vi.fn(async () => "p".repeat(32)) }));
vi.mock("./client.js", () => ({ notionRequest: vi.fn() }));
vi.mock("./readback.js", () => ({ verifyArchivedAttachments: vi.fn() }));
vi.mock("./page-file.js", () => ({ listPageFiles: vi.fn() }));
vi.mock("./env.js", () => ({ notionEnv: { NOTION_STOCK_HOLDINGS_DB_ID: () => "d".repeat(32), NOTION_ARCHIVE_PAGE_ID: () => "a".repeat(32) } }));

const source = { docId: "S100TEST", stockCode: "9999", edinetCode: "E99999", fiscalYearEnd: "2026-06-30" };
const holding: ShareholdingsExtraction["holdings"][number] = { name: "構造検証用銘柄", kind: "特定投資株式", shares: 12,
  sharesRaw: 12, sharesUnit: "株", bookValueRaw: 34, bookValueUnit: "千円", bookValueYen: 34000,
  listingStatus: "unknown", price: null, priceDate: null, priceCurrency: null, tableIndex: 0, rowIndex: 3 };
const extraction: ShareholdingsExtraction = { status: "ok", reason: null, source, filename: "XBRL/PublicDoc/structure.htm",
  elementId: "jpcrp_cor:ShareholdingsTextBlock", contextRef: "FilingDateInstant", holdings: [holding], holderScope: "filer_only" };
const args = { source, ownerName: "構造検証用提出者", zip: Buffer.from("構造境界検証。ZIP parserは別suite"), archivePageId: "a".repeat(32), maxRows: 20 };

function oldSchema(): HoldingsSchema {
  const properties: HoldingsSchema["properties"] = {};
  for (const [index, [name, , type]] of LEGACY_HOLDINGS_COLUMNS.entries()) properties[name] = { id: `old-${index}`, type,
    ...(type === "select" ? { select: { options: [
      { id: "listed", name: "上場", color: "blue" }, { id: "no-code", name: "非上場", color: "gray" },
    ] } } : {}) };
  return { id: "d".repeat(32), properties, description: [{ plain_text: "旧取込の説明" }] };
}

function migratedSchema(schema = oldSchema()): HoldingsSchema {
  const properties = structuredClone(schema.properties);
  const patch = buildHoldingsSchemaPatch(schema);
  for (const [key, raw] of Object.entries(patch.properties)) {
    const definition = raw as { name?: string; select?: HoldingsSchema["properties"][string]["select"] };
    if (definition.name) {
      const [name, old] = Object.entries(properties).find(([, value]) => value.id === key)!;
      properties[definition.name] = { ...old, ...(definition.select ? { select: definition.select } : {}) };
      delete properties[name];
    } else properties[key] = { id: `new-${key}`, type: Object.keys(definition)[0],
      ...(Object.keys(definition)[0] === "select" ? { select: { options: definition.select!.options.map((option, index) => ({ ...option, id: `opt-${index}` })) } } : {}),
      ...(Object.keys(definition)[0] === "formula" ? { formula: (definition as unknown as { formula: { expression: string } }).formula } : {}) };
  }
  return { id: schema.id, properties, description: [{ plain_text: HOLDINGS_DESCRIPTION }] };
}

function mirrored(properties: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(properties).map(([name, raw]) => {
    const value = raw as Record<string, unknown>;
    const type = Object.keys(value)[0];
    if (type === "title" || type === "rich_text") {
      const parts = value[type] as Array<{ text: { content: string } }>;
      return [name, { type, [type]: parts.map(p => ({ ...p, type: "text", plain_text: p.text.content })) }];
    }
    if (type === "date" && value.date !== null) return [name, { type, date: { ...(value.date as object), end: null, time_zone: null } }];
    return [name, { type, ...value }];
  }));
}

const legacy = Object.fromEntries(LEGACY_HOLDINGS_COLUMNS.map(([, name]) => [name, { type: "number", number: 777 }]));
let saved: Record<string, unknown>;
async function requestRouter(method: string, path: string, body?: unknown): Promise<unknown> {
  if (method === "GET" && path.startsWith("/databases/")) {
    if (path.includes("p".repeat(32))) return { id: "p".repeat(32), properties: {
      "保有明細状態": { type: "select" }, "保有明細理由": { type: "rich_text" }, "保有明細再開情報": { type: "rich_text" },
    } };
    return migratedSchema();
  }
  if (method === "PATCH") {
    saved[path] = (body as { properties: Record<string, unknown> }).properties;
    return { id: path.split("/").at(-1) };
  }
  if (method === "POST") { saved[`/pages/${"e".repeat(32)}`] = (body as { properties: Record<string, unknown> }).properties; return { id: "e".repeat(32) }; }
  const properties = saved[path] as Record<string, unknown> | undefined;
  return { id: path.split("/").at(-1), parent: { type: "database_id", database_id: (path.includes("a".repeat(32)) ? "p" : "d").repeat(32) },
    archived: false, in_trash: false, properties: { ...legacy, ...mirrored(holdingProperties(source,args.ownerName,holding)), Key: { type: "title", title: [{ type: "text", plain_text: `${source.docId}:type1`, text: { content: `${source.docId}:type1` } }] },
      ...(properties ? mirrored(properties) : {}) } };
}

beforeEach(() => { vi.clearAllMocks(); saved = {}; vi.mocked(parseShareholdingsData).mockReturnValue(structuredClone(extraction));
  vi.mocked(notionRequest).mockImplementation(requestRouter);
  vi.mocked(queryUniqueRow).mockResolvedValue(null); });

describe("株式保有の原典限定writer", () => {
  it("5旧列と分類option IDを維持し、新schemaは再実行でmutation不要", () => {
    const before = oldSchema(), snapshot = structuredClone(before);
    const patch = buildHoldingsSchemaPatch(before);
    expect(patch.properties["old-0"]).toEqual({ name: "旧分類（未検証）" });
    expect(Object.keys(patch.properties).filter(key => key.startsWith("old-"))).toHaveLength(5);
    expect(before).toEqual(snapshot);
    expect(buildHoldingsSchemaPatch(migratedSchema()).properties).toEqual({});
  });

  it("旧名の退避を読戻してから同名の正規列を作り、旧optionはID/名前とも保持する", async () => {
    const before = oldSchema(), renamed = structuredClone(before), after = migratedSchema(before);
    for (const [name, legacy] of LEGACY_HOLDINGS_COLUMNS) {
      renamed.properties[legacy] = renamed.properties[name]; delete renamed.properties[name];
    }
    vi.mocked(notionRequest).mockResolvedValueOnce(before).mockResolvedValueOnce({ id: before.id })
      .mockResolvedValueOnce(renamed).mockResolvedValueOnce({ id: before.id }).mockResolvedValueOnce(after);
    await expect(applyHoldingsSchema(before)).resolves.toEqual(after);
    const writes = vi.mocked(notionRequest).mock.calls.filter(([method]) => method === "PATCH");
    expect(Object.values((writes[0][2] as { properties: object }).properties)).toEqual(LEGACY_HOLDINGS_COLUMNS.map(([, name]) => ({ name })));
    expect((writes[1][2] as { properties: object }).properties).toHaveProperty("株価");
    expect((writes[1][2] as { description: unknown }).description).toEqual([{ type: "text", text: { content: HOLDINGS_DESCRIPTION } }]);
    expect(after.properties["旧分類（未検証）"].select).toEqual(before.properties["区分"].select);
  });

  it("schema PATCHの結果不明なら再送・読戻しへ進まない", async () => {
    const schema = oldSchema();
    vi.mocked(notionRequest).mockResolvedValueOnce(schema).mockRejectedValueOnce(new Error("ACK_UNKNOWN"));
    await expect(applyHoldingsSchema(schema)).rejects.toThrow("ACK_UNKNOWN");
    expect(notionRequest).toHaveBeenCalledTimes(2);
    expect(notionRequest).toHaveBeenLastCalledWith("PATCH", expect.any(String), expect.any(Object), { singleAttempt: true });
  });

  it.each(["no_detail_table", "unsupported"] as const)("原表が%sなら明細を書かず原本行に理由付きHOLDを保持", async status => {
    vi.mocked(parseShareholdingsData).mockReturnValue({ ...extraction, status, reason: "原表未対応", holdings: [] });
    expect(await publishVerifiedShareholdings(args)).toEqual({ status: "held", parsed: 0, reason: "原表未対応" });
    expect(queryUniqueRow).not.toHaveBeenCalled();
    expect(saved[`/pages/${args.archivePageId}`]).toMatchObject({ "保有明細状態": { select: { name: "要確認" } } });
  });

  it("数値表があっても提出会社の保有主体が未成立なら原本HOLDのみで、明細へ書かない", async () => {
    vi.mocked(parseShareholdingsData).mockReturnValue({ ...extraction, holderScope: "unqualified", reason: "名義別区画は対象外" });
    expect(await publishVerifiedShareholdings(args)).toEqual({ status: "held", parsed: 0, reason: "名義別区画は対象外" });
    expect(queryUniqueRow).not.toHaveBeenCalled();
    expect(vi.mocked(notionRequest).mock.calls.filter(([method, path]) => method === "POST" && path === "/pages")).toHaveLength(0);
    expect(Object.keys(saved)).toEqual([`/pages/${args.archivePageId}`]);
  });

  it("自然キーに保有種別を含め、異種別の既存行を更新しない", async () => {
    await publishVerifiedShareholdings(args);
    expect(queryUniqueRow).toHaveBeenCalledWith(expect.any(String), { and: expect.arrayContaining([
      { property: "保有種別", select: { equals: "特定投資株式" } },
    ]) }, expect.any(String));
    vi.mocked(queryUniqueRow).mockResolvedValue(await requestRouter("GET", `/pages/${"e".repeat(32)}`) as { id: string });
    vi.mocked(parseShareholdingsData).mockReturnValue({ ...extraction, holdings: [{ ...holding, kind: "みなし保有株式" }] });
    const before = structuredClone(saved);
    await expect(publishVerifiedShareholdings(args)).rejects.toThrow();
    expect(saved[`/pages/${"e".repeat(32)}`]).toEqual(before[`/pages/${"e".repeat(32)}`]);
  });

  it("run予算を超える通は一部だけ更新せず次runへ、残枠0なら解析しない", async () => {
    vi.mocked(parseShareholdingsData).mockReturnValue({ ...extraction, holdings: [holding, holding] });
    expect((await publishVerifiedShareholdings({ ...args, maxRows: 1 })).status).toBe("held");
    vi.mocked(parseShareholdingsData).mockClear();
    expect((await publishVerifiedShareholdings({ ...args, maxRows: 0 })).status).toBe("held");
    expect(parseShareholdingsData).not.toHaveBeenCalled();
    expect(queryUniqueRow).not.toHaveBeenCalled();
    expect(saved[`/pages/${args.archivePageId}`]).toMatchObject({ "保有明細状態": { select: { name: "再開待ち" } } });
  });

  it("株数・帳簿価額だけを確定し、価格/通貨/観測日を補わず、旧値を保つ", async () => {
    const existing = { id: "e".repeat(32), parent: { type: "database_id", database_id: "d".repeat(32) },
      archived: false, in_trash: false, properties: { ...legacy, ...mirrored(holdingProperties(source,args.ownerName,holding)), "原本照合済": { type: "checkbox", checkbox: false } } };
    vi.mocked(queryUniqueRow).mockResolvedValue(existing);
    expect(await publishVerifiedShareholdings(args)).toEqual({ status: "published", parsed: 1, created: 0, updated: 1, unchanged: 0 });
    const properties = saved[`/pages/${"e".repeat(32)}`] as Record<string, unknown>;
    expect(properties["保有株数"]).toEqual({ number: 12 });
    expect(properties["帳簿価額（円）"]).toEqual({ number: 34000 });
    expect(properties["株価"]).toEqual({ number: null });
    expect(properties["保有時価"]).toEqual({ number: null });
    expect(properties["通貨"]).toEqual({ rich_text: [] });
    expect(properties["基準日"]).toEqual({ date: null });
    expect(properties["区分"]).toEqual({ select: { name: "未確認" } });
    expect(LEGACY_HOLDINGS_COLUMNS.every(([, name]) => !Object.hasOwn(properties, name))).toBe(true);
    expect(verifyArchivedAttachments).not.toHaveBeenCalled();
  });

  it("書込結果不明なら後続行/readbackへ進まず、保存原本照合失敗ならwriterへ進まない", async () => {
    vi.mocked(notionRequest).mockImplementation(async (method, path, body) => {
      if (method === "POST") throw new Error("ACK_UNKNOWN");
      return requestRouter(method, path, body);
    });
    vi.mocked(queryUniqueRow).mockResolvedValue(null);
    await expect(publishVerifiedShareholdings(args)).rejects.toThrow("ACK_UNKNOWN");
    expect(notionRequest).toHaveBeenLastCalledWith("POST", "/pages", expect.any(Object), { singleAttempt: true });
    expect(saved[`/pages/${args.archivePageId}`]).toMatchObject({ "保有明細状態": { select: { name: "実行中（結果未確定）" } } });
    vi.clearAllMocks();
    vi.mocked(verifyArchivedAttachments).mockRejectedValueOnce(new Error("SOURCE_SHA_MISMATCH"));
    await expect(publishSavedShareholdings({ ...args, archivePageId: "f".repeat(32) })).rejects.toThrow("SOURCE_SHA_MISMATCH");
    expect(notionRequest).not.toHaveBeenCalled();
  });

  it("並行呼出でも最初の通信前に共有run枠を予約し、未知結果では返却しない", async () => {
    const budget = { remainingRows: 1 };
    const first = publishVerifiedShareholdings({ ...args, budget });
    expect(budget.remainingRows).toBe(0);
    const second = publishVerifiedShareholdings({ ...args, budget });
    expect((await first).status).toBe("published");
    expect((await second).status).toBe("held");
    expect(queryUniqueRow).toHaveBeenCalledTimes(1);
  });

  it("前回unknownは次定時にblind replayせず、原本GET/行書込も0", async () => {
    vi.mocked(notionRequest).mockImplementation(async (method, path, body) => method === "POST"
      ? { results: [{ id: args.archivePageId }], has_more: false, next_cursor: null }
      : requestRouter(method, path, body));
    await expect(resumePendingShareholdings({ maxRows: 100, shouldStop: () => false })).rejects.toThrow("結果未確定");
    expect(listPageFiles).not.toHaveBeenCalled();
    expect(queryUniqueRow).not.toHaveBeenCalled();
  });

  it("手動入口でも前回unknownを既知HOLDへ上書きせず、行書込へ進めない", async () => {
    vi.mocked(notionRequest).mockImplementation(async (method, path, body) => {
      const response = await requestRouter(method, path, body);
      if (method === "GET" && path === `/pages/${args.archivePageId}`) {
        const page = response as { properties: Record<string, unknown> };
        page.properties["保有明細状態"] = { type: "select", select: { name: "実行中（結果未確定）" } };
      }
      return response;
    });
    await expect(publishVerifiedShareholdings({ ...args, maxRows: 0 })).rejects.toThrow("前回結果が未確定");
    expect(notionRequest).not.toHaveBeenCalledWith("PATCH", expect.any(String), expect.anything(), expect.anything());
    expect(queryUniqueRow).not.toHaveBeenCalled();
  });

  it("EDINET済から独立した既知HOLDを保存hosted ZIPのSHA照合後に優先再開する", async () => {
    const info = { source, ownerName: args.ownerName, zipBytes: args.zip.length,
      zipSha256: createHash("sha256").update(args.zip).digest("hex"), parsed: 1 };
    vi.mocked(notionRequest).mockImplementation(async (method, path, body) => {
      if (method === "POST" && path.endsWith("/query")) {
        const status = (body as { filter: { select: { equals: string } } }).filter.select.equals;
        return { results: status === "再開待ち" ? [{ id: args.archivePageId, archived: false, in_trash: false,
          properties: mirrored({ "保有明細再開情報": { rich_text: [{ text: { content: JSON.stringify(info) } }] } }) }] : [], has_more: false, next_cursor: null };
      }
      return requestRouter(method, path, body);
    });
    vi.mocked(listPageFiles).mockResolvedValue([{ name: `${source.docId}_xbrl.zip`, kind: "file", url: "https://hosted.invalid/saved-only" }]);
    const native = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(Uint8Array.from(args.zip)));
    try {
      expect(await resumePendingShareholdings({ maxRows: 100, shouldStop: () => false })).toEqual({ usedRows: 1, resumed: 1, held: 0, pending: false });
      expect(native).toHaveBeenCalledTimes(1);
      expect(native.mock.calls[0][0]).toBe("https://hosted.invalid/saved-only");
      expect(verifyArchivedAttachments).not.toHaveBeenCalled();
    } finally { native.mockRestore(); }
  });

  it("原本照合済の株数へ同日価格根拠だけを追記し、後の原本未指定で価格を消さない", async () => {
    await publishVerifiedShareholdings(args);
    const rowPath = `/pages/${"e".repeat(32)}`;
    vi.mocked(queryUniqueRow).mockImplementation(async () => await requestRouter("GET", rowPath) as { id: string });
    const identity = { code: "9999", edinetCode: "E99999", corporateNumber: "1".repeat(13), legalName: holding.name,
      englishName: "STRUCTURAL", asOf: source.fiscalYearEnd, row: 3, archivePageId: "1".repeat(32), zipSha256: "2".repeat(64) };
    vi.mocked(qualifyHoldingValuation).mockResolvedValue({ status: "qualified", identity, price: 100, value: 1200, currency: "JPY", date: source.fiscalYearEnd,
      priceSource: { archivePageId: "3".repeat(32), gzipSha256: "4".repeat(64), bodySha256: "5".repeat(64), filename: "structure.gz", symbol: "9999.T",
        capturedAt: "2026-07-01T00:00:00Z", sourceTimestamp: 1782777600, range: "10y", priceBasis: "STRUCTURAL", splitObservation: "STRUCTURAL" } });
    const evidence = { archivePageId: "1".repeat(32), filename: "structure", bytes: Buffer.alloc(0), sha256: "2".repeat(64) };
    const result = await publishVerifiedShareholdings({ ...args, valuationSources: { codeList: evidence, prices: [evidence] } });
    expect(result).toMatchObject({ status: "published", updated: 1 });
    expect(saved[rowPath]).toMatchObject({ "株価": { number: 100 }, "保有時価": { number: 1200 }, "基準日": { date: { start: source.fiscalYearEnd } }, "価格照合済": { checkbox: true } });
    const priced = structuredClone(saved[rowPath]);
    expect(await publishVerifiedShareholdings(args)).toMatchObject({ status: "published", unchanged: 1 });
    expect(saved[rowPath]).toEqual(priced);
  });

  it("同一通の全明細で価格indexを共有し、後続の原本資格失敗なら行を書き始めない", async () => {
    vi.mocked(parseShareholdingsData).mockReturnValue({ ...extraction, holdings: [holding, { ...holding, rowIndex: 4 }] });
    vi.mocked(qualifyHoldingValuation).mockResolvedValueOnce({ status: "unavailable", identity: null, reason: "保存価格なし" })
      .mockRejectedValueOnce(new Error("SOURCE_SHA_MISMATCH"));
    const evidence = { archivePageId: "1".repeat(32), filename: "structure", bytes: Buffer.alloc(0), sha256: "2".repeat(64) };
    const prices = [evidence];
    await expect(publishVerifiedShareholdings({ ...args, valuationSources: { codeList: evidence, prices } })).rejects.toThrow("SOURCE_SHA_MISMATCH");
    expect(HoldingsPriceIndex).toHaveBeenCalledTimes(1);
    expect(HoldingsPriceIndex).toHaveBeenCalledWith(prices);
    const calls = vi.mocked(qualifyHoldingValuation).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0].prices).toBe(calls[1][0].prices);
    expect(calls[0][0].prices).toBeInstanceOf(HoldingsPriceIndex);
    expect(notionRequest).not.toHaveBeenCalled();
    expect(queryUniqueRow).not.toHaveBeenCalled();
  });
});


describe("保有明細の現行/legacy保存type1 reader", () => {
  function primary(key: string, changes: Record<string, unknown> = {}) {
    const metadata = { docID: source.docId, edinetCode: source.edinetCode, secCode: `${source.stockCode}0`, periodEnd: source.fiscalYearEnd,
      ...(key.endsWith(":type1") ? { edinetDocType: 1 } : {}), _fileManifest: { files: [{ originalFilename: `${source.docId}_xbrl.zip`, byteLength: args.zip.length,
        sha256: createHash("sha256").update(args.zip).digest("hex") }] }, ...changes };
    return { id: "b".repeat(32), parent: { type: "database_id", database_id: "p".repeat(32) }, archived: false, in_trash: false,
      properties: mirrored({ Key: { title: [{ text: { content: key } }] }, Metadata: { rich_text: [{ text: { content: JSON.stringify(metadata) } }] }, "Fetched At": { date: { start: "2026-07-01T00:00:00Z" } } }) };
  }
  beforeEach(() => { vi.mocked(listPageFiles).mockResolvedValue([{ name: `${source.docId}_xbrl.zip`, kind: "file", url: "https://hosted.invalid/type1" }]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(Uint8Array.from(args.zip))); });
  afterEach(() => vi.restoreAllMocks());
  it("現行keyがあればlegacyを読まず、完全なmetadata/DEI/SHAを照合する", async () => {
    vi.mocked(queryUniqueRow).mockResolvedValue(primary(`${source.docId}:type1`));
    expect(await readSavedHoldingsZip(source)).toMatchObject({ status: "ready", sourceCustody: "typed", originalManifest: "known" });
    expect(queryUniqueRow).toHaveBeenCalledTimes(1);expect(verifySavedHoldingsSource).toHaveBeenCalledWith(args.zip, source);
    expect(notionRequest).not.toHaveBeenCalled();
  });
  it("現行不在時だけlegacy bare keyのtype1を明示採用し、同居CSVを使わない", async () => {
    vi.mocked(queryUniqueRow).mockResolvedValueOnce(null).mockResolvedValueOnce(primary(source.docId));
    vi.mocked(listPageFiles).mockResolvedValue([{ name: `${source.docId}_csv.zip`, kind: "file", url: "https://hosted.invalid/csv" }, { name: `${source.docId}_xbrl.zip`, kind: "file", url: "https://hosted.invalid/type1" }]);
    expect(await readSavedHoldingsZip(source)).toMatchObject({ status: "ready", sourceCustody: "legacy", archivePageId: "b".repeat(32) });
    expect(queryUniqueRow).toHaveBeenCalledTimes(2);expect(fetch).toHaveBeenCalledTimes(1);expect(vi.mocked(fetch).mock.calls[0][0]).toBe("https://hosted.invalid/type1");
  });
  it("manual primaryのissuer/期末metadata欠測はDEIへ束縛して欠測一覧を残す", async () => {
    vi.mocked(queryUniqueRow).mockResolvedValue(primary(`${source.docId}:type1`, { edinetCode: undefined, periodEnd: undefined, secCode: undefined, stockCode: source.stockCode, rawSecCode: `${source.stockCode}0`, sourceZIPSHA: createHash("sha256").update(args.zip).digest("hex"), sourceZIPBytes: args.zip.length }));
    expect(await readSavedHoldingsZip(source)).toMatchObject({ status: "ready", metadataMissing: ["edinetCode", "periodEnd"] });
    expect(verifySavedHoldingsSource).toHaveBeenCalledWith(args.zip, source);
  });
  it("docID欠測はKey/添付名だけで資格化せず理由HOLD、存在する矛盾は従来STOP", async () => {
    vi.mocked(queryUniqueRow).mockResolvedValue(primary(`${source.docId}:type1`, { docID: undefined }));
    expect(await readSavedHoldingsZip(source)).toMatchObject({ status: "held", reason: expect.stringContaining("metadataにdocIDがなく") });
    expect(verifySavedHoldingsSource).not.toHaveBeenCalled();
    expect(notionRequest).not.toHaveBeenCalled();
    vi.mocked(queryUniqueRow).mockResolvedValue(primary(`${source.docId}:type1`, { docID: "S100YC5I" }));
    await expect(readSavedHoldingsZip(source)).rejects.toThrow();
  });
  it("metadataの非0不正codeや矛盾した保存SHAは許容しない", async () => {
    for (const changes of [{ rawSecCode: "00005" }, { sourceZIPSHA: "0".repeat(64) }]) {
      vi.mocked(queryUniqueRow).mockResolvedValue(primary(`${source.docId}:type1`, changes));
      await expect(readSavedHoldingsZip(source)).rejects.toThrow();
    }
  });
  it("壊れた現行添付をlegacyで救済せず、CSV-onlyも未提供とは断定しない", async () => {
    vi.mocked(queryUniqueRow).mockResolvedValue(primary(`${source.docId}:type1`));vi.mocked(listPageFiles).mockResolvedValue([{ name: `${source.docId}_csv.zip`, kind: "file", url: "https://hosted.invalid/csv" }]);
    expect((await readSavedHoldingsZip(source)).status).toBe("held");expect(queryUniqueRow).toHaveBeenCalledTimes(1);expect(fetch).not.toHaveBeenCalled();
    vi.mocked(queryUniqueRow).mockResolvedValue(null);const missing = await readSavedHoldingsZip(source);expect(missing).toMatchObject({ status: "held", reason: expect.stringContaining("公式の原本未提供とは未判定") });
  });
  it.each([{ edinetCode: "E00000" }, { periodEnd: "2025-06-30" }, { _fileManifest: { files: [{ originalFilename: `${source.docId}_xbrl.zip`, byteLength: args.zip.length, sha256: "0".repeat(64) }] } }])("提出者/期末/全SHA不一致はSTOP", async changes => {
    vi.mocked(queryUniqueRow).mockResolvedValue(primary(`${source.docId}:type1`, changes));await expect(readSavedHoldingsZip(source)).rejects.toThrow();expect(queryUniqueRow).toHaveBeenCalledTimes(1);
  });
});
