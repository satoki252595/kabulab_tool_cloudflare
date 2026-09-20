/**
 * 有報の定性セクション (事業の内容・リスク・配当政策 等) の抽出。
 *
 * EDINET CSV (type=5) は全テキストブロックを平坦化して含むため、既に取得済みの
 * CSV 行から追加ダウンロードなしで定性情報を抜き出せる (二重取得しない)。
 * XBRL (type=1) は不要。
 *
 * 対象は法定の有報項目名に固定 (allowlist)。項目名の正規化 (空白・句読点除去)
 * で様式改訂前後の表記ゆれを吸収する。数値要素の混入を防ぐため要素 ID が
 * TextBlock で終わる行だけを候補にする。
 *
 * 同一セクションに複数コンテキストの行がある場合は当期・連結を優先する
 * (overseas-parser の「当期・連結に最も近い候補を選ぶ」と同じ方針)。
 * 該当なし・空文は行を作らない (NULL/欠損で正直に表す。ルール2)。
 */
import type { EdinetCsvRow } from "./csv.js";

export type TextSectionKey =
  | "business"
  | "risks"
  | "management_policy"
  | "dividend_policy"
  | "mda"
  | "rnd";

export interface TextSectionDef {
  key: TextSectionKey;
  /** 法定の有報項目名 (現行様式) */
  title: string;
}

/**
 * 投資判断に使う定性 6 項目。項目の追加はこの表に 1 行足すだけで済み、
 * DDL 変更は不要 (section_key 列に新キーが入るだけ)。
 */
export const TEXT_SECTIONS: readonly TextSectionDef[] = [
  { key: "business", title: "事業の内容" },
  { key: "risks", title: "事業等のリスク" },
  { key: "management_policy", title: "経営方針、経営環境及び対処すべき課題等" },
  { key: "dividend_policy", title: "配当政策" },
  {
    key: "mda",
    title: "経営者による財政状態、経営成績及びキャッシュ・フローの状況の分析",
  },
  { key: "rnd", title: "研究開発活動" },
];

export type TextParseStatus = "ok" | "no_text_sections" | "parse_error";

export interface ExtractedSection {
  sectionKey: TextSectionKey;
  /** HTML を剥がしたプレーンテキスト (原文の語句は変えない) */
  text: string;
  charCount: number;
  elementId: string;
  itemName: string;
  contextId: string;
}

/** 項目名の正規化: 空白・句読点の有無を吸収する (同一意味の表記ゆれ) */
export function normalizeTitle(s: string): string {
  return s.replace(/[\s、。．，,.]+/g, "");
}

const NORMALIZED_TITLES = new Map<TextSectionKey, string>(
  TEXT_SECTIONS.map((d) => [d.key, normalizeTitle(d.title)])
);

/** 要素 ID のローカル名 (例: jpcrp_cor:BusinessRisksTextBlock → BusinessRisksTextBlock) */
function localName(elementId: string): string {
  return elementId.split(":").pop()!;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => {
      const cp = Number(n);
      return Number.isSafeInteger(cp) && cp <= 0x10ffff
        ? String.fromCodePoint(cp)
        : `&#${n};`;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => {
      const cp = parseInt(h, 16);
      return Number.isSafeInteger(cp) && cp <= 0x10ffff
        ? String.fromCodePoint(cp)
        : `&#x${h};`;
    })
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

/**
 * テキストブロック値 (HTML) をプレーンテキスト化する。
 * タグ除去・実体参照復号・空白畳み込みのみで、語句の言い換えや要約はしない。
 */
export function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/[\s\u3000]+/g, " ")
    .trim();
}

function scoreRow(r: EdinetCsvRow): number {
  let s = 0;
  if (r.relativeYear.startsWith("Current")) s += 2;
  if (r.consolidatedOrNonConsolidated === "連結") s += 1;
  return s;
}

/**
 * CSV 行から定性 6 項目を抜く。1 セクション最大 1 行。
 * マッチも抽出も純粋関数 (テスト容易・副作用なし)。
 */
export function extractTextSections(rows: EdinetCsvRow[]): ExtractedSection[] {
  const out: ExtractedSection[] = [];
  for (const def of TEXT_SECTIONS) {
    const want = NORMALIZED_TITLES.get(def.key)!;
    let best: EdinetCsvRow | null = null;
    let bestScore = -1;
    for (const r of rows) {
      if (!localName(r.elementId).endsWith("TextBlock")) continue;
      if (normalizeTitle(r.itemName) !== want) continue;
      const s = scoreRow(r);
      if (s > bestScore) {
        bestScore = s;
        best = r;
      }
    }
    if (!best) continue;
    const text = stripHtml(best.value);
    if (!text) continue;
    out.push({
      sectionKey: def.key,
      text,
      charCount: text.length,
      elementId: best.elementId,
      itemName: best.itemName,
      contextId: best.contextId,
    });
  }
  return out;
}
