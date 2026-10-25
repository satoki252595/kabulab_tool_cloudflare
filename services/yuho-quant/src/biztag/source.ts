/**
 * D1 の読み取り専用データソース (005 yuho-quant 事業タグ)。
 * 設計: docs/005-yuho-quant-business-tags.md §5.1・§0 (「D1 には何も書かない」)。
 *
 * 母集団は `activeEquityCondition()` (上場中の内国普通株)。`core_stocks` から
 * select する列は code/name/sector33 の 3 つだけ (`market`/`sector`/
 * `instrument_type` は personal-only。`core-stocks-license-boundary.test.ts` が
 * 固定する境界)。
 *
 * 銘柄ごとの最新有報は `doc_type_code IN ('120','130')` の中で
 * `period_end DESC, submitted_at DESC` の先頭 (訂正有報 130 も対象)。
 * D1 の bind 変数上限 (1クエリ100。memory: D1 bound param limit) を超えないよう、
 * 母集団の id はサブクエリのまま `inArray` に渡す (JS 配列に材料化しない)。
 *
 * `yuho_text_sections` (索引テーブル。80万行規模) には一切触れない
 * (rows_read を抑える)。
 */
import assert from "node:assert/strict";
import { notionEnv } from "../../../../src/shared/notion-archive/env.js";
import { notionRequest } from "../../../../src/shared/notion-archive/client.js";
import { readVerifiedDocText } from "../services/text-backup.js";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { activeEquityCondition } from "../../../../src/shared/db/active-equity.js";
import { stocks } from "../../../../src/shared/db/core-schema.js";
import { listingOfficialEvents, universeOverlayState } from "../../../../src/shared/db/universe-events.js";
import { parseStockCode } from "../../../../src/shared/jpx/stock-code.js";
import { yuhoDocuments } from "../db/schema.js";
import { reportedLatestSelectionHold, REPORTED_DOCUMENT_HOLD_REASON } from "../services/edinet/reported-changes.js";
import { assertBiztagDate } from "../env.js";
import { todayJst } from "./date-jst.js";
import { normalizeSupplementText, type SupplementRow } from "../../../../src/shared/notion-archive/stock-supplement.js";
import { sha256Hex } from "../../../../src/shared/sha256.js";
import { readSavedEdinetZip } from "../services/edinet/archive.js";
import { edinetArchiveNativeMetadata } from "../services/edinet/archive-metadata.js";
import { parseEdinetCsvZip } from "../services/edinet/csv.js";
import { extractTextSections, TEXT_SECTIONS } from "../services/edinet/text-sections.js";
import { parseSubmitDateTime, secCodeToTicker } from "../services/edinet/types.js";
import { displayName, hasUsableText, rowTextSyncReceipt } from "./plan.js";

export interface LatestDoc {
  stockCode: string;
  companyName: string;
  sector33: string | null;
  /** 最新候補を先に固定してから保留する。旧有報へ戻さない。 */
  reportedHoldReason?: string;
  doc: null | {
    docId: string;
    docTypeCode: "120" | "130";
    /** YYYY-MM-DD */
    periodEnd: string;
    /** ISO 8601 */
    submittedAt: string;
    notionDocPageId: string | null;
    textParseStatus: string | null;
  };
}

/**
 * `core_stocks` / `yuho_documents` にアクセスできれば足りる最小の drizzle db 型。
 * Worker バインディング版 (DrizzleD1Database) と Node の D1 HTTP 版
 * (sqlite-proxy / `createD1HttpDb`) のどちらも渡せる
 * (`src/shared/db/active-equity.ts` の `CoreDb` と同じ形)。
 */
export type BiztagSourceDb = BaseSQLiteDatabase<"async", unknown, Record<string, unknown>>;

export interface NewStockEligibility {
  eligibleCodes: ReadonlySet<string>;
  heldCodes: ReadonlySet<string>;
}

