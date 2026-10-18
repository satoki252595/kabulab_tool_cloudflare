import { createReportedSourceTestDb } from "./reported-source-test-db.js";
const sourceDb = createReportedSourceTestDb().db;
/** Real source snapshots; the restartable healthy checkpoint is an explicitly declared test mutation. */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HOLDINGS_DESCRIPTION, resumePendingShareholdings, publishVerifiedShareholdings } from "./shareholdings.js";
import { notionRequest } from "./client.js";
import { queryUniqueRow, recordPrimaryData } from "./archive.js";
import { listPageFiles } from "./page-file.js";

vi.mock("./client.js", async original => ({ ...await original<typeof import("./client.js")>(), notionRequest: vi.fn() }));
vi.mock("./archive.js", () => ({ recordPrimaryData: vi.fn(), queryUniqueRow: vi.fn(), findUniqueBackupChildByTitle: vi.fn(async () => "364d74ff84cd81a1838bd973ac329270") }));
vi.mock("./page-file.js", () => ({ listPageFiles: vi.fn() }));
vi.mock("./env.js", async original => ({ ...await original<typeof import("./env.js")>(), notionEnv: {
  NOTION_STOCK_HOLDINGS_DB_ID: () => "5ad4d311b06f42b4b78ab3801cd509e2", NOTION_ARCHIVE_PAGE_ID: () => "205d74ff84cd809e92b4dd1adc5cf186",
} }));
const base = new URL("../../../services/yuho-quant/src/tests/fixtures/holdings-unknown-source/", import.meta.url);
const bytes = (name: string) => readFileSync(new URL(name, base));
const read = (name: string) => JSON.parse(bytes(name).toString());
const schema = JSON.parse(readFileSync(new URL("../../../services/yuho-quant/src/tests/fixtures/holdings-pending1911/schema.json", import.meta.url), "utf8"));
// Current-server schema projection only; original unknown/source fixture bytes remain unchanged.
schema.properties["価格状態"].formula.expression = 'if(prop("価格照合済"), "期末参考時価（期末株数×採用終値）", "未取得（価格・通貨・株数単位の照合未成立）")';
for (const part of schema.description) { part.plain_text = HOLDINGS_DESCRIPTION; part.text.content = HOLDINGS_DESCRIPTION; }
const info = (p: ReturnType<typeof read>) => JSON.parse(p.properties["保有明細再開情報"].rich_text.map((v: { plain_text: string }) => v.plain_text).join(""));
const rt = (content: string) => [{ type: "text", text: { content }, plain_text: content }];
const sameId = (a: string, b: string) => a.replaceAll("-", "") === b.replaceAll("-", "");
let unknown: ReturnType<typeof read>, healthy: ReturnType<typeof read>, queued: boolean, unknownPages: ReturnType<typeof read>[];
let mutations: Array<{ path: string; body: unknown }>, unknownGets: number, fault: string | undefined;
const options = { sourceDb, maxRows: 100, shouldStop: () => false };
beforeEach(() => {
  vi.clearAllMocks(); unknown = read("1911-source-unknown.json"); healthy = read("1897-source-complete.json"); queued = true;
  // Original1897 is complete. Only these two checkpoint fields are deliberately changed for normal-resume testing.
  healthy.properties["保有明細状態"].select.name = "再開待ち";
  const checkpoint = info(healthy); checkpoint.sourceNextHoldingOffset = 0;
  healthy.properties["保有明細再開情報"].rich_text = rt(JSON.stringify(checkpoint));
  unknownPages = [unknown]; mutations = []; unknownGets = 0; fault = undefined;
  vi.mocked(queryUniqueRow).mockImplementation(async () => structuredClone(healthy));
  vi.mocked(listPageFiles).mockImplementation(async id => {
    expect(sameId(id, healthy.id)).toBe(true);
    return [{ name: "S100XT0W_xbrl.zip", kind: "file", url: healthy.properties.Files.files[0].file.url }];
  });
  vi.mocked(notionRequest).mockImplementation(async (method, path, body) => {
    if (method === "GET" && path.startsWith("/databases/")) return (sameId(path.split("/").at(-1)!, schema.id) ? schema
      : { id: unknown.parent.database_id, properties: unknown.properties }) as never;
    if (method === "POST" && path.endsWith("/query")) {
      if (sameId(path.split("/")[2], schema.id)) return { object: "list", results: read("1897-period-complete.json").rows, has_more: false, next_cursor: null } as never;
      const status = (body as { filter: { select: { equals: string } } }).filter.select.equals;
      return { object: "list", results: status === "実行中（結果未確定）" ? structuredClone(unknownPages) : status === "再開待ち" && queued ? [structuredClone(healthy)] : [],
        has_more: fault === "overflow", next_cursor: fault === "overflow" ? "unconsumed" : null } as never;
    }
    if (method === "GET" && sameId(path.split("/").at(-1)!, unknown.id)) {
      unknownGets++;
      if (fault === "network") throw new TypeError("fetch failed");
      const value = structuredClone(unknown);
      if (fault === "drift" && unknownGets === 2) value.properties["保有明細理由"].rich_text = rt("explicit changed-reason fault");
      return value;
    }
    expect(sameId(path.split("/").at(-1)!, healthy.id)).toBe(true);
    if (method === "PATCH") {
      mutations.push({ path, body });
      for (const [name, raw] of Object.entries((body as { properties: Record<string, Record<string, unknown>> }).properties)) {
        const value = structuredClone(raw);
        if (Array.isArray(value.rich_text)) value.rich_text = (value.rich_text as Array<{ text: { content: string } }>).map(p => ({ ...p, type: "text", plain_text: p.text.content }));
        healthy.properties[name] = { ...healthy.properties[name], ...value };
      }
      return { object: "page", id: healthy.id } as never;
    }
    expect(method).toBe("GET"); return structuredClone(healthy);
  });
});

