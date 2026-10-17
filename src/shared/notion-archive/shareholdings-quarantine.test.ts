/** Actual208A values; signed URLs and mutation response envelopes are declared protocol projections. */
import { readFileSync, writeFileSync, mkdtempSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quarantineSavedHoldingSource, publishVerifiedShareholdings } from "./shareholdings.js";
import { quarantineSavedHoldings } from "../../../scripts/notion/shareholdings.js";
import { notionRequest } from "./client.js";
import { recordPrimaryData, queryUniqueRow } from "./archive.js";
import { verifyArchivedAttachments } from "./readback.js";
import { listPageFiles } from "./page-file.js";
import { downloadArchivedFile } from "./archived-download.js";

vi.mock("./client.js", async original => ({ ...await original<typeof import("./client.js")>(), notionRequest: vi.fn() }));
vi.mock("./archive.js", () => ({ recordPrimaryData: vi.fn(), queryUniqueRow: vi.fn(), findUniqueBackupChildByTitle: vi.fn(async () => "364d74ff84cd81a1838bd973ac329270") }));
vi.mock("./readback.js", () => ({ verifyArchivedAttachments: vi.fn() }));
vi.mock("./page-file.js", () => ({ listPageFiles: vi.fn() }));
vi.mock("./archived-download.js", () => ({ downloadArchivedFile: vi.fn() }));
vi.mock("../../shared/db/d1-http-client.js", () => ({ createD1HttpDb: () => ({}) }));
vi.mock("../../../services/yuho-quant/data-scripts/lib/shareholdings-backfill.js", () => ({ selectLatestHoldingsDocuments: vi.fn(async () => ({ rows: [{ ...fixture.source, ownerName: fixture.ownerName }], more: false })) }));
vi.mock("./env.js", async original => ({ ...await original<typeof import("./env.js")>(), notionEnv: {
  NOTION_STOCK_HOLDINGS_DB_ID: () => "5ad4d311b06f42b4b78ab3801cd509e2", NOTION_ARCHIVE_PAGE_ID: () => "205d74ff84cd809e92b4dd1adc5cf186",
} }));
const base = new URL("../../../services/yuho-quant/src/tests/fixtures/holdings-owner-quarantine/", import.meta.url);
const bytes = (name: string) => readFileSync(new URL(name === "208A-S100Z0JO.zip" ? "../holdings-largest-holder/208A-S100Z0JO.zip" : name, base));
const fixture = JSON.parse(bytes("snapshot.json").toString());
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
type Page = typeof fixture.expectedSource;
let page: Page, rows: Page[], fault: string | undefined, archives: Array<{ pageId: string; filename: string; bytes: Uint8Array }>;
let writes: Array<{ method: string; path: string; body: unknown }>, extra: Page[], temp: string | undefined;
const cwd = process.cwd(), nid = (value: string) => value.replaceAll("-", "");
const args = () => ({ source: fixture.source, ownerName: fixture.ownerName, archivePageId: fixture.expectedSource.id,
  zip: bytes("208A-S100Z0JO.zip"), expectedSource: structuredClone(fixture.expectedSource), expectedPeriod: structuredClone(fixture.expectedPeriod),
  expectedRows: structuredClone(fixture.expectedRows), schema: structuredClone(fixture.schema), acceptedHoldings: structuredClone(fixture.acceptedHoldings),
  originalIntent: JSON.parse(bytes("original-intent.json").toString()), assertLatestSource: vi.fn(async () => {}) });
