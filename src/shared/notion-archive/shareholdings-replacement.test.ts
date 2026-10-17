import { createReportedSourceTestDb } from "./reported-source-test-db.js";
const sourceDb = createReportedSourceTestDb().db;
/** Actual1911 business values; new IDs/response clocks below are declared transport protocol mutations. */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceUnknownHoldingPatch, publishVerifiedShareholdings, qualifyHoldingPatchJournal } from "./shareholdings.js";
import { notionRequest } from "./client.js";
import { recordPrimaryData } from "./archive.js";
import { verifyArchivedAttachments } from "./readback.js";
import { listPageFiles } from "./page-file.js";
import { downloadArchivedFile } from "./archived-download.js";

vi.mock("./client.js", async original => ({ ...await original<typeof import("./client.js")>(), notionRequest: vi.fn() }));
vi.mock("./archive.js", () => ({ recordPrimaryData: vi.fn(), queryUniqueRow: vi.fn(), findUniqueBackupChildByTitle: vi.fn(async () => "364d74ff84cd81a1838bd973ac329270") }));
vi.mock("./readback.js", () => ({ verifyArchivedAttachments: vi.fn() }));
vi.mock("./page-file.js", () => ({ listPageFiles: vi.fn() }));
vi.mock("./archived-download.js", () => ({ downloadArchivedFile: vi.fn() }));
vi.mock("./env.js", async original => ({ ...await original<typeof import("./env.js")>(), notionEnv: {
  NOTION_STOCK_HOLDINGS_DB_ID: () => "5ad4d311b06f42b4b78ab3801cd509e2", NOTION_ARCHIVE_PAGE_ID: () => "205d74ff84cd809e92b4dd1adc5cf186",
} }));
const base = new URL("../../../services/yuho-quant/src/tests/fixtures/holdings-pending1911/", import.meta.url);
const bytes = (name: string) => readFileSync(new URL(name, base));
const read = (name: string) => JSON.parse(bytes(name).toString());
const schema = read("schema.json"), source = read("provenance.json").source, ownerName = read("provenance.json").ownerName;
const oldId = read("unknown-before.json").id, legacyId = "3fbd74ff-84cd-81fd-b919-c47b222b5f21";
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const nid = (value: string) => value.replaceAll("-", "");
const checkpoint = () => JSON.parse(page.properties["保有明細再開情報"].rich_text.map((v: { plain_text: string }) => v.plain_text).join(""));
let page: ReturnType<typeof read>, rows: ReturnType<typeof read>, old: ReturnType<typeof read>;
let archives: Map<string, { filename: string; bytes: Uint8Array }>, fault: string | undefined, nextId: number;
let additionalUnknown: ReturnType<typeof read>[];
let writes: Array<{ method: string; path: string; body: unknown }>;
const journal = () => ({ pending: JSON.stringify({ version: 2, noAutomaticReplay: true, mode: "latest-saved-holdings" }),
  journal: bytes("journal.jsonl").toString(), intent: bytes("unknown-intent.json").toString(), request: bytes("unknown-request.json").toString(), before: read("unknown-before.json"), schema,
  beforeRaw: bytes("unknown-before.json").toString(), schemaRaw: bytes("schema.json").toString() });
const args = () => ({ source, ownerName, archivePageId: page.id, zip: bytes("1911-S100Y1XP.zip"), journal: journal(),
  legacyPre: { archivePageId: legacyId, filename: "holdings-legacy-PRE.json", sha256: sha(bytes("legacy-pre.json")), bytes: bytes("legacy-pre.json") }, assertLatestSource: vi.fn(async () => {}) });

