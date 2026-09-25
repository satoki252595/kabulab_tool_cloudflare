/**
 * jev(判定モデル)へ渡す「状態」(state) の組み立て。
 * 設計: docs/005-yuho-quant-business-tags.md §5.4。
 *
 * 送るのは常に原文からの抜粋のみ(AI に事業内容を作文させない・ルール1)。
 * 切り詰めた事実(原文の文字数・当たった箇所数・省いた段落数)は inputSummary に
 * 正直に書く(ルール2: 黙って埋めない)。
 *
 * 構成:
 * - 主の節「事業の内容」: 12,000 字以内なら全文。超えたら冒頭 3,000 字 + 当たった文の
 *   前後 ±400 字を「（中略）」でつなぐ。
 * - 補足の節(セグメント情報・MD&A・研究開発活動): 当たった段落だけ。合計 8,000 字まで。
 *   まず候補語ごとに 1 段落ずつ(節の優先順: セグメント → MD&A → 研究開発)入れ、
 *   残りの予算で文書順に足す。どの候補語にも最低 1 つは文脈が付くようにするため。
 */
import {
  PREFILTER_SECTIONS,
  PREFILTER_SECTION_TITLE,
  PRIMARY_SECTION,
  type KeywordHit,
  type PrefilterResult,
  type PrefilterSectionKey,
} from "./prefilter.js";
import { splitParagraphs } from "./text.js";

export interface DocMeta {
  stockCode: string;
  companyName: string;
  docId: string;
  /** YYYY-MM-DD */
  periodEnd: string;
  docTypeLabel: string;
}

/** 「事業の内容」が全文のまま収まる上限(字)。超えたら抜粋する。 */
export const BUSINESS_FULL_MAX = 12000;
/** 抜粋時、冒頭から必ず入れる字数。 */
export const BUSINESS_LEAD = 3000;
/** 抜粋時、当たった文の前後に足す窓(字)。 */
export const HIT_WINDOW = 400;
/** 補足の節(当たった段落のみ)の合計上限(字)。 */
export const SUPPORT_MAX = 8000;

/** 補足の節(主の節以外)。優先順。 */
const SUPPORT_SECTIONS = PREFILTER_SECTIONS.filter((k) => k !== PRIMARY_SECTION);

/** 要約に書く補足節の短い名前 */
const SUPPORT_SHORT_NAME: Record<PrefilterSectionKey, string> = {
  business: "事業の内容",
  segment_info: "セグメント",
  mda: "MD&A",
  rnd: "研究開発",
};

export interface JudgeInput {
  /** jev へそのまま渡す入力本文。 */
  state: string;
  /** 「事業の内容 全文 1,802字／補足 セグメント1・MD&A 2・研究開発1段落 1,640字」のような日本語の要約。 */
  inputSummary: string;
  /** 「事業の内容」の原文の文字数(切り詰めた場合も原文の総字数)。 */
  businessChars: number;
  /** 「事業の内容」を切り詰めたかどうか。 */
  businessTruncated: boolean;
  /** state に採用した補足の段落数。 */
  supportParagraphsUsed: number;
  /** 8,000 字の上限のため省いた補足の段落数(当たった段落のうち)。 */
  supportParagraphsOmitted: number;
}

