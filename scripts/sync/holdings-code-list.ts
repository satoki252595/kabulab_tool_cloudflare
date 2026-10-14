/** Reuse sector33's physically saved FSA generation; never fetch a second upstream copy. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { z } from "zod";
import { findUniqueBackupChildByTitle } from "../../src/shared/notion-archive/archive.js";
import { notionRequest } from "../../src/shared/notion-archive/client.js";
import { notionEnv } from "../../src/shared/notion-archive/env.js";
import { priceFileSchema, type PriceFile } from "../../src/shared/holdings/price-registry.js";
import { downloadArchivedFile } from "../moneyflow/lib/archived-files.js";
import { parseHoldingsCodeList, type ArchivedSource } from "../../services/yuho-quant/src/services/edinet/shareholdings-valuation.js";
import { jstDateSec } from "../../src/shared/vwap/proof.js";

type Part = { type: string; plain_text: string; text: { content: string } };
interface Page {
  object: string; id: string; archived: boolean; in_trash: boolean;
  parent: { type: string; database_id: string };
  properties: Record<string, { type: string; has_more?: boolean; rich_text?: Part[]; title?: Part[];
    select?: { name: string }; date?: { start: string };
    files?: Array<{ name: string; type: string; file?: { url: string } }> }>;
}
interface Entry { originalFilename: string; uploadFilename: string; byteLength: number; sha256: string; upload: string }
export class HoldingsCodeListBudgetError extends Error {}
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const SOURCE_URL = "https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip";
function text(page: Page, name: string, type: "title" | "rich_text"): string {
  const prop = page.properties[name]; assert.equal(prop.type, type);
  const parts = prop[type]; assert.ok(Array.isArray(parts));
  return parts.map(part => { assert.equal(part.type, "text"); assert.equal(part.plain_text, part.text.content); return part.plain_text; }).join("");
}
function clock(value: unknown): number {
  const result = Date.parse(z.string().datetime({ offset: true }).parse(value)); assert.ok(Number.isFinite(result)); return result;
}
function pageGuard(page: Page, id: string, dbId?: string): void {
  assert.equal(page.object, "page"); assert.equal(page.id.replaceAll("-", ""), id.replaceAll("-", ""));
  assert.equal(page.archived, false); assert.equal(page.in_trash, false); assert.equal(page.parent.type, "database_id");
  assert.match(page.parent.database_id.replaceAll("-", ""), /^[a-f0-9]{32}$/i);
  if (dbId !== undefined) assert.equal(page.parent.database_id.replaceAll("-", ""), dbId.replaceAll("-", ""));
  assert.ok(Object.values(page.properties).every(prop => prop.has_more !== true), "公式銘柄表のpage応答が打ち切られています");
  assert.equal(page.properties.Status.type, "select"); assert.equal(page.properties.Status.select?.name, "recorded", "最新の公式銘柄表の物理保管が未完了です");
}
// Match Python json.dumps(sort_keys=True, ensure_ascii=False, separators=(',', ':')).
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}

/** One-file bootstrap remains supported; normal generations require the exact ZIP + capture manifest. */
export async function readVerifiedHoldingsCodeList(expected: PriceFile, maxBytes?: number): Promise<{
  source: ArchivedSource; asOf: string; readBytes: number; generation?: { key: string; completedAt: string; fetchedAt: string };
}> {
  priceFileSchema.parse(expected);
  assert.match(expected.filename, /^[A-Za-z0-9_.-]+\.zip$/);
  const page = await notionRequest<Page>("GET", `/pages/${expected.archivePageId}`, undefined, { singleAttempt: true });
  pageGuard(page, expected.archivePageId);
  const metadata = JSON.parse(text(page, "Metadata", "rich_text"));
  const manifest = metadata._fileManifest;
  assert.equal(manifest.version, 1); assert.match(manifest.inputFingerprint, /^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(manifest.files) && (manifest.files.length === 1 || manifest.files.length === 2));
  const entries: Entry[] = manifest.files;
  const files = page.properties.Files; assert.equal(files.type, "files"); assert.equal(files.files?.length, entries.length);
  assert.equal(new Set(entries.map(entry => entry.originalFilename)).size, entries.length);
  assert.equal(new Set(files.files.map(file => file.name)).size, entries.length);
  for (const entry of entries) {
    assert.equal(entry.originalFilename, entry.uploadFilename); assert.equal(entry.upload, "uploaded");
    assert.match(entry.sha256, /^[a-f0-9]{64}$/); assert.ok(Number.isSafeInteger(entry.byteLength) && entry.byteLength > 0 && entry.byteLength <= 20 * 1024 * 1024);
    const match: NonNullable<Page["properties"][string]["files"]> = files.files.filter(file => file.name === entry.originalFilename); assert.equal(match.length, 1);
    assert.equal(match[0].type, "file"); assert.ok(typeof match[0].file?.url === "string");
  }
  const zip = entries.filter(entry => entry.originalFilename === expected.filename); assert.equal(zip.length, 1);
  assert.equal(zip[0].sha256, expected.sha256); assert.equal(zip[0].byteLength, expected.byteLength);
  const capture = entries.find(entry => entry !== zip[0]);
  if (capture !== undefined) {
    assert.match(capture.originalFilename, /^[A-Za-z0-9_.-]+-sector33-manifest\.json$/); assert.ok(capture.byteLength <= 1024 * 1024);
  }
  const readBytes = entries.reduce((sum, entry) => sum + entry.byteLength, 0);
  if (maxBytes !== undefined) {
    assert.ok(Number.isSafeInteger(maxBytes) && maxBytes >= 0);
    if (readBytes > maxBytes) throw new HoldingsCodeListBudgetError("公式銘柄表のZIPとcapture manifestの全文読取予算が不足しています");
  }
  const read = async (entry: Entry) => {
    const file = files.files!.find(file => file.name === entry.originalFilename)!;
    const bytes = Buffer.from(await downloadArchivedFile({ name: entry.originalFilename, url: file.file!.url }, "保有価格の公式銘柄表", { maxBytes: entry.byteLength }));
    assert.equal(bytes.length, entry.byteLength); assert.equal(hash(bytes), entry.sha256, "公式銘柄表の全SHAが不一致です");
    return bytes;
  };
  const bytes = await read(zip[0]), source = { ...expected, bytes }, catalog = parseHoldingsCodeList(source);
  if (entries.length === 1) return { source, asOf: catalog.asOf, readBytes };
  assert.ok(capture);
  const body = JSON.parse((await read(capture)).toString("utf8")), key = text(page, "Key", "title");
  assert.equal(body.key, key); assert.equal(body.sourceUrl, SOURCE_URL); assert.equal(body.asOf, catalog.asOf);
  assert.equal(body.zipSha256, expected.sha256); assert.equal(body.zipBytes, expected.byteLength);
  assert.equal(metadata.asOf, body.asOf); assert.equal(metadata.sha256, body.zipSha256); assert.equal(metadata.bytes, body.zipBytes); assert.equal(metadata.completedAt, body.completedAt);
  assert.equal(body.response.status, 200); assert.equal(body.response.finalUrl, SOURCE_URL);
  assert.ok(Number.isSafeInteger(body.listedRecords) && body.listedRecords > 0);
  const fetchedAt = page.properties["Fetched At"]; assert.equal(fetchedAt.type, "date"); assert.ok(fetchedAt.date);
  assert.ok(clock(body.requestedAt) <= clock(body.completedAt) && clock(body.completedAt) <= clock(fetchedAt.date.start));
  const captureBody = Object.fromEntries(Object.entries(body).filter(([name]) => name !== "key"));
  assert.equal(key, `edinet-codelist-${body.asOf}-${hash(JSON.stringify(canonical(captureBody))).slice(0, 12)}`, "公式銘柄表のcapture世代keyが不一致です");
  return { source, asOf: catalog.asOf, readBytes, generation: { key, completedAt: body.completedAt, fetchedAt: fetchedAt.date.start } };
}

