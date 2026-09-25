/**
 * validateVocabulary / assertValidVocabulary のテスト。
 *
 * `MINI_VOCAB` (実データの抜粋。__fixtures__/mini-vocab.ts) はそのままだと
 * 検査を通る。各テストは複製 (`structuredClone`) してから 1 箇所だけ壊し、
 * 狙ったルール (issue の `code`) だけが検出されることを確認する。
 */
import { describe, expect, it } from "vitest";
import { MINI_VOCAB } from "./__fixtures__/mini-vocab.js";
import {
  NOTION_OPTIONS_PER_COLUMN_MAX,
  type BusinessTerm,
  type ThemeTerm,
  type Vocabulary,
} from "./schema.js";
import { assertValidVocabulary, validateVocabulary } from "./validate.js";

function codes(v: Vocabulary): string[] {
  return validateVocabulary(v).map((i) => i.code);
}

describe("validateVocabulary", () => {
  it("実データ抜粋の最小単語帳はそのまま検査を通る (0 件)", () => {
    expect(validateVocabulary(MINI_VOCAB)).toEqual([]);
  });

  it("business が空配列だと schema ルール (minLength) に落ちる", () => {
    const v = structuredClone(MINI_VOCAB);
    v.business = [];
    const issues = validateVocabulary(v);
    expect(issues.some((i) => i.code === "schema")).toBe(true);
  });

  it("id が重複していると duplicate_id を検出する", () => {
    const v = structuredClone(MINI_VOCAB);
    v.business[1].id = v.business[0].id;
    const issues = validateVocabulary(v);
    const dup = issues.filter((i) => i.code === "duplicate_id");
    expect(dup).toHaveLength(2);
    expect(dup.map((i) => i.termId)).toEqual([v.business[0].id, v.business[0].id]);
  });

  it("business id の系統トークンと family が食い違うと family_mismatch を検出する", () => {
    const v = structuredClone(MINI_VOCAB);
    const target = v.business.find((t) => t.id === "B.SEMI.SILICON_WAFER");
    if (!target) throw new Error("fixture に B.SEMI.SILICON_WAFER が無い");
    target.family = "MACH"; // id は B.SEMI.* のまま
    expect(codes(v)).toContain("family_mismatch");
  });

  it("labelJa が大文字小文字違いで衝突すると label_duplicate を両方に検出する", () => {
    const v = structuredClone(MINI_VOCAB);
    v.business[1].labelJa = v.business[0].labelJa.toUpperCase();
    const issues = validateVocabulary(v);
    const dup = issues.filter((i) => i.code === "label_duplicate");
    expect(dup.map((i) => i.termId).sort()).toEqual(
      [v.business[0].id, v.business[1].id].sort()
    );
  });

  it("labelJa に全角カンマを含むと label_forbidden_char を検出する", () => {
    const v = structuredClone(MINI_VOCAB);
    v.business[0].labelJa = "工作機械、産業用ロボット";
    expect(codes(v)).toContain("label_forbidden_char");
  });

  it("labelJa が LABEL_MAX_CHARS を超えると label_too_long を検出する", () => {
    const v = structuredClone(MINI_VOCAB);
    v.business[0].labelJa = "あ".repeat(41);
    expect(codes(v)).toContain("label_too_long");
  });

  it("1 列の非廃止 business が上限を超えると notion_option_limit を検出する", () => {
    const v = structuredClone(MINI_VOCAB);
    const template = v.business.find((t) => t.notionColumn === "upstream");
    if (!template) throw new Error("fixture に upstream の語が無い");
    const extra: BusinessTerm[] = Array.from(
      { length: NOTION_OPTIONS_PER_COLUMN_MAX + 1 },
      (_, i) => ({
        ...structuredClone(template),
        id: `B.${template.family}.EXTRA_${i}`,
        labelJa: `臨時追加語${i}`,
      })
    );
    v.business = [...v.business, ...extra];
    const issues = validateVocabulary(v);
    expect(issues.some((i) => i.code === "notion_option_limit")).toBe(true);
  });

  it("非廃止テーマが上限を超えると notion_option_limit を検出する", () => {
    const v = structuredClone(MINI_VOCAB);
    const template = v.themes[0];
    const extra: ThemeTerm[] = Array.from(
      { length: NOTION_OPTIONS_PER_COLUMN_MAX + 1 },
      (_, i) => ({
        ...structuredClone(template),
        id: `T.EXTRA_${i}`,
        labelJa: `臨時テーマ${i}`,
      })
    );
    v.themes = [...v.themes, ...extra];
    const issues = validateVocabulary(v);
    expect(issues.some((i) => i.code === "notion_option_limit")).toBe(true);
  });

  it("theme の構成語 id が business に存在しないと theme_member_missing を検出する", () => {
    const v = structuredClone(MINI_VOCAB);
    v.themes[0].members = ["B.NOT_EXIST.FOO"];
    const issues = validateVocabulary(v);
    expect(
      issues.some((i) => i.code === "theme_member_missing" && i.termId === v.themes[0].id)
    ).toBe(true);
  });

  it("非廃止テーマの構成語が全て廃止済みになると theme_no_active_member を検出する", () => {
    const v = structuredClone(MINI_VOCAB);
    const theme = v.themes.find((t) => t.id === "T.HYDROGEN");
    if (!theme) throw new Error("fixture に T.HYDROGEN が無い");
    for (const memberId of theme.members) {
      const member = v.business.find((t) => t.id === memberId);
      if (!member) throw new Error(`fixture に構成語 ${memberId} が無い`);
      member.deprecated = true;
    }
    const issues = validateVocabulary(v);
    expect(
      issues.some((i) => i.code === "theme_no_active_member" && i.termId === theme.id)
    ).toBe(true);
  });

  it("廃止済みテーマは構成語が全廃止でも theme_no_active_member を出さない", () => {
    const v = structuredClone(MINI_VOCAB);
    const theme = v.themes.find((t) => t.id === "T.HYDROGEN");
    if (!theme) throw new Error("fixture に T.HYDROGEN が無い");
    theme.deprecated = true;
    for (const memberId of theme.members) {
      const member = v.business.find((t) => t.id === memberId);
      if (!member) throw new Error(`fixture に構成語 ${memberId} が無い`);
      member.deprecated = true;
    }
    const issues = validateVocabulary(v);
    expect(issues.some((i) => i.code === "theme_no_active_member")).toBe(false);
  });

  it("keywords が空白のみだと keyword_empty を検出する", () => {
    const v = structuredClone(MINI_VOCAB);
    v.business[0].keywords.push(" ");
    expect(codes(v)).toContain("keyword_empty");
  });

  it("keywords 内に同じ語が重複していると keyword_duplicate を検出する", () => {
    const v = structuredClone(MINI_VOCAB);
    v.business[0].keywords.push(v.business[0].keywords[0]);
    expect(codes(v)).toContain("keyword_duplicate");
  });

  it("keywords と excludeKeywords に同じ語があると keyword_excludes_conflict を検出する", () => {
    const v = structuredClone(MINI_VOCAB);
    v.business[0].excludeKeywords.push(v.business[0].keywords[0]);
    expect(codes(v)).toContain("keyword_excludes_conflict");
  });

  it("出典 URL が https でないと source_url_not_https を検出する", () => {
    const v = structuredClone(MINI_VOCAB);
    v.business[0].sources[0].url = "http://example.com/not-https";
    expect(codes(v)).toContain("source_url_not_https");
  });

  it("addedIn が単語帳の版より新しいと added_in_future を検出する", () => {
    const v = structuredClone(MINI_VOCAB);
    v.business[0].addedIn = "v5"; // v.version は v1 のまま
    expect(codes(v)).toContain("added_in_future");
  });
});

describe("assertValidVocabulary", () => {
  it("問題が無ければ何もしない", () => {
    expect(() => assertValidVocabulary(MINI_VOCAB)).not.toThrow();
  });

  it("問題があれば全件を列挙して throw する", () => {
    const v = structuredClone(MINI_VOCAB);
    v.business[0].labelJa = "あ".repeat(41);
    v.business[1].labelJa = v.business[0].labelJa; // 2 つ目の問題 (label_duplicate) も混ぜる
    expect(() => assertValidVocabulary(v)).toThrowError(/label_too_long/);
    expect(() => assertValidVocabulary(v)).toThrowError(/label_duplicate/);
  });
});
