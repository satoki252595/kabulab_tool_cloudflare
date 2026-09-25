/**
 * excerpt.ts のユニットテスト。
 *
 * 「事業の内容」の切り詰め窓は、実コーパスの中で 12,000 字を超える実例
 * (リボミック 有報・26,640字)を使って確かめる(合成での水増しは不要だった)。
 * 補足の節 (セグメント情報・MD&A・研究開発活動) の予算 (SUPPORT_MAX=8,000字)・
 * 段落単位の（中略）・語ごとの文脈保証・単独段落の打ち切りも、実コーパスの
 * 組み合わせ (リボミックの「事業の内容」節をテスト目的で他節の代用にした実文・
 * 味の素の実際の「研究開発活動」節) で確かめる。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUSINESS_FULL_MAX,
  BUSINESS_LEAD,
  SUPPORT_MAX,
  buildJudgeInput,
  type DocMeta,
} from "./excerpt.js";
import { prefilter } from "./prefilter.js";
import rawVocab from "./fixtures/test-vocab.json" with { type: "json" };
import { VocabularySchema, type Vocabulary } from "./vocabulary/schema.js";

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fx = (name: string) => readFileSync(join(FX, name), "utf8");
const vocab: Vocabulary = VocabularySchema.parse(rawVocab);

const meta: DocMeta = {
  stockCode: "4591",
  companyName: "リボミック",
  docId: "S100X6UM",
  periodEnd: "2026-03-31",
  docTypeLabel: "有報",
};

describe("buildJudgeInput", () => {
  it("12,000字以下ならそのまま全文を使う(味の素の実文・485字)。補足の節が無ければ「該当なし」", () => {
    const rndExcerpt = fx("2802-ajinomoto-rnd-abf.txt");
    const result = prefilter(vocab, { business: rndExcerpt });
    const input = buildJudgeInput(
      { stockCode: "2802", companyName: "味の素", docId: "S100Y992", periodEnd: "2026-03-31", docTypeLabel: "有報" },
      { business: rndExcerpt },
      result
    );
    expect(input.businessTruncated).toBe(false);
    expect(input.businessChars).toBe(rndExcerpt.length);
    expect(input.inputSummary).toBe(`事業の内容 全文 ${rndExcerpt.length}字／補足 該当なし`);
    expect(input.state).toContain(rndExcerpt);
    expect(input.state).toContain("銘柄コード: 2802");
    expect(input.state).not.toContain("（該当段落）");
  });

  it("12,000字を超えるリボミックの実文は切り詰め対象になり、冒頭3,000字と当たり箇所数を正直に報告する(セグメント情報は実際の短い節)", () => {
    const business = fx("4591-ribomic-business.txt");
    const segment = fx("4591-ribomic-segment-info.txt");
    expect(business.length).toBeGreaterThan(BUSINESS_FULL_MAX);

    const result = prefilter(vocab, { business, segment_info: segment });
    const input = buildJudgeInput(meta, { business, segment_info: segment }, result);

    expect(input.businessChars).toBe(business.length);
    expect(input.businessTruncated).toBe(true);
    expect(input.inputSummary).toBe(
      "事業の内容 抜粋 冒頭3,000字+該当135箇所（原文26,640字）／補足 セグメント1段落 306字"
    );
    expect(input.supportParagraphsUsed).toBe(1);
    expect(input.supportParagraphsOmitted).toBe(0);

    expect(input.state).toContain(business.slice(0, BUSINESS_LEAD));
    // 節の見出しは TEXT_SECTIONS の実際の項目名 (「セグメント情報等、財務諸表」) を使う。
    expect(input.state).toContain("【セグメント情報等、財務諸表（該当段落）】");
    // セグメントの当たった段落(創薬事業…)がそのまま含まれる
    expect(input.state).toContain("創薬事業及びこれに付随する事業を行う単一セグメント");
  });

  it("当たり箇所が冒頭から離れていれば、間を『（中略）』でつなぎ原文全体は含めない", () => {
    // fixtures/composite-farhit-business.txt: ソフトバンクの実際の「事業の内容」
    // (19,996字・本テスト語彙とは無関係で当たりが無い)の直後に、味の素の実際の
    // ABF 言及部分(485字)を連結した合成テキスト。実文だけで構成しつつ、
    // 「冒頭ウィンドウ」と「当たりウィンドウ」の間に確実に隙間ができる例を作るため
    // (実コーパスのリボミック文はヒットが密集しすぎて隙間が残らなかった)。
    const composite = fx("composite-farhit-business.txt");
    expect(composite.length).toBeGreaterThan(BUSINESS_FULL_MAX);

    const result = prefilter(vocab, { business: composite });
    const input = buildJudgeInput(meta, { business: composite }, result);

    expect(input.businessTruncated).toBe(true);
    expect(input.inputSummary).toBe("事業の内容 抜粋 冒頭3,000字+該当3箇所（原文20,482字）／補足 該当なし");
    expect(input.state).toContain(composite.slice(0, BUSINESS_LEAD));
    expect(input.state).toContain("「ABF™」は、高い絶縁信頼性");
    expect(input.state).not.toContain(composite);
    expect((input.state.match(/（中略）/g) ?? []).length).toBe(1);
  });

  it("補足の節が SUPPORT_MAX(8,000字) を超える該当段落を持つとき、段落単位で省いた数を正直に報告し（中略）でつなぐ", () => {
    // 実コーパスの segment_info は最大でも3,460字程度しかなく、単独では
    // 8,000字超・複数段落省略を再現できない (実測: corpus 339社走査)。そこで
    // 「事業の内容」節で既に使っているリボミックの実文
    // (4591-ribomic-business.txt・実測62段落が「アプタマー」等でヒット)を、
    // このテストに限り セグメント情報 の入力として転用する
    // (composite-farhit-business.txt と同じ考え方: 実文だけで構成しつつ、
    // 通常のコーパスには無い分量・構造を再現するための転用。リボミックの
    // 実際のセグメント情報の記述内容を主張するものではない)。
    const reused = fx("4591-ribomic-business.txt");
    const sections = { segment_info: reused };
    const result = prefilter(vocab, sections);
    const input = buildJudgeInput(meta, sections, result);

    expect(input.supportParagraphsUsed).toBeGreaterThan(0);
    expect(input.supportParagraphsOmitted).toBeGreaterThan(0);
    expect(input.supportParagraphsUsed).toBe(23);
    expect(input.supportParagraphsOmitted).toBe(39);
    expect(input.inputSummary).toBe(
      "事業の内容 全文 0字／補足 セグメント23段落 7,887字（該当62段落中39段落省略）"
    );

    const segBlock = /【セグメント情報等、財務諸表（該当段落）】\n([\s\S]*)$/.exec(input.state);
    expect(segBlock).not.toBeNull();
    // 上限 (SUPPORT_MAX=8,000字) を超えない (段落間の「（中略）」を含めても)。
    expect(segBlock?.[1].length ?? Infinity).toBeLessThanOrEqual(SUPPORT_MAX);
    // 62段落のうち23段落しか採用していない (隣接しない段落がある) ので、
    // 少なくとも1回は「（中略）」でつながる。
    expect((input.state.match(/（中略）/g) ?? []).length).toBeGreaterThan(0);
  });

  it("該当した最初の段落 1 つだけで SUPPORT_MAX(8,000字) を超える場合、その段落を先頭から打ち切り「…」で明示する", () => {
    // splitParagraphs は改行が無いテキストを 400字ごとの文グループに分けるため、
    // 「1段落だけで8,000字」を実データで再現するには、改行を明示的な区切りとして
    // 使う (splitParagraphs は改行があればそれを最優先するため)。中身は
    // リボミックの実文 (実測でアプタマー等が高密度に出現する冒頭8,600字分)を
    // そのまま 1 段落として使う (捏造した文言は無い)。
    const businessFull = fx("4591-ribomic-business.txt");
    const oneHugeParagraph = businessFull.slice(0, 8600);
    // 2段落目も同じ実文の続き (アプタマー等が高密度に出現する箇所) をそのまま使う
    // (捏造した文言ではなく、実文書の続きを別段落として扱っているだけ)。
    const secondParagraph = businessFull.slice(8600, 9200);
    expect(oneHugeParagraph.length).toBeGreaterThan(SUPPORT_MAX);
    const sections = { rnd: `${oneHugeParagraph}\n${secondParagraph}` };

    const result = prefilter(vocab, sections);
    const input = buildJudgeInput(meta, sections, result);

    expect(input.supportParagraphsUsed).toBe(1);
    expect(input.supportParagraphsOmitted).toBeGreaterThanOrEqual(1);
    const rndBlock = /【研究開発活動（該当段落）】\n([\s\S]*)$/.exec(input.state);
    expect(rndBlock).not.toBeNull();
    expect(rndBlock?.[1]).toBe(`${oneHugeParagraph.slice(0, SUPPORT_MAX - 1)}…`);
    expect(rndBlock?.[1].endsWith("…")).toBe(true);
  });

  it("語ごとの文脈保証: MD&A の当たりが予算を使い切っても、当たりが研究開発活動にしか無い語には必ず段落が付く", () => {
    // 「事業の内容」で既に使っているリボミックの実文 (実測: アプタマー・創薬等が
    // 62段落でヒットし、単独で SUPPORT_MAX を大きく超える) を、このテストに限り
    // MD&A の入力として転用する (composite-farhit-business.txt と同じ考え方:
    // 実文だけで構成しつつ、通常のコーパスには無い分量を再現するための転用)。
    // 研究開発活動には味の素の実際の「研究開発活動」節 (ABF 関連, 485字) を使う。
    // ABF に対応する語 (B.MAT.SEMICON_PACKAGE_SUBSTRATE) は MD&A 側には
    // 一切出現しないため、当たりは研究開発活動の段落にしか無い。
    const mda = fx("4591-ribomic-business.txt");
    const rnd = fx("2802-ajinomoto-rnd-abf.txt");
    const sections = { mda, rnd };
    const result = prefilter(vocab, sections);
    expect(result.candidates.map((c) => c.term.id).sort()).toEqual(
      ["B.MAT.SEMICON_PACKAGE_SUBSTRATE", "B.MED.INNOVATOR_DRUG", "B.MED.NUCLEIC_ACID_DRUG"].sort()
    );

    const input = buildJudgeInput(meta, sections, result);

    // MD&A 側の当たり (62段落) は予算を大きく超えるため大半が省かれる
    // (実測: 64段落中40段落省略。MD&A62段落+研究開発2段落の合計)。
    expect(input.supportParagraphsOmitted).toBeGreaterThan(0);
    expect(input.inputSummary).toBe(
      "事業の内容 全文 0字／補足 MD&A22・研究開発2段落 7,977字（該当64段落中40段落省略）"
    );
    // 研究開発活動にしか当たりが無い ABF (SEMICON_PACKAGE_SUBSTRATE) 語の文脈が、
    // MD&A の当たりで予算が圧迫されても必ず state に含まれる (段落単位の
    // 文脈保証。excerpt.ts の buildSupportExcerpt ステップ1)。
    expect(input.state).toContain("【研究開発活動（該当段落）】");
    expect(input.state).toContain("「ABF™」の開発を推進しています");
    expect(input.state).toContain("【経営者による財政状態、経営成績及びキャッシュ・フローの状況の分析（該当段落）】");
  });

  it("語ごとの文脈保証(複数候補が予算を分け合う場合): 先に処理された候補の保証段落が予算の大半を使っても、後続候補にも切り詰めてでも文脈を付ける", () => {
    // 実測(2026-09-25)で見つかったギャップ: 旧実装は「保証段落が予算に収まらない
    // とき、既に1つでも確保済みなら諦めて0段落にする」動作だったため、処理順で
    // 後になった候補だけ文脈ゼロになりえた(冒頭コメントの保証に違反)。
    // ここでは「単独では SUPPORT_MAX(8,000字) に収まるが、2 候補分を足すと
    // 超える」実文の組み合わせで再現する: セグメント情報にリボミックの実文
    // (アプタマー・創薬等でヒット、4,500字)、MD&A に composite-farhit-business
    // (味の素の実際の ABF 言及を含む合成テキスト、末尾4,500字)を割り当てる
    // (どちらも既存テストで使っている実文の別範囲の転用)。
    const segment_info = `${fx("4591-ribomic-business.txt").slice(0, 4500)}\n`;
    const compositeText = fx("composite-farhit-business.txt");
    const mda = `${compositeText.slice(compositeText.length - 4500)}\n`;
    const sections = { segment_info, mda };
    const result = prefilter(vocab, sections);
    // セグメント情報 (核酸医薬・新薬系 2 語) と MD&A (ABF 1 語) で候補語が分かれ、
    // かつそれぞれの保証段落 (4,500字) は単独では SUPPORT_MAX に収まるが、
    // 先に処理される語の分と合わせると 8,000字 を超える。
    expect(result.candidates.map((c) => c.term.id).sort()).toEqual(
      ["B.MAT.SEMICON_PACKAGE_SUBSTRATE", "B.MED.INNOVATOR_DRUG", "B.MED.NUCLEIC_ACID_DRUG"].sort()
    );

    const input = buildJudgeInput(meta, sections, result);

    // 両方の節に段落が付く(旧実装はセグメント情報側が丸ごと 0 段落になっていた)。
    expect(input.state).toContain("【セグメント情報等、財務諸表（該当段落）】");
    expect(input.state).toContain("【経営者による財政状態、経営成績及びキャッシュ・フローの状況の分析（該当段落）】");
    // MD&A の ABF 言及はそのまま含まれる。
    expect(input.state).toContain("ABF");
    // セグメント情報側は予算を使い切ったため切り詰められるが、「…」で
    // 打ち切ったことを明示し、空にはしない(ルール2: 黙って0件にしない)。
    const segBlock = /【セグメント情報等、財務諸表（該当段落）】\n([\s\S]*?)\n\n【/.exec(input.state);
    expect(segBlock).not.toBeNull();
    expect(segBlock?.[1].endsWith("…")).toBe(true);
    expect(segBlock?.[1].length).toBeGreaterThan(0);
    // 合計は SUPPORT_MAX を超えない。
    expect(input.supportParagraphsUsed).toBe(2);
  });

  it("該当節が無いときは 0字・該当なしとして正直に扱う(データを埋めない)", () => {
    const emptyResult = prefilter(vocab, {});
    const input = buildJudgeInput(meta, {}, emptyResult);
    expect(input.businessChars).toBe(0);
    expect(input.businessTruncated).toBe(false);
    expect(input.inputSummary).toBe("事業の内容 全文 0字／補足 該当なし");
    expect(input.supportParagraphsUsed).toBe(0);
    expect(input.supportParagraphsOmitted).toBe(0);
  });
});
