/** 保存済み同一原本の明示月限定から、余剰1行だけを除く。全量取込の代用にはしない。 */
import { createHash } from "node:crypto";
import { constants, createReadStream, fstatSync, lstatSync, openSync, closeSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { isDeepStrictEqual } from "node:util";
import { createGunzip } from "node:zlib";
import { eq, getTableColumns, sql } from "drizzle-orm";
import type { AnySQLiteTable } from "drizzle-orm/sqlite-core";
import type { D1BatchStatement } from "../../../src/shared/db/d1-http-client.js";
import { notionRequest } from "../../../src/shared/notion-archive/client.js";
import { notionEnv } from "../../../src/shared/notion-archive/env.js";
import { assertAdoptedDatabaseSchema, inputFingerprint, readFileManifest } from "../../../src/shared/notion-archive/archive.js";
import { stockFinancials, stockScores, stocks, yutaiBenefits } from "../src/db/schema.js";
import { parsePublicBenefitFacts } from "../src/public-facts.js";
import { benefitKey } from "./benefit-key.js";
import { assertNotCommittable } from "./private-path.js";
import { buildStockPreflightStatement, snapshotStockPreimages, type StockBatch } from "./atomic-apply.js";
import { buildYieldScoreStatements, computeYieldEntries, type RecomputeYieldsDb, type YieldInputs } from "./recompute-yields.js";
import { benefitRowsOf, explicitRowRecordMonth, type StockYutaiData } from "./yutai-full-import.js";

type Cell = string | number | null;
type Row = Record<string, Cell>;
const tables = { parent: stocks, benefits: yutaiBenefits, financial: stockFinancials, scores: stockScores };
const tableNames = { parent: "core_stocks", benefits: "yutai_benefits", financial: "otakara_stock_financials", scores: "otakara_stock_scores" };
export type MonthScopePreimage = { parent: Row; benefits: Row[]; financial: Row | null; scores: Row | null };
export type SavedMonthScopePage = { html: string; url: string; receivedAt: string; batchFetchedAt: string; pages: number; rawBytes: number; compressedBytes: number; sha256: string };
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

/** private実体ファイルだけを開く。途中のsymlinkも拒否し、開いたinodeを固定する。 */
function privateFile(path: string): number {
  assertNotCommittable(path);
  const full = resolve(path), st = lstatSync(full);
  assert(realpathSync(full) === full && st.isFile() && !st.isSymbolicLink() && st.uid === process.getuid?.() && (st.mode & 0o777) === 0o600, "月限定入力は所有者限定0600の実体ファイルが必要です");
  const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW), actual = fstatSync(fd);
  if (actual.dev !== st.dev || actual.ino !== st.ino || actual.mode !== st.mode || actual.uid !== st.uid) { closeSync(fd); throw new Error("月限定入力のinodeが変わりました"); }
  return fd;
}

/** 既存の物理添付全bytes verifierへ渡す圧縮bytesも、同じprivate資格/完全SHAで読む。 */
export function readMonthScopeRawBytes(path: string, sha256: string): Uint8Array {
  const fd = privateFile(path);
  try {
    assert(fstatSync(fd).size <= 256 * 1024 * 1024, "保存gzipが有限上限を超えました");
    const bytes = readFileSync(fd); assert(digest(bytes) === sha256, "物理照合用gzipの完全SHAが変わりました"); return bytes;
  } finally { closeSync(fd); }
}

