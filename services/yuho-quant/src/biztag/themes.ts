/**
 * 投資テーマの導出。設計: docs/005-yuho-quant-business-tags.md §5.6。
 *
 * 投資テーマは判定しない。「はい」となった business 語の集合から
 * **決定的に**導く(theme 層は jev に問い合わせない)。
 */
import type { ThemeTerm, Vocabulary } from "./vocabulary/schema.js";

/**
 * 「はい」判定の business 語 id (`yesTermIds`) を 1 つ以上構成語に含む、
 * 廃止されていない投資テーマを単語帳の並び順で返す。
 */
export function deriveThemes(vocab: Vocabulary, yesTermIds: readonly string[]): ThemeTerm[] {
  const yesSet = new Set(yesTermIds);
  return vocab.themes.filter(
    (theme) => !theme.deprecated && theme.members.some((memberId) => yesSet.has(memberId))
  );
}
