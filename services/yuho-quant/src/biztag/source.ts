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
import { and, eq, inArray } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { activeEquityCondition } from "../../../../src/shared/db/active-equity.js";
import { stocks } from "../../../../src/shared/db/core-schema.js";
import { listingOfficialEvents, universeOverlayState } from "../../../../src/shared/db/universe-events.js";
import { parseStockCode } from "../../../../src/shared/jpx/stock-code.js";
import { yuhoDocuments } from "../db/schema.js";
import { assertBiztagDate } from "../env.js";
import { todayJst } from "./date-jst.js";

export interface LatestDoc {
  stockCode: string;
  companyName: string;
  sector33: string | null;
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
  stockId: number;
  docId: string;
  docTypeCode: string;
  periodEnd: string;
  submittedAt: Date;
  notionDocPageId: string | null;
  textParseStatus: string | null;
}

function isLater(a: DocRow, b: DocRow): boolean {
  if (a.periodEnd !== b.periodEnd) return a.periodEnd > b.periodEnd;
  return a.submittedAt.getTime() > b.submittedAt.getTime();
}

/**
 * 母集団 (上場中の内国普通株) の銘柄ごとに、最新の有報/訂正有報 1 通を返す。
 * 有報が 1 通も無い銘柄は `doc: null` (古い書類には戻らない。設計 §5.1)。
 */
export async function loadLatestDocs(db: BiztagSourceDb): Promise<LatestDoc[]> {
  const stockRows = await db
    .select({ id: stocks.id, code: stocks.code, name: stocks.name, sector33: stocks.sector33 })
    .from(stocks)
    .where(activeEquityCondition());

  // 母集団の id をサブクエリのまま渡す (JS 配列の inArray は銘柄数ぶんの bind を
  // 作り D1 の 1 クエリ 100 bind 上限を超える)。
  const activeStockIds = db.select({ id: stocks.id }).from(stocks).where(activeEquityCondition());

  const docRows = (await db
    .select({
      stockId: yuhoDocuments.stockId,
      docId: yuhoDocuments.docId,
      docTypeCode: yuhoDocuments.docTypeCode,
      periodEnd: yuhoDocuments.periodEnd,
      submittedAt: yuhoDocuments.submittedAt,
      notionDocPageId: yuhoDocuments.notionDocPageId,
      textParseStatus: yuhoDocuments.textParseStatus,
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
