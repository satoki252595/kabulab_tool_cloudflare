/**
 * 根拠(有報からコードで抜き出した原文の文)の組み立て。
 * 設計: docs/005-yuho-quant-business-tags.md §3.1 ページ本文・§5.3。
 */
import type { KeywordHit, PrefilterSectionKey } from "./prefilter.js";

const PERIOD_END_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 会計期末(YYYY-MM-DD)を「YYYY年M月期」に変換する。
 * 形式が違う・実在しない日付(例: 2025-02-30)は throw する(ルール2: 黙って埋めない)。
 */
export function formatPeriodJa(periodEnd: string): string {
  const m = PERIOD_END_RE.exec(periodEnd);
  if (!m) {
    throw new Error(`formatPeriodJa: 会計期末の形式が不正 (YYYY-MM-DD 必須): ${periodEnd}`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) {
    throw new Error(`formatPeriodJa: 月が不正: ${periodEnd}`);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`formatPeriodJa: 実在しない日付: ${periodEnd}`);
  }
  return `${year}年${month}月期`;
}

/**
 * キーワードの前後を残して maxChars 以内に切り詰める。
 * 切った側には必ず「…」を付ける(黙って削らない・ルール2)。
 */
function cutAroundKeyword(text: string, keyword: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const idx = text.indexOf(keyword);
  if (idx === -1) {
    // 正規化の揺れでキーワードが原文中に厳密一致しない場合は中央を切り出す
    const start = Math.max(0, Math.floor((text.length - maxChars) / 2));
    const end = start + maxChars;
    return `…${text.slice(start, end)}…`;
  }
  const half = Math.floor((maxChars - keyword.length) / 2);
  let start = idx - half;
  let end = idx + keyword.length + half;
  if (start < 0) {
    end += -start;
    start = 0;
  }
  if (end > text.length) {
    start -= end - text.length;
    end = text.length;
  }
  start = Math.max(0, start);
  end = Math.min(text.length, end);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

/**
 * 語 1 つ分の根拠文を選ぶ。同じ文は 1 回だけ(先に出てきた keyword を採用)、
 * 最大 max 件まで。maxChars を超える文は {@link cutAroundKeyword} で切り詰める。
 */
export function pickEvidenceSentences(
  hits: KeywordHit[],
  max = 3,
  maxChars = 300
): Array<{ text: string; sectionKey: PrefilterSectionKey }> {
  const seen = new Set<string>();
  const picked: Array<{ text: string; sectionKey: PrefilterSectionKey }> = [];
  for (const hit of hits) {
    const key = `${hit.sectionKey}:${hit.sentence.start}-${hit.sentence.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push({
      text: cutAroundKeyword(hit.sentence.text, hit.keyword, maxChars),
      sectionKey: hit.sectionKey,
    });
    if (picked.length >= max) break;
  }
  return picked;
}