function assertTimestamp(value: string, label: string): void {
  if (typeof value !== "string") throw new Error(`loadNewStockEligibility: ${label} が不正です`);
  assertBiztagDate(value.slice(0, 10), label);
  if (
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`loadNewStockEligibility: ${label} が不正です`);
  }
}

/**
 * 新規上場資格だけを既存台帳の 2 SELECT で読む。core の現役普通株との交差は
 * loadLatestDocs / planWork が行う。行の欠落・過去未判定は新規の根拠にしない。
 * 不完全な世代は停止、開始日以後の取り消し/未来/保留イベントは per-code HOLD。
 */
export async function loadNewStockEligibility(
  db: BiztagSourceDb,
  from: string,
  today: string
): Promise<NewStockEligibility> {
  assertBiztagDate(from, "BIZTAG_NEW_LISTING_FROM");
  assertBiztagDate(today, "loadNewStockEligibility today");
  const states = await db.select({
    baseAsOf: universeOverlayState.baseAsOf,
    eventsFetchedAt: universeOverlayState.eventsFetchedAt,
    eventsSha: universeOverlayState.eventsSha,
    eligibilityAsOf: universeOverlayState.eligibilityAsOf,
    appliedAt: universeOverlayState.appliedAt,
    heldListingCodes: universeOverlayState.heldListingCodes,
  }).from(universeOverlayState).where(eq(universeOverlayState.id, 1));
  const state = states[0];
  if (
    states.length !== 1 || state === undefined || state.baseAsOf === null ||
    state.eventsFetchedAt === null || state.eventsSha === null ||
    state.eligibilityAsOf === null || state.appliedAt === null ||
    !/^[a-f0-9]{64}$/.test(state.eventsSha)
  ) {
    throw new Error("loadNewStockEligibility: 母集団の世代証拠が不完全です。判定停止");
  }
  assertBiztagDate(state.baseAsOf, "baseAsOf");
  assertBiztagDate(state.eligibilityAsOf, "eligibilityAsOf");
  assertTimestamp(state.eventsFetchedAt, "eventsFetchedAt");
  assertTimestamp(state.appliedAt, "appliedAt");
  const appliedAtMs = Date.parse(state.appliedAt);
  if (state.baseAsOf > state.eligibilityAsOf || state.eligibilityAsOf > today ||
      appliedAtMs < Date.parse(state.eventsFetchedAt) ||
      todayJst(() => appliedAtMs) > today) {
    throw new Error("loadNewStockEligibility: 母集団の世代日付が矛盾しています。判定停止");
  }
  const heldCodes = new Set<string>();
  if (state.heldListingCodes !== null && state.heldListingCodes !== "") {
    const held: unknown = JSON.parse(state.heldListingCodes);
    if (!Array.isArray(held) || !held.every((code): code is string =>
      typeof code === "string" && parseStockCode(code) === code) || new Set(held).size !== held.length) {
      throw new Error("loadNewStockEligibility: IPO HOLD の形が不明です。判定停止");
    }
    for (const code of held) heldCodes.add(code);
  }
  const events = await db.select({
    code: listingOfficialEvents.code,
    effectiveDate: listingOfficialEvents.effectiveDate,
    fetchedAt: listingOfficialEvents.fetchedAt,
    rawSha: listingOfficialEvents.rawSha,
    archiveKey: listingOfficialEvents.archiveKey,
    lastSeenFetchedAt: listingOfficialEvents.lastSeenFetchedAt,
  }).from(listingOfficialEvents).where(eq(listingOfficialEvents.kind, "listing"));
  const eligibleCodes = new Set<string>();
  const seen = new Set<string>();
  for (const event of events) {
    assertBiztagDate(event.effectiveDate, "listing effectiveDate");
    if (event.effectiveDate < from) continue;
    if (typeof event.code !== "string" || parseStockCode(event.code) !== event.code) {
      throw new Error("loadNewStockEligibility: 上場銘柄コードが不正です。判定停止");
    }
    assertTimestamp(event.fetchedAt, "listing fetchedAt");
    if (event.lastSeenFetchedAt !== null) assertTimestamp(event.lastSeenFetchedAt, "listing lastSeenFetchedAt");
    if (
      seen.has(event.code) || event.effectiveDate > state.eligibilityAsOf ||
      event.lastSeenFetchedAt !== state.eventsFetchedAt ||
      event.fetchedAt !== state.eventsFetchedAt ||
      !/^[a-f0-9]{64}$/.test(event.rawSha) ||
      event.archiveKey !== `universe-official-events-${state.baseAsOf}-${state.eligibilityAsOf}-sha-${state.eventsSha.slice(0, 12)}`
    ) {
      heldCodes.add(event.code);
    }
    seen.add(event.code);
    if (!heldCodes.has(event.code)) eligibleCodes.add(event.code);
  }
  for (const code of heldCodes) eligibleCodes.delete(code);
  return { eligibleCodes, heldCodes };
}

