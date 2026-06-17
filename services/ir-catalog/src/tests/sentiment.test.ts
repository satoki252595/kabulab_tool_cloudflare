/**
 * 株主視点センチメント分類の固定テスト。
 *
 * 「方向が表題から確信できた時だけ」ポジ/ネガを付与するルールを test で固定する。
 * 新タグを足したくなった時はまずここを書いてから sentiment.ts を触ること
 * (ルール1: 方向を捏造しない / "それっぽい寄せ" の禁止)。
 */
import { describe, expect, it } from "vitest";
import {
  NEGATIVE_TAG_LIST,
  POSITIVE_TAG_LIST,
  rowSentiments,
  tagSentiment,
} from "../services/sentiment.js";

describe("tagSentiment", () => {
  it("positive: 上方修正 / 増配 / 自社株買い / 自己株式の消却", () => {
    expect(tagSentiment("上方修正")).toBe("positive");
    expect(tagSentiment("増配")).toBe("positive");
    expect(tagSentiment("自社株買い")).toBe("positive");
    expect(tagSentiment("自己株式の消却")).toBe("positive");
  });

  it("negative: 下方修正 / 減配・無配", () => {
    expect(tagSentiment("下方修正")).toBe("negative");
    expect(tagSentiment("減配・無配")).toBe("negative");
  });

  it("neutral: 方向が表題に明示されないタグ (代表例)", () => {
    // classify.ts で「方向不明時の中立タグ」として扱うもの
    expect(tagSentiment("配当政策の変更")).toBe("neutral");
    expect(tagSentiment("配当(決定・予想)")).toBe("neutral");
    expect(tagSentiment("業績予想の修正")).toBe("neutral");
    // 株主視点で解釈が分かれるもの
    expect(tagSentiment("M&A・資本提携")).toBe("neutral");
    expect(tagSentiment("特別損益")).toBe("neutral");
    expect(tagSentiment("エクイティファイナンス")).toBe("neutral");
    expect(tagSentiment("自己株式の処分")).toBe("neutral");
    expect(tagSentiment("株式分割・併合")).toBe("neutral");
    expect(tagSentiment("重要事象(調査等)")).toBe("neutral");
    expect(tagSentiment("訂正・取消")).toBe("neutral");
    expect(tagSentiment("人事・組織")).toBe("neutral");
  });

  it("neutral: 未知タグは neutral (捏造しない)", () => {
    expect(tagSentiment("ぜんぜん知らないタグ")).toBe("neutral");
    expect(tagSentiment("")).toBe("neutral");
  });
});

describe("rowSentiments", () => {
  it("空 tags は空 Set", () => {
    expect(rowSentiments([])).toEqual(new Set());
  });

  it("中立のみ → 空 Set", () => {
    expect(rowSentiments(["決算短信", "業績予想の修正"])).toEqual(new Set());
  });

  it("ポジ単独", () => {
    expect(rowSentiments(["上方修正"])).toEqual(new Set(["positive"]));
  });

  it("ネガ単独", () => {
    expect(rowSentiments(["減配・無配"])).toEqual(new Set(["negative"]));
  });

  it("ポジ + 中立は positive のみ", () => {
    expect(rowSentiments(["増配", "配当(決定・予想)"])).toEqual(
      new Set(["positive"])
    );
  });

  it("ポジとネガが同時に含まれる場合は両方返す (片側に丸めない)", () => {
    // 理論上の境界ケース。実データで起き得るかは別問題だが、関数の挙動を固定。
    expect(rowSentiments(["上方修正", "減配・無配"])).toEqual(
      new Set(["positive", "negative"])
    );
  });
});

describe("POSITIVE_TAG_LIST / NEGATIVE_TAG_LIST", () => {
  it("互いに排他", () => {
    const pos = new Set(POSITIVE_TAG_LIST);
    const neg = new Set(NEGATIVE_TAG_LIST);
    for (const t of pos) expect(neg.has(t)).toBe(false);
    for (const t of neg) expect(pos.has(t)).toBe(false);
  });

  it("件数固定 (誤って増減した時に検知できる)", () => {
    expect(POSITIVE_TAG_LIST.length).toBe(4);
    expect(NEGATIVE_TAG_LIST.length).toBe(2);
  });
});
