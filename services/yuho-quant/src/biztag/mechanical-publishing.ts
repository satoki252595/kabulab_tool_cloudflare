/** Finite body/master publishing only. No vocabulary, thresholds, model or semantic tag writes. */
import assert from "node:assert/strict";
import { and, asc, eq, gt, inArray, or } from "drizzle-orm";
import { stocks } from "../../../../src/shared/db/core-schema.js";
import { activeEquityCondition } from "../../../../src/shared/db/active-equity.js";
import { createD1HttpDb } from "../../../../src/shared/db/d1-http-client.js";
import { parseStockCode } from "../../../../src/shared/jpx/stock-code.js";
import { currentPublishingWriter, publishingReadOnly } from "../../../../scripts/mechanical-publishing/shared-writer.js";
import { buildSupplementProperties, createSupplementRow, ensureSupplementDb, loadStockMasterIndex, loadSupplementRows,
  notionStats, replaceEvidenceBlock, resetNotionStats, type SupplementRow, type SupplementRowInput } from "../../../../src/shared/notion-archive/index.js";
import { normalizeSupplementText, readSupplementRowFully, SupplementWriteHeldError } from "../../../../src/shared/notion-archive/stock-supplement.js";
import { NotionConfigError } from "../../../../src/shared/notion-archive/env.js";
import { sha256Hex } from "../../../../src/shared/sha256.js";
import * as schema from "../db/schema.js";
import { TEXT_SECTIONS } from "../services/edinet/text-sections.js";
import { assertLatestDocCurrent, loadLatestDocs, readQualifiedBiztagDocText, type BiztagSourceDb, type LatestDoc } from "./source.js";
import { displayName, hasUsableText, readInputReceipt, rowTextSyncReceipt } from "./plan.js";
import { savedRowGuard, textColumnsOf, textReceipt } from "./process.js";
import { PREFILTER_SECTIONS } from "./prefilter.js";
import { docTypeLabelOf } from "./doc-type.js";

export interface PublishingCursor { version: 1; afterCode: string | null; changedAt: string; changedDoc: string }
type PublishingOutcome = {
  stockCode: string;
  outcome: "synced" | "unchanged" | "basic-only" | "held" | "unstarted";
  sourceReceipt: { textsSha256: string; notionTextsSha256?: string } | null;
};
export function publishingCursor(raw: string | null, now: number): PublishingCursor {
  if (raw === null) return { version: 1, afterCode: null, changedAt: new Date(Math.floor(now / 1000) * 1000).toISOString(), changedDoc: "" };
  const value: PublishingCursor = JSON.parse(raw);
  assert(value && typeof value === "object"); assert.deepEqual(Object.keys(value).sort(), ["afterCode", "changedAt", "changedDoc", "version"]);
  assert.equal(value.version, 1); assert(value.afterCode === null || parseStockCode(value.afterCode) === value.afterCode);
  assert(typeof value.changedAt === "string" && Number.isFinite(Date.parse(value.changedAt)) && Date.parse(value.changedAt) <= now);
  assert(value.changedDoc === "" || /^S[0-9A-Z]{7}$/.test(value.changedDoc)); return value;
}

/** Apply the code/time scope in SQL before loading document metadata or any Notion original. */
export async function mechanicalSelection(db: BiztagSourceDb, cursor: PublishingCursor, limit: number) {
  assert(Number.isSafeInteger(limit) && limit >= 1 && limit <= 50);
  const changed = await db.select({ code: stocks.code, docId: schema.yuhoDocuments.docId, ingestedAt: schema.yuhoDocuments.ingestedAt })
    .from(schema.yuhoDocuments).innerJoin(stocks, eq(stocks.id, schema.yuhoDocuments.stockId))
    .where(and(activeEquityCondition(), inArray(schema.yuhoDocuments.docTypeCode, ["120", "130"]),
      or(gt(schema.yuhoDocuments.ingestedAt, new Date(cursor.changedAt)), and(eq(schema.yuhoDocuments.ingestedAt, new Date(cursor.changedAt)), gt(schema.yuhoDocuments.docId, cursor.changedDoc)))))
    .orderBy(asc(schema.yuhoDocuments.ingestedAt), asc(schema.yuhoDocuments.docId)).limit(limit);
  const window = (after: string | null) => db.select({ code: stocks.code }).from(stocks)
    .where(and(activeEquityCondition(), after === null ? undefined : gt(stocks.code, after))).orderBy(asc(stocks.code)).limit(limit);
  let rotating = await window(cursor.afterCode);
  if (rotating.length === 0 && cursor.afterCode !== null) rotating = await window(null);
  const codes = [...new Set([...changed.map(row => row.code), ...rotating.map(row => row.code)])].slice(0, limit);
  return { codes, changed, rotating };
}

