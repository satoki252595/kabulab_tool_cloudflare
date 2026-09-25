/**
 * 語ごとの判定結果を、補足行(Notion)に書く形へまとめる。
 * 設計: docs/005-yuho-quant-business-tags.md §5.6・§3.1。
 *
 * 保存するのは常に「語の名前」「確率と帯」「原文から抜き出した文」の 3 つだけ
 * (AI に事業内容を作文させない・ルール1)。
 */
import type { EvidenceBlockInput } from "../../../../src/shared/notion-archive/index.js";
import { pickEvidenceSentences } from "./evidence.js";
import type { Band, TermJudgment } from "./judge.js";
import { PREFILTER_SECTION_TITLE, type KeywordHit, type PrefilterResult } from "./prefilter.js";
import { deriveThemes } from "./themes.js";
import type { Vocabulary } from "./vocabulary/schema.js";

export interface TagOutcome {
  upstream: string[];
  downstream: string[];
  distribution: string[];
  themes: string[];
  uncertainText: string | null;
  evidence: EvidenceBlockInput["items"];
  /**
   * 「事業タグの根拠文」列に書く平文 (§3.1)。`はい`/`要確認` の語ごとに
   * `タグ名（はい 0.93）：「原文1〜2文」— 節名` の1行。語が無ければ null。
   */
  evidenceText: string | null;
  /** Notion の rich_text 上限 (§EVIDENCE_TEXT_MAX_CHARS) のため一部を切り詰めたか。 */
  evidenceTextTruncated: boolean;
}

/**
 * 「事業タグの根拠文」列の文字数上限。Notion の rich_text は 1 プロパティ
 * `ROW_RICH_TEXT_SEGMENTS_MAX`(100) 要素 × `RICH_TEXT_MAX`(2000) 字 = 200,000字
 * まで送れるが (`buildSupplementProperties` の `richTextValue` が超過で throw する)、
 * 行全体の処理を止めないよう、ここでは安全マージンを取った下限で自ら切り詰め、
 * 切り詰めた事実を末尾に明記する(黙って削らない・ルール2)。ページ本文の
 * 根拠トグル(`buildEvidenceBlock`)には全語が残るので、情報そのものは失われない。
 */
export const EVIDENCE_TEXT_MAX_CHARS = 190_000;

const EVIDENCE_TEXT_TRUNCATE_NOTE =
  "\n…（文字数上限のため以下省略。全語の根拠はページ本文の根拠トグルを参照）";

function formatEvidenceTextLine(item: EvidenceBlockInput["items"][number]): string {
  const bandLabel = item.band === "yes" ? "はい" : "要確認";
  const picked = item.sentences.slice(0, 2);
  const quote = picked.map((s) => s.text).join("");
  const sectionNames = [...new Set(picked.map((s) => s.sectionTitle))].join("・");
  return `${item.labelJa}（${bandLabel} ${item.probability.toFixed(2)}）：「${quote}」— ${sectionNames}`;
}

/**
 * `はい`/`要確認` の語ごとの根拠文を組み立てる(純粋関数)。
 * `items` は `summarizeJudgments` が作る evidence 配列 (既に `いいえ` を除いている)。
 */
export function buildEvidenceText(
  items: EvidenceBlockInput["items"]
): { text: string | null; truncated: boolean } {
  if (items.length === 0) return { text: null, truncated: false };
  const lines = items.map(formatEvidenceTextLine);
  const full = lines.join("\n");
  if (full.length <= EVIDENCE_TEXT_MAX_CHARS) return { text: full, truncated: false };

  const budget = EVIDENCE_TEXT_MAX_CHARS - EVIDENCE_TEXT_TRUNCATE_NOTE.length;
  let out = "";
  for (const line of lines) {
    const candidate = out.length === 0 ? line : `${out}\n${line}`;
    if (candidate.length > budget) break;
    out = candidate;
  }
  return { text: `${out}${EVIDENCE_TEXT_TRUNCATE_NOTE}`, truncated: true };
}

function evidenceSentences(hits: KeywordHit[]): Array<{ text: string; sectionTitle: string }> {
  return pickEvidenceSentences(hits).map((s) => ({
    text: s.text,
    sectionTitle: PREFILTER_SECTION_TITLE[s.sectionKey],
  }));
}

function formatUncertain(labelJa: string, probability: number): string {
  return `${labelJa}（${probability.toFixed(2)}）`;
}

/**
 * jev の判定結果を Notion 用の事業タグ・投資テーマ・要確認タグ・根拠にまとめる。
 *
 * `judgments` は `candidates` (prefilter の結果)に含まれる語だけを対象にする
 * 前提。対応する候補が無い判定が来たら呼び出し側のバグとして throw する。
 */
export function summarizeJudgments(
  vocab: Vocabulary,
  candidates: PrefilterResult["candidates"],
  judgments: TermJudgment[]
): TagOutcome {
  const judgmentByTermId = new Map(judgments.map((j) => [j.termId, j] as const));
  const hitsByTermId = new Map(candidates.map((c) => [c.term.id, c.hits] as const));

  const upstream: string[] = [];
  const downstream: string[] = [];
  const distribution: string[] = [];
  const uncertainParts: string[] = [];
  const evidence: EvidenceBlockInput["items"] = [];

  for (const term of vocab.business) {
    if (term.deprecated) continue;
    const judgment = judgmentByTermId.get(term.id);
    if (judgment === undefined) continue;

    const band: Band = judgment.band;
    if (band === "no") continue;

    const hits = hitsByTermId.get(term.id);
    if (hits === undefined) {
      throw new Error(`summarizeJudgments: 候補に無い語の判定結果が渡された (${term.id})`);
    }

    if (band === "yes") {
      if (term.notionColumn === "upstream") upstream.push(term.labelJa);
      else if (term.notionColumn === "downstream") downstream.push(term.labelJa);
      else distribution.push(term.labelJa);
    } else {
      uncertainParts.push(formatUncertain(term.labelJa, judgment.probability));
    }

    evidence.push({
      labelJa: term.labelJa,
      band,
      probability: judgment.probability,
      sentences: evidenceSentences(hits),
    });
  }

  const yesTermIds = judgments.filter((j) => j.band === "yes").map((j) => j.termId);
  const themes = deriveThemes(vocab, yesTermIds).map((t) => t.labelJa);
  const { text: evidenceText, truncated: evidenceTextTruncated } = buildEvidenceText(evidence);

  return {
    upstream,
    downstream,
    distribution,
    themes,
    uncertainText: uncertainParts.length > 0 ? uncertainParts.join(" / ") : null,
    evidence,
    evidenceText,
    evidenceTextTruncated,
  };
}
