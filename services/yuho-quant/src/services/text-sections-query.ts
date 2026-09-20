/**
 * 定性セクション (事業の内容・リスク等) の読み取り層。
 *
 * ルール2: 行が無い (セクション欠損・未取込) は null・空配列のまま返し、
 * 呼び出し側 (テーマ判定など) に判断を委ねる。同一会計期末の重複
 * (訂正報告書 130 等) は提出日時が新しい書類を採用する (order-query と同じ)。
 */
import { and, desc, eq } from "drizzle-orm";
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
  const rows = await db
    .select({
      sectionKey: textSections.sectionKey,
      text: textSections.text,
      charCount: textSections.charCount,
      fiscalYearEnd: textSections.fiscalYearEnd,
      docId: yuhoDocuments.docId,
      submittedAt: yuhoDocuments.submittedAt,
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
  const out: LatestTextSection[] = [];
  for (const r of rows) {
    if (seen.has(r.sectionKey)) continue;
    seen.add(r.sectionKey);
    out.push({
      sectionKey: r.sectionKey as TextSectionKey,
      text: r.text,
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
