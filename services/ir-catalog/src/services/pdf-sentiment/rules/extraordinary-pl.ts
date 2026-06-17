/**
 * Engine 1 ルール: 特別損益 PDF → positive/negative/mixed/unknown
 *
 * 「特別利益」「特別損失」「減損損失」を含む適時開示は表題から方向不明だが、
 * 本文では金額付きで明示される。本ルールは:
 *
 * 1. テキスト内で「特別利益」「特別損失」「減損損失」のキーワードを検出
 * 2. 各キーワード直後 (~80 文字) から金額を抽出
 * 3. 利益 vs 損失の金額差で方向判定:
 *    - 損失のみ → negative
 *    - 利益のみ → positive
 *    - 両方ある場合は絶対値の大きい方を採用、規模が同程度なら mixed
 * 4. 金額不明確は `unknown` (規模を捏造しない)
 *
 * 注: タイトル分類 classify.ts が「特別損益」タグを付けるのは
 *     「特別損失/特別利益/特損/減損損失/減損の計上」が表題にある場合のみ。
 *     表題に「特別損失」とだけ書かれている場合、それ自体が方向を示唆するが、
 *     PDF 本文の金額抽出も併走させて mixed や規模判定を可能にする。
 */
import type { PdfSentimentResult } from "../types.js";
import { unknown } from "../types.js";
import { normalizeForNumber, parseAmount } from "./numbers.js";

interface AmountHit {
  kind: "loss" | "gain";
  amount: number; // 円換算
}

const LOSS_KEYS = [
  "特別損失",
  "減損損失",
  "特損",
  "減損の計上",
  "減損損失の計上",
] as const;
const GAIN_KEYS = ["特別利益", "特益"] as const;

function findAmountsNear(
  text: string,
  key: string,
  kind: AmountHit["kind"]
): AmountHit[] {
  const norm = normalizeForNumber(text);
  const hits: AmountHit[] = [];
  let idx = 0;
  while (idx < norm.length) {
    const found = norm.indexOf(key, idx);
    if (found < 0) break;
    const slice = norm.slice(found, found + key.length + 100);
    const m = slice.match(
      /(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(百万円|千円|億円|兆円|円)/
    );
    if (m) {
      const amount = parseAmount(`${m[1]}${m[2]}`);
      if (Number.isFinite(amount) && amount > 0) {
        hits.push({ kind, amount });
      }
    }
    idx = found + key.length;
  }
  return hits;
}

export function classifyExtraordinaryPL(text: string): PdfSentimentResult {
  const losses: AmountHit[] = [];
  const gains: AmountHit[] = [];
  for (const k of LOSS_KEYS) losses.push(...findAmountsNear(text, k, "loss"));
  for (const k of GAIN_KEYS) gains.push(...findAmountsNear(text, k, "gain"));

  if (losses.length === 0 && gains.length === 0) {
    return unknown("特別損益キーワード近傍に金額を抽出できなかった");
  }

  const sumLoss = losses.reduce((a, b) => a + b.amount, 0);
  const sumGain = gains.reduce((a, b) => a + b.amount, 0);

  if (sumLoss > 0 && sumGain === 0) {
    return {
      sentiment: "negative",
      method: "rule_v1",
      score: 1.0,
      rationale: `特別損失合計=${sumLoss}円`,
    };
  }
  if (sumGain > 0 && sumLoss === 0) {
    return {
      sentiment: "positive",
      method: "rule_v1",
      score: 1.0,
      rationale: `特別利益合計=${sumGain}円`,
    };
  }

  // 両方ある場合、規模差が 2 倍以上なら大きい方を採用、未満なら mixed
  const ratio = sumLoss > sumGain ? sumLoss / sumGain : sumGain / sumLoss;
  if (!Number.isFinite(ratio) || ratio < 2) {
    return {
      sentiment: "mixed",
      method: "rule_v1",
      score: 1.0,
      rationale: `損失=${sumLoss}円 / 利益=${sumGain}円 (規模差<2倍)`,
    };
  }
  return {
    sentiment: sumLoss > sumGain ? "negative" : "positive",
    method: "rule_v1",
    score: 1.0,
    rationale: `損失=${sumLoss}円 / 利益=${sumGain}円 (大規模側を採用)`,
  };
}
