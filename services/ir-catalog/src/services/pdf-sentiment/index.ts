/**
 * PDF 本文センチメント判定の公開 API。
 *
 * 呼び出しフロー:
 *   1. PDF バイト列を `extractPdfText` でテキスト化 (5s timeout)
 *   2. 失敗 (画像化 / 暗号化 / 破損 / timeout) → `unknown` を正直に返す
 *   3. テキスト + primaryTag を `dispatchClassify` に渡してエンジン振り分け
 *
 * ルール1/2 整合: 抽出/判定不能なケースは `unknown` か `skipped` を返し、
 * 架空の positive/negative で埋めない。
 *
 * 帰属表記 (商用利用条件):
 *   - 東北大学 乾・岡崎研究室『日本語評価極性辞書』(商用可・要クレジット明記)
 *     詳細は [dictionary/LICENSE.md](./dictionary/LICENSE.md) と
 *     UI disclaimer ([../../views/stock-detail.ts](../../views/stock-detail.ts))。
 */
import { dispatchClassify } from "./dispatch.js";
import { extractPdfText } from "./extract-text.js";
import { unknown, type PdfSentimentResult } from "./types.js";

export type { PdfSentiment, PdfSentimentMethod, PdfSentimentResult } from "./types.js";

/**
 * `bytes` を PDF として解析し、`primaryTag` に応じてエンジン振り分け。
 * 失敗時も throw せず `unknown` / `skipped` を返す (バッチを止めない設計)。
 */
export async function classifyPdfSentiment(
  bytes: Uint8Array,
  primaryTag: string | null
): Promise<PdfSentimentResult> {
  const { result } = await classifyPdfSentimentWithText(bytes, primaryTag);
  return result;
}

export interface PdfSentimentWithText {
  result: PdfSentimentResult;
  /** 抽出テキスト。抽出失敗時は null (判定は unknown になる) */
  text: string | null;
}

/**
 * 判定結果と抽出テキストの両方を返す。D1 への本文保存
 * (`ir_disclosure_texts`) 用。抽出は 1 回だけで二重に読まない。
 */
export async function classifyPdfSentimentWithText(
  bytes: Uint8Array,
  primaryTag: string | null
): Promise<PdfSentimentWithText> {
  const text = await extractPdfText(bytes);
  if (text === null) {
    return {
      result: unknown("PDF テキスト抽出失敗 (画像化/暗号化/破損/timeout)"),
      text: null,
    };
  }
  return { result: await dispatchClassify(text, primaryTag), text };
}

/**
 * 既にテキスト化済みの素材を直接判定する (テスト用に公開)。
 * 本番経路では使わない。
 */
export async function classifyTextSentiment(
  text: string,
  primaryTag: string | null
): Promise<PdfSentimentResult> {
  return dispatchClassify(text, primaryTag);
}
