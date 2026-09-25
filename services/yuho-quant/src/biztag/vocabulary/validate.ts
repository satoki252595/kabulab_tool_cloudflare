/**
 * 単語帳（語彙）の意味検査。設計: docs/005-yuho-quant-business-tags.md §4。
 *
 * 形の検査 (`VocabularySchema`) だけでは検出できない、語同士の関係や
 * Notion 側の制約を検査する。**テストと年次見直しの関門 (`pnpm biztag gate`)
 * が同じ関数を使う** ため、ここに書いたルールが単語帳の正の仕様になる。
 *
 * フォールバックはしない (ルール2): 壊れた単語帳を「直して」返すことは
 * せず、問題を `VocabIssue[]` として列挙するだけ。適用するかどうかは
 * 呼び出し側 (関門) が決める。
 */
import {
  BUSINESS_ID_PATTERN,
  LABEL_MAX_CHARS,
  NOTION_OPTIONS_PER_COLUMN_MAX,
  VocabularySchema,
  type BusinessTerm,
  type ThemeTerm,
  type Vocabulary,
} from "./schema.js";

export interface VocabIssue {
  /** 機械可読なルール ID (テストで特定のルールを狙い撃ちするために使う) */
  code: string;
  /** 関係する語の id (単語帳全体に関わる場合は省略) */
  termId?: string;
  message: string;
}

/** ラベルに使えない区切り文字 (Notion の multi_select はカンマ区切りのため) */
const LABEL_FORBIDDEN_CHARS = [",", "，", "、"];

function allTerms(v: Vocabulary): Array<BusinessTerm | ThemeTerm> {
  return [...v.business, ...v.themes];
}

/**
 * 版名 (`v1`, `v2`, ...) から数値部分を取り出す。形式が
 * `VERSION_PATTERN` と一致しないときは `undefined`
 * (呼び出し側は「別ルールで既に報告済みの形式エラー」として比較を
 * スキップする — 不正な形式に対して適当な既定値で数値比較を続けない)。
 */
function versionNumber(version: string): number | undefined {
  const m = /^v([1-9][0-9]*)$/.exec(version);
  return m ? Number(m[1]) : undefined;
}

/**
 * 単語帳を検査し、見つかった問題を全て返す (0 件 = 問題なし)。
 * 1 つ検査に失敗しても残りの検査は続ける (できるだけ多くの問題を一度に
 * 報告するため)。
 */
