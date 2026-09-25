/**
 * parseVocabulary のテスト。zod の形検査と意味検査 (assertValidVocabulary)
 * の両方を必ず通ることを確認する (どちらか片方だけをすり抜ける経路が
 * 無いこと)。
 */
import { describe, expect, it } from "vitest";
import { MINI_VOCAB } from "./__fixtures__/mini-vocab.js";
import { parseVocabulary } from "./load.js";

describe("parseVocabulary", () => {
  it("実データ抜粋 (JSON 往復) をそのまま読み込める", () => {
    const json = JSON.parse(JSON.stringify(MINI_VOCAB));
    expect(parseVocabulary(json)).toEqual(MINI_VOCAB);
  });

  it("形が壊れている (business が無い) と throw する", () => {
    const json = JSON.parse(JSON.stringify(MINI_VOCAB));
    delete json.business;
    expect(() => parseVocabulary(json)).toThrow();
  });

  it("形は正しいが意味検査に落ちる (labelJa 重複) と throw する", () => {
    const json = JSON.parse(JSON.stringify(MINI_VOCAB));
    json.business[1].labelJa = json.business[0].labelJa;
    expect(() => parseVocabulary(json)).toThrow(/label_duplicate/);
  });

  it("null や配列など全く形の違う値は throw する", () => {
    expect(() => parseVocabulary(null)).toThrow();
    expect(() => parseVocabulary([])).toThrow();
    expect(() => parseVocabulary("not a vocabulary")).toThrow();
  });
});