const DOC_TYPE_CODES = ["120", "130"] as const;

function assertDocTypeCode(v: string, docId: string): "120" | "130" {
  if (v === "120" || v === "130") return v;
  throw new Error(`loadLatestDocs: 想定外の書類種別コードです (docId=${docId}): ${v}`);
}

interface DocRow {
  id: number;
  stockId: number;
  docId: string;
  docTypeCode: string;
  periodEnd: string;
  submittedAt: Date;
  notionDocPageId: string | null;
  textParseStatus: string | null;
  reportedHold: number;
}

function isLater(a: DocRow, b: DocRow): boolean {
  if (a.periodEnd !== b.periodEnd) return a.periodEnd > b.periodEnd;
  if (a.submittedAt.getTime() !== b.submittedAt.getTime()) return a.submittedAt.getTime() > b.submittedAt.getTime();
  return a.id > b.id;
}

/**
 * 母集団 (上場中の内国普通株) の銘柄ごとに、最新の有報/訂正有報 1 通を返す。
 * 有報が 1 通も無い銘柄は `doc: null` (古い書類には戻らない。設計 §5.1)。
 */
export async function loadLatestDocs(db: BiztagSourceDb, codes?: readonly string[]): Promise<LatestDoc[]> {
  if (codes !== undefined && (!Array.isArray(codes) || [...codes].some(code => typeof code !== "string" || parseStockCode(code) !== code))) {
    throw new Error("loadLatestDocs: 銘柄scopeは正準証券コードの配列で指定してください");
  }
  if (codes?.length === 0) return [];
  // One JSON bind keeps an explicit scope below D1's 100-bind limit, including more than 100 codes.
  const active = codes === undefined ? activeEquityCondition() : and(activeEquityCondition(),
    inArray(stocks.code, sql`(select value from json_each(${JSON.stringify([...new Set(codes)])}))`));
  const stockRows = await db
    .select({ id: stocks.id, code: stocks.code, name: stocks.name, sector33: stocks.sector33 })
    .from(stocks)
    .where(active);

  // 母集団の id をサブクエリのまま渡す (JS 配列の inArray は銘柄数ぶんの bind を
  // 作り D1 の 1 クエリ 100 bind 上限を超える)。
  const activeStockIds = db.select({ id: stocks.id }).from(stocks).where(active);

  const docRows = (await db
    .select({
      id: yuhoDocuments.id,
      stockId: yuhoDocuments.stockId,
      docId: yuhoDocuments.docId,
      docTypeCode: yuhoDocuments.docTypeCode,
      periodEnd: yuhoDocuments.periodEnd,
      submittedAt: yuhoDocuments.submittedAt,
      notionDocPageId: yuhoDocuments.notionDocPageId,
      textParseStatus: yuhoDocuments.textParseStatus,
      reportedHold: reportedLatestSelectionHold(yuhoDocuments.docId,yuhoDocuments.stockId,yuhoDocuments.periodEnd,yuhoDocuments.submittedAt).as("reported_hold"),
    })
    .from(yuhoDocuments)
    .where(
      and(
        inArray(yuhoDocuments.docTypeCode, DOC_TYPE_CODES),
        inArray(yuhoDocuments.stockId, activeStockIds)
      )
    )) as DocRow[];

  const latestByStockId = new Map<number, DocRow>();
  for (const row of docRows) {
    const current = latestByStockId.get(row.stockId);
    if (!current || isLater(row, current)) {
      latestByStockId.set(row.stockId, row);
    }
  }

  return stockRows.map((s) => {
    const doc = latestByStockId.get(s.id);
    return {
      stockCode: s.code,
      companyName: s.name,
      sector33: s.sector33,
      ...(doc?.reportedHold === 1 ? { reportedHoldReason: REPORTED_DOCUMENT_HOLD_REASON } : {}),
      doc: doc
        ? {
            docId: doc.docId,
            docTypeCode: assertDocTypeCode(doc.docTypeCode, doc.docId),
            periodEnd: doc.periodEnd,
            submittedAt: doc.submittedAt.toISOString(),
            notionDocPageId: doc.notionDocPageId,
            textParseStatus: doc.textParseStatus,
          }
        : null,
    };
  });
}


