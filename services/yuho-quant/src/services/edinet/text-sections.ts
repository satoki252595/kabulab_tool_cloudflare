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
  | "rnd"
  | "major_shareholders"
  | "issued_shares_total"
  | "ownership_breakdown"
  | "voting_rights"
  | "treasury_shares"
  | "treasury_shareholders_meeting"
  | "treasury_board"
  | "treasury_disposal"
  | "subsidiaries"
  | "employees"
  | "history"
  | "material_contracts"
  | "officers"
  | "officer_shareholdings"
  | "outside_directors"
  | "governance_overview"
  | "audit_status"
  | "sustainability"
  | "facilities"
  | "facilities_plan"
  | "capex"
  | "securities_schedule"
  | "securities_note"
  | "fixed_assets_schedule"
  | "rental_property"
  | "segment_info"
  | "subsequent_events"
  | "related_parties"
  | "parent_info"
  | "rights_plan"
  | "mscb_exercise"
  | "changes_issued"
  | "main_customers";

export interface TextSectionDef {
  key: TextSectionKey;
  /** 法定の有報項目名 (現行様式) */
  title: string;
}

/**
 * 投資判断に使う開示テキスト項目。項目の追加はこの表に 1 行足すだけで済み、
 * DDL 変更は不要 (section_key 列に新キーが入るだけ)。
 *
 * 項目名は EDINET CSV の「項目名」列の実測値に合わせる (S100Z2G0 で全件確認)。
 * CSV 側は末尾に ` [テキストブロック]` が付くので照合時に剥がす。
 * 様式の大見出し (株式等の状況・自己株式の取得等の状況・ガバナンスの状況等)
 * は CSV に行が無く細目だけがあるため、細目の実測名で登録する。
 * company により出ない項目 (賃貸不動産・ライツプラン等) は行なし =
 * 正直な欠損として残る。
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
  { key: "major_shareholders", title: "大株主の状況" },
  { key: "issued_shares_total", title: "発行済株式、株式の総数等" },
  { key: "ownership_breakdown", title: "所有者別状況" },
  { key: "voting_rights", title: "発行済株式、議決権の状況" },
  { key: "treasury_shares", title: "自己株式等" },
  { key: "treasury_shareholders_meeting", title: "株主総会決議による取得の状況" },
  { key: "treasury_board", title: "取締役会決議による取得の状況" },
  { key: "treasury_disposal", title: "取得自己株式の処理状況及び保有状況" },
  { key: "subsidiaries", title: "関係会社の状況" },
  { key: "employees", title: "従業員の状況" },
  { key: "history", title: "沿革" },
  { key: "material_contracts", title: "重要な契約等" },
  { key: "officers", title: "役員の状況" },
  { key: "officer_shareholdings", title: "株式の保有状況" },
  { key: "outside_directors", title: "社外取締役（及び社外監査役）" },
  { key: "governance_overview", title: "コーポレート・ガバナンスの概要" },
  { key: "audit_status", title: "監査の状況" },
  { key: "sustainability", title: "サステナビリティに関する考え方及び取組" },
  { key: "facilities", title: "主要な設備の状況" },
  { key: "facilities_plan", title: "設備の新設、除却等の計画" },
  { key: "capex", title: "設備投資等の概要" },
  { key: "securities_schedule", title: "有価証券明細表" },
  { key: "securities_note", title: "有価証券関係、財務諸表" },
  { key: "fixed_assets_schedule", title: "有形固定資産等明細表" },
  { key: "rental_property", title: "賃貸等不動産関係、財務諸表" },
  { key: "segment_info", title: "セグメント情報等、財務諸表" },
  { key: "subsequent_events", title: "重要な後発事象、財務諸表" },
  { key: "related_parties", title: "関連当事者情報、財務諸表" },
  { key: "parent_info", title: "提出会社の親会社等の情報" },
  { key: "rights_plan", title: "ライツプランの内容" },
  {
    key: "mscb_exercise",
    title: "行使価額修正条項付新株予約権付社債券等の行使状況等",
  },
  { key: "changes_issued", title: "発行済株式総数、資本金等の推移" },
  { key: "main_customers", title: "主要な顧客ごとの情報" },
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

/**
 * 項目名の正規化: 末尾の ` [テキストブロック]` を剥がし、空白・句読点・
 * 「等」の有無を吸収する (同一意味の表記ゆれ)。allowlist 側も同規則で
 * 正規化して完全一致させる。正規化後に衝突する allowlist 項目があれば
 * テストで検出する (TEXT_SECTIONS 固定テスト)。
 */
export function normalizeTitle(s: string): string {
  return s
    .replace(/\s*\[テキストブロック\]\s*$/, "")
    .replace(/[\s、。．，,.・等]+/g, "");
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

/**
 * 候補行の採点。CSV の相対年度は和名 (当期/前期/当期末/提出日時点) で
 * 入るため、当期系を優先する (前期と当期の両方がある注記で当期を採る)。
 * 開示項目は提出日時点で単一行が通例 (同点は先勝ち・決定的)。
 */
function scoreRow(r: EdinetCsvRow): number {
  let s = 0;
  if (r.relativeYear.includes("当期")) s += 2;
  else if (r.relativeYear === "提出日時点") s += 1;
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