function apply(target: Page, properties: Record<string, Record<string, unknown>>) {
  for (const [name, value] of Object.entries(properties)) {
    const type = target.properties[name].type, original = target.properties[name];
    if (type === "rich_text") target.properties[name] = { ...original, rich_text: (value.rich_text as Array<{ text: { content: string } }>).map(part => ({ ...part, type: "text", plain_text: part.text.content })) };
    else target.properties[name] = { ...original, [type]: structuredClone(value[type]) };
  }
  if (target.properties["検証状態"]) target.properties["検証状態"].formula.string = target.properties["原本照合済"].checkbox ? "明細原本照合済" : "未検証（旧取込）";
  target.last_edited_time = new Date(Date.parse(target.last_edited_time) + 60_000).toISOString(); // Declared response-clock projection only.
}
beforeEach(() => {
  vi.clearAllMocks(); fault = undefined; archives = []; writes = []; extra = [];
  page = structuredClone(fixture.expectedSource); rows = structuredClone(fixture.expectedRows);
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("Every live HTTP is forbidden"); }));
  vi.mocked(queryUniqueRow).mockImplementation(async () => structuredClone(page));
  vi.mocked(listPageFiles).mockImplementation(async () => [{ kind: "file", name: "S100Z0JO_xbrl.zip", url: "https://offline.invalid/S100Z0JO_xbrl.zip" }]);
  vi.mocked(downloadArchivedFile).mockImplementation(async () => bytes("208A-S100Z0JO.zip"));
  vi.mocked(recordPrimaryData).mockImplementation(async input => {
    const file = input.files![0];
    if (fault === "physical-PRE" || fault === "physical-POST" && file.filename.endsWith("POST.json")) throw Error("physical ACK unknown");
    const pageId = String(archives.length + 1).padStart(32, "0"); archives.push({ pageId, filename: file.filename, bytes: file.bytes });
    if (fault === "drift-after-PRE") rows[0].properties["保有株数"].number++;
    return { pageId, fileTooLarge: false, manifestMatch: "written" } as never;
  });
  vi.mocked(verifyArchivedAttachments).mockImplementation(async (id, files) => {
    const file = archives.find(item => item.pageId === id); expect(file).toBeDefined();
    expect(files).toHaveLength(1); expect(files[0].filename).toBe(file!.filename); expect(sha(files[0].bytes)).toBe(sha(file!.bytes));
  });
  vi.mocked(notionRequest).mockImplementation(async (method, path, body, options) => {
    const input = body as { filter?: { property?: string }; properties?: Record<string, Record<string, unknown>> };
    if (method === "GET" && path.startsWith("/databases/")) {
      const schema = nid(path.split("/").at(-1)!) === nid(fixture.schema.id) ? structuredClone(fixture.schema) : structuredClone(fixture.sourceSchema);
      if (fault === "source-option" && schema.id === page.parent.database_id) schema.properties["保有価格状態"].select.options = schema.properties["保有価格状態"].select.options.filter((option: { name: string }) => option.name !== "要確認");
      return schema;
    }
    if (method === "POST" && path.endsWith("/query")) return { results: input.filter?.property === "保有明細状態" ? [] : [...structuredClone(rows), ...structuredClone(extra)], has_more: false, next_cursor: null } as never;
    if (method === "GET") {
      if (path === `/pages/${page.id}`) return structuredClone(page);
      const found = [...rows, ...extra].find(row => path === `/pages/${row.id}`); expect(found).toBeDefined(); return structuredClone(found);
    }
    expect(method).toBe("PATCH"); expect(options).toEqual({ singleAttempt: true });
    writes.push({ method, path, body: structuredClone(body) });
    const target = path === `/pages/${page.id}` ? page : rows.find(row => path === `/pages/${row.id}`)!;
    if (fault === "first-PATCH-before-commit") throw new TypeError("fetch failed before application; ACK remains unknown");
    apply(target, input.properties!);
    if (fault === "first-PATCH" || fault === "source-PATCH" && target.id === page.id) throw new TypeError("fetch failed after possible application");
    if (fault === "other-prop") target.properties["保有株数"].number++;
    return structuredClone(target);
  });
});
afterEach(() => { process.chdir(cwd); if (temp) rmSync(temp, { recursive: true }); temp = undefined; vi.unstubAllGlobals(); });