describe("normal unknown source isolation", () => {
  it("actual1911 keeps its unknown source/price state while actual1897 resumes through the normal publisher", async () => {
    const proof = read("provenance.json");
    for (const file of proof.files) expect(createHash("sha256").update(bytes(file.fixture)).digest("hex")).toBe(file.fixtureSha256);
    const before = structuredClone(unknown), native = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(Uint8Array.from(bytes("1897-S100XT0W.zip"))));
    try {
      const result = await resumePendingShareholdings(options);
      expect(result).toMatchObject({ usedRows: 8, resumed: 1, held: 1, pending: true, unknownSources: [{ archivePageId: unknown.id, source: info(unknown).source, reasonCode: "unknown_source_isolated" }] });
      expect(result.unknownSources![0].sourcePageSha256).toBe("182830d267c881598d02051eb8b532bf740084570aeb0f24811a317e7503c5bf");
      expect(unknownGets).toBe(2); expect(unknown).toEqual(before); expect(native).toHaveBeenCalledTimes(1);
      expect(mutations).toHaveLength(2); expect(mutations.every(v => sameId(v.path.split("/").at(-1)!, healthy.id))).toBe(true);
      expect(healthy.properties["保有明細状態"].select.name).toBe("明細原本照合済");
      expect(recordPrimaryData).not.toHaveBeenCalled();
      //1911 is not in the price queue and source isolation never creates one.
      expect(unknown.properties["保有価格状態"].select).toBeNull(); expect(unknown.properties["保有価格再開情報"].rich_text).toEqual([]);
    } finally { native.mockRestore(); }
  });
  it("an isolated unknown alone is a visible pending HOLD, with no original download or mutation", async () => {
    queued = false;
    expect(await resumePendingShareholdings(options)).toMatchObject({ usedRows: 0, resumed: 0, held: 1, pending: true, unknownSources: [{ reasonCode: "unknown_source_isolated" }] });
    expect(unknownGets).toBe(2); expect(listPageFiles).not.toHaveBeenCalled(); expect(mutations).toEqual([]);
  });
  it.each(["missing-info", "invalid-doc", "invalid-code", "unbound-issuer", "wrong-manifest", "missing-facts", "wrong-key", "overflow", "too-many", "duplicate", "collision", "network"])("%s stops before any other writer", async change => {
    fault = change;
    if (change === "missing-info") delete unknown.properties["保有明細再開情報"];
    if (change === "invalid-doc" || change === "invalid-code") {
      const value = info(unknown);
      if (change === "invalid-doc") value.source.docId += "A";
      else value.source.stockCode = "A911";
      unknown.properties["保有明細再開情報"].rich_text = rt(JSON.stringify(value));
    }
    if (["unbound-issuer", "wrong-manifest"].includes(change)) {
      const metadata = JSON.parse(unknown.properties.Metadata.rich_text.map((p: { plain_text: string }) => p.plain_text).join(""));
      if (change === "unbound-issuer") metadata.edinetCode = "E00133";
      else metadata._fileManifest.files[0].sha256 = "0".repeat(64);
      unknown.properties.Metadata.rich_text = rt(JSON.stringify(metadata));
    }
    if (change === "missing-facts") { const value = info(unknown); delete value.factsSha256; unknown.properties["保有明細再開情報"].rich_text = rt(JSON.stringify(value)); }
    if (change === "wrong-key") unknown.properties.Key.title = rt("S100XT0W:type1");
    if (change === "duplicate") unknownPages.push(structuredClone(unknown));
    if (change === "too-many") unknownPages = Array.from({ length: 6 }, () => structuredClone(unknown));
    if (change === "collision") { const value = info(healthy); value.source = info(unknown).source; healthy.properties["保有明細再開情報"].rich_text = rt(JSON.stringify(value)); }
    if (change === "invalid-doc" || change === "invalid-code") await expect(resumePendingShareholdings(options)).rejects.toThrow("regular expression");
    else await expect(resumePendingShareholdings(options)).rejects.toThrow();
    expect(mutations).toEqual([]); expect(listPageFiles).not.toHaveBeenCalled(); expect(recordPrimaryData).not.toHaveBeenCalled();
    if (change === "network") expect(unknownGets).toBe(1);
  });
  it("full unknown-source POST drift stops even if healthy work already completed", async () => {
    queued = false; fault = "drift";
    await expect(resumePendingShareholdings(options)).rejects.toThrow("全props");
    expect(unknownGets).toBe(2); expect(mutations).toEqual([]);
  });
  it("the same-source publisher still refuses unknown before any holding mutation", async () => {
    await expect(publishVerifiedShareholdings({ sourceDb, source: info(unknown).source, ownerName: info(unknown).ownerName,
      zip: readFileSync(new URL("../../../services/yuho-quant/src/tests/fixtures/holdings-pending1911/1911-S100Y1XP.zip", import.meta.url)), archivePageId: unknown.id, maxRows: 1 })).rejects.toThrow("前回結果が未確定");
    expect(mutations).toEqual([]);
  });
  it("a revised document and different archive cannot bypass the same-issuer/FY guard", async () => {
    const original = info(unknown);
    await expect(publishVerifiedShareholdings({ sourceDb, source: { ...original.source, docId: `${original.source.docId.slice(0, -1)}Q` }, ownerName: original.ownerName,
      zip: readFileSync(new URL("../../../services/yuho-quant/src/tests/fixtures/holdings-pending1911/1911-S100Y1XP.zip", import.meta.url)), archivePageId: healthy.id, maxRows: 1 })).rejects.toThrow("同じ提出会社・期末");
    expect(mutations).toEqual([]); expect(unknownGets).toBe(0); expect(listPageFiles).not.toHaveBeenCalled();
  });
  it("a different FY reaches its own source-identity gate, rather than colliding with1911's period", async () => {
    const original = info(unknown);
    // Declared input mutation, not a fabricated historical filing. Its mismatched actual archive must still STOP.
    await expect(publishVerifiedShareholdings({ sourceDb, source: { ...original.source, docId: `${original.source.docId.slice(0, -1)}Q`, fiscalYearEnd: "2024-12-31" }, ownerName: original.ownerName,
      zip: readFileSync(new URL("../../../services/yuho-quant/src/tests/fixtures/holdings-pending1911/1911-S100Y1XP.zip", import.meta.url)), archivePageId: healthy.id, maxRows: 1 })).rejects.toThrow("S100XT0W");
    expect(vi.mocked(notionRequest).mock.calls.some(([method, path]) => method === "GET" && path === `/pages/${healthy.id}`)).toBe(true);
    expect(mutations).toEqual([]);
  });
});
