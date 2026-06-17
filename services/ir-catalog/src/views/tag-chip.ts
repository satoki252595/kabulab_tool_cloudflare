/**
 * タグの色分けチップ。タグ名 (専門用語) には必ず初心者向けバルーンを付ける
 * (CLAUDE.md ルール7)。色は classify.ts の単一定義 (UI/Notion 共通)。
 */
import { termTip } from "../../../../src/shared/term-tip.js";
import { tagDef } from "../services/classify.js";
import { h } from "./layout.js";

const UNCLASSIFIED_TIP =
  "どの分類ルールにも当てはまらなかった開示。意味を取り違えないよう、あえて推測でタグを付けていない。資料本文で内容を確認してください。";

/** 単一タグのチップ。未知ラベルは枠だけ付けて素直に表示 (捏造しない) */
export function tagChip(label: string, align: "center" | "right" = "center"): string {
  const def = tagDef(label);
  if (!def) {
    return `<span class="chip unclassified"><span class="dot"></span>${h(label)}</span>`;
  }
  const style = `color:${def.ink};background:${def.fill};border-color:${def.ink}`;
  return `<span class="chip" style="${style}"><span class="dot"></span>${termTip(
    def.label,
    def.tip,
    align
  )}</span>`;
}

/** 未分類チップ (primaryTag=null 用) */
export function unclassifiedChip(): string {
  return `<span class="chip unclassified"><span class="dot"></span>${termTip(
    "未分類",
    UNCLASSIFIED_TIP
  )}</span>`;
}

/** タグ配列を色分けチップ列に。0 件なら未分類チップ */
export function tagChips(tags: string[]): string {
  if (tags.length === 0) return unclassifiedChip();
  return tags.map((t) => tagChip(t)).join("");
}