/** A new body never changes the saved tag/status/evidence. Missing judgment lineage remains explicitly unknown. */
export async function mechanicalTextInput(latest: LatestDoc, row: SupplementRow | null,
  sections: Parameters<typeof textColumnsOf>[0], masterPageId: string | null): Promise<SupplementRowInput> {
  assert(hasUsableText(latest.doc) && latest.reportedHoldReason === undefined);
  assert(sections.length > 0, "39本文の同期元が空です。旧本文を消しません");
  const texts = textColumnsOf(sections), receipt = await textReceipt(latest.doc, texts, null);
  const title = new Map(TEXT_SECTIONS.map(section => [section.key, section.title]));
  const fourSha = await sha256Hex(JSON.stringify(PREFILTER_SECTIONS.map(key => [key, texts[title.get(key)!]])));
  let tagInputSha256: string | null = null;
  if (row !== null) {
    try {
      const judgment = readInputReceipt(row.judgeInput);
      if (row.tagStatus === "判定済" && judgment !== null && row.tagDoc?.split(" ", 1)[0] === judgment.docId && row.vocabVersion === judgment.vocabVersion) tagInputSha256 = judgment.sectionsSha256;
    } catch { /* Invalid old semantic lineage does not authorize retagging or prevent qualified body publishing. */ }
  }
  const input: SupplementRowInput = { stockCode: latest.stockCode, companyName: latest.companyName, sector33: latest.sector33,
    docId: latest.doc.docId, docType: docTypeLabelOf(latest.doc.docTypeCode), periodEnd: latest.doc.periodEnd, submittedAt: latest.doc.submittedAt,
    textStatus: "取得済", texts, textSyncReceipt: JSON.stringify(receipt), textInputSha256: fourSha, tagInputSha256 };
  if (masterPageId !== null && (row === null || !row.masterLinked)) input.masterPageId = masterPageId;
  if (row === null) Object.assign(input, { tagStatus: "未判定", upstream: [], downstream: [], distribution: [], themes: [],
    uncertain: null, evidenceText: null, tagDoc: null, vocabVersion: null, judgedAt: null, candidateCount: null, judgeInput: null,
    error: null, attempts: 0, nextRetryAt: null });
  return input;
}

