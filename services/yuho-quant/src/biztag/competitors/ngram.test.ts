import { describe, expect, it } from "vitest";
import { buildIdf, charNgrams, cosineSimilarity, termFreq, tfidfVector } from "./ngram.js";

describe("charNgrams", () => {
  it("文字2-gramを作る", () => {
    expect(charNgrams("あいうえお")).toEqual(["あい", "いう", "うえ", "えお"]);
  });

  it("正規化してから n-gram にする(全角・半角揺れを吸収)", () => {
    // normalizeForMatch は NFKC + 長音統一等を行う。半角カナ「ｱｲｳ」は全角へ。
    expect(charNgrams("ｱｲｳ")).toEqual(charNgrams("アイウ"));
  });

  it("n未満の短い文字列は1件だけ返す(空にしない)", () => {
    expect(charNgrams("あ")).toEqual(["あ"]);
  });

  it("空文字列は空配列", () => {
    expect(charNgrams("")).toEqual([]);
  });
});

describe("buildIdf + tfidfVector + cosineSimilarity", () => {
  it("同一文書同士のコサイン類似度は1に近い(自己相関)", () => {
    const docs = [termFreq(charNgrams("半導体製造装置の開発")), termFreq(charNgrams("食品の製造販売"))];
    const idf = buildIdf(docs);
    const v0 = tfidfVector(docs[0], idf);
    expect(cosineSimilarity(v0, v0)).toBeCloseTo(1, 6);
  });

  it("全く異なる文書同士は類似度が低い", () => {
    const docs = [termFreq(charNgrams("半導体製造装置の開発")), termFreq(charNgrams("食品の製造販売"))];
    const idf = buildIdf(docs);
    const v0 = tfidfVector(docs[0], idf);
    const v1 = tfidfVector(docs[1], idf);
    const vSame = tfidfVector(docs[0], idf);
    expect(cosineSimilarity(v0, v1)).toBeLessThan(cosineSimilarity(v0, vSame));
  });

  it("似た文書同士は類似度が高い", () => {
    const docs = [
      termFreq(charNgrams("半導体製造装置の開発・製造・販売")),
      termFreq(charNgrams("半導体製造装置及び検査装置の開発・製造・販売")),
      termFreq(charNgrams("食品の製造販売及び物流")),
    ];
    const idf = buildIdf(docs);
    const vs = docs.map((d) => tfidfVector(d, idf));
    const semiSemi = cosineSimilarity(vs[0], vs[1]);
    const semiFood = cosineSimilarity(vs[0], vs[2]);
    expect(semiSemi).toBeGreaterThan(semiFood);
  });
});
