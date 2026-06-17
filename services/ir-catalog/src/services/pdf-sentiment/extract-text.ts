/**
 * PDF バイト列 → テキスト抽出 (`unpdf` ラッパ)。
 *
 * - 抽出失敗 / 0 文字 / タイムアウト時は **null** を返す (架空文字列で埋めない)
 * - unpdf は Mozilla pdf.js を Vercel Serverless 対応にバンドルした OSS 実装
 *   (Apache-2.0)。`getDocumentProxy` が disableFontFace を自動設定するので
 *   Node.js 環境でフォント不足エラーを出さない
 * - 画像化 PDF (スキャン取込み) は文字情報を持たないため 0 文字になる →
 *   呼び出し側で `unknown` 扱い (OCR は導入しない — ルール1 整合)
 */
import { extractText, getDocumentProxy } from "unpdf";

const DEFAULT_TIMEOUT_MS = 5_000;

export interface ExtractOptions {
  /** タイムアウト超過は null を返す (再試行は呼び出し側責務) */
  timeoutMs?: number;
}

/**
 * @returns 抽出テキスト (空白除去後で 1 文字以上) または null
 */
export async function extractPdfText(
  bytes: Uint8Array,
  opts: ExtractOptions = {}
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // PDF ヘッダ事前チェック (`%PDF-`): 非 PDF を抽出器に渡さない
  if (
    bytes.length < 5 ||
    bytes[0] !== 0x25 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x44 ||
    bytes[3] !== 0x46 ||
    bytes[4] !== 0x2d
  ) {
    return null;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });

  try {
    const result = await Promise.race([extract(bytes), timeout]);
    return result;
  } catch (e) {
    console.warn(`[pdf-sentiment extract] 抽出失敗: ${(e as Error).message}`);
    return null;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function extract(bytes: Uint8Array): Promise<string | null> {
  const doc = await getDocumentProxy(bytes);
  const { text } = await extractText(doc, { mergePages: true });
  const merged = Array.isArray(text) ? text.join("\n") : text;
  const trimmed = (merged ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}