export async function runMechanicalPublishing(options: { limit: number; budgetMs: number; codes?: string[]; sourceDeadlineMs?: number; deadlineMs?: number }) {
  assert(Number.isSafeInteger(options.limit) && options.limit > 0 && options.limit <= 50);
  assert(Number.isSafeInteger(options.budgetMs) && options.budgetMs > 0 && options.budgetMs <= 15 * 60_000);
  if (options.codes) assert(options.codes.length > 0 && options.codes.length <= options.limit && new Set(options.codes).size === options.codes.length && options.codes.every(code => parseStockCode(code) === code));
  const writer = currentPublishingWriter(); assert(writer, "機械同期には共有writerが必要です");
  const start = Date.now();
  assert((options.sourceDeadlineMs === undefined) === (options.deadlineMs === undefined));
  const soft = options.sourceDeadlineMs === undefined ? start + options.budgetMs : options.sourceDeadlineMs;
  const hard = options.deadlineMs === undefined ? soft + 5 * 60_000 : options.deadlineMs;
  assert(Number.isSafeInteger(soft) && Number.isSafeInteger(hard) && soft > start && hard - soft === 5 * 60_000);
  await writer.assertReady();
  const active = () => { if (Date.now() >= hard) throw new NotionConfigError("機械同期の閉鎖期限を超えました"); };
  resetNotionStats();
  const cursor = publishingCursor(await writer.readCursor("supplement-texts"), start);
  const db = createD1HttpDb(schema) as unknown as BiztagSourceDb;
  const selection = options.codes ? { codes: options.codes, changed: [], rotating: [] } : await publishingReadOnly(() => mechanicalSelection(db, cursor, options.limit));
  const latest = await publishingReadOnly(() => loadLatestDocs(db, selection.codes));
  const outcomes = new Map<string, PublishingOutcome>(selection.codes.map(stockCode =>
    [stockCode, { stockCode, outcome: "unstarted", sourceReceipt: null }]));
  const done = new Set<string>(), held: Array<{ stockCode: string; reason: string }> = [];
  let synced = 0, unchanged = 0, basicOnly = 0;
  if (latest.length > 0) {
    const supplement = await ensureSupplementDb({ textColumns: TEXT_SECTIONS.map(s => s.title), upstreamOptions: [], downstreamOptions: [],
      distributionOptions: [], themeOptions: [], versionOptions: [], sector33Options: [...new Set(latest.flatMap(row => row.sector33 === null ? [] : [row.sector33]))] });
    const rows = await publishingReadOnly(() => loadSupplementRows(supplement.dbId, supplement.propertyIds, { codes: selection.codes }));
    const master = await publishingReadOnly(() => loadStockMasterIndex(selection.codes));
    for (const item of latest) {
      if (Date.now() >= soft) break;
      const outcome = outcomes.get(item.stockCode)!;
      outcome.outcome = "held";
      const row = rows.find(value => value.stockCode === item.stockCode) ?? null;
      if (item.reportedHoldReason !== undefined) { held.push({ stockCode: item.stockCode, reason: item.reportedHoldReason }); done.add(item.stockCode); continue; }
      if (row !== null && (row.companyName.trim() !== "" && displayName(row.companyName) !== displayName(item.companyName) ||
          row.docId === item.doc?.docId && (row.sector33 !== null && item.sector33 !== null && row.sector33 !== item.sector33 ||
          row.docType !== null && row.docType !== docTypeLabelOf(item.doc!.docTypeCode) || row.periodEnd !== null && row.periodEnd !== item.doc!.periodEnd ||
          row.submittedAt !== null && Date.parse(row.submittedAt) !== Date.parse(item.doc!.submittedAt)))) {
        held.push({ stockCode: item.stockCode, reason: "非空の主体/同docメタが不同。旧値を保持" }); done.add(item.stockCode); continue;
      }
      if (master.duplicates.has(item.stockCode)) { held.push({ stockCode: item.stockCode, reason: "銘柄マスタのrelationが一意ではありません" }); done.add(item.stockCode); continue; }
      const masterId = master.index.get(item.stockCode) ?? null;
      if (masterId === null && (row === null || !row.masterLinked)) held.push({ stockCode: item.stockCode, reason: "一意な銘柄マスタrelation先が未保管。本文同期とは区別して保持" });
      try {
        if (!hasUsableText(item.doc)) {
          const input: SupplementRowInput = { docId: row === null ? null : row.docId };
          if (row === null || row.companyName.trim() === "") input.companyName = item.companyName;
          if (row === null || row.sector33 === null) input.sector33 = item.sector33;
          if (masterId !== null && (row === null || !row.masterLinked)) input.masterPageId = masterId;
          if (row === null) {
            await assertLatestDocCurrent(db, item.stockCode, item.doc, { companyName: item.companyName, sector33: item.sector33 });
            await createSupplementRow(supplement.dbId, { ...input, stockCode: item.stockCode, textStatus: "本文なし", tagStatus: "未判定" }, null, writer.supplementJournal()); basicOnly++;
            outcome.outcome = "basic-only";
          } else if (Object.keys(input).length > 1) {
            await replaceEvidenceBlock(row.pageId, undefined, input, savedRowGuard(row), async () => {
              active(); await assertLatestDocCurrent(db, item.stockCode, item.doc, { companyName: item.companyName, sector33: item.sector33 });
            }, writer.supplementJournal()); basicOnly++;
            outcome.outcome = "basic-only";
          }
          held.push({ stockCode: item.stockCode, reason: "最新有報の適格本文が未保管。基本メタ欠落だけを補い旧本文/タグを保持" });
        } else {
          let prior = null;
          if (row !== null) { try { prior = rowTextSyncReceipt(row); } catch { /* Requalify the source; do not fabricate historical input lineage. */ } }
          const current = row !== null && row.docId === item.doc.docId && row.textStatus === "取得済" && prior?.docId === item.doc.docId &&
            prior.textPageId === item.doc.notionDocPageId && prior.notionTextsSha256 !== undefined;
          active();
          const full = row === null ? null : await publishingReadOnly(() => readSupplementRowFully(row.pageId, supplement.dbId, TEXT_SECTIONS.map(s => s.title), active));
          if (full !== null) assert(full.stockCode === item.stockCode && JSON.stringify(savedRowGuard(full)) === JSON.stringify(savedRowGuard(row!)), "補足メタ/判定が限定plan後に変更されています");
          // 旧receiptだけではsource所属を証明できない。unchanged候補も同じ資格readerを1回通す。
          const sections = await publishingReadOnly(() => readQualifiedBiztagDocText(db, item.stockCode, item.doc!));
          active(); const input = await mechanicalTextInput(item, full, sections, masterId);
          const observed = rowTextSyncReceipt({ textSyncReceipt: input.textSyncReceipt, judgeInput: null });
          if (observed !== null) outcome.sourceReceipt = { textsSha256: observed.textsSha256, notionTextsSha256: observed.notionTextsSha256 };
          if (current && full !== null && full.textSyncReceipt !== undefined && full.textSyncReceipt !== null &&
              full.textInputSha256 === input.textInputSha256 && full.tagInputSha256 === input.tagInputSha256 &&
              observed !== null && observed.textsSha256 === prior!.textsSha256 &&
              observed.notionTextsSha256 === prior!.notionTextsSha256 && full.masterLinked && full.companyName === item.companyName && full.sector33 === item.sector33 &&
              await sha256Hex(JSON.stringify(TEXT_SECTIONS.map(({ title }) => [title, normalizeSupplementText(full.texts[title]) || null]))) === prior!.notionTextsSha256) {
            unchanged++; outcome.outcome = "unchanged"; done.add(item.stockCode); continue;
          }
          const beforeWrite = async () => { active(); await assertLatestDocCurrent(db, item.stockCode, item.doc, { companyName: item.companyName, sector33: item.sector33 }); };
          if (full === null) { await beforeWrite(); await createSupplementRow(supplement.dbId, input, null, writer.supplementJournal()); }
          else await replaceEvidenceBlock(full.pageId, undefined, input, { ...savedRowGuard(full), ...buildSupplementProperties({ texts: full.texts }) }, beforeWrite, writer.supplementJournal());
          synced++; outcome.outcome = "synced";
        }
        done.add(item.stockCode);
      } catch (error) {
        if (!(error instanceof SupplementWriteHeldError)) throw error;
        // A HOLD after reserve has a durable pending intent and must stop the whole writer.
        await writer.assertReady(); held.push({ stockCode: item.stockCode, reason: "補足publicationの資格HOLD。旧値を保持" }); done.add(item.stockCode);
      }
    }
  }
  const next = { ...cursor };
  if (!options.codes) {
    for (const item of selection.changed) { if (!done.has(item.code)) break; next.changedAt = item.ingestedAt.toISOString(); next.changedDoc = item.docId; }
    for (const item of selection.rotating) { if (!done.has(item.code)) break; next.afterCode = item.code; }
    await writer.writeCursor("supplement-texts", JSON.stringify(next) + "\n");
  }
  return { selected: selection.codes.length, processed: done.size, unstarted: selection.codes.length - done.size, synced, unchanged, basicOnly, held,
    selectedCodes: selection.codes,
    latestDocs: latest.map(({ stockCode, doc, reportedHoldReason }) => ({ stockCode, reportedHoldReason,
      doc: doc === null ? null : { docId: doc.docId, docTypeCode: doc.docTypeCode, periodEnd: doc.periodEnd,
        submittedAt: doc.submittedAt, notionDocPageId: doc.notionDocPageId, textParseStatus: doc.textParseStatus } })),
    outcomes: [...outcomes.values()].map(outcome => ({ ...outcome, holds: held.filter(item => item.stockCode === outcome.stockCode).map(item => item.reason) })),
    cursorBefore: cursor, cursorAfter: next,
    modelCalls: 0, wholeSupplementComplete: false, notion: notionStats() };
}