/** 全gzipのSHAとEOFを検証する。全市場のHTMLはdecodeせず、指定codeの1件だけを戻す。 */
export async function readSavedMonthScopePage(path: string, sha256: string, code: string): Promise<SavedMonthScopePage> {
  assert(/^[a-f0-9]{64}$/.test(sha256) && /^\d{3}[0-9A-Z]$/.test(code), "月限定の完全SHA/codeが不正です");
  const fd = privateFile(path), hash = createHash("sha256");
  let compressedBytes = 0, expandedBytes = 0, pages = 0, rawBytes = 0, tail = "", lastClock: string | undefined;
  let selected: { html: string; url: string; receivedAt: string } | undefined;
  const target = `https://minkabu.jp/stock/${code}/yutai`;
  const line = (text: string) => {
    assert(text.length > 0 && Buffer.byteLength(text) <= 8 * 1024 * 1024 && ++pages <= 10_000, "保存原本の行数/行サイズが上限外です");
    const value: unknown = JSON.parse(text);
    assert(value !== null && typeof value === "object" && !Array.isArray(value), "保存原本の行形式が不正です");
    const p = value as Record<string, unknown>;
    assert(isDeepStrictEqual(Object.keys(p).sort(), ["url", "receivedAt", "status", "contentType", "byteLength", "bodyBase64"].sort()) &&
      typeof p.url === "string" && typeof p.receivedAt === "string" && new Date(p.receivedAt).toISOString() === p.receivedAt &&
      (p.status === null || (typeof p.status === "number" && Number.isInteger(p.status))) &&
      (p.contentType === null || typeof p.contentType === "string") && typeof p.byteLength === "number" && Number.isSafeInteger(p.byteLength) && p.byteLength > 0 &&
      typeof p.bodyBase64 === "string" && p.bodyBase64.length === Math.ceil(p.byteLength / 3) * 4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.bodyBase64), "保存原本のmetadataが不正です");
    lastClock = p.receivedAt;
    rawBytes += p.byteLength;
    if (p.url !== target) return;
    assert(selected === undefined && p.status === 200 && typeof p.contentType === "string" && /^text\/html(?:;|$)/i.test(p.contentType), "指定銘柄の原本が重複/非200/非HTMLです");
    const bytes = Buffer.from(p.bodyBase64, "base64");
    assert(bytes.length === p.byteLength && bytes.toString("base64") === p.bodyBase64, "指定銘柄の原本bytesが不整合です");
    selected = { html: new TextDecoder("utf-8", { fatal: true }).decode(bytes), url: p.url, receivedAt: p.receivedAt };
  };
  try {
    await pipeline(createReadStream(path, { fd, autoClose: false }), async function* (source) {
      for await (const chunk of source) {
        const bytes = Buffer.from(chunk as Uint8Array); compressedBytes += bytes.length;
        assert(compressedBytes <= 256 * 1024 * 1024, "保存gzipが有限上限を超えました"); hash.update(bytes); yield bytes;
      }
    }, createGunzip(), async source => {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      for await (const chunk of source) {
        expandedBytes += (chunk as Uint8Array).length;
        assert(expandedBytes <= 1024 * 1024 * 1024, "保存gzipの展開が有限上限を超えました");
        tail += decoder.decode(chunk as Uint8Array, { stream: true });
        let end: number;
        while ((end = tail.indexOf("\n")) >= 0) { line(tail.slice(0, end)); tail = tail.slice(end + 1); }
        assert(Buffer.byteLength(tail) <= 8 * 1024 * 1024, "保存原本の行が有限上限を超えました");
      }
      tail += decoder.decode();
      assert(tail.length === 0, "保存原本のJSONL末尾が未閉鎖です");
    });
    assert(hash.digest("hex") === sha256 && selected !== undefined && lastClock !== undefined, "保存原本の完全SHA/指定銘柄が一致しません");
    return { ...selected, batchFetchedAt: lastClock, pages, rawBytes, compressedBytes, sha256 };
  } finally { closeSync(fd); }
}

function record(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "原本保管metadataが不正です"); return value as Record<string, unknown>;
}
function sameId(a: unknown, b: unknown): boolean {
  const valid = (v: unknown): v is string => typeof v === "string" && /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(v);
  return valid(a) && valid(b) && a.replaceAll("-", "").toLowerCase() === b.replaceAll("-", "").toLowerCase();
}
function richText(value: unknown): string {
  assert(Array.isArray(value) && value.length < 25, "原本保管の文字列が欠落/未閉鎖です");
  return value.map(part => {
    const v = record(part), text = record(v.text);
    assert(v.type === "text" && typeof v.plain_text === "string" && v.plain_text === text.content, "原本保管の文字列が不完全です"); return v.plain_text;
  }).join("");
}
function completeNative(value: unknown) {
  const v = record(value);
  assert(!Object.hasOwn(v, "incomplete") && !Object.hasOwn(v, "truncated") &&
    (!Object.hasOwn(v, "request_status") || isDeepStrictEqual(v.request_status, { type: "complete" })), "原本保管の応答が未閉鎖です"); return v;
}

