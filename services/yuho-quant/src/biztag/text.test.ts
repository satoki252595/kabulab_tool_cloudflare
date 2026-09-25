/**
 * text.ts のユニットテスト。
 *
 * 実際の有報から取れる例では表現しきれない境界(丸数字の合成連続・改行入りの
 * 段落分割)だけ、会社を特定できない短い合成文字列を使う(コメントで明示)。
 * それ以外は fixtures/ の実データ(有報原文)を使う。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { matchesKeyword, normalizeForMatch, splitParagraphs, splitSentences } from "./text.js";

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fx = (name: string) => readFileSync(join(FX, name), "utf8");

describe("normalizeForMatch", () => {
  it("半角カタカナ長音・水平線などの長音類は、片仮名の前後なら「ー」に揃える", () => {
    expect(normalizeForMatch("シリコンｰウエハ")).toBe("シリコンーウエハ");
    expect(normalizeForMatch("シリコンーウエハ")).toBe("シリコンーウエハ");
    // ABF (ASCII) と テスト (片仮名) の間の「―」は直後が片仮名なので長音扱い
    expect(normalizeForMatch("ABF―テスト")).toBe("abfーテスト");
  });

  it("片仮名に接しないダッシュ・ハイフン類は「-」に揃える", () => {
    expect(normalizeForMatch("ケース－バイ－ケース")).toBe("ケース-バイ-ケース");
    expect(normalizeForMatch("2025-03-31")).toBe("2025-03-31");
  });

  it("NFKC・空白畳み込み・ASCII 小文字化", () => {
    expect(normalizeForMatch("ＡＢＣ　　ｄｅｆ")).toBe("abc def");
  });

  it("CJK には大小文字の区別が無いため素通りする", () => {
    expect(normalizeForMatch("事業の内容")).toBe("事業の内容");
  });

  it("商標・サービスマーク記号(™℠)は NFKC 展開(TM/SM)による誤境界化を防ぐため除去する(味の素 有報 S100Y992 の実文「ABF™」)", () => {
    // fixtures/2802-ajinomoto-rnd-abf.txt の実文に含まれる「ABF™」がそのまま
    // NFKC されると "abftm" になり、"abf" の直後に ASCII 文字 (t) が続いて
    // matchesKeyword の境界規則で弾かれてしまう(実際に起きた回帰)。
    expect(normalizeForMatch("「ABF™」の開発")).toBe("「abf」の開発");
    expect(normalizeForMatch("ABF™")).not.toContain("tm");
  });
});

describe("matchesKeyword", () => {
  it("ASCII キーワードは英単語の内部には当たらない(トーメンデバイス 有報 S100YJQ2 事業等のリスクの実文「ec」in「Electronics」)", () => {
    const sentence =
      "当社グループは、サムスングループの半導体および電子部品の販売に特化しており、国内においては日本サムスン株式会社から、" +
      "海外においては上海三星半導体有限公司、Samsung Electronics Singapore Pte. Ltd.等から商品を購入しており、" +
      "サムスングループへの依存度が極めて高い状況にあります。";
    expect(matchesKeyword(normalizeForMatch(sentence), normalizeForMatch("ec"))).toBe(false);
  });

  it("「ソース」は「リソース」の内部には当たらない(味の素 有報 S100Y992 MD&Aの実文)", () => {
    const sentence =
      "削減可能なコスト・ムダをなくし、削減できたリソースを成長に振り向けるために、既存業務を「やめる」、" +
      "「へらす」、「かえる」の3つの視点で、AIも活用しながら、主体的に業務改善を行っています。";
    expect(matchesKeyword(normalizeForMatch(sentence), normalizeForMatch("ソース"))).toBe(false);
  });

  it("「リース」は「リリース」の内部には当たらない(ネクソン 有報 S100XSM4 MD&Aの実文)", () => {
    const sentence =
      "また、10月30日にグローバルでリリースした『ARC Raiders』が2ヶ月未満で累計販売本数1,000万本を突破し、" +
      "業績に大きく貢献いたしました。";
    expect(matchesKeyword(normalizeForMatch(sentence), normalizeForMatch("リース"))).toBe(false);
  });

  it("「トランス」は「トランスフォーメーション」の内部には当たらない(日比谷総合設備 有報 S100YQYG 研究開発活動の実文)", () => {
    const sentence = "(2) DX・スマート関連技術開発デジタルトランスフォーメーション(DX)の推進にも取り組みました。";
    expect(matchesKeyword(normalizeForMatch(sentence), normalizeForMatch("トランス"))).toBe(false);
  });

  it("4字を超える片仮名キーワードは、より長い片仮名語の内部でも当たる(リボミック 有報 の実文「オートタキシンアプタマー」中の「アプタマー」)", () => {
    // fixtures/4591-ribomic-business.txt に実在する句(引用): 「アプタマー」は
    // 5字(SHORT_KATAKANA_MAX=4を超える)ため、片仮名の直前(「シ」)に接していても
    // 別語の一部とはみなさない。
    const sentence = "ブタPVRモデルにおける抗オートタキシンアプタマーの効果を検討した結果";
    expect(sentence).toContain("オートタキシンアプタマー");
    expect(matchesKeyword(normalizeForMatch(sentence), normalizeForMatch("アプタマー"))).toBe(true);
  });

  it("漢字キーワードは境界を見ないため複合語の内部でも当たる(サスメド 有報 S100WR1U の実文「医薬品」中の「医薬」)", () => {
    const sentence =
      "そうした中、厚生労働省を中心に後発医薬品の使用が継続的に推進されておりますが、" +
      "後発医薬品の普及は社会保障費の抑制につながる反面、新薬の開発に対する民間企業のインセンティブを減少させる可能性もあります。";
    expect(matchesKeyword(normalizeForMatch(sentence), normalizeForMatch("医薬"))).toBe(true);
  });

  it("ABF は商標記号付き表記「ABF™」の中でも当たる(味の素 有報 S100Y992 研究開発活動の実文)", () => {
    const text = fx("2802-ajinomoto-rnd-abf.txt");
    expect(text).toContain("「ABF™」");
    const sentences = splitSentences(text);
    const hit = sentences.find((s) => matchesKeyword(normalizeForMatch(s.text), normalizeForMatch("ABF")));
    expect(hit).toBeDefined();
    expect(hit?.text).toContain("ABF™");
  });

  it("空のキーワードは単語帳の検査漏れとして throw する", () => {
    expect(() => matchesKeyword("何か", "")).toThrow(/空のキーワード/);
  });
});

describe("splitSentences", () => {
  it("句点で区切る(味の素 有報 S100Y992・研究開発活動の実文)", () => {
    // fixtures/2802-ajinomoto-rnd-abf.txt: 味の素の実際の有報から抜き出した実文。
    // 本来の生産経路は「事業の内容」節を読むが、この会社のその節(808字)は短く
    // ABF に触れていないため、ここでは同じ書類の「研究開発活動」節の実文を
    // prefilter 入力の材料として流用する(テスト目的の代用であることを明示)。
    const text = fx("2802-ajinomoto-rnd-abf.txt");
    const sentences = splitSentences(text);
    expect(sentences).toHaveLength(6);
    expect(sentences[0].text).toBe(
      "＜ファンクショナルマテリアルズ（電子材料等）＞ 電子材料分野においては、味の素ファインテクノ㈱と共同で、次世代PC、データセンター向けサーバー、5G通信ネットワーク用途を中心に、「ABF™」の開発を推進しています。"
    );
    // オフセットが原文の範囲と一致する(引用は常に原文から切り出す)
    for (const s of sentences) {
      expect(text.slice(s.start, s.end)).toBe(s.text);
    }
  });

  it("句読点の直前に来る「・」は並列の中点であり区切らない(川崎重工ではなく実データの一例)", () => {
    // 実コーパスの実文(「小型車から大型トラック・バス用の…」)。「トラック・バス」の
    // 「・」は直前が空白でないため箇条書きとして扱われず、1 文のまま保たれる。
    const text =
      "ブレーキ部門……小型車から大型トラック・バス用の重要保安部品であるブレーキについては、当社が製造販売しております。";
    const sentences = splitSentences(text);
    expect(sentences).toHaveLength(1);
    expect(sentences[0].text).toBe(text);
  });

  it("箇条書きの先頭記号(空白の後の全角括弧数字)は文の区切りになる(リボミック 有報 S100X6UM の実文)", () => {
    const text =
      "その具体的な進捗を下記に要約いたします。 （１）当事業年度の主要なトピックス 創薬事業 創薬事業では、当社が自社で創製した医薬品の研究開発を行い、製薬企業等へのライセンス・アウトを通じた収益獲得を目指しております。";
    const sentences = splitSentences(text);
    expect(sentences.map((s) => s.text)).toEqual([
      "その具体的な進捗を下記に要約いたします。",
      "（１）当事業年度の主要なトピックス 創薬事業 創薬事業では、当社が自社で創製した医薬品の研究開発を行い、製薬企業等へのライセンス・アウトを通じた収益獲得を目指しております。",
    ]);
  });

  it("丸数字の連続(合成例・句点を挟まない列挙)も箇条書きとして区切る", () => {
    // 実データでは丸数字の前に句点が来ることが大半で、この「句点なし・空白区切りのみで
    // 連続する丸数字」というケースの実例はコーパス中に見つからなかったため、
    // 区切り規則そのものを確かめる合成テストとして短い文字列を使う。
    const text = "ブレーキ部門 ①概要 ②詳細";
    const sentences = splitSentences(text);
    expect(sentences.map((s) => s.text)).toEqual(["ブレーキ部門", "①概要", "②詳細"]);
  });

  it("空文は捨てる(句読点や空白のみは除外し、実質のある文だけ残す)", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("   ")).toEqual([]);
    // 句点そのものにも文字はあるため 1 文として残る(空文ではない)
    expect(splitSentences("。").map((s) => s.text)).toEqual(["。"]);
  });
});

describe("splitParagraphs", () => {
  it("改行が無い実データ(リボミック segment_info)は文単位で 400 字以内にグループ化する", () => {
    // 実測: このコーパス(339 社)は sections[].text に改行を 1 つも含まない
    // (EDINET テキストブロックの flatten で失われるため)。よってこの
    // フォールバック経路こそが実運用での唯一の経路であり、これは「データの
    // フォールバック」ではなく元々段落という概念が無い原文に対する分割ルール。
    const text = fx("4591-ribomic-segment-info.txt");
    expect(text.includes("\n")).toBe(false);
    const paragraphs = splitParagraphs(text);
    expect(paragraphs.map((p) => p.text.length)).toEqual([306, 362, 289]);
    for (const p of paragraphs) {
      expect(text.slice(p.start, p.end)).toBe(p.text);
      expect(p.text.length).toBeLessThanOrEqual(400);
    }
  });

  it("改行があればそれで区切る(合成例。実コーパスに改行入りテキストが無いため)", () => {
    const text = "第一段落です。複数の文を含みます。\n第二段落です。\n\n第三段落。";
    const paragraphs = splitParagraphs(text);
    expect(paragraphs.map((p) => p.text)).toEqual([
      "第一段落です。複数の文を含みます。",
      "第二段落です。",
      "第三段落。",
    ]);
  });

  it("空文は段落を作らない", () => {
    expect(splitParagraphs("")).toEqual([]);
    expect(splitParagraphs("   ")).toEqual([]);
  });
});
