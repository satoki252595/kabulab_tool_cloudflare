/**
 * SHA-256（hex）。Worker と Node の両方で動く WebCrypto だけを使う。
 *
 * 用途: 事業タグ単語帳・台帳の JSON の改ざん検知（docs/005-yuho-quant-business-tags.md §3.2）、
 * Automation の合言葉の照合（ハッシュ同士を比べる）。
 */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 長さの等しい hex 文字列の定数時間比較（タイミングで一致位置を漏らさない）。
 * 長さが違えば false（ハッシュ同士の比較なので長さは秘密ではない）。
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