/** 既知page→親DBの純GET各1回。作成/検索はせずcanonical原本pointerとmanifestを資格化する。 */
export async function qualifySavedMonthScopeArchive(pageId: string, filename: string, raw: SavedMonthScopePage): Promise<void> {
  const page = completeNative(await notionRequest<unknown>("GET", `/pages/${pageId}`, undefined, { singleAttempt: true }));
  const parent = record(page.parent), props = record(page.properties), property = (key: string, type: string) => {
    const p = record(props[key]); assert(p.type === type && p.has_more !== true, "原本保管propertyの型/完成状態が不正です"); return p;
  };
  const key = filename.slice(0, -".jsonl.gz".length), runId = key.slice("yutai-source-".length);
  assert(page.object === "page" && sameId(page.id, pageId) && page.archived === false && page.in_trash === false && parent.type === "database_id" && sameId(parent.database_id, parent.database_id) &&
    richText(property("Key", "title").title) === key && record(property("Service", "select").select).name === "otakara-yutai" &&
    record(property("Status", "select").select).name === "recorded" && richText(property("Source", "rich_text").rich_text) === "minkabu search/detail response bytes (gzip lossless)", "保存原本のpage/親/キー/完成状態が一致しません");
  const metadata = record(JSON.parse(richText(property("Metadata", "rich_text").rich_text)));
  assert(metadata.runId === runId && metadata.pages === raw.pages && metadata.rawBytes === raw.rawBytes && metadata.bytes === raw.compressedBytes && metadata.sha256 === raw.sha256 && !Object.hasOwn(metadata, "_fileTooLarge"), "保存原本metadataと元gzipが一致しません");
  const manifest = readFileManifest(metadata);
  const fingerprint = await inputFingerprint([{ filename, contentType: "application/gzip", byteLength: raw.compressedBytes, sha256: raw.sha256 }]);
  assert(manifest !== "absent" && manifest !== "malformed" && manifest.files.length === 1 && manifest.inputFingerprint === fingerprint, "保存原本manifestが未資格です");
  const file = manifest.files[0];
  assert(file.originalFilename === filename && file.uploadFilename === filename && file.originalMime === "application/gzip" && file.uploadMime === "application/gzip" && file.byteLength === raw.compressedBytes && file.sha256 === raw.sha256 && file.upload === "uploaded", "保存原本の添付manifestが一致しません");
  const files = property("Files", "files").files;
  assert(Array.isArray(files) && files.length === 1 && record(files[0]).name === filename && record(files[0]).type === "file" && typeof record(record(files[0]).file).url === "string", "保存原本が単一のhosted添付ではありません");
  const observed = record(property("Fetched At", "date").date).start;
  assert(typeof observed === "string" && Number.isFinite(Date.parse(observed)) &&
    (Date.parse(observed) === Date.parse(raw.batchFetchedAt) || Date.parse(observed) === Math.floor(Date.parse(raw.batchFetchedAt) / 60_000) * 60_000), "Notionの原本取得時刻が元rawの実時計/分表現と一致しません");
  const db = completeNative(await notionRequest<unknown>("GET", `/databases/${parent.database_id}`, undefined, { singleAttempt: true })), dbParent = record(db.parent);
  assert(db.object === "database" && sameId(db.id, parent.database_id) && db.archived === false && db.in_trash === false &&
    dbParent.type === "page_id" && sameId(dbParent.page_id, notionEnv.NOTION_ARCHIVE_PAGE_ID()) && richText(db.title) === "一次データ｜otakara-yutai", "保存原本DBがcanonical親/titleと一致しません");
  const dbProperties = record(db.properties);
  for (const value of Object.values(dbProperties)) record(value);
  assertAdoptedDatabaseSchema(dbProperties as Record<string, { type: string }>, { Key: { title: {} }, Service: { select: {} }, Source: { rich_text: {} }, "Fetched At": { date: {} }, Status: { select: {} }, Metadata: { rich_text: {} }, Files: { files: {} } }, "保存月限定是正の正本原本DB");
}

