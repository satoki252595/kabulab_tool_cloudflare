/**
 * 一次データ Notion アーカイブ (CLAUDE.md ルール6) 公開 API。
 *
 * 使い方:
 *   import { recordPrimaryData } from "../../../src/shared/notion-archive/index.js";
 *   await recordPrimaryData({
 *     service: "yuho-quant",
 *     key: doc.docID,                         // 冪等キー
 *     source: "EDINET API v2 /documents/{docId}",
 *     metadata: { ...一覧 API の生メタ },
 *     files: [{ bytes, filename, contentType }], // 取得した物理ファイル
 *   });
 */
export { recordPrimaryData, moveToTrash, isArchived } from "./archive.js";
export {
  ensureStockTextDb,
  findStockTextRowId,
  readStockTextRow,
  upsertStockTextRow,
  buildTextBodyBlocks,
  STOCK_TEXT_DB_TITLE,
  TEXT_BODY_MARKER,
} from "./stock-text.js";
export type {
  StockTextDoc,
  StockTextSection,
  UpsertStockTextRowResult,
} from "./stock-text.js";
export type {
  RecordPrimaryDataInput,
  RecordResult,
  PrimaryFile,
} from "./archive.js";
export { NotionFileTooLargeError } from "./file-upload.js";
export { NotionConfigError, notionEnv } from "./env.js";
export { upsertDisclosuresByStock } from "./dataset.js";
export type {
  ByStockInput,
  ByStockRow,
  ByStockResult,
  NotionSelectColor,
  PdfClassification,
  PdfSentimentLabel,
} from "./dataset.js";
export { fetchPageFileUrl } from "./page-file.js";
export type { PageFileRef } from "./page-file.js";
export { ensureIndexPage, replacePageChildren } from "./index-page.js";
export type { EnsureIndexPageOptions, EnsureIndexPageResult } from "./index-page.js";
export { ARCHIVE_SECTIONS, INDEX_PAGE_TITLE, buildIndexBlocks } from "./map.js";
export type { IndexBullet, IndexSection } from "./map.js";
export { notionStats, resetNotionStats } from "./client.js";
export type { NotionStats } from "./client.js";
export { RICH_TEXT_MAX, splitRichText, joinRichText } from "./rich-text.js";
export type { RichTextChunk } from "./rich-text.js";

// 005 yuho-quant 事業タグ (docs/005-yuho-quant-business-tags.md §3)
export {
  SUPPLEMENT_DB_TITLE,
  SUPPLEMENT_PROPS,
  ensureSupplementDb,
  loadSupplementRows,
  loadStockMasterIndex,
  buildSupplementProperties,
  chunkPropertiesByBytes,
  createSupplementRow,
  updateSupplementRow,
  EVIDENCE_TITLE_PREFIX,
  buildEvidenceBlock,
  replaceEvidenceBlock,
} from "./stock-supplement.js";
export type {
  TextStatus,
  TagStatus,
  DocTypeLabel,
  SupplementSchemaSpec,
  SupplementRow,
  SupplementRowInput,
  StockMasterIndex,
  EvidenceItem,
  EvidenceBlockInput,
} from "./stock-supplement.js";
export {
  LEDGER_DB_TITLE,
  LedgerIntegrityError,
  ensureLedgerDb,
  listLedgerEntries,
  readLedgerJson,
  createLedgerEntry,
  updateLedgerEntry,
  replaceLedgerJson,
} from "./biztag-ledger.js";
export type { LedgerKind, LedgerState, LedgerEntry } from "./biztag-ledger.js";

// 株価の日次同期の完了記録 (取引日つき。CLAUDE.md ルール6: 1 取引日 1 行の単一 DB)
export {
  PRICE_SYNC_DB_TITLE,
  PRICE_SYNC_PROPS,
  ensurePriceSyncDb,
  recordPriceSyncLog,
} from "./price-sync-log.js";
export type {
  PriceSyncStatus,
  PriceSyncLogInput,
  RecordPriceSyncLogResult,
} from "./price-sync-log.js";
// 005 yuho-quant 競合他社 (docs/005-yuho-quant-business-tags.md「競合他社」節 §4)
export {
  COMPETITOR_PROPS,
  ensureCompetitorColumns,
  loadCompetitorMeta,
  writeCompetitorRelation,
} from "./stock-competitors.js";
export type { CompetitorMeta, WriteCompetitorRelationInput } from "./stock-competitors.js";

// 2026-09-25 「一次データ保管」再配置 — scripts/notion/relocate-archive.ts 専用
// (通常のサービスコードは使わない。ルール6 の窓口をここでも保つための再輸出)
export {
  movePage,
  moveDatabase,
  findDatabasesByTitlePrefix,
  getDatabaseParentPageId,
  getPageParent,
  listDirectChildren,
} from "./relocate.js";
export type {
  MovePageParent,
  FoundDatabase,
  PageParent,
  RemainingChild,
} from "./relocate.js";
export { findAllBackupChildrenByTitle } from "./archive.js";
export type { BackupChildHit } from "./archive.js";