export function validateVocabulary(v: Vocabulary): VocabIssue[] {
  const issues: VocabIssue[] = [];

  // 1. 形 (zod)。以降の意味検査の前提 (id が文字列である等) は TS の型で
  //    保証されているので、形が壊れていても続けて実行する。
  const parsed = VocabularySchema.safeParse(v);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        code: "schema",
        message: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      });
    }
  }

  const terms = allTerms(v);

  // 2. id の重複 (business + theme 通し)。
  const idCounts = new Map<string, number>();
  for (const t of terms) idCounts.set(t.id, (idCounts.get(t.id) ?? 0) + 1);
  for (const t of terms) {
    if ((idCounts.get(t.id) ?? 0) > 1) {
      issues.push({
        code: "duplicate_id",
        termId: t.id,
        message: `id が重複しています: ${t.id}`,
      });
    }
  }

  // 2'. business id の系統トークンと family フィールドの一致。
  for (const t of v.business) {
    const m = BUSINESS_ID_PATTERN.exec(t.id);
    const idFamily = m?.[1];
    if (idFamily !== undefined && idFamily !== t.family) {
      issues.push({
        code: "family_mismatch",
        termId: t.id,
        message: `id の系統トークン "${idFamily}" と family "${t.family}" が一致しません`,
      });
    }
  }

  // 3. labelJa の一意性 (大文字小文字を無視・廃止済みも含めて全語)・
  //    禁止文字・文字数上限。
  const labelGroups = new Map<string, string[]>();
  for (const t of terms) {
    const key = t.labelJa.toLowerCase();
    const group = labelGroups.get(key) ?? [];
    group.push(t.id);
    labelGroups.set(key, group);
  }
  for (const t of terms) {
    const group = labelGroups.get(t.labelJa.toLowerCase()) ?? [];
    if (group.length > 1) {
      issues.push({
        code: "label_duplicate",
        termId: t.id,
        message: `labelJa "${t.labelJa}" が他の語と重複しています (${group.filter((id) => id !== t.id).join(", ")})`,
      });
    }
    if (LABEL_FORBIDDEN_CHARS.some((c) => t.labelJa.includes(c))) {
      issues.push({
        code: "label_forbidden_char",
        termId: t.id,
        message: `labelJa にカンマ相当の文字を含められません: "${t.labelJa}"`,
      });
    }
    if (t.labelJa.length > LABEL_MAX_CHARS) {
      issues.push({
        code: "label_too_long",
        termId: t.id,
        message: `labelJa が ${LABEL_MAX_CHARS} 字を超えています (${t.labelJa.length} 字): "${t.labelJa}"`,
      });
    }
  }

  // 4. Notion 選択肢数の上限 (非廃止のみ)。
  for (const column of ["upstream", "downstream"] as const) {
    const count = v.business.filter((t) => t.notionColumn === column && !t.deprecated).length;
    if (count > NOTION_OPTIONS_PER_COLUMN_MAX) {
      issues.push({
        code: "notion_option_limit",
        message: `列 "${column}" の非廃止語が上限 ${NOTION_OPTIONS_PER_COLUMN_MAX} を超えています (${count} 件)`,
      });
    }
  }
  const activeThemeCount = v.themes.filter((t) => !t.deprecated).length;
  if (activeThemeCount > NOTION_OPTIONS_PER_COLUMN_MAX) {
    issues.push({
      code: "notion_option_limit",
      message: `投資テーマの非廃止語が上限 ${NOTION_OPTIONS_PER_COLUMN_MAX} を超えています (${activeThemeCount} 件)`,
    });
  }

  // 5. theme の構成語。
  //    - 参照先が実在しない (id が business に無い) 場合は常に問題
  //      (廃止済みの語を構成語として残すこと自体は許容する — id は
  //      使い回さないので、廃止済みでも実在すれば「歴史的な構成語」
  //      として辿れることに意味がある)。
  //    - ただし **非廃止の theme** が構成語を 1 つも「今アクティブな
  //      business 語」として持てていなければ、そのテーマは判定結果に
  //      絶対に現れない死んだテーマになるため問題とする
  //      (廃止済みの theme は対象外 — 既に使われていないので構成語の
  //      鮮度は問わない)。
  const businessById = new Map(v.business.map((t) => [t.id, t] as const));
  for (const theme of v.themes) {
    let activeMemberCount = 0;
    for (const memberId of theme.members) {
      const member = businessById.get(memberId);
      if (!member) {
        issues.push({
          code: "theme_member_missing",
          termId: theme.id,
          message: `構成語 "${memberId}" が business 語に存在しません`,
        });
        continue;
      }
      if (!member.deprecated) activeMemberCount++;
    }
    if (!theme.deprecated && activeMemberCount === 0) {
      issues.push({
        code: "theme_no_active_member",
        termId: theme.id,
        message: "非廃止の構成語が 1 つもありません (このテーマは判定結果に現れません)",
      });
    }
  }

  // 6. keywords: 正規化後も空でない・語内で一意。
  for (const t of v.business) {
    const seen = new Set<string>();
    for (const kw of t.keywords) {
      const normalized = kw.trim();
      if (normalized.length === 0) {
        issues.push({
          code: "keyword_empty",
          termId: t.id,
          message: `keywords に空白のみの語が含まれています: "${kw}"`,
        });
        continue;
      }
      if (seen.has(normalized)) {
        issues.push({
          code: "keyword_duplicate",
          termId: t.id,
          message: `keywords 内で重複しています: "${kw}"`,
        });
      }
      seen.add(normalized);
    }

    // 9. keyword と excludeKeyword が同じ語で矛盾している。
    const excludeSet = new Set(t.excludeKeywords.map((k) => k.trim()));
    for (const kw of t.keywords) {
      if (excludeSet.has(kw.trim())) {
        issues.push({
          code: "keyword_excludes_conflict",
          termId: t.id,
          message: `keywords と excludeKeywords の両方に "${kw}" があります`,
        });
      }
    }
  }

  // 7. 出典 URL が https (schema の regex と重複するが、意味検査としても
  //    明示しておく — schema を経由しない経路 (proposal の中間状態等) で
  //    呼ばれても検出できるように)。
  for (const t of terms) {
    for (const src of t.sources) {
      if (!src.url.startsWith("https://")) {
        issues.push({
          code: "source_url_not_https",
          termId: t.id,
          message: `出典 URL が https ではありません: "${src.url}"`,
        });
      }
    }
  }

  // 8. addedIn ≤ version (数値比較)。どちらかの形式が不正なときは
  //    (1. で既に報告済みなので) 比較をスキップする — 不正な形式に
  //    適当な既定値を当てて比較を続けない。
  const vocabVersionNumber = versionNumber(v.version);
  if (vocabVersionNumber !== undefined) {
    for (const t of terms) {
      const addedInNumber = versionNumber(t.addedIn);
      if (addedInNumber !== undefined && addedInNumber > vocabVersionNumber) {
        issues.push({
          code: "added_in_future",
          termId: t.id,
          message: `addedIn (${t.addedIn}) が単語帳の版 (${v.version}) より新しいです`,
        });
      }
    }
  }

  return issues;
}

/** 検査して 1 件でも問題があれば、全件を列挙して throw する。 */
export function assertValidVocabulary(v: Vocabulary): void {
  const issues = validateVocabulary(v);
  if (issues.length === 0) return;
  const lines = issues.map(
    (i) => `- [${i.code}]${i.termId ? ` ${i.termId}:` : ""} ${i.message}`
  );
  throw new Error(`単語帳の検査に失敗しました (${issues.length} 件):\n${lines.join("\n")}`);
}