function columns(table: AnySQLiteTable) { return Object.entries(getTableColumns(table)); }
function assertRow(value: unknown, table: AnySQLiteTable): asserts value is Row {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "全列PREの行形式が不正です");
  const row = value as Record<string, unknown>;
  assert(isDeepStrictEqual(Object.keys(row).sort(), columns(table).map(([key]) => key).sort()), "全列PREのschema列が一致しません");
  for (const [key, col] of columns(table)) {
    const v = row[key];
    assert(v === null ? !col.notNull : col.dataType === "string" || col.columnType === "SQLiteTextJson" ? typeof v === "string" : typeof v === "number" && Number.isFinite(v), "全列PREの型が一致しません");
  }
}
/** JSONtextとunix秒をそのまま保持する、schema whitelist付きの完全PRE資格。 */
export function assertMonthScopePreimage(value: unknown): asserts value is MonthScopePreimage {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "月限定PREが不正です");
  const p = value as Record<string, unknown>;
  assert(isDeepStrictEqual(Object.keys(p).sort(), ["parent", "benefits", "financial", "scores"].sort()), "月限定PREのキーが不正です");
  assertRow(p.parent, stocks);
  assert(Array.isArray(p.benefits) && p.benefits.length > 0 && p.benefits.length <= 100, "月限定PREの優待集合が上限外です");
  p.benefits.forEach(row => assertRow(row, yutaiBenefits));
  if (p.financial !== null) assertRow(p.financial, stockFinancials);
  if (p.scores !== null) assertRow(p.scores, stockScores);
  const parent = p.parent;
  assert(parent.isActive === 1 && parent.instrumentType === "equity" && parent.isYutai === 1 &&
    Number.isSafeInteger(parent.id) && new Set(p.benefits.map(row => row.id)).size === p.benefits.length &&
    p.benefits.every(row => row.stockId === parent.id && Number.isSafeInteger(row.id)) &&
    (p.financial === null || p.financial.stockId === parent.id) && (p.scores === null || p.scores.stockId === parent.id), "月限定PREの親/ID/母集団が不正です");
}

/** 固定SHAのprivate全列PREを、通信より先に読む。 */
export function readMonthScopePreimage(path: string, sha256: string): MonthScopePreimage {
  assert(/^[a-f0-9]{64}$/.test(sha256), "月限定PREの完全SHAが不正です");
  const fd = privateFile(path);
  try {
    assert(fstatSync(fd).size <= 1024 * 1024, "月限定PREが有限上限を超えました");
    const bytes = readFileSync(fd); assert(bytes.length <= 1024 * 1024 && digest(bytes) === sha256, "月限定PREのサイズ/SHAが一致しません");
    const p: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); assertMonthScopePreimage(p); return p;
  } finally { closeSync(fd); }
}

/** 指定銘柄以外を先読みしない。raw SQL射影でDTO文字列/boolean/日時のDB表現を保つ。 */
export async function loadMonthScopePreimage(db: RecomputeYieldsDb, code: string): Promise<MonthScopePreimage> {
  assert(/^\d{3}[0-9A-Z]$/.test(code), "月限定codeが不正です");
  const projection = (table: AnySQLiteTable) => Object.fromEntries(columns(table).map(([key, col]) => [key, sql`${col}`]));
  const parents = await db.select(projection(stocks)).from(stocks).where(eq(stocks.code, code)).limit(2);
  assert(parents.length === 1, "月限定の親銘柄が一意ではありません");
  const id = parents[0].id as number;
  const [benefits, financial, scores] = await Promise.all([
    db.select(projection(yutaiBenefits)).from(yutaiBenefits).where(eq(yutaiBenefits.stockId, id)).orderBy(yutaiBenefits.id).limit(101),
    db.select(projection(stockFinancials)).from(stockFinancials).where(eq(stockFinancials.stockId, id)).limit(2),
    db.select(projection(stockScores)).from(stockScores).where(eq(stockScores.stockId, id)).limit(2),
  ]);
  assert(financial.length <= 1 && scores.length <= 1, "月限定の財務/scoreが一意ではありません");
  const p = { parent: parents[0], benefits, financial: financial.length === 0 ? null : financial[0], scores: scores.length === 0 ? null : scores[0] };
  assertMonthScopePreimage(p); return p;
}

/** 順序に依存せず全列・全IDを比較する。値/掲載文はエラーに出さない。 */
export function assertMonthScopeRowsEqual(expected: MonthScopePreimage, actual: MonthScopePreimage): void {
  const ordered = (p: MonthScopePreimage) => ({ ...p, benefits: [...p.benefits].sort((a, b) => Number(a.id) - Number(b.id)) });
  assert(isDeepStrictEqual(ordered(expected), ordered(actual)), "月限定の全列PRE/readbackが一致しません");
}