/** 書込直前の1社だけを再照会する。旧doc/旧pointerへ戻らず、差異はHOLD。 */
export async function assertLatestDocCurrent(
  db: BiztagSourceDb,
  stockCode: string,
  expected: LatestDoc["doc"],
  expectedStock?: Pick<LatestDoc, "companyName" | "sector33">
): Promise<void> {
  if (expected === null || expectedStock !== undefined) {
    if (expectedStock === undefined) throw new Error("本文なし基本メタの現active資格がありません");
    const selected = await loadLatestDocs(db, [stockCode]), current = selected[0];
    if (selected.length !== 1 || current.stockCode !== stockCode || current.companyName !== expectedStock.companyName ||
        current.sector33 !== expectedStock.sector33 || current.reportedHoldReason !== undefined ||
        JSON.stringify(current.doc) !== JSON.stringify(expected)) {
      throw new Error(`書込直前に現activeの基本メタ/最新有報が変更 (${stockCode})。旧値と本文HOLDを保持`);
    }
    return;
  }
  const rows = await db.select({
    docId: yuhoDocuments.docId, docTypeCode: yuhoDocuments.docTypeCode,
    periodEnd: yuhoDocuments.periodEnd, submittedAt: yuhoDocuments.submittedAt,
    notionDocPageId: yuhoDocuments.notionDocPageId, textParseStatus: yuhoDocuments.textParseStatus,
    reportedHold: reportedLatestSelectionHold(yuhoDocuments.docId,yuhoDocuments.stockId,yuhoDocuments.periodEnd,yuhoDocuments.submittedAt).as("reported_hold"),
  }).from(yuhoDocuments).innerJoin(stocks, eq(yuhoDocuments.stockId, stocks.id)).where(and(
    activeEquityCondition(), eq(stocks.code, stockCode), inArray(yuhoDocuments.docTypeCode, DOC_TYPE_CODES)
  )).orderBy(desc(yuhoDocuments.periodEnd), desc(yuhoDocuments.submittedAt), desc(yuhoDocuments.id)).limit(1);
  const actual = rows[0];
  if (actual?.reportedHold === 1) throw new Error(REPORTED_DOCUMENT_HOLD_REASON);
  if (rows.length !== 1 || actual.docId !== expected.docId || actual.docTypeCode !== expected.docTypeCode ||
      actual.periodEnd !== expected.periodEnd || actual.submittedAt.toISOString() !== expected.submittedAt ||
      actual.notionDocPageId !== expected.notionDocPageId || actual.textParseStatus !== expected.textParseStatus) {
    throw new Error(`書込直前に最新有報・本文pointerが変更/欠測 (${stockCode})。旧値を保持してHOLD`);
  }
}

