import { createReportedSourceTestDb } from "./reported-source-test-db.js";
const sourceDb = createReportedSourceTestDb().db;
/** schema移行の保全と原表資格後の書込境界。原文をfixtureへ複製しない。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ShareholdingsExtraction, ShareholdingsNotApplicable, ShareholdingsSource } from "../../../services/yuho-quant/src/services/edinet/shareholdings.js";
import { parseShareholdingsData, verifySavedHoldingsSource } from "../../../services/yuho-quant/src/services/edinet/shareholdings.js";
import { HoldingPriceIssuerMismatch, HoldingPriceShareBasisMismatch, HoldingsPriceIndex, qualifyHoldingValuation } from "../../../services/yuho-quant/src/services/edinet/shareholdings-valuation.js";
import { queryUniqueRow, recordPrimaryData } from "./archive.js";
import { notionRequest } from "./client.js";
import { verifyArchivedAttachments } from "./readback.js";
import { listPageFiles } from "./page-file.js";
import { readHoldingsSchema, applyHoldingsSchema, buildHoldingsSchemaPatch, HOLDINGS_DESCRIPTION, LEGACY_HOLDINGS_COLUMNS, publishSavedShareholdings, publishVerifiedShareholdings, resumePendingShareholdings, resumePendingShareholdingsPrices, readSavedHoldingsZip, holdingProperties, holdingsFactsSha256, resolveHoldingRows, verifyCompletedHoldingsSource, type HoldingsSchema, type HoldingPriceSourceLoader } from "./shareholdings.js";

vi.mock("../../../services/yuho-quant/src/services/edinet/shareholdings.js", async original => ({
  ...await original<typeof import("../../../services/yuho-quant/src/services/edinet/shareholdings.js")>(),
  parseShareholdingsData: vi.fn(), verifySavedHoldingsSource: vi.fn(() => ({ status: "verified", filename: "structural.xbrl" })),
}));
vi.mock("../../../services/yuho-quant/src/services/edinet/shareholdings-valuation.js", async importOriginal => ({
  HoldingPriceIssuerMismatch: (await importOriginal<typeof import("../../../services/yuho-quant/src/services/edinet/shareholdings-valuation.js")>()).HoldingPriceIssuerMismatch,
  HoldingPriceShareBasisMismatch: (await importOriginal<typeof import("../../../services/yuho-quant/src/services/edinet/shareholdings-valuation.js")>()).HoldingPriceShareBasisMismatch,
  HoldingsPriceIndex: vi.fn(function () {}),
  parseHoldingsCodeList: vi.fn(() => ({ asOf: "2026-06-30", byLegalName: new Map() })), qualifyHoldingValuation: vi.fn(),
}));
vi.mock("./archive.js", () => ({ recordPrimaryData: vi.fn(), queryUniqueRow: vi.fn(), findUniqueBackupChildByTitle: vi.fn(async () => "p".repeat(32)) }));
vi.mock("./client.js", async importOriginal => ({ ...(await importOriginal<typeof import("./client.js")>()), notionRequest: vi.fn() }));
vi.mock("./readback.js", () => ({ verifyArchivedAttachments: vi.fn() }));
vi.mock("./page-file.js", () => ({ listPageFiles: vi.fn() }));
vi.mock("./env.js", () => ({ notionEnv: { NOTION_STOCK_HOLDINGS_DB_ID: () => "d".repeat(32), NOTION_ARCHIVE_PAGE_ID: () => "a".repeat(32) } }));

const source = { docId: "S100TEST", stockCode: "9999", edinetCode: "E99999", fiscalYearEnd: "2026-06-30" };
const holding: ShareholdingsExtraction["holdings"][number] = { name: "構造検証用銘柄", kind: "特定投資株式", shares: 12,
  sharesRaw: 12, sharesUnit: "株", bookValueRaw: 34, bookValueUnit: "千円", bookValueYen: 34000,
  listingStatus: "unknown", price: null, priceDate: null, priceCurrency: null, tableIndex: 0, rowIndex: 3 };
const extraction: ShareholdingsExtraction = { status: "ok", reason: null, source, filename: "XBRL/PublicDoc/structure.htm",
  elementId: "jpcrp_cor:ShareholdingsTextBlock", contextRef: "FilingDateInstant", holdings: [holding], holderScope: "filer_only" };
const args = { sourceDb, source, ownerName: "構造検証用提出者", zip: Buffer.from("構造境界検証。ZIP parserは別suite"), archivePageId: "a".repeat(32), maxRows: 20 };

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

function formulaStatuses(properties: Record<string, unknown>) {
  const checked = properties["価格照合済"] as { checkbox?: boolean } | undefined;
  return {
    "価格状態": { id: migratedSchema().properties["価格状態"].id, type: "formula", formula: { type: "string", string: checked?.checkbox === true
      ? "期末参考時価（期末株数×採用終値）" : "未取得（価格・通貨・株数単位の照合未成立）" } },
    "検証状態": { id: migratedSchema().properties["検証状態"].id, type: "formula", formula: { type: "string", string: "明細原本照合済" } },
  };
}

const legacy = Object.fromEntries(LEGACY_HOLDINGS_COLUMNS.map(([, name]) => [name, { type: "number", number: 777 }]));
let saved: Record<string, unknown>;
let holdingPeriodRows: () => Promise<unknown[]>;
type TestProperties = Record<string, { select?: { name: string }; rich_text?: Array<{ text: { content: string } }> }>;
type TestPage = { object: string; id: string; parent: { type: string; database_id: string }; archived: boolean; in_trash: boolean; properties: TestProperties };
const testProperties = (value: unknown) => value as TestProperties;
const pageProperties = (value: unknown) => (value as { properties: TestProperties }).properties;
const restartInfo = (value: unknown, phase = "保有明細") => JSON.parse(testProperties(value)[`${phase}再開情報`].rich_text!.map(p => p.text.content).join("")) as Record<string, unknown>;
async function requestRouter(method: string, path: string, body?: unknown): Promise<unknown> {
  if (method === "POST" && path === `/databases/${"d".repeat(32)}/query`) return { object: "list", results: await holdingPeriodRows(), has_more: false, next_cursor: null };
  if (method === "POST" && path === `/databases/${"p".repeat(32)}/query`) return { object: "list", results: [], has_more: false, next_cursor: null };
  if (method === "GET" && path.startsWith("/databases/")) {
    if (path.includes("p".repeat(32))) return { id: "p".repeat(32), properties: {
      "保有明細状態": { type: "select", select: { options: [{ name: "原本明示不該当" }] } }, "保有明細理由": { type: "rich_text" }, "保有明細再開情報": { type: "rich_text" },
      "保有価格状態": { type: "select" }, "保有価格理由": { type: "rich_text" }, "保有価格再開情報": { type: "rich_text" },
    } };
    return migratedSchema();
  }
  if (method === "PATCH") {
    saved[path] = { ...(saved[path] as object), ...(body as { properties: Record<string, unknown> }).properties };
    return { object: path.startsWith("/databases/") ? "database" : "page", id: path.split("/").at(-1) };
  }
  if (method === "POST") {
    const count = Object.values(saved).filter(value => Object.hasOwn(value as object, "銘柄名")).length;
    if (count > 1) throw new Error("Protocol fixture supports two distinct rows");
    const id = (count === 0 ? "e" : "f").repeat(32);
    saved[`/pages/${id}`] = (body as { properties: Record<string, unknown> }).properties;
    return { object: "page", id };
  }
  const properties = saved[path] as Record<string, unknown> | undefined;
  return { object: "page", id: path.split("/").at(-1), parent: { type: "database_id", database_id: (path.includes("a".repeat(32)) ? "p" : "d").repeat(32) },
    archived: false, in_trash: false, properties: { ...legacy, ...mirrored(holdingProperties(source,args.ownerName,holding)), Key: { type: "title", title: [{ type: "text", plain_text: `${source.docId}:type1`, text: { content: `${source.docId}:type1` } }] },
      ...(properties ? mirrored(properties) : {}),
      ...(!path.includes("a".repeat(32)) ? formulaStatuses(properties ?? {}) : {}) } };
}

beforeEach(() => { vi.clearAllMocks(); saved = {}; holdingPeriodRows = async () => Promise.all(Object.entries(saved).filter(([path, value]) => path.startsWith("/pages/") && Object.hasOwn(value as object, "銘柄名")).map(([path]) => requestRouter("GET", path))); vi.mocked(parseShareholdingsData).mockReturnValue(structuredClone(extraction));
  vi.mocked(notionRequest).mockImplementation(requestRouter);
  vi.mocked(queryUniqueRow).mockResolvedValue(null); });

describe("保有明細schemaの宣言値とHTTP応答envelope", () => {
  it("実208Aの全schema値を保持し、応答ごとのrequest_idをschemaへ混入しない", async () => {
    const snapshot = JSON.parse(readFileSync(new URL("../../../services/yuho-quant/src/tests/fixtures/holdings-owner-quarantine/snapshot.json", import.meta.url), "utf8"));
    // Financial/schema values are real fixture values; these two request IDs are explicit transport projections.
    const replies = ["first-read-request", "second-read-request"].map(request_id => ({ ...structuredClone(snapshot.schema), object: "database", request_id }));
    vi.mocked(notionRequest).mockResolvedValueOnce(replies[0]).mockResolvedValueOnce(replies[1]);
    const first = await readHoldingsSchema(), second = await readHoldingsSchema();
    expect(first).toEqual(snapshot.schema); expect(second).toEqual(first);
    expect(Object.keys(first).sort()).toEqual(["description", "id", "properties"]);
    expect(first.properties).toBe(replies[0].properties); expect(first.description).toBe(replies[0].description);
    expect(replies[0].request_id).toBe("first-read-request"); expect(replies[1].request_id).toBe("second-read-request");
    expect(vi.mocked(notionRequest).mock.calls.map(call => call.slice(0, 2))).toEqual(Array.from({ length: 2 }, () => ["GET", `/databases/${"d".repeat(32)}`]));
    expect(recordPrimaryData).not.toHaveBeenCalled();
  });
  it("通常ensureは既存選択肢のID/色を保持して不該当terminalだけを1回追加し読戻す", async () => {
    const schema = await requestRouter("GET", `/databases/${"p".repeat(32)}`) as HoldingsSchema;
    const old = [{ id: "existing-attention", name: "要確認", color: "red" }];
    schema.properties["保有明細状態"].select = { options: structuredClone(old) };
    vi.mocked(notionRequest).mockImplementation(async (method, path, body) => {
      if (path === `/databases/${"p".repeat(32)}`) {
        if (method === "PATCH") {
          Object.assign(schema.properties["保有明細状態"], (body as { properties: HoldingsSchema["properties"] }).properties["保有明細状態"]);
          return { object: "database", id: schema.id } as never;
        }
        return structuredClone(schema) as never;
      }
      return requestRouter(method, path, body) as never;
    });
    vi.mocked(parseShareholdingsData).mockReturnValue({ ...extraction, status: "unsupported", reason: "原表未対応", holdings: [] });
    expect(await publishVerifiedShareholdings(args)).toMatchObject({ status: "held" });
    expect(schema.properties["保有明細状態"].select?.options).toEqual([...old, { name: "原本明示不該当" }]);
    expect(vi.mocked(notionRequest).mock.calls.filter(([method, path]) => method === "PATCH" && path.startsWith("/databases/"))).toHaveLength(1);
    expect(vi.mocked(notionRequest).mock.calls.filter(([method, path]) => method === "GET" && path === `/databases/${"p".repeat(32)}`)).toHaveLength(2);
  });
});

describe("旧未検証行の明示source移行", () => {
  type NativeHolding = Parameters<typeof resolveHoldingRows>[4][number];
  const id = "e".repeat(32), path = `/pages/${id}`;
  async function legacyPage(): Promise<NativeHolding> {
    const page = await requestRouter("GET", path) as NativeHolding;
    page.created_time = "2026-10-12T16:49:00.000Z"; page.last_edited_time = page.created_time;
    page.properties["保有種別"] = { type: "select", select: null };
    page.properties["原本照合済"] = { type: "checkbox", checkbox: false };
    page.properties["価格照合済"] = { type: "checkbox", checkbox: false };
    page.properties["保有株数"] = { type: "number", number: 111 }; // Explicit unverified-value fault; source remains12.
    for (const name of ["出典文書ID", "出典原本SHA256", "出典明細行", "出典要素ID", "出典ファイル", "出典Context"]) page.properties[name] = { type: "rich_text", rich_text: [] };
    for (const name of ["価格照合根拠", "欠測理由", "確定銘柄コード", "銘柄照合根拠"]) page.properties[name] = { type: "rich_text", rich_text: [] };
    for (const [name, property] of Object.entries(page.properties)) property.id = migratedSchema().properties[name]?.id ?? `legacy-${name}`;
    page.properties["検証状態"].formula = { type: "string", string: "未検証（旧取込）" };
    return page;
  }
  async function setup(fault?: string) {
    const before = await legacyPage(), page = structuredClone(before); let gets = 0, patches = 0;
    holdingPeriodRows = async () => [structuredClone(page)];
    vi.mocked(recordPrimaryData).mockImplementation(async input => {
      if (fault === "pre-archive" || fault === "post-archive" && input.key.includes("/POST/")) throw new Error("CUSTODY_ACK_UNKNOWN");
      return { pageId: (input.key.includes("/PRE/") ? "b" : "c").repeat(32), outcome: "recorded", fileTooLarge: false, manifestMatch: "written" };
    });
    vi.mocked(notionRequest).mockImplementation(async (method, target, body) => {
      if (target !== path) return requestRouter(method, target, body);
      if (method === "PATCH") {
        patches++; expect(recordPrimaryData).toHaveBeenCalledTimes(1); expect(verifyArchivedAttachments).toHaveBeenCalledTimes(1);
        if (fault === "patch-unknown") throw new Error("PATCH_ACK_UNKNOWN");
        for (const [name, value] of Object.entries(mirrored((body as { properties: Record<string, unknown> }).properties))) page.properties[name] = { ...page.properties[name], ...value as object };
        Object.assign(page.properties, formulaStatuses(page.properties)); page.last_edited_time = "2026-10-12T16:49:01.000Z";
        return { object: "page", id };
      }
      gets++;
      if (fault === "fresh-properties" && gets === 1) page.properties["保有株数"].number = 112;
      if (fault === "post-readback" && gets === 2) page.properties["旧抽出株数（単位未確認）"].number = 778;
      if (fault === "independent" && gets === 3) page.last_edited_time = "2026-10-12T16:49:02.000Z";
      return structuredClone(page);
    });
    return { before, page: () => page, patches: () => patches, gets: () => gets };
  }
  it("whole原表と唯一旧行だけを対応し、2種別/主体差/出典/照合flagはHOLD", async () => {
    const page = await legacyPage();
    expect(resolveHoldingRows(source,args.ownerName,[holding],[holding],[page])).toMatchObject({ status: "ready", selected: [{ existing: page, migrateLegacy: true }] });
    expect(resolveHoldingRows(source,args.ownerName,[holding,{...holding,kind:"みなし保有株式"}],[holding],[page])).toMatchObject({status:"held"});
    for (const change of [(p:NativeHolding)=>{p.properties["保有会社"].rich_text=[{type:"text",plain_text:"別の主体",text:{content:"別の主体"}}]},
      (p:NativeHolding)=>{p.properties["出典文書ID"].rich_text=[{type:"text",plain_text:source.docId,text:{content:source.docId}}]},
      (p:NativeHolding)=>{p.properties["価格照合済"].checkbox=true}]) {
      const changed=structuredClone(page);change(changed);expect(resolveHoldingRows(source,args.ownerName,[holding],[holding],[changed])).toMatchObject({status:"held"});
    }
    expect(resolveHoldingRows(source,args.ownerName,[holding],[holding],[page,{...page,id:"f".repeat(32)}])).toMatchObject({status:"held"});
  });
  it("物理PRE→fresh全props→単発既行PATCH→独立POST、旧値は残しcanonical置換を明記", async () => {
    const state=await setup();
    expect(await publishVerifiedShareholdings(args)).toEqual({status:"published",parsed:1,created:0,updated:1,unchanged:0});
    expect(state.patches()).toBe(1);expect(state.gets()).toBe(3);expect(recordPrimaryData).toHaveBeenCalledTimes(2);
    const pre=JSON.parse(Buffer.from(vi.mocked(recordPrimaryData).mock.calls[0][0].files![0].bytes).toString());
    expect(pre.rows).toEqual([state.before]);expect(state.page().properties["保有株数"].number).toBe(12);
    for (const [,name]of LEGACY_HOLDINGS_COLUMNS)expect(state.page().properties[name]).toEqual(state.before.properties[name]);
    expect(vi.mocked(recordPrimaryData).mock.calls.every(([input])=>input.metadata?.unverifiedCanonicalValuesReplacedFromSavedSource===true)).toBe(true);
    expect(restartInfo(saved[`/pages/${args.archivePageId}`])).toMatchObject({sourceNextHoldingOffset:1,legacyMigration:{pre:{pageId:"b".repeat(32)},post:{pageId:"c".repeat(32)}}});
  });
  it.each(["pre-archive","fresh-properties","patch-unknown","post-readback","independent","post-archive"])("%sはunknown/cursor0を残し再送しない",async fault=>{
    const state=await setup(fault);await expect(publishVerifiedShareholdings(args)).rejects.toThrow();
    expect(restartInfo(saved[`/pages/${args.archivePageId}`])).toMatchObject({sourceNextHoldingOffset:0,legacyMigration:{pre:{sha256:expect.stringMatching(/^[a-f0-9]{64}$/)}}});
    expect(saved[`/pages/${args.archivePageId}`]).toMatchObject({"保有明細状態":{select:{name:"実行中（結果未確定）"}}});
    const patches=state.patches(),archives=vi.mocked(recordPrimaryData).mock.calls.length;
    await expect(publishVerifiedShareholdings(args)).rejects.toThrow("前回結果が未確定");expect(state.patches()).toBe(patches);expect(recordPrimaryData).toHaveBeenCalledTimes(archives);
    expect(state.patches()).toBe(fault==="pre-archive"||fault==="fresh-properties"?0:1);
  });
  it("完了sourceでもfile/context/全raw出典が違えばwrite0資格としない",async()=>{
    await publishVerifiedShareholdings(args);const page=await requestRouter("GET",path)as NativeHolding;
    const zipSha=createHash("sha256").update(args.zip).digest("hex");
    expect(verifyCompletedHoldingsSource(source,args.ownerName,extraction,zipSha,[page])).toEqual({status:"verified"});
    for(const name of ["出典ファイル","出典Context","出典原本SHA256","出典明細行"]){const changed=structuredClone(page);changed.properties[name].rich_text=[{type:"text",plain_text:"EXPLICIT_OFFLINE_DRIFT",text:{content:"EXPLICIT_OFFLINE_DRIFT"}}];expect(verifyCompletedHoldingsSource(source,args.ownerName,extraction,zipSha,[changed])).toMatchObject({status:"held"});}
  });
});

describe("株式保有の原典限定writer", () => {
  it("宣言したexact-doc取下げHOLDは全Notion mutation前に返し、既知READだけ行予約を戻す", async () => {
    const { db, sqlite } = createReportedSourceTestDb();
    sqlite.prepare("insert into yuho_edinet_reported_changes (source_page_id,seq_number,source_raw_sha256,doc_id,parent_doc_id,reported_state,observation_json) values(?,?,?,?,?,?,?)").run(
      "declared-source", 1, "declared-not-original-SHA", source.docId, null, "reported_withdrawal", "{\"protocolFault\":true}");
    const budget = { remainingRows: 20 }, before = structuredClone(saved);
    expect(await publishVerifiedShareholdings({ ...args, sourceDb: db, budget })).toMatchObject({ status: "held", parsed: 1, reason: expect.stringContaining("取下げ") });
    expect(budget.remainingRows).toBe(20); expect(saved).toEqual(before);
    expect(notionRequest).not.toHaveBeenCalled(); expect(recordPrimaryData).not.toHaveBeenCalled(); sqlite.close();
  });
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

  // Protocol-only evidence; real source/subject/context qualification is covered by shareholdings-absence.test.ts.
  const notApplicable: ShareholdingsNotApplicable = { version: 1, basis: "whole_section_not_applicable",
    zipSha256: createHash("sha256").update(args.zip).digest("hex"), filename: extraction.filename!,
    memberSha256: createHash("sha256").update(args.zip).digest("hex"), blockHtmlSha256: createHash("sha256").update(args.zip).digest("hex"),
    elementNamespace: "http://disclosure.edinet-fsa.go.jp/taxonomy/jpcrp/2025-11-01/jpcrp_cor",
    inlineNamespace: "http://www.xbrl.org/2008/inlineXBRL",
    context: { contextRef: "FilingDateInstant", entity: `${source.edinetCode}-000`, instantDate: "2026-09-18" },
    statement: "(5) 【株式の保有状況】 該当事項はありません。" };
  it("明示不該当は専用terminalへ根拠を残し、明細0件成功・新価格queueや旧価格変更を作らない", async () => {
    vi.mocked(parseShareholdingsData).mockReturnValue({ ...extraction, status: "explicit_not_applicable", reason: "原本明示不該当", holdings: [], notApplicable });
    const path = `/pages/${args.archivePageId}`, price = { "保有価格状態": { select: { name: "要確認" } }, "保有価格理由": { rich_text: [{ text: { content: "旧価格の資格は不明" } }] } };
    saved[path] = structuredClone(price);
    const budget = { remainingRows: 20 };
    expect(await publishVerifiedShareholdings({ ...args, budget })).toEqual({ status: "held", parsed: 0, reason: "原本明示不該当", reasonCode: "explicit_not_applicable", notApplicable });
    expect(restartInfo(saved[path]).notApplicable).toEqual(notApplicable);
    expect(testProperties(saved[path])["保有明細状態"].select?.name).toBe("原本明示不該当");
    expect(restartInfo(saved[path]).sourceQueueVersion).toBeUndefined(); expect(restartInfo(saved[path]).factsSha256).toBeUndefined();
    for (const [name, value] of Object.entries(price)) expect((saved[path] as Record<string, unknown>)[name]).toEqual(value);
    expect(testProperties(saved[path])["保有価格再開情報"]).toBeUndefined(); expect(budget.remainingRows).toBe(20);
    expect(queryUniqueRow).not.toHaveBeenCalled(); expect(qualifyHoldingValuation).not.toHaveBeenCalled();
    expect(Object.keys(saved)).toEqual([path]);
  });
  it.each(["unknown", "nonzero", "cursor", "completed"])("明示不該当で旧%sのmarker/factsを付け替えない", async mode => {
    vi.mocked(parseShareholdingsData).mockReturnValue({ ...extraction, status: "explicit_not_applicable", reason: "原本明示不該当", holdings: [], notApplicable });
    const info = { source, ownerName: args.ownerName, zipBytes: args.zip.length, zipSha256: notApplicable.zipSha256,
      parsed: mode === "nonzero" ? 1 : 0, ...(mode === "cursor" ? { sourceQueueVersion: 1, sourceNextHoldingOffset: 0 } : {}) };
    const path = `/pages/${args.archivePageId}`;
    saved[path] = { "保有明細状態": { select: { name: mode === "unknown" ? "実行中（結果未確定）" : mode === "completed" ? "明細原本照合済" : "再開待ち" } },
      "保有明細再開情報": { rich_text: [{ text: { content: JSON.stringify(info) } }] } };
    const before = structuredClone(saved);
    await expect(publishVerifiedShareholdings(args)).rejects.toThrow(); expect(saved).toEqual(before);
    expect(vi.mocked(notionRequest).mock.calls.filter(([method, path]) => method === "PATCH" || method === "POST" && !path.endsWith("/query"))).toHaveLength(0);
  });
  const actualAbsences: Array<{ source: ShareholdingsSource; ownerName: string; fixture: string; originalZipSha256: string;
    notApplicable: ShareholdingsNotApplicable }> = JSON.parse(readFileSync(new URL("../../../services/yuho-quant/src/tests/fixtures/holdings-absence-cli/provenance.json", import.meta.url), "utf8")).items;
  async function realAbsence(fixture: typeof actualAbsences[number], drift = false) {
    const actual = await vi.importActual<typeof import("../../../services/yuho-quant/src/services/edinet/shareholdings.js")>("../../../services/yuho-quant/src/services/edinet/shareholdings.js");
    vi.mocked(parseShareholdingsData).mockImplementation(actual.parseShareholdingsData);
    const zip = readFileSync(new URL(`../../../services/yuho-quant/src/tests/fixtures/holdings-absence-cli/${fixture.fixture}`, import.meta.url));
    expect(createHash("sha256").update(zip).digest("hex")).toBe(fixture.originalZipSha256);
    // Protocol-only archive page; the complete real ZIP supplies every issuer/context/absence fact.
    const before = { object: "page", id: args.archivePageId, parent: { type: "database_id", database_id: "p".repeat(32) }, archived: false, in_trash: false,
      properties: { Key: { type: "title", title: [{ type: "text", text: { content: `${fixture.source.docId}:type1` }, plain_text: `${fixture.source.docId}:type1` }] },
        Metadata: { type: "rich_text", rich_text: [] }, Files: { type: "files", files: [] },
        "保有価格状態": { type: "select", select: null }, "保有価格理由": { type: "rich_text", rich_text: [] }, "保有価格再開情報": { type: "rich_text", rich_text: [] } } };
    const page = { ...structuredClone(before), properties: testProperties(structuredClone(before.properties)) }, budget = { remainingRows: 20 };
    vi.mocked(notionRequest).mockImplementation(async (method, path, body, options) => {
      if (method === "POST" && path.endsWith("/query")) return requestRouter(method, path, body) as never;
      expect(path).toBe(`/pages/${args.archivePageId}`);
      if (method === "PATCH") {
        expect(options).toEqual({ singleAttempt: true });
        Object.assign(page.properties, mirrored((body as { properties: Record<string, unknown> }).properties));
        if (drift) page.properties.Key = mirrored({ Key: { title: [{ text: { content: `${fixture.source.docId}:type1変` } }] } }).Key as never;
        return { object: "page", id: page.id } as never;
      }
      expect(method).toBe("GET"); return structuredClone(page) as never;
    });
    const result = await publishVerifiedShareholdings({ ...args, source: fixture.source, ownerName: fixture.ownerName, zip,
      maxRows: 0, budget, observeIssuedShares: true });
    return { before, page, budget, result };
  }
  it.each(actualAbsences)("通常定期publisherでも保存実 $source.stockCode の明示不該当だけを保存し全他props/価格をPOST照合", async fixture => {
    const { before, page, budget, result } = await realAbsence(fixture);
    expect(result).toMatchObject({ status: "held", parsed: 0, reasonCode: "explicit_not_applicable", notApplicable: fixture.notApplicable });
    expect(restartInfo(page.properties)).toMatchObject({ notApplicable: fixture.notApplicable });
    for (const [name, value] of Object.entries(before.properties)) expect(page.properties[name]).toEqual(value);
    expect(page.properties["保有価格再開情報"].rich_text).toEqual([]); expect(budget.remainingRows).toBe(20);
    expect(queryUniqueRow).not.toHaveBeenCalled(); expect(qualifyHoldingValuation).not.toHaveBeenCalled();
    expect(vi.mocked(notionRequest).mock.calls.filter(([method]) => method === "PATCH")).toHaveLength(1);
  });
  it("実206Aのabsence marker読戻しで旧Keyが一文字でも変更されれば成功にしない", async () => {
    await expect(realAbsence(actualAbsences[0], true)).rejects.toThrow("他の原本props");
    expect(vi.mocked(notionRequest).mock.calls.filter(([method]) => method === "PATCH")).toHaveLength(1);
  });
  it.each(["normal", "following-held", "expired-after-read", "changed-proof", "legacy-cursor", "soft-expired"])("保存実206Aの旧不該当の有限再資格: %s", async mode => {
    const fixture = actualAbsences[0], { page } = await realAbsence(fixture);
    page.properties["保有明細状態"].select = { name: "要確認" };
    page.properties.Metadata = mirrored({ Metadata: { rich_text: [{ text: { content: JSON.stringify({ docID: fixture.source.docId,
      secCode: `${fixture.source.stockCode}0`, edinetCode: fixture.source.edinetCode, periodEnd: fixture.source.fiscalYearEnd,
      filerName: fixture.ownerName, edinetDocType: 1 }) } }] } }).Metadata as never;
    page.properties["Fetched At"] = { type: "date", date: { start: "2026-09-18T00:00:00Z" } } as never;
    if (mode === "changed-proof" || mode === "legacy-cursor") {
      const info = restartInfo(page.properties);
      if (mode === "changed-proof") (info.notApplicable as ShareholdingsNotApplicable).blockHtmlSha256 = "0".repeat(64);
      else { info.sourceQueueVersion = 1; info.sourceNextHoldingOffset = 0; }
      page.properties["保有明細再開情報"] = mirrored({ "保有明細再開情報": { rich_text: [{ text: { content: JSON.stringify(info) } }] } })["保有明細再開情報"] as never;
    }
    const original = vi.mocked(notionRequest).getMockImplementation()!;
    vi.mocked(notionRequest).mockImplementation(async (method, path, body, opts) => {
      if (method === "POST" && path === `/databases/${"p".repeat(32)}/query`) {
        const status = (body as { filter: { select: { equals: string } } }).filter.select.equals;
        return { results: status !== "要確認" ? [] : page.properties["保有明細状態"].select?.name === "要確認"
          ? [structuredClone(page)] : mode === "following-held" ? [{ id: "f".repeat(32), properties: {} }] : [], has_more: false, next_cursor: null } as never;
      }
      return original(method, path, body, opts);
    });
    vi.mocked(queryUniqueRow).mockResolvedValue(page as never);
    vi.mocked(listPageFiles).mockResolvedValue([{ name: `${fixture.source.docId}_xbrl.zip`, kind: "file", url: "https://file.notion.so/saved-only" }]);
    const zip = readFileSync(new URL(`../../../services/yuho-quant/src/tests/fixtures/holdings-absence-cli/${fixture.fixture}`, import.meta.url));
    let expired = false;
    const native = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      if (mode === "expired-after-read") expired = true;
      return new Response(Uint8Array.from(zip));
    });
    vi.mocked(notionRequest).mockClear();
    try {
      const running = resumePendingShareholdings({ sourceDb, maxRows: 100, shouldStop: () => mode === "soft-expired", hardDeadlineReached: () => expired });
      if (mode === "expired-after-read" || mode === "changed-proof") {
        await expect(running).rejects.toThrow(mode === "changed-proof" ? "全文根拠" : "時間予算");
      } else if (mode === "legacy-cursor" || mode === "soft-expired") {
        expect(await running).toEqual({ usedRows: 0, resumed: 0, held: 1, pending: false });
      } else {
        expect(await running).toEqual({ usedRows: 0, resumed: 0, held: mode === "following-held" ? 1 : 0, pending: false, explicitNotApplicable: 1 });
      }
      if (!["normal", "following-held"].includes(mode)) {
        expect(page.properties["保有明細状態"].select?.name).toBe("要確認");
        expect(vi.mocked(notionRequest).mock.calls.filter(([method]) => method === "PATCH")).toHaveLength(0);
        expect(native).toHaveBeenCalledTimes(mode === "legacy-cursor" || mode === "soft-expired" ? 0 : 1);
        return;
      }
      expect(page.properties["保有明細状態"].select?.name).toBe("原本明示不該当");
      expect(restartInfo(page.properties).notApplicable).toEqual(fixture.notApplicable);
      expect(native).toHaveBeenCalledOnce();
      expect(vi.mocked(notionRequest).mock.calls.filter(([method]) => method === "PATCH")).toHaveLength(1);
      expect(vi.mocked(notionRequest).mock.calls.filter(([method, path]) => method === "POST" && path === "/pages")).toHaveLength(0);
    } finally { native.mockRestore(); }
  });

  it.each([ ["rich_text", "x".repeat(200_001)], ["送信予算", "あ".repeat(150_000)] ])(
    "再開情報全体の%s予算超過は値を切らずPATCH0で停止", async (reason, ownerName) => {
      vi.mocked(parseShareholdingsData).mockReturnValue({ ...extraction, status: "unsupported", reason: "protocol-only marker limit", holdings: [] });
      await expect(publishVerifiedShareholdings({ ...args, ownerName })).rejects.toThrow(reason);
      expect(vi.mocked(notionRequest).mock.calls.filter(([method, path]) => method === "PATCH" || method === "POST" && !path.endsWith("/query"))).toHaveLength(0);
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
    expect(notionRequest).toHaveBeenCalledWith("POST", `/databases/${"d".repeat(32)}/query`, { filter: { and: [
      { property: "保有会社コード", rich_text: { equals: source.stockCode } }, { property: "期末", date: { equals: source.fiscalYearEnd } },
    ] }, page_size: 100 });
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

  it.each([false, true])("既存行のfresh差分=%s: 変更時は止め、株数・帳簿価額だけを確定して旧値を保つ", async drift => {
    const existing = { object: "page", id: "e".repeat(32), parent: { type: "database_id", database_id: "d".repeat(32) },
      archived: false, in_trash: false, properties: { ...legacy, ...mirrored(holdingProperties(source,args.ownerName,holding)), "原本照合済": { type: "checkbox", checkbox: false } } };
    let patched = false;
    holdingPeriodRows = async () => patched ? [await requestRouter("GET", `/pages/${existing.id}`)] : [structuredClone(existing)];
    vi.mocked(notionRequest).mockImplementation(async (method, path, body) => {
      if (path === `/pages/${existing.id}`) {
        if (method === "GET" && !patched) {
          const current = structuredClone(existing);
          if (drift) current.properties["原本照合済"].checkbox = true;
          return current;
        }
        if (method === "PATCH") patched = true;
      }
      return requestRouter(method, path, body);
    });
    if (drift) {
      await expect(publishVerifiedShareholdings(args)).rejects.toThrow("fresh全propsが変更");
      expect(patched).toBe(false);
      expect(restartInfo(saved[`/pages/${args.archivePageId}`])).toMatchObject({ sourceNextHoldingOffset: 0 });
      return;
    }
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
      if (method === "POST" && path === "/pages") throw new Error("ACK_UNKNOWN");
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
    expect(vi.mocked(notionRequest).mock.calls.filter(([method, path]) => method === "POST" && path === `/databases/${"d".repeat(32)}/query`)).toHaveLength(2);
  });

  it("前回unknownは次定時にblind replayせず、原本GET/行書込も0", async () => {
    vi.mocked(notionRequest).mockImplementation(async (method, path, body) => method === "POST"
      ? { results: [{ id: args.archivePageId }], has_more: false, next_cursor: null }
      : requestRouter(method, path, body));
    await expect(resumePendingShareholdings({ sourceDb, maxRows: 100, shouldStop: () => false })).rejects.toThrow("結果未確定");
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
      if (method === "POST" && path === `/databases/${"d".repeat(32)}/query`) return requestRouter(method, path, body);
      if (method === "POST" && path.endsWith("/query")) {
        const status = (body as { filter: { select: { equals: string } } }).filter.select.equals;
        return { results: status === "再開待ち" ? [{ id: args.archivePageId, archived: false, in_trash: false,
          properties: mirrored({ "保有明細再開情報": { rich_text: [{ text: { content: JSON.stringify(info) } }] } }) }] : [], has_more: false, next_cursor: null };
      }
      return requestRouter(method, path, body);
    });
    vi.mocked(listPageFiles).mockResolvedValue([{ name: `${source.docId}_xbrl.zip`, kind: "file", url: "https://file.notion.so/saved-only" }]);
    const native = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(Uint8Array.from(args.zip)));
    try {
      expect(await resumePendingShareholdings({ sourceDb, maxRows: 100, shouldStop: () => false })).toEqual({ usedRows: 1, resumed: 1, held: 0, pending: false });
      expect(native).toHaveBeenCalledTimes(1);
      expect(native.mock.calls[0][0]).toBe("https://file.notion.so/saved-only");
      expect(verifyArchivedAttachments).not.toHaveBeenCalled();
    } finally { native.mockRestore(); }
  });

  it("原本照合済の株数へ同日価格根拠だけを追記し、後の原本未指定で価格を消さない", async () => {
    await publishVerifiedShareholdings(args);
    const rowPath = `/pages/${"e".repeat(32)}`;
    holdingPeriodRows = async () => [await requestRouter("GET", rowPath)];
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
    expect(vi.mocked(notionRequest).mock.calls.every(([method, path]) => method === "GET" || method === "POST" && path.endsWith("/query"))).toBe(true);
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
  beforeEach(() => { vi.mocked(listPageFiles).mockResolvedValue([{ name: `${source.docId}_xbrl.zip`, kind: "file", url: "https://file.notion.so/type1" }]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(Uint8Array.from(args.zip))); });
  afterEach(() => vi.restoreAllMocks());
  it("現行keyがあればlegacyを読まず、完全なmetadata/DEI/SHAを照合する", async () => {
    vi.mocked(queryUniqueRow).mockResolvedValue(primary(`${source.docId}:type1`));
    expect(await readSavedHoldingsZip(source)).toMatchObject({ status: "ready", sourceCustody: "typed", originalManifest: "known" });
    expect(queryUniqueRow).toHaveBeenCalledTimes(1);expect(verifySavedHoldingsSource).toHaveBeenCalledWith(args.zip, source);
    expect(notionRequest).not.toHaveBeenCalled();
  });
  it("issuer予算は既知サイズをGET前に予約し、未知サイズは20MiBを確保する", async () => {
    vi.mocked(queryUniqueRow).mockResolvedValue(primary(`${source.docId}:type1`));
    const short = { remainingBytes: args.zip.length - 1 };
    expect(await readSavedHoldingsZip(source, short)).toMatchObject({ status: "held", reasonCode: "budget_exhausted" });
    expect(fetch).not.toHaveBeenCalled(); expect(short.remainingBytes).toBe(args.zip.length - 1);
    vi.mocked(queryUniqueRow).mockResolvedValue(primary(`${source.docId}:type1`, { _fileManifest: undefined }));
    expect(await readSavedHoldingsZip(source, { remainingBytes: 20 * 1024 ** 2 - 1 })).toMatchObject({ status: "held", reasonCode: "budget_exhausted" });
    expect(fetch).not.toHaveBeenCalled();
    const full = { remainingBytes: 20 * 1024 ** 2 };
    expect(await readSavedHoldingsZip(source, full)).toMatchObject({ status: "ready", originalManifest: "unknown" });
    expect(full.remainingBytes).toBe(20 * 1024 ** 2 - args.zip.length); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("issuer読取unknownは予約を返さず、破損サイズmetadataはGET前にSTOPする", async () => {
    vi.mocked(queryUniqueRow).mockResolvedValue(primary(`${source.docId}:type1`)); vi.mocked(fetch).mockRejectedValueOnce(new Error("READ_UNKNOWN"));
    const budget = { remainingBytes: args.zip.length };
    await expect(readSavedHoldingsZip(source, budget)).rejects.toThrow("READ_UNKNOWN"); expect(budget.remainingBytes).toBe(0);
    vi.mocked(queryUniqueRow).mockResolvedValue(primary(`${source.docId}:type1`, { sourceZIPBytes: args.zip.length + 1 }));
    await expect(readSavedHoldingsZip(source, { remainingBytes: 20 * 1024 ** 2 })).rejects.toThrow(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("現行不在時だけlegacy bare keyのtype1を明示採用し、同居CSVを使わない", async () => {
    vi.mocked(queryUniqueRow).mockResolvedValueOnce(null).mockResolvedValueOnce(primary(source.docId));
    vi.mocked(listPageFiles).mockResolvedValue([{ name: `${source.docId}_csv.zip`, kind: "file", url: "https://file.notion.so/csv" }, { name: `${source.docId}_xbrl.zip`, kind: "file", url: "https://file.notion.so/type1" }]);
    expect(await readSavedHoldingsZip(source)).toMatchObject({ status: "ready", sourceCustody: "legacy", archivePageId: "b".repeat(32) });
    expect(queryUniqueRow).toHaveBeenCalledTimes(2);expect(fetch).toHaveBeenCalledTimes(1);expect(vi.mocked(fetch).mock.calls[0][0]).toBe("https://file.notion.so/type1");
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
    vi.mocked(queryUniqueRow).mockResolvedValue(primary(`${source.docId}:type1`));vi.mocked(listPageFiles).mockResolvedValue([{ name: `${source.docId}_csv.zip`, kind: "file", url: "https://file.notion.so/csv" }]);
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
    holdingPeriodRows = async () => Object.values(rows);
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
      if (method === "POST" && path === `/databases/${"d".repeat(32)}/query`) return requestRouter(method, path, body);
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

  it("既完prefixの原本列が変われば残windowを書かず、元cursorを保持してHOLDする", async () => {
    const rows = windowRouter();
    await publishVerifiedShareholdings({ ...args, maxRows: 1 });
    Object.assign(rows[`/pages/${"e".repeat(32)}`].properties, mirrored({ "保有株数": { number: 13 } }));
    vi.mocked(notionRequest).mockClear();
    expect(await publishVerifiedShareholdings({ ...args, maxRows: 1 }))
      .toMatchObject({ status: "held", reason: expect.stringContaining("既完window") });
    expect(Object.keys(rows)).toHaveLength(1);
    expect(savedInfo().sourceNextHoldingOffset).toBe(1);
    expect(testProperties(saved[sourcePath])["保有明細状態"].select!.name).toBe("要確認");
    expect(vi.mocked(notionRequest).mock.calls.filter(([method, path]) => method === "POST" && path === `/databases/${"d".repeat(32)}/query`)).toHaveLength(1);
    expect(vi.mocked(notionRequest).mock.calls.some(([method, path]) => method === "POST" && path === "/pages")).toBe(false);
  });

  it("最終window後の全原表でdriftを検出したら完了や価格queueを登録せず、unknownを保持する", async () => {
    const rows = windowRouter();
    await publishVerifiedShareholdings({ ...args, maxRows: 1 });
    const listing = holdingPeriodRows; let calls = 0;
    holdingPeriodRows = async () => {
      if (++calls === 2) Object.assign(rows[`/pages/${"e".repeat(32)}`].properties, mirrored({ "出典Context": { rich_text: [{ text: { content: "EXPLICIT_POST_WINDOW_DRIFT" } }] } }));
      return listing();
    };
    await expect(publishVerifiedShareholdings({ ...args, maxRows: 1 })).rejects.toThrow("全原表の最終読戻し");
    expect(Object.keys(rows)).toHaveLength(2);
    expect(savedInfo().sourceNextHoldingOffset).toBe(1);
    expect(testProperties(saved[sourcePath])["保有明細状態"].select!.name).toBe("実行中（結果未確定）");
    expect(testProperties(saved[sourcePath])["保有価格再開情報"]).toBeUndefined();
    vi.mocked(notionRequest).mockClear();
    await expect(publishVerifiedShareholdings({ ...args, maxRows: 1 })).rejects.toThrow("結果未確定source");
    expect(vi.mocked(notionRequest).mock.calls.every(([method, path]) => method === "GET" || method === "POST" && path.endsWith("/query"))).toBe(true);
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
      expect(vi.mocked(notionRequest).mock.calls.some(([method, path]) => method === "PATCH" || method === "POST" && path === "/pages")).toBe(false);
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
    await expect(publishVerifiedShareholdings({ ...args, maxRows: 1 })).rejects.toThrow("結果未確定source");
    expect(vi.mocked(notionRequest).mock.calls.every(([method, path]) => method === "GET" || method === "POST" && path.endsWith("/query"))).toBe(true);
  });

  it.each([args.zip.length, 6 * 1024 * 1024])("通常source再開が保存ZIP/native資格を再用し、部分windowの消費行数を計数する（%s bytes）", async size => {
    const zip = size === args.zip.length ? args.zip : Buffer.alloc(size);
    windowRouter(); await publishVerifiedShareholdings({ ...args, zip, maxRows: 0 });
    vi.mocked(listPageFiles).mockResolvedValue([{ name: `${source.docId}_xbrl.zip`, kind: "file", url: "https://file.notion.so/source-window" }]);
    const native = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(Uint8Array.from(zip)));
    expect(await resumePendingShareholdings({ sourceDb, maxRows: 1, shouldStop: () => false })).toEqual({ usedRows: 1, resumed: 1, held: 0, pending: true });
    expect(savedInfo().sourceNextHoldingOffset).toBe(1);
    expect(await resumePendingShareholdings({ sourceDb, maxRows: 1, shouldStop: () => false })).toEqual({ usedRows: 1, resumed: 1, held: 0, pending: false });
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

  async function seedPublishedSource(valuationSources?: { codeList: typeof evidence; prices: typeof evidence[] }, zip = args.zip) {
    await publishVerifiedShareholdings({ ...args, zip, valuationSources });
    vi.mocked(listPageFiles).mockResolvedValue([{ name: `${source.docId}_xbrl.zip`, kind: "file", url: "https://file.notion.so/saved-price-phase-only" }]);
    vi.mocked(queryUniqueRow).mockImplementation(async dbId => {
      if (dbId !== "p".repeat(32)) return await requestRouter("GET", rowPath) as { id: string };
      const page = await requestRouter("GET", `/pages/${args.archivePageId}`) as { id: string; properties: Record<string, unknown> };
      return { ...page, properties: { ...page.properties, ...mirrored({ Metadata: { rich_text: [{ text: { content: JSON.stringify({
        docID: source.docId, secCode: `${source.stockCode}0`, edinetCode: source.edinetCode, periodEnd: source.fiscalYearEnd,
        edinetDocType: 1, sourceZIPSHA: createHash("sha256").update(zip).digest("hex"), sourceZIPBytes: zip.length,
      }) } }] }, "Fetched At": { date: { start: "2026-07-01T00:00:00Z" } } }) } };
    });
    vi.mocked(notionRequest).mockImplementation(async (method, path, body) => {
      if (method === "POST" && path === `/databases/${"d".repeat(32)}/query`) return requestRouter(method, path, body);
      if (method === "POST" && path.endsWith("/query")) {
        type Filter = { property: string; select?: { equals: string }; rich_text?: { contains?: string; does_not_contain?: string } };
        const raw = (body as { filter: Filter & { and?: Filter[] } }).filter, filters = raw.and === undefined ? [raw] : raw.and;
        const page = { ...await requestRouter("GET", `/pages/${args.archivePageId}`) as { properties: Record<string, { select?: { name: string }; rich_text?: Array<{ plain_text: string }> }> },
          created_time: "2026-07-01T00:00:00.000Z", last_edited_time: "2026-07-01T00:00:00.000Z" }; // declared native transport clocks
        const matches = filters.every(filter => {
          const prop=page.properties[filter.property]; if(filter.select) return prop?.select?.name === filter.select.equals;
          const text=prop?.rich_text?.map(v=>v.plain_text).join("");
          return text !== undefined && (filter.rich_text?.contains === undefined || text.includes(filter.rich_text.contains)) &&
            (filter.rich_text?.does_not_contain === undefined || !text.includes(filter.rich_text.does_not_contain));
        });
        return { results: matches ? [page] : [], has_more: false, next_cursor: null };
      }
      const response=await requestRouter(method,path,body);
      return method === "GET" && path === `/pages/${args.archivePageId}` ? { ...response as object,
        created_time:"2026-07-01T00:00:00.000Z",last_edited_time:"2026-07-01T00:00:00.000Z" } : response;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(Uint8Array.from(zip)));
    return structuredClone(saved[`/pages/${args.archivePageId}`]) as Record<string, unknown>;
  }

  it("宣言したexact-doc取下げHOLDはprice unknown marker/ZIP GET/価格loaderより前に止める", async () => {
    await seedPublishedSource();
    const { db, sqlite } = createReportedSourceTestDb();
    sqlite.prepare("insert into yuho_edinet_reported_changes (source_page_id,seq_number,source_raw_sha256,doc_id,parent_doc_id,reported_state,observation_json) values(?,?,?,?,?,?,?)").run(
      "declared-source", 1, "declared-not-original-SHA", source.docId, null, "reported_withdrawal", "{\"protocolFault\":true}");
    const before = structuredClone(saved), loader = vi.fn(async () => ready);
    vi.mocked(notionRequest).mockClear(); vi.mocked(listPageFiles).mockClear();
    const outcome = await resumePendingShareholdingsPrices({ sourceDb: db, maxRows: 100, shouldStop: () => false, budget: budget(), loadSources: loader });
    expect(outcome).toMatchObject({ usedRows: 0, resumed: 0, held: 1 });
    expect(saved).toEqual(before); expect(loader).not.toHaveBeenCalled(); expect(listPageFiles).not.toHaveBeenCalled();
    expect(vi.mocked(notionRequest).mock.calls.filter(([method]) => method === "PATCH" || method === "DELETE")).toEqual([]); sqlite.close();
  });
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
  it("publisher→保存reader→価格resumeが共通20MiB予算で5MiB超の同じ全ZIPを照合する", async () => {
    const zip = Buffer.alloc(6 * 1024 * 1024);
    await seedPublishedSource(undefined, zip);
    vi.mocked(qualifyHoldingValuation).mockResolvedValue(qualified());
    expect(await resumePendingShareholdingsPrices({ sourceDb, maxRows: 100, shouldStop: () => false, budget: budget(), loadSources: async () => ready }))
      .toEqual({ usedRows: 1, resumed: 1, held: 0, pending: false });
    const verified = vi.mocked(verifySavedHoldingsSource).mock.calls.at(-1)!;
    const parsed = vi.mocked(parseShareholdingsData).mock.calls.at(-1)!;
    expect(verified[0].length).toBe(zip.length); expect(verified[1]).toEqual(source); expect(parsed[1]).toEqual(source);
    const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
    expect(sha(verified[0])).toBe(sha(zip)); expect(sha(parsed[0])).toBe(sha(zip));
    expect(restartInfo(saved[`/pages/${args.archivePageId}`], "保有価格").zipBytes).toBe(zip.length);
    vi.mocked(parseShareholdingsData).mockClear(); saved = {};
    expect(await publishVerifiedShareholdings({ ...args, zip: Buffer.alloc(20 * 1024 * 1024 + 1) }))
      .toMatchObject({ status: "held", reason: expect.stringContaining("20MiB") });
    expect(parseShareholdingsData).not.toHaveBeenCalled();
  });

  it("原本/価格の両完了後の価格付きbackfill再実行はcursor終端を照合してwrite0", async () => {
    await seedPublishedSource();
    vi.mocked(qualifyHoldingValuation).mockResolvedValue(qualified());
    await resumePendingShareholdingsPrices({ sourceDb, maxRows: 100, shouldStop: () => false, budget: budget(), loadSources: async () => ready });
    const before = structuredClone(saved);
    vi.mocked(notionRequest).mockClear(); vi.mocked(queryUniqueRow).mockClear();
    expect(await publishVerifiedShareholdings({ ...args, valuationSources: ready })).toEqual({ status: "published", parsed: 0, created: 0, updated: 0, unchanged: 0 });
    expect(saved).toEqual(before);
    expect(vi.mocked(notionRequest).mock.calls.every(([method, path]) => method === "GET" || method === "POST" && path.endsWith("/query"))).toBe(true);
    expect(queryUniqueRow).not.toHaveBeenCalled();
  });

  it("保存ZIPと同じ原表を照合後に既writerへ価格根拠を渡し、価格列以外はPATCHしない", async () => {
    const sourceBefore = await seedPublishedSource(), rowBefore = structuredClone(saved[rowPath]) as Record<string, unknown>;
    vi.mocked(qualifyHoldingValuation).mockResolvedValue(qualified());
    const loader = vi.fn<HoldingPriceSourceLoader>(async () => ready);
    const shouldStop = () => false;
    const result = await resumePendingShareholdingsPrices({ sourceDb, maxRows: 100, shouldStop, budget: budget(), loadSources: loader });
    expect(result).toEqual({ usedRows: 1, resumed: 1, held: 0, pending: false });
    expect(loader).toHaveBeenCalledWith(extraction.holdings, budget(), shouldStop, source.fiscalYearEnd, undefined);
    const patch = vi.mocked(notionRequest).mock.calls.find(([method, path]) => method === "PATCH" && path === rowPath)![2] as { properties: Record<string, unknown> };
    expect(patch.properties).toMatchObject({ "株価": { number: 100 }, "保有時価": { number: 1200 }, "価格照合済": { checkbox: true } });
    for (const name of ["保有株数", "帳簿価額（円）", "出典原本SHA256", "原本照合済", "Name"]) expect(patch.properties).not.toHaveProperty(name);
    const sourceAfter = saved[`/pages/${args.archivePageId}`] as Record<string, unknown>;
    for (const name of ["保有明細状態", "保有明細理由", "保有明細再開情報"]) expect(sourceAfter[name]).toEqual(sourceBefore[name]);
    expect(sourceAfter["保有価格状態"]).toEqual({ select: { name: "価格照合完了" } });
    for (const [name, value] of Object.entries(rowBefore)) if (!Object.hasOwn(patch.properties, name)) expect((saved[rowPath] as Record<string, unknown>)[name]).toEqual(value);
  });

  it("同じ保存ZIP parserの商号変更診断をloaderと価格qualifierの双方へ渡す", async () => {
    const nameChanges: NonNullable<ShareholdingsExtraction["nameChanges"]> = [];
    vi.mocked(parseShareholdingsData).mockReturnValue({ ...extraction, nameChanges });
    await seedPublishedSource(); vi.mocked(qualifyHoldingValuation).mockResolvedValue(qualified());
    const loader = vi.fn<HoldingPriceSourceLoader>(async () => ready);
    expect(await resumePendingShareholdingsPrices({ sourceDb, maxRows: 100, shouldStop: () => false, budget: budget(), loadSources: loader }))
      .toMatchObject({ usedRows: 1, resumed: 1, held: 0 });
    expect(loader.mock.calls[0][4]).toBe(nameChanges);
    expect(vi.mocked(qualifyHoldingValuation).mock.calls.at(-1)![0].nameChanges).toBe(nameChanges);
  });

  it.each([
    { ownerCode: "1333", symbol: "8418.T", expectedEnglishName: "Yamaguchi Finacial Group,Inc.", observedEnglishName: "Yamaguchi Financial Group, Inc.",
      gzipSha256: "c663f9b644752012e86747eb3526f6f09790de1d140e3627b052445edb8acafd", bodySha256: "1aca595d4d08cd9cb45e264ca2a45bfeee31562cc6470c9891eae120720a31b3" },
    { ownerCode: "1377", symbol: "2874.T", expectedEnglishName: "Yokohama Reito Co.,Ltd.", observedEnglishName: "Yokorei Co.,Ltd.",
      gzipSha256: "c5702632f04bc1eddb6be1541c55b110bd408ea9ba8ff5b7b3fef6b3d155af18", bodySha256: "be0bea4b6040077c1873624b77fee3d91984ad9fae3d19a800c45dd1886afb45" },
  ])("保存原本で確認した単独商号不一致だけを未資格行へ分離し、独立した価格行を採用する: $ownerCode", async ({ ownerCode: _, ...proof }) => {
    const holdings = [holding, { ...holding, kind: "みなし保有株式" as const, rowIndex: 4 }];
    vi.mocked(parseShareholdingsData).mockReturnValue({ ...extraction, holdings });
    const sourceBefore = await seedPublishedSource(), rowsBefore = structuredClone(saved);
    const mismatch = new HoldingPriceIssuerMismatch({ ...proof, archivePageId: evidence.archivePageId, filename: evidence.filename });
    vi.mocked(qualifyHoldingValuation).mockResolvedValueOnce(qualified()).mockRejectedValueOnce(mismatch);
    vi.mocked(notionRequest).mockClear();
    expect(await resumePendingShareholdingsPrices({ sourceDb, maxRows: 100, shouldStop: () => false, budget: budget(), loadSources: async () => ready }))
      .toEqual({ usedRows: 2, resumed: 1, held: 1, pending: false });
    expect(saved[rowPath]).toMatchObject({ "株価": { number: 100 }, "保有時価": { number: 1200 }, "価格照合済": { checkbox: true } });
    const unavailablePath = `/pages/${"f".repeat(32)}`;
    expect(saved[unavailablePath]).toMatchObject({ "株価": { number: null }, "保有時価": { number: null }, "価格照合済": { checkbox: false } });
    expect(JSON.stringify((saved[unavailablePath] as Record<string, unknown>)["欠測理由"])).toContain(proof.bodySha256);
    const pricePatches = vi.mocked(notionRequest).mock.calls.filter(([method, path]) => method === "PATCH" && [rowPath, unavailablePath].includes(path));
    expect(pricePatches).toHaveLength(2);expect(vi.mocked(notionRequest).mock.calls.some(([method, path]) => method === "POST" && path === "/pages")).toBe(false);
    const priceColumns = new Set(["株価", "保有時価", "通貨", "基準日", "区分", "確定銘柄コード", "銘柄照合根拠", "価格照合根拠", "価格照合済", "欠測理由"]);
    for (const [, , body] of pricePatches) for (const name of Object.keys((body as { properties: Record<string, unknown> }).properties)) expect(priceColumns.has(name)).toBe(true);
    for (const path of [rowPath, unavailablePath]) for (const [name, value] of Object.entries(rowsBefore[path] as Record<string, unknown>)) if (!priceColumns.has(name)) expect((saved[path] as Record<string, unknown>)[name]).toEqual(value);
    expect(saved[`/pages/${args.archivePageId}`]).toMatchObject({ "保有価格状態": { select: { name: "要確認" } } });
    expect(restartInfo(saved[`/pages/${args.archivePageId}`], "保有価格")).toMatchObject({ nextHoldingOffset: 2, unavailableRows: 1 });
    for (const name of ["保有明細状態", "保有明細理由", "保有明細再開情報"]) expect((saved[`/pages/${args.archivePageId}`] as Record<string, unknown>)[name]).toEqual(sourceBefore[name]);
  });

  it("実1798の市場3/30・法的4/1・FY3/31分割前株数はunknownより前にHOLDし全価格/旧cursorを保持する", async () => {
    const issuer = JSON.parse(readFileSync(new URL("../../../services/yuho-quant/src/tests/fixtures/holdings-split-1798/qualified-evidence.json", import.meta.url), "utf8"));
    const sourceBefore = await seedPublishedSource(), rowsBefore = structuredClone(saved);
    const mismatch = new HoldingPriceShareBasisMismatch({ symbol: "1798.T", fiscalYearEnd: "2026-03-31", marketExDate: "2026-03-30",
      priceCapturedAt: issuer.priceCapturedAt, priceBodySha256: "62ad3b17c528bb5e89ae781746f350932da60a9152992d53b13fc5bfdc2914ef", issuer, basis: issuer.preSplitFiscalYearBasis });
    vi.mocked(qualifyHoldingValuation).mockRejectedValue(mismatch); vi.mocked(notionRequest).mockClear();
    expect(await resumePendingShareholdingsPrices({ sourceDb, maxRows: 100, shouldStop: () => false, budget: budget(), loadSources: async () => ready }))
      .toEqual({ usedRows: 0, resumed: 0, held: 1, pending: false });
    const mutations = vi.mocked(notionRequest).mock.calls.filter(([method, path]) => method === "PATCH" || method === "POST" && path === "/pages");
    expect(mutations).toHaveLength(1); expect(mutations[0][1]).toBe(`/pages/${args.archivePageId}`);
    expect(JSON.stringify(mutations)).not.toContain("実行中（結果未確定）");
    expect(saved[`/pages/${args.archivePageId}`]).toMatchObject({ "保有価格状態": { select: { name: "要確認" } } });
    expect(restartInfo(saved[`/pages/${args.archivePageId}`], "保有価格")).toEqual(restartInfo(sourceBefore, "保有価格"));
    for (const name of ["保有明細状態", "保有明細理由", "保有明細再開情報"]) expect((saved[`/pages/${args.archivePageId}`] as Record<string, unknown>)[name]).toEqual(sourceBefore[name]);
    for (const [path, row] of Object.entries(rowsBefore)) if (path !== `/pages/${args.archivePageId}`) expect(saved[path]).toEqual(row);
    // Same prose with an untyped transport/source error remains an unknown latch; no catch-all reclassification.
    saved = structuredClone(rowsBefore); vi.mocked(qualifyHoldingValuation).mockRejectedValue(new Error(mismatch.message));
    await expect(resumePendingShareholdingsPrices({ sourceDb, maxRows: 100, shouldStop: () => false, budget: budget(), loadSources: async () => ready })).rejects.toThrow("期末株数");
    expect(saved[`/pages/${args.archivePageId}`]).toMatchObject({ "保有価格状態": { select: { name: "実行中（結果未確定）" } } });
  });

  it("全価格資格後にも公式英字名の最新doc変更を事前HOLDし価格書込0を守る", async () => {
    await seedPublishedSource(); vi.mocked(qualifyHoldingValuation).mockResolvedValue(qualified()); vi.mocked(notionRequest).mockClear();
    const checkOfficialIssuerNames = vi.fn(async () => ({ status: "held" as const, reason: "公式issuerの最新doc変更" }));
    expect(await resumePendingShareholdingsPrices({ sourceDb, maxRows: 100, shouldStop: () => false, budget: budget(), loadSources: async () => ({ ...ready, checkOfficialIssuerNames }) }))
      .toEqual({ usedRows: 0, resumed: 0, held: 1, pending: false });
    expect(checkOfficialIssuerNames).toHaveBeenCalledTimes(1);
    const patches = vi.mocked(notionRequest).mock.calls.filter(([method]) => method === "PATCH");
    expect(patches).toHaveLength(1); expect(JSON.stringify(patches)).not.toContain("実行中（結果未確定）");
    expect(saved[`/pages/${args.archivePageId}`]).toMatchObject({ "保有価格状態": { select: { name: "要確認" } } });
  });

  it("writer前issuer再照合の時間予算不足は価格unknownへ入れず再開待ち/cursorを保持する", async () => {
    const before = await seedPublishedSource(); vi.mocked(qualifyHoldingValuation).mockResolvedValue(qualified()); vi.mocked(notionRequest).mockClear();
    const checkOfficialIssuerNames = async () => ({ status: "held" as const, reasonCode: "budget_exhausted" as const, reason: "公式issuer照合の実時間予算不足" });
    expect(await resumePendingShareholdingsPrices({ sourceDb, maxRows: 100, shouldStop: () => false, budget: budget(), loadSources: async () => ({ ...ready, checkOfficialIssuerNames }) }))
      .toEqual({ usedRows: 0, resumed: 0, held: 0, pending: true });
    const patches = vi.mocked(notionRequest).mock.calls.filter(([method]) => method === "PATCH");
    expect(patches).toHaveLength(1); expect(JSON.stringify(patches)).not.toContain("実行中（結果未確定）");
    expect(saved[`/pages/${args.archivePageId}`]).toMatchObject({ "保有価格状態": { select: { name: "再開待ち" } } });
    expect(restartInfo(saved[`/pages/${args.archivePageId}`], "保有価格")).toEqual(restartInfo(before, "保有価格"));
  });

  it("英字商号と同じmessageでも型付き事前不一致以外はunknown STOPを維持する", async () => {
    await seedPublishedSource(); vi.mocked(qualifyHoldingValuation).mockRejectedValue(new Error("価格原本の発行体英字商号が一致しません"));
    await expect(resumePendingShareholdingsPrices({ sourceDb, maxRows: 100, shouldStop: () => false, budget: budget(), loadSources: async () => ready })).rejects.toThrow("英字商号");
    expect(saved[`/pages/${args.archivePageId}`]).toMatchObject({ "保有価格状態": { select: { name: "実行中（結果未確定）" } } });
    expect(vi.mocked(notionRequest).mock.calls.filter(([method, path]) => method === "PATCH" && path === rowPath)).toHaveLength(0);
  });

  it("価格指定CLIも同じ行未資格を通り、既存unknownは型付き不一致でも上書きしない", async () => {
    await seedPublishedSource();
    const error = new HoldingPriceIssuerMismatch({ symbol: "8418.T", expectedEnglishName: "Yamaguchi Finacial Group,Inc.", observedEnglishName: "Yamaguchi Financial Group, Inc.",
      archivePageId: evidence.archivePageId, filename: evidence.filename, gzipSha256: evidence.sha256, bodySha256: evidence.sha256 });
    vi.mocked(qualifyHoldingValuation).mockRejectedValue(error); vi.mocked(notionRequest).mockClear();
    expect(await publishVerifiedShareholdings({ ...args, valuationSources: ready })).toMatchObject({ status: "published", unavailable: 1 });
    expect(saved[rowPath]).toMatchObject({ "価格照合済": { checkbox: false } });
    expect(JSON.stringify((saved[rowPath] as Record<string, unknown>)["欠測理由"])).toContain(error.proof.bodySha256);
    await requestRouter("PATCH", `/pages/${args.archivePageId}`, { properties: { "保有価格状態": { select: { name: "実行中（結果未確定）" } } } });
    const before = structuredClone(saved); vi.mocked(notionRequest).mockClear(); vi.mocked(qualifyHoldingValuation).mockClear();
    await expect(publishVerifiedShareholdings({ ...args, valuationSources: ready })).rejects.toThrow("前回結果が未確定");
    expect(saved).toEqual(before); expect(qualifyHoldingValuation).not.toHaveBeenCalled();
    expect(vi.mocked(notionRequest).mock.calls.some(([method]) => method === "PATCH")).toBe(false);
  });

  it("snapshot外/未同定価格はNULLと範囲理由を残し、完了値として扱わない", async () => {
    await seedPublishedSource();
    vi.mocked(qualifyHoldingValuation).mockResolvedValue({ status: "unavailable", identity: null, reason: "保存価格の資格なし" });
    const result = await resumePendingShareholdingsPrices({ sourceDb, maxRows: 100, shouldStop: () => false, budget: budget(), loadSources: async () => ready });
    expect(result).toMatchObject({ resumed: 1, held: 1 });
    expect(saved[rowPath]).toMatchObject({ "株価": { number: null }, "保有時価": { number: null }, "価格照合済": { checkbox: false } });
    expect(JSON.stringify((saved[rowPath] as Record<string, unknown>)["欠測理由"])).toContain(ready.evidenceScope);
    expect(saved[`/pages/${args.archivePageId}`]).toMatchObject({ "保有明細状態": { select: { name: "明細原本照合済" } }, "保有価格状態": { select: { name: "要確認" } } });
  });

  it.each(["価格状態の旧値", "価格状態の新値", "価格状態のID", "他のformula"])("計算列の正常な再計算だけを許可し、%sの不整合はSTOPする", async (change) => {
    await seedPublishedSource(); vi.mocked(qualifyHoldingValuation).mockResolvedValue(qualified());
    const route = vi.mocked(notionRequest).getMockImplementation()!;
    const corrupt = (value: unknown) => {
      const result = value as { properties: Record<string, { checkbox?: boolean; id?: string; formula: { string: string } }> };
      const checked = result.properties["価格照合済"].checkbox;
      if (change === "価格状態の旧値" && !checked || change === "価格状態の新値" && checked) result.properties["価格状態"].formula.string = "不整合";
      if (change === "価格状態のID") result.properties["価格状態"].id = "別ID";
      if (change === "他のformula" && checked) result.properties["検証状態"].formula.string = "不整合";
      return value;
    };
    const query = holdingPeriodRows;
    holdingPeriodRows = async () => (await query()).map(corrupt);
    vi.mocked(notionRequest).mockImplementation(async (method, path, ...rest) => {
      const result = await route(method, path, ...rest);
      return method === "GET" && path === rowPath ? corrupt(result) : result;
    });
    vi.mocked(notionRequest).mockClear();
    await expect(resumePendingShareholdingsPrices({ sourceDb, maxRows: 100, shouldStop: () => false, budget: budget(), loadSources: async () => ready })).rejects.toThrow(change === "他のformula" ? "他props" : "価格状態");
    const writes = vi.mocked(notionRequest).mock.calls.filter(([method, path]) => method === "PATCH" && path === rowPath);
    expect(writes).toHaveLength(change === "価格状態の旧値" || change === "価格状態のID" ? 0 : 1);
    expect(saved[`/pages/${args.archivePageId}`]).toMatchObject({ "保有価格状態": { select: { name: "実行中（結果未確定）" } } });
  });

  it("既に原本・価格照合済みの値は新snapshot欠測で消さず、架空NULLにも欠測数にも置換しない", async () => {
    vi.mocked(qualifyHoldingValuation).mockResolvedValue(qualified());
    await seedPublishedSource({ codeList: evidence, prices: [evidence] });
    const previous = structuredClone(saved[rowPath]);
    vi.mocked(qualifyHoldingValuation).mockResolvedValue({ status: "unavailable", identity: null, reason: "新snapshot内の該当観測なし" });
    expect(await resumePendingShareholdingsPrices({ sourceDb, maxRows: 100, shouldStop: () => false, budget: budget(), loadSources: async () => ready })).toMatchObject({ resumed: 1, held: 0 });
    expect(saved[rowPath]).toEqual(previous);
    expect(saved[`/pages/${args.archivePageId}`]).toMatchObject({ "保有価格状態": { select: { name: "価格照合完了" } } });
  });

  it.each([
    new Error("PRICE_ACK_UNKNOWN"),
    new HoldingPriceIssuerMismatch({ symbol: "8418.T", expectedEnglishName: "Yamaguchi Finacial Group,Inc.", observedEnglishName: "Yamaguchi Financial Group, Inc.",
      archivePageId: evidence.archivePageId, filename: evidence.filename, gzipSha256: evidence.sha256, bodySha256: evidence.sha256 }),
  ])("価格mutation後の例外は型に関わらずunknownを保持し、次定時は原本GET/loader/価格再送0: $name", async error => {
    const sourceBefore = await seedPublishedSource();
    vi.mocked(qualifyHoldingValuation).mockResolvedValue(qualified());
    const routing = vi.mocked(notionRequest).getMockImplementation()!;
    vi.mocked(notionRequest).mockImplementation(async (method, path, ...rest) => {
      if (method === "PATCH" && path === rowPath) throw error;
      return routing(method, path, ...rest);
    });
    const loader = vi.fn(async () => ready), options = { sourceDb, maxRows: 100, shouldStop: () => false, budget: budget(), loadSources: loader };
    await expect(resumePendingShareholdingsPrices(options)).rejects.toThrow(error);
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
    await expect(resumePendingShareholdingsPrices({ sourceDb, maxRows: 100, shouldStop: () => false, budget: budget(), loadSources: async () => ready })).rejects.toThrow("PATCH ACKが別行");
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
    await expect(resumePendingShareholdingsPrices({ sourceDb, maxRows: 1, shouldStop: () => false, budget: budget(), loadSources: loader })).rejects.toThrow("全facts/order");
    expect(loader).not.toHaveBeenCalled();
    expect(vi.mocked(notionRequest).mock.calls.filter(([method, path]) => method === "PATCH" && path === rowPath)).toHaveLength(0);
    expect(saved[`/pages/${args.archivePageId}`]).toMatchObject({ "保有明細状態": { select: { name: "明細原本照合済" } }, "保有価格状態": { select: { name: "実行中（結果未確定）" } } });
  });

  it("未有効化snapshotは予算待ちへ誤分類せず要確認としてsource完了を保持する", async () => {
    await seedPublishedSource();
    expect(await resumePendingShareholdingsPrices({ sourceDb, maxRows: 100, shouldStop: () => false, budget: budget(),
      loadSources: async () => ({ status: "held", reasonCode: "snapshot_unavailable", reason: "有効化未完了" }) })).toMatchObject({ resumed: 0, held: 1, pending: false });
    expect(saved[`/pages/${args.archivePageId}`]).toMatchObject({ "保有価格状態": { select: { name: "要確認" } }, "保有明細状態": { select: { name: "明細原本照合済" } } });
  });

  it("価格source資格throwでもsource完了は保持し、予算不足だけは次定時に残す", async () => {
    await seedPublishedSource();
    const held = await resumePendingShareholdingsPrices({ sourceDb, maxRows: 100, shouldStop: () => false, budget: budget(),
      loadSources: async () => ({ status: "held", reason: "全必要chunkの残予算不足", reasonCode: "budget_exhausted" }) });
    expect(held).toMatchObject({ resumed: 0, pending: true });
    expect(saved[`/pages/${args.archivePageId}`]).toMatchObject({ "保有明細状態": { select: { name: "明細原本照合済" } }, "保有価格状態": { select: { name: "再開待ち" } } });
    await expect(resumePendingShareholdingsPrices({ sourceDb, maxRows: 100, shouldStop: () => false, budget: budget(),
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
      archived: false, in_trash: false, properties: { ...legacy, ...mirrored((call[2] as { properties: Record<string, unknown> }).properties),
        ...formulaStatuses((call[2] as { properties: Record<string, unknown> }).properties) } }));
    holdingPeriodRows = async () => structuredClone(rows);
    const originalRequest = vi.mocked(notionRequest).getMockImplementation()!;
    vi.mocked(notionRequest).mockImplementation(async (method, path, body, options) => {
      const row = rows.find(row => path === `/pages/${row.id}`);
      if (!row) return originalRequest(method, path, body, options);
      if (method === "PATCH") { Object.assign(row.properties, mirrored((body as { properties: Record<string, unknown> }).properties)); Object.assign(row.properties, formulaStatuses(row.properties)); return { object: "page", id: row.id }; }
      return structuredClone(row);
    });
    vi.mocked(qualifyHoldingValuation).mockResolvedValue(qualified());
    const loader = vi.fn<HoldingPriceSourceLoader>(async () => ready);
    const options = { sourceDb, maxRows: 1, shouldStop: () => false, budget: budget(), loadSources: loader };
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
  async function completedUnavailable() {
    await seedPublishedSource();
    vi.mocked(qualifyHoldingValuation).mockResolvedValue({ status: "unavailable", identity: null, reason: "旧snapshotで原本資格未成立" });
    await resumePendingShareholdingsPrices({ sourceDb,maxRows:100,shouldStop:()=>false,budget:budget(),loadSources:async()=>ready });
    expect(restartInfo(saved[`/pages/${args.archivePageId}`],"保有価格")).toMatchObject({snapshotId:ready.snapshotId,nextHoldingOffset:1,unavailableRows:1});
    vi.mocked(recordPrimaryData).mockResolvedValue({pageId:"1".repeat(32),outcome:"recorded",fileTooLarge:false,manifestMatch:"written"});
    vi.mocked(verifyArchivedAttachments).mockResolvedValue(undefined);
    vi.mocked(notionRequest).mockClear(); vi.mocked(recordPrimaryData).mockClear();
  }
  const nextLoader=()=>Object.assign(async()=>({...ready,snapshotId:"next-price-snapshot"}),{currentSnapshotId:async()=>"next-price-snapshot"});
  it("新世代だけ完了HOLDの全原表PREを物理保管し、通常価格writerで未資格行を回復する", async()=>{
    await completedUnavailable(); const before=structuredClone(saved);
    vi.mocked(qualifyHoldingValuation).mockResolvedValue(qualified());
    expect(await resumePendingShareholdingsPrices({sourceDb,maxRows:100,shouldStop:()=>false,budget:budget(),loadSources:nextLoader()})).toMatchObject({usedRows:1,resumed:1,held:0});
    expect(recordPrimaryData).toHaveBeenCalledTimes(1);
    const archived=vi.mocked(recordPrimaryData).mock.calls[0][0], pre=JSON.parse(Buffer.from(archived.files![0].bytes).toString());
    expect(pre.previousInfo).toMatchObject({snapshotId:ready.snapshotId,nextHoldingOffset:1,unavailableRows:1});expect(pre.rows).toHaveLength(1);
    expect(verifyArchivedAttachments).toHaveBeenCalledWith("1".repeat(32),archived.files!.map(f=>({filename:f.filename,bytes:f.bytes})),"保有価格再資格PRE");
    expect(restartInfo(saved[`/pages/${args.archivePageId}`],"保有価格")).toMatchObject({snapshotId:"next-price-snapshot",nextHoldingOffset:1,unavailableRows:0,
      previousPricePass:{snapshotId:ready.snapshotId,nextHoldingOffset:1,unavailableRows:1,pre:{pageId:"1".repeat(32)}}});
    for(const field of ["保有明細状態","保有明細理由","保有明細再開情報"]) expect(testProperties(saved[`/pages/${args.archivePageId}`])[field]).toEqual(testProperties(before[`/pages/${args.archivePageId}`])[field]);
  });
  it("同snapshotやsource未完了は価格HOLDを再開せずarchive/PATCH0",async()=>{
    await completedUnavailable();
    const same=Object.assign(async()=>ready,{currentSnapshotId:async()=>ready.snapshotId});
    await resumePendingShareholdingsPrices({sourceDb,maxRows:100,shouldStop:()=>false,budget:budget(),loadSources:same});
    expect(recordPrimaryData).not.toHaveBeenCalled();expect(vi.mocked(notionRequest).mock.calls.filter(([m])=>m==="PATCH")).toEqual([]);
    testProperties(saved[`/pages/${args.archivePageId}`])["保有明細状態"]={select:{name:"要確認"}}; // declared208A-like source quarantine
    await resumePendingShareholdingsPrices({sourceDb,maxRows:100,shouldStop:()=>false,budget:budget(),loadSources:nextLoader()});
    expect(recordPrimaryData).not.toHaveBeenCalled();expect(vi.mocked(notionRequest).mock.calls.filter(([m])=>m==="PATCH")).toEqual([]);
  });
  it("再資格ZIPも既source byte予算へ入場し、不足ならhosted GET/PRE/PATCH0",async()=>{
    await completedUnavailable();vi.mocked(fetch).mockClear();const limit={remainingChunks:116,remainingBytes:args.zip.length-1};
    await resumePendingShareholdingsPrices({sourceDb,maxRows:100,shouldStop:()=>false,budget:limit,loadSources:nextLoader()});
    expect(fetch).not.toHaveBeenCalled();expect(recordPrimaryData).not.toHaveBeenCalled();expect(vi.mocked(notionRequest).mock.calls.filter(([m])=>m==="PATCH")).toEqual([]);
    limit.remainingBytes=args.zip.length;vi.mocked(qualifyHoldingValuation).mockResolvedValue(qualified());
    await resumePendingShareholdingsPrices({sourceDb,maxRows:100,shouldStop:()=>false,budget:limit,loadSources:nextLoader()});
    expect(limit.remainingBytes).toBe(0);expect(testProperties(saved[`/pages/${args.archivePageId}`])["保有価格状態"]).toEqual({select:{name:"再開待ち"}});
    expect(vi.mocked(notionRequest).mock.calls.filter(([m,p])=>m==="PATCH"&&p===rowPath)).toEqual([]);
  });
  it("外部queueの再資格PRE欠落/他source key/SHA差を価格mutation前に拒否する",async()=>{
    await completedUnavailable();const old=restartInfo(saved[`/pages/${args.archivePageId}`],"保有価格");
    const file={pageId:"1".repeat(32),sha256:"2".repeat(64),bytes:100,filename:"holdings-price-requalification-PRE.json",
      key:`holdings-price-requalification/${source.docId}/${ready.snapshotId}/next-price-snapshot/PRE/${"2".repeat(64)}`};
    const valid={snapshotId:ready.snapshotId,nextHoldingOffset:1,unavailableRows:1,pre:file};
    for(const previousPricePass of [{},{...valid,pre:{...file,pageId:undefined}},{...valid,pre:{...file,key:file.key.replace(source.docId,"S100OTHR")}},{...valid,pre:{...file,sha256:"3".repeat(64)}}]){
      Object.assign(testProperties(saved[`/pages/${args.archivePageId}`]),{"保有価格状態":{select:{name:"再開待ち"}},"保有価格再開情報":{rich_text:[{text:{content:JSON.stringify({...old,snapshotId:"next-price-snapshot",nextHoldingOffset:0,unavailableRows:0,previousPricePass})}}]}});
      await expect(resumePendingShareholdingsPrices({sourceDb,maxRows:100,shouldStop:()=>false,budget:budget(),loadSources:nextLoader()})).rejects.toThrow();
    }
    for(const snapshotId of [undefined,ready.snapshotId]){
      Object.assign(testProperties(saved[`/pages/${args.archivePageId}`]),{"保有価格再開情報":{rich_text:[{text:{content:JSON.stringify({...old,snapshotId,nextHoldingOffset:0,unavailableRows:0,previousPricePass:valid})}}]}});
      await expect(resumePendingShareholdingsPrices({sourceDb,maxRows:100,shouldStop:()=>false,budget:budget(),loadSources:nextLoader()})).rejects.toThrow();
    }
    expect(recordPrimaryData).not.toHaveBeenCalled();expect(vi.mocked(notionRequest).mock.calls.filter(([m])=>m==="PATCH")).toEqual([]);
  });
  it("新世代でも全facts変更はPRE/価格mutation前STOP、PRE unknownはdurable価格unknownで再送不可",async()=>{
    await completedUnavailable();vi.mocked(parseShareholdingsData).mockReturnValue({...extraction,holdings:[{...holding,shares:13}]});
    await expect(resumePendingShareholdingsPrices({sourceDb,maxRows:100,shouldStop:()=>false,budget:budget(),loadSources:nextLoader()})).rejects.toThrow();
    expect(recordPrimaryData).not.toHaveBeenCalled();expect(vi.mocked(notionRequest).mock.calls.filter(([m])=>m==="PATCH")).toEqual([]);
    vi.mocked(parseShareholdingsData).mockReturnValue(structuredClone(extraction));vi.mocked(recordPrimaryData).mockRejectedValueOnce(new Error("PRE_UPLOAD_UNKNOWN"));
    const options={sourceDb,maxRows:100,shouldStop:()=>false,budget:budget(),loadSources:nextLoader()};
    await expect(resumePendingShareholdingsPrices(options)).rejects.toThrow("PRE_UPLOAD_UNKNOWN");
    expect(testProperties(saved[`/pages/${args.archivePageId}`])["保有価格状態"]).toEqual({select:{name:"実行中（結果未確定）"}});
    await expect(resumePendingShareholdingsPrices(options)).rejects.toThrow("保有価格に結果未確定");expect(recordPrimaryData).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notionRequest).mock.calls.filter(([m,path])=>m==="PATCH"&&path===rowPath)).toEqual([]);
  });

  it("再資格は既確定行の全props/旧proofを保持し、未資格行だけ新原本で算定する",async()=>{
    const holdings=[holding,{...holding,kind:"みなし保有株式" as const,rowIndex:4}];
    vi.mocked(parseShareholdingsData).mockReturnValue({...extraction,holdings});await seedPublishedSource();
    const created=vi.mocked(notionRequest).mock.calls.filter(([m,p])=>m==="POST"&&p==="/pages");
    const rows=created.map((call,index)=>({object:"page",id:(index===0?"e":"f").repeat(32),parent:{type:"database_id",database_id:"d".repeat(32)},archived:false,in_trash:false,
      properties:{...legacy,...mirrored((call[2] as {properties:Record<string,unknown>}).properties),...formulaStatuses((call[2] as {properties:Record<string,unknown>}).properties)}}));
    holdingPeriodRows=async()=>structuredClone(rows); const route=vi.mocked(notionRequest).getMockImplementation()!;
    vi.mocked(notionRequest).mockImplementation(async(m,p,b,o)=>{const row=rows.find(v=>p===`/pages/${v.id}`);if(!row)return route(m,p,b,o);
      if(m==="PATCH"){Object.assign(row.properties,mirrored((b as {properties:Record<string,unknown>}).properties));Object.assign(row.properties,formulaStatuses(row.properties));return{object:"page",id:row.id};}return structuredClone(row);});
    vi.mocked(qualifyHoldingValuation).mockResolvedValueOnce(qualified()).mockResolvedValueOnce({status:"unavailable",identity:null,reason:"旧snapshot不足"});
    await resumePendingShareholdingsPrices({sourceDb,maxRows:100,shouldStop:()=>false,budget:budget(),loadSources:async()=>ready});
    const first=structuredClone(rows[0]), oldSource=structuredClone(saved[`/pages/${args.archivePageId}`]);
    vi.mocked(recordPrimaryData).mockResolvedValue({pageId:"1".repeat(32),outcome:"recorded",fileTooLarge:false,manifestMatch:"written"});vi.mocked(verifyArchivedAttachments).mockResolvedValue(undefined);
    vi.mocked(qualifyHoldingValuation).mockClear();vi.mocked(qualifyHoldingValuation).mockImplementation(async({holding:h})=>{if(h.kind==="特定投資株式")throw new Error("OLD_QUALIFIED_MUST_NOT_REPRICE");return qualified();});
    const loader=Object.assign(vi.fn<HoldingPriceSourceLoader>(async()=>({...ready,snapshotId:"next-price-snapshot"})),{currentSnapshotId:async()=>"next-price-snapshot"});
    vi.mocked(notionRequest).mockClear();
    expect(await resumePendingShareholdingsPrices({sourceDb,maxRows:100,shouldStop:()=>false,budget:budget(),loadSources:loader})).toMatchObject({usedRows:2,resumed:1,held:0});
    expect(rows[0]).toEqual(first);expect(loader.mock.calls[0][0]).toEqual([holdings[1]]);expect(qualifyHoldingValuation).toHaveBeenCalledTimes(1);
    expect(restartInfo(saved[`/pages/${args.archivePageId}`],"保有価格")).toMatchObject({nextHoldingOffset:2,unavailableRows:0});
    expect(vi.mocked(notionRequest).mock.calls.filter(([m,p])=>m==="PATCH"&&p===`/pages/${first.id}`)).toEqual([]);
    for(const field of ["保有明細状態","保有明細理由","保有明細再開情報"]) expect(testProperties(saved[`/pages/${args.archivePageId}`])[field]).toEqual(testProperties(oldSource)[field]);
  });

});
