/**
 * 単語帳の改ざん検知用ハッシュ。設計: docs/005-yuho-quant-business-tags.md §3.2。
 *
 * 台帳 DB (`biztag-ledger.ts`) は本文 JSON と「ハッシュ」列を持ち、読むとき
 * 一致を照合する (一致しなければ throw)。書く側・読む側・テストが同じ
 * ハッシュ値を得られるよう、キー順を固定した正規化 JSON に対して
 * SHA-256 を取る。Worker (WebCrypto) と Node の両方で動く
 * `src/shared/sha256.ts` を使う。
 */
import { sha256Hex } from "../../../../../src/shared/sha256.js";
import type { Vocabulary } from "./schema.js";

/**
 * オブジェクトのキーをコードポイント順に再帰的に並べ替えた値を返す。
 * 配列の要素順は意味を持つ (`keywords` の並び等) ため変えない。
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = canonicalize(record[key]);
    }
    return sorted;
  }
  return value;
}

/** キー順固定・空白なしの JSON 文字列 (ハッシュ入力の正準形)。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** 単語帳全体の SHA-256 (hex)。 */
export async function vocabularyHash(v: Vocabulary): Promise<string> {
  return sha256Hex(canonicalJson(v));
}