/** 未資格本文は失敗状態の書込へ進めず、原文/旧タグを保持する。 */
export class BiztagTextQualificationError extends Error {
  constructor(cause?: unknown) {
    super("保存本文の所属/7メタを資格確認できません。旧値を保持してHOLD", { cause });
    this.name = "BiztagTextQualificationError";
  }
}

const companyDocumentColumns = { id: yuhoDocuments.id, stockId: yuhoDocuments.stockId, edinetCode: yuhoDocuments.edinetCode,
  filerName: yuhoDocuments.filerName, docId: yuhoDocuments.docId, docTypeCode: yuhoDocuments.docTypeCode, periodStart: yuhoDocuments.periodStart,
  periodEnd: yuhoDocuments.periodEnd, submittedAt: yuhoDocuments.submittedAt, notionDocPageId: yuhoDocuments.notionDocPageId, textParseStatus: yuhoDocuments.textParseStatus };
type CompanyDocument = Pick<typeof yuhoDocuments.$inferSelect, keyof typeof companyDocumentColumns>;

/** 本文監査と商号refreshが共有する、type5物理読取後のnative全項目照合。 */
export function qualifyBiztagArchiveIdentity(latest: LatestDoc, document: CompanyDocument,
  source: Pick<Awaited<ReturnType<typeof readSavedEdinetZip>>, "metadata">) {
  assert(hasUsableText(latest.doc) && latest.reportedHoldReason === undefined, "latest_body_unqualified");
  const metadata = edinetArchiveNativeMetadata(source.metadata);
  assert(document.docId === latest.doc.docId && document.periodEnd === latest.doc.periodEnd && document.docTypeCode === latest.doc.docTypeCode &&
    document.notionDocPageId === latest.doc.notionDocPageId && document.textParseStatus === "ok" && document.submittedAt.toISOString() === latest.doc.submittedAt, "document_changed");
  assert(metadata.docID === document.docId && metadata.edinetDocType === 5 && metadata.edinetCode === document.edinetCode &&
    typeof metadata.secCode === "string" && secCodeToTicker(metadata.secCode) === latest.stockCode && metadata.periodEnd === document.periodEnd &&
    metadata.periodStart === document.periodStart && metadata.docTypeCode === document.docTypeCode && metadata.filerName === document.filerName &&
    typeof metadata.submitDateTime === "string" && parseSubmitDateTime(metadata.submitDateTime).getTime() === document.submittedAt.getTime(), "source_identity_incomplete_or_mismatch");
}
export function qualifyBiztagArchiveSource(latest: LatestDoc, document: CompanyDocument,
  source: Awaited<ReturnType<typeof readSavedEdinetZip>>) {
  qualifyBiztagArchiveIdentity(latest, document, source);
  const rows = parseEdinetCsvZip(source.bytes), sections = extractTextSections(rows);
  assert(sections.length > 0, "source_39_empty"); return { rows, sections };
}