/** schema由来の列名だけをSQL化し、値は単一JSONへbindする。全4表の補完CAS。 */
export function fullCas(pre: MonthScopePreimage, clock?: { minimum: number; maximum: number }): D1BatchStatement {
  const conditions: string[] = [], params: (string | number)[] = [JSON.stringify(pre)];
  for (const name of Object.keys(tables) as (keyof typeof tables)[]) {
    const count = name === "benefits" ? pre.benefits.length : pre[name] === null ? 0 : 1;
    const where = name === "parent" ? "id" : "stock_id";
    conditions.push(`(SELECT count(*) FROM ${tableNames[name]} WHERE ${where} = ?) = ${count}`); params.push(Number(pre.parent.id));
    if (count === 0) continue;
    const path = name === "benefits" ? "json_each(json_extract((SELECT j FROM snap),'$.benefits'))" : `json_each(json_array(json_extract((SELECT j FROM snap),'$.${name}')))`;
    const mismatch = columns(tables[name]).map(([key, col]) => {
      if (name === "financial" && key === "fetchedAt" && clock !== undefined) return `(typeof(b.${col.name}) != 'integer' OR b.${col.name} < ${clock.minimum} OR b.${col.name} > ${clock.maximum})`;
      return `b.${col.name} IS NOT json_extract(exp.value,'$.${key}')`;
    }).join(" OR ");
    conditions.push(`NOT EXISTS (SELECT 1 FROM ${path} exp LEFT JOIN ${tableNames[name]} b ON b.${where}=json_extract(exp.value,'$.${name === "parent" ? "id" : "stockId"}')${name === "benefits" ? " AND b.id=json_extract(exp.value,'$.id')" : ""} WHERE b.${where} IS NULL OR ${mismatch})`);
  }
  return { sql: `WITH snap(j) AS (VALUES (?)) SELECT json(CASE WHEN ${conditions.join(" AND ")} THEN 'null' ELSE '' END)`, params };
}