interface Interval {
  start: number;
  end: number;
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [{ ...sorted[0] }];
  for (const cur of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/** 3 桁ごとにカンマを入れる(Intl のロケールデータ有無に依存させない)。 */
function formatJa(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function buildBusinessExcerpt(
  text: string,
  hits: KeywordHit[]
): { excerpt: string; truncated: boolean; hitLocationCount: number } {
  if (text.length <= BUSINESS_FULL_MAX) {
    return { excerpt: text, truncated: false, hitLocationCount: 0 };
  }

  const seenSentences = new Set<string>();
  const hitIntervals: Interval[] = [];
  for (const hit of hits) {
    const key = `${hit.sentence.start}-${hit.sentence.end}`;
    if (seenSentences.has(key)) continue;
    seenSentences.add(key);
    hitIntervals.push({
      start: Math.max(0, hit.sentence.start - HIT_WINDOW),
      end: Math.min(text.length, hit.sentence.end + HIT_WINDOW),
    });
  }

  const lead: Interval = { start: 0, end: Math.min(BUSINESS_LEAD, text.length) };
  const merged = mergeIntervals([lead, ...hitIntervals]);
  const excerpt = merged.map((iv) => text.slice(iv.start, iv.end)).join("（中略）");
  return { excerpt, truncated: true, hitLocationCount: seenSentences.size };
}

/** 補足節の当たった段落 1 つ */
interface SupportParagraph {
  sectionKey: PrefilterSectionKey;
  /** 節内の段落番号(文書順・隣接判定用) */
  index: number;
  start: number;
  text: string;
  /** この段落に当たった語 */
  termIds: Set<string>;
}

interface SupportExcerpt {
  blocks: Array<{ sectionKey: PrefilterSectionKey; text: string; used: number }>;
  used: number;
  omitted: number;
  charsUsed: number;
}

function clampParagraph(p: SupportParagraph, budget: number): SupportParagraph {
  // 1 段落だけで予算を超える場合は、先頭から予算までで切り「…」で切ったことを示す
  // (ルール2: 上限超過の全文を黙って混ぜない・黙って捨てない)。
  return { ...p, text: `${p.text.slice(0, Math.max(0, budget - 1))}…` };
}

function buildSupportExcerpt(
  sections: Partial<Record<PrefilterSectionKey, string>>,
  result: PrefilterResult
): SupportExcerpt {
  const matched: SupportParagraph[] = [];
  for (const sectionKey of SUPPORT_SECTIONS) {
    const text = sections[sectionKey];
    if (text === undefined || text.length === 0) continue;
    const hits = result.candidates.flatMap((c) => c.hits.filter((h) => h.sectionKey === sectionKey));
    if (hits.length === 0) continue;
    splitParagraphs(text).forEach((p, index) => {
      const termIds = new Set(
        hits.filter((h) => h.sentence.start >= p.start && h.sentence.start < p.end).map((h) => h.termId)
      );
      if (termIds.size > 0) matched.push({ sectionKey, index, start: p.start, text: p.text, termIds });
    });
  }
  if (matched.length === 0) return { blocks: [], used: 0, omitted: 0, charsUsed: 0 };

  const chosen = new Map<SupportParagraph, SupportParagraph>(); // 元 → 採用形(切り詰め後)
  let charsUsed = 0;
  /**
   * ステップ2 (残り予算での追加) 用。予算が尽きていれば何もしない
   * (こちらは「保証」ではなく「残りで足せるだけ足す」だけなので、
   * 収まらない段落は黙って見送ってよい)。
   */
  const tryAdd = (p: SupportParagraph): void => {
    if (chosen.has(p)) return;
    const remaining = SUPPORT_MAX - charsUsed;
    if (remaining <= 0) return;
    if (p.text.length > remaining) return;
    chosen.set(p, p);
    charsUsed += p.text.length;
  };
  /**
   * ステップ1 (候補語ごとの文脈保証) 用。予算がどれだけ残っていても、
   * 先に処理された候補が予算を使い切っていても、この候補の段落は必ず
   * 1 つ登録する(収まらなければ `clampParagraph` で切り詰める。予算が
   * 既に 0 でも「…」だけは残す)。処理順で後になった候補ほど不利になる
   * (finding: 先着の候補が予算を独占して後続候補の保証を潰す) のを防ぐための
   * 唯一の防御であり、ここを「収まらなければ諦める」にしてはいけない。
   */
  const addGuaranteed = (p: SupportParagraph): void => {
    if (chosen.has(p)) return;
    const remaining = SUPPORT_MAX - charsUsed;
    if (remaining > 0 && p.text.length <= remaining) {
      chosen.set(p, p);
      charsUsed += p.text.length;
      return;
    }
    const clamped = clampParagraph(p, Math.max(0, remaining));
    chosen.set(p, clamped);
    charsUsed += clamped.text.length;
  };

  // 1) 候補語ごとに最初の 1 段落(節の優先順 → 文書順)を必ず確保する
  //    (予算超過でも切り詰めて確保する。どの候補語にも最低 1 つは文脈が
  //    付くという冒頭の保証を、処理順に関わらず満たすため)。
  for (const c of result.candidates) {
    const covered = [...chosen.keys()].some((p) => p.termIds.has(c.term.id));
    if (covered) continue;
    const first = matched.find((p) => p.termIds.has(c.term.id));
    if (first !== undefined) addGuaranteed(first);
  }
  // 2) 残りの予算で、残りの段落を節の優先順・文書順に(こちらは保証ではないので
  //    収まらなければ見送ってよい)。
  for (const p of matched) tryAdd(p);

  const blocks: SupportExcerpt["blocks"] = [];
  for (const sectionKey of SUPPORT_SECTIONS) {
    const inSection = matched.filter((p) => p.sectionKey === sectionKey && chosen.has(p));
    if (inSection.length === 0) continue;
    const parts: string[] = [];
    inSection.forEach((p, i) => {
      if (i > 0 && p.index > inSection[i - 1].index + 1) parts.push("（中略）");
      parts.push(chosen.get(p)!.text);
    });
    blocks.push({ sectionKey, text: parts.join(""), used: inSection.length });
  }
  return { blocks, used: chosen.size, omitted: matched.length - chosen.size, charsUsed };
}

/**
 * jev へ渡す状態(state)と、判定入力列に書く要約を組み立てる。
 *
 * `sections` と `result` は同じ節テキストに対して {@link prefilter} を実行した
 * ものを渡すこと(KeywordHit のオフセットが sections の原文と対応している必要がある)。
 */
export function buildJudgeInput(
  meta: DocMeta,
  sections: Partial<Record<PrefilterSectionKey, string>>,
  result: PrefilterResult
): JudgeInput {
  const businessText = sections.business === undefined ? "" : sections.business;
  const businessHits = result.candidates.flatMap((c) =>
    c.hits.filter((h) => h.sectionKey === PRIMARY_SECTION)
  );

  const business = buildBusinessExcerpt(businessText, businessHits);
  const support = buildSupportExcerpt(sections, result);

  const businessSummary = business.truncated
    ? `事業の内容 抜粋 冒頭${formatJa(BUSINESS_LEAD)}字+該当${formatJa(business.hitLocationCount)}箇所（原文${formatJa(businessText.length)}字）`
    : `事業の内容 全文 ${formatJa(businessText.length)}字`;

  const supportSummary =
    support.used === 0
      ? "補足 該当なし"
      : `補足 ${support.blocks.map((b) => `${SUPPORT_SHORT_NAME[b.sectionKey]}${formatJa(b.used)}`).join("・")}段落 ${formatJa(support.charsUsed)}字` +
        (support.omitted > 0
          ? `（該当${formatJa(support.used + support.omitted)}段落中${formatJa(support.omitted)}段落省略）`
          : "");

  const headerLines = [
    `銘柄コード: ${meta.stockCode}`,
    `会社名: ${meta.companyName}`,
    `書類ID: ${meta.docId}`,
    `会計期末: ${meta.periodEnd}`,
    `書類種別: ${meta.docTypeLabel}`,
  ].join("\n");

  const blocks = [headerLines, `【${PREFILTER_SECTION_TITLE.business}】\n${business.excerpt}`];
  for (const b of support.blocks) {
    blocks.push(`【${PREFILTER_SECTION_TITLE[b.sectionKey]}（該当段落）】\n${b.text}`);
  }

  return {
    state: blocks.join("\n\n"),
    inputSummary: `${businessSummary}／${supportSummary}`,
    businessChars: businessText.length,
    businessTruncated: business.truncated,
    supportParagraphsUsed: support.used,
    supportParagraphsOmitted: support.omitted,
  };
}