function applyProperties(target: ReturnType<typeof read>, input: Record<string, Record<string, unknown>>) {
  for (const [name, write] of Object.entries(input)) {
    const property = target.properties[name]; expect(property).toBeDefined(); const type = property.type;
    let value = structuredClone(write[type]);
    if (type === "title" || type === "rich_text") value = (value as Array<{ text: { content: string }; annotations?: unknown }>).map(part => ({
      ...part, annotations: part.annotations === undefined ? read("unknown-before.json").properties.Name.title[0].annotations : part.annotations,
      type: "text", plain_text: part.text.content, href: null,
    }));
    if (type === "select" && value !== null) {
      const nameValue = (value as { name: string }).name;
      if (["保有明細状態", "保有価格状態"].includes(name)) value = { name: nameValue }; // Source-marker protocol envelope, not a holding DB select.
      else { const option = schema.properties[name].select.options.find((v: { name: string }) => v.name === nameValue); expect(option).toBeDefined(); value = { id: option.id, name: option.name, color: option.color }; }
    }
    if (type === "date" && value !== null) value = { ...(value as object), end: null, time_zone: null };
    target.properties[name] = { ...property, [type]: value };
  }
  if (target.properties["検証状態"]) target.properties["検証状態"].formula.string = target.properties["原本照合済"].checkbox ? "明細原本照合済" : "未検証（旧取込）";
  if (target.properties["価格状態"]) target.properties["価格状態"].formula.string = target.properties["価格照合済"].checkbox ? "期末参考時価（同日期末株数×終値）" : "未取得（価格・通貨・株数単位の照合未成立）";
}
beforeEach(() => {
  vi.clearAllMocks(); additionalUnknown = []; fault = undefined; nextId = 1; writes = [];
  page = JSON.parse(readFileSync(new URL("../../../services/yuho-quant/src/tests/fixtures/holdings-unknown-source/1911-source-unknown.json", import.meta.url), "utf8"));
  rows = read("period-after31.json"); old = rows.find((v: { id: string }) => v.id === oldId);
  archives = new Map([[legacyId, { filename: "holdings-legacy-PRE.json", bytes: bytes("legacy-pre.json") }], [page.id, { filename: "S100Y1XP_xbrl.zip", bytes: bytes("1911-S100Y1XP.zip") }]]);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("protocol test forbids every live HTTP"); }));
  vi.mocked(recordPrimaryData).mockImplementation(async input => {
    if (fault === "physical-post" && input.files![0].filename === "holdings-patch-POST.json") throw new Error("physical POST unknown");
    if (fault === "legacy-post" && input.files![0].filename === "holdings-patch-LEGACY-POST.json") throw new Error("legacy POST unknown");
    const id = String(1000 + archives.size).padStart(32, "0"); archives.set(id, { filename: input.files![0].filename, bytes: input.files![0].bytes });
    return { pageId: id, fileTooLarge: false, manifestMatch: "written" } as never;
  });
  vi.mocked(verifyArchivedAttachments).mockImplementation(async (id, files) => {
    const file = archives.get(id); expect(file).toBeDefined(); expect(files).toHaveLength(1); expect(files[0].filename).toBe(file!.filename); expect(sha(files[0].bytes)).toBe(sha(file!.bytes));
  });
  vi.mocked(listPageFiles).mockImplementation(async id => [{ name: archives.get(id)!.filename, kind: "file", url: `https://offline.invalid/${id}` }]);
  vi.mocked(downloadArchivedFile).mockImplementation(async file => Buffer.from(archives.get(file.url.split("/").at(-1)!)!.bytes));
  vi.mocked(notionRequest).mockImplementation(async (method, path, body, options) => {
    const request = body as { archived?: boolean; properties?: Record<string, Record<string, unknown>>; filter?: { property?: string }; parent?: { database_id: string } };
    if (method === "GET" && path.startsWith("/databases/")) return (nid(path.split("/").at(-1)!) === nid(schema.id) ? schema : { id: page.parent.database_id, properties: page.properties }) as never;
    if (method === "POST" && path.endsWith("/query")) return { results: request.filter?.property === "保有明細状態" ? (page.properties["保有明細状態"].select.name === "実行中（結果未確定）" ? [structuredClone(page), ...structuredClone(additionalUnknown)] : structuredClone(additionalUnknown)) : structuredClone(rows), has_more: false, next_cursor: null } as never;
    if (method === "GET") {
      if (path === `/pages/${page.id}`) return structuredClone(page);
      if (path === `/pages/${oldId}`) return structuredClone(old);
      const found = rows.find((v: { id: string }) => path === `/pages/${v.id}`); expect(found).toBeDefined(); return structuredClone(found);
    }
    writes.push({ method, path, body }); expect(options).toEqual({ singleAttempt: true });
    if (request.archived === true) {
      expect(path).toBe(`/pages/${oldId}`); old.archived = true; old.in_trash = true; rows = rows.filter((v: { id: string }) => v.id !== oldId);
      if (fault === "retire-unknown") throw new TypeError("fetch failed"); return structuredClone(old);
    }
    if (method === "POST") {
      expect(path).toBe("/pages");
      const created = read("unknown-before.json"); created.id = String(nextId++).padStart(32, "0");
      // Declared transport/default envelope only; business values come exclusively from the actual source producer.
      created.created_time = created.last_edited_time = page.last_edited_time;
      for (const value of Object.values(created.properties) as Array<Record<string, unknown>>) {
        const type = String(value.type); if (type === "formula") continue;
        value[type] = type === "title" || type === "rich_text" ? [] : type === "checkbox" ? false : null;
      }
      applyProperties(created, request.properties!); rows.push(created);
      if (fault === "create-unknown") throw new TypeError("fetch failed"); return structuredClone(created);
    }
    expect(method).toBe("PATCH"); const target = path === `/pages/${page.id}` ? page : rows.find((v: { id: string }) => path === `/pages/${v.id}`);
    expect(target).toBeDefined(); applyProperties(target, request.properties!); return structuredClone(target);
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("actual1911 normal constructive unknown replacement", () => {
  it("preserves the143 journal and40-row PRE; retires only old32, proves44 current pages, then normal45 writes only13", async () => {
    const input = args(), originalJournal = input.journal.journal, extras = structuredClone(rows.filter((r: ReturnType<typeof read>) => !JSON.parse(bytes("legacy-pre.json").toString()).rows.some((p: { id: string }) => p.id === r.id) && r.properties["原本照合済"].checkbox === false));
    expect(extras).toHaveLength(2); const proof = read("replacement-provenance.json"); expect(sha(bytes("legacy-pre.json"))).toBe(proof.legacyPre.fixtureSha256); expect(sha(bytes("period-after31.json"))).toBe(proof.currentPeriod.fixtureSha256);
    expect(qualifyHoldingPatchJournal(input.journal).attempt).toBe(143);
    const result = await replaceUnknownHoldingPatch(input);
    expect(result).toMatchObject({ oldId, sourceNextHoldingOffset: 0, sourceComplete: false }); expect(result.newId).not.toBe(oldId);
    expect(input.journal.journal).toBe(originalJournal); expect(old.archived).toBe(true); expect(rows).toHaveLength(44);
    expect(writes.map(v => [v.method, v.path])).toEqual([["PATCH", `/pages/${oldId}`], ["POST", "/pages"], ["PATCH", `/pages/${page.id}`]]);
    expect(page.properties["保有明細状態"].select.name).toBe("再開待ち"); expect(checkpoint().sourceNextHoldingOffset).toBe(0); expect(checkpoint().sourceQueueVersion).toBe(2);
    expect(page.properties["保有価格状態"].select).toBeNull();
    const originalWrites = writes.length;
    const published = await publishVerifiedShareholdings({ sourceDb, source, ownerName, archivePageId: page.id, zip: input.zip, maxRows: 45 });
    expect(published).toMatchObject({ status: "published", parsed: 45, unchanged: 32, updated: 10, created: 3 });
    expect(rows).toHaveLength(47); expect(checkpoint().sourceNextHoldingOffset).toBe(45); expect(checkpoint().patchResolution.legacyPost).toBeDefined();
    expect(page.properties["保有明細状態"].select.name).toBe("明細原本照合済");
    expect(writes.slice(originalWrites).filter(v => v.path !== `/pages/${page.id}`)).toHaveLength(13);
    for (const extra of extras) expect(rows.find((v: { id: string }) => v.id === extra.id)).toEqual(extra);
    const final = [...archives.values()].find(v => v.filename === "holdings-patch-LEGACY-POST.json")!;
    const mapping = JSON.parse(Buffer.from(final.bytes).toString()).mapping; expect(mapping).toHaveLength(40); expect(mapping.find((v: { oldId: string }) => v.oldId === oldId).newId).toBe(result.newId);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const beforeReplay = writes.length, archiveCount = archives.size;
    expect(await publishVerifiedShareholdings({ sourceDb, source, ownerName, archivePageId: page.id, zip: input.zip, maxRows: 45 })).toMatchObject({ status: "published", parsed: 0 });
    expect(writes).toHaveLength(beforeReplay); expect(archives.size).toBe(archiveCount);
  });
  it("ordinary scheduled row budgets keep v2 and original40 proof until the final10/10/10/10/5 window", async () => {
    const input = args(); await replaceUnknownHoldingPatch(input); const replacedWrites = writes.length;
    for (const end of [10, 20, 30, 40, 45]) {
      const result = await publishVerifiedShareholdings({ sourceDb, source, ownerName, archivePageId: page.id, zip: input.zip, maxRows: 10 });
      expect(checkpoint().sourceQueueVersion).toBe(2); expect(checkpoint().sourceNextHoldingOffset).toBe(end);
      expect(result.status).toBe(end === 45 ? "published" : "held");
      expect(page.properties["保有価格状態"].select).toEqual(end === 45 ? { name: "再開待ち" } : null);
      if (end < 45) expect(checkpoint().patchResolution.legacyPost).toBeUndefined();
    }
    expect(writes.slice(replacedWrites).filter(v => v.path !== `/pages/${page.id}`)).toHaveLength(13);
    expect(checkpoint().patchResolution.legacyPost).toBeDefined(); expect(rows).toHaveLength(47);
    const final = [...archives.values()].find(v => v.filename === "holdings-patch-LEGACY-POST.json")!;
    expect(JSON.parse(Buffer.from(final.bytes).toString()).mapping).toHaveLength(40); expect(input.journal.journal).toBe(journal().journal);
  });
  it("a delayed original properties-only PATCH can change only the retired ID, never the replacement/price values", async () => {
    const input = args(), result = await replaceUnknownHoldingPatch(input), replacement = structuredClone(rows.find((v: { id: string }) => v.id === result.newId));
    // Declared delayed-commit protocol, not an assertion that the actual unknown ACK has been recovered.
    applyProperties(old, JSON.parse(JSON.stringify(qualifyHoldingPatchJournal(input.journal).changed)));
    expect(old.archived).toBe(true); expect(rows.find((v: { id: string }) => v.id === result.newId)).toEqual(replacement);
    await expect(publishVerifiedShareholdings({ sourceDb, source, ownerName, archivePageId: page.id, zip: input.zip, maxRows: 45 })).resolves.toMatchObject({ updated: 10, created: 3, unchanged: 32 });
  });
  it("a second real issuer unknown does not block the isolated target replacement", async () => {
    const other = JSON.parse(readFileSync(new URL("../../../services/yuho-quant/src/tests/fixtures/holdings-unknown-source/1897-source-complete.json", import.meta.url), "utf8"));
    other.properties["保有明細状態"].select.name = "実行中（結果未確定）";
    const info = JSON.parse(other.properties["保有明細再開情報"].rich_text.map((v: { plain_text: string }) => v.plain_text).join("")); info.sourceNextHoldingOffset = 0;
    applyProperties(other, { "保有明細再開情報": { rich_text: [{ type: "text", text: { content: JSON.stringify(info) } }] } }); additionalUnknown = [other];
    await expect(replaceUnknownHoldingPatch(args())).resolves.toMatchObject({ sourceComplete: false });
  });
  it("same issuer/FY unknown under a different source ID stops before every mutation", async () => {
    const duplicate = structuredClone(page); duplicate.id = read("known-before.json").id;
    additionalUnknown = [duplicate]; await expect(replaceUnknownHoldingPatch(args())).rejects.toThrow(); expect(writes).toEqual([]); expect(recordPrimaryData).not.toHaveBeenCalled();
  });
  it.each(["v1-with-resolution", "v2-without-resolution", "unsupported-version"])("%s is fail-closed before the ordinary publisher writes", async value => {
    await replaceUnknownHoldingPatch(args()); const info = checkpoint();
    if (value === "v1-with-resolution") info.sourceQueueVersion = 1;
    if (value === "v2-without-resolution") delete info.patchResolution;
    if (value === "unsupported-version") info.sourceQueueVersion = 3;
    applyProperties(page, { "保有明細再開情報": { rich_text: [{ type: "text", text: { content: JSON.stringify(info) } }] } });
    const count = writes.length; await expect(publishVerifiedShareholdings({ sourceDb, source, ownerName, archivePageId: page.id, zip: args().zip, maxRows: 45 })).rejects.toThrow(); expect(writes).toHaveLength(count);
  });
  it.each(["retire-unknown", "create-unknown", "physical-post"])("%s stops at its first ambiguous operation without source requeue or later writes", async value => {
    fault = value; const original = structuredClone(page);
    await expect(replaceUnknownHoldingPatch(args())).rejects.toThrow(); expect(page).toEqual(original);
    expect(writes.filter(v => v.method === "POST")).toHaveLength(value === "retire-unknown" ? 0 : 1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("final original40 physical POST failure preserves unknown source and never enables the price queue", async () => {
    await replaceUnknownHoldingPatch(args()); fault = "legacy-post";
    await expect(publishVerifiedShareholdings({ sourceDb, source, ownerName, archivePageId: page.id, zip: args().zip, maxRows: 45 })).rejects.toThrow("legacy POST unknown");
    expect(page.properties["保有明細状態"].select.name).toBe("実行中（結果未確定）"); expect(page.properties["保有価格状態"].select).toBeNull();
  });
  it("old unmatched extra drift stops the ordinary publisher before any holding/source DML", async () => {
    await replaceUnknownHoldingPatch(args());
    const knownIds = new Set(JSON.parse(bytes("legacy-pre.json").toString()).rows.map((v: { id: string }) => v.id));
    const extra = rows.find((v: ReturnType<typeof read>) => !knownIds.has(v.id) && v.properties["原本照合済"].checkbox === false);
    extra.properties["旧抽出株数（単位未確認）"].number++; const priorWrites = writes.length;
    await expect(publishVerifiedShareholdings({ sourceDb, source, ownerName, archivePageId: page.id, zip: args().zip, maxRows: 45 })).rejects.toThrow(); expect(writes).toHaveLength(priorWrites);
  });
  it.each(["request-sha", "body-unarchive", "legacy-sha", "source-facts", "old-value-drift", "before-custom-type"])("%s cannot authorize the replacement", async value => {
    const input = args();
    if (value === "request-sha") input.journal.request += " ";
    if (value === "body-unarchive") {
      input.journal.request = JSON.stringify({ ...JSON.parse(input.journal.request), archived: false });
      const intent = JSON.parse(input.journal.intent); intent.bodySha256 = sha(input.journal.request); intent.bodyBytes = Buffer.byteLength(input.journal.request); input.journal.intent = JSON.stringify(intent);
      const events = input.journal.journal.trim().split("\n").map(line => JSON.parse(line)); events.filter(v => v.phase === "send-intent").at(-1).bodySha256 = intent.bodySha256; input.journal.journal = events.map(v => JSON.stringify(v)).join("\n") + "\n";
    }
    if (value === "legacy-sha") input.legacyPre.sha256 = "0".repeat(64);
    if (value === "source-facts") { const info = checkpoint(); info.factsSha256 = "0".repeat(64); applyProperties(page, { "保有明細再開情報": { rich_text: [{ type: "text", text: { content: JSON.stringify(info) } }] } }); }
    if (value === "old-value-drift") { const unknown = rows.find((p: { id: string }) => p.id === oldId); unknown.properties["旧試算時価（未検証）"].number++; }
    if (value === "before-custom-type") { input.journal.before.properties["unhandled"] = { type: "relation", relation: [] }; input.journal.beforeRaw = JSON.stringify(input.journal.before); }
    await expect(replaceUnknownHoldingPatch(input)).rejects.toThrow(); expect(writes).toEqual([]);
  });
});
