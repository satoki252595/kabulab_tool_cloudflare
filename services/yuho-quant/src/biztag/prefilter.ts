/**
 * 事業タグの絞り込み(コードのみ・確率的判定なし)。
 * 設計: docs/005-yuho-quant-business-tags.md §5.3。
 *
 * 対象の節ごとに文を分け、単語帳の keywords に「語として」当たった文を集める
 * (境界の規則は text.ts の matchesKeyword)。excludeKeywords を含む文は当たりに
 * 数えない。ここで当たらなかった語は「語なし」(候補にならない=判定していない。
 * 未判定とは別)。
 *
 * 対象の節を「事業の内容」だけにしない理由 (2026-09-25 実測・338 社):
 * - 「セグメント情報等、財務諸表」がある有報は全体の約 13% (29/338) しかない。
 * - 味の素の ABF は「事業の内容」(808 字) に無く、「研究開発活動」にだけ
 *   「先端半導体パッケージにおけるビルドアップ層用材料として幅広く採用」とある。
 * - 「事業の内容」+「セグメント情報」だけだと候補語ゼロの会社が 55 社、
 *   MD&A と「研究開発活動」を足すと 5 社になる。
 * 当たっただけではタグにしない。「その会社自身が今その事業を営んでいるか」は
 * jev が判定し、研究段階・顧客の業界・借入先などは「いいえ」にする (judge.ts)。
 */
import { TEXT_SECTIONS, type TextSectionKey } from "../services/edinet/text-sections.js";
import type { Sentence } from "./text.js";
import { matchesKeyword, normalizeForMatch, splitSentences } from "./text.js";
import type { BusinessTerm, Vocabulary } from "./vocabulary/schema.js";

/** 絞り込みの対象節 (TextSectionKey の部分集合)。並びは優先順 (主 → 補足)。 */
export const PREFILTER_SECTIONS = ["business", "segment_info", "mda", "rnd"] as const;
export type PrefilterSectionKey = (typeof PREFILTER_SECTIONS)[number];

/** 主の節 (全文または抜粋を必ず渡す)。それ以外は当たった箇所だけ渡す補足の節。 */
export const PRIMARY_SECTION: PrefilterSectionKey = "business";

function titleOf(key: TextSectionKey): string {
  const def = TEXT_SECTIONS.find((d) => d.key === key);
  if (def === undefined) throw new Error(`TEXT_SECTIONS に ${key} が無い`);
  return def.title;
}

/**
 * 節のキー → 有報の項目名 (= 補足 DB の本文列名・根拠の節名)。
 * TEXT_SECTIONS が正本 (列名と一致させるため、ここで名前を書き直さない)。
 */
export const PREFILTER_SECTION_TITLE: Readonly<Record<PrefilterSectionKey, string>> = {
  business: titleOf("business"),
  segment_info: titleOf("segment_info"),
  mda: titleOf("mda"),
  rnd: titleOf("rnd"),
};

/** TextSectionKey が絞り込みの対象節かどうか */
export function isPrefilterSection(key: string): key is PrefilterSectionKey {
  return (PREFILTER_SECTIONS as readonly string[]).includes(key);
}

/** キーワードが当たった文 1 件。 */
export interface KeywordHit {
  termId: string;
  sectionKey: PrefilterSectionKey;
  sentence: Sentence;
  keyword: string;
}

export interface PrefilterResult {
  /** 当たりのあった業種語(廃止済みは除く)。単語帳の並び順。 */
  candidates: Array<{ term: BusinessTerm; hits: KeywordHit[] }>;
  /** 1 件も当たらなかった語の id。単語帳の並び順。 */
  noHitTermIds: string[];
}

/**
 * 絞り込みを行う。
 *
 * 対象は廃止されていない business 語のみ。文は節ごとに一度だけ分割・正規化し、
 * 語ごとに使い回す。1 つの文が複数の keyword に当たる場合は、その keyword の
 * 数だけ KeywordHit を作る(根拠選定側 (evidence.ts) が文単位でまとめて重複を除く)。
 */
export function prefilter(
  vocab: Vocabulary,
  sections: Partial<Record<PrefilterSectionKey, string>>
): PrefilterResult {
  const sectionSentences = PREFILTER_SECTIONS.flatMap((sectionKey) => {
    const text = sections[sectionKey];
    if (text === undefined) return [];
    return [
      {
        sectionKey,
        sentences: splitSentences(text).map((sentence) => ({
          sentence,
          normalized: normalizeForMatch(sentence.text),
        })),
      },
    ];
  });

  const candidates: PrefilterResult["candidates"] = [];
  const noHitTermIds: string[] = [];

  for (const term of vocab.business) {
    if (term.deprecated) continue;

    const normalizedKeywords = term.keywords.map((keyword) => normalizeForMatch(keyword));
    const normalizedExcludes = term.excludeKeywords.map((keyword) => normalizeForMatch(keyword));
    const hits: KeywordHit[] = [];

    for (const { sectionKey, sentences } of sectionSentences) {
      for (const { sentence, normalized } of sentences) {
        if (normalizedExcludes.some((exclude) => normalized.includes(exclude))) continue;
        term.keywords.forEach((keyword, idx) => {
          if (matchesKeyword(normalized, normalizedKeywords[idx])) {
            hits.push({ termId: term.id, sectionKey, sentence, keyword });
          }
        });
      }
    }

    if (hits.length > 0) {
      candidates.push({ term, hits });
    } else {
      noHitTermIds.push(term.id);
    }
  }

  return { candidates, noHitTermIds };
}
