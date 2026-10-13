/** schema移行の保全と原表資格後の書込境界。原文をfixtureへ複製しない。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { ShareholdingsExtraction } from "../../../services/yuho-quant/src/services/edinet/shareholdings.js";
import { parseShareholdingsData } from "../../../services/yuho-quant/src/services/edinet/shareholdings.js";
import { queryUniqueRow } from "./archive.js";
import { notionRequest } from "./client.js";
import { verifyArchivedAttachments } from "./readback.js";
import { listPageFiles } from "./page-file.js";
import { applyHoldingsSchema, buildHoldingsSchemaPatch, LEGACY_HOLDINGS_COLUMNS, publishSavedShareholdings, publishVerifiedShareholdings, resumePendingShareholdings, type HoldingsSchema } from "./shareholdings.js";

vi.mock("../../../services/yuho-quant/src/services/edinet/shareholdings.js", () => ({ parseShareholdingsData: vi.fn() }));
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
  elementId: "jpcrp_cor:ShareholdingsTextBlock", contextRef: "FilingDateInstant", holdings: [holding] };
const args = { source, ownerName: "構造検証用提出者", zip: Buffer.from("構造境界検証。ZIP parserは別suite"), archivePageId: "a".repeat(32), maxRows: 20 };

function oldSchema(): HoldingsSchema {
  const properties: HoldingsSchema["properties"] = {};
  for (const [index, [name, , type]] of LEGACY_HOLDINGS_COLUMNS.entries()) properties[name] = { id: `old-${index}`, type,
    ...(type === "select" ? { select: { options: [
      { id: "listed", name: "上場", color: "blue" }, { id: "no-code", name: "非上場", color: "gray" },
    ] } } : {}) };
  return { id: "d".repeat(32), properties };
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
    } else properties[key] = { id: `new-${key}`, type: Object.keys(definition)[0] };
  }
  return { id: schema.id, properties };
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
    archived: false, in_trash: false, properties: { ...legacy, Key: { type: "title", title: [{ type: "text", plain_text: `${source.docId}:type1`, text: { content: `${source.docId}:type1` } }] },
      ...(properties ? mirrored(properties) : {}) } };
}

beforeEach(() => { vi.clearAllMocks(); saved = {}; vi.mocked(parseShareholdingsData).mockReturnValue(structuredClone(extraction));
  vi.mocked(notionRequest).mockImplementation(requestRouter);
  vi.mocked(queryUniqueRow).mockResolvedValue(null); });

describe("株式保有の原典限定writer", () => {
  it("5旧列と分類option IDを維持し、新schemaは再実行でmutation不要", () => {
    const before = oldSchema(), snapshot = structuredClone(before);
    const patch = buildHoldingsSchemaPatch(before);
    expect(patch.properties["old-0"]).toEqual({ name: "旧分類（未検証）", select: { options: [
      { id: "listed", name: "コード照合のみ（未検証）", color: "blue" }, { id: "no-code", name: "コード未確定", color: "gray" },
    ] } });
    expect(Object.keys(patch.properties).filter(key => key.startsWith("old-"))).toHaveLength(5);
    expect(before).toEqual(snapshot);
    expect(buildHoldingsSchemaPatch(migratedSchema()).properties).toEqual({});
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
      archived: false, in_trash: false, properties: { ...legacy, "原本照合済": { type: "checkbox", checkbox: false } } };
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
});
