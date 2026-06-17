/**
 * PDF 本文センチメント判定の公開型 (ルール1/2 整合)。
 *
 * - 方向が確信できたときだけ `positive` / `negative` を返す
 * - 指標で割れた場合は `mixed` (片寄せ禁止)
 * - 抽出 0 文字 / マッチなしは `unknown` (架空値で埋めない)
 * - 判定対象外タグ (決算短信・人事 等) は `skipped`
 */
export type PdfSentiment =
  | "positive"
  | "negative"
  | "mixed"
  | "unknown"
  | "skipped";

/** 判定エンジン世代。schema.ts pdf_sentiment_method 列の値と一致 */
export type PdfSentimentMethod = "rule_v1" | "dict_v1";

export interface PdfSentimentResult {
  sentiment: PdfSentiment;
  /** どのエンジンで出した結果か。skipped/unknown は null も許す */
  method: PdfSentimentMethod | null;
  /** スコア。rule_v1=1.0 or null、dict_v1=-1.0..+1.0 */
  score: number | null;
  /** デバッグ用 (ログのみ。DB 保存なし)。判定の根拠を 1 行で */
  rationale?: string;
}

/** 「対象外なので判定しなかった」を返すヘルパ (ルール2: silent skip しない) */
export function skipped(rationale: string): PdfSentimentResult {
  return { sentiment: "skipped", method: null, score: null, rationale };
}

/** 「対象だが判定不能」を返すヘルパ */
export function unknown(rationale: string): PdfSentimentResult {
  return { sentiment: "unknown", method: null, score: null, rationale };
}
