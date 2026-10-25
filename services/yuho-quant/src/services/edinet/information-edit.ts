/** 情報修正だけを機械再資格化する。金融/本文writerを迂回せず、既存値完全一致時の解決行だけを追記する。 */
import { and, eq, getTableColumns, sql, type SQL } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Database } from "../../db/client.js";
import { edinetCatchupProgress, edinetReportedChanges as observations, edinetReportedResolutions as resolutions,
  yuhoDocuments, orderFacts, overseasSalesFacts, textSections } from "../../db/schema.js";
import { stocks } from "../../../../../src/shared/db/core-schema.js";
import { disclosureIngestCondition } from "../../../../../src/shared/db/active-equity.js";
import { sha256Hex } from "../../../../../src/shared/sha256.js";
import { toD1BatchStatements, type createD1HttpBatchSender } from "../../../../../src/shared/db/d1-http-client.js";
import { readVerifiedDocText } from "../text-backup.js";
import { notionEnv } from "../../../../../src/shared/notion-archive/env.js";
import { NotionUnknownResultError } from "../../../../../src/shared/notion-archive/client.js";
import { readSavedEdinetZip, SavedEdinetZipQualificationError } from "./archive.js";
import { edinetArchiveNativeMetadata } from "./archive-metadata.js";
import { captureListSnapshot, readListSnapshot, listSnapshotSchema, EdinetListQualificationError, type ListSnapshot } from "./list-snapshot.js";
import { EdinetListFetchError } from "./client.js";
import { edinetDocSchema, parseSubmitDateTime, secCodeToTicker, type EdinetDoc } from "./types.js";
import { loadEdinetTickerMap, edinetTickerIdentityGuard } from "./identity.js";
import { unresolvedReportedObservation } from "./reported-changes.js";
import { parseEdinetCsvZip } from "./csv.js";
import { extractTextSections } from "./text-sections.js";
import { parseOrderData, RX_ORDER_KEYWORD } from "./order-parser.js";
import { parseOverseasData, RX_OVERSEAS_KEYWORD, validateOverseasSaveSet } from "../overseas-parser.js";
import { toOrderSaveRows } from "../order-save-rows.js";
import { toOverseasSaveRows } from "../overseas-save-rows.js";
import { serializeOverseasOmission } from "../overseas-omission.js";

class InformationEditHold extends Error {}
function requireSame(value: unknown, message: string): asserts value {
  if (!value) throw new InformationEditHold(message);
}
const rawValue = (v: unknown): unknown => v instanceof Date ? v.getTime() / 1000 : typeof v === "boolean" ? Number(v) : v;
const normalized = (v: unknown): unknown => Array.isArray(v) ? v.map(normalized) : v && typeof v === "object" && !(v instanceof Date)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => [k, normalized(value)])) : v instanceof Date ? v.getTime() / 1000 : v;
const encoded = (v: unknown) => JSON.stringify(normalized(v));
const sameRows = (a: unknown[], b: unknown[]) => encoded(a.map(encoded).sort()) === encoded(b.map(encoded).sort());

/** seqNumberは日付一覧の座標。実metadata/操作時計はすべて入力fingerprintに含める。 */
export function informationEditMetadata(doc: EdinetDoc): string {
  return encoded(Object.fromEntries(Object.entries(edinetDocSchema.parse(doc)).filter(([k]) => k !== "seqNumber")));
}
export function isInformationEdit(doc: EdinetDoc): boolean {
  return doc.withdrawalStatus === "0" && doc.disclosureStatus === "0" && ["1", "2"].includes(String(doc.docInfoEditStatus)) &&
    doc.docTypeCode === "120" && doc.ordinanceCode === "010" && doc.parentDocID === null &&
    ["030000", "030001", "040000", "040001"].includes(String(doc.formCode));
}

/** readbackした集合そのものを同一batchでCAS。DELETE/UPDATEや別source取得はしない。 */
export function informationEditRowsGuard(db: Database, table: SQLiteTable, where: SQL, rows: readonly Record<string, unknown>[]) {
  const entries = Object.entries(getTableColumns(table));
  const columns = sql.join(entries.map(([, c]) => sql`${sql.identifier(c.name)}`), sql`, `);
  const expected = rows.map(row => Object.fromEntries(entries.map(([k, c]) => [c.name, rawValue(row[k])])));
  const values = sql.join(entries.map(([, c]) => sql`json_extract(value, ${`$.${c.name}`})`), sql`, `);
  return db.select({ unchanged: sql`json(case when (select count(*) from ${table} where ${where})=${rows.length}
    and not exists(select ${columns} from ${table} where ${where} except select ${values} from json_each(${JSON.stringify(expected)}))
    then 'null' else '' end)` }).from(sql`(select 1)`);
}

