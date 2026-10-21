/** 原一覧の報告状態を保持する。親関係だけから金融値を継承/失効しない。 */
import { and, eq, inArray, sql, type SQL, type AnyColumn } from "drizzle-orm";
import { SQLiteSyncDialect, type BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { edinetReportedChanges as table, edinetReportedResolutions as resolutions } from "../../db/schema.js";
import { listSnapshotSchema, type ListSnapshot } from "./list-snapshot.js";
import { hasAnnualSecuritiesReportForm, isAnnualSecuritiesReport, parseSubmitDateTime, secCodeToTicker, type EdinetDoc, type EdinetListResponse } from "./types.js";
import { loadEdinetTickerMap } from "./identity.js";
import { stocks } from "../../../../../src/shared/db/core-schema.js";
import { disclosureIngestCondition } from "../../../../../src/shared/db/active-equity.js";

export type ReportedSourceDb = BaseSQLiteDatabase<"async", unknown, Record<string, unknown>>;
type State = "reported_withdrawal" | "reported_status_unqualified" | "unqualified_relation";
export const REPORTED_DOCUMENT_HOLD_REASON = "金融庁の提出書類一覧で取下げや状態変更を確認したため、確認が終わるまで表示・計算を保留しています。";

/** legalStatus/操作時計を法的効力日や金融値の資格へ読み替えない。 */
export function reportedDocumentMetadata(doc: EdinetDoc) {
  return {
    withdrawalStatus: doc.withdrawalStatus,
    ...(doc.docInfoEditStatus === undefined ? {} : { docInfoEditStatus: doc.docInfoEditStatus }),
    ...(doc.disclosureStatus === undefined ? {} : { disclosureStatus: doc.disclosureStatus }),
    ...(doc.parentDocID === undefined ? {} : { parentDocID: doc.parentDocID }),
    ...(doc.opeDateTime === undefined ? {} : { opeDateTime: doc.opeDateTime }),
    ...(doc.legalStatus === undefined ? {} : { legalStatus: doc.legalStatus }),
    chainQualification: "unqualified" as const,
    chainApplication: "not_applied" as const,
  };
}

function reportedState(doc: EdinetDoc): State | null {
  if (doc.withdrawalStatus === "1") return "reported_withdrawal";
  if (doc.withdrawalStatus !== "0" ||
      (doc.docInfoEditStatus !== undefined && doc.docInfoEditStatus !== "0") ||
      (doc.disclosureStatus !== undefined && doc.disclosureStatus !== "0")) return "reported_status_unqualified";
  if (isAnnualSecuritiesReport(doc) && (doc.docTypeCode === "130" ||
      (doc.parentDocID !== undefined && doc.parentDocID !== null))) return "unqualified_relation";
  return null;
}

export function reportedStandaloneHold(doc: EdinetDoc): boolean {
  const state = reportedState(doc);
  return state !== null && state !== "unqualified_relation";
}

/** 原観測と完全一致した完了行だけを除く。取下げ/不開示は解決行で解除しない。 */
export function unresolvedReportedObservation(alias: SQL = sql`${table}`): SQL {
  return sql`${alias}.reported_state <> 'unqualified_relation' and not (case when
    ${alias}.reported_state = 'reported_status_unqualified'
    and json_extract(${alias}.observation_json,'$.doc.withdrawalStatus') = '0'
    and json_extract(${alias}.observation_json,'$.doc.disclosureStatus') = '0'
    and json_extract(${alias}.observation_json,'$.doc.docInfoEditStatus') in ('1','2')
    then exists(select 1 from ${resolutions} r where r.source_page_id=${alias}.source_page_id
      and r.seq_number=${alias}.seq_number and r.source_raw_sha256=${alias}.source_raw_sha256
      and r.doc_id=${alias}.doc_id and r.observation_json=${alias}.observation_json) else 0 end)`;
}

type QualifiedProjection = { stockId: number; periodEnd: string; submittedAt: Date; ticker: string; edinetCode: string };

/** 完全な原報告だけを候補にする。NULL/親ID/原文タイトルから資格を補作しない。 */
function projectionCandidate(doc: EdinetDoc): { ticker: string; periodEnd: string; submittedAt: Date; edinetCode: string } | null {
  if (!reportedStandaloneHold(doc) || !hasAnnualSecuritiesReportForm(doc) || doc.edinetCode === null ||
      !/^E\d{5}$/.test(doc.edinetCode) || doc.filerName === null || !doc.filerName.trim() ||
      doc.periodEnd === null || !/^\d{4}-\d{2}-\d{2}$/.test(doc.periodEnd) ||
      doc.submitDateTime === null || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(doc.submitDateTime)) return null;
  const period = new Date(`${doc.periodEnd}T00:00:00Z`), submittedAt = parseSubmitDateTime(doc.submitDateTime);
  if (!Number.isFinite(period.getTime()) || period.toISOString().slice(0, 10) !== doc.periodEnd ||
      submittedAt.toISOString().slice(0, 16) !== doc.submitDateTime.replace(" ", "T") || doc.periodEnd>doc.submitDateTime.slice(0,10)) return null;
  const ticker = secCodeToTicker(doc.secCode);
  if (ticker === null) return null;
  return { ticker, periodEnd: doc.periodEnd, submittedAt, edinetCode: doc.edinetCode };
}

/** 既存issuer逆引きとnormal ingest母集団の両方が一意・一致した候補だけ。追加Notion/sourceは0。 */
async function qualifyReportedProjections(db: ReportedSourceDb, list: EdinetListResponse, shouldStop: () => boolean) {
  const candidates = list.results.flatMap(doc => { const p = projectionCandidate(doc); return p === null ? [] : [{ doc, ...p }]; });
  const qualified = new Map<number, QualifiedProjection>();
  if (candidates.length === 0) return qualified;
  const issuers=[...new Set(candidates.map(c=>c.edinetCode))], issuerMap=new Map<string,string>();
  for (let i=0;i<issuers.length;i+=90) {
    if (shouldStop()) throw new Error("EDINET報告主体の照合予算を超過しました");
    for (const [issuer,ticker] of await loadEdinetTickerMap(db,issuers.slice(i,i+90))) issuerMap.set(issuer,ticker);
  }
  const codes = [...new Set(candidates.map(c => c.ticker))], found = new Map<string, {id:number}>();
  for (let i=0; i<codes.length; i+=90) {
    if (shouldStop()) throw new Error("EDINET報告主体の照合予算を超過しました");
    const batch=codes.slice(i,i+90), rows=await db.select({id:stocks.id,code:stocks.code}).from(stocks)
      .where(and(disclosureIngestCondition(),inArray(stocks.code,batch)));
    for (const row of rows) {
      if (!batch.includes(row.code) || found.has(row.code) || !Number.isSafeInteger(row.id) || row.id<=0) {
        throw new Error("EDINET報告主体の通常マスタ応答が不明です");
      }
      found.set(row.code,row);
    }
  }
  for (const c of candidates) {
    const stock=found.get(c.ticker);
    if (!stock || issuerMap.get(c.edinetCode)!==c.ticker) continue;
    qualified.set(c.doc.seqNumber,{stockId:stock.id,ticker:c.ticker,edinetCode:c.edinetCode,periodEnd:c.periodEnd,submittedAt:c.submittedAt});
  }
  return qualified;
}

export function buildReportedChanges(list: EdinetListResponse, input: ListSnapshot, qualified: ReadonlyMap<number,QualifiedProjection> = new Map()) {
  const source = listSnapshotSchema.parse(input);
  if (!source.qualified || source.httpStatus !== 200 || list.metadata.status !== "200" ||
      list.metadata.resultset.count !== list.results.length) throw new Error("EDINET変更観測の原一覧は未資格です");
  const sourcePageId = source.pageId.replaceAll("-", "").toLowerCase();
  const rows: Array<typeof table.$inferInsert> = [];
  const sequences = new Set<number>();
  for (const doc of list.results) {
    // 資格Mapの観測キーなので、変更行以外も含む元一覧全体で一意性を守る。
    if (!Number.isSafeInteger(doc.seqNumber) || sequences.has(doc.seqNumber)) {
      throw new Error("EDINET変更観測の書類ID/順序が不正又は重複しています");
    }
    sequences.add(doc.seqNumber);
    const state = reportedState(doc);
    if (state === null) continue;
    if (!/^S[0-9A-Z]{7}$/.test(doc.docID)) {
      throw new Error("EDINET変更観測の書類ID/順序が不正又は重複しています");
    }
    // raw-before-parseの保管証拠と同じ原行の投影。原一覧そのものは物理ファイルが正本。
    // 同docIDの複数状態も元一覧の別観測。docIDで資格を後勝ち共有しない。
    const projection=qualified.get(doc.seqNumber);
    const observation = { source: { ...source, pageId: sourcePageId }, doc,
      reportedIdentity: projection === undefined ? {status:"unqualified"} : {status:"qualified_reported_metadata", ...projection},
      state, chainQualification: "unqualified", chainApplication: "not_applied" };
    rows.push({ sourcePageId, seqNumber: doc.seqNumber, sourceRawSha256: source.rawSha256,
      docId: doc.docID, parentDocId: doc.parentDocID === undefined ? null : doc.parentDocID,
      reportedState: state, observationJson: JSON.stringify(observation),
      stockId:projection===undefined?null:projection.stockId, periodEnd:projection===undefined?null:projection.periodEnd,
      submittedAt:projection===undefined?null:projection.submittedAt });
  }
  return rows;
}

/** 1 INSERTは9行/90bind以内。同一原本の既存観測を変更しない。未知ACKはcallerの@listを保持。 */
export async function recordReportedChanges(db: ReportedSourceDb, list: EdinetListResponse, source: ListSnapshot, shouldStop: () => boolean) {
  // 資格不明の原一覧からidentity lookupを始めない。
  buildReportedChanges(list,source);
  const expected = buildReportedChanges(list, source, await qualifyReportedProjections(db,list,shouldStop));
  if (expected.length === 0) return { observations: 0, held: 0, relations: 0 };
  const scope = eq(table.sourcePageId, expected[0].sourcePageId);
  if (shouldStop()) throw new Error("EDINET変更観測の保存予算を超過しました");
  const before = await db.select().from(table).where(scope);
  const expectedBySeq = new Map(expected.map(row => [row.seqNumber, row]));
  const assertSaved = (saved: typeof before) => {
    if (new Set(saved.map(row => row.seqNumber)).size !== saved.length) throw new Error("EDINET変更観測が重複しています");
    for (const row of saved) {
      const match = expectedBySeq.get(row.seqNumber);
      if (!match || Object.entries(row).some(([key, value]) => value instanceof Date
        ? !(match[key as keyof typeof match] instanceof Date) || value.getTime() !== (match[key as keyof typeof match] as Date).getTime()
        : value !== match[key as keyof typeof match])) {
        throw new Error("EDINET変更観測の原本/保存内容が不一致です（再送なし）");
      }
    }
  };
  assertSaved(before);
  const existing = new Set(before.map(row => row.seqNumber));
  const missing = expected.filter(row => !existing.has(row.seqNumber));
  for (let i = 0; i < missing.length; i += 9) {
    if (shouldStop()) throw new Error("EDINET変更観測の保存予算を超過しました");
    await db.insert(table).values(missing.slice(i, i + 9)).onConflictDoNothing();
  }
  if (shouldStop()) throw new Error("EDINET変更観測の照合予算を超過しました");
  const after = await db.select().from(table).where(scope);
  assertSaved(after);
  if (after.length !== expected.length) throw new Error("EDINET変更観測の保存全量が不一致です（再送なし）");
  return { observations: expected.length,
    held: expected.filter(row => row.reportedState !== "unqualified_relation").length,
    relations: expected.filter(row => row.reportedState === "unqualified_relation").length };
}

/** exact docIDの状態だけを保留する。未解決の親関係は独立した現行原表を無効化しない。 */
export function reportedDocumentHold(docId: AnyColumn | SQL | string): SQL<number> {
  // Drizzle select-field rendering removes ordinary column qualifiers even inside a nested SQL.
  const target = typeof docId === "string" ? sql`${docId}` : "table" in docId
    ? sql`${docId.table}.${sql.identifier(docId.name)}` : docId;
  return sql<number>`exists (select 1 from ${table} where ${table}.${sql.identifier(table.docId.name)} = ${target}
    and ${unresolvedReportedObservation()})`.mapWith(value => {
      if (value !== 0 && value !== 1) throw new Error("EDINET変更観測の資格応答が不明です");
      return value;
    });
}

const outerColumn = (column: AnyColumn) => sql`${column.table}.${sql.identifier(column.name)}`;
/** このpredicateのqは、原metadataと通常identityの両mapが一致したimmutable投影だけ。 */
function qualifiedReportCondition(stockId: SQL): SQL {
  return sql`q.stock_id=${stockId} and q.period_end is not null and q.submitted_at is not null
    and ${unresolvedReportedObservation(sql`q`)}
    and not exists (select 1 from yuho_documents accepted where accepted.stock_id=q.stock_id
      and accepted.doc_type_code in ('120','130') and accepted.period_end=q.period_end
      and (accepted.submitted_at>q.submitted_at or (accepted.submitted_at=q.submitted_at
        and exists(select 1 from yuho_documents observed where observed.doc_id=q.doc_id and accepted.id>observed.id)))
      and not ${reportedDocumentHold(sql`accepted.doc_id`)})`;
}

/** stockのoverall最新年報HOLD。使用facts窓の外へ新年度が欠けても旧年度をcurrentにしない。 */
function reportedOverallLatestHold(stockId:AnyColumn):SQL {
  return sql`(exists(select 1 from yuho_documents current where current.stock_id=${outerColumn(stockId)}
    and current.doc_type_code in ('120','130')
    and ${reportedDocumentHold(sql`current.doc_id`)}
    and not exists(select 1 from yuho_documents later where later.stock_id=current.stock_id and later.doc_type_code in ('120','130')
      and (later.period_end>current.period_end or (later.period_end=current.period_end and
        (later.submitted_at>current.submitted_at or (later.submitted_at=current.submitted_at and later.id>current.id)))))
    )
    or exists(select 1 from ${table} q where ${qualifiedReportCondition(outerColumn(stockId))}
      and not exists(select 1 from yuho_documents later where later.stock_id=q.stock_id and later.doc_type_code in ('120','130')
        and (later.period_end>q.period_end or (later.period_end=q.period_end and later.submitted_at>q.submitted_at)))))`;
}

/** 最新選択後のHOLD。未取込の新しいFY報告を古い最新書類で置換しない。 */
export function reportedLatestSelectionHold(docId: AnyColumn, stockId: AnyColumn, periodEnd: AnyColumn, submittedAt: AnyColumn): SQL<number> {
  return sql<number>`(${reportedDocumentHold(docId)} or exists(select 1 from ${table} q
    where ${qualifiedReportCondition(outerColumn(stockId))}
      and (q.period_end>${outerColumn(periodEnd)} or (q.period_end=${outerColumn(periodEnd)} and q.submitted_at>=${outerColumn(submittedAt)}))))`.mapWith(value=>{
    if(value!==0&&value!==1)throw new Error("EDINET最新報告の資格応答が不明です");return value;
  });
}

/** 明示した金融sourceは同じFYだけを保護する。別FYの原表を一括無効化しない。 */
export function reportedFinancialSourceHold(docId: AnyColumn | SQL | string): SQL<number> {
  const target=typeof docId==="string"?sql`${docId}`:"table" in docId?outerColumn(docId):docId;
  return sql<number>`(${reportedDocumentHold(docId)} or exists(select 1 from yuho_documents source
    where source.doc_id=${target} and exists(select 1 from ${table} q
      where ${qualifiedReportCondition(sql`source.stock_id`)}
        and q.period_end=source.period_end and q.submitted_at>=source.submitted_at)))`.mapWith(value=>{
    if(value!==0&&value!==1)throw new Error("EDINET金融sourceの資格応答が不明です");return value;
  });
}

function qualifiedProjectionHold(kind:"orders"|"overseas",stockId:AnyColumn,firstFy:AnyColumn,lastFy:AnyColumn):SQL {
  const facts=sql.identifier(kind==="orders"?"yuho_order_facts":"yuho_overseas_facts");
  return sql`exists(select 1 from ${table} q where ${qualifiedReportCondition(outerColumn(stockId))}
    and q.period_end between ${outerColumn(firstFy)} and ${outerColumn(lastFy)}
    and not exists(select 1 from ${facts} newer_fact join yuho_documents nd on nd.id=newer_fact.document_id
      where newer_fact.stock_id=q.stock_id and newer_fact.fiscal_year_end=q.period_end
        and nd.submitted_at>q.submitted_at and not ${reportedDocumentHold(sql`nd.doc_id`)}))`;
}

/** 既存投影の使用窓内で採用される最新ファクトのみを保留する。先に除外して旧提出へ戻さない。 */
export function reportedGrowthHold(kind: "orders" | "overseas", stockId: AnyColumn,
  firstFy: AnyColumn, lastFy: AnyColumn): SQL {
  // select-field compilation may omit column table names; correlated references must remain qualified.
  const outer = (column: AnyColumn) => sql`${column.table}.${sql.identifier(column.name)}`;
  const facts = sql.identifier(kind === "orders" ? "yuho_order_facts" : "yuho_overseas_facts");
  const used = kind === "orders" ? sql`f.segment_kind = 'total'`
    : sql`f.region_kind in ('overseas_total', 'total', 'overseas')`;
  const newerUsed = kind === "orders" ? sql`newer.segment_kind = 'total'`
    : sql`newer.region_kind in ('overseas_total', 'total')`;
  // 観測から影響候補stockを一度だけ構成し、無関係stockの履歴/facts再探索を避ける。
  // ponytail: 集合構築は観測履歴O(rows)。実測読取の増大時だけactive影響集合を検討する。
  // NULL identityのexact docは実metadataへjoin、未取込の資格済み報告はstock_id側で保持する。
  return sql`case when ${outer(stockId)} in (
    select affected.stock_id from ${table} affected where affected.reported_state <> 'unqualified_relation' and affected.stock_id is not null
    union select document.stock_id from ${table} affected cross join yuho_documents document
      where document.doc_id=affected.doc_id and affected.reported_state <> 'unqualified_relation'
  ) then (${reportedOverallLatestHold(stockId)} or ${qualifiedProjectionHold(kind,stockId,firstFy,lastFy)} or ${reportedUnrepresentedDocumentHold(kind, stockId, firstFy, lastFy)} or exists (select 1 from ${facts} f join yuho_documents d on d.id = f.document_id
    where f.stock_id = ${outer(stockId)} and f.fiscal_year_end between ${outer(firstFy)} and ${outer(lastFy)}
      and ${used} and ${reportedDocumentHold(sql`d.doc_id`)}
      and not exists (select 1 from ${facts} newer
        join yuho_documents nd on nd.id = newer.document_id
        where newer.stock_id = f.stock_id and newer.fiscal_year_end = f.fiscal_year_end
          and ${newerUsed} and nd.submitted_at > d.submitted_at))) else 0 end`;
}

/** 最新HOLD書類にfactsが無い場合も旧提出の同FY値へ戻さない。別FYや正常な新提出は巻き込まない。 */
function latestAnnualHoldCondition(stockId: AnyColumn, firstFy: AnyColumn, lastFy: AnyColumn): SQL {
  const outer = (column: AnyColumn) => sql`${column.table}.${sql.identifier(column.name)}`;
  return sql`missing.stock_id = ${outer(stockId)} and missing.doc_type_code in ('120','130')
    and missing.period_end between ${outer(firstFy)} and ${outer(lastFy)}
    and ${reportedDocumentHold(sql`missing.doc_id`)}
    and not exists (select 1 from yuho_documents later where later.stock_id=missing.stock_id
      and later.doc_type_code in ('120','130') and later.period_end=missing.period_end
      and (later.submitted_at>missing.submitted_at or (later.submitted_at=missing.submitted_at and later.id>missing.id)))`;
}

/** 本文索引が無い同FY最新書類も、実D1 metadataに束縛したexact IDだけを返す。 */
export function reportedLatestAnnualHoldDocId(stockId: AnyColumn, fiscalYearEnd: AnyColumn): SQL<string | null> {
  return sql<string | null>`(select missing.doc_id from yuho_documents missing
    where ${latestAnnualHoldCondition(stockId, fiscalYearEnd, fiscalYearEnd)})`.mapWith(value => {
    if (value !== null && (typeof value !== "string" || !/^S[0-9A-Z]{7}$/.test(value))) throw new Error("EDINET最新本文資格の応答が不明です");
    return value as string | null;
  });
}

/** 未取込報告も本文GET前に明示HOLD。同じFYだけ、原一覧の実docIDを返す。 */
export function reportedQualifiedTextHoldDocId(stockId:AnyColumn,fiscalYearEnd:AnyColumn):SQL<string|null> {
  return sql<string|null>`(select q.doc_id from ${table} q where ${qualifiedReportCondition(outerColumn(stockId))}
    and q.period_end=${outerColumn(fiscalYearEnd)} order by q.submitted_at desc,q.doc_id desc limit 1)`;
}

export function reportedUnrepresentedDocumentHold(kind: "orders" | "overseas", stockId: AnyColumn,
  firstFy: AnyColumn, lastFy: AnyColumn): SQL<number> {
  const facts = sql.identifier(kind === "orders" ? "yuho_order_facts" : "yuho_overseas_facts");
  return sql<number>`exists (select 1 from yuho_documents missing
    where ${latestAnnualHoldCondition(stockId, firstFy, lastFy)}
      and not exists (select 1 from ${facts} newer_fact join yuho_documents source_doc on source_doc.id=newer_fact.document_id
        where newer_fact.stock_id=missing.stock_id and newer_fact.fiscal_year_end=missing.period_end
          and source_doc.submitted_at>missing.submitted_at))`.mapWith(value => {
    if (value !== 0 && value !== 1) throw new Error("EDINET変更観測の使用年度資格が不明です"); return value;
  });
}

export class ReportedDocumentHoldError extends Error {
  constructor(public readonly docId: string) {
    super(`${REPORTED_DOCUMENT_HOLD_REASON}（${docId}）`);
    this.name = "ReportedDocumentHoldError";
  }
}

/** 対象集合の実D1事前照合。1 SELECT/最大100 bind、Notion PREより前に使う。 */
export function reportedDocumentsHoldQuery(docIds: readonly string[]) {
  if (docIds.length === 0 || docIds.length > 100 || new Set(docIds).size !== docIds.length ||
      docIds.some(id => typeof id !== "string" || !id)) throw new Error("EDINET変更観測の照合対象集合が不正です");
  const query = new SQLiteSyncDialect().sqlToQuery(sql`with targets(doc_id) as (values ${sql.join(docIds.map(id=>sql`(${id})`),sql`,`)})
    select distinct targets.doc_id from targets where ${reportedFinancialSourceHold(sql`targets.doc_id`)} order by targets.doc_id`);
  if (query.params.some(value => typeof value !== "string")) throw new Error("EDINET変更観測の照合bindが不正です");
  return { sql: query.sql, params: query.params as string[] };
}

export function assertReportedDocumentsResult(docIds: readonly string[], rows: readonly Record<string, unknown>[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (Object.keys(row).length !== 1 || typeof row.doc_id !== "string" || !docIds.includes(row.doc_id) || seen.has(row.doc_id)) {
      throw new Error("EDINET変更観測の集合照合応答が不明です");
    }
    seen.add(row.doc_id);
  }
  if (rows.length > 0) throw new ReportedDocumentHoldError(rows[0].doc_id as string);
}

/** 同じ金融atomic batch内の競合検査。既知HOLDならSQLite/D1がbatch全体をrollbackする。 */
export function reportedDocumentAtomicGuard(db: ReportedSourceDb, docId: string) {
  return db.select({ reportedSourceUsable: sql`json(case when ${reportedFinancialSourceHold(sql`target.doc_id`)} then '' else 'null' end)` }).from(sql`(select ${docId} as doc_id) target`);
}

/** 対象docIDの資格を、通常backendの同じD1で確かめる。旧文書への再選択はしない。 */
export async function assertReportedDocumentUsable(db: ReportedSourceDb, docId: string): Promise<void> {
  const rows = await db.select({ held: reportedFinancialSourceHold(sql`target.doc_id`) }).from(sql`(select ${docId} as doc_id) target`);
  if (rows.length !== 1 || (rows[0].held !== 0 && rows[0].held !== 1)) throw new Error("EDINET変更観測の資格応答が不明です");
  if (rows[0].held === 1) throw new ReportedDocumentHoldError(docId);
}
