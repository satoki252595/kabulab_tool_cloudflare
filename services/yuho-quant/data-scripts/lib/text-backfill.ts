/**
 * 定性セクション backfill の D1 対象選定 + 1 文書ぶん batch 構築。
 * data-scripts/backfill-text-sections.ts (top-level await の CLI で import
 * できない) からテスト可能な純粋部を切り出したもの。振る舞いの正本はここ。
 */
import { and, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { Database } from "../../src/db/client.js";
import { textSections, yuhoDocuments } from "../../src/db/schema.js";
import type { ExtractedSection } from "../../src/services/edinet/text-sections.js";

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * 通常選定の where 条件。未処理 (textParseStatus NULL) に加え、既存 173 と
 * 同一の再開条件 (textParseStatus='ok' かつ notionDocPageId NULL) を含める。
 * Notion 保管に失敗した通も force 無しで次回回収される。
 */
export function textBackfillWhere(
  docFilter: string[] | null,
  force: boolean
): SQL | undefined {
  const pending = or(
    isNull(yuhoDocuments.textParseStatus),
    and(
      eq(yuhoDocuments.textParseStatus, "ok"),
      isNull(yuhoDocuments.notionDocPageId)
    )
  );
  if (docFilter !== null) {
    return force
      ? inArray(yuhoDocuments.docId, docFilter)
      : and(pending, inArray(yuhoDocuments.docId, docFilter));
  }
  return force ? undefined : pending;
}

export interface TextBackfillTarget {
  id: number;
  stockId: number;
  docId: string;
  periodEnd: string;
  filerName: string;
}

/**
 * 1 文書ぶん (text status UPDATE + 索引 DELETE + INSERT 群) の batch 文を
 * 構築する。呼び出し側は toD1BatchStatements で変換し d1HttpBatch の
 * 単一 batch で送る。逐次だと UPDATE 後に落ちた場合「status だけ埋まって
 * 索引 0 件」の部分行が残り、次回選定から外れて永久欠損になる同根因。
 * sections 0 件でも UPDATE + DELETE の 2 文は返す (全 tuple に記録)。
 */
export function buildTextBackfillStatements(
  db: Database,
  target: TextBackfillTarget,
  status: string,
  sections: ExtractedSection[]
) {
  const sectionRows = sections.map((s) => ({
    documentId: target.id,
    stockId: target.stockId,
    fiscalYearEnd: target.periodEnd,
    sectionKey: s.sectionKey,
    elementId: s.elementId,
    itemName: s.itemName,
    contextId: s.contextId,
    charCount: s.charCount,
  }));
  // D1 bind 上限 100: 8 列/行 → 8 行/文 (8×8=64)。
  return [
    db
      .update(yuhoDocuments)
      .set({ textParseStatus: status })
      .where(eq(yuhoDocuments.id, target.id)),
    db.delete(textSections).where(eq(textSections.documentId, target.id)),
    ...chunk(sectionRows, 8).map((part) =>
      db.insert(textSections).values(part)
    ),
  ];
}