describe("実208Aの明示主体保留", () => {
  it("全4行のcheckbox/旧理由追記だけ、source両queueを要確認、全値/時計/info/2物理を保全", async () => {
    const input = args(), original = structuredClone(page), before = structuredClone(rows);
    await expect(quarantineSavedHoldingSource(input)).resolves.toMatchObject({ status: "quarantined", rows: 4, pricesAccepted: 0 });
    expect(writes).toHaveLength(5); expect(archives.map(file => file.filename)).toEqual(["holdings-owner-PRE.json", "holdings-owner-POST.json"]);
    const pre = JSON.parse(Buffer.from(archives[0].bytes).toString()), post = JSON.parse(Buffer.from(archives[1].bytes).toString());
    expect(pre.sourcePage.last_edited_time).toBe(original.last_edited_time); expect(post.sourceAfter.last_edited_time).toBe(page.last_edited_time);
    expect(page.last_edited_time).not.toBe(original.last_edited_time); expect(page.created_time).toBe(original.created_time);
    expect(input.assertLatestSource).toHaveBeenCalledTimes(7);
    expect(page.properties["保有明細状態"].select.name).toBe("要確認"); expect(page.properties["保有価格状態"].select.name).toBe("要確認");
    for (const name of ["保有明細再開情報", "保有価格再開情報", "Fetched At", "Metadata", "Files"]) expect(page.properties[name]).toEqual(original.properties[name]);
    for (const [i, row] of rows.entries()) {
      expect(row.properties["原本照合済"].checkbox).toBe(false); expect(row.properties["検証状態"].formula.string).toBe("未検証（旧取込）");
      for (const [name, value] of Object.entries(before[i].properties)) if (!["原本照合済", "検証状態", "欠測理由"].includes(name)) expect(row.properties[name]).toEqual(value);
      expect(row.created_time).toBe(before[i].created_time);
      const reason = row.properties["欠測理由"].rich_text.map((v: { plain_text: string }) => v.plain_text).join("");
      expect(reason.startsWith(before[i].properties["欠測理由"].rich_text.map((v: { plain_text: string }) => v.plain_text).join(""))).toBe(true);
      expect(reason).toContain("最大保有会社「株式会社構造計画研究所」");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["canonical-price", "canonical-zero-price", "price-checked", "source-unknown", "source-price-unknown", "source-option", "row-ids", "facts", "ZIP", "period-extra"])("%sを元値のままSTOPし業務/物理0", async kind => {
    const input = args();
    if (kind === "canonical-price") rows[0].properties["株価"].number = fixture.acceptedHoldings[0].bookValueRaw;
    if (kind === "canonical-zero-price") rows[0].properties["株価"].number = 0;
    if (kind === "price-checked") rows[0].properties["価格照合済"].checkbox = true;
    if (kind === "source-unknown") page.properties["保有明細状態"].select.name = "実行中（結果未確定）";
    if (kind === "source-price-unknown") page.properties["保有価格状態"].select.name = "実行中（結果未確定）";
    if (kind === "row-ids") input.expectedRows.reverse();
    if (kind === "facts") input.acceptedHoldings.reverse();
    if (kind === "ZIP") input.zip = bytes("snapshot.json");
    if (kind === "period-extra") extra.push(structuredClone(rows[0]));
    if (kind === "source-option") fault = kind;
    await expect(quarantineSavedHoldingSource(input)).rejects.toThrow(); expect(writes).toHaveLength(0); expect(archives).toHaveLength(0);
  });
  it.each(["physical-PRE", "drift-after-PRE", "first-PATCH", "source-PATCH", "other-prop", "physical-POST"])("%sを成功化せずその時点でSTOP", async kind => {
    fault = kind; await expect(quarantineSavedHoldingSource(args())).rejects.toThrow();
    expect(writes.length).toBe(kind === "physical-PRE" || kind === "drift-after-PRE" ? 0 : kind === "source-PATCH" || kind === "physical-POST" ? 5 : 1);
  });
  it("自動publisherは完了sourceを保留へ降格しない", async () => {
    await expect(publishVerifiedShareholdings({ source: fixture.source, ownerName: fixture.ownerName, archivePageId: page.id, zip: bytes("208A-S100Z0JO.zip"), maxRows: 4 }))
      .rejects.toThrow("確定sourceを解析保留で戻しません");
    expect(writes).toHaveLength(0); expect(archives).toHaveLength(0);
  });
  it.each(["first-PATCH", "first-PATCH-before-commit"])("通常CLIは%sのcanonical onceを残し、別out/PREコピーでも再送を拒否", async failure => {
    temp = mkdtempSync(join(tmpdir(), "holdings-quarantine-")); process.chdir(temp);
    writeFileSync(".env", "", { mode: 0o600 }); writeFileSync("source.zip", bytes("208A-S100Z0JO.zip"));
    for (const name of ["snapshot.json", "original-intent.json", "original-acceptance.json"]) writeFileSync(name, bytes(name));
    const order = { kind: "holding-owner-quarantine-writer-order", source: fixture.source, archivePageId: page.id,
      allConflictingActorsTerminal: true, exclusiveSourceWriterReserved: true, notAfter: new Date(Date.now() + 60_000).toISOString() };
    writeFileSync("order.json", JSON.stringify(order));
    const input = { source: fixture.source, ownerName: fixture.ownerName, archivePageId: page.id, zipPath: "source.zip", snapshotPath: "snapshot.json",
      originalIntentPath: "original-intent.json", originalAcceptancePath: "original-acceptance.json", writerOrderGatePath: "order.json" };
    writeFileSync("input.json", JSON.stringify(input));
    writeFileSync("order.json", JSON.stringify({ ...order, allConflictingActorsTerminal: false }));
    await expect(quarantineSavedHoldings(join(temp, "input.json"), join(temp, "out.json"))).rejects.toThrow();
    expect(existsSync(join(temp, "tmp"))).toBe(false); expect(writes).toHaveLength(0);
    writeFileSync("order.json", JSON.stringify(order)); fault = failure;
    await expect(quarantineSavedHoldings(join(temp, "input.json"), join(temp, "out.json"))).rejects.toThrow();
    expect(writes).toHaveLength(1); const before = writes.length;
    writeFileSync("input2.json", JSON.stringify(input));
    await expect(quarantineSavedHoldings(join(temp, "input2.json"), join(temp, "out2.json"))).rejects.toThrow(); expect(writes).toHaveLength(before);
    const state = join(temp, "tmp/holdings-source-quarantine"); expect(readdirSync(state)).toHaveLength(1);
    expect(existsSync(join(state, readdirSync(state)[0], "quarantine-started.json"))).toBe(true);
    expect(existsSync("out.json.pending-write.json")).toBe(true); expect(existsSync("out.json")).toBe(false);
  });
});
