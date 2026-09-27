/**
 * PDF のテキスト抽出 (moneyflow 共通)。
 *
 * unpdf (pdf.js) の `getDocumentProxy()` は渡した Uint8Array の ArrayBuffer を
 * worker へ transfer して **detach する** (呼び出し後に byteLength が 0 になる。
 * unpdf 1.6.2 / Node 22 で実測)。同じバイト列を一次データとして
 * `recordPrimaryData()` へ渡すと空ファイル扱いで throw するため、ここで必ず
 * コピーを渡し、呼び出し元のバイト列を壊さない。
 */
import { extractText, getDocumentProxy } from "unpdf";

/** 全ページを連結したテキストを返す (引数のバイト列は変更しない)。 */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes.slice());
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}
