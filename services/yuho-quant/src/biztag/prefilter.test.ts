/**
 * prefilter.ts のユニットテスト。
 *
 * 単語帳は fixtures/test-vocab.json (実際の単語帳ドラフトから抜粋した実在の語)、
 * 入力テキストは fixtures/ の実コーパステキストを使う。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prefilter } from "./prefilter.js";
import rawVocab from "./fixtures/test-vocab.json" with { type: "json" };
import { VocabularySchema, type Vocabulary } from "./vocabulary/schema.js";

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fx = (name: string) => readFileSync(join(FX, name), "utf8");

const vocab: Vocabulary = VocabularySchema.parse(rawVocab);

describe("prefilter", () => {
  it("味の素の実文(研究開発活動節)から ABF 関連語が候補になる(節キーは実際の rnd)", () => {
    // fixtures/2802-ajinomoto-rnd-abf.txt: 味の素 有報 S100Y992 の
    // 「研究開発活動」節の実文。B.MAT.SEMICON_PACKAGE_SUBSTRATE の
    // keyword「ABF」が実際にヒットする。
    const rndExcerpt = fx("2802-ajinomoto-rnd-abf.txt");
    const result = prefilter(vocab, { rnd: rndExcerpt });

    expect(result.candidates.map((c) => c.term.id)).toEqual(["B.MAT.SEMICON_PACKAGE_SUBSTRATE"]);
    const hits = result.candidates[0].hits;
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.keyword).toBe("ABF");
      expect(hit.sectionKey).toBe("rnd");
      // 引用は原文からそのまま切り出されている
      expect(rndExcerpt.slice(hit.sentence.start, hit.sentence.end)).toBe(hit.sentence.text);
    }

    // 廃止済み(このフィクスチャでは B.MED.VACCINE を意図的に deprecated=true にしている)
    // 語は候補にも「語なし」にも出ない
    const allTermIds = [...result.candidates.map((c) => c.term.id), ...result.noHitTermIds];
    expect(allTermIds).not.toContain("B.MED.VACCINE");
    expect(result.noHitTermIds.sort()).toEqual(
      ["B.MED.NUCLEIC_ACID_DRUG", "B.MED.INNOVATOR_DRUG", "B.SEMI.SILICON_WAFER"].sort()
    );
  });

  it("リボミックの実文から核酸医薬・創薬の候補が『事業の内容』『セグメント情報』の両方から出る", () => {
    const business = fx("4591-ribomic-business.txt");
    const segment = fx("4591-ribomic-segment-info.txt");
    const result = prefilter(vocab, { business, segment_info: segment });

    const byId = new Map(result.candidates.map((c) => [c.term.id, c.hits]));
    expect(byId.has("B.MED.NUCLEIC_ACID_DRUG")).toBe(true);
    expect(byId.has("B.MED.INNOVATOR_DRUG")).toBe(true);
    expect(byId.has("B.MAT.SEMICON_PACKAGE_SUBSTRATE")).toBe(false);
    expect(byId.has("B.SEMI.SILICON_WAFER")).toBe(false);

    const innovatorHits = byId.get("B.MED.INNOVATOR_DRUG")!;
    const sectionKeys = new Set(innovatorHits.map((h) => h.sectionKey));
    expect(sectionKeys.has("business")).toBe(true);
    expect(sectionKeys.has("segment_info")).toBe(true);

    expect(result.noHitTermIds.sort()).toEqual(
      ["B.MAT.SEMICON_PACKAGE_SUBSTRATE", "B.SEMI.SILICON_WAFER"].sort()
    );
  });

  it("MD&A 節からも候補が出る(リボミックの実際の MD&A 節。研究開発費・希少疾病用医薬品指定等の実記述)", () => {
    // fixtures/4591-ribomic-mda.txt: リボミック 有報 S100YF0X (2026-03-31期)
    // の実際の「経営者による財政状態、経営成績及びキャッシュ・フローの状況の
    // 分析」節 (ローカルコーパススナップショットより。既存の
    // 4591-ribomic-business.txt/segment-info.txt とは書類IDが異なる別取得分)。
    const mda = fx("4591-ribomic-mda.txt");
    const result = prefilter(vocab, { mda });

    const byId = new Map(result.candidates.map((c) => [c.term.id, c.hits]));
    expect(byId.has("B.MED.NUCLEIC_ACID_DRUG")).toBe(true); // 「アプタマー」
    expect(byId.has("B.MED.INNOVATOR_DRUG")).toBe(true); // 「創薬」「承認申請」「希少疾病用医薬品」
    for (const hits of byId.values()) {
      for (const hit of hits) {
        expect(hit.sectionKey).toBe("mda");
        expect(mda.slice(hit.sentence.start, hit.sentence.end)).toBe(hit.sentence.text);
      }
    }
  });

  it("境界規則が節をまたいで効く: ASCII キーワードが英単語の一部に当たっても候補にならない(清水銀行の実文)", () => {
    // fixtures/8364-shimizu-bank-mda-boundary.txt: 清水銀行 有報 S100YC9F
    // (2026-03-31期) の MD&A 節の実文の一部。中期経営計画の愛称
    // 「KASOKU」に "ASO" (B.MED.NUCLEIC_ACID_DRUG の keyword) が部分一致するが、
    // 前後が ASCII 英数字 (K/K) のため matchesKeyword の境界規則で弾かれ、
    // 候補にならない (このテキストには他に単語帳のどの keyword も含まれない)。
    const mda = fx("8364-shimizu-bank-mda-boundary.txt");
    expect(mda).toContain("KASOKU");
    const result = prefilter(vocab, { mda });

    expect(result.candidates).toEqual([]);
    expect(result.noHitTermIds).toContain("B.MED.NUCLEIC_ACID_DRUG");
  });

  it("excludeKeywords に当たる文はヒットに数えない(サスメド 有報 S100WR1U の実文)", () => {
    // B.MED.INNOVATOR_DRUG の keyword「新薬」と excludeKeyword「後発医薬品」が
    // 同じ文に同時に出現する実例(サスメドの実際の「事業の内容」節)。
    // このとき当たりとして数えてはならない。
    const term = vocab.business.find((t) => t.id === "B.MED.INNOVATOR_DRUG")!;
    expect(term.keywords).toContain("新薬");
    expect(term.excludeKeywords).toContain("後発医薬品");
    const text = fx("4263-susmed-business-excerpt.txt");
    expect(text).toContain("新薬");
    expect(text).toContain("後発医薬品");

    const result = prefilter(vocab, { business: text });
    expect(result.candidates.map((c) => c.term.id)).not.toContain("B.MED.INNOVATOR_DRUG");
    expect(result.noHitTermIds).toContain("B.MED.INNOVATOR_DRUG");
  });

  it("節が渡されなければ候補は出ない(全語が『語なし』)", () => {
    const result = prefilter(vocab, {});
    expect(result.candidates).toEqual([]);
    expect(result.noHitTermIds.sort()).toEqual(
      vocab.business
        .filter((t) => !t.deprecated)
        .map((t) => t.id)
        .sort()
    );
  });
});
