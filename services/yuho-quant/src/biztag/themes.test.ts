/**
 * themes.ts のユニットテスト。
 *
 * fixtures/test-vocab.json には「はい」集合に応じて拾われるべきテーマ
 * (T.SEMICONDUCTOR / T.DRUG_DISCOVERY)と、構成語が一致しても拾われては
 * いけない廃止済みテーマ(T.SEMI_ADVANCED_PACKAGING。テスト目的で
 * deprecated=true にしている)を用意している。
 */
import { describe, expect, it } from "vitest";
import { deriveThemes } from "./themes.js";
import rawVocab from "./fixtures/test-vocab.json" with { type: "json" };
import { VocabularySchema, type Vocabulary } from "./vocabulary/schema.js";

const vocab: Vocabulary = VocabularySchema.parse(rawVocab);

describe("deriveThemes", () => {
  it("『はい』語を 1 つ以上含むテーマを単語帳の並び順で返す", () => {
    const themes = deriveThemes(vocab, ["B.MED.NUCLEIC_ACID_DRUG"]);
    expect(themes.map((t) => t.id)).toEqual(["T.DRUG_DISCOVERY"]);
  });

  it("複数のテーマにまたがる語なら両方拾う(単語帳の並び順を保つ)", () => {
    const themes = deriveThemes(vocab, ["B.MAT.SEMICON_PACKAGE_SUBSTRATE"]);
    // T.SEMICONDUCTOR と T.SEMI_ADVANCED_PACKAGING はどちらも
    // B.MAT.SEMICON_PACKAGE_SUBSTRATE を構成語に持つが、後者は廃止済みなので
    // 拾われるのは前者だけ。
    expect(themes.map((t) => t.id)).toEqual(["T.SEMICONDUCTOR"]);
  });

  it("廃止済みテーマは構成語が『はい』でも拾わない", () => {
    const themes = deriveThemes(vocab, ["B.MAT.SEMICON_PACKAGE_SUBSTRATE"]);
    expect(themes.map((t) => t.id)).not.toContain("T.SEMI_ADVANCED_PACKAGING");
  });

  it("『はい』が無ければテーマも無い", () => {
    expect(deriveThemes(vocab, [])).toEqual([]);
    // このフィクスチャのどのテーマの構成語でもない id
    expect(deriveThemes(vocab, ["B.NOT_A_MEMBER_OF_ANY_THEME"])).toEqual([]);
  });

  it("B.SEMI.SILICON_WAFER は T.SEMICONDUCTOR の構成語でもある", () => {
    const themes = deriveThemes(vocab, ["B.SEMI.SILICON_WAFER"]);
    expect(themes.map((t) => t.id)).toEqual(["T.SEMICONDUCTOR"]);
  });

  it("『はい』集合が複数語にまたがれば重複なく1回だけ返す", () => {
    const themes = deriveThemes(vocab, ["B.MED.NUCLEIC_ACID_DRUG", "B.MED.INNOVATOR_DRUG"]);
    expect(themes.map((t) => t.id)).toEqual(["T.DRUG_DISCOVERY"]);
  });
});
