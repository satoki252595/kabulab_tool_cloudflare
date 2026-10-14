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
import { applyHoldingsSchema, buildHoldingsSchemaPatch, HOLDINGS_DESCRIPTION, LEGACY_HOLDINGS_COLUMNS, publishSavedShareholdings, publishVerifiedShareholdings, resumePendingShareholdings, resumePendingShareholdingsPrices, readSavedHoldingsZip, holdingProperties, holdingsFactsSha256, type HoldingsSchema, type HoldingPriceSourceLoader } from "./shareholdings.js";

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
type TestProperties = Record<string, { select?: { name: string }; rich_text?: Array<{ text: { content: string } }> }>;
type TestPage = { object: string; id: string; parent: { type: string; database_id: string }; archived: boolean; in_trash: boolean; properties: TestProperties };
const testProperties = (value: unknown) => value as TestProperties;
const pageProperties = (value: unknown) => (value as { properties: TestProperties }).properties;
const restartInfo = (value: unknown, phase = "保有明細") => JSON.parse(testProperties(value)[`${phase}再開情報`].rich_text!.map(p => p.text.content).join("")) as Record<string, unknown>;
async function requestRouter(method: string, path: string, body?: unknown): Promise<unknown> {
  if (method === "GET" && path.startsWith("/databases/")) {
    if (path.includes("p".repeat(32))) return { id: "p".repeat(32), properties: {
      "保有明細状態": { type: "select" }, "保有明細理由": { type: "rich_text" }, "保有明細再開情報": { type: "rich_text" },
      "保有価格状態": { type: "select" }, "保有価格理由": { type: "rich_text" }, "保有価格再開情報": { type: "rich_text" },
    } };
    return migratedSchema();
  }
  if (method === "PATCH") {
    saved[path] = { ...(saved[path] as object), ...(body as { properties: Record<string, unknown> }).properties };
    return { object: path.startsWith("/databases/") ? "database" : "page", id: path.split("/").at(-1) };
  }
  if (method === "POST") { saved[`/pages/${"e".repeat(32)}`] = (body as { properties: Record<string, unknown> }).properties; return { object: "page", id: "e".repeat(32) }; }
  const properties = saved[path] as Record<string, unknown> | undefined;
  return { object: "page", id: path.split("/").at(-1), parent: { type: "database_id", database_id: (path.includes("a".repeat(32)) ? "p" : "d").repeat(32) },
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

  it("残枠0でも全原表を固定してcursor0を明示し、明細は書かない", async () => {
    expect((await publishVerifiedShareholdings({ ...args, maxRows: 0 })).status).toBe("held");
    expect(parseShareholdingsData).toHaveBeenCalledTimes(1);
    expect(queryUniqueRow).not.toHaveBeenCalled();
    expect(saved[`/pages/${args.archivePageId}`]).toMatchObject({ "保有明細状態": { select: { name: "再開待ち" } } });
    expect(restartInfo(saved[`/pages/${args.archivePageId}`])).toMatchObject({ sourceQueueVersion: 1, sourceNextHoldingOffset: 0, parsed: 1, factsSha256: holdingsFactsSha256([holding]) });
  });

  it("株数・帳簿価額だけを確定し、価格/通貨/観測日を補わず、旧値を保つ", async () => {
    const existing = { object: "page", id: "e".repeat(32), parent: { type: "database_id", database_id: "d".repeat(32) },
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
    vi.mocked(notionRequest).mockImplementation(async (method, path, body) => {
      const result = await requestRouter(method, path, body);
      if (method === "GET" && path === `/pages/${"c".repeat(32)}`) (result as TestPage).parent.database_id = "p".repeat(32);
      return result;
    });
    const budget = { remainingRows: 1 };
    const first = publishVerifiedShareholdings({ ...args, budget });
    expect(budget.remainingRows).toBe(0);
    const second = publishVerifiedShareholdings({ ...args, archivePageId: "c".repeat(32), budget });
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
    await publishVerifiedShareholdings({ ...args, maxRows: 0 });
    const info = { source, ownerName: args.ownerName, zipBytes: args.zip.length,
      zipSha256: createHash("sha256").update(args.zip).digest("hex"), parsed: 1, sourceQueueVersion: 1, sourceNextHoldingOffset: 0, factsSha256: holdingsFactsSha256([holding]) };
    vi.mocked(queryUniqueRow).mockImplementation(async dbId => dbId === "p".repeat(32) ? {
      ...(await requestRouter("GET", `/pages/${args.archivePageId}`) as TestPage), properties: {
        ...pageProperties(await requestRouter("GET", `/pages/${args.archivePageId}`)),
        ...mirrored({ Metadata: { rich_text: [{ text: { content: JSON.stringify({ docID: source.docId, secCode: `${source.stockCode}0`, edinetCode: source.edinetCode, periodEnd: source.fiscalYearEnd, edinetDocType: 1 }) } }] }, "Fetched At": { date: { start: "2026-07-01T00:00:00Z" } } }),
      },
    } : null);
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
    expect(await publishVerifiedShareholdings(args)).toMatchObject({ status: "published", parsed: 0, unchanged: 0 });
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
    expect(vi.mocked(notionRequest).mock.calls.every(([method]) => method === "GET")).toBe(true);
    expect(queryUniqueRow).not.toHaveBeenCalled();
  });
});


describe("保有明細の現行/legacy保存type1 reader", () => {
  function primary(key: string, changes: Record<string, unknown> = {}) {
    const metadata = { docID: source.docId, edinetCode: source.edinetCode, secCode: `${source.stockCode}0`, periodEnd: source.fiscalYearEnd,
      ...(key.endsWith(":type1") ? { edinetDocType: 1 } : {}), _fileManifest: { files: [{ originalFilename: `${source.docId}_xbrl.zip`, byteLength: args.zip.length,
        sha256: createHash("sha256").update(args.zip).digest("hex") }] }, ...changes };
    return { object: "page", id: "b".repeat(32), parent: { type: "database_id", database_id: "p".repeat(32) }, archived: false, in_trash: false,
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

describe("全原表へ束縛するsource有限window", () => {
  const holdings = [holding, { ...holding, kind: "みなし保有株式" as const, rowIndex: 4 }];
  const sourcePath = `/pages/${args.archivePageId}`;
  const info = () => ({ source, ownerName: args.ownerName, zipBytes: args.zip.length,
    zipSha256: createHash("sha256").update(args.zip).digest("hex"), parsed: holdings.length,
    factsSha256: holdingsFactsSha256(holdings), sourceQueueVersion: 1, sourceNextHoldingOffset: 0 });
  const savedInfo = () => restartInfo(saved[sourcePath]);

  function windowRouter() {
    const rows: Record<string, TestPage> = {};
    vi.mocked(parseShareholdingsData).mockReturnValue({ ...extraction, holdings });
    vi.mocked(queryUniqueRow).mockImplementation(async (dbId, filter) => {
      if (dbId === "p".repeat(32)) {
        const page = await requestRouter("GET", sourcePath) as TestPage;
        return { ...page, properties: { ...page.properties, ...mirrored({
          Metadata: { rich_text: [{ text: { content: JSON.stringify({ docID: source.docId, edinetCode: source.edinetCode,
            secCode: `${source.stockCode}0`, periodEnd: source.fiscalYearEnd, edinetDocType: 1 }) } }] },
          "Fetched At": { date: { start: "2026-07-01T00:00:00Z" } },
        }) } };
      }
      const kind = (filter as { and: Array<{ property: string; select?: { equals: string } }> }).and.find(p => p.property === "保有種別")!.select!.equals;
      return Object.values(rows).find(p => p.properties["保有種別"].select!.name === kind) ?? null;
    });
    vi.mocked(notionRequest).mockImplementation(async (method, path, body) => {
      if (method === "POST" && path === "/pages") {
        const pageId = (Object.keys(rows).length === 0 ? "e" : "f").repeat(32);
        rows[`/pages/${pageId}`] = { object: "page", id: pageId, parent: { type: "database_id", database_id: "d".repeat(32) },
          archived: false, in_trash: false, properties: testProperties(mirrored((body as { properties: Record<string, unknown> }).properties)) };
        return { object: "page", id: pageId };
      }
      if (rows[path]) return structuredClone(rows[path]);
      if (method === "POST" && path.endsWith("/query")) {
        const page = await requestRouter("GET", sourcePath) as TestPage, status = (body as { filter: { select: { equals: string } } }).filter.select.equals;
        return { results: page.properties["保有明細状態"]?.select?.name === status ? [page] : [], has_more: false, next_cursor: null };
      }
      return requestRouter(method, path, body);
    });
    return rows;
  }
  afterEach(() => vi.restoreAllMocks());

  it("各windowの全読戻し後だけsource cursorが進み、最後だけ価格pendingを同時登録する", async () => {
    const rows = windowRouter();
    const first = await publishVerifiedShareholdings({ ...args, maxRows: 1 });
    expect(first).toMatchObject({ status: "held", parsed: 2, usedRows: 1, pending: true });
    expect(savedInfo()).toMatchObject({ ...info(), sourceNextHoldingOffset: 1 });
    expect(testProperties(saved[sourcePath])["保有明細状態"]).toEqual({ select: { name: "再開待ち" } });
    expect(testProperties(saved[sourcePath])["保有価格状態"]).toBeUndefined();
    const second = await publishVerifiedShareholdings({ ...args, maxRows: 1 });
    expect(second).toMatchObject({ status: "published", parsed: 1, created: 1 });
    expect(Object.keys(rows)).toHaveLength(2);
    expect(savedInfo()).toMatchObject({ ...info(), sourceNextHoldingOffset: 2 });
    expect(testProperties(saved[sourcePath])["保有明細状態"]).toEqual({ select: { name: "明細原本照合済" } });
    const price = restartInfo(saved[sourcePath], "保有価格");
    expect(price).toMatchObject({ parsed: 2, factsSha256: info().factsSha256, priceQueueVersion: 1, nextHoldingOffset: 0 });
    expect(price).not.toHaveProperty("sourceNextHoldingOffset");
    expect(price).not.toHaveProperty("sourceQueueVersion");
    const calls = vi.mocked(notionRequest).mock.calls;
    const firstRowRead = calls.findIndex(([method, path]) => method === "GET" && path === `/pages/${"e".repeat(32)}`);
    const firstCursorAdvance = calls.findIndex(([method, path, body]) => method === "PATCH" && path === sourcePath && pageProperties(body)["保有明細状態"].select!.name === "再開待ち");
    expect(firstCursorAdvance).toBeGreaterThan(firstRowRead);
  });

  it("通全体の順序/facts変更は次windowの書込前にSTOPする", async () => {
    windowRouter(); await publishVerifiedShareholdings({ ...args, maxRows: 1 });
    vi.mocked(queryUniqueRow).mockClear();
    vi.mocked(parseShareholdingsData).mockReturnValue({ ...extraction, holdings: [...holdings].reverse() });
    await expect(publishVerifiedShareholdings({ ...args, maxRows: 1 })).rejects.toThrow("全facts/order");
    expect(queryUniqueRow).not.toHaveBeenCalled();
    expect(savedInfo().sourceNextHoldingOffset).toBe(1);
  });

  it.each(["rotation", "different-object", "different-version"] as const)("Filesの%sを全source CASで検査し、再署名だけを許容する", async change => {
    windowRouter(); const route = vi.mocked(notionRequest).getMockImplementation()!; let reads = 0;
    vi.mocked(notionRequest).mockImplementation(async (method, path, body, options) => {
      const response = await route(method, path, body, options);
      if (method === "GET" && path === sourcePath) {
        const n = ++reads, object = change === "different-object" && n > 1 ? "changed-object" : "same-object";
        const version = change === "different-version" && n > 1 ? "v2" : "v1";
        (response as { properties: Record<string, unknown> }).properties.Files = { type: "files", files: [{ name: `${source.docId}_xbrl.zip`, type: "file",
          file: { url: `https://prod-files-secure.s3.us-west-2.amazonaws.com/${object}?versionId=${version}&X-Amz-Date=${n}&X-Amz-Signature=${n}`, expiry_time: String(n) } }] };
      }
      return response;
    });
    if (change === "rotation") {
      expect(await publishVerifiedShareholdings({ ...args, maxRows: 1 })).toMatchObject({ status: "held", usedRows: 1, pending: true });
      expect(savedInfo().sourceNextHoldingOffset).toBe(1);
    } else {
      await expect(publishVerifiedShareholdings({ ...args, maxRows: 1 })).rejects.toThrow("全props");
      expect(queryUniqueRow).not.toHaveBeenCalled();
      expect(vi.mocked(notionRequest).mock.calls.some(([method]) => method === "PATCH" || method === "POST")).toBe(false);
    }
  });

  it("ACK不明ではcursor0/unknownを保持し、次回は再送しない", async () => {
    windowRouter(); const route = vi.mocked(notionRequest).getMockImplementation()!;
    vi.mocked(notionRequest).mockImplementation(async (method, path, body, options) => {
      if (method === "POST" && path === "/pages") throw new Error("SOURCE_WINDOW_ACK_UNKNOWN");
      return route(method, path, body, options);
    });
    await expect(publishVerifiedShareholdings({ ...args, maxRows: 1 })).rejects.toThrow("SOURCE_WINDOW_ACK_UNKNOWN");
    expect(savedInfo().sourceNextHoldingOffset).toBe(0);
    expect(testProperties(saved[sourcePath])["保有明細状態"].select!.name).toBe("実行中（結果未確定）");
    vi.mocked(notionRequest).mockClear();
    await expect(publishVerifiedShareholdings({ ...args, maxRows: 1 })).rejects.toThrow("前回結果が未確定");
    expect(vi.mocked(notionRequest).mock.calls.every(([method]) => method === "GET")).toBe(true);
  });

  it("通常再開が保存ZIP/native資格を再用し、部分windowの消費行数をrun予算へ数える", async () => {
    windowRouter(); await publishVerifiedShareholdings({ ...args, maxRows: 0 });
    vi.mocked(listPageFiles).mockResolvedValue([{ name: `${source.docId}_xbrl.zip`, kind: "file", url: "https://hosted.invalid/source-window" }]);
    const native = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(Uint8Array.from(args.zip)));
    expect(await resumePendingShareholdings({ maxRows: 1, shouldStop: () => false })).toEqual({ usedRows: 1, resumed: 1, held: 0, pending: true });
    expect(savedInfo().sourceNextHoldingOffset).toBe(1);
    expect(await resumePendingShareholdings({ maxRows: 1, shouldStop: () => false })).toEqual({ usedRows: 1, resumed: 1, held: 0, pending: false });
    expect(native).toHaveBeenCalledTimes(2);
    expect(verifySavedHoldingsSource).toHaveBeenCalledTimes(2);
  });

  it("旧cursor欠測は暗黙0へ戻さず、物理PREの全props/clock一致でだけ明示v1を作る", async () => {
    windowRouter(); const old = { source, ownerName: args.ownerName, zipBytes: args.zip.length, zipSha256: info().zipSha256, parsed: 2 };
    saved[sourcePath] = { "保有明細状態": { select: { name: "要確認" } }, "保有明細理由": { rich_text: [{ text: { content: "旧上限HOLD" } }] },
      "保有明細再開情報": { rich_text: [{ text: { content: JSON.stringify(old) } }] } };
    const route = vi.mocked(notionRequest).getMockImplementation()!;
    vi.mocked(notionRequest).mockImplementation(async (method, path, body, options) => {
      const result = await route(method, path, body, options);
      if (method === "GET" && path === sourcePath) Object.assign(result as object, { created_time: "2026-07-01T00:00:00Z", last_edited_time: "2026-07-01T00:00:00Z" });
      return result;
    });
    expect(await publishVerifiedShareholdings({ ...args, maxRows: 1 })).toMatchObject({ status: "held", reason: expect.stringContaining("物理PRE") });
    expect(savedInfo()).toEqual(old); expect(queryUniqueRow).not.toHaveBeenCalled();
    const page = await notionRequest("GET", sourcePath);
    const bytes = Buffer.from(JSON.stringify({ page, info: info() }));
    const sourceWindowPre = { archivePageId: "1".repeat(32), filename: "source-window-pre.json", bytes,
      sha256: createHash("sha256").update(bytes).digest("hex") };
    const changed = Buffer.from(JSON.stringify({ page: { ...(page as object), last_edited_time: "2026-07-02T00:00:00Z" }, info: info() }));
    await expect(publishVerifiedShareholdings({ ...args, maxRows: 1, sourceWindowPre: { ...sourceWindowPre, bytes: changed, sha256: createHash("sha256").update(changed).digest("hex") } })).rejects.toThrow("props/clock");
    expect(queryUniqueRow).not.toHaveBeenCalled(); expect(savedInfo()).toEqual(old);
    expect(await publishVerifiedShareholdings({ ...args, maxRows: 1, sourceWindowPre })).toMatchObject({ status: "held", usedRows: 1, pending: true });
    expect(savedInfo()).toMatchObject({ ...info(), sourceNextHoldingOffset: 1 });
    expect(verifyArchivedAttachments).toHaveBeenCalledWith(sourceWindowPre.archivePageId, [{ filename: sourceWindowPre.filename, bytes }], "保有明細source windowの旧PRE");
  });
});

describe("原本完了とは独立した保存価格queue", () => {
  const rowPath = `/pages/${"e".repeat(32)}`;
  const evidence = { archivePageId: "1".repeat(32), filename: "structural-price-source", bytes: Buffer.alloc(0), sha256: "2".repeat(64) };
  const ready = { status: "ready" as const, snapshotId: "structural-snapshot", evidenceScope: "snapshot structural-snapshot 内。その他保存観測の存在は未判定", codeList: evidence, prices: [evidence] };
  const budget = () => ({ remainingChunks: 116, remainingBytes: 256 * 1024 * 1024 });
  const qualified = () => ({ status: "qualified" as const, identity: { code: source.stockCode, edinetCode: source.edinetCode,
    corporateNumber: "1".repeat(13), legalName: holding.name, englishName: "STRUCTURAL", asOf: source.fiscalYearEnd,
    row: 3, archivePageId: evidence.archivePageId, zipSha256: evidence.sha256 }, price: 100, value: 1200, currency: "JPY" as const,
    date: source.fiscalYearEnd, priceSource: { archivePageId: evidence.archivePageId, gzipSha256: evidence.sha256, bodySha256: "3".repeat(64),
      filename: "structural.gz", symbol: "9999.T", capturedAt: "2026-07-01T00:00:00Z", sourceTimestamp: 1782777600,
      range: "10y", priceBasis: "STRUCTURAL", splitObservation: "STRUCTURAL" } });

  async function seedPublishedSource(valuationSources?: { codeList: typeof evidence; prices: typeof evidence[] }) {
    await publishVerifiedShareholdings({ ...args, valuationSources });
    vi.mocked(listPageFiles).mockResolvedValue([{ name: `${source.docId}_xbrl.zip`, kind: "file", url: "https://hosted.invalid/saved-price-phase-only" }]);
    vi.mocked(queryUniqueRow).mockImplementation(async dbId => {
      if (dbId !== "p".repeat(32)) return await requestRouter("GET", rowPath) as { id: string };
      const page = await requestRouter("GET", `/pages/${args.archivePageId}`) as { id: string; properties: Record<string, unknown> };
      return { ...page, properties: { ...page.properties, ...mirrored({ Metadata: { rich_text: [{ text: { content: JSON.stringify({
        docID: source.docId, secCode: `${source.stockCode}0`, edinetCode: source.edinetCode, periodEnd: source.fiscalYearEnd,
        edinetDocType: 1, sourceZIPSHA: createHash("sha256").update(args.zip).digest("hex"), sourceZIPBytes: args.zip.length,
      }) } }] }, "Fetched At": { date: { start: "2026-07-01T00:00:00Z" } } }) } };
    });
    vi.mocked(notionRequest).mockImplementation(async (method, path, body) => {
      if (method === "POST" && path.endsWith("/query")) {
        const status = (body as { filter: { select: { equals: string } } }).filter.select.equals;
        const page = await requestRouter("GET", `/pages/${args.archivePageId}`) as { properties: Record<string, { select?: { name: string } }> };
        return { results: page.properties["保有価格状態"]?.select?.name === status ? [page] : [], has_more: false, next_cursor: null };
      }
      return requestRouter(method, path, body);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(Uint8Array.from(args.zip)));
    return structuredClone(saved[`/pages/${args.archivePageId}`]) as Record<string, unknown>;
  }
  afterEach(() => vi.restoreAllMocks());

  it("原本完了と価格pendingの3propsを一度のPATCHで原子的に登録する", async () => {
    await publishVerifiedShareholdings(args);
    const patches = vi.mocked(notionRequest).mock.calls.filter(([method, path]) => method === "PATCH" && path === `/pages/${args.archivePageId}`);
    const final = patches.at(-1)![2] as { properties: Record<string, unknown> };
    expect(final.properties).toMatchObject({ "保有明細状態": { select: { name: "明細原本照合済" } }, "保有価格状態": { select: { name: "再開待ち" } } });
    expect(Object.keys(final.properties)).toHaveLength(6);
    const info = (final.properties["保有価格再開情報"] as { rich_text: Array<{ text: { content: string } }> }).rich_text.map(p => p.text.content).join("");
    expect(JSON.parse(info)).toMatchObject({ source, parsed: 1, priceQueueVersion: 1, nextHoldingOffset: 0, unavailableRows: 0 });
  });

  it("原本/価格の両完了後の価格付きbackfill再実行はcursor終端を照合してwrite0", async () => {
    await seedPublishedSource();
    vi.mocked(qualifyHoldingValuation).mockResolvedValue(qualified());
    await resumePendingShareholdingsPrices({ maxRows: 100, shouldStop: () => false, budget: budget(), loadSources: async () => ready });
    const before = structuredClone(saved);
    vi.mocked(notionRequest).mockClear(); vi.mocked(queryUniqueRow).mockClear();
    expect(await publishVerifiedShareholdings({ ...args, valuationSources: ready })).toEqual({ status: "published", parsed: 0, created: 0, updated: 0, unchanged: 0 });
    expect(saved).toEqual(before);
    expect(vi.mocked(notionRequest).mock.calls.every(([method]) => method === "GET")).toBe(true);
    expect(queryUniqueRow).not.toHaveBeenCalled();
  });

  it("保存ZIPと同じ原表を照合後に既writerへ価格根拠を渡し、価格列以外はPATCHしない", async () => {
    const sourceBefore = await seedPublishedSource(), rowBefore = structuredClone(saved[rowPath]) as Record<string, unknown>;
    vi.mocked(qualifyHoldingValuation).mockResolvedValue(qualified());
    const loader = vi.fn<HoldingPriceSourceLoader>(async () => ready);
    const result = await resumePendingShareholdingsPrices({ maxRows: 100, shouldStop: () => false, budget: budget(), loadSources: loader });
    expect(result).toEqual({ usedRows: 1, resumed: 1, held: 0, pending: false });
    expect(loader).toHaveBeenCalledWith(extraction.holdings, budget());
    const patch = vi.mocked(notionRequest).mock.calls.find(([method, path]) => method === "PATCH" && path === rowPath)![2] as { properties: Record<string, unknown> };
    expect(patch.properties).toMatchObject({ "株価": { number: 100 }, "保有時価": { number: 1200 }, "価格照合済": { checkbox: true } });
    for (const name of ["保有株数", "帳簿価額（円）", "出典原本SHA256", "原本照合済", "Name"]) expect(patch.properties).not.toHaveProperty(name);
    const sourceAfter = saved[`/pages/${args.archivePageId}`] as Record<string, unknown>;
    for (const name of ["保有明細状態", "保有明細理由", "保有明細再開情報"]) expect(sourceAfter[name]).toEqual(sourceBefore[name]);
    expect(sourceAfter["保有価格状態"]).toEqual({ select: { name: "価格照合完了" } });
    for (const [name, value] of Object.entries(rowBefore)) if (!Object.hasOwn(patch.properties, name)) expect((saved[rowPath] as Record<string, unknown>)[name]).toEqual(value);
  });

  it("snapshot外/未同定価格はNULLと範囲理由を残し、完了値として扱わない", async () => {
    await seedPublishedSource();
    vi.mocked(qualifyHoldingValuation).mockResolvedValue({ status: "unavailable", identity: null, reason: "保存価格の資格なし" });
    const result = await resumePendingShareholdingsPrices({ maxRows: 100, shouldStop: () => false, budget: budget(), loadSources: async () => ready });
    expect(result).toMatchObject({ resumed: 1, held: 1 });
    expect(saved[rowPath]).toMatchObject({ "株価": { number: null }, "保有時価": { number: null }, "価格照合済": { checkbox: false } });
    expect(JSON.stringify((saved[rowPath] as Record<string, unknown>)["欠測理由"])).toContain(ready.evidenceScope);
    expect(saved[`/pages/${args.archivePageId}`]).toMatchObject({ "保有明細状態": { select: { name: "明細原本照合済" } }, "保有価格状態": { select: { name: "要確認" } } });
  });

  it("既に原本・価格照合済みの値は新snapshot欠測で消さず、架空NULLにも欠測数にも置換しない", async () => {
    vi.mocked(qualifyHoldingValuation).mockResolvedValue(qualified());
    await seedPublishedSource({ codeList: evidence, prices: [evidence] });
    const previous = structuredClone(saved[rowPath]);
    vi.mocked(qualifyHoldingValuation).mockResolvedValue({ status: "unavailable", identity: null, reason: "新snapshot内の該当観測なし" });
    expect(await resumePendingShareholdingsPrices({ maxRows: 100, shouldStop: () => false, budget: budget(), loadSources: async () => ready })).toMatchObject({ resumed: 1, held: 0 });
    expect(saved[rowPath]).toEqual(previous);
    expect(saved[`/pages/${args.archivePageId}`]).toMatchObject({ "保有価格状態": { select: { name: "価格照合完了" } } });
  });

  it("価格mutation未知は独立unknownを保持し、次定時は原本GET/loader/価格再送0", async () => {
    const sourceBefore = await seedPublishedSource();
    vi.mocked(qualifyHoldingValuation).mockResolvedValue(qualified());
    const routing = vi.mocked(notionRequest).getMockImplementation()!;
    vi.mocked(notionRequest).mockImplementation(async (method, path, ...rest) => {
      if (method === "PATCH" && path === rowPath) throw new Error("PRICE_ACK_UNKNOWN");
      return routing(method, path, ...rest);
    });
    const loader = vi.fn(async () => ready), options = { maxRows: 100, shouldStop: () => false, budget: budget(), loadSources: loader };
    await expect(resumePendingShareholdingsPrices(options)).rejects.toThrow("PRICE_ACK_UNKNOWN");
    const sourceAfter = saved[`/pages/${args.archivePageId}`] as Record<string, unknown>;
    expect(sourceAfter["保有明細状態"]).toEqual(sourceBefore["保有明細状態"]);
    expect(sourceAfter["保有価格状態"]).toEqual({ select: { name: "実行中（結果未確定）" } });
    vi.mocked(listPageFiles).mockClear(); loader.mockClear(); vi.mocked(fetch).mockClear();
    await expect(resumePendingShareholdingsPrices(options)).rejects.toThrow("保有価格に結果未確定");
    expect(listPageFiles).not.toHaveBeenCalled(); expect(loader).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("別pageを返す価格PATCH ACKを成功/次cursorと扱わず、unknownを保全する", async () => {
    await seedPublishedSource(); vi.mocked(qualifyHoldingValuation).mockResolvedValue(qualified());
    const routing = vi.mocked(notionRequest).getMockImplementation()!;
    vi.mocked(notionRequest).mockImplementation(async (method, path, ...rest) => {
      const response = await routing(method, path, ...rest);
      return method === "PATCH" && path === rowPath ? { object: "page", id: "f".repeat(32) } : response;
    });
    await expect(resumePendingShareholdingsPrices({ maxRows: 100, shouldStop: () => false, budget: budget(), loadSources: async () => ready })).rejects.toThrow("PATCH ACKが別行");
    expect(notionRequest).not.toHaveBeenCalledWith("GET", `/pages/${"f".repeat(32)}`);
    expect(saved[`/pages/${args.archivePageId}`]).toMatchObject({ "保有価格状態": { select: { name: "実行中（結果未確定）" } } });
    const page = await requestRouter("GET", `/pages/${args.archivePageId}`) as { properties: Record<string, { rich_text?: Array<{ plain_text: string }> }> };
    expect(JSON.parse(page.properties["保有価格再開情報"].rich_text!.map(p => p.plain_text).join(""))).toMatchObject({ nextHoldingOffset: 0 });
  });

  it("ZIPと件数が同じでも全factsの原表順が変わればloader/価格書込前にSTOPする", async () => {
    const holdings = [holding, { ...holding, kind: "みなし保有株式" as const, rowIndex: 4 }];
    vi.mocked(parseShareholdingsData).mockReturnValue({ ...extraction, holdings });
    await seedPublishedSource();
    vi.mocked(parseShareholdingsData).mockReturnValue({ ...extraction, holdings: [...holdings].reverse() });
    const loader = vi.fn<HoldingPriceSourceLoader>();
    await expect(resumePendingShareholdingsPrices({ maxRows: 1, shouldStop: () => false, budget: budget(), loadSources: loader })).rejects.toThrow("全facts/order");
    expect(loader).not.toHaveBeenCalled();
    expect(vi.mocked(notionRequest).mock.calls.filter(([method, path]) => method === "PATCH" && path === rowPath)).toHaveLength(0);
    expect(saved[`/pages/${args.archivePageId}`]).toMatchObject({ "保有明細状態": { select: { name: "明細原本照合済" } }, "保有価格状態": { select: { name: "実行中（結果未確定）" } } });
  });

  it("未有効化snapshotは予算待ちへ誤分類せず要確認としてsource完了を保持する", async () => {
    await seedPublishedSource();
    expect(await resumePendingShareholdingsPrices({ maxRows: 100, shouldStop: () => false, budget: budget(),
      loadSources: async () => ({ status: "held", reasonCode: "snapshot_unavailable", reason: "有効化未完了" }) })).toMatchObject({ resumed: 0, held: 1, pending: false });
    expect(saved[`/pages/${args.archivePageId}`]).toMatchObject({ "保有価格状態": { select: { name: "要確認" } }, "保有明細状態": { select: { name: "明細原本照合済" } } });
  });

  it("価格source資格throwでもsource完了は保持し、予算不足だけは次定時に残す", async () => {
    await seedPublishedSource();
    const held = await resumePendingShareholdingsPrices({ maxRows: 100, shouldStop: () => false, budget: budget(),
      loadSources: async () => ({ status: "held", reason: "全必要chunkの残予算不足", reasonCode: "budget_exhausted" }) });
    expect(held).toMatchObject({ resumed: 0, pending: true });
    expect(saved[`/pages/${args.archivePageId}`]).toMatchObject({ "保有明細状態": { select: { name: "明細原本照合済" } }, "保有価格状態": { select: { name: "再開待ち" } } });
    await expect(resumePendingShareholdingsPrices({ maxRows: 100, shouldStop: () => false, budget: budget(),
      loadSources: async () => { throw new Error("PRICE_SOURCE_SHA_MISMATCH"); } })).rejects.toThrow("PRICE_SOURCE_SHA_MISMATCH");
    expect(saved[`/pages/${args.archivePageId}`]).toMatchObject({ "保有明細状態": { select: { name: "明細原本照合済" } }, "保有価格状態": { select: { name: "実行中（結果未確定）" } } });
  });

  it("全原表を毎回資格化し、価格だけ残行予算のwindowを読戻してcursorを進める", async () => {
    const holdings = [holding, { ...holding, kind: "みなし保有株式" as const, rowIndex: 4 }];
    vi.mocked(parseShareholdingsData).mockReturnValue({ ...extraction, holdings });
    const sourceBefore = await seedPublishedSource();
    const created = vi.mocked(notionRequest).mock.calls.filter(([method, path]) => method === "POST" && path === "/pages");
    expect(created).toHaveLength(2);
    const rows = created.map((call, index) => ({ object: "page", id: (index === 0 ? "e" : "f").repeat(32), parent: { type: "database_id", database_id: "d".repeat(32) },
      archived: false, in_trash: false, properties: { ...legacy, ...mirrored((call[2] as { properties: Record<string, unknown> }).properties) } }));
    const originalQuery = vi.mocked(queryUniqueRow).getMockImplementation()!;
    vi.mocked(queryUniqueRow).mockImplementation(async (dbId, filter, message) => {
      if (dbId === "p".repeat(32)) return originalQuery(dbId, filter, message);
      const predicates = (filter as { and: Array<{ property: string; select?: { equals: string } }> }).and;
      const kind = predicates.find(p => p.property === "保有種別")!.select!.equals;
      return rows.find(row => row.properties["保有種別"].select.name === kind)!;
    });
    const originalRequest = vi.mocked(notionRequest).getMockImplementation()!;
    vi.mocked(notionRequest).mockImplementation(async (method, path, body, options) => {
      const row = rows.find(row => path === `/pages/${row.id}`);
      if (!row) return originalRequest(method, path, body, options);
      if (method === "PATCH") { Object.assign(row.properties, mirrored((body as { properties: Record<string, unknown> }).properties)); return { object: "page", id: row.id }; }
      return structuredClone(row);
    });
    vi.mocked(qualifyHoldingValuation).mockResolvedValue(qualified());
    const loader = vi.fn<HoldingPriceSourceLoader>(async () => ready);
    const options = { maxRows: 1, shouldStop: () => false, budget: budget(), loadSources: loader };
    expect(await resumePendingShareholdingsPrices(options)).toMatchObject({ usedRows: 1, resumed: 1, pending: true });
    let page = await requestRouter("GET", `/pages/${args.archivePageId}`) as { properties: Record<string, { rich_text?: Array<{ plain_text: string }> }> };
    expect(JSON.parse(page.properties["保有価格再開情報"].rich_text!.map(p => p.plain_text).join(""))).toMatchObject({ parsed: 2, nextHoldingOffset: 1 });
    expect(await resumePendingShareholdingsPrices(options)).toMatchObject({ usedRows: 1, resumed: 1, pending: false });
    page = await requestRouter("GET", `/pages/${args.archivePageId}`) as typeof page;
    expect(JSON.parse(page.properties["保有価格再開情報"].rich_text!.map(p => p.plain_text).join(""))).toMatchObject({ parsed: 2, nextHoldingOffset: 2, unavailableRows: 0 });
    expect(loader.mock.calls.map(call => call[0])).toEqual([[holdings[0]], [holdings[1]]]);
    const sourceAfter = saved[`/pages/${args.archivePageId}`] as Record<string, unknown>;
    for (const name of ["保有明細状態", "保有明細理由", "保有明細再開情報"]) expect(sourceAfter[name]).toEqual(sourceBefore[name]);
    expect(sourceAfter["保有価格状態"]).toEqual({ select: { name: "価格照合完了" } });
  });
});
