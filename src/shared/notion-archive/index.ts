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