/** 商号差の候補だけ旧新docを索引読取。同一tickerだけで別issuer/旧本文を採用しない。 */
export async function readQualifiedCompanyNameRefresh(db: BiztagSourceDb, latest: LatestDoc, row: SupplementRow,
  masterPageId: string | null) {
  try {
    const id = (value: string) => { assert(/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value)); return value.replaceAll("-", "").toLowerCase(); };
    assert(latest.doc !== null && latest.reportedHoldReason === undefined && row.stockCode === latest.stockCode &&
      row.companyName.trim() !== "" && latest.companyName.trim() !== "" && row.docId !== null && /^S[0-9A-Z]{7}$/.test(row.docId));
    assert(masterPageId !== null && row.masterPageIds?.length === 1 && id(row.masterPageIds[0]) === id(masterPageId));
    const master = await notionRequest<{ object: string; id: string; archived: boolean; in_trash: boolean;
      parent: { type: string; database_id: string }; properties: Record<string, { type: string; has_more?: boolean;
        rich_text?: Array<{ type: string; plain_text: string; text: { content: string } }>;
        title?: Array<{ type: string; plain_text: string; text: { content: string } }> }> }>("GET", `/pages/${masterPageId}`);
    assert(master.object === "page" && id(master.id) === id(masterPageId) && master.archived === false && master.in_trash === false &&
      master.parent.type === "database_id" && id(master.parent.database_id) === id(notionEnv.NOTION_DB_STOCK_MASTER()));
    const codeProperty = master.properties["銘柄コード"], codeParts = codeProperty?.type === "rich_text" ? codeProperty.rich_text : codeProperty?.type === "title" ? codeProperty.title : undefined;
    assert(codeProperty?.has_more !== true && Array.isArray(codeParts) && codeParts.every(part => part.type === "text" && part.plain_text === part.text?.content) &&
      codeParts.map(part => part.plain_text).join("") === latest.stockCode);
    const receipt = rowTextSyncReceipt(row);
    assert(receipt !== null && receipt.docId === row.docId);
    const ids = [...new Set([row.docId, latest.doc.docId])];
    const records = await db.select({ document: companyDocumentColumns, companyName: stocks.name, sector33: stocks.sector33,
      reportedHold: reportedLatestSelectionHold(yuhoDocuments.docId,yuhoDocuments.stockId,yuhoDocuments.periodEnd,yuhoDocuments.submittedAt).as("reported_hold") })
      .from(yuhoDocuments).innerJoin(stocks, eq(yuhoDocuments.stockId, stocks.id))
      .where(and(activeEquityCondition(), eq(stocks.code, latest.stockCode), inArray(yuhoDocuments.docId, ids))).limit(3);
    assert(records.length === ids.length && new Set(records.map(value => value.document.docId)).size === ids.length);
    const current = records.find(value => value.document.docId === latest.doc!.docId)!, old = records.find(value => value.document.docId === row.docId)!;
    assert(current && old && records.every(value => value.reportedHold === 0 && value.companyName === latest.companyName && value.sector33 === latest.sector33));
    assert(current.document.stockId === old.document.stockId && current.document.edinetCode === old.document.edinetCode &&
      /^E\d{5}$/.test(old.document.edinetCode) && displayName(row.companyName) === displayName(old.document.filerName));
    assert(row.docType === (old.document.docTypeCode === "120" ? "有報" : "訂正有報") && row.periodEnd === old.document.periodEnd &&
      row.submittedAt !== null && Date.parse(row.submittedAt) === old.document.submittedAt.getTime() && row.sector33 === latest.sector33 &&
      receipt.textPageId === old.document.notionDocPageId);
    const verified = new Map<string, Awaited<ReturnType<typeof readVerifiedDocText>>>();
    for (const record of records) {
      const document = record.document;
      assert(document.docTypeCode === "120" || document.docTypeCode === "130");
      const saved = await readSavedEdinetZip(document.docId, 5); assert(saved.originalManifest === "known");
      const selected: LatestDoc = { ...latest, doc: { docId: document.docId, docTypeCode: document.docTypeCode, periodEnd: document.periodEnd,
        submittedAt: document.submittedAt.toISOString(), notionDocPageId: document.notionDocPageId, textParseStatus: document.textParseStatus } };
      const source = qualifyBiztagArchiveSource(selected, document, saved);
      const body = await readVerifiedDocText({ dbId: notionEnv.NOTION_YUHO_TEXT_DB_ID(), rowPageId: document.notionDocPageId!,
        stockCode: latest.stockCode, docId: document.docId, d1DocumentId: document.id, fiscalYearEnd: document.periodEnd, textParseStatus: "ok",
        sectionCount: source.sections.length, charCount: source.sections.reduce((n, section) => n + [...section.text].length, 0) });
      assert(JSON.stringify(body.map(section => [section.sectionKey, section.itemName, section.text])) ===
        JSON.stringify(source.sections.map(section => [section.sectionKey, section.itemName, section.text]))); verified.set(document.docId, body);
    }
    const sections = verified.get(row.docId)!;
    const rawTexts = Object.fromEntries(TEXT_SECTIONS.map(section => [section.title, null as string | null]));
    const seen = new Set<string>();
    for (const section of sections) {
      const definition = TEXT_SECTIONS.find(value => value.key === section.sectionKey);
      assert(definition && !seen.has(section.sectionKey)); seen.add(section.sectionKey); rawTexts[definition.title] = section.text;
    }
    const normalized = (value: string | null) => normalizeSupplementText(value) || null;
    assert(TEXT_SECTIONS.every(({ title }) => typeof row.texts[title] === "string" && normalized(row.texts[title]) === normalized(rawTexts[title])));
    assert(receipt.textsSha256 === await sha256Hex(JSON.stringify(TEXT_SECTIONS.map(({ title }) => [title, rawTexts[title]]))));
    if (receipt.notionTextsSha256 !== undefined) assert(receipt.notionTextsSha256 === await sha256Hex(JSON.stringify(TEXT_SECTIONS.map(({ title }) => [title, normalized(rawTexts[title])]))));
    await assertLatestDocCurrent(db, latest.stockCode, latest.doc, { companyName: latest.companyName, sector33: latest.sector33 });
    return verified.get(latest.doc.docId)!;
  } catch (cause) { throw new BiztagTextQualificationError(cause); }
}

