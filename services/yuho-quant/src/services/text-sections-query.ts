/**
 * 定性セクション (事業の内容・リスク等) の読み取り層。
 *
 * 本文の正本は Notion (全銘柄共通の単一「有報テキスト」DB。D1 10GB 上限
 * 対策)。D1 は索引 (キー・項目名・文字数) + 行 ID (`notion_doc_page_id`)
 * のみを持ち、本関数は索引で最新を特定して本文を Notion から読む。
 *
 * ルール2: 行が無い (セクション欠損・未取込・ポインタ未設定) は null・
 * 空配列のまま返し、呼び出し側 (テーマ判定など) に判断を委ねる。D1 残存
 * テキストへのフォールバックはしない (P4 で text 列自体が落ちるため)。
 * 同一会計期末の重複 (訂正報告書 130 等) は提出日時が新しい書類を採用する
 * (order-query と同じ)。
 */
import { and, desc, eq } from "drizzle-orm";
import { readStockTextRow } from "../../../../src/shared/notion-archive/index.js";
import type { Database } from "../db/client.js";
import { yuhoDocuments, textSections } from "../db/schema.js";
import type { TextSectionKey } from "./edinet/text-sections.js";

export interface LatestTextSection {
  sectionKey: TextSectionKey;
  text: string;
  charCount: number;
  fiscalYearEnd: string;
  docId: string;
  submittedAt: Date;
}

/**
 * 銘柄の最新期セクションを 1 括りで返す。最新期末がセクションごとに違う
 * 場合は各セクションの最新を返す (混ぜて 1 期に寄せない)。
 */
export async function getLatestTextSections(
  db: Database,
  stockId: number
): Promise<LatestTextSection[]> {
  // 1) D1 索引でセクション毎の最新行を特定する (本文は読まない)。
  const rows = await db
    .select({
      sectionKey: textSections.sectionKey,
      charCount: textSections.charCount,
      fiscalYearEnd: textSections.fiscalYearEnd,
      docId: yuhoDocuments.docId,
      submittedAt: yuhoDocuments.submittedAt,
      notionDocPageId: yuhoDocuments.notionDocPageId,
    })
    .from(textSections)
    .innerJoin(
      yuhoDocuments,
      eq(textSections.documentId, yuhoDocuments.id)
    )
    .where(
      and(
        eq(textSections.stockId, stockId),
        eq(yuhoDocuments.stockId, stockId)
      )
    )
    .orderBy(desc(textSections.fiscalYearEnd), desc(yuhoDocuments.submittedAt));
  const seen = new Set<string>();
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (seen.has(r.sectionKey)) continue;
    seen.add(r.sectionKey);
    latest.set(r.sectionKey, r);
  }
  if (latest.size === 0) return [];

  // 2) 通単位で Notion 行を読む (同一通は 1 回だけ)。
  const byDoc = new Map<string, string>();
  for (const r of latest.values()) {
    if (r.notionDocPageId && !byDoc.has(r.docId)) {
      byDoc.set(r.docId, r.notionDocPageId);
    }
  }
  const texts = new Map<string, Map<string, string>>();
  for (const [docId, rowPageId] of byDoc) {
    const sections = await readStockTextRow(rowPageId);
    texts.set(
      docId,
      new Map(sections.map((s) => [s.sectionKey, s.text]))
    );
  }

  // 3) 索引 + 本文を組み立てる。ポインタ無し・本文欠落は落とす
  // (呼び出し側が「確認不能」等に倒す。D1 残存テキストは見ない)。
  const out: LatestTextSection[] = [];
  for (const [sectionKey, r] of latest) {
    const text = texts.get(r.docId)?.get(sectionKey);
    if (text === undefined) continue;
    out.push({
      sectionKey: sectionKey as TextSectionKey,
      text,
      charCount: r.charCount,
      fiscalYearEnd: r.fiscalYearEnd,
      docId: r.docId,
      submittedAt: r.submittedAt,
    });
  }
  return out;
}

/** 指定セクションの最新 1 件。無ければ null (呼び出し側で「確認不能」等へ)。 */
export async function getTextSection(
  db: Database,
  stockId: number,
  sectionKey: TextSectionKey
): Promise<LatestTextSection | null> {
  const rows = await getLatestTextSections(db, stockId);
  return rows.find((r) => r.sectionKey === sectionKey) ?? null;
}