/** 原本・全現行行が同一で、明示月限定に反する余剰がちょうど1行のときだけ計画する。 */
export function planSavedMonthScope(pre: MonthScopePreimage, data: StockYutaiData, raw: SavedMonthScopePage, inputs: YieldInputs, now = Date.now()) {
  assertMonthScopePreimage(pre);
  assert(pre.parent.code === data.code && data.sourceFetchedAt === raw.receivedAt && raw.url === `https://minkabu.jp/stock/${data.code}/yutai`, "原本と銘柄/実取得時計が一致しません");
  const source = benefitRowsOf(data);
  assert(source.heldBenefits === 0 && source.rows.length > 0 && source.rows.length === pre.benefits.length - 1, "月限定是正は余剰1行/missing0だけです");
  const remaining = [...pre.benefits];
  for (const row of pre.benefits) {
    assert(row.recordDate === null && typeof row.publicFacts === "string" && typeof row.description === "string", "月限定是正に単発/DTO欠落があります");
    const facts = parsePublicBenefitFacts(row.publicFacts);
    assert(facts !== null && facts.sourceGroup === benefitKey(data.code, row.description) && facts.source.listingUrl === raw.url && facts.source.fetchedAt === raw.receivedAt && facts.source.batchFetchedAt === raw.batchFetchedAt, "現行DTOの原本/群/実取得時計が一致しません");
  }
  for (const row of source.rows) {
    const matches = remaining.filter(current => current.description === row.description && current.minShares === row.minShares && current.recordMonth === row.recordMonth);
    assert(matches.length === 1, "原本の全行を現行へ一意に対応できません"); remaining.splice(remaining.indexOf(matches[0]), 1);
  }
  assert(remaining.length === 1, "余剰行が一意ではありません");
  const excess = remaining[0], retained = pre.benefits.filter(row => row.id !== excess.id);
  const restricted = data.benefits.filter(benefit => explicitRowRecordMonth(benefit.description) !== undefined &&
    benefitRowsOf({ ...data, benefits: [benefit] }).rows.some(row => row.description === excess.description && row.minShares === excess.minShares));
  assert(restricted.length === 1 && restricted[0].localRecordMonths.length === 1 && restricted[0].localRecordMonths[0] === explicitRowRecordMonth(restricted[0].description) &&
    restricted[0].tableRecordMonths !== undefined && restricted[0].tableRecordMonths.includes(Number(excess.recordMonth)) &&
    retained.some(row => row.description === excess.description && row.minShares === excess.minShares) &&
    !restricted[0].localRecordMonths.includes(Number(excess.recordMonth)), "余剰行が原本の明示月限定に結び付きません");
  const stockId = Number(pre.parent.id), snapshot = snapshotStockPreimages(inputs, [stockId]).get(stockId)!;
  assert(snapshot.parent.code === pre.parent.code && snapshot.benefits.length === pre.benefits.length, "再計算の親/全行集合がPREと一致しません");
  const projected = pre.benefits.map(row => Object.fromEntries(Object.keys(snapshot.benefits[0]).map(key => [key, row[key]]))).sort((a, b) => Number(a.id) - Number(b.id));
  assert(isDeepStrictEqual(projected, snapshot.benefits), "再計算の優待射影が全列PREと一致しません");
  const financial = snapshot.financial === null ? null : Object.fromEntries(Object.keys(snapshot.financial).map(key => [key, pre.financial?.[key]]));
  const scores = snapshot.scores === null ? null : Object.fromEntries(Object.keys(snapshot.scores).map(key => [key, pre.scores?.[key]]));
  assert(isDeepStrictEqual(snapshot.financial, financial) && isDeepStrictEqual(snapshot.scores, scores) &&
    (snapshot.financial === null) === (pre.financial === null) && (snapshot.scores === null) === (pre.scores === null), "再計算の財務/score射影が全列PREと一致しません");
  assert(Number.isSafeInteger(now) && now > 0, "再計算の実行時計が不正です");
  const filtered: YieldInputs = { ...inputs, benefits: new Map(inputs.benefits) };
  filtered.benefits.set(stockId, inputs.benefits.get(stockId)!.filter(row => row.rowId !== excess.id));
  const yieldPlan = computeYieldEntries([stockId], filtered), entry = yieldPlan.entries[0];
  const expected: MonthScopePreimage = structuredClone({ ...pre, benefits: retained });
  if (entry?.changed && expected.financial !== null) expected.financial.yutaiYield = entry.next;
  if (entry?.scoreChanged && entry.scoreNext !== null && expected.scores !== null) Object.assign(expected.scores, entry.scoreNext);
  const clock = entry?.changed ? { minimum: Math.floor(now / 1000), maximum: Math.floor(now / 1000) + 15 * 60 } : undefined;
  const statements: D1BatchStatement[] = [buildStockPreflightStatement(snapshot), fullCas(pre),
    { sql: "DELETE FROM yutai_benefits WHERE id = ? AND stock_id = ?", params: [excess.id, stockId] },
    { sql: "SELECT json(CASE WHEN changes() = 1 THEN 'null' ELSE '' END)", params: [] }];
  if (entry !== undefined) for (const statement of buildYieldScoreStatements(entry)) statements.push(statement, { sql: "SELECT json(CASE WHEN changes() = 1 THEN 'null' ELSE '' END)", params: [] });
  statements.push(fullCas(expected, clock));
  const batch: StockBatch = { stockId, key: `saved-month-scope:${stockId}:${excess.id}`, statements };
  return { batch, expected, excessId: Number(excess.id), yieldPlan, clock };
}

/** 通常builderだけが変える財務時計を範囲検証し、残り全列/IDは完全一致させる。 */
export function assertMonthScopePost(plan: Pick<ReturnType<typeof planSavedMonthScope>, "expected" | "clock">, actual: MonthScopePreimage): void {
  const expected = structuredClone(plan.expected);
  if (plan.clock !== undefined) {
    assert(actual.financial !== null && typeof actual.financial.fetchedAt === "number" && Number.isSafeInteger(actual.financial.fetchedAt) && actual.financial.fetchedAt >= plan.clock.minimum && actual.financial.fetchedAt <= plan.clock.maximum, "通常再計算の財務時計が範囲外です");
    expected.financial!.fetchedAt = actual.financial.fetchedAt;
  }
  assertMonthScopeRowsEqual(expected, actual);
}
