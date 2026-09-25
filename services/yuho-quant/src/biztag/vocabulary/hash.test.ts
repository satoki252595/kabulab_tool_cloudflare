/**
 * canonicalJson / vocabularyHash のテスト。
 *
 * 台帳 DB は「本文 JSON の SHA-256」を照合キーにする (docs/005 §3.2) ので、
 * キー順の違いや配列順の意味を取り違えるとハッシュが再現できなくなる。
 */
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../../../../src/shared/sha256.js";
import { MINI_VOCAB } from "./__fixtures__/mini-vocab.js";
import { canonicalJson, vocabularyHash } from "./hash.js";

describe("canonicalJson", () => {
  it("キー順が違っても同じ正規化文字列になる", () => {
    const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
    const b = { a: 2, c: { y: 2, z: 1 }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("配列の要素順は変えない (意味を持つため)", () => {
    const a = { list: [1, 2, 3] };
    const b = { list: [3, 2, 1] };
    expect(canonicalJson(a)).not.toBe(canonicalJson(b));
  });

  it("値そのものが違えば正規化文字列も違う", () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });

  it("空白を含まない (JSON.stringify の既定と同じくコンパクト)", () => {
    expect(canonicalJson({ a: 1, b: [1, 2] })).toBe('{"a":1,"b":[1,2]}');
  });
});

describe("vocabularyHash", () => {
  it("sha256Hex(canonicalJson(v)) と一致する", async () => {
    const expected = await sha256Hex(canonicalJson(MINI_VOCAB));
    expect(await vocabularyHash(MINI_VOCAB)).toBe(expected);
  });

  it("64 桁の16進文字列を返す", async () => {
    const h = await vocabularyHash(MINI_VOCAB);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("内容が同じなら (再構築しても) 同じハッシュになる", async () => {
    const clone = structuredClone(MINI_VOCAB);
    expect(await vocabularyHash(clone)).toBe(await vocabularyHash(MINI_VOCAB));
  });

  it("1 語でも変わればハッシュが変わる", async () => {
    const clone = structuredClone(MINI_VOCAB);
    clone.business[0].keywords.push("追加キーワード");
    expect(await vocabularyHash(clone)).not.toBe(await vocabularyHash(MINI_VOCAB));
  });
});