/** Bounded newest-two selection; malformed newest data never selects the older generation. */
export async function resolveLatestHoldingsCodeList(previous: PriceFile, finishedAt: string): Promise<
  { status: "ready"; file: PriceFile } | { status: "held"; reason: string }
> {
  const at = clock(finishedAt);
  const dbId = await findUniqueBackupChildByTitle({ parentPageId: notionEnv.NOTION_ARCHIVE_PAGE_ID(), title: "一次データ｜universe", kind: "database" });
  if (dbId === null) return { status: "held", reason: "通常取得が保管した公式銘柄表DBがありません。旧価格snapshotを維持します" };
  const result = await notionRequest<{ results: Page[]; has_more: boolean; next_cursor: string | null }>("POST", `/databases/${dbId}/query`, {
    filter: { property: "Key", title: { starts_with: "edinet-codelist-" } },
    sorts: [{ property: "Fetched At", direction: "descending" }], page_size: 2,
  }, { singleAttempt: true });
  assert.ok(Array.isArray(result.results) && result.results.length <= 2); assert.equal(typeof result.has_more, "boolean");
  if (result.has_more) assert.ok(result.results.length === 2 && typeof result.next_cursor === "string" && result.next_cursor.length > 0);
  else assert.equal(result.next_cursor, null);
  if (result.results.length === 0) return { status: "held", reason: "通常取得の公式銘柄表世代がありません。旧価格snapshotを維持します" };
  const selected = result.results[0]; pageGuard(selected, selected.id, dbId);
  const fetched = (page: Page) => { assert.equal(page.properties["Fetched At"].type, "date"); return clock(page.properties["Fetched At"].date?.start); };
  assert.ok(fetched(selected) <= at, "公式銘柄表の保管時計が価格run完了より未来です");
  if (result.results.length === 2) assert.ok(fetched(selected) > fetched(result.results[1]), "最新の公式銘柄表が同時計競合/順序不一致です");
  const key = text(selected, "Key", "title"); assert.match(key, /^edinet-codelist-\d{4}-\d\d-\d\d-[a-f0-9]{12}$/);
  const metadata = JSON.parse(text(selected, "Metadata", "rich_text"));
  const entries: Entry[] = metadata._fileManifest.files; assert.ok(Array.isArray(entries) && entries.length === 2);
  const zip = entries.filter(entry => entry.originalFilename.endsWith(".zip")); assert.equal(zip.length, 1);
  const file = priceFileSchema.parse({ archivePageId: selected.id, filename: zip[0].originalFilename, sha256: zip[0].sha256, byteLength: zip[0].byteLength });
  const current = await readVerifiedHoldingsCodeList(file);
  const before = JSON.stringify(priceFileSchema.parse(previous)) === JSON.stringify(file) ? current : await readVerifiedHoldingsCodeList(previous);
  assert.ok(current.generation); assert.equal(current.generation.key, key); assert.equal(clock(current.generation.fetchedAt), fetched(selected));
  assert.ok(clock(current.generation.completedAt) <= at);
  assert.ok(current.asOf >= before.asOf, "公式銘柄表の基準日が後退しています");
  assert.ok(current.asOf <= jstDateSec(at / 1000), "公式銘柄表の基準日が未来です");
  if (before.generation !== undefined) {
    assert.ok(clock(current.generation.completedAt) >= clock(before.generation.completedAt), "公式銘柄表の実取得時計が後退しています");
    if (clock(current.generation.completedAt) === clock(before.generation.completedAt)) assert.equal(current.source.sha256, before.source.sha256, "公式銘柄表の同一取得時計で原本が競合しています");
  }
  return { status: "ready", file };
}