export async function readInformationEditState(db: Database, docID: string, stockId: number, stop: () => void) {
  stop(); const document = await db.select().from(yuhoDocuments).where(eq(yuhoDocuments.docId, docID)).limit(2);
  requireSame(document.length === 1, "同じ有報の取込行が一意に存在しません");
  const d = document[0];
  stop(); const stock = await db.select({ id: stocks.id, code: stocks.code }).from(stocks)
    .where(and(eq(stocks.id, stockId), disclosureIngestCondition())).limit(2);
  requireSame(stock.length === 1 && d.stockId === stockId, "同じ通常取込主体を確認できません");
  stop(); const orders = await db.select().from(orderFacts).where(eq(orderFacts.documentId, d.id)).orderBy(orderFacts.id).limit(1001);
  stop(); const overseas = await db.select().from(overseasSalesFacts).where(eq(overseasSalesFacts.documentId, d.id)).orderBy(overseasSalesFacts.id).limit(1001);
  stop(); const text = await db.select().from(textSections).where(eq(textSections.documentId, d.id)).orderBy(textSections.id).limit(101);
  requireSame(orders.length <= 1000 && overseas.length <= 1000 && text.length <= 100, "対象有報の有限読取上限です");
  return { stock, document, orders, overseas, text };
}
export type InformationEditState = Awaited<ReturnType<typeof readInformationEditState>>;
type State = InformationEditState;
type SavedZip = Awaited<ReturnType<typeof readSavedEdinetZip>>;

/** 共通parser/serializerの結果が、既存全facts/本文索引/原文と同じ場合だけ許可する。 */
export function verifyInformationEditData(state: State, rows: ReturnType<typeof parseEdinetCsvZip>, xbrl: SavedZip | undefined,
  body: Array<{ sectionKey: string; itemName: string; text: string }>) {
  const d = state.document[0], sections = extractTextSections(rows);
  const needOrder = rows.some(r => RX_ORDER_KEYWORD.test(r.itemName) || RX_ORDER_KEYWORD.test(r.value));
  const needOverseas = rows.some(r => RX_OVERSEAS_KEYWORD.test(r.itemName) || RX_OVERSEAS_KEYWORD.test(r.value));
  const requiredXbrl = () => { requireSame(xbrl !== undefined, "通常parserに必要な保存type1原本がありません"); return xbrl; };
  const order = needOrder ? parseOrderData(requiredXbrl().bytes, d.periodEnd) : { status: "no_order_table" as const, honbunFile: null, facts: [] };
  const overseas = needOverseas ? parseOverseasData(requiredXbrl().bytes, d.periodEnd)
    : { status: "no_overseas_table" as const, honbunFile: null, facts: [], proof: undefined, omission: undefined };
  validateOverseasSaveSet(overseas.facts, overseas.proof);
  const textStatus = sections.length > 0 ? "ok" : "no_text_sections";
  requireSame(d.parseStatus === order.status && d.honbunFile === order.honbunFile &&
    d.overseasParseStatus === overseas.status && d.overseasHonbunFile === overseas.honbunFile && d.textParseStatus === textStatus,
  "通常parserの既存status/抽出元と一致しません（自動置換なし）");
  const unique = new Map<string, typeof order.facts[number]>();
  for (const fact of order.facts) { const key = `${fact.fiscalYearEnd} ${fact.segmentName}`; if (!unique.has(key)) unique.set(key, fact); }
  const identity = { documentId: d.id, stockId: d.stockId };
  requireSame(sameRows(state.orders.map(({ id: _id, ...r }) => r), toOrderSaveRows([...unique.values()], order.status).map(r => ({ ...identity, ...r }))), "受注全factsが一致しません（自動置換なし）");
  requireSame(sameRows(state.overseas.map(({ id: _id, ...r }) => r), toOverseasSaveRows(overseas.facts, overseas.status).map(r => ({ ...identity, ...r }))), "海外全factsが一致しません（自動置換なし）");
  const omission = overseas.omission === undefined ? null : serializeOverseasOmission({ docId: d.docId, edinetCode: d.edinetCode,
    periodEnd: d.periodEnd, archivePageId: requiredXbrl().pageId, archiveManifest: requiredXbrl().originalManifest, zipSha256: requiredXbrl().sha256, omission: overseas.omission });
  requireSame(encoded(d.overseasOmissionJson === null ? null : JSON.parse(d.overseasOmissionJson)) === encoded(omission === null ? null : JSON.parse(omission)), "海外省略根拠が一致しません");
  requireSame(sameRows(state.text.map(({ id: _id, ...r }) => r), sections.map(s => ({ ...identity, fiscalYearEnd: d.periodEnd,
    sectionKey: s.sectionKey, elementId: s.elementId, itemName: s.itemName, contextId: s.contextId, charCount: s.charCount }))), "本文全索引が一致しません");
  requireSame(encoded(body) === encoded(sections.map(s => ({ sectionKey: s.sectionKey, itemName: s.itemName, text: s.text }))), "保存本文全節が一致しません");
}

