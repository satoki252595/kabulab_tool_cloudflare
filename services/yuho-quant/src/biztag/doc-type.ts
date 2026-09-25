/**
 * 書類種別コード (EDINET `docTypeCode`) → 表示ラベルの唯一の変換元。
 *
 * jev への状態ヘッダ (`DocMeta.docTypeLabel`。excerpt.ts) と Notion の
 * 書類種別列 (`DocTypeLabel`。process.ts・golden.ts) の両方がここを使う。
 * 二重定義すると、片方だけ直して食い違う事故になるため一本化する。
 */
import type { DocTypeLabel } from "../../../../src/shared/notion-archive/index.js";

export const DOC_TYPE_CODES = ["120", "130"] as const;
export type DocTypeCode = (typeof DOC_TYPE_CODES)[number];

export function docTypeLabelOf(code: DocTypeCode): DocTypeLabel {
  return code === "120" ? "有報" : "訂正有報";
}
