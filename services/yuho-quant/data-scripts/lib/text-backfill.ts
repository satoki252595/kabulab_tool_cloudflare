/**
 * 定性セクション backfill の D1 対象選定 + 1 文書ぶん batch 構築。
 * data-scripts/backfill-text-sections.ts (top-level await の CLI で import
 * できない) からテスト可能な純粋部を切り出したもの。振る舞いの正本はここ。
 */
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "../../src/db/client.js";
import { textSections, yuhoDocuments } from "../../src/db/schema.js";
import type { ExtractedSection } from "../../src/services/edinet/text-sections.js";
import { reportedDocumentAtomicGuard } from "../../src/services/edinet/reported-changes.js";

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
  /** 0節の確定時だけ必須。既本文や不明な旧状態を空へ置換しない。 */
  textParseStatus?: string | null;
  notionDocPageId?: string | null;
}

/**
 * 1 文書ぶん (text status UPDATE + 索引 DELETE + INSERT 群) の batch 文を
 * 構築する。呼び出し側は toD1BatchStatements で変換し d1HttpBatch の
 * 単一 batch で送る。逐次だと UPDATE 後に落ちた場合「status だけ埋まって
 * 索引 0 件」の部分行が残り、次回選定から外れて永久欠損になる同根因。
 * 解析失敗はSQL作成前に停止。0節は既状態が確認でき、正常本文/pointerが無い時だけ確定する。
 */
export function buildTextBackfillStatements(
  db: Database,
  target: TextBackfillTarget,
  status: string,
  sections: ExtractedSection[],
  /** 全文読戻し済みのNotion行。索引/statusと同一batchで確定する。 */
  notionDocPageId?: string
) {
  if (status === "parse_error") throw new Error("本文解析失敗のため旧status/索引/pointerを保持してHOLD");
  if (sections.length === 0) {
    if (target.textParseStatus === undefined || target.notionDocPageId === undefined) {
      throw new Error("0節確定に必要な旧本文snapshotが不明のためHOLD");
    }
    if (target.textParseStatus === "ok" || target.notionDocPageId !== null) {
      throw new Error("再抽出0節のため既存の正常本文/status/索引/pointerを保持してHOLD");
    }
  }
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
  // 前読取後に報告HOLDが増えても、同一batchのguardでstatus/索引/pointerを保全する。
  // D1 bind 上限 100: 8 列/行 → 8 行/文 (8×8=64)。
  return [
    reportedDocumentAtomicGuard(db, target.docId),
    db
      .update(yuhoDocuments)
      .set({ textParseStatus: status, ...(notionDocPageId === undefined ? {} : { notionDocPageId }),
        // 全文照合済みpointer/statusの完成だけを通知。同値再読戻しや索引修復は再投入しない。
        ...(status === "ok" && sections.length > 0 && notionDocPageId !== undefined && notionDocPageId.length > 0
          ? { ingestedAt: sql`case when ${yuhoDocuments.textParseStatus} is not 'ok' or ${yuhoDocuments.notionDocPageId} is not ${notionDocPageId}
              then unixepoch() else ${yuhoDocuments.ingestedAt} end` } : {}),
      })
      .where(eq(yuhoDocuments.id, target.id)),
    db.delete(textSections).where(eq(textSections.documentId, target.id)),
    ...chunk(sectionRows, 8).map((part) =>
      db.insert(textSections).values(part)
    ),
  ];
}
