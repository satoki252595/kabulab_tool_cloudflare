/**
 * Engine 2: 形態素解析 + 極性辞書による文書スコアリング。
 *
 * 1. kuromoji で形態素分解 → 内容語 (名詞・動詞・形容詞) を抽出
 * 2. 各形態素を辞書 (用言/名詞) でマッチ → 極性 (±1) を取得
 * 3. **否定処理**: マッチ語の直後 3 形態素以内に否定 (「ない」「ません」
 *    「困難」「断念」等) があれば符号を反転
 * 4. ヒット総数で正規化したスコア (-1.0 〜 +1.0) を返す
 * 5. ヒット数が閾値未満は `unknown` (誤判定回避 — ルール2)
 * 6. スコア絶対値が閾値未満は `unknown` (片寄せ禁止)
 *
 * すべての判定は決定論的 (同じテキストは同じ結果)。乱数や時刻に依存しない。
 */
import type { PdfSentimentResult } from "../types.js";
import { unknown } from "../types.js";
import { loadDict } from "./load-dict.js";
import { tokenize, type Token } from "./tokenize.js";

/** 否定形態素のマッチ (簡易・3 形態素窓) */
const NEGATION_RX =
  /^(ない|ぬ|ません|なく|難い|困難|無い|無し|拒否|断念|中止|否|不|未)$/;

/** 内容語 POS のみ (助詞・記号・数値は除外) */
function isContentToken(t: Token): boolean {
  return t.pos === "名詞" || t.pos === "動詞" || t.pos === "形容詞";
}

/** マッチ語 i から窓 (n 形態素) 内に否定があるか */
function hasNegationAfter(tokens: Token[], i: number, window = 3): boolean {
  const end = Math.min(tokens.length, i + 1 + window);
  for (let j = i + 1; j < end; j++) {
    const t = tokens[j];
    const surf = t.surface_form ?? "";
    const base = t.basic_form ?? surf;
    if (NEGATION_RX.test(base) || NEGATION_RX.test(surf)) return true;
  }
  return false;
}

interface ScoreOptions {
  /** マッチ語の最低数 (これ未満は unknown) */
  minHits?: number;
  /** スコア絶対値の最低値 (これ未満は unknown) */
  minAbsScore?: number;
}

export async function classifyByDictionary(
  text: string,
  opts: ScoreOptions = {}
): Promise<PdfSentimentResult> {
  const minHits = opts.minHits ?? 6;
  const minAbsScore = opts.minAbsScore ?? 0.15;

  const dict = loadDict();
  let tokens: Token[];
  try {
    tokens = await tokenize(text);
  } catch (e) {
    return unknown(`kuromoji 初期化/解析失敗: ${(e as Error).message}`);
  }

  let pos = 0;
  let neg = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!isContentToken(t)) continue;
    const base = t.basic_form && t.basic_form !== "*" ? t.basic_form : t.surface_form;
    const surf = t.surface_form;
    // 用言辞書 (基本形優先) → 名詞辞書 (表層形優先) の順でマッチ
    let polarity = dict.wago.get(base) ?? dict.wago.get(surf);
    if (polarity === undefined) {
      polarity = dict.noun.get(surf) ?? dict.noun.get(base);
    }
    if (polarity === undefined) continue;
    const flipped = hasNegationAfter(tokens, i) ? -polarity : polarity;
    if (flipped > 0) pos++;
    else if (flipped < 0) neg++;
  }

  const hits = pos + neg;
  if (hits < minHits) {
    return unknown(`辞書マッチ ${hits} 件 (閾値 ${minHits} 未満)`);
  }
  // 正規化スコア (-1.0 〜 +1.0)
  const score = (pos - neg) / hits;
  if (Math.abs(score) < minAbsScore) {
    return {
      sentiment: "unknown",
      method: "dict_v1",
      score,
      rationale: `pos=${pos} neg=${neg} score=${score.toFixed(3)} (|score|<${minAbsScore})`,
    };
  }
  return {
    sentiment: score > 0 ? "positive" : "negative",
    method: "dict_v1",
    score,
    rationale: `pos=${pos} neg=${neg} score=${score.toFixed(3)}`,
  };
}
