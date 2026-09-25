/**
 * Notion `rich_text` の分割・結合ユーティリティ。
 *
 * `archive.ts` / `stock-text.ts` は用途固有の私的な分割関数を既に持つ
 * (空文字列でも 1 要素を置きたい・code block 用等、意図的に挙動が違う)。
 * 本モジュールはそれらを置き換えるものではなく、**新規コード
 * (`stock-supplement.ts` / `biztag-ledger.ts` 等) が最初に選ぶべき共通実装**
 * として追加する (CLAUDE.md ルール2: 2000 文字上限を超えて欠落させない)。
 */

/** rich_text 1 要素の content 上限 (公式 /reference/request-limits) */
export const RICH_TEXT_MAX = 2000;

export interface RichTextChunk {
  type: "text";
  text: { content: string };
}

/**
 * 文字列を rich_text 要素の配列へ分割する (欠落させない — ルール2)。
 *
 * - サロゲートペアを割らない (UTF-16 の上位/下位を別チャンクへ分離しない)。
 * - 各チャンクの長さ (UTF-16 コード単位) は `max` 以下。
 * - 空文字列は空配列 (`[]`) を返す。「値が無い」ことを表す (プロパティを
 *   クリアする側の呼び出し元がこれで `{ rich_text: [] }` を作れる)。
 *
 * `max` が 1 の場合など極端に小さい値ではサロゲートペア回避を優先できず
 * ペアを割ることがあるが、実運用の `max` は常に 2000 前後のため実害はない。
 */
export function splitRichText(
  text: string,
  max: number = RICH_TEXT_MAX
): RichTextChunk[] {
  if (text.length === 0) return [];
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`splitRichText: max は 1 以上の整数でなければなりません (max=${max})`);
  }
  const out: RichTextChunk[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + max, text.length);
    if (end < text.length && end - i > 1) {
      const code = text.charCodeAt(end - 1);
      // 上位サロゲート (U+D800-DBFF) で終わるなら 1 文字戻して割らない
      if (code >= 0xd800 && code <= 0xdbff) {
        end -= 1;
      }
    }
    out.push({ type: "text", text: { content: text.slice(i, end) } });
    i = end;
  }
  return out;
}

/**
 * Notion から読み戻した rich_text 配列を平文へ結合する。
 * `plain_text` があれば優先し、無ければ `text.content` を使う
 * (テスト等で `plain_text` のみ・`text.content` のみ双方に対応するため)。
 * `undefined` は空文字列として扱う (プロパティ未設定)。
 */
export function joinRichText(
  rich:
    | Array<{ plain_text?: string; text?: { content: string } }>
    | undefined
): string {
  return (rich ?? []).map((r) => r.plain_text ?? r.text?.content ?? "").join("");
}
