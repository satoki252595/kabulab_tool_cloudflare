/**
 * 文字 n-gram TF-IDF によるテキスト類似度 (競合他社の候補生成用)。
 * 設計: docs/005-yuho-quant-business-tags.md「事業タグから競合他社を導く」節。
 *
 * 「事業の内容」は日本語の複合語が多く分かち書き辞書が無いと単語分割が難しいため、
 * 単語帳の絞り込み (prefilter.ts) と同様に**辞書に依存しない文字 n-gram**で
 * テキスト類似度を測る。1 コーパス内の相対頻度 (IDF) だけを使うローカル計算で、
 * 外部ライブラリ・ネットワーク呼び出しは無い。
 */
import { normalizeForMatch } from "../text.js";

/** 文字 n-gram の n。2 (bigram) は日本語の複合語の多くを捉えつつ疎行列化しすぎない。 */
export const NGRAM_N = 2;

/** テキストを正規化した上で文字 n-gram の配列にする。 */
export function charNgrams(text: string, n: number = NGRAM_N): string[] {
  const normalized = normalizeForMatch(text);
  if (normalized.length < n) return normalized.length > 0 ? [normalized] : [];
  const grams: string[] = [];
  for (let i = 0; i <= normalized.length - n; i++) {
    grams.push(normalized.slice(i, i + n));
  }
  return grams;
}

/** 語 (n-gram) → 出現回数。 */
export type TermFreq = Map<string, number>;

export function termFreq(grams: string[]): TermFreq {
  const tf = new Map<string, number>();
  for (const g of grams) tf.set(g, (tf.get(g) ?? 0) + 1);
  return tf;
}

/**
 * コーパス全体 (文書ごとの TermFreq の配列) から IDF (逆文書頻度) を作る。
 * `idf(term) = ln((N + 1) / (df(term) + 1)) + 1` (平滑化。全文書に出る n-gram の
 * 重みが 0 未満にならないようにする定番の式)。
 */
export function buildIdf(docs: TermFreq[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const tf of docs) {
    for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const n = docs.length;
  const idf = new Map<string, number>();
  for (const [term, d] of df) {
    idf.set(term, Math.log((n + 1) / (d + 1)) + 1);
  }
  return idf;
}

/** TF-IDF ベクトル (L2 正規化済み)。コサイン類似度はそのまま内積で求められる。 */
export type Vector = Map<string, number>;

export function tfidfVector(tf: TermFreq, idf: Map<string, number>): Vector {
  const raw = new Map<string, number>();
  for (const [term, count] of tf) {
    const weight = count * (idf.get(term) ?? 0);
    if (weight > 0) raw.set(term, weight);
  }
  let normSq = 0;
  for (const w of raw.values()) normSq += w * w;
  const norm = Math.sqrt(normSq);
  if (norm === 0) return raw;
  const out = new Map<string, number>();
  for (const [term, w] of raw) out.set(term, w / norm);
  return out;
}

/** 2 つの (L2 正規化済み) ベクトルのコサイン類似度 (0..1 の想定。両方とも非負重みのため)。 */
export function cosineSimilarity(a: Vector, b: Vector): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, w] of small) {
    const wOther = large.get(term);
    if (wOther !== undefined) dot += w * wOther;
  }
  return dot;
}
