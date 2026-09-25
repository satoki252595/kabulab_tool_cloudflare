/**
 * 単語帳 2 版の差分。年次見直しの関門 (docs/005-yuho-quant-business-tags.md
 * §6.3「変更量」) が「変わる語は有効な語の 2 割まで」「1 系統の廃止は
 * 全体の 1 割まで」を判定するために使う。台帳 DB の「差分」列 (追加・
 * 変更・廃止の語 ID 一覧) もここから作る。
 */
import { canonicalJson } from "./hash.js";
import type { BusinessTerm, ThemeTerm, Vocabulary } from "./schema.js";

export interface VocabDiff {
  /** to にだけ存在する id (business + theme) */
  added: string[];
  /** from では非廃止だったが、to で廃止済み or 消滅した id */
  deprecated: string[];
  /** addedIn を除く何らかのフィールドが変わった id (from にも to にも存在) */
  changed: string[];
  /** changed のうち labelJa が変わった id */
  renamed: string[];
  /** added ∪ deprecated ∪ changed (business + theme 通し・昇順) */
  changedTermIds: string[];
}

function termMap(v: Vocabulary): Map<string, BusinessTerm | ThemeTerm> {
  const map = new Map<string, BusinessTerm | ThemeTerm>();
  for (const t of v.business) map.set(t.id, t);
  for (const t of v.themes) map.set(t.id, t);
  return map;
}

/** addedIn を除いたフィールドだけを比較する (版が上がるたびに addedIn 自体は変わらないので比較対象に含めない)。 */
function withoutAddedIn(t: BusinessTerm | ThemeTerm): unknown {
  const { addedIn: _addedIn, ...rest } = t;
  return rest;
}

/**
 * from → to の差分を計算する (純粋関数。ネットワーク・DB I/O なし)。
 */
export function diffVocabularies(from: Vocabulary, to: Vocabulary): VocabDiff {
  const fromMap = termMap(from);
  const toMap = termMap(to);

  const added: string[] = [];
  const deprecated: string[] = [];
  const changed: string[] = [];
  const renamed: string[] = [];

  for (const id of toMap.keys()) {
    if (!fromMap.has(id)) added.push(id);
  }

  for (const [id, fromTerm] of fromMap) {
    const toTerm = toMap.get(id);
    const wasActive = !fromTerm.deprecated;

    if (!toTerm) {
      // id は使い回さない運用のはずだが、万一 to から消えていたら
      // 「廃止扱い」として検出する (黙って見逃さない)。
      if (wasActive) deprecated.push(id);
      continue;
    }

    if (wasActive && toTerm.deprecated) {
      deprecated.push(id);
    }

    if (canonicalJson(withoutAddedIn(fromTerm)) !== canonicalJson(withoutAddedIn(toTerm))) {
      changed.push(id);
      if (fromTerm.labelJa !== toTerm.labelJa) renamed.push(id);
    }
  }

  added.sort();
  deprecated.sort();
  changed.sort();
  renamed.sort();

  const changedTermIds = Array.from(new Set([...added, ...deprecated, ...changed])).sort();

  return { added, deprecated, changed, renamed, changedTermIds };
}

/**
 * 変化量の比率。関門の「変更量」判定 (§6.3-4) の入力になる。
 *
 * - `changedRatio`: 変わった語数 / from の非廃止語数 (business + theme 通し)。
 * - `deprecatedRatioByFamily`: 系統ごとの「今回廃止した business 語数」 /
 *   「from の非廃止 business 語数 (全系統合計)」。分母を系統ごとにせず
 *   全体にするのは、設計書の「1 系統の廃止は全体の 1 割まで」が
 *   *単語帳全体に対する比率* を指しているため。廃止が 0 件だった系統は
 *   キーを作らない (0 埋めは意味のある情報を持たないので載せない)。
 */
export function changeStats(
  from: Vocabulary,
  diff: VocabDiff
): { changedRatio: number; deprecatedRatioByFamily: Record<string, number> } {
  const activeBusinessCount = from.business.filter((t) => !t.deprecated).length;
  const activeThemeCount = from.themes.filter((t) => !t.deprecated).length;
  const activeTotal = activeBusinessCount + activeThemeCount;
  if (activeTotal === 0) {
    throw new Error("changeStats: from に非廃止の語が 1 件もないため変化率を計算できません");
  }
  const changedRatio = diff.changedTermIds.length / activeTotal;

  if (activeBusinessCount === 0) {
    throw new Error(
      "changeStats: from に非廃止の business 語が 1 件もないため系統別廃止率を計算できません"
    );
  }
  const businessById = new Map(from.business.map((t) => [t.id, t] as const));
  const deprecatedCountByFamily = new Map<string, number>();
  for (const id of diff.deprecated) {
    const term = businessById.get(id);
    if (!term) continue; // theme の廃止 (id が t.name 側) は系統を持たない
    deprecatedCountByFamily.set(term.family, (deprecatedCountByFamily.get(term.family) ?? 0) + 1);
  }
  const deprecatedRatioByFamily: Record<string, number> = {};
  for (const [family, count] of deprecatedCountByFamily) {
    deprecatedRatioByFamily[family] = count / activeBusinessCount;
  }

  return { changedRatio, deprecatedRatioByFamily };
}