async function originalList(db: Database, date: string, docID: string, prior: unknown, stop: () => void) {
  if (prior !== undefined) {
    const snapshot = listSnapshotSchema.parse(prior); requireSame(snapshot.date === date, "保存済み元日付根拠が不一致です");
    stop(); return { snapshot, list: await readListSnapshot(snapshot) };
  }
  stop(); const saved = await db.select({ snapshot: edinetCatchupProgress.snapshot }).from(edinetCatchupProgress)
    .where(and(eq(edinetCatchupProgress.scope, "main"), eq(edinetCatchupProgress.date, date))).limit(1);
  for (const row of saved) {
    if (row.snapshot === null) continue;
    const snapshot = listSnapshotSchema.parse(JSON.parse(row.snapshot));
    if (!snapshot.qualified || snapshot.date !== date) continue;
    stop(); const list = await readListSnapshot(snapshot);
    if (list.results.some(d => d.docID === docID && d.docInfoEditStatus === "2")) return { snapshot, list };
  }
  // 日付一覧の取得・物理保存だけ。他銘柄の観測INSERT/ingest/投影は呼ばない。
  stop();
  try { return await captureListSnapshot(date); }
  catch (error) {
    if (error instanceof EdinetListFetchError || error instanceof EdinetListQualificationError || error instanceof NotionUnknownResultError) throw error;
    throw new NotionUnknownResultError("元日付一覧の物理保管が未閉鎖です（再送なし）", { cause: error });
  }
}

