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
  themes: string[];
  uncertainText: string | null;
  evidence: EvidenceBlockInput["items"];
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
      else downstream.push(term.labelJa);
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

  return {
    upstream,
    downstream,
    themes,
    uncertainText: uncertainParts.length > 0 ? uncertainParts.join(" / ") : null,
    evidence,
  };
}