/** 選択済みの1docだけを索引で読み、D1主体とNotion所属/全7メタを同時に資格化する。 */
export async function readQualifiedBiztagDocText(db: BiztagSourceDb, stockCode: string,
  expected: NonNullable<LatestDoc["doc"]>) {
  try {
    assert(parseStockCode(stockCode) === stockCode && expected.notionDocPageId !== null && expected.textParseStatus === "ok");
    const rows = await db.select({ id: yuhoDocuments.id, docId: yuhoDocuments.docId, docTypeCode: yuhoDocuments.docTypeCode,
      periodEnd: yuhoDocuments.periodEnd, submittedAt: yuhoDocuments.submittedAt,
      notionDocPageId: yuhoDocuments.notionDocPageId, textParseStatus: yuhoDocuments.textParseStatus,
      reportedHold: reportedLatestSelectionHold(yuhoDocuments.docId,yuhoDocuments.stockId,yuhoDocuments.periodEnd,yuhoDocuments.submittedAt).as("reported_hold"),
    }).from(yuhoDocuments).innerJoin(stocks, eq(yuhoDocuments.stockId, stocks.id))
      .where(and(activeEquityCondition(), eq(stocks.code, stockCode), eq(yuhoDocuments.docId, expected.docId))).limit(2);
    const d = rows[0];
    assert(rows.length === 1 && Number.isSafeInteger(d.id) && d.id > 0 && d.reportedHold === 0 &&
      d.docId === expected.docId && d.docTypeCode === expected.docTypeCode && d.periodEnd === expected.periodEnd &&
      d.submittedAt.toISOString() === expected.submittedAt && d.notionDocPageId === expected.notionDocPageId && d.textParseStatus === "ok");
    const sections = await readVerifiedDocText({ dbId: notionEnv.NOTION_YUHO_TEXT_DB_ID(), rowPageId: expected.notionDocPageId,
      stockCode, docId: d.docId, d1DocumentId: d.id, fiscalYearEnd: d.periodEnd, textParseStatus: "ok", deriveCountsFromBody: true });
    assert(sections.length > 0, "資格本文が空です"); return sections;
  } catch (cause) { throw new BiztagTextQualificationError(cause); }
}
