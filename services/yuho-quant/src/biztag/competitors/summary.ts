/**
 * 候補企業 (会社B) の「核となる事業」の短い説明をコードで組み立てる。
 * 設計: docs/005-yuho-quant-business-tags.md「競合他社」節 §2 jev 判定。
 *
 * **AI に会社Bの説明文を作文させない** (ルール1・設計書 §1 と同じ精神)。
 * ここで作る説明は次の3つの実データだけを機械的に連結したもので、
 * LLM には一切通さない:
 *   1. 会社名・33業種
 *   2. 既に jev 判定済みの事業タグ (labelJa) の一覧
 *   3. 「事業の内容」冒頭の実文 (句点区切りで最初の段落相当まで、コードで切り出す)
 */
import { splitSentences } from "../text.js";

/** 「事業の内容」冒頭から取る本文の目安上限 (字)。長すぎる冒頭段落を安全に切る。 */
export const SUMMARY_BUSINESS_LEAD_MAX = 300;

/**
 * 「事業の内容」原文冒頭から、文の区切り (句点) を保ったまま
 * `SUMMARY_BUSINESS_LEAD_MAX` 字程度までを切り出す (機械的な抜粋。要約ではない)。
 * 1 文目だけで上限を超える場合は、その1文を上限で切り「…」を付ける
 * (黙って全文を混ぜない・ルール2)。
 */
export function leadExcerpt(businessText: string, maxChars: number = SUMMARY_BUSINESS_LEAD_MAX): string {
  const trimmed = businessText.trim();
  if (trimmed.length === 0) return "";
  const sentences = splitSentences(trimmed);
  if (sentences.length === 0) {
    return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars)}…`;
  }
  let out = "";
  for (const s of sentences) {
    const candidate = out + s.text;
    if (candidate.length > maxChars) break;
    out = candidate;
  }
  if (out.length === 0) {
    // 1文目だけで上限超過。その1文を切り詰める。
    return `${sentences[0].text.slice(0, Math.max(0, maxChars - 1))}…`;
  }
  return out.length < trimmed.length ? `${out}…` : out;
}

export interface CompanySummaryInput {
  companyName: string;
  stockCode: string;
  sector33: string | null;
  /** 事業タグ（素材・部品・装置）∪（製品・サービス）∪（流通・サービス）の labelJa。 */
  tags: string[];
  businessText: string;
}

/**
 * 会社Bの説明文 (jev の質問文に埋め込む。設計書「B の名前＋タグ・事業の内容冒頭から
 * コードで作る短い説明」)。
 */
export function buildCompanySummary(input: CompanySummaryInput): string {
  const parts: string[] = [`${input.companyName}（証券コード${input.stockCode}）`];
  if (input.sector33 !== null) parts.push(`33業種: ${input.sector33}`);
  if (input.tags.length > 0) parts.push(`事業タグ: ${input.tags.join("、")}`);
  const lead = leadExcerpt(input.businessText);
  if (lead.length > 0) parts.push(`有報「事業の内容」冒頭: ${lead}`);
  return parts.join("／");
}