/** 完了応答unknownはthrowしてcallerのinFlightを残す。既知資格不足だけpendingへ戻す。 */
export async function requalifyInformationEdit(db: Database, args: { doc: EdinetDoc; source: ListSnapshot;
  stockId: number; stockCode: string; shouldStop: () => boolean; d1HttpBatch?: ReturnType<typeof createD1HttpBatchSender> }): Promise<
  { status: "resolved"; observations: number; reused: boolean } | { status: "held"; reason: string }> {
  let sendStarted = false;
  const stop = () => { if (args.shouldStop()) throw new Error("EDINET情報修正の処理予算です（再送なし）"); };
  try {
    requireSame(isInformationEdit(args.doc), "取下げ/不開示/未対応の形式や親関係は自動解除しません");
    const source = listSnapshotSchema.parse(args.source);
    requireSame(source.qualified && source.httpStatus === 200, "情報修正の原一覧が未資格です");
    requireSame(secCodeToTicker(args.doc.secCode) === args.stockCode, "原一覧の明示証券コードが一致しません");
    const metadataJson = informationEditMetadata(args.doc), metadataSha256 = await sha256Hex(metadataJson);
    stop(); const found = await db.select({ ...getTableColumns(observations), unresolved: sql<number>`case when ${unresolvedReportedObservation()} then 1 else 0 end` })
      .from(observations).where(eq(observations.docId, args.doc.docID)).limit(51);
    requireSame(found.length > 0 && found.length <= 50, "対象文書の観測が不明または有限上限です");
    const held = found.filter(r => r.unresolved === 1);
    requireSame(found.some(r => r.sourcePageId === source.pageId.replaceAll("-", "").toLowerCase() &&
      r.seqNumber === args.doc.seqNumber && r.sourceRawSha256 === source.rawSha256), "対象観測の物理原本SHAが不一致です");
    if (held.length === 0) return { status: "resolved", observations: 0, reused: true };
    requireSame(args.doc.docInfoEditStatus === "1", "元日付の情報修正行は、修正イベントの完全照合が終わるまでHOLDです");
    for (const row of held) {
      const observed = JSON.parse(row.observationJson) as { doc: unknown; reportedIdentity?: { status: string; ticker: string; edinetCode: string; stockId: number; periodEnd: string } };
      const doc = edinetDocSchema.parse(observed.doc);
      requireSame(isInformationEdit(doc) && (doc.docInfoEditStatus === "2" || informationEditMetadata(doc) === metadataJson) && row.stockId === args.stockId &&
        row.periodEnd === args.doc.periodEnd && row.submittedAt !== null && args.doc.submitDateTime !== null &&
        row.submittedAt.getTime() === parseSubmitDateTime(args.doc.submitDateTime).getTime() &&
        observed.reportedIdentity?.status === "qualified_reported_metadata" && observed.reportedIdentity.stockId === args.stockId &&
        observed.reportedIdentity.periodEnd === args.doc.periodEnd && observed.reportedIdentity.ticker === args.stockCode &&
        observed.reportedIdentity.edinetCode === args.doc.edinetCode, "別状態/別主体/別情報修正の未解決観測があります");
    }
    const before = await readInformationEditState(db, args.doc.docID, args.stockId, stop), d = before.document[0];
    requireSame(before.stock[0].code === args.stockCode && d.edinetCode === args.doc.edinetCode && d.docTypeCode === "120" &&
      d.periodEnd === args.doc.periodEnd && d.periodStart === args.doc.periodStart && d.filerName === args.doc.filerName &&
      args.doc.submitDateTime !== null && d.submittedAt.getTime() === parseSubmitDateTime(args.doc.submitDateTime).getTime(), "取込済み主体/FY/業務metadataが変わるためHOLDです");
    requireSame(args.doc.edinetCode !== null && (await loadEdinetTickerMap(db, [args.doc.edinetCode])).get(args.doc.edinetCode) === args.stockCode,
      "現行issuer逆引きが一致しません");
    stop(); const previous = await db.select().from(resolutions).where(and(eq(resolutions.docId, d.docId), eq(resolutions.metadataSha256, metadataSha256))).limit(1);
    const prior = previous.length === 0 ? undefined : JSON.parse(previous[0].proofJson) as Record<string, unknown>;
    if (prior !== undefined) requireSame(prior.contract === "information-edit-identical-v1" && prior.metadataJson === metadataJson && encoded(prior.state) === encoded(before), "完了済み同入力の保存状態が変わっています");
    const original = await originalList(db, d.submittedAt.toISOString().slice(0, 10), d.docId, prior?.originalSnapshot, stop);
    const old = original.list.results.filter(row => row.docID === d.docId);
    requireSame(old.length === 1 && old[0].docInfoEditStatus === "2" && old[0].withdrawalStatus === "0" && old[0].disclosureStatus === "0", "元提出日の修正前metadata/現行開示資格を確認できません");
    for (const key of ["docID", "edinetCode", "secCode", "JCN", "filerName", "ordinanceCode", "formCode", "docTypeCode", "periodStart", "periodEnd", "submitDateTime", "parentDocID"] as const)
      requireSame(old[0][key] === args.doc[key], "修正前後の形式/主体/FY/業務metadataが異なるためHOLDです");
    // =2全体を解除しない。実際に全文照合した元snapshot/原行だけを同じ完了batchへ含める。
    for (const row of held) {
      const doc = edinetDocSchema.parse(JSON.parse(row.observationJson).doc);
      if (doc.docInfoEditStatus === "2") requireSame(row.sourcePageId === original.snapshot.pageId.replaceAll("-", "").toLowerCase() &&
        row.seqNumber === old[0].seqNumber && row.sourceRawSha256 === original.snapshot.rawSha256 && encoded(doc) === encoded(old[0]),
      "別snapshot/別原行の情報修正状態は未確認のためHOLDです");
    }
    stop(); const csv = await readSavedEdinetZip(d.docId, 5);
    const csvRows = prior === undefined ? parseEdinetCsvZip(csv.bytes) : undefined;
    if (prior !== undefined) requireSame(typeof prior.requiresXbrl === "boolean", "同入力のtype1必要判定が未保存です");
    const requiresXbrl = csvRows === undefined ? prior!.requiresXbrl === true : csvRows.some(r => RX_ORDER_KEYWORD.test(r.itemName) ||
      RX_ORDER_KEYWORD.test(r.value) || RX_OVERSEAS_KEYWORD.test(r.itemName) || RX_OVERSEAS_KEYWORD.test(r.value));
    stop(); const xbrl = requiresXbrl ? await readSavedEdinetZip(d.docId, 1) : undefined;
    const savedZips = xbrl === undefined ? [csv] : [csv, xbrl];
    for (const zip of savedZips) {
      const metadata = edinetArchiveNativeMetadata(zip.metadata);
      for (const [key, value] of Object.entries({ edinetCode: d.edinetCode, secCode: args.doc.secCode,
        filerName: d.filerName, docTypeCode: d.docTypeCode, periodStart: d.periodStart, periodEnd: d.periodEnd, submitDateTime: args.doc.submitDateTime }))
        requireSame(metadata[key] === value, "保存原本と業務metadataが一致しません");
    }
    requireSame(d.textParseStatus === "ok" && d.notionDocPageId !== null, "完成済み本文pointerがありません");
    stop(); const body = await readVerifiedDocText({ dbId: notionEnv.NOTION_YUHO_TEXT_DB_ID(), rowPageId: d.notionDocPageId, stockCode: args.stockCode,
      docId: d.docId, d1DocumentId: d.id, fiscalYearEnd: d.periodEnd, textParseStatus: "ok",
      sectionCount: before.text.length, charCount: before.text.reduce((n, s) => n + s.charCount, 0) });
    const zips = savedZips.map(z => ({ pageId: z.pageId, sha256: z.sha256, bytes: z.bytes.length, originalManifest: z.originalManifest }));
    const bodySha256 = await sha256Hex(encoded(body));
    if (prior === undefined) { requireSame(csvRows !== undefined, "CSV parserの入力がありません"); verifyInformationEditData(before, csvRows, xbrl, body); }
    else requireSame(encoded(prior.zips) === encoded(zips) && prior.bodySha256 === bodySha256, "完了済み同入力の原本/全文が変わっています");
    // 読取・parserの間にpointerやfacts/identityが変わっていないことを限定再読取で確認する。
    requireSame(encoded(await readInformationEditState(db, d.docId, args.stockId, stop)) === encoded(before), "再確認中に保存状態が変わっています");
    const proof = { contract: "information-edit-identical-v1", metadataJson, originalSnapshot: original.snapshot,
      state: before, requiresXbrl, zips, bodySha256 };
    const now = Math.floor(Date.now() / 1000), proofJson = JSON.stringify(normalized(proof));
    const rows = held.map(row => ({ sourcePageId: row.sourcePageId, seqNumber: row.seqNumber, sourceRawSha256: row.sourceRawSha256,
      observationJson: row.observationJson, docId: row.docId, metadataSha256, proofJson, resolvedAt: now }));
    const statements = [edinetTickerIdentityGuard(db, d.edinetCode, args.stockCode), informationEditRowsGuard(db, observations, eq(observations.docId, d.docId), found),
      db.select({ stockUnchanged: sql`json(case when exists(select 1 from ${stocks}
        where ${stocks.id}=${args.stockId} and ${stocks.code}=${args.stockCode} and ${disclosureIngestCondition()})
        then 'null' else '' end)` }).from(sql`(select 1)`),
      informationEditRowsGuard(db, yuhoDocuments, eq(yuhoDocuments.docId, d.docId), before.document),
      informationEditRowsGuard(db, orderFacts, eq(orderFacts.documentId, d.id), before.orders),
      informationEditRowsGuard(db, overseasSalesFacts, eq(overseasSalesFacts.documentId, d.id), before.overseas),
      informationEditRowsGuard(db, textSections, eq(textSections.documentId, d.id), before.text)];
    for (let i = 0; i < rows.length; i += 9) statements.push(db.insert(resolutions).values(rows.slice(i, i + 9)) as never);
    stop();
    if (args.d1HttpBatch !== undefined) { const batch = toD1BatchStatements(statements); sendStarted = true; await args.d1HttpBatch(batch); }
    else { const [first, ...rest] = statements; sendStarted = true; await db.batch([first, ...rest]); }
    stop(); const after = await db.select().from(resolutions).where(and(eq(resolutions.docId, d.docId), eq(resolutions.metadataSha256, metadataSha256)));
    for (const row of rows) if (!after.some(saved => encoded(saved) === encoded(row))) throw new Error("情報修正の完了応答/読戻しが不明です（再送なし）");
    return { status: "resolved", observations: rows.length, reused: prior !== undefined };
  } catch (error) {
    if (sendStarted || error instanceof NotionUnknownResultError) throw error;
    if (error instanceof InformationEditHold || error instanceof SavedEdinetZipQualificationError) return { status: "held", reason: error.message };
    if (error instanceof EdinetListFetchError || error instanceof EdinetListQualificationError) return { status: "held", reason: "元提出日一覧の取得/資格が未成立です" };
    return { status: "held", reason: "完了送信前の読取または処理予算が未成立です（次の通常処理で再確認）" };
  }
}
