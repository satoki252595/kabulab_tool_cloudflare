/**
 * jev 呼び出しの費用見積もり (docs/005-yuho-quant-business-tags.md §5.5)。
 *
 * 出力トークンは無料 (jev 課金体系。同 §5.5)。入力トークンのみ課金対象。
 */
import { JEV_PRICE_PER_MTOK_INPUT_USD } from "./client.js";

/** 入力トークン数から USD 費用を見積もる (出力は無料)。 */
export function estimateCostUsd(inputTokens: number): number {
  return (inputTokens / 1_000_000) * JEV_PRICE_PER_MTOK_INPUT_USD;
}
